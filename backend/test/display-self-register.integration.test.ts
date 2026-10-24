import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, ORIGIN } from './helpers.js';

// Queue TV first start: no password, no PIN. The screen registers itself (restaurant
// install, own network only) as an ACTIVE display: the queue opens at once.

const ctx = createTestContext({ selfHosted: true });
const cloud = createTestContext();
const created: string[] = [];
afterAll(async () => {
  // Leave no pending screens behind (the pending cap counts them).
  await ctx.db.device.updateMany({
    where: { id: { in: created } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await Promise.all([ctx.close(), cloud.close()]);
});
type Agent = ReturnType<typeof ctx.agent>;
const register = (agent: Agent, body: object = {}) =>
  agent
    .post('/api/devices/display/register')
    .set('Origin', ORIGIN)
    .send(body);

describe('Queue TV self-registration', () => {
  it('registers as ACTIVE with no sign-in and shows the queue at once', async () => {
    await createTenant(ctx);
    const tv = ctx.agent();
    await tv.get('/api/queue/display').expect(403);
    let first = await register(tv);
    if (first.status === 409) {
      expect(first.body.code).toBe('BRANCH_REQUIRED');
      first = await register(tv, {
        branchId: first.body.details.branches[0].id,
      });
    }
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('ACTIVE');
    created.push(first.body.id);
    const device = await ctx.db.device.findUniqueOrThrow({
      where: { id: first.body.id },
    });
    expect(device.panel).toBe('DISPLAY');

    // Active at once: the queue shows, and a repeat re-uses the same device.
    await tv.get('/api/queue/display').expect(200);
    const again = await register(tv).expect(200);
    expect(again.body.id).toBe(first.body.id);
    // The screen holds no session: staff pages stay closed.
    await tv.get('/api/auth/me').expect(401);
    await tv.get('/api/queue/display').expect(200);
  });

  it('a hosted (cloud) server refuses self-registration', async () => {
    await register(cloud.agent()).expect(403);
  });
});
