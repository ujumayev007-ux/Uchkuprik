// Creates a demo business for local development and browser tests. Never runs in
// production. Credentials come from the environment and are not printed.
//   DEMO_TENANT_SLUG=demo DEMO_PASSWORD=... npm run seed:demo -w backend
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { createSecretBox, hashSecret } from '../lib/crypto.js';
import { createBusinessTenant } from '../modules/tenants/provisioning.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Demo data must not be created in production.');
  process.exit(1);
}
const slug = process.env.DEMO_TENANT_SLUG ?? 'demo';
const password = process.env.DEMO_PASSWORD ?? '';
const cashierPin = process.env.DEMO_CASHIER_PIN ?? '';
if (
  !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) ||
  password.length < 10 ||
  !/^\d{4}$/.test(cashierPin)
) {
  console.error(
    'Set DEMO_TENANT_SLUG, DEMO_PASSWORD (10+ chars) and DEMO_CASHIER_PIN (4 digits).',
  );
  process.exit(1);
}

const db = createPrisma(config.DATABASE_URL);
const secrets = createSecretBox(config.APP_SECRET_KEY);
try {
  if (await db.tenant.findUnique({ where: { slug } })) {
    console.log(JSON.stringify({ slug, created: false }));
  } else {
    await db.$transaction(async (tx) => {
      const { tenant, owner } = await createBusinessTenant(tx, {
        slug,
        name: 'Lazzat Burger',
        branchName: 'Chilonzor filiali',
        owner: { username: 'owner', displayName: 'Aziz Karimov', password },
      });
      await tx.user.update({
        where: { id: owner.id },
        data: { mustChangePassword: false },
      });
      const cashierRole = await tx.role.findFirstOrThrow({
        where: { tenantId: tenant.id, systemKey: 'cashier' },
      });
      const id = crypto.randomUUID();
      await tx.user.create({
        data: {
          id,
          tenantId: tenant.id,
          username: 'kassir',
          displayName: 'Dilnoza Rahimova',
          pinHash: await hashSecret(secrets.pepperPin(id, cashierPin)),
          allBranches: true,
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: id, roleId: cashierRole.id },
      });
      // A small menu so the POS can be used immediately.
      const burgers = await tx.menuCategory.create({
        data: { tenantId: tenant.id, name: 'Burgerlar' },
      });
      const drinks = await tx.menuCategory.create({
        data: { tenantId: tenant.id, name: 'Ichimliklar', sortOrder: 1 },
      });
      const burger = await tx.product.create({
        data: {
          tenantId: tenant.id,
          categoryId: burgers.id,
          name: 'Klassik burger',
        },
      });
      await tx.productVariant.create({
        data: {
          tenantId: tenant.id,
          productId: burger.id,
          name: 'Standart',
          price: 40000,
          cost: 16000,
        },
      });
      const cola = await tx.product.create({
        data: { tenantId: tenant.id, categoryId: drinks.id, name: 'Kola' },
      });
      await tx.productVariant.create({
        data: {
          tenantId: tenant.id,
          productId: cola.id,
          name: 'Standart',
          price: 10000,
          cost: 4000,
        },
      });
    });
    console.log(JSON.stringify({ slug, created: true }));
  }
} finally {
  await db.$disconnect();
}
