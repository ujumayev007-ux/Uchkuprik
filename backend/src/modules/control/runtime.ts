import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Services } from '../../context.js';
import type { ControlLink, Prisma } from '../../generated/prisma/client.js';
import {
  readGrant,
  resolveControlState,
  timing,
  compareVersions,
  type ControlState,
} from './grant.js';
import {
  fingerprintOf,
  generateIdentity,
  publicKeyOf,
  exportPublicKey,
  signValue,
  verifyDocument,
} from './keys.js';
import {
  flushOutbox,
  outboxSummary,
  scheduleDailySummaries,
} from './outbox.js';
import { evaluateKey } from './policy.js';
import { loadAdminSettings, unlinkedView, type ControlView } from './view.js';

type Transport = typeof fetch;

export type AvailableUpdate = {
  version: string;
  url: string;
  sha256: string;
  size: number | null;
  notes: string | null;
  signature: string;
};

type BeatResponse = {
  t: 'beat';
  activationId: string;
  seq: number;
  serverTime: string;
  grant: string;
  commands: { id: string; type: string; scope?: string; username?: string }[];
  update: AvailableUpdate | null;
};

const LINK_CACHE_MS = 2_000;

/**
 * Customer-side control agent: activation, signed heartbeats, grant storage, the
 * monotonic clock, command execution and the synchronisation outbox. The central
 * server stays authoritative; this object only ever holds what the server signed.
 */
export function createControlRuntime(
  services: Services,
  options: { transport?: Transport } = {},
) {
  const { db } = services;
  const transport: Transport = options.transport ?? fetch;
  const trusted = services.control?.trustedKeys ?? [];
  const sysNow = () => services.now?.() ?? new Date();

  let linkCache: { at: number; row: ControlLink | null } | null = null;
  let anchor: { effective: number; mono: number } | null = null;
  let clockSuspect = false;
  let ackIds: string[] = [];
  let available: AvailableUpdate | null = null;
  let beating = false;
  const startedAt = Date.now();

  const invalidate = () => {
    linkCache = null;
  };

  async function link(): Promise<ControlLink | null> {
    const at = Date.now();
    if (linkCache && at - linkCache.at < LINK_CACHE_MS) return linkCache.row;
    const row = await db.controlLink.findUnique({ where: { id: 1 } });
    linkCache = { at, row };
    return row;
  }

  /** Never-decreasing time: system clock, stored high-water mark, elapsed runtime. */
  function monotonic(row: ControlLink | null): Date {
    const sys = sysNow().getTime();
    const mono = performance.now();
    const stored = row?.highWater.getTime() ?? 0;
    let effective = Math.max(sys, stored);
    if (anchor) {
      const expected = anchor.effective + (mono - anchor.mono);
      effective = Math.max(effective, expected);
      // The system clock fell behind where it must be by more than normal drift.
      if (expected - sys > timing.clockRollbackMs) clockSuspect = true;
    } else if (stored - sys > timing.clockRollbackMs) clockSuspect = true;
    anchor = { effective, mono };
    return new Date(effective);
  }

  function resolve(row: ControlLink | null): ControlState {
    const now = monotonic(row);
    const expectedFingerprint = row ? deviceFingerprint(row) : undefined;
    return resolveControlState({
      link: row
        ? {
            grant: row.grant,
            highWater: row.highWater,
            lastContactAt: row.lastContactAt,
            serverStatus: row.serverStatus,
          }
        : null,
      trusted,
      monotonicNow: now,
      clockSuspect,
      expectedFingerprint,
    });
  }

  function devicePem(row: ControlLink | null): string | null {
    // The key an activation was made with always wins (it is what the centre
    // registered); the launcher's key is used for new activations.
    if (row?.deviceKeyEnc) return services.secrets.decrypt(row.deviceKeyEnc);
    return services.control?.deviceKeyPem ?? null;
  }

  function deviceFingerprint(row: ControlLink): string | undefined {
    const pem = devicePem(row);
    return pem ? fingerprintOf(publicKeyOf(pem)) : undefined;
  }

  async function state() {
    const row = await link();
    const value = resolve(row);
    // Persist the high-water mark at most once a minute.
    if (
      row &&
      value.effectiveNow.getTime() - row.highWater.getTime() > 60_000
    ) {
      linkCache = null;
      await db.controlLink
        .update({ where: { id: 1 }, data: { highWater: value.effectiveNow } })
        .catch(() => undefined);
    }
    return { ...value, link: row };
  }

  async function view(tenantId: string | null): Promise<ControlView> {
    const current = await state();
    if (current.mode === 'UNLINKED') {
      const base = unlinkedView();
      if (tenantId) base.adminSettings = await loadAdminSettings(db, tenantId);
      return base;
    }
    const required = current.policy.minAppVersion;
    const since = current.policy.minVersionFrom
      ? new Date(current.policy.minVersionFrom).getTime()
      : 0;
    const version = services.appVersion ?? '0.0.0';
    return {
      mode: current.mode,
      reason: current.reason,
      policy: current.policy,
      adminSettings: tenantId
        ? await loadAdminSettings(db, tenantId)
        : new Map(),
      offlineUntil: current.offlineUntil,
      versionBlocked:
        !!required &&
        /^\d+\.\d+\.\d+$/.test(version) &&
        compareVersions(version, required) < 0 &&
        current.effectiveNow.getTime() >= since,
    };
  }

  async function call(path: string, body: unknown, baseUrl: string) {
    const response = await transport(`${baseUrl}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { status: response.status, data };
  }

  /** Activates this install with a licence key and stores the device identity. */
  async function activate(input: {
    licenseKey: string;
    deviceName: string;
    serverUrl?: string;
  }) {
    const baseUrl = (input.serverUrl ?? services.control?.url ?? '').replace(
      /\/+$/,
      '',
    );
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('NO_SERVER');
    const existing = await link();
    const envKey = services.control?.deviceKeyPem;
    // Key order: launcher-provided (OS secure storage), then the sealed key of an
    // earlier activation, else a new identity generated now.
    const generated =
      envKey || existing?.deviceKeyEnc ? null : generateIdentity();
    const pem = existing?.deviceKeyEnc
      ? services.secrets.decrypt(existing.deviceKeyEnc)
      : (envKey ?? generated!.privateKeyPem);
    const publicKey = exportPublicKey(publicKeyOf(pem));
    const tenant = await db.tenant.findFirst({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const branch = await db.branch.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { name: true },
    });
    const body = {
      licenseKey: input.licenseKey,
      publicKey,
      deviceName: input.deviceName,
      installId: services.installId ?? 'unknown',
      ...(tenant ? { tenantKey: tenant.id } : {}),
      model: os.cpus()[0]?.model.trim().slice(0, 80) ?? 'PC',
      os: `${os.type()} ${os.release()}`.slice(0, 80),
      platform: 'DESKTOP',
      appVersion: services.appVersion ?? '0.0.0',
      ...(branch ? { branchName: branch.name } : {}),
      ts: sysNow().getTime(),
    };
    const proof = signValue(pem, { type: 'activate', ...body });
    const { status, data } = await call(
      '/control/device/activate',
      { ...body, proof },
      baseUrl,
    );
    if (status !== 201) return { ok: false as const, status, code: data.code };
    const grantDoc = String(data.grant);
    const grant = readGrant(grantDoc, trusted);
    if (!grant || grant.fingerprint !== fingerprintOf(publicKey))
      return { ok: false as const, status: 502, code: 'INVALID_GRANT' };
    const at = sysNow();
    const fields = {
      serverUrl: baseUrl,
      activationId: String(data.activationId),
      customerId: grant.customerId,
      licenseHint: input.licenseKey.slice(-5).toUpperCase(),
      grant: grantDoc,
      grantIssuedAt: new Date(grant.issuedAt),
      grantExpiresAt: new Date(grant.expiresAt),
      policyVersion: grant.policy.version,
      lastContactAt: at,
      highWater: new Date(Math.max(at.getTime(), Date.parse(grant.issuedAt))),
      serverStatus: grant.status,
      lastError: null,
      ...(generated
        ? { deviceKeyEnc: services.secrets.encrypt(generated.privateKeyPem) }
        : {}),
    };
    await db.controlLink.upsert({
      where: { id: 1 },
      create: { id: 1, ...fields },
      update: fields,
    });
    invalidate();
    anchor = null;
    clockSuspect = false;
    return { ok: true as const, customerName: String(data.customerName) };
  }

  async function terminateSessions(command: {
    scope?: string;
    username?: string;
  }) {
    const reason = 'owner_terminated';
    if (command.scope === 'user' && command.username) {
      const users = await db.user.findMany({
        where: { username: command.username },
        select: { id: true },
      });
      await db.session.updateMany({
        where: {
          userId: { in: users.map((user) => user.id) },
          revokedAt: null,
        },
        data: { revokedAt: sysNow(), revokeReason: reason },
      });
      return;
    }
    await db.session.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: sysNow(), revokeReason: reason },
    });
  }

  async function heartbeatPayload() {
    const at = sysNow();
    const [session, branches, devices, summary] = await Promise.all([
      db.session.findFirst({
        where: {
          revokedAt: null,
          expiresAt: { gt: at },
          idleExpiresAt: { gt: at },
        },
        orderBy: { lastSeenAt: 'desc' },
        include: { user: { select: { displayName: true } } },
      }),
      db.branch.findMany({
        where: { deletedAt: null },
        select: { code: true, name: true, isActive: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      db.device.findMany({
        include: { branch: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      outboxSummary(db),
    ]);
    return {
      appVersion: services.appVersion ?? '0.0.0',
      currentUser: session?.user.displayName ?? null,
      os: `${os.type()} ${os.release()}`.slice(0, 80),
      ackCommands: ackIds.slice(0, 20),
      branches,
      terminals: devices.map((device) => ({
        localId: device.id,
        name: device.name,
        branchName: device.branch.name,
        panel: (['CASHIER', 'KITCHEN', 'WAITER'] as const).includes(
          device.panel as 'CASHIER',
        )
          ? (device.panel as 'CASHIER' | 'KITCHEN' | 'WAITER')
          : 'OTHER',
        status: device.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED',
        appVersion: device.appVersion,
        model: device.userAgent?.slice(0, 80) ?? null,
        os: null,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        lastIp: device.lastIp,
        currentUser: null,
      })),
      stats: {
        queued: summary.pending,
        conflicts: summary.conflicts,
        failed: summary.failed,
        uptimeMin: Math.round((Date.now() - startedAt) / 60_000),
      },
    };
  }

  async function signedPost(
    row: ControlLink,
    pem: string,
    type: 'heartbeat' | 'sync',
    path: string,
    payload: object,
  ) {
    const seq = Math.max(Number(row.requestSeq) + 1, Date.now());
    await db.controlLink.update({
      where: { id: 1 },
      data: { requestSeq: BigInt(seq) },
    });
    invalidate();
    const ts = sysNow().getTime();
    const sig = signValue(pem, {
      type,
      activationId: row.activationId,
      seq,
      ts,
      payload,
    });
    const result = await call(
      path,
      { activationId: row.activationId, seq, ts, payload, sig },
      row.serverUrl,
    );
    return { seq, ...result };
  }

  /** One check-in with the centre. Network failures are recorded, never thrown. */
  async function beat(): Promise<string> {
    if (beating) return 'busy';
    beating = true;
    try {
      const row = await db.controlLink.findUnique({ where: { id: 1 } });
      if (!row) return 'unlinked';
      const pem = devicePem(row);
      if (!pem) return 'no-key';
      let result;
      try {
        result = await signedPost(
          row,
          pem,
          'heartbeat',
          '/control/device/heartbeat',
          await heartbeatPayload(),
        );
      } catch {
        await db.controlLink.update({
          where: { id: 1 },
          data: { lastError: 'NETWORK' },
        });
        invalidate();
        return 'offline';
      }
      if (result.status !== 200) {
        await db.controlLink.update({
          where: { id: 1 },
          data: { lastError: `HTTP_${result.status}` },
        });
        invalidate();
        return 'rejected';
      }
      const doc = verifyDocument<BeatResponse>(
        String(result.data.response),
        trusted,
      );
      if (
        !doc ||
        doc.t !== 'beat' ||
        doc.activationId !== row.activationId ||
        doc.seq !== result.seq
      ) {
        await db.controlLink.update({
          where: { id: 1 },
          data: { lastError: 'BAD_RESPONSE' },
        });
        invalidate();
        return 'invalid';
      }
      const grant = readGrant(doc.grant, trusted);
      if (!grant || grant.fingerprint !== fingerprintOf(publicKeyOf(pem)))
        return 'invalid';
      const server = new Date(doc.serverTime);
      const local = monotonic(row);
      await db.controlLink.update({
        where: { id: 1 },
        data: {
          grant: doc.grant,
          grantIssuedAt: new Date(grant.issuedAt),
          grantExpiresAt: new Date(grant.expiresAt),
          policyVersion: grant.policy.version,
          lastContactAt: local,
          highWater: new Date(Math.max(local.getTime(), server.getTime())),
          serverStatus: grant.status,
          lastError: null,
        },
      });
      clockSuspect = false;
      available = doc.update;
      ackIds = [];
      for (const command of doc.commands) {
        if (command.type === 'terminate_sessions')
          await terminateSessions(command).catch(() => undefined);
        ackIds.push(command.id);
      }
      invalidate();
      return 'ok';
    } finally {
      beating = false;
    }
  }

  /** Sends queued operations; results are applied by operation id. */
  async function sync(): Promise<{ sent: number }> {
    const row = await db.controlLink.findUnique({ where: { id: 1 } });
    const pem = row ? devicePem(row) : null;
    if (!row || !pem) return { sent: 0 };
    return flushOutbox(services, async (operations) => {
      const result = await signedPost(
        row,
        pem,
        'sync',
        '/control/device/sync',
        {
          operations: operations.map((operation) => ({
            opId: operation.opId,
            type: operation.type,
            ...(operation.key ? { key: operation.key } : {}),
            data: operation.data,
          })),
        },
      );
      if (result.status !== 200)
        throw Object.assign(new Error('HTTP'), { status: result.status });
      const doc = verifyDocument<{
        t: string;
        results: { opId: string; status: string; message?: string }[];
      }>(String(result.data.response), trusted);
      if (!doc || doc.t !== 'sync') throw new Error('BAD_RESPONSE');
      return doc.results;
    });
  }

  /** Internet-dependent work waiting in its own queues (never shown as done). */
  async function internetQueues() {
    const [
      notificationsQueued,
      notificationsFailed,
      webhooksQueued,
      webhooksFailed,
    ] = await Promise.all([
      db.notificationJob.count({ where: { status: 'PENDING' } }),
      db.notificationJob.count({ where: { status: 'FAILED' } }),
      db.webhookDelivery.count({ where: { status: 'PENDING' } }),
      db.webhookDelivery.count({ where: { status: 'FAILED' } }),
    ]);
    return {
      notificationsQueued,
      notificationsFailed,
      webhooksQueued,
      webhooksFailed,
    };
  }

  /** Update readiness for the desktop launcher: never while a sale is running. */
  async function updateInfo() {
    const active = await db.order.count({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    });
    const current = await state();
    return {
      update: available,
      activeOrders: active,
      idle: active === 0,
      minVersion: current.policy.minAppVersion,
    };
  }

  async function status() {
    const current = await state();
    const summary = await outboxSummary(db);
    const row = current.link;
    return {
      linked: current.mode !== 'UNLINKED',
      mode: current.mode,
      reason: current.reason,
      customerName: current.grant?.customerName ?? null,
      licenseExpiresAt: current.grant?.licenseExpiresAt ?? null,
      offlineUntil: current.offlineUntil,
      offlineEnabled: current.policy.offlineEnabled,
      maxOfflineMinutes: current.policy.maxOfflineMinutes,
      policyVersion: current.policy.version,
      lastContactAt: row?.lastContactAt ?? null,
      lastError: row?.lastError ?? null,
      serverUrl: row?.serverUrl ?? services.control?.url ?? null,
      licenseHint: row?.licenseHint ?? null,
      sync: summary,
      internet: await internetQueues(),
      update: available,
      timing: {
        heartbeatSeconds: timing.heartbeatIntervalMs / 1000,
        toleranceMinutes: timing.networkToleranceMs / 60_000,
      },
    };
  }

  /** Background loop: check in, then flush the outbox and plan daily summaries. */
  function start(intervalMs: number = timing.heartbeatIntervalMs) {
    let lastSummaries = 0;
    const tick = async () => {
      try {
        if ((await link()) === null) return;
        if ((await beat()) === 'ok') {
          await sync().catch(() => undefined);
          if (Date.now() - lastSummaries > 60 * 60_000) {
            lastSummaries = Date.now();
            await scheduleDailySummaries(services).catch(() => undefined);
          }
        }
      } catch {
        services.logger.warn('Control check-in failed');
      }
    };
    const first = setTimeout(() => void tick(), 15_000);
    first.unref();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return {
    view,
    state,
    activate,
    beat,
    sync,
    status,
    updateInfo,
    start,
    invalidate,
    evaluate: evaluateKey,
    newOpId: () => randomUUID(),
    hash: (value: string) => createHash('sha256').update(value).digest('hex'),
    link,
    // Test hooks.
    _resetClock() {
      anchor = null;
      clockSuspect = false;
    },
  };
}

export type ControlRuntime = ReturnType<typeof createControlRuntime>;
export type { Prisma };
