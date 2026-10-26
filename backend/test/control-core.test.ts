import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerRetryWait } from '../src/modules/control/runtime.js';
import {
  catalogByKey,
  featureCatalog,
  matchRoute,
} from '../src/modules/control/catalog.js';
import {
  compareVersions,
  resolveControlState,
  timing,
  type Grant,
} from '../src/modules/control/grant.js';
import {
  canonicalJson,
  fingerprintOf,
  generateIdentity,
  generateLicenseKey,
  normalizeLicenseKey,
  signDocument,
  signValue,
  verifyDocument,
  verifyValue,
} from '../src/modules/control/keys.js';
import {
  defaultPolicy,
  evaluateKey,
  financialVisibility,
  resolveParams,
  sanitizeFeatures,
  type PolicyDoc,
} from '../src/modules/control/policy.js';

describe('feature catalog', () => {
  it('has unique keys and Uzbek labels', () => {
    const keys = featureCatalog.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of featureCatalog)
      expect(def.label.length).toBeGreaterThan(2);
  });

  it('maps every API route of the backend to a feature or an open path', () => {
    const root = join(import.meta.dirname, '..', 'src', 'modules');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(
            /\brouter\.(get|post|put|patch|delete)\(\s*(['`])([^'`]+)\2/g,
          ))
            found.push(`${match[1]!.toUpperCase()} ${match[3]!}`);
        }
      }
    };
    walk(root);
    expect(found.length).toBeGreaterThan(200);
    const unmapped = found.filter((route) => {
      const [method, path] = route.split(' ') as [string, string];
      return (
        matchRoute(method, path.replace(/:[A-Za-z]+/g, 'x')).kind === 'unmapped'
      );
    });
    expect(unmapped).toEqual([]);
  });

  it('routes money actions to their own features', () => {
    expect(matchRoute('POST', '/orders')).toEqual({
      kind: 'feature',
      key: 'orders.create',
    });
    expect(matchRoute('POST', '/orders/abc/refunds')).toEqual({
      kind: 'feature',
      key: 'payments.refund',
    });
    expect(matchRoute('POST', '/orders/abc/discount')).toEqual({
      kind: 'feature',
      key: 'discounts.apply',
    });
    expect(matchRoute('GET', '/reports/sales')).toEqual({
      kind: 'feature',
      key: 'reports.sales',
    });
    expect(matchRoute('POST', '/auth/login')).toEqual({ kind: 'open' });
  });
});

describe('policy evaluation', () => {
  const policy = (features: PolicyDoc['features']): PolicyDoc => ({
    ...defaultPolicy(),
    offlineEnabled: true,
    maxOfflineMinutes: 60,
    features,
  });

  it('applies catalog defaults and per-feature online/offline switches', () => {
    const base = policy({});
    expect(evaluateKey(base, 'orders.create')).toMatchObject({
      online: true,
      offline: true,
    });
    // Refunds are online-only unless SUPER_OWNER enables them offline.
    expect(evaluateKey(base, 'payments.refund')).toMatchObject({
      online: true,
      offline: false,
    });
    const enabled = policy({ 'payments.refund': { offline: true } });
    expect(evaluateKey(enabled, 'payments.refund')?.offline).toBe(true);
    // Internet-dependent features can never be offline.
    const forced = policy({ 'online.ordering': { offline: true } });
    expect(evaluateKey(forced, 'online.ordering')?.offline).toBe(false);
  });

  it('OFF is final, ADMIN follows the restaurant admin setting', () => {
    const off = policy({ 'menu.manage': { mode: 'OFF' } });
    expect(evaluateKey(off, 'menu.manage')).toMatchObject({
      online: false,
      offline: false,
    });
    const delegated = policy({ 'fin.cashier.cost': { mode: 'ADMIN' } });
    expect(
      evaluateKey(delegated, 'fin.cashier.cost', ['cashier'])?.online,
    ).toBe(false);
    const admin = new Map([['fin.cashier.cost|cashier', true]]);
    expect(
      evaluateKey(delegated, 'fin.cashier.cost', ['cashier'], admin)?.online,
    ).toBe(true);
    // The admin cannot override a feature SUPER_OWNER did not delegate.
    const locked = policy({ 'menu.manage': { mode: 'OFF' } });
    const adminOn = new Map([['menu.manage|*', true]]);
    expect(evaluateKey(locked, 'menu.manage', ['admin'], adminOn)?.online).toBe(
      false,
    );
  });

  it('hides cost, margin and net profit from cashiers by default', () => {
    const base = policy({});
    expect(financialVisibility(base, ['cashier'], true)).toEqual({
      cost: false,
      margin: false,
      profit: false,
    });
    expect(financialVisibility(base, ['owner'], false)).toEqual({
      cost: true,
      margin: true,
      profit: true,
    });
    const enabled = policy({ 'fin.cashier.cost': { mode: 'ON' } });
    expect(financialVisibility(enabled, ['cashier'], true)).toEqual({
      cost: true,
      margin: false,
      profit: false,
    });
    // The global switch still wins over the cashier switch.
    const globalOff = policy({
      'fin.cashier.cost': { mode: 'ON' },
      'fin.cost': { mode: 'OFF' },
    });
    expect(financialVisibility(globalOff, ['cashier'], true).cost).toBe(false);
  });

  it('drops unknown keys and bad values from stored policies', () => {
    expect(
      sanitizeFeatures({
        'orders.create': { mode: 'OFF', online: 'yes', offline: false },
        'nope.key': { mode: 'ON' },
        'menu.manage': 'bad',
      }),
    ).toEqual({ 'orders.create': { mode: 'OFF', offline: false } });
    expect(catalogByKey.has('nope.key')).toBe(false);
  });
});

describe('keys and signed documents', () => {
  it('generates well-formed random licence keys that normalize', () => {
    const a = generateLicenseKey();
    const b = generateLicenseKey();
    expect(a).toMatch(/^FFL(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(a).not.toBe(b);
    expect(normalizeLicenseKey(a.toLowerCase().replace(/-/g, ' '))).toBe(a);
    expect(normalizeLicenseKey('FFL-short')).toBeNull();
  });

  it('signs documents and rejects tampering and foreign keys', () => {
    const server = generateIdentity();
    const other = generateIdentity();
    const document = signDocument(server.privateKeyPem, { a: 1, b: [2] });
    expect(verifyDocument(document, [server.publicKey])).toEqual({
      a: 1,
      b: [2],
    });
    expect(verifyDocument(document, [other.publicKey])).toBeNull();
    const [body, signature] = document.split('.');
    const forged = Buffer.from(JSON.stringify({ a: 2, b: [2] })).toString(
      'base64url',
    );
    expect(
      verifyDocument(`${forged}.${signature}`, [server.publicKey]),
    ).toBeNull();
    expect(body).toBeTruthy();
  });

  it('verifies device signatures over canonical JSON', () => {
    const device = generateIdentity();
    const value = { b: 1, a: { d: 4, c: 3 } };
    const signature = signValue(device.privateKeyPem, value);
    expect(canonicalJson(value)).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(
      verifyValue(device.publicKey, { a: { c: 3, d: 4 }, b: 1 }, signature),
    ).toBe(true);
    expect(verifyValue(device.publicKey, { ...value, b: 2 }, signature)).toBe(
      false,
    );
    expect(fingerprintOf(device.publicKey)).toHaveLength(32);
  });
});

describe('control state machine', () => {
  const server = generateIdentity();
  const device = generateIdentity();
  const T0 = new Date('2026-10-16T08:00:00Z');
  const minutes = (count: number) => count * 60_000;

  function grantDoc(
    overrides: Partial<Grant> = {},
    policy: Partial<PolicyDoc> = {},
  ) {
    const grant: Grant = {
      t: 'grant',
      v: 1,
      customerId: 'c1',
      customerName: 'Test',
      licenseId: 'l1',
      activationId: 'a1',
      fingerprint: fingerprintOf(device.publicKey),
      issuedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + minutes(120)).toISOString(),
      licenseExpiresAt: new Date(T0.getTime() + 30 * 86_400_000).toISOString(),
      status: 'ACTIVE',
      features: [],
      limits: { branches: null, users: null, devices: null },
      policy: {
        ...defaultPolicy(),
        offlineEnabled: true,
        maxOfflineMinutes: 120,
        ...policy,
      },
      ...overrides,
    };
    return signDocument(server.privateKeyPem, grant);
  }
  const state = (
    document: string,
    now: Date,
    extra: {
      clockSuspect?: boolean;
      lastContactAt?: Date | null;
      serverStatus?: string;
    } = {},
  ) =>
    resolveControlState({
      link: {
        grant: document,
        highWater: now,
        lastContactAt: 'lastContactAt' in extra ? extra.lastContactAt! : T0,
        serverStatus: extra.serverStatus ?? 'ACTIVE',
      },
      trusted: [server.publicKey],
      monotonicNow: now,
      clockSuspect: extra.clockSuspect ?? false,
    });

  it('stays online through brief network failures', () => {
    const doc = grantDoc();
    const now = new Date(T0.getTime() + timing.networkToleranceMs - 1000);
    expect(state(doc, now).mode).toBe('ONLINE');
  });

  it('switches to offline with the grant, then expires and preserves data', () => {
    const doc = grantDoc();
    const offline = state(doc, new Date(T0.getTime() + minutes(30)));
    expect(offline.mode).toBe('OFFLINE');
    expect(offline.offlineUntil?.toISOString()).toBe(
      new Date(T0.getTime() + minutes(120)).toISOString(),
    );
    const expired = state(doc, new Date(T0.getTime() + minutes(121)));
    expect(expired).toMatchObject({ mode: 'EXPIRED', reason: 'GRANT_EXPIRED' });
  });

  it('online-only customers stop after the tolerance window', () => {
    const doc = grantDoc({}, { offlineEnabled: false, maxOfflineMinutes: 0 });
    const state1 = state(doc, new Date(T0.getTime() + minutes(6)));
    expect(state1).toMatchObject({
      mode: 'EXPIRED',
      reason: 'OFFLINE_DISABLED',
    });
  });

  it('blocks on server verdicts and expired licences', () => {
    expect(state(grantDoc({ status: 'SUSPENDED' }), T0).mode).toBe('BLOCKED');
    expect(state(grantDoc(), T0, { serverStatus: 'REVOKED' }).mode).toBe(
      'BLOCKED',
    );
    const late = new Date(T0.getTime() + 31 * 86_400_000);
    expect(state(grantDoc(), late, { lastContactAt: late })).toMatchObject({
      mode: 'EXPIRED',
      reason: 'LICENSE_EXPIRED',
    });
  });

  it('a rolled-back clock needs a fresh contact before new operations', () => {
    const doc = grantDoc();
    const now = new Date(T0.getTime() + minutes(30));
    expect(state(doc, now, { clockSuspect: true })).toMatchObject({
      mode: 'EXPIRED',
      reason: 'CLOCK',
    });
    // Contact within the tolerance window clears the suspicion.
    expect(
      state(doc, now, { clockSuspect: true, lastContactAt: now }).mode,
    ).toBe('ONLINE');
  });

  it('rejects grants signed by other keys or bound to another device', () => {
    const foreign = signDocument(generateIdentity().privateKeyPem, {
      t: 'grant',
      v: 1,
    });
    expect(state(foreign, T0)).toMatchObject({
      mode: 'EXPIRED',
      reason: 'INVALID_GRANT',
    });
    const mismatch = resolveControlState({
      link: {
        grant: grantDoc(),
        highWater: T0,
        lastContactAt: T0,
        serverStatus: 'ACTIVE',
      },
      trusted: [server.publicKey],
      monotonicNow: T0,
      clockSuspect: false,
      expectedFingerprint: 'ffffffffffffffffffffffffffffffff',
    });
    expect(mismatch.reason).toBe('INVALID_GRANT');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.8.0', '1.8.0')).toBe(0);
    expect(compareVersions('1.7.9', '1.8')).toBe(-1);
  });
});

describe('Owner application signing parity', () => {
  it('signs exactly the bytes the server verifies', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'owner-desktop', 'main.cjs'),
      'utf8',
    );
    const body = /function canonicalJson\(value\) \{[\s\S]*?\n\}\n/.exec(
      source,
    )![0];
    const canonical = new Function(`${body}; return canonicalJson;`)() as (
      value: unknown,
    ) => string;
    const sample = {
      z: [1, { b: 2, a: undefined, c: null }],
      a: 'Ўзбек "тест"',
      n: 12.5,
    };
    expect(canonical(sample)).toBe(canonicalJson(sample));
    // A signature made over the Owner app's bytes verifies on the server.
    const device = generateIdentity();
    const signature = signValue(device.privateKeyPem, sample);
    expect(
      verifyValue(
        device.publicKey,
        JSON.parse(JSON.stringify(sample)),
        signature,
      ),
    ).toBe(true);
  });
});

describe('per-role overrides and parameters', () => {
  const policy = (features: PolicyDoc['features']): PolicyDoc => ({
    ...defaultPolicy(),
    features,
  });
  const def = catalogByKey.get('discounts.percent')!;

  it('applies an override per role and keeps what any role allows', () => {
    const p = policy({
      'discounts.percent': { roles: { waiter: { enabled: false } } },
    });
    expect(evaluateKey(p, 'discounts.percent', ['waiter'])?.online).toBe(false);
    expect(evaluateKey(p, 'discounts.percent', ['cashier'])?.online).toBe(true);
    expect(
      evaluateKey(p, 'discounts.percent', ['waiter', 'cashier'])?.online,
    ).toBe(true);
    // A global OFF is final even when a role is explicitly enabled.
    const off = policy({
      'discounts.percent': {
        mode: 'OFF',
        roles: { cashier: { enabled: true } },
      },
    });
    expect(evaluateKey(off, 'discounts.percent', ['cashier'])?.online).toBe(
      false,
    );
  });

  it('resolves parameters: default, restaurant, role, then delegated Admin value under the cap', () => {
    const p = policy({
      'discounts.percent': {
        mode: 'ADMIN',
        params: { maxPercent: 40 },
        roles: { cashier: { params: { maxPercent: 15 } } },
      },
    });
    const admin = new Map([
      ['discounts.percent|cashier', { maxPercent: 30 }],
      ['discounts.percent|waiter', { maxPercent: 5 }],
    ]);
    // The Admin cannot raise the cashier limit above the Owner value (15).
    expect(resolveParams(p, def, ['cashier'], admin).maxPercent).toBe(15);
    expect(resolveParams(p, def, ['waiter'], admin).maxPercent).toBe(5);
    expect(resolveParams(p, def, ['kitchen'], new Map()).maxPercent).toBe(40);
    expect(resolveParams(defaultPolicy(), def, []).maxPercent).toBe(100);
  });

  it('drops invalid parameters and unknown roles when sanitizing', () => {
    const clean = sanitizeFeatures({
      'discounts.percent': {
        params: { maxPercent: 500, other: 1 },
        roles: {
          'Bad Role!': { enabled: true },
          cashier: { params: { maxPercent: 12 } },
        },
      },
      'orders.display': { params: { defaultMode: 'weird' } },
    });
    expect(clean['discounts.percent']).toEqual({
      roles: { cashier: { params: { maxPercent: 12 } } },
    });
    expect(clean['orders.display']).toBeUndefined();
  });
});

describe('announcing an install that is not linked yet', () => {
  it('retries soon after a failure, every minute while pending, rarely otherwise', () => {
    expect(registerRetryWait('ERROR', 1)).toBe(30_000);
    expect(registerRetryWait('ERROR', 2)).toBe(60_000);
    expect(registerRetryWait('ERROR', 4)).toBe(240_000);
    expect(registerRetryWait('ERROR', 10)).toBe(300_000);
    expect(registerRetryWait('PENDING', 0)).toBe(60_000);
    expect(registerRetryWait('SKIPPED', 0)).toBe(600_000);
    expect(registerRetryWait('ACTIVATED', 0)).toBe(600_000);
  });
});
