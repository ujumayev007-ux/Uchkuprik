import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { messages } from '../../messages.js';
import { planFeatures } from '../billing/entitlements.js';
import { timing } from './grant.js';
import { fingerprintOf, generateLicenseKey, verifyValue } from './keys.js';
import {
  controlAudit,
  getOwner,
  loadOwner,
  requireOwner,
  requireOwnerReauth,
} from './owner.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ----------------------------------------------------------------- settings

export const registrySettingsDefault = {
  // A brand-new installation gets one trial by itself, the moment it first registers.
  autoTrial: true,
  trialHours: 72,
};
export type RegistrySettings = typeof registrySettingsDefault;

export async function registrySettings(db: Db | Tx): Promise<RegistrySettings> {
  const row = await db.controlSetting.findUnique({
    where: { key: 'registry' },
  });
  const value = (row?.value ?? {}) as Partial<RegistrySettings>;
  return {
    autoTrial: value.autoTrial ?? registrySettingsDefault.autoTrial,
    trialHours:
      Number.isInteger(value.trialHours) &&
      (value.trialHours as number) >= 1 &&
      (value.trialHours as number) <= 24 * 30
        ? (value.trialHours as number)
        : registrySettingsDefault.trialHours,
  };
}

// ------------------------------------------------------------------- events

/** Persists a vendor notification once, however often the same thing is reported. */
export async function recordEvent(
  db: Db | Tx,
  event: {
    type: string;
    dedupeKey: string;
    customerId?: string | null;
    registrationId?: string | null;
    data?: Prisma.InputJsonValue;
  },
) {
  try {
    await db.controlEvent.create({
      data: {
        type: event.type,
        dedupeKey: event.dedupeKey,
        customerId: event.customerId ?? null,
        registrationId: event.registrationId ?? null,
        data: event.data ?? {},
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

// ----------------------------------------------------------------- licences

/**
 * A licence whose clock starts at the first server-authorised activation: the end is
 * fixed then (activation + hours), not when the key is created. Until the first
 * activation `expiresAt` is only the deadline for using the key.
 */
export async function issueTrialLicense(
  tx: Tx,
  services: Services,
  input: {
    customerId: string;
    hours: number;
    at: Date;
    ownerId?: string | null;
    note?: string | null;
  },
) {
  const key = generateLicenseKey();
  const license = await tx.controlLicense.create({
    data: {
      customerId: input.customerId,
      keyHash: services.secrets.keyedHash('license-key', key),
      keyHint: key.slice(-5),
      expiresAt: new Date(input.at.getTime() + 30 * DAY),
      maxInstalls: 1,
      features: [...planFeatures],
      trialHours: input.hours,
      note: input.note ?? 'Sinov muddati',
      createdById: input.ownerId ?? null,
    },
  });
  return { license, key };
}

/** The same rule as the licence screen: a trial is exactly `trialHours` long. */
export function trialEndsAt(license: {
  trialHours: number | null;
  trialStartedAt: Date | null;
}): Date | null {
  return license.trialHours && license.trialStartedAt
    ? new Date(license.trialStartedAt.getTime() + license.trialHours * HOUR)
    : null;
}

// --------------------------------------------------------------- router

const text = (max: number) => z.string().trim().min(1).max(max);

export function registryRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const authed = [loadOwner(services), requireOwner()];
  const sensitive = [...authed, requireOwnerReauth(services)];
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: Math.max(services.limits?.credentialsPerMinute ?? 20, 20),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });

  // -------------------------------------------------- device side: first launch

  router.post('/control/device/register', limiter, async (req, res) => {
    const input = parse(
      z.object({
        publicKey: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/),
        installId: text(60),
        deviceName: text(80),
        platform: z.enum(['DESKTOP', 'ANDROID']).default('DESKTOP'),
        appVersion: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,40}$/)
          .optional(),
        restaurantName: text(80).optional(),
        tenantKey: text(80).optional(),
        // First installation on this computer (survives deleting the data folder).
        installedAt: z.iso.datetime().optional(),
        hasLocalLicense: z.boolean().default(false),
        ts: z.number().int().positive(),
        proof: z.string().min(40).max(200),
      }),
      req.body,
    );
    const at = now();
    const { proof, ...signed } = input;
    // The request is signed by the key being registered, so nobody can speak for
    // another install and no privilege is implied by it.
    if (
      !verifyValue(input.publicKey, { type: 'register', ...signed }, proof) ||
      Math.abs(at.getTime() - input.ts) > timing.requestSkewMs
    )
      throw new AppError(
        403,
        'DEVICE_PROOF_INVALID',
        'controlSignatureInvalid',
      );
    const fingerprint = fingerprintOf(input.publicKey);
    const settings = await registrySettings(db);
    const installedAt = input.installedAt ? new Date(input.installedAt) : null;

    const registered = await db.$transaction(async (tx) => {
      let registration = await tx.controlRegistration.findUnique({
        where: { fingerprint },
      });
      let isNew = false;
      if (registration) {
        registration = await tx.controlRegistration.update({
          where: { id: registration.id },
          data: {
            lastSeenAt: at,
            appVersion: input.appVersion ?? registration.appVersion,
            label: input.deviceName,
            hasLocalLicense: input.hasLocalLicense,
            lastIp: req.ip ?? null,
          },
        });
      } else {
        try {
          registration = await tx.controlRegistration.create({
            data: {
              installId: input.installId,
              fingerprint,
              publicKey: input.publicKey,
              platform: input.platform,
              appVersion: input.appVersion ?? null,
              label: input.deviceName,
              restaurantName: input.restaurantName ?? null,
              tenantKey: input.tenantKey ?? null,
              installedAt,
              hasLocalLicense: input.hasLocalLicense,
              lastIp: req.ip ?? null,
            },
          });
          isNew = true;
        } catch (error) {
          if (isUniqueViolation(error)) throw errors.conflict();
          throw error;
        }
        await recordEvent(tx, {
          type: 'registration.new',
          dedupeKey: `reg:${fingerprint}`,
          registrationId: registration.id,
          data: {
            label: input.deviceName,
            restaurantName: input.restaurantName ?? null,
            appVersion: input.appVersion ?? null,
            platform: input.platform,
            installId: input.installId,
          },
        });
      }

      // The automatic trial: one per new installation. Anything that looks like a
      // returning or already-licensed computer waits for the Owner instead.
      if (isNew && registration.status === 'PENDING' && settings.autoTrial) {
        const fresh =
          installedAt !== null &&
          at.getTime() - installedAt.getTime() < DAY &&
          installedAt.getTime() - at.getTime() < HOUR;
        const seenBefore =
          (await tx.controlRegistration.count({
            where: {
              id: { not: registration.id },
              OR: [
                { installId: input.installId },
                ...(input.tenantKey ? [{ tenantKey: input.tenantKey }] : []),
              ],
            },
          })) > 0;
        if (fresh && !input.hasLocalLicense && !seenBefore) {
          const customer = await tx.controlCustomer.create({
            data: {
              name: input.restaurantName ?? input.deviceName,
              note: 'Avtomatik yaratildi (yangi o‘rnatish)',
              boundTenantKey: input.tenantKey ?? null,
            },
          });
          const { license, key } = await issueTrialLicense(tx, services, {
            customerId: customer.id,
            hours: settings.trialHours,
            at,
          });
          registration = await tx.controlRegistration.update({
            where: { id: registration.id },
            data: {
              status: 'ASSIGNED',
              customerId: customer.id,
              licenseId: license.id,
              claimKeyEnc: services.secrets.encrypt(key),
            },
          });
          await recordEvent(tx, {
            type: 'trial.assigned',
            dedupeKey: `trial-assigned:${registration.id}`,
            customerId: customer.id,
            registrationId: registration.id,
            data: { hours: settings.trialHours, restaurantName: customer.name },
          });
          await controlAudit(tx, req, {
            customerId: customer.id,
            action: 'registration.auto_trial',
            entityType: 'registration',
            entityId: registration.id,
            data: { hours: settings.trialHours },
          });
        }
      }
      return { registration, isNew };
    });
    const { registration: result, isNew } = registered;

    // The key stays sealed until the device that registered activates with it; a lost
    // response can therefore be repeated safely (same signed identity, same answer).
    res.status(isNew ? 201 : 200).json({
      registrationId: result.id,
      status: result.status,
      ...(result.status === 'ASSIGNED' && result.claimKeyEnc
        ? { licenseKey: services.secrets.decrypt(result.claimKeyEnc) }
        : {}),
      serverTime: at.toISOString(),
    });
  });

  // -------------------------------------------------------- Owner side: events

  router.get('/control/events', ...authed, async (req, res) => {
    const query = parse(
      z.object({
        unread: z.enum(['0', '1']).default('0'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.bigint().optional(),
      }),
      req.query,
    );
    const where: Prisma.ControlEventWhereInput = {
      ...(query.unread === '1' ? { readAt: null } : {}),
      ...(query.before ? { id: { lt: query.before } } : {}),
    };
    const [events, unread] = await Promise.all([
      db.controlEvent.findMany({
        where,
        orderBy: { id: 'desc' },
        take: query.limit,
      }),
      db.controlEvent.count({ where: { readAt: null } }),
    ]);
    res.json({
      unread,
      events: events.map((event) => ({
        id: event.id.toString(),
        type: event.type,
        customerId: event.customerId,
        registrationId: event.registrationId,
        data: event.data,
        createdAt: event.createdAt,
        read: event.readAt !== null,
      })),
    });
  });

  router.post('/control/events/read', ...authed, async (req, res) => {
    const input = parse(
      z.object({
        all: z.boolean().optional(),
        ids: z
          .array(z.string().regex(/^\d{1,18}$/))
          .max(200)
          .optional(),
      }),
      req.body,
    );
    const where: Prisma.ControlEventWhereInput = input.all
      ? { readAt: null }
      : { readAt: null, id: { in: (input.ids ?? []).map(BigInt) } };
    const result = await db.controlEvent.updateMany({
      where,
      data: { readAt: now() },
    });
    res.json({ marked: result.count });
  });

  // ------------------------------------------------- Owner side: registrations

  router.get('/control/registrations', ...authed, async (req, res) => {
    const query = parse(
      z.object({
        status: z.enum(['PENDING', 'ASSIGNED', 'REJECTED']).optional(),
        q: z.string().trim().max(80).optional(),
      }),
      req.query,
    );
    const rows = await db.controlRegistration.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { label: { contains: query.q, mode: 'insensitive' } },
                { restaurantName: { contains: query.q, mode: 'insensitive' } },
                { installId: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { firstSeenAt: 'desc' },
      take: 200,
    });
    const licenses = await db.controlLicense.findMany({
      where: {
        id: {
          in: rows.flatMap((row) => (row.licenseId ? [row.licenseId] : [])),
        },
      },
      select: {
        id: true,
        trialHours: true,
        trialStartedAt: true,
        expiresAt: true,
        status: true,
      },
    });
    const byId = new Map(licenses.map((license) => [license.id, license]));
    res.json({
      registrations: rows.map((row) => {
        const license = row.licenseId ? byId.get(row.licenseId) : undefined;
        return {
          id: row.id,
          installId: row.installId,
          label: row.label,
          restaurantName: row.restaurantName,
          platform: row.platform,
          appVersion: row.appVersion,
          installedAt: row.installedAt,
          hasLocalLicense: row.hasLocalLicense,
          status: row.status,
          customerId: row.customerId,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          // Connectivity is separate from the commercial state of the licence.
          license: license
            ? {
                id: license.id,
                status: license.status,
                trial: license.trialHours !== null,
                trialStartedAt: license.trialStartedAt,
                endsAt: license.trialStartedAt ? license.expiresAt : null,
                waitingForActivation:
                  license.trialHours !== null && !license.trialStartedAt,
              }
            : null,
        };
      }),
    });
  });

  // Assign a registration to a customer (existing or new) with a trial or a licence.
  router.post(
    '/control/registrations/:id/assign',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z
          .object({
            customerId: z.uuid().optional(),
            newCustomer: z
              .object({
                name: text(100),
                contactName: z.string().trim().max(100).optional(),
                phone: z.string().trim().max(40).optional(),
              })
              .optional(),
            mode: z.enum(['trial', 'months']),
            trialHours: z
              .number()
              .int()
              .min(1)
              .max(24 * 30)
              .optional(),
            months: z.number().int().min(1).max(60).optional(),
          })
          .refine((v) => !!v.customerId !== !!v.newCustomer),
        req.body,
      );
      const at = now();
      const settings = await registrySettings(db);
      const outcome = await db.$transaction(async (tx) => {
        const registration = await tx.controlRegistration.findUnique({
          where: { id },
        });
        if (!registration) throw errors.notFound();
        if (registration.status === 'ASSIGNED') throw errors.conflict();
        const customer = input.customerId
          ? await tx.controlCustomer.findUnique({
              where: { id: input.customerId },
            })
          : await tx.controlCustomer.create({
              data: {
                name: input.newCustomer!.name,
                contactName: input.newCustomer!.contactName ?? null,
                phone: input.newCustomer!.phone ?? null,
                boundTenantKey: registration.tenantKey,
              },
            });
        if (!customer) throw errors.notFound();
        let licenseId: string;
        let key: string;
        if (input.mode === 'trial') {
          // A customer gets one trial: converting or renewing is the way on.
          const earlier = await tx.controlLicense.count({
            where: { customerId: customer.id, trialHours: { not: null } },
          });
          if (earlier > 0) throw errors.conflict();
          const issued = await issueTrialLicense(tx, services, {
            customerId: customer.id,
            hours: input.trialHours ?? settings.trialHours,
            at,
            ownerId: owner.ownerId,
          });
          licenseId = issued.license.id;
          key = issued.key;
        } else {
          const expires = new Date(at.getTime());
          expires.setUTCMonth(expires.getUTCMonth() + (input.months ?? 1));
          key = generateLicenseKey();
          const license = await tx.controlLicense.create({
            data: {
              customerId: customer.id,
              keyHash: services.secrets.keyedHash('license-key', key),
              keyHint: key.slice(-5),
              expiresAt: new Date(
                `${expires.toISOString().slice(0, 10)}T23:59:59.999+05:00`,
              ),
              maxInstalls: 1,
              features: [...planFeatures],
              createdById: owner.ownerId,
            },
          });
          licenseId = license.id;
        }
        await tx.controlRegistration.update({
          where: { id },
          data: {
            status: 'ASSIGNED',
            customerId: customer.id,
            licenseId,
            claimKeyEnc: services.secrets.encrypt(key),
          },
        });
        await recordEvent(tx, {
          type: 'registration.assigned',
          dedupeKey: `assigned:${id}:${licenseId}`,
          customerId: customer.id,
          registrationId: id,
          data: { mode: input.mode, customerName: customer.name },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId: customer.id,
          action: 'registration.assign',
          entityType: 'registration',
          entityId: id,
          data: { mode: input.mode },
        });
        return { customerId: customer.id };
      });
      res.json(outcome);
    },
  );

  router.post(
    '/control/registrations/:id/reject',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.controlRegistration.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      if (result.count === 0) throw errors.conflict();
      await controlAudit(db, req, {
        ownerId: owner.ownerId,
        action: 'registration.reject',
        entityType: 'registration',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  // --------------------------------------------------------- Owner: settings

  router.get('/control/registry-settings', ...authed, async (_req, res) => {
    res.json(await registrySettings(db));
  });

  router.put('/control/registry-settings', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(
      z.object({
        autoTrial: z.boolean(),
        trialHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30),
      }),
      req.body,
    );
    await db.controlSetting.upsert({
      where: { key: 'registry' },
      create: { key: 'registry', value: input },
      update: { value: input },
    });
    await controlAudit(db, req, {
      ownerId: owner.ownerId,
      action: 'registry.settings.update',
      entityType: 'settings',
      data: input,
    });
    res.json(input);
  });

  return router;
}
