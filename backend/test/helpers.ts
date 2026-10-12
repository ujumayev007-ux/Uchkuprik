import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import { createPrisma } from '../src/db.js';
import { createSecretBox, hashSecret } from '../src/lib/crypto.js';
import { createLogger } from '../src/logger.js';
import {
  createBusinessTenant,
  PLATFORM_SLUG,
} from '../src/modules/tenants/provisioning.js';

// Integration helpers use the real PostgreSQL database. Every fixture uses unique
// identifiers so suites can run repeatedly without truncating data.
export const PASSWORD = 'Xavfsiz-parol-2026';
export const ORIGIN = 'http://localhost:5173';

export function createTestContext() {
  const config = loadConfig();
  const db = createPrisma(config.DATABASE_URL);
  const probe = createDatabase(config.DATABASE_URL);
  const clock = { offsetMs: 0 };
  const services: Services = {
    db,
    secrets: createSecretBox(config.APP_SECRET_KEY),
    logger: createLogger('silent'),
    secureCookies: false,
    now: () => new Date(Date.now() + clock.offsetMs),
    limits: {
      credentialsPerMinute: 10_000,
      apiPerMinute: 10_000,
      signupsPerHour: 10_000,
    },
  };
  const app = createApp({
    config: { APP_ORIGIN: ORIGIN },
    database: probe,
    logger: services.logger,
    services,
  });
  return {
    db,
    app,
    services,
    clock,
    agent: () => request.agent(app),
    async close() {
      await Promise.all([db.$disconnect(), probe.close()]);
    },
  };
}

export type TestContext = ReturnType<typeof createTestContext>;

export const unique = (prefix: string) =>
  `${prefix}-${randomBytes(4).toString('hex')}`;

export async function createTenant(
  ctx: TestContext,
  options: { mustChangePassword?: boolean } = {},
) {
  const slug = unique('t');
  const result = await ctx.db.$transaction((tx) =>
    createBusinessTenant(tx, {
      slug,
      name: `Test ${slug}`,
      branchName: 'Markaziy filial',
      owner: { username: 'owner', displayName: 'Egasi', password: PASSWORD },
    }),
  );
  if (!options.mustChangePassword)
    await ctx.db.user.update({
      where: { id: result.owner.id },
      data: { mustChangePassword: false },
    });
  const roles = await ctx.db.role.findMany({
    where: { tenantId: result.tenant.id },
  });
  const roleId = (key: string) =>
    roles.find((role) => role.systemKey === key)!.id;
  return { ...result, slug, roleId };
}

export async function addUser(
  ctx: TestContext,
  tenantId: string,
  input: {
    username: string;
    roleIds: string[];
    pin?: string;
    branchIds?: string[];
  },
) {
  const id = crypto.randomUUID();
  const user = await ctx.db.user.create({
    data: {
      id,
      tenantId,
      username: input.username,
      displayName: input.username,
      passwordHash: await hashSecret(PASSWORD),
      pinHash: input.pin
        ? await hashSecret(ctx.services.secrets.pepperPin(id, input.pin))
        : null,
      allBranches: !input.branchIds,
    },
  });
  await ctx.db.userRole.createMany({
    data: input.roleIds.map((roleId) => ({ tenantId, userId: id, roleId })),
  });
  if (input.branchIds)
    await ctx.db.userBranch.createMany({
      data: input.branchIds.map((branchId) => ({
        tenantId,
        userId: id,
        branchId,
      })),
    });
  return user;
}

export async function ensurePlatformTenant(ctx: TestContext) {
  return (
    (await ctx.db.tenant.findUnique({ where: { slug: PLATFORM_SLUG } })) ??
    ctx.db.tenant.create({
      data: { slug: PLATFORM_SLUG, name: 'Platforma', kind: 'PLATFORM' },
    })
  );
}

export function login(
  agent: ReturnType<TestContext['agent']>,
  tenant: string,
  username: string,
  password = PASSWORD,
) {
  return agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ tenant, username, password });
}
