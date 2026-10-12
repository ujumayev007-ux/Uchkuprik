import type { Tx } from '../../db.js';
import { hashSecret } from '../../lib/crypto.js';
import { systemRoles } from '../auth/permissions.js';

export const PLATFORM_SLUG = 'platform';

/** Seeds the system roles for a new business tenant. Idempotent per role key. */
export async function seedSystemRoles(tx: Tx, tenantId: string) {
  const roles: Record<string, string> = {};
  for (const [systemKey, role] of Object.entries(systemRoles)) {
    const saved = await tx.role.upsert({
      where: { tenantId_systemKey: { tenantId, systemKey } },
      update: {},
      create: {
        tenantId,
        systemKey,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
      },
    });
    roles[systemKey] = saved.id;
  }
  return roles;
}

export async function createBusinessTenant(
  tx: Tx,
  input: {
    slug: string;
    name: string;
    branchName: string;
    owner: { username: string; displayName: string; password: string };
    // Self-service owners chose their own password and need not replace it.
    ownerChosePassword?: boolean;
  },
) {
  const tenant = await tx.tenant.create({
    data: { slug: input.slug, name: input.name, kind: 'BUSINESS' },
  });
  const roles = await seedSystemRoles(tx, tenant.id);
  const branch = await tx.branch.create({
    data: { tenantId: tenant.id, code: 'main', name: input.branchName },
  });
  const owner = await tx.user.create({
    data: {
      tenantId: tenant.id,
      username: input.owner.username,
      displayName: input.owner.displayName,
      passwordHash: await hashSecret(input.owner.password),
      passwordChangedAt: new Date(),
      // A password chosen by the platform operator must be replaced by the owner.
      mustChangePassword: !input.ownerChosePassword,
      allBranches: true,
    },
  });
  await tx.userRole.create({
    data: { tenantId: tenant.id, userId: owner.id, roleId: roles.owner! },
  });
  return { tenant, branch, owner };
}
