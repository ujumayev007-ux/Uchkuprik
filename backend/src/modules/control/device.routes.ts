import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { messages } from '../../messages.js';
import { compareVersions, timing } from './grant.js';
import { issueGrant, loadPolicy } from './issue.js';
import {
  canonicalJson,
  fingerprintOf,
  normalizeLicenseKey,
  signDocument,
  verifyValue,
} from './keys.js';
import { controlAudit } from './owner.js';
import { recordEvent } from './registry.js';
import { buildBundle } from '../branding/bundle.js';
import { AD_PANELS } from '../branding/bundle.js';

const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{40,200}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

const envelope = z.object({
  activationId: z.uuid(),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  sig: z.string().min(40).max(200),
});

export const syncOperationTypes = [
  'daily_summary',
  'offline_event',
  'audit_event',
  'license_event',
  'ad_stats',
] as const;

const operationSchema = z.object({
  opId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  type: z.enum(syncOperationTypes),
  // Business key: the same key with different content is a conflict, not a duplicate.
  key: z.string().max(120).optional(),
  data: z.record(z.string(), z.unknown()),
});

const hashOf = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Device-facing channel: activation, signed heartbeats and synchronisation. */
export function deviceRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: Math.max(services.limits?.credentialsPerMinute ?? 20, 20),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });
  const beatLimiter = rateLimit({
    windowMs: 60_000,
    limit: services.limits?.apiPerMinute ?? 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });

  router.post('/control/device/activate', limiter, async (req, res) => {
    const input = parse(
      z.object({
        licenseKey: z.string().trim().min(10).max(60),
        publicKey: publicKeySchema,
        deviceName: text(80),
        installId: text(60),
        // Identity of the local restaurant (tenant) the install belongs to.
        tenantKey: text(80).optional(),
        model: text(80).optional(),
        os: text(80).optional(),
        platform: z.enum(['DESKTOP', 'ANDROID']).default('DESKTOP'),
        appVersion: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,40}$/)
          .optional(),
        branchName: text(80).optional(),
        ts: z.number().int().positive(),
        proof: z.string().min(40).max(200),
      }),
      req.body,
    );
    const at = now();
    const { proof, ...signed } = input;
    // Proof of possession: the request is signed by the key being registered.
    if (
      !verifyValue(input.publicKey, { type: 'activate', ...signed }, proof) ||
      Math.abs(at.getTime() - input.ts) > timing.requestSkewMs
    ) {
      await controlAudit(db, req, {
        action: 'device.activate.bad_proof',
        outcome: 'DENIED',
        data: { installId: input.installId },
      });
      throw new AppError(
        403,
        'DEVICE_PROOF_INVALID',
        'controlSignatureInvalid',
      );
    }
    const normalized = normalizeLicenseKey(input.licenseKey);
    const license = normalized
      ? await db.controlLicense.findUnique({
          where: {
            keyHash: services.secrets.keyedHash('license-key', normalized),
          },
          include: { customer: true },
        })
      : null;
    if (
      !license ||
      license.status === 'REVOKED' ||
      license.customer.status === 'CLOSED' ||
      license.expiresAt <= at
    ) {
      await controlAudit(db, req, {
        customerId: license?.customerId ?? null,
        action: 'device.activate.rejected',
        outcome: 'DENIED',
        data: { installId: input.installId },
      });
      throw new AppError(400, 'LICENSE_KEY_INVALID', 'licenseKeyInvalid');
    }
    if (license.status === 'SUSPENDED' || license.customer.status !== 'ACTIVE')
      throw new AppError(403, 'DEVICE_BLOCKED', 'deviceBlocked');
    const fingerprint = fingerprintOf(input.publicKey);
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.controlActivation.findUnique({
        where: { fingerprint },
      });
      if (existing && existing.licenseId !== license.id)
        throw new AppError(400, 'LICENSE_KEY_INVALID', 'licenseKeyInvalid');
      if (existing && existing.status === 'REPLACED')
        throw new AppError(403, 'DEVICE_BLOCKED', 'deviceBlocked');
      // Binding: the licence belongs to one local restaurant after first use.
      const customer = await tx.controlCustomer.findUniqueOrThrow({
        where: { id: license.customerId },
      });
      if (
        input.tenantKey &&
        customer.boundTenantKey &&
        customer.boundTenantKey !== input.tenantKey
      )
        throw new AppError(409, 'TENANT_MISMATCH', 'licenseInvalid');
      if (!existing) {
        const used = await tx.controlActivation.count({
          where: {
            licenseId: license.id,
            status: { in: ['ACTIVE', 'BLOCKED'] },
          },
        });
        if (used >= license.maxInstalls)
          throw new AppError(409, 'ACTIVATION_LIMIT', 'activationLimit');
      }
      if (input.tenantKey && !customer.boundTenantKey)
        await tx.controlCustomer.update({
          where: { id: customer.id },
          data: { boundTenantKey: input.tenantKey },
        });
      // A trial starts at the first server-authorised activation: from now until
      // now + trialHours, exactly (not until the end of a calendar day).
      let trialStarted = false;
      if (license.trialHours && !license.trialStartedAt) {
        const started = await tx.controlLicense.updateMany({
          where: { id: license.id, trialStartedAt: null },
          data: {
            trialStartedAt: at,
            expiresAt: new Date(at.getTime() + license.trialHours * 3_600_000),
          },
        });
        trialStarted = started.count === 1;
      }
      const data = {
        installId: input.installId,
        deviceName: input.deviceName,
        model: input.model ?? null,
        os: input.os ?? null,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        branchName: input.branchName ?? null,
        lastIp: req.ip ?? null,
      };
      const activation = existing
        ? await tx.controlActivation.update({
            where: { id: existing.id },
            data,
          })
        : await tx.controlActivation.create({
            data: {
              ...data,
              customerId: customer.id,
              licenseId: license.id,
              publicKey: input.publicKey,
              fingerprint,
            },
          });
      await controlAudit(tx, req, {
        customerId: customer.id,
        action: existing ? 'device.reactivate' : 'device.activate',
        entityType: 'device',
        entityId: activation.id,
        data: { deviceName: input.deviceName, installId: input.installId },
      });
      if (!existing)
        await recordEvent(tx, {
          type: 'device.activated',
          dedupeKey: `activated:${activation.id}`,
          customerId: customer.id,
          data: {
            deviceName: input.deviceName,
            platform: input.platform,
            appVersion: input.appVersion ?? null,
            customerName: customer.name,
          },
        });
      if (trialStarted)
        await recordEvent(tx, {
          type: 'trial.started',
          dedupeKey: `trial-started:${license.id}`,
          customerId: customer.id,
          data: {
            customerName: customer.name,
            hours: license.trialHours,
            endsAt: new Date(
              at.getTime() + license.trialHours! * 3_600_000,
            ).toISOString(),
          },
        });
      // The device holds its key now: the sealed copy is no longer needed.
      await tx.controlRegistration.updateMany({
        where: { licenseId: license.id, claimKeyEnc: { not: null } },
        data: { claimKeyEnc: null },
      });
      return { activation, customer };
    });
    // The licence as it is now (a trial that just started has its real end date).
    const current = await db.controlLicense.findUniqueOrThrow({
      where: { id: license.id },
    });
    const policy = await loadPolicy(db, license.customerId);
    const { document } = issueGrant(services, {
      customer: result.customer,
      license: current,
      activation: result.activation,
      policy,
      at,
    });
    res.status(201).json({
      activationId: result.activation.id,
      customerName: result.customer.name,
      grant: document,
      serverTime: at.toISOString(),
    });
  });

  /** Verifies the device signature, freshness and counter; returns the activation. */
  async function authenticateDevice(
    req: Request,
    type: 'heartbeat' | 'sync' | 'media',
  ) {
    const body = parse(envelope, req.body);
    const at = now();
    const activation = await db.controlActivation.findUnique({
      where: { id: body.activationId },
      include: { customer: true, license: true },
    });
    const valid =
      activation &&
      verifyValue(
        activation.publicKey,
        {
          type,
          activationId: body.activationId,
          seq: body.seq,
          ts: body.ts,
          payload: body.payload,
        },
        body.sig,
      ) &&
      Math.abs(at.getTime() - body.ts) <= timing.requestSkewMs;
    if (!activation || !valid) {
      await controlAudit(db, req, {
        customerId: activation?.customerId ?? null,
        action: 'device.bad_signature',
        outcome: 'DENIED',
        entityType: 'device',
        ...(activation ? { entityId: activation.id } : {}),
      });
      throw new AppError(
        403,
        'DEVICE_PROOF_INVALID',
        'controlSignatureInvalid',
      );
    }
    // Replay protection: the counter only moves forward (atomic compare-and-set).
    const advanced = await db.controlActivation.updateMany({
      where: { id: activation.id, lastSeq: { lt: BigInt(body.seq) } },
      data: { lastSeq: BigInt(body.seq) },
    });
    if (advanced.count === 0) {
      await controlAudit(db, req, {
        customerId: activation.customerId,
        action: 'device.replay',
        outcome: 'DENIED',
        entityType: 'device',
        entityId: activation.id,
      });
      throw new AppError(409, 'REPLAYED_REQUEST', 'conflict');
    }
    return { activation, body, at };
  }

  const beatSchema = z.object({
    appVersion: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,40}$/)
      .optional(),
    currentUser: z.string().max(80).nullable().optional(),
    deviceName: text(80).optional(),
    model: text(80).nullable().optional(),
    os: text(80).nullable().optional(),
    ackCommands: z.array(z.string().max(64)).max(20).default([]),
    // Version of the branding bundle this install holds completely (media included).
    brandingVersion: z.string().max(40).optional(),
    branches: z
      .array(
        z.object({
          code: text(40),
          name: text(80),
          isActive: z.boolean().default(true),
        }),
      )
      .max(200)
      .default([]),
    terminals: z
      .array(
        z.object({
          localId: text(64),
          name: text(80),
          branchName: z.string().max(80).nullable().optional(),
          panel: z
            .enum(['CASHIER', 'KITCHEN', 'WAITER', 'OTHER'])
            .default('OTHER'),
          status: z.enum(['ACTIVE', 'REVOKED']).default('ACTIVE'),
          appVersion: z.string().max(40).nullable().optional(),
          model: z.string().max(80).nullable().optional(),
          os: z.string().max(80).nullable().optional(),
          lastSeenAt: z.iso.datetime().nullable().optional(),
          lastIp: z.string().max(60).nullable().optional(),
          currentUser: z.string().max(80).nullable().optional(),
        }),
      )
      .max(200)
      .default([]),
    stats: z
      .record(
        z.string(),
        z.union([z.number(), z.string(), z.boolean(), z.null()]),
      )
      .default({}),
  });

  router.post('/control/device/heartbeat', beatLimiter, async (req, res) => {
    const { activation, body, at } = await authenticateDevice(req, 'heartbeat');
    const beat = parse(beatSchema, body.payload);
    const pending = Array.isArray(activation.pendingCommands)
      ? (activation.pendingCommands as { id: string }[])
      : [];
    const remaining = pending.filter(
      (command) => !beat.ackCommands.includes(command.id),
    );
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.controlActivation.update({
        where: { id: activation.id },
        data: {
          lastHeartbeatAt: at,
          lastIp: req.ip ?? null,
          appVersion: beat.appVersion ?? activation.appVersion,
          currentUser: beat.currentUser ?? null,
          deviceName: beat.deviceName ?? activation.deviceName,
          model: beat.model ?? activation.model,
          os: beat.os ?? activation.os,
          branchName: beat.branches[0]?.name ?? activation.branchName,
          stats: beat.stats as Prisma.InputJsonValue,
          pendingCommands: remaining as unknown as Prisma.InputJsonValue,
        },
      });
      for (const branch of beat.branches)
        await tx.controlBranch.upsert({
          where: {
            customerId_code: {
              customerId: activation.customerId,
              code: branch.code,
            },
          },
          create: { customerId: activation.customerId, ...branch },
          update: {
            name: branch.name,
            isActive: branch.isActive,
            lastReportedAt: at,
          },
        });
      for (const terminal of beat.terminals) {
        const data = {
          name: terminal.name,
          branchName: terminal.branchName ?? null,
          panel: terminal.panel,
          status: terminal.status,
          appVersion: terminal.appVersion ?? null,
          model: terminal.model ?? null,
          os: terminal.os ?? null,
          lastSeenAt: terminal.lastSeenAt
            ? new Date(terminal.lastSeenAt)
            : null,
          lastIp: terminal.lastIp ?? null,
          currentUser: terminal.currentUser ?? null,
        };
        await tx.controlTerminal.upsert({
          where: {
            activationId_localId: {
              activationId: activation.id,
              localId: terminal.localId,
            },
          },
          create: {
            activationId: activation.id,
            localId: terminal.localId,
            ...data,
          },
          update: data,
        });
      }
      return row;
    });
    const policy = await loadPolicy(db, activation.customerId);
    // Global minimum version from the newest fully rolled-out release.
    const releases = await db.controlRelease.findMany({
      where: {
        platform: activation.platform === 'ANDROID' ? 'APK' : 'EXE',
        stage: { in: ['STAGED', 'ALL'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const globalMin = releases
      .filter((release) => release.stage === 'ALL' && release.minVersion)
      .map((release) => release.minVersion!)
      .sort(compareVersions)
      .pop();
    if (
      globalMin &&
      (!policy.minAppVersion ||
        compareVersions(globalMin, policy.minAppVersion) > 0)
    ) {
      policy.minAppVersion = globalMin;
      policy.minVersionFrom ??= at.toISOString();
    }
    const current = updated.appVersion ?? '0.0.0';
    const candidate = releases
      .filter((release) => compareVersions(release.version, current) > 0)
      .sort((a, b) => compareVersions(b.version, a.version))
      .find((release) => {
        if (release.stage === 'ALL') return true;
        // Staged rollout: a stable bucket per installation and version.
        const bucket =
          Number.parseInt(
            createHash('sha256')
              .update(`${activation.id}:${release.version}`)
              .digest('hex')
              .slice(0, 6),
            16,
          ) % 100;
        return bucket < release.rolloutPercent;
      });
    const { document } = issueGrant(services, {
      customer: activation.customer,
      license: activation.license,
      activation: updated,
      policy,
      at,
    });
    const key = services.control?.signingKeyPem;
    if (!key) throw errors.forbidden();
    // Design and advertising for this restaurant; sent only when the install's copy differs.
    const bundle = await buildBundle(db, activation.customerId, at).catch(
      () => null,
    );
    const branding =
      bundle && bundle.v !== beat.brandingVersion ? bundle : null;
    if (bundle) {
      if (bundle.v === beat.brandingVersion)
        await db.adDelivery
          .updateMany({
            where: { activationId: activation.id, ackedAt: null },
            data: { ackedAt: at },
          })
          .catch(() => undefined);
      else
        for (const ad of bundle.ads)
          await db.adDelivery
            .upsert({
              where: {
                campaignId_activationId: {
                  campaignId: ad.id,
                  activationId: activation.id,
                },
              },
              create: {
                campaignId: ad.id,
                customerId: activation.customerId,
                activationId: activation.id,
                version: ad.version,
                sentAt: at,
              },
              update: { version: ad.version, sentAt: at, ackedAt: null },
            })
            .catch(() => undefined);
    }
    const response = signDocument(key, {
      t: 'beat',
      activationId: activation.id,
      seq: body.seq,
      serverTime: at.toISOString(),
      grant: document,
      commands: remaining,
      // Server migration: the signed answer carries the new address of the centre.
      relocate: services.control?.relocateTo ?? null,
      branding,
      update: candidate
        ? {
            version: candidate.version,
            url: candidate.url,
            sha256: candidate.sha256,
            size: candidate.size,
            notes: candidate.notes,
            signature: candidate.signature,
          }
        : null,
    });
    res.json({ response });
  });

  /** One branding file for an install; the install verifies it against the signed bundle's sha256. */
  router.post('/control/device/media', beatLimiter, async (req, res) => {
    const { activation, body } = await authenticateDevice(req, 'media');
    const { id } = parse(z.object({ id: z.uuid() }), body.payload);
    if (
      activation.status !== 'ACTIVE' ||
      activation.license.status !== 'ACTIVE' ||
      activation.customer.status !== 'ACTIVE'
    )
      throw new AppError(403, 'DEVICE_BLOCKED', 'deviceBlocked');
    // Only files the restaurant's own bundle refers to are handed out.
    const bundle = await buildBundle(db, activation.customerId);
    if (!bundle.media.some((media) => media.id === id)) throw errors.notFound();
    const row = await db.brandingMedia.findUnique({ where: { id } });
    if (!row) throw errors.notFound();
    res.json({
      id,
      mime: row.mime,
      sha256: row.sha256,
      data: Buffer.from(row.data).toString('base64'),
    });
  });

  /** Display counters reported by an install: cumulative values, applied idempotently. */
  async function applyAdStats(customerId: string, data: unknown) {
    const parsed = z
      .object({
        campaignId: z.uuid(),
        day: z.string().regex(/^d{4}-d{2}-d{2}$/),
        panel: z.enum(AD_PANELS),
        shown: z.number().int().min(0).max(1_000_000),
        closed: z.number().int().min(0).max(1_000_000),
      })
      .safeParse(data);
    if (!parsed.success) return;
    const { campaignId, day, panel, shown, closed } = parsed.data;
    if (!(await db.adCampaign.findUnique({ where: { id: campaignId } })))
      return;
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const where = {
      campaignId_customerId_day_panel: {
        campaignId,
        customerId,
        day: dayDate,
        panel,
      },
    };
    const existing = await db.adStat.findUnique({ where });
    await db.adStat.upsert({
      where,
      create: { campaignId, customerId, day: dayDate, panel, shown, closed },
      update: {
        shown: Math.max(existing?.shown ?? 0, shown),
        closed: Math.max(existing?.closed ?? 0, closed),
      },
    });
  }

  router.post('/control/device/sync', beatLimiter, async (req, res) => {
    const { activation, body, at } = await authenticateDevice(req, 'sync');
    const { operations } = parse(
      z.object({ operations: z.array(operationSchema).min(1).max(50) }),
      body.payload,
    );
    if (
      activation.status !== 'ACTIVE' ||
      activation.license.status !== 'ACTIVE' ||
      activation.customer.status !== 'ACTIVE'
    )
      throw new AppError(403, 'DEVICE_BLOCKED', 'deviceBlocked');
    const results: { opId: string; status: string; message?: string }[] = [];
    for (const operation of operations) {
      const payloadHash = hashOf({
        type: operation.type,
        data: operation.data,
      });
      const existing = await db.controlSyncOp.findUnique({
        where: {
          customerId_opId: {
            customerId: activation.customerId,
            opId: operation.opId,
          },
        },
      });
      if (existing) {
        // Retried operations are acknowledged without being applied twice.
        if (existing.payloadHash === payloadHash)
          results.push({ opId: operation.opId, status: 'DUPLICATE' });
        else
          results.push({
            opId: operation.opId,
            status: 'CONFLICT',
            message: 'opId boshqa mazmun bilan qayta ishlatilgan',
          });
        continue;
      }
      let status: 'APPLIED' | 'CONFLICT' = 'APPLIED';
      let message: string | undefined;
      if (operation.key) {
        const sameKey = await db.controlSyncOp.findFirst({
          where: {
            customerId: activation.customerId,
            type: operation.type,
            status: 'APPLIED',
            payload: { path: ['key'], equals: operation.key },
          },
        });
        if (sameKey && sameKey.payloadHash !== payloadHash) {
          status = 'CONFLICT';
          message = 'Shu kalit uchun boshqa ma’lumot allaqachon qabul qilingan';
        } else if (sameKey) {
          await db.controlSyncOp.create({
            data: {
              customerId: activation.customerId,
              activationId: activation.id,
              opId: operation.opId,
              type: operation.type,
              payloadHash,
              payload: {
                key: operation.key,
                data: operation.data,
              } as Prisma.InputJsonValue,
              status: 'DUPLICATE',
              receivedAt: at,
            },
          });
          results.push({ opId: operation.opId, status: 'DUPLICATE' });
          continue;
        }
      }
      await db.controlSyncOp.create({
        data: {
          customerId: activation.customerId,
          activationId: activation.id,
          opId: operation.opId,
          type: operation.type,
          payloadHash,
          payload: {
            key: operation.key ?? null,
            data: operation.data,
          } as Prisma.InputJsonValue,
          status,
          ...(message ? { result: { message } } : {}),
          receivedAt: at,
        },
      });
      if (status === 'APPLIED' && operation.type === 'ad_stats')
        await applyAdStats(activation.customerId, operation.data).catch(
          () => undefined,
        );
      results.push({
        opId: operation.opId,
        status,
        ...(message ? { message } : {}),
      });
    }
    const key = services.control?.signingKeyPem;
    if (!key) throw errors.forbidden();
    res.json({
      response: signDocument(key, {
        t: 'sync',
        activationId: activation.id,
        seq: body.seq,
        serverTime: at.toISOString(),
        results,
      }),
    });
  });

  return router;
}
