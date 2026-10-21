import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Services } from '../src/context.js';
import { AppError, sendError } from '../src/http/errors.js';
import {
  activeOverride,
  decideNetwork,
  enforceNetwork,
  isLocalClient,
  networkStatus,
  normalizeNetwork,
  subnetsOf,
} from '../src/modules/control/network.js';

// A restaurant LAN 192.168.1.0/24 (and an IPv6 ULA /64) behind the server's network card.
const lan = subnetsOf({
  Ethernet: [
    {
      address: '192.168.1.13',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '192.168.1.13/24',
    },
    {
      address: 'fd12:3456:789a:1::13',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: 'fd12:3456:789a:1::13/64',
      scopeid: 0,
    },
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
  ],
});

describe('approved network detection', () => {
  it('accepts the server itself and addresses inside its own subnets only', () => {
    for (const ok of [
      '127.0.0.1',
      '::ffff:127.0.0.1',
      '::1',
      '192.168.1.55',
      '::ffff:192.168.1.200',
      'fe80::1ff:fe23:4567:890a',
      'fd12:3456:789a:1::99',
    ])
      expect(isLocalClient(ok, lan), ok).toBe(true);
    for (const bad of [
      undefined,
      '',
      '8.8.8.8',
      '203.0.113.7',
      // Private, but of another network (a neighbour's Wi-Fi, a VPN, a forwarded port).
      '192.168.2.10',
      '10.0.0.5',
      '172.16.4.4',
      '100.64.1.1',
      'fd12:3456:789a:2::1',
      'not-an-address',
    ])
      expect(isLocalClient(bad, lan), String(bad)).toBe(false);
  });

  it('reads policies tolerantly and expires overrides by time', () => {
    expect(normalizeNetwork(undefined).override).toBeNull();
    expect(normalizeNetwork({ override: 'yes' }).override).toBeNull();
    expect(
      normalizeNetwork({ override: { expiresAt: 'soon' } }).override,
    ).toBeNull();
    const policy = normalizeNetwork({
      override: {
        expiresAt: '2030-01-02T00:00:00.000Z',
        grantedAt: '2030-01-01T00:00:00.000Z',
        roles: ['cashier', 'BAD ROLE', 5],
        reason: 'Masofaviy yordam',
      },
    });
    expect(policy.override?.roles).toEqual(['cashier']);
    expect(
      activeOverride(policy, new Date('2030-01-01T12:00:00Z')),
    ).not.toBeNull();
    expect(
      activeOverride(policy, new Date('2030-01-02T00:00:00.001Z')),
    ).toBeNull();
  });
});

function services(
  network?: unknown,
  selfHosted = true,
  now = new Date('2030-01-01T12:00:00Z'),
) {
  return {
    selfHosted,
    now: () => now,
    controlRuntime: { state: async () => ({ policy: { network } }) },
  } as unknown as Services;
}
const auth = (roleKeys: string[]) => ({ roleKeys }) as never;
const override = (roles: string[] = []) => ({
  override: {
    expiresAt: '2030-01-03T00:00:00.000Z',
    grantedAt: '2030-01-01T00:00:00.000Z',
    roles,
    reason: 'Sinov',
  },
});

describe('network decision', () => {
  const outside = '203.0.113.7';

  it('blocks outside addresses by default, allows the restaurant network, ignores hosted installs', async () => {
    expect(
      await decideNetwork(services(), {
        remote: outside,
        path: '/api/orders',
        auth: auth(['cashier']),
      }),
    ).toEqual({ allowed: false, reason: 'OUTSIDE_NETWORK' });
    expect(
      await decideNetwork(services(), {
        remote: '127.0.0.1',
        path: '/api/orders',
        auth: undefined,
      }),
    ).toEqual({ allowed: true, via: 'LOCAL' });
    expect(
      await decideNetwork(services(undefined, false), {
        remote: outside,
        path: '/api/orders',
        auth: undefined,
      }),
    ).toEqual({ allowed: true, via: 'NOT_APPLICABLE' });
  });

  it('an Owner exception still needs a login, can be limited to roles and expires', async () => {
    const open = services(override());
    // Not signed in: only the sign-in routes pass.
    expect(
      await decideNetwork(open, {
        remote: outside,
        path: '/api/auth/login',
        auth: undefined,
      }),
    ).toEqual({
      allowed: true,
      via: 'OVERRIDE',
    });
    expect(
      await decideNetwork(open, {
        remote: outside,
        path: '/api/orders',
        auth: undefined,
      }),
    ).toEqual({
      allowed: false,
      reason: 'OVERRIDE_NEEDS_LOGIN',
    });
    expect(
      await decideNetwork(open, {
        remote: outside,
        path: '/api/orders',
        auth: auth(['waiter']),
      }),
    ).toEqual({
      allowed: true,
      via: 'OVERRIDE',
    });
    const cashiersOnly = services(override(['cashier']));
    expect(
      await decideNetwork(cashiersOnly, {
        remote: outside,
        path: '/api/orders',
        auth: auth(['waiter']),
      }),
    ).toEqual({
      allowed: false,
      reason: 'OVERRIDE_ROLE',
    });
    expect(
      await decideNetwork(cashiersOnly, {
        remote: outside,
        path: '/api/orders',
        auth: auth(['cashier']),
      }),
    ).toMatchObject({
      allowed: true,
    });
    // After the expiry the same request is refused, with no further action.
    const later = services(override(), true, new Date('2030-01-03T00:00:01Z'));
    expect(
      await decideNetwork(later, {
        remote: outside,
        path: '/api/orders',
        auth: auth(['waiter']),
      }),
    ).toEqual({
      allowed: false,
      reason: 'OUTSIDE_NETWORK',
    });
  });

  it('is not fooled by headers: only the connection address counts', async () => {
    const app = express();
    app.set('trust proxy', 0);
    // Stand-in for a connection from the internet.
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: '203.0.113.7',
        configurable: true,
      });
      next();
    });
    app.get('/api/network/status', async (req, res) => {
      res.json(
        await networkStatus(services(), req.socket.remoteAddress, undefined),
      );
    });
    app.use('/api', enforceNetwork(services()));
    app.get('/api/orders', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(((error, _req, res, _next) => {
      if (error instanceof AppError) sendError(res, error);
      else res.status(500).end();
    }) as express.ErrorRequestHandler);
    const blocked = await request(app)
      .get('/api/orders')
      .set('X-Forwarded-For', '192.168.1.5')
      .set('X-Real-IP', '127.0.0.1')
      .set('Host', '192.168.1.13:8787');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('NETWORK_NOT_APPROVED');
    expect(blocked.body.message).toContain('Wi‑Fi');
    // Diagnostics still answer, naming the cause but not the restaurant's addresses.
    const status = await request(app)
      .get('/api/network/status')
      .set('X-Forwarded-For', '192.168.1.5');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      approved: false,
      reason: 'OUTSIDE_NETWORK',
      yourAddress: '203.0.113.7',
    });
    expect(JSON.stringify(status.body)).not.toContain('192.168.1.13');
  });
});
