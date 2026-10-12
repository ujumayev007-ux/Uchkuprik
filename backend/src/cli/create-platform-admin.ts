// Secure initial Super Admin provisioning. Run on the server:
//   PLATFORM_ADMIN_USERNAME=... PLATFORM_ADMIN_PASSWORD=... npm run admin:create -w backend
// Credentials come from the environment (never argv, which is visible in process lists)
// and are never printed. MFA enrollment is enforced at the first login.
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { hashSecret } from '../lib/crypto.js';
import { passwordSchema } from '../modules/auth/auth.routes.js';
import { audit } from '../modules/audit/audit.js';
import { PLATFORM_SLUG } from '../modules/tenants/provisioning.js';

const config = loadConfig();
const username =
  process.env.PLATFORM_ADMIN_USERNAME?.trim().toLowerCase() ?? '';
const displayName =
  process.env.PLATFORM_ADMIN_DISPLAY_NAME?.trim() || 'Platforma administratori';
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';

if (
  !/^[a-z0-9._-]{3,40}$/.test(username) ||
  !passwordSchema.safeParse(password).success
) {
  console.error(
    'Set PLATFORM_ADMIN_USERNAME (3-40 chars: a-z 0-9 . _ -) and PLATFORM_ADMIN_PASSWORD (10+ chars with letters and digits).',
  );
  process.exit(1);
}

const db = createPrisma(config.DATABASE_URL);
try {
  const passwordHash = await hashSecret(password);
  await db.$transaction(async (tx) => {
    const platform =
      (await tx.tenant.findUnique({ where: { slug: PLATFORM_SLUG } })) ??
      (await tx.tenant.create({
        data: {
          slug: PLATFORM_SLUG,
          name: 'FAST FOOD Platforma',
          kind: 'PLATFORM',
        },
      }));
    if (platform.kind !== 'PLATFORM')
      throw new Error('Reserved platform slug is taken.');
    const existing = await tx.user.findUnique({
      where: { tenantId_username: { tenantId: platform.id, username } },
    });
    if (existing)
      throw new Error('A platform user with this username already exists.');
    const user = await tx.user.create({
      data: {
        tenantId: platform.id,
        username,
        displayName,
        passwordHash,
        passwordChangedAt: new Date(),
        isPlatformAdmin: true,
      },
    });
    await audit(tx, null, {
      tenantId: platform.id,
      actorUserId: null,
      action: 'platform.admin.provision',
      entityType: 'user',
      entityId: user.id,
      data: { username, source: 'cli' },
    });
  });
  console.log(
    `Platform administrator created. Sign in with business code "${PLATFORM_SLUG}".`,
  );
} catch (error) {
  // Print only messages raised above; driver errors may contain connection details.
  const known = [
    'Reserved platform slug is taken.',
    'A platform user with this username already exists.',
  ];
  console.error(
    error instanceof Error && known.includes(error.message)
      ? error.message
      : 'Provisioning failed.',
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
