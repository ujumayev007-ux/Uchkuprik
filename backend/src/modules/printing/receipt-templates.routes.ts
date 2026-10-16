import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { errors, isUniqueViolation, parse } from '../../http/errors.js';
import { EscPos } from '../../printing/escpos.js';
import {
  ASSIGNMENT_TARGETS,
  fromLegacyLayout,
  receiptTemplateSchema,
  TEMPLATE_KINDS,
  templateSettingsOf,
} from '../../printing/receipt-template.js';
import { receiptTicket, sampleReceipt } from '../../printing/receipt.js';
import { resolveTemplate } from '../../printing/resolve-template.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

const templateBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(TEMPLATE_KINDS).default('CUSTOMER'),
  settings: receiptTemplateSchema,
});

const targetSchema = z.object({
  type: z.enum(ASSIGNMENT_TARGETS),
  targetId: z.string().trim().min(1).max(64),
});

/** Named receipt templates: list, create, edit, assign to printers/departments/types, test. */
export function receiptTemplatesRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('settings.manage')];

  router.get('/receipt-templates', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const [templates, profile] = await Promise.all([
      db.receiptTemplate.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { name: 'asc' },
        include: { assignments: true },
      }),
      db.tenantProfile.findUnique({
        where: { tenantId: auth.tenantId },
        select: { receiptSettings: true },
      }),
    ]);
    res.json({
      // The restaurant's original layout: the default customer receipt.
      defaultTemplate: fromLegacyLayout(profile?.receiptSettings),
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        kind: template.kind,
        settings: templateSettingsOf(template.settings),
        assignments: template.assignments.map((row) => ({
          type: row.targetType,
          targetId: row.targetId,
        })),
        updatedAt: template.updatedAt,
      })),
    });
  });

  router.post('/receipt-templates', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(templateBody, req.body);
    try {
      const created = await db.receiptTemplate.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          kind: input.kind,
          settings: input.settings as unknown as Prisma.InputJsonValue,
        },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'receipt.template.create',
        entityType: 'receipt_template',
        entityId: created.id,
        data: { name: input.name, kind: input.kind },
      });
      res.status(201).json({ id: created.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.put('/receipt-templates/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(templateBody, req.body);
    try {
      const result = await db.receiptTemplate.updateMany({
        where: { id, tenantId: auth.tenantId },
        data: {
          name: input.name,
          kind: input.kind,
          settings: input.settings as unknown as Prisma.InputJsonValue,
        },
      });
      if (result.count === 0) throw errors.notFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'receipt.template.update',
      entityType: 'receipt_template',
      entityId: id,
      data: { name: input.name, kind: input.kind },
    });
    res.json({ ok: true });
  });

  router.delete('/receipt-templates/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.receiptTemplate.deleteMany({
      where: { id, tenantId: auth.tenantId },
    });
    if (result.count === 0) throw errors.notFound();
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'receipt.template.delete',
      entityType: 'receipt_template',
      entityId: id,
    });
    res.json({ ok: true });
  });

  // Replaces where one template applies (printers, departments, receipt type default).
  router.put(
    '/receipt-templates/:id/assignments',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { targets } = parse(
        z.object({ targets: z.array(targetSchema).max(100) }),
        req.body,
      );
      const template = await db.receiptTemplate.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!template) throw errors.notFound();
      // Targets must belong to this restaurant (tenant isolation).
      for (const target of targets) {
        if (target.type === 'PRINTER') {
          const ok = await db.printer.findFirst({
            where: { id: target.targetId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!ok) throw errors.validation([{ path: 'targets' }]);
        } else if (target.type === 'STATION') {
          const ok = await db.kitchenStation.findFirst({
            where: { id: target.targetId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!ok) throw errors.validation([{ path: 'targets' }]);
        } else if (
          !(TEMPLATE_KINDS as readonly string[]).includes(target.targetId)
        )
          throw errors.validation([{ path: 'targets' }]);
      }
      await db.$transaction(async (tx) => {
        await tx.receiptAssignment.deleteMany({
          where: { tenantId: auth.tenantId, templateId: id },
        });
        for (const target of targets)
          await tx.receiptAssignment.upsert({
            where: {
              tenantId_targetType_targetId: {
                tenantId: auth.tenantId,
                targetType: target.type,
                targetId: target.targetId,
              },
            },
            create: {
              tenantId: auth.tenantId,
              targetType: target.type,
              targetId: target.targetId,
              templateId: id,
            },
            update: { templateId: id },
          });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'receipt.template.assign',
          entityType: 'receipt_template',
          entityId: id,
          data: { targets },
        });
      });
      res.json({ ok: true });
    },
  );

  // Which template a print target would use (for the designer and the cashier).
  router.get('/receipt-templates/resolve', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        kind: z.enum(TEMPLATE_KINDS).default('CUSTOMER'),
        printerId: z.uuid().optional(),
        stationId: z.uuid().optional(),
        templateId: z.uuid().optional(),
      }),
      req.query,
    );
    const resolved = await resolveTemplate(db, auth.tenantId, {
      kind: query.kind,
      printerId: query.printerId ?? null,
      stationId: query.stationId ?? null,
      templateId: query.templateId ?? null,
    });
    res.json(resolved);
  });

  // Test print: a sample receipt/ticket in the unsaved or saved settings, on a printer.
  router.post('/receipt-templates/test-print', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        printerId: z.uuid(),
        settings: receiptTemplateSchema,
        kind: z.enum(TEMPLATE_KINDS).default('CUSTOMER'),
      }),
      req.body,
    );
    const printer = await db.printer.findFirst({
      where: { id: input.printerId, tenantId: auth.tenantId },
    });
    if (!printer) throw errors.notFound();
    await resolveBranch(db, auth, printer.branchId);
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { name: true },
    });
    const payload =
      input.kind === 'CUSTOMER'
        ? receiptTicket(sampleReceipt(tenant.name, new Date()), input.settings)
        : new EscPos()
            .align('center')
            .bold(true)
            .line(input.settings.title || tenant.name)
            .bold(false)
            .line(`Sinov: ${printer.name}`)
            .line(`${input.settings.widthMm} mm`)
            .feed(4)
            .cut()
            .build();
    const job = await db.printJob.create({
      data: {
        tenantId: auth.tenantId,
        printerId: printer.id,
        kind: printer.kind,
        purpose: 'TEST',
        payload,
      },
    });
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'receipt.template.test',
      entityType: 'printer',
      entityId: printer.id,
    });
    res.status(201).json({ jobId: job.id });
  });

  return router;
}
