import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import {
  describeZone,
  PRESETS,
  TEMPLATES,
  validateWorkflow,
  workflowConfigSchema,
  ZONE_LABEL,
  ZONES,
  type RestaurantFacts,
  type WorkflowConfig,
  type Zone,
} from '../workflow/engine.js';
import { storeWorkflow } from '../workflow/restaurant.js';
import {
  controlAudit,
  getOwner,
  loadOwner,
  requireOwner,
  requireOwnerReauth,
} from './owner.js';

/** The newest (active) workflow of a customer, as sent to its restaurant. */
export async function activeWorkflow(db: Db, customerId: string) {
  const row = await db.controlWorkflow.findFirst({
    where: { customerId },
    orderBy: { version: 'desc' },
  });
  return row ? { version: row.version, config: row.config } : null;
}

/** What the restaurant last reported about itself (its newest working computer). */
async function factsOf(db: Db, customerId: string): Promise<RestaurantFacts | null> {
  const activation = await db.controlActivation.findFirst({
    where: { customerId, status: 'ACTIVE' },
    orderBy: { lastHeartbeatAt: 'desc' },
    select: { capabilities: true, stats: true },
  });
  if (!activation) return null;
  const stats = (activation.stats ?? {}) as { facts?: Omit<RestaurantFacts, 'capabilities'> };
  return { capabilities: activation.capabilities, ...(stats.facts ?? {}) };
}

const routesOf = (config: WorkflowConfig) =>
  (Object.keys(config.zones) as Zone[])
    .sort((a, b) => ZONES.indexOf(a) - ZONES.indexOf(b))
    .map((zone) => ({
      zone,
      label: ZONE_LABEL[zone],
      steps: describeZone(config.zones[zone]!),
    }));

/**
 * Owner → Mijozlar → Restoran → Ish rejimlari: presets, templates, preview with
 * checks, activation (a new version), history and rollback. Nothing changes for a
 * restaurant until the Owner activates a configuration; open orders keep the version
 * they were created with.
 */
export function workflowRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const authed = [loadOwner(services), requireOwner()];
  const sensitive = [...authed, requireOwnerReauth(services)];
  const idParam = (value: unknown) => parse(z.uuid(), value);

  const customerOf = async (id: string) => {
    const customer = await db.controlCustomer.findUnique({
      where: { id },
      select: { id: true, tenantId: true, name: true },
    });
    if (!customer) throw errors.notFound();
    return customer;
  };

  router.get('/control/customers/:id/workflow', ...authed, async (req, res) => {
    const customer = await customerOf(idParam(req.params.id));
    const rows = await db.controlWorkflow.findMany({
      where: { customerId: customer.id },
      orderBy: { version: 'desc' },
      take: 30,
    });
    const active = rows[0] ?? null;
    res.json({
      active: active
        ? {
            version: active.version,
            config: active.config,
            note: active.note,
            createdAt: active.createdAt,
            routes: routesOf(workflowConfigSchema.parse(active.config)),
          }
        : null,
      history: rows.map((row) => {
        const config = row.config as { enabled?: boolean; preset?: number | null };
        return {
          version: row.version,
          note: row.note,
          createdAt: row.createdAt,
          enabled: config.enabled === true,
          preset: config.preset ?? null,
        };
      }),
      presets: PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        steps: preset.steps,
        needs: preset.needs ?? null,
        config: preset.config(),
      })),
      templates: TEMPLATES.map((template) => ({
        key: template.key,
        name: template.name,
        preset: template.preset,
        config: template.config(),
      })),
      zones: ZONES.map((zone) => ({ zone, label: ZONE_LABEL[zone] })),
      facts: await factsOf(db, customer.id),
      hosted: customer.tenantId !== null,
    });
  });

  // Settings check, conflicts and the order route of every zone — nothing is saved.
  router.post(
    '/control/customers/:id/workflow/preview',
    ...authed,
    async (req, res) => {
      const customer = await customerOf(idParam(req.params.id));
      const config = parse(workflowConfigSchema, req.body?.config);
      res.json({
        issues: validateWorkflow(config, await factsOf(db, customer.id)),
        routes: routesOf(config),
      });
    },
  );

  // Activation: a new version; errors in the check refuse it.
  const activate = async (
    req: Parameters<Parameters<typeof router.post>[1]>[0],
    customerId: string,
    config: WorkflowConfig,
    note: string | null,
    action: string,
  ) => {
    const owner = getOwner(req.res!);
    const customer = await customerOf(customerId);
    const issues = validateWorkflow(config, await factsOf(db, customer.id));
    if (config.enabled && issues.some((issue) => issue.level === 'error'))
      throw new AppError(409, 'WORKFLOW_INVALID', 'workflowInvalid', { issues });
    const created = await db.$transaction(async (tx) => {
      const last = await tx.controlWorkflow.findFirst({
        where: { customerId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;
      const row = await tx.controlWorkflow.create({
        data: {
          customerId,
          version,
          config: config as unknown as Prisma.InputJsonValue,
          note,
          createdById: owner.ownerId,
        },
      });
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        customerId,
        action,
        entityType: 'workflow',
        entityId: row.id,
        data: { version, preset: config.preset, enabled: config.enabled },
      });
      return row;
    });
    // A restaurant hosted on this server gets it at once; installs on their next
    // check-in (about a minute).
    if (customer.tenantId)
      await storeWorkflow(db, customer.tenantId, {
        version: created.version,
        config,
      });
    return created.version;
  };

  router.post('/control/customers/:id/workflow', ...sensitive, async (req, res) => {
    const input = parse(
      z.object({
        config: workflowConfigSchema,
        note: z.string().trim().max(200).nullable().optional(),
        confirm: z.literal(true),
      }),
      req.body,
    );
    const version = await activate(
      req,
      idParam(req.params.id),
      input.config,
      input.note ?? null,
      input.config.enabled ? 'workflow.activate' : 'workflow.disable',
    );
    res.status(201).json({ version });
  });

  // Back to an earlier configuration (it becomes the newest version again).
  router.post(
    '/control/customers/:id/workflow/rollback',
    ...sensitive,
    async (req, res) => {
      const customerId = idParam(req.params.id);
      const { version } = parse(
        z.object({ version: z.number().int().min(1), confirm: z.literal(true) }),
        req.body,
      );
      const row = await db.controlWorkflow.findUnique({
        where: { customerId_version: { customerId, version } },
      });
      if (!row) throw errors.notFound();
      const next = await activate(
        req,
        customerId,
        workflowConfigSchema.parse(row.config),
        `v${version} ga qaytarildi`,
        'workflow.rollback',
      );
      res.status(201).json({ version: next });
    },
  );

  return router;
}
