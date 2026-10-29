import { createHash, randomUUID } from 'node:crypto';
import { applyOwnerDecision } from '../devices/approval.js';
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
  scheduleAdStats,
  scheduleDailySummaries,
} from './outbox.js';
import { evaluateKey } from './policy.js';
import { verifyLicense } from '../license/license.js';
import type { BrandingBundle } from '../branding/bundle.js';
import { sha256Of, sniffMedia } from '../branding/media.js';
import { loadAdminData, unlinkedView, type ControlView } from './view.js';
import { storeWorkflow } from '../workflow/restaurant.js';

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
  commands: {
    id: string;
    type: string;
    scope?: string;
    username?: string;
    // device_approval: the terminal (local device id) and the Owner's decision.
    localId?: string;
    approve?: boolean;
    // rename_host: the Owner's request and the asked Windows name.
    requestId?: string;
    name?: string;
  }[];
  update: AvailableUpdate | null;
  workflow?: { version: number; config: unknown } | null;
  // Address the centre has moved to (signed with the same key as the grant).
  relocate?: string | null;
  // Design and advertising of this restaurant (only when the install's copy is outdated).
  branding?: BrandingBundle | null;
};

const LINK_CACHE_MS = 2_000;

/**
 * Customer-side control agent: activation, signed heartbeats, grant storage, the
 * monotonic clock, command execution and the synchronisation outbox. The central
 * server stays authoritative; this object only ever holds what the server signed.
 */
/**
 * When an install that is not linked yet announces itself again: soon after a failure
 * (30 s, doubling, at most 5 min), every minute while the Owner's decision is pending,
 * otherwise every ten minutes.
 */
export function registerRetryWait(
  result: 'SKIPPED' | 'PENDING' | 'ACTIVATED' | 'ERROR',
  failures: number,
): number {
  if (result === 'ERROR')
    return Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
  return result === 'PENDING' ? 60_000 : 10 * 60_000;
}

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
      if (tenantId) {
        const admin = await loadAdminData(db, tenantId);
        base.adminSettings = admin.settings;
        base.adminParams = admin.params;
      }
      return base;
    }
    const required = current.policy.minAppVersion;
    const since = current.policy.minVersionFrom
      ? new Date(current.policy.minVersionFrom).getTime()
      : 0;
    const version = services.appVersion ?? '0.0.0';
    const admin = tenantId ? await loadAdminData(db, tenantId) : null;
    return {
      mode: current.mode,
      reason: current.reason,
      policy: current.policy,
      adminSettings: admin?.settings ?? new Map(),
      adminParams: admin?.params ?? new Map(),
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

  /**
   * First launch: tell the vendor this installation exists (signed with the install's
   * own key, no privileges). A brand-new installation is handed its trial key in the
   * answer and activates with it at once; anything else waits for the Owner. Safe to
   * repeat: the centre recognises the same signed identity.
   */
  async function register(): Promise<
    'SKIPPED' | 'PENDING' | 'ACTIVATED' | 'ERROR'
  > {
    const baseUrl = (services.control?.url ?? '').replace(/\/+$/, '');
    const pem = services.control?.deviceKeyPem;
    if (!/^https?:\/\//.test(baseUrl) || !pem || (await link()) !== null)
      return 'SKIPPED';
    const publicKey = exportPublicKey(publicKeyOf(pem));
    const tenant = await db.tenant.findFirst({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    const row = await db.appLicense.findUnique({ where: { id: 1 } });
    const local = row?.key ? verifyLicense(row.key) : null;
    const body = {
      publicKey,
      installId: services.installId ?? 'unknown',
      deviceName: os.hostname().slice(0, 80) || 'PC',
      platform: 'DESKTOP',
      appVersion: services.appVersion ?? '0.0.0',
      ...(tenant
        ? { restaurantName: tenant.name.slice(0, 80), tenantKey: tenant.id }
        : {}),
      ...(services.installedAt
        ? { installedAt: services.installedAt.toISOString() }
        : {}),
      hasLocalLicense: !!local && local.installId === services.installId,
      ts: sysNow().getTime(),
    };
    const proof = signValue(pem, { type: 'register', ...body });
    const { status, data } = await call(
      '/control/device/register',
      { ...body, proof },
      baseUrl,
    );
    if (status !== 200 && status !== 201) return 'ERROR';
    if (data.status === 'ASSIGNED' && typeof data.licenseKey === 'string') {
      const result = await activate({
        licenseKey: data.licenseKey,
        deviceName: body.deviceName,
        serverUrl: baseUrl,
      });
      return result.ok ? 'ACTIVATED' : 'ERROR';
    }
    return 'PENDING';
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

  /** Stations, printers, staff and TVs: what the Owner's workflow check looks at. */
  async function restaurantFacts() {
    const [stations, printers, roles, tv] = await Promise.all([
      db.kitchenStation.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        take: 100,
      }),
      db.printer.groupBy({
        by: ['kind'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      db.userRole.findMany({
        where: { user: { status: 'ACTIVE', deletedAt: null } },
        select: { userId: true, role: { select: { permissions: true } } },
      }),
      db.device.count({ where: { panel: 'DISPLAY', status: 'ACTIVE' } }),
    ]);
    const holders = (permission: string) =>
      new Set(
        roles
          .filter((row) => row.role.permissions.includes(permission))
          .map((row) => row.userId),
      ).size;
    const count = (kind: string) =>
      printers.find((row) => row.kind === kind)?._count._all ?? 0;
    return {
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name.slice(0, 80),
      })),
      printers: { kitchen: count('KITCHEN'), receipt: count('RECEIPT') },
      staff: {
        cashier: holders('payments.accept'),
        waiter: holders('orders.create'),
        kitchen: holders('kitchen.access'),
      },
      tv,
    };
  }

  async function heartbeatPayload() {
    const at = sysNow();
    const current = await link();
    const rename = current?.hostRenameRequest as {
      id: string;
      status: 'REQUESTED' | 'REJECTED' | 'DONE' | 'FAILED';
      message?: string | null;
    } | null;
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
      // The Windows computer name as it is now (the Owner sees renames by themselves).
      hostname: os.hostname().slice(0, 80) || undefined,
      // What this agent can do for the Owner.
      capabilities: [
        'rekey',
        'workflow',
        ...(services.hostRenameAgent ? ['rename_host'] : []),
      ],
      ...(rename
        ? {
            hostRename: {
              id: rename.id,
              status: rename.status,
              message: rename.message ?? null,
            },
          }
        : {}),
      currentUser: session?.user.displayName ?? null,
      facts: await restaurantFacts(),
      os: `${os.type()} ${os.release()}`.slice(0, 80),
      ackCommands: ackIds.slice(0, 20),
      brandingVersion: await completeBrandingVersion(),
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
        status: device.status,
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
    type: 'heartbeat' | 'sync' | 'media' | 'rekey',
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

  /**
   * "Device ID yangilash" asked by the Owner: a new FastFood device key is made and
   * registered (signed by the old key and the new one). The new registration waits for
   * the Owner's approval. Windows identifiers are never touched.
   */
  async function resetIdentity(oldPem: string) {
    const row = await db.controlLink.findUnique({ where: { id: 1 } });
    if (!row) return;
    const fresh = generateIdentity();
    const publicKey = exportPublicKey(publicKeyOf(fresh.privateKeyPem));
    const proof = signValue(fresh.privateKeyPem, {
      type: 'rekey',
      activationId: row.activationId,
      publicKey,
    });
    const result = await signedPost(
      row,
      oldPem,
      'rekey',
      '/control/device/rekey',
      {
        publicKey,
        proof,
      },
    );
    if (result.status !== 200 || typeof result.data.activationId !== 'string')
      return;
    await db.controlLink.update({
      where: { id: 1 },
      data: {
        activationId: result.data.activationId,
        deviceKeyEnc: services.secrets.encrypt(fresh.privateKeyPem),
        serverStatus: 'BLOCKED',
      },
    });
    invalidate();
    services.logger.info('Device ID renewed; waiting for the Owner approval');
  }

  /** The Owner asks to rename this Windows computer: kept until the Admin answers. */
  async function requestHostRename(command: {
    requestId?: string;
    name?: string;
  }) {
    if (!command.requestId || !command.name) return;
    await db.controlLink.update({
      where: { id: 1 },
      data: {
        hostRenameRequest: {
          id: command.requestId,
          name: command.name,
          status: services.hostRenameAgent ? 'REQUESTED' : 'FAILED',
          message: services.hostRenameAgent ? null : 'agent unavailable',
        },
      },
    });
    invalidate();
    void announceConfigChange();
  }

  /** The Admin's answer on this computer (after Windows did, or refused, the rename). */
  async function answerHostRename(input: {
    id: string;
    status: 'REJECTED' | 'DONE' | 'FAILED';
    message?: string | null | undefined;
  }) {
    const row = await db.controlLink.findUnique({ where: { id: 1 } });
    const current = row?.hostRenameRequest as {
      id?: string;
      status?: string;
    } | null;
    if (!row || current?.id !== input.id || current.status !== 'REQUESTED')
      return false;
    await db.controlLink.update({
      where: { id: 1 },
      data: {
        hostRenameRequest: {
          ...(current as object),
          status: input.status,
          message: input.message ?? null,
        },
      },
    });
    invalidate();
    // Report it now (the Owner sees the outcome without waiting a minute).
    void beat().catch(() => undefined);
    return true;
  }

  /** One check-in with the centre. Network failures are recorded, never thrown. */
  /** Tells connected panels (web and Android) to reload their settings. */
  async function announceConfigChange() {
    const tenant = await db.tenant
      .findFirst({
        where: { kind: 'BUSINESS' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      .catch(() => null);
    if (tenant)
      services.events?.publish({ type: 'config.changed', tenantId: tenant.id });
  }

  // ---- design and advertising from the centre ----------------------------------

  /** The bundle version, reported to the centre only when every file is stored here. */
  async function completeBrandingVersion(): Promise<string | undefined> {
    const cached = await db.brandingCache.findUnique({ where: { id: 1 } });
    if (!cached) return undefined;
    const bundle = cached.bundle as unknown as BrandingBundle;
    const have = await db.brandingMedia.findMany({
      where: { id: { in: bundle.media.map((media) => media.id) } },
      select: { id: true, sha256: true },
    });
    const complete = bundle.media.every((media) =>
      have.some((row) => row.id === media.id && row.sha256 === media.sha256),
    );
    return complete ? cached.version : undefined;
  }

  let applyingBranding = false;
  let brandingWork: Promise<void> = Promise.resolve();
  /** Stores a signed bundle, fetches its files, then tells open screens to reload. */
  async function applyBranding(
    row: ControlLink,
    pem: string,
    bundle: BrandingBundle,
  ) {
    if (applyingBranding) return;
    applyingBranding = true;
    try {
      if (
        !bundle ||
        typeof bundle.v !== 'string' ||
        !Array.isArray(bundle.ads) ||
        !Array.isArray(bundle.media)
      )
        return;
      await db.brandingCache.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          version: bundle.v,
          bundle: bundle as unknown as Prisma.InputJsonValue,
        },
        update: {
          version: bundle.v,
          bundle: bundle as unknown as Prisma.InputJsonValue,
          receivedAt: sysNow(),
        },
      });
      for (const media of bundle.media) {
        const have = await db.brandingMedia.findUnique({
          where: { id: media.id },
          select: { sha256: true },
        });
        if (have?.sha256 === media.sha256) continue;
        try {
          const result = await signedPost(
            row,
            pem,
            'media',
            '/control/device/media',
            { id: media.id },
          );
          if (result.status !== 200) continue;
          const bytes = Buffer.from(String(result.data.data ?? ''), 'base64');
          const found = sniffMedia(bytes);
          // The signed bundle's checksum decides: anything else is discarded.
          if (!found || sha256Of(bytes) !== media.sha256) continue;
          await db.brandingMedia.upsert({
            where: { id: media.id },
            create: {
              id: media.id,
              kind: found.kind,
              mime: found.mime,
              name: 'markaziy',
              sizeBytes: bytes.length,
              sha256: media.sha256,
              data: bytes,
            },
            update: {
              kind: found.kind,
              mime: found.mime,
              sizeBytes: bytes.length,
              sha256: media.sha256,
              data: bytes,
            },
          });
        } catch {
          /* The next heartbeat retries: the bundle stays incomplete until then. */
        }
      }
      // Files nobody refers to any more (bundle or the restaurant's own design) go away.
      const own = await db.tenantDesign.findMany({ select: { config: true } });
      const keep = new Set<string>(bundle.media.map((media) => media.id));
      for (const id of JSON.stringify(own).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ) ?? [])
        keep.add(id);
      await db.brandingMedia.deleteMany({
        where: { id: { notIn: [...keep] }, name: 'markaziy' },
      });
      await announceBrandingChange();
    } finally {
      applyingBranding = false;
    }
  }

  async function announceBrandingChange() {
    const tenant = await db.tenant
      .findFirst({
        where: { kind: 'BUSINESS' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      .catch(() => null);
    if (tenant)
      services.events?.publish({
        type: 'branding.changed',
        tenantId: tenant.id,
      });
  }

  /** https (or loopback http for test builds) addresses only. */
  const trimUrl = (value: string) => value.trim().replace(/\/+$/, '');
  const acceptableUrl = (value: string) =>
    /^https:\/\/[^\s/]+(\/.*)?$/.test(value) ||
    /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value);

  /**
   * Switches to another address of the SAME central server (a moved server keeps the
   * database and signing key). The new address must answer a signed heartbeat for this
   * activation with a document the trusted key signed; only then is it adopted.
   */
  async function relocate(target: string): Promise<boolean> {
    const url = trimUrl(target);
    if (!acceptableUrl(url)) return false;
    const row = await db.controlLink.findUnique({ where: { id: 1 } });
    if (!row) return false;
    if (row.serverUrl === url) return true;
    const pem = devicePem(row);
    if (!pem) return false;
    try {
      const probe = await signedPost(
        { ...row, serverUrl: url },
        pem,
        'heartbeat',
        '/control/device/heartbeat',
        await heartbeatPayload(),
      );
      if (probe.status !== 200) return false;
      const doc = verifyDocument<BeatResponse>(
        String(probe.data.response),
        trusted,
      );
      if (
        !doc ||
        doc.t !== 'beat' ||
        doc.activationId !== row.activationId ||
        doc.seq !== probe.seq
      )
        return false;
      await db.controlLink.update({
        where: { id: 1 },
        data: { serverUrl: url, lastError: null },
      });
      invalidate();
      return true;
    } catch {
      return false;
    }
  }

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
      // The centre announced a new address: verify it first, then switch.
      if (doc.relocate && trimUrl(doc.relocate) !== row.serverUrl)
        void relocate(doc.relocate);
      // The SUPER_OWNER's workflow: kept for the restaurant (newer versions only).
      if (doc.workflow) {
        const tenant = await db.tenant.findFirst({
          where: { kind: 'BUSINESS' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (tenant && (await storeWorkflow(db, tenant.id, doc.workflow)))
          void announceConfigChange();
      }
      // New decisions from the Owner reach connected screens and Android devices:
      // policy changes, and blocking / unblocking (the screens drop or show the
      // "blocked" notice at once instead of after a reload).
      if (
        row.policyVersion !== grant.policy.version ||
        row.serverStatus !== grant.status
      )
        void announceConfigChange();
      if (doc.branding)
        brandingWork = applyBranding(row, pem, doc.branding).catch(
          () => undefined,
        );
      available = doc.update;
      ackIds = [];
      for (const command of doc.commands) {
        if (command.type === 'terminate_sessions')
          await terminateSessions(command).catch(() => undefined);
        if (command.type === 'reset_identity')
          await resetIdentity(pem).catch(() => undefined);
        if (command.type === 'rename_host')
          await requestHostRename(command).catch(() => undefined);
        if (command.type === 'device_approval')
          await applyOwnerDecision(db, command, sysNow()).catch(
            () => undefined,
          );
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
    let lastRegister = 0;
    let registerWait = 0;
    let registerFailures = 0;
    const tick = async () => {
      try {
        if ((await link()) === null) {
          // Not linked yet: announce this installation (and collect an approval).
          // A failed attempt (centre asleep, internet not up yet) is retried soon
          // (30 s, doubling, at most 5 min) instead of after ten minutes; while the
          // Owner's decision is awaited the install asks every minute, so a licence
          // the Owner assigns is picked up at once.
          if (Date.now() - lastRegister >= registerWait) {
            lastRegister = Date.now();
            const result = await register().catch(() => 'ERROR' as const);
            registerFailures = result === 'ERROR' ? registerFailures + 1 : 0;
            registerWait = registerRetryWait(result, registerFailures);
            // Licence assigned by the Owner: check in right away so the Owner sees
            // the installation online at once (not a minute later).
            if (result === 'ACTIVATED' && (await beat()) === 'ok')
              await sync().catch(() => undefined);
          }
          return;
        }
        if ((await beat()) === 'ok') {
          await sync().catch(() => undefined);
          if (Date.now() - lastSummaries > 60 * 60_000) {
            lastSummaries = Date.now();
            await scheduleDailySummaries(services).catch(() => undefined);
          }
          await scheduleAdStats(services).catch(() => undefined);
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
    register,
    beat,
    answerHostRename,
    hostRenameRequest: async () =>
      ((await link())?.hostRenameRequest ?? null) as {
        id: string;
        name: string;
        status: string;
      } | null,
    sync,
    status,
    updateInfo,
    start,
    relocate,
    // Resolves when the last received design/advertising bundle has been stored.
    brandingSettled: () => brandingWork,
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
