import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import { generateIdentity, signValue } from '../src/modules/control/keys.js';
import { provisionOwner } from '../src/modules/control/owner-admin.js';
import { ownerPolicy } from '../src/modules/control/owner.js';
import { createTestContext, ORIGIN, PASSWORD, unique } from './helpers.js';

// An Owner application can ask to stay signed in until the computer restarts: the
// session then lives much longer (the application ends it on the next boot), while an
// ordinary sign-in keeps the short idle and absolute limits.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
afterAll(() => ctx.close());

const post = (agent: request.Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

// Lifetime measured from "now" of the test clock (the database stamps rows with real time).
const lifetime = (until: Date) =>
  until.getTime() - (Date.now() + ctx.clock.offsetMs);

function nextCode(secret: string) {
  ctx.clock.offsetMs += 31_000;
  return totpCode(secret, currentStep(Date.now() + ctx.clock.offsetMs));
}

async function signIn(keep: boolean | undefined) {
  const email = `${unique('owner')}@example.com`;
  const created = await provisionOwner(ctx.db, ctx.services.secrets, {
    email,
    displayName: 'Super Owner',
    password: PASSWORD,
  });
  const agent = request.agent(ctx.app);
  const device = generateIdentity();
  const challenge = (await post(agent, '/control/owner/challenge')).body
    .challenge as string;
  const response = await post(agent, '/control/owner/login', {
    email,
    password: PASSWORD,
    challenge,
    deviceKey: device.publicKey,
    deviceSignature: signValue(device.privateKeyPem, { challenge, email }),
    deviceLabel: 'Test EXE',
    code: nextCode(created.mfaSecret),
    ...(keep === undefined ? {} : { keep }),
  });
  expect(response.status).toBe(200);
  const owner = await ctx.db.controlOwner.findUniqueOrThrow({
    where: { email },
  });
  const session = await ctx.db.controlOwnerSession.findFirstOrThrow({
    where: { ownerId: owner.id },
    orderBy: { createdAt: 'desc' },
  });
  return { agent, session, cookie: response.headers['set-cookie'] };
}

describe('owner session that stays until the computer restarts', () => {
  it('keeps the ordinary short limits unless the application asks', async () => {
    const { session } = await signIn(undefined);
    expect(lifetime(session.expiresAt)).toBeCloseTo(ownerPolicy.absoluteMs, -4);
    expect(lifetime(session.idleExpiresAt)).toBeCloseTo(ownerPolicy.idleMs, -4);
    const explicitOff = await signIn(false);
    expect(lifetime(explicitOff.session.expiresAt)).toBeCloseTo(
      ownerPolicy.absoluteMs,
      -4,
    );
  });

  it('lives for days with a long idle window when the application asks, and slides', async () => {
    const { agent, session, cookie } = await signIn(true);
    expect(lifetime(session.expiresAt)).toBeCloseTo(
      ownerPolicy.keptAbsoluteMs,
      -4,
    );
    expect(lifetime(session.idleExpiresAt)).toBeCloseTo(
      ownerPolicy.keptIdleMs,
      -4,
    );
    expect(String(cookie)).toContain(
      `Max-Age=${ownerPolicy.keptAbsoluteMs / 1000}`,
    );
    // Two hours later (far beyond the ordinary 30 minutes) the session still works,
    // and its idle window slides forward by the long value, not the short one.
    ctx.clock.offsetMs += 2 * 60 * 60_000;
    await agent.get('/api/control/owner/me').expect(200);
    const after = await ctx.db.controlOwnerSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.idleExpiresAt.getTime() - after.lastSeenAt.getTime()).toBe(
      ownerPolicy.keptIdleMs,
    );
    // An ordinary session of the same age would be gone.
    const ordinary = await signIn(undefined);
    ctx.clock.offsetMs += 2 * 60 * 60_000;
    await ordinary.agent.get('/api/control/owner/me').expect(401);
  });
});
