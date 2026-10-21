import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type {
  ControlActivation,
  ControlCustomer,
  ControlLicense,
  Prisma,
} from '../../generated/prisma/client.js';
import { errors, isUniqueViolation, parse } from '../../http/errors.js';
import { planFeatures } from '../billing/entitlements.js';
import { catalogByKey } from './catalog.js';
import { compareVersions, timing } from './grant.js';
import { loadPolicy } from './issue.js';
import { generateLicenseKey } from './keys.js';
import {
  controlAudit,
  getOwner,
  loadOwner,
  requireOwner,
  requireOwnerReauth,
} from './owner.js';
import { defaultNetwork, normalizeNetwork } from './network.js';
import { sanitizeFeatures } from './policy.js';
import { clearPolicyCache } from './view.js';
import { signDocument } from './keys.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, verifyBackup } from '../../lib/backup.js';

const paramValues = z.record(
  z.string().max(40),
  z.union([z.number(), z.string().max(40), z.boolean()]),
);

const DAY = 86_400_000;

/** Drops undefined values (exactOptionalPropertyTypes-safe update payloads). */
function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** End of a calendar day in Tashkent (UTC+5): a licence is valid through its last day. */
export function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999+05:00`);
}

function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export type Presence = 'ONLINE' | 'OFFLINE' | 'BLOCKED' | 'NEVER';

export function presenceOf(
  activation: Pick<ControlActivation, 'status' | 'lastHeartbeatAt'>,
  at: Date,
): Presence {
  if (activation.status !== 'ACTIVE') return 'BLOCKED';
  if (!activation.lastHeartbeatAt) return 'NEVER';
  return at.getTime() - activation.lastHeartbeatAt.getTime() <=
    timing.presenceWindowMs
    ? 'ONLINE'
    : 'OFFLINE';
}

type Command = {
  id: string;
  type: 'terminate_sessions';
  scope: string;
  username?: string;
  issuedAt: string;
};

async function queueCommand(
  tx: Db | Tx,
  activationId: string,
  command: Omit<Command, 'id' | 'issuedAt'>,
  at: Date,
) {
  const row = await tx.controlActivation.findUniqueOrThrow({
    where: { id: activationId },
    select: { pendingCommands: true },
  });
  const list = Array.isArray(row.pendingCommands)
    ? (row.pendingCommands as Command[])
    : [];
  list.push({ ...command, id: randomUUID(), issuedAt: at.toISOString() });
  await tx.controlActivation.update({
    where: { id: activationId },
    data: {
      pendingCommands: list.slice(-20) as unknown as Prisma.InputJsonValue,
    },
  });
}

const licenseTerms = z.object({
  maxInstalls: z.number().int().min(1).max(100).default(1),
  maxDevices: z.number().int().min(1).max(1000).nullable().default(null),
  maxBranches: z.number().int().min(1).max(1000).nullable().default(null),
  maxUsers: z.number().int().min(1).max(10_000).nullable().default(null),
  features: z.array(z.enum(planFeatures)).default([...planFeatures]),
  note: z.string().trim().max(500).nullable().default(null),
});

function licenseView(license: ControlLicense, at: Date) {
  const daysLeft = Math.ceil(
    (license.expiresAt.getTime() - at.getTime()) / DAY,
  );
  return {
    id: license.id,
    keyHint: license.keyHint,
    status: license.status,
    startsAt: license.startsAt,
    expiresAt: license.expiresAt,
    daysLeft: Math.max(daysLeft, 0),
    expired: daysLeft <= 0,
    maxInstalls: license.maxInstalls,
    maxDevices: license.maxDevices,
    maxBranches: license.maxBranches,
    maxUsers: license.maxUsers,
    features: license.features,
    note: license.note,
    renewedAt: license.renewedAt,
    createdAt: license.createdAt,
  };
}

export function deviceView(
  activation: ControlActivation & {
    customer?: Pick<ControlCustomer, 'name'>;
    terminals?: {
      id: string;
      localId: string;
      name: string;
      branchName: string | null;
      panel: string;
      status: string;
      appVersion: string | null;
      model: string | null;
      os: string | null;
      lastSeenAt: Date | null;
      lastIp: string | null;
      currentUser: string | null;
    }[];
  },
  at: Date,
) {
  return {
    id: activation.id,
    customerId: activation.customerId,
    customerName: activation.customer?.name ?? null,
    licenseId: activation.licenseId,
    deviceName: activation.deviceName,
    model: activation.model,
    os: activation.os,
    platform: activation.platform,
    appVersion: activation.appVersion,
    branchName: activation.branchName,
    status: activation.status,
    presence: presenceOf(activation, at),
    activatedAt: activation.activatedAt,
    lastHeartbeatAt: activation.lastHeartbeatAt,
    // Network address as seen by the server; never a physical location.
    lastIp: activation.lastIp,
    currentUser: activation.currentUser,
    stats: activation.stats,
    blockedReason: activation.blockedReason,
    terminals: (activation.terminals ?? []).map((terminal) => ({
      ...terminal,
      presence:
        terminal.status !== 'ACTIVE'
          ? 'BLOCKED'
          : terminal.lastSeenAt &&
              at.getTime() - terminal.lastSeenAt.getTime() <=
                timing.presenceWindowMs * 2
            ? 'ONLINE'
            : 'OFFLINE',
    })),
  };
}

/** Owner-facing management API: customers, licences, payments, devices, policy. */
export function manageRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const authed = [loadOwner(services), requireOwner()];
  const sensitive = [...authed, requireOwnerReauth(services)];
  const idParam = (value: unknown) => parse(z.uuid(), value);

  router.get('/control/overview', ...authed, async (_req, res) => {
    const at = now();
    const soon = new Date(at.getTime() + 7 * DAY);
    const [customers, licenses, expiring, activations, conflicts] =
      await Promise.all([
        db.controlCustomer.count({ where: { status: 'ACTIVE' } }),
        db.controlLicense.count({
          where: { status: 'ACTIVE', expiresAt: { gt: at } },
        }),
        db.controlLicense.count({
          where: { status: 'ACTIVE', expiresAt: { gt: at, lte: soon } },
        }),
        db.controlActivation.findMany({
          select: { status: true, lastHeartbeatAt: true },
        }),
        db.controlSyncOp.count({ where: { status: 'CONFLICT' } }),
      ]);
    const presence = { ONLINE: 0, OFFLINE: 0, BLOCKED: 0, NEVER: 0 };
    for (const activation of activations)
      presence[presenceOf(activation, at)]++;
    res.json({
      customers,
      activeLicenses: licenses,
      expiringSoon: expiring,
      devices: presence,
      syncConflicts: conflicts,
    });
  });

  // ---- customers ------------------------------------------------------------

  router.get('/control/customers', ...authed, async (_req, res) => {
    const at = now();
    const customers = await db.controlCustomer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        licenses: { orderBy: { createdAt: 'desc' } },
        activations: {
          select: { status: true, lastHeartbeatAt: true, appVersion: true },
        },
        branches: { select: { id: true } },
      },
    });
    res.json({
      customers: customers.map((customer) => {
        const license =
          customer.licenses.find((item) => item.status === 'ACTIVE') ??
          customer.licenses[0] ??
          null;
        const presence = { ONLINE: 0, OFFLINE: 0, BLOCKED: 0, NEVER: 0 };
        for (const activation of customer.activations)
          presence[presenceOf(activation, at)]++;
        return {
          id: customer.id,
          name: customer.name,
          contactName: customer.contactName,
          phone: customer.phone,
          status: customer.status,
          license: license ? licenseView(license, at) : null,
          devices: presence,
          branchCount: customer.branches.length,
          createdAt: customer.createdAt,
        };
      }),
    });
  });

  router.post('/control/customers', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        contactName: z.string().trim().max(120).nullable().default(null),
        phone: z.string().trim().max(40).nullable().default(null),
        note: z.string().trim().max(1000).nullable().default(null),
      }),
      req.body,
    );
    const customer = await db.$transaction(async (tx) => {
      const created = await tx.controlCustomer.create({ data: input });
      await tx.controlPolicy.create({ data: { customerId: created.id } });
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        customerId: created.id,
        action: 'customer.create',
        entityType: 'customer',
        entityId: created.id,
        data: { name: input.name },
      });
      return created;
    });
    res.status(201).json({ id: customer.id });
  });

  router.get('/control/customers/:id', ...authed, async (req, res) => {
    const id = idParam(req.params.id);
    const at = now();
    const customer = await db.controlCustomer.findUnique({
      where: { id },
      include: {
        licenses: { orderBy: { createdAt: 'desc' } },
        activations: {
          orderBy: { activatedAt: 'desc' },
          include: { terminals: true },
        },
        branches: { orderBy: { name: 'asc' } },
        payments: { orderBy: { paidAt: 'desc' }, take: 50 },
      },
    });
    if (!customer) throw errors.notFound();
    const policy = await loadPolicy(db, id);
    res.json({
      id: customer.id,
      name: customer.name,
      contactName: customer.contactName,
      phone: customer.phone,
      note: customer.note,
      status: customer.status,
      // The restaurant runs on this server: the Owner may browse its data.
      hosted: customer.tenantId !== null,
      createdAt: customer.createdAt,
      licenses: customer.licenses.map((license) => licenseView(license, at)),
      devices: customer.activations.map((activation) =>
        deviceView(activation, at),
      ),
      branches: customer.branches.map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        isActive: branch.isActive,
        lastReportedAt: branch.lastReportedAt,
      })),
      payments: customer.payments,
      policy,
    });
  });

  router.patch('/control/customers/:id', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const input = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        contactName: z.string().trim().max(120).nullable().optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        note: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const result = await tx.controlCustomer.updateMany({
        where: { id },
        data: defined(input),
      });
      if (result.count === 0) throw errors.notFound();
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        customerId: id,
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        data: { fields: Object.keys(input) },
      });
    });
    res.json({ ok: true });
  });

  router.post(
    '/control/customers/:id/status',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = idParam(req.params.id);
      const { status } = parse(
        z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const result = await tx.controlCustomer.updateMany({
          where: { id },
          data: { status },
        });
        if (result.count === 0) throw errors.notFound();
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId: id,
          action: `customer.status.${status.toLowerCase()}`,
          entityType: 'customer',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  // ---- licences ------------------------------------------------------------

  router.post(
    '/control/customers/:id/licenses',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const customerId = idParam(req.params.id);
      const input = parse(
        licenseTerms.extend({
          months: z.number().int().min(1).max(60).optional(),
          expiresAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
        req.body,
      );
      if (!input.months && !input.expiresAt)
        throw errors.validation([{ path: 'months' }]);
      const at = now();
      const expiresAt = input.expiresAt
        ? endOfDay(input.expiresAt)
        : endOfDay(addMonths(at, input.months!).toISOString().slice(0, 10));
      const customer = await db.controlCustomer.findUnique({
        where: { id: customerId },
      });
      if (!customer) throw errors.notFound();
      // The plaintext key exists only in this response; storage keeps its keyed hash.
      const key = generateLicenseKey();
      const license = await db.$transaction(async (tx) => {
        const created = await tx.controlLicense.create({
          data: {
            customerId,
            keyHash: services.secrets.keyedHash('license-key', key),
            keyHint: key.slice(-5),
            expiresAt,
            maxInstalls: input.maxInstalls,
            maxDevices: input.maxDevices,
            maxBranches: input.maxBranches,
            maxUsers: input.maxUsers,
            features: input.features,
            note: input.note,
            createdById: owner.ownerId,
          },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: 'license.issue',
          entityType: 'license',
          entityId: created.id,
          data: {
            expiresAt: expiresAt.toISOString(),
            keyHint: created.keyHint,
          },
        });
        return created;
      });
      res
        .status(201)
        .json({ id: license.id, key, license: licenseView(license, at) });
    },
  );

  const licenseAction = (
    path: string,
    action: string,
    apply: (
      license: ControlLicense,
      body: Record<string, unknown>,
      at: Date,
    ) => Prisma.ControlLicenseUpdateInput | null,
  ) =>
    router.post(
      `/control/licenses/:id/${path}`,
      ...sensitive,
      async (req, res) => {
        const owner = getOwner(res);
        const id = idParam(req.params.id);
        const at = now();
        await db.$transaction(async (tx) => {
          const license = await tx.controlLicense.findUnique({ where: { id } });
          if (!license) throw errors.notFound();
          const data = apply(
            license,
            (req.body ?? {}) as Record<string, unknown>,
            at,
          );
          if (!data) throw errors.conflict();
          await tx.controlLicense.update({ where: { id }, data });
          await controlAudit(tx, req, {
            ownerId: owner.ownerId,
            customerId: license.customerId,
            action,
            entityType: 'license',
            entityId: id,
          });
        });
        res.json({ ok: true });
      },
    );

  licenseAction('suspend', 'license.suspend', (license, _body, at) =>
    license.status === 'ACTIVE'
      ? { status: 'SUSPENDED', suspendedAt: at }
      : null,
  );
  licenseAction('resume', 'license.resume', (license) =>
    license.status === 'SUSPENDED'
      ? { status: 'ACTIVE', suspendedAt: null }
      : null,
  );
  licenseAction('revoke', 'license.revoke', (license, _body, at) =>
    license.status !== 'REVOKED' ? { status: 'REVOKED', revokedAt: at } : null,
  );

  router.post('/control/licenses/:id/renew', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const input = parse(
      z.object({ months: z.number().int().min(1).max(60) }),
      req.body,
    );
    const at = now();
    const expiresAt = await db.$transaction(async (tx) => {
      const license = await tx.controlLicense.findUnique({ where: { id } });
      if (!license || license.status === 'REVOKED') throw errors.notFound();
      // Whole months from the later of today and the current end.
      const base = license.expiresAt > at ? license.expiresAt : at;
      const next = endOfDay(
        addMonths(base, input.months).toISOString().slice(0, 10),
      );
      await tx.controlLicense.update({
        where: { id },
        data: { expiresAt: next, renewedAt: at },
      });
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        customerId: license.customerId,
        action: 'license.renew',
        entityType: 'license',
        entityId: id,
        data: { months: input.months, expiresAt: next.toISOString() },
      });
      return next;
    });
    res.json({ expiresAt });
  });

  router.patch('/control/licenses/:id', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const input = parse(licenseTerms.partial(), req.body);
    await db.$transaction(async (tx) => {
      const license = await tx.controlLicense.findUnique({ where: { id } });
      if (!license) throw errors.notFound();
      await tx.controlLicense.update({ where: { id }, data: defined(input) });
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        customerId: license.customerId,
        action: 'license.update',
        entityType: 'license',
        entityId: id,
        data: { fields: Object.keys(input) },
      });
    });
    res.json({ ok: true });
  });

  // ---- payments --------------------------------------------------------------

  router.post(
    '/control/customers/:id/payments',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const customerId = idParam(req.params.id);
      const input = parse(
        z.object({
          amount: z.number().int().min(0).max(1_000_000_000),
          method: z
            .enum(['CASH', 'TRANSFER', 'CARD', 'CLICK', 'PAYME', 'OTHER'])
            .default('TRANSFER'),
          periodMonths: z.number().int().min(0).max(60).default(0),
          licenseId: z.uuid().optional(),
          reference: z.string().trim().max(100).nullable().default(null),
          note: z.string().trim().max(500).nullable().default(null),
        }),
        req.body,
      );
      const at = now();
      const result = await db.$transaction(async (tx) => {
        const customer = await tx.controlCustomer.findUnique({
          where: { id: customerId },
        });
        if (!customer) throw errors.notFound();
        let license: ControlLicense | null = null;
        if (input.periodMonths > 0 || input.licenseId) {
          license = await tx.controlLicense.findFirst({
            where: {
              customerId,
              status: { not: 'REVOKED' },
              ...(input.licenseId ? { id: input.licenseId } : {}),
            },
            orderBy: { createdAt: 'desc' },
          });
          if (!license) throw errors.notFound();
        }
        let expiresAt: Date | null = null;
        if (license && input.periodMonths > 0) {
          const base = license.expiresAt > at ? license.expiresAt : at;
          expiresAt = endOfDay(
            addMonths(base, input.periodMonths).toISOString().slice(0, 10),
          );
          await tx.controlLicense.update({
            where: { id: license.id },
            data: { expiresAt, renewedAt: at },
          });
        }
        const payment = await tx.controlPayment.create({
          data: {
            customerId,
            licenseId: license?.id ?? null,
            amount: input.amount,
            method: input.method,
            periodMonths: input.periodMonths,
            reference: input.reference,
            note: input.note,
            paidAt: at,
            recordedById: owner.ownerId,
          },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: 'payment.record',
          entityType: 'payment',
          entityId: payment.id,
          data: {
            amount: input.amount,
            periodMonths: input.periodMonths,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
        return { id: payment.id, expiresAt };
      });
      res.status(201).json(result);
    },
  );

  router.get('/control/payments', ...authed, async (req, res) => {
    const { customerId } = parse(
      z.object({ customerId: z.uuid().optional() }),
      req.query,
    );
    const payments = await db.controlPayment.findMany({
      where: customerId ? { customerId } : {},
      orderBy: { paidAt: 'desc' },
      take: 200,
      include: { customer: { select: { name: true } } },
    });
    res.json({
      payments: payments.map((payment) => ({
        id: payment.id,
        customerId: payment.customerId,
        customerName: payment.customer.name,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        periodMonths: payment.periodMonths,
        reference: payment.reference,
        paidAt: payment.paidAt,
      })),
    });
  });

  // ---- devices --------------------------------------------------------------

  router.get('/control/devices', ...authed, async (req, res) => {
    const query = parse(
      z.object({
        customerId: z.uuid().optional(),
        presence: z.enum(['ONLINE', 'OFFLINE', 'BLOCKED', 'NEVER']).optional(),
        q: z.string().trim().max(80).optional(),
      }),
      req.query,
    );
    const at = now();
    const activations = await db.controlActivation.findMany({
      where: {
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.q
          ? {
              OR: [
                { deviceName: { contains: query.q, mode: 'insensitive' } },
                { currentUser: { contains: query.q, mode: 'insensitive' } },
                {
                  customer: {
                    name: { contains: query.q, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 500,
      include: { customer: { select: { name: true } }, terminals: true },
    });
    const rows = activations
      .map((activation) => deviceView(activation, at))
      .filter((row) => !query.presence || row.presence === query.presence);
    res.json({ devices: rows });
  });

  const deviceAction = (
    path: string,
    action: string,
    apply: (
      tx: Tx,
      activation: ControlActivation,
      body: Record<string, unknown>,
      at: Date,
    ) => Promise<void>,
  ) =>
    router.post(
      `/control/devices/:id/${path}`,
      ...sensitive,
      async (req, res) => {
        const owner = getOwner(res);
        const id = idParam(req.params.id);
        const at = now();
        await db.$transaction(async (tx) => {
          const activation = await tx.controlActivation.findUnique({
            where: { id },
          });
          if (!activation) throw errors.notFound();
          await apply(
            tx,
            activation,
            (req.body ?? {}) as Record<string, unknown>,
            at,
          );
          await controlAudit(tx, req, {
            ownerId: owner.ownerId,
            customerId: activation.customerId,
            action,
            entityType: 'device',
            entityId: id,
          });
        });
        res.json({ ok: true });
      },
    );

  deviceAction('block', 'device.block', async (tx, activation, body, at) => {
    await tx.controlActivation.update({
      where: { id: activation.id },
      data: {
        status: 'BLOCKED',
        blockedReason:
          typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
      },
    });
    await queueCommand(
      tx,
      activation.id,
      { type: 'terminate_sessions', scope: 'all' },
      at,
    );
  });
  deviceAction('unblock', 'device.unblock', async (tx, activation) => {
    if (activation.status !== 'BLOCKED') throw errors.conflict();
    await tx.controlActivation.update({
      where: { id: activation.id },
      data: { status: 'ACTIVE', blockedReason: null },
    });
  });
  // Replacement frees the licence slot; the old installation is revoked on its next
  // check-in and a new computer can activate with the same key.
  deviceAction(
    'replace',
    'device.replace',
    async (tx, activation, _body, at) => {
      if (activation.status === 'REPLACED') throw errors.conflict();
      await tx.controlActivation.update({
        where: { id: activation.id },
        data: { status: 'REPLACED', replacedAt: at },
      });
      await queueCommand(
        tx,
        activation.id,
        { type: 'terminate_sessions', scope: 'all' },
        at,
      );
    },
  );
  deviceAction(
    'terminate-sessions',
    'device.sessions.terminate',
    async (tx, activation, body, at) => {
      const username =
        typeof body.username === 'string'
          ? body.username.slice(0, 40)
          : undefined;
      await queueCommand(
        tx,
        activation.id,
        {
          type: 'terminate_sessions',
          scope: username ? 'user' : 'all',
          ...(username ? { username } : {}),
        },
        at,
      );
    },
  );

  // ---- policy ------------------------------------------------------------

  router.get('/control/customers/:id/policy', ...authed, async (req, res) => {
    const id = idParam(req.params.id);
    if (
      !(await db.controlCustomer.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw errors.notFound();
    res.json(await loadPolicy(db, id));
  });

  router.put(
    '/control/customers/:id/policy',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const customerId = idParam(req.params.id);
      const input = parse(
        z.object({
          features: z.record(
            z.string().refine((key) => catalogByKey.has(key)),
            z.object({
              mode: z.enum(['ON', 'OFF', 'ADMIN']).optional(),
              online: z.boolean().optional(),
              offline: z.boolean().optional(),
              params: paramValues.optional(),
              roles: z
                .record(
                  z.string().max(40),
                  z.object({
                    enabled: z.boolean().optional(),
                    params: paramValues.optional(),
                  }),
                )
                .optional(),
            }),
          ),
          offlineEnabled: z.boolean(),
          maxOfflineMinutes: z
            .number()
            .int()
            .min(0)
            .max(30 * 24 * 60),
          minAppVersion: z
            .string()
            .regex(/^\d+\.\d+\.\d+$/)
            .nullable()
            .default(null),
          minVersionFrom: z.iso.datetime().nullable().default(null),
          // Omitted = keep what is stored. null = revoke the exception.
          networkOverride: z
            .object({
              days: z.number().int().min(1).max(90),
              roles: z
                .array(z.string().regex(/^[a-z0-9_-]{1,40}$/))
                .max(20)
                .default([]),
              reason: z.string().trim().min(3).max(200),
            })
            .nullable()
            .optional(),
        }),
        req.body,
      );
      const features = sanitizeFeatures(input.features);
      const version = await db.$transaction(async (tx) => {
        const customer = await tx.controlCustomer.findUnique({
          where: { id: customerId },
        });
        if (!customer) throw errors.notFound();
        const before = await tx.controlPolicy.findUnique({
          where: { customerId },
        });
        const at = services.now?.() ?? new Date();
        const network =
          input.networkOverride === undefined
            ? normalizeNetwork(before?.network)
            : input.networkOverride === null
              ? defaultNetwork()
              : {
                  override: {
                    grantedAt: at.toISOString(),
                    expiresAt: new Date(
                      at.getTime() + input.networkOverride.days * 86_400_000,
                    ).toISOString(),
                    roles: input.networkOverride.roles,
                    reason: input.networkOverride.reason,
                  },
                };
        const data = {
          network: network as unknown as Prisma.InputJsonValue,
          features: features as unknown as Prisma.InputJsonValue,
          offlineEnabled: input.offlineEnabled,
          maxOfflineMinutes: input.offlineEnabled ? input.maxOfflineMinutes : 0,
          minAppVersion: input.minAppVersion,
          minVersionFrom: input.minVersionFrom
            ? new Date(input.minVersionFrom)
            : null,
          updatedById: owner.ownerId,
        };
        const saved = await tx.controlPolicy.upsert({
          where: { customerId },
          create: { customerId, ...data },
          update: { ...data, version: { increment: 1 } },
        });
        const changed = new Set<string>();
        const prior = sanitizeFeatures(before?.features ?? {});
        for (const key of new Set([
          ...Object.keys(prior),
          ...Object.keys(features),
        ]))
          if (JSON.stringify(prior[key]) !== JSON.stringify(features[key]))
            changed.add(key);
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: 'policy.update',
          entityType: 'policy',
          entityId: customerId,
          data: {
            version: saved.version,
            changedFeatures: [...changed].slice(0, 100),
            offlineEnabled: input.offlineEnabled,
            maxOfflineMinutes: data.maxOfflineMinutes,
            minAppVersion: input.minAppVersion,
            ...(input.networkOverride !== undefined
              ? {
                  networkOverride: network.override
                    ? {
                        expiresAt: network.override.expiresAt,
                        roles: network.override.roles,
                        reason: network.override.reason,
                      }
                    : 'revoked',
                }
              : {}),
          },
        });
        return saved.version;
      });
      // Hosted restaurants see the change at once; installs get it with the next
      // heartbeat and announce it to their own panels then.
      clearPolicyCache();
      const linked = await db.controlCustomer.findUnique({
        where: { id: customerId },
        select: { tenantId: true },
      });
      if (linked?.tenantId)
        services.events?.publish({
          type: 'config.changed',
          tenantId: linked.tenantId,
        });
      res.json({ version });
    },
  );

  // ---- audit and synchronisation ledger ------------------------------------

  router.get('/control/audit', ...authed, async (req, res) => {
    const query = parse(
      z.object({
        customerId: z.uuid().optional(),
        action: z.string().trim().max(60).optional(),
        outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    const rows = await db.controlAuditLog.findMany({
      where: {
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.action ? { action: { startsWith: query.action } } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.before ? { id: { lt: BigInt(query.before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
    });
    res.json({
      entries: rows.map((row) => ({ ...row, id: Number(row.id) })),
    });
  });

  router.get('/control/customers/:id/sync', ...authed, async (req, res) => {
    const id = idParam(req.params.id);
    const rows = await db.controlSyncOp.findMany({
      where: { customerId: id },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        opId: true,
        type: true,
        status: true,
        result: true,
        receivedAt: true,
        activationId: true,
      },
    });
    res.json({ operations: rows });
  });

  // ---- backups ------------------------------------------------------------

  // Writes a fresh backup, restores it into a scratch database and compares every
  // table: the answer proves the backup can actually be restored.
  router.post('/control/backup/verify', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const url = services.databaseUrl;
    if (!url) throw errors.notFound();
    const dir = await mkdtemp(join(tmpdir(), 'ff-verify-'));
    const started = Date.now();
    try {
      const file = join(dir, 'backup.ndjson.gz');
      const summary = await createBackup(url, file);
      const result = await verifyBackup(url, file, summary);
      await controlAudit(db, req, {
        ownerId: owner.ownerId,
        action: 'backup.verify',
        outcome: result.ok ? 'SUCCESS' : 'FAILURE',
        data: {
          tables: result.tables,
          rows: result.rows,
          mismatches: result.mismatches.length,
        },
      });
      res.json({
        ...result,
        bytes: summary.bytes,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- releases and staged updates ------------------------------------------

  router.get('/control/releases', ...authed, async (_req, res) => {
    const releases = await db.controlRelease.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const activations = await db.controlActivation.findMany({
      where: { status: 'ACTIVE' },
      select: { appVersion: true, platform: true },
    });
    const adoption = new Map<string, number>();
    for (const activation of activations)
      if (activation.appVersion)
        adoption.set(
          activation.appVersion,
          (adoption.get(activation.appVersion) ?? 0) + 1,
        );
    res.json({
      releases: releases.map((release) => ({
        ...release,
        installs: adoption.get(release.version) ?? 0,
      })),
      versions: [...adoption.entries()].map(([version, count]) => ({
        version,
        count,
      })),
    });
  });

  router.post('/control/releases', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(
      z.object({
        platform: z.enum(['EXE', 'APK']),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        url: z
          .string()
          .url()
          .refine((value) => value.startsWith('https://')),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().positive().nullable().default(null),
        notes: z.string().trim().max(2000).nullable().default(null),
      }),
      req.body,
    );
    const key = services.control?.signingKeyPem;
    if (!key) throw errors.forbidden();
    try {
      const release = await db.$transaction(async (tx) => {
        const created = await tx.controlRelease.create({
          data: {
            ...input,
            signature: signDocument(key, {
              t: 'release',
              platform: input.platform,
              version: input.version,
              url: input.url,
              sha256: input.sha256,
              size: input.size,
            }),
            createdById: owner.ownerId,
          },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          action: 'release.create',
          entityType: 'release',
          entityId: created.id,
          data: { platform: input.platform, version: input.version },
        });
        return created;
      });
      res.status(201).json({ id: release.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.post('/control/releases/:id/stage', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const input = parse(
      z.object({
        stage: z.enum(['DRAFT', 'STAGED', 'ALL', 'WITHDRAWN']),
        rolloutPercent: z.number().int().min(0).max(100).default(0),
        minVersion: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .nullable()
          .default(null),
      }),
      req.body,
    );
    if (input.minVersion) {
      const release = await db.controlRelease.findUnique({ where: { id } });
      if (release && compareVersions(input.minVersion, release.version) > 0)
        throw errors.validation([{ path: 'minVersion' }]);
    }
    await db.$transaction(async (tx) => {
      const result = await tx.controlRelease.updateMany({
        where: { id },
        data: {
          stage: input.stage,
          rolloutPercent: input.stage === 'ALL' ? 100 : input.rolloutPercent,
          minVersion: input.minVersion,
        },
      });
      if (result.count === 0) throw errors.notFound();
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        action: 'release.stage',
        entityType: 'release',
        entityId: id,
        data: input,
      });
    });
    res.json({ ok: true });
  });

  return router;
}
