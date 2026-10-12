import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const settingsInput = z.object({
  name: z.string().trim().min(2).max(100),
  legalName: optionalText(150),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{9,14}$/)
    .nullable()
    .optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .nullable()
    .optional(),
  address: optionalText(200),
  receiptHeader: optionalText(300),
  receiptFooter: optionalText(300),
  serviceChargeBp: z.number().int().min(0).max(3000),
  requireMfaForAdmins: z.boolean(),
  allowNegativeStock: z.boolean().default(true),
  publicOrdering: z.boolean().default(false),
});

export function settingsRouter(services: Services) {
  const { db } = services;
  const router = Router();

  router.get('/settings', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      include: { profile: true },
    });
    res.json({
      name: tenant.name,
      slug: tenant.slug,
      requireMfaForAdmins: tenant.requireMfaForAdmins,
      legalName: tenant.profile?.legalName ?? null,
      taxId: tenant.profile?.taxId ?? null,
      phone: tenant.profile?.phone ?? null,
      address: tenant.profile?.address ?? null,
      receiptHeader: tenant.profile?.receiptHeader ?? null,
      receiptFooter: tenant.profile?.receiptFooter ?? null,
      serviceChargeBp: tenant.profile?.serviceChargeBp ?? 0,
      allowNegativeStock: tenant.profile?.allowNegativeStock ?? true,
      publicOrdering: tenant.profile?.publicOrdering ?? false,
    });
  });

  router.patch(
    '/settings',
    requireAuth(),
    requirePermission('settings.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(settingsInput, req.body);
      const profile = {
        legalName: input.legalName ?? null,
        taxId: input.taxId ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        receiptHeader: input.receiptHeader ?? null,
        receiptFooter: input.receiptFooter ?? null,
        serviceChargeBp: input.serviceChargeBp,
        allowNegativeStock: input.allowNegativeStock,
        publicOrdering: input.publicOrdering,
      };
      await db.$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id: auth.tenantId },
          data: {
            name: input.name,
            requireMfaForAdmins: input.requireMfaForAdmins,
          },
        });
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          create: { tenantId: auth.tenantId, ...profile },
          update: profile,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.update',
          entityType: 'tenant',
          entityId: auth.tenantId,
          data: {
            serviceChargeBp: input.serviceChargeBp,
            requireMfaForAdmins: input.requireMfaForAdmins,
          },
        });
      });
      res.json({ ok: true });
    },
  );

  return router;
}
