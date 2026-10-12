import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  await ctx.db.tenantProfile.create({ data: { tenantId, loyaltyEarnBp: 500 } }); // 5 %
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Burger' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Standart', price: 40000 },
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
  return { tenant, tenantId, owner, variant };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const newOrder = async (s: Setup) =>
  (
    await post(s.owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: s.variant.id, quantity: 1 }],
    }).expect(201)
  ).body;
const pay = (s: Setup, id: string, method: string, amount: number) =>
  post(s.owner, `/orders/${id}/payments`, {
    idempotencyKey: randomUUID(),
    method,
    amount,
    ...(method === 'CASH' ? { tendered: amount } : {}),
  });

describe('customers and loyalty', () => {
  it('earns points on paid money, redeems them as payment and reverses them on refund', async () => {
    const s = await setup();
    const first = await newOrder(s);
    const attached = await post(s.owner, `/orders/${first.id}/customer`, {
      phone: '90 123 45 67',
      name: 'Dilshod',
    }).expect(200);
    expect(attached.body.customer).toMatchObject({
      phone: '+998901234567',
      name: 'Dilshod',
      points: 0,
      tier: 'STANDARD',
    });
    await pay(s, first.id, 'CARD', 40000).expect(201);
    await post(s.owner, `/orders/${first.id}/complete`).expect(200);
    const customerId = attached.body.customer.id;
    let customer = await ctx.db.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(customer).toMatchObject({
      points: 2000,
      totalSpent: 40000,
      orderCount: 1,
    });

    // Redeem: no customer -> error; too many points -> error; 2 000 points -> paid.
    const anonymous = await newOrder(s);
    expect((await pay(s, anonymous.id, 'LOYALTY', 100)).body.code).toBe(
      'CUSTOMER_REQUIRED',
    );
    const second = await newOrder(s);
    await post(s.owner, `/orders/${second.id}/customer`, {
      phone: '+998 (90) 123-45-67',
    }).expect(200);
    expect((await pay(s, second.id, 'LOYALTY', 5000)).body.code).toBe(
      'INSUFFICIENT_POINTS',
    );
    const redeemed = await pay(s, second.id, 'LOYALTY', 2000).expect(201);
    await pay(s, second.id, 'CARD', 38000).expect(201);
    await post(s.owner, `/orders/${second.id}/complete`).expect(200);
    customer = await ctx.db.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    // 5 % of the 38 000 paid in money; points are not earned on points.
    expect(customer).toMatchObject({
      points: 1900,
      orderCount: 2,
      totalSpent: 80000,
    });

    await post(s.owner, `/orders/${second.id}/refunds`, {
      paymentId: redeemed.body.paymentId,
      amount: 2000,
      reason: 'Qaytarish',
    }).expect(201);
    customer = await ctx.db.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(customer.points).toBe(3900);

    const ledger = await ctx.db.loyaltyEntry.findMany({
      where: { customerId },
      orderBy: { id: 'asc' },
    });
    expect(
      ledger.map((entry) => [entry.type, entry.points, entry.balanceAfter]),
    ).toEqual([
      ['EARN', 2000, 2000],
      ['REDEEM', -2000, 0],
      ['EARN', 1900, 1900],
      ['REVERSAL', 2000, 3900],
    ]);
    await expect(
      ctx.db
        .$executeRaw`UPDATE loyalty_entries SET points = 1 WHERE "customerId" = ${customerId}::uuid`,
    ).rejects.toThrow();

    const detail = await s.owner
      .get(`/api/customers/${customerId}`)
      .expect(200);
    expect(detail.body.orders).toHaveLength(2);
    await post(s.owner, `/customers/${customerId}/points`, {
      points: -100000,
      reason: 'Xato',
    }).expect(409);
  });
});

describe('coupons', () => {
  it('applies discounts, enforces limits atomically and releases uses on cancel', async () => {
    const s = await setup();
    await post(s.owner, '/coupons', {
      code: 'yoz10',
      kind: 'PERCENT',
      value: 1000,
      minOrder: 30000,
      maxUses: 1,
    }).expect(201);
    const a = await newOrder(s);
    const b = await newOrder(s);
    await post(s.owner, `/orders/${a.id}/coupon`, { code: 'YOZ10' }).expect(
      200,
    );
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id: a.id } })).total,
    ).toBe(36000);
    expect(
      (await post(s.owner, `/orders/${b.id}/coupon`, { code: 'YOZ10' })).body
        .code,
    ).toBe('COUPON_EXHAUSTED');
    await post(s.owner, `/orders/${a.id}/cancel`, {
      reason: 'Mijoz ketdi',
    }).expect(200);
    await post(s.owner, `/orders/${b.id}/coupon`, { code: 'YOZ10' }).expect(
      200,
    );
    expect(
      (await post(s.owner, `/orders/${b.id}/coupon`, { code: 'NOPE' })).status,
    ).toBe(409);
    expect(
      (
        await post(s.owner, '/coupons', {
          code: 'BAD',
          kind: 'PERCENT',
          value: 20000,
        })
      ).status,
    ).toBe(400);

    await post(s.owner, '/coupons', {
      code: 'IKKI',
      kind: 'FIXED',
      value: 5000,
      maxUses: 2,
    }).expect(201);
    const orders = await Promise.all(
      Array.from({ length: 4 }, () => newOrder(s)),
    );
    const results = await Promise.all(
      orders.map((order) =>
        post(s.owner, `/orders/${order.id}/coupon`, { code: 'IKKI' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    const coupon = await ctx.db.coupon.findFirstOrThrow({
      where: { tenantId: s.tenantId, code: 'IKKI' },
    });
    expect(coupon.usedCount).toBe(2);
  });
});

describe('feedback and marketing consent', () => {
  it('collects one rating per order, tracks complaints and exports only consenting customers', async () => {
    const s = await setup();
    const order = await newOrder(s);
    await ctx.db.order.update({
      where: { id: order.id },
      data: {
        trackingToken: `fb${randomUUID().replace(/-/g, '')}`,
        status: 'COMPLETED',
      },
    });
    const { trackingToken } = await ctx.db.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const guest = ctx.agent();
    await post(guest, `/public/orders/${trackingToken}/feedback`, {
      rating: 2,
      comment: 'Sovuq keldi',
    }).expect(201);
    expect(
      (
        await post(guest, `/public/orders/${trackingToken}/feedback`, {
          rating: 5,
        })
      ).body.code,
    ).toBe('FEEDBACK_EXISTS');
    const list = await s.owner.get('/api/feedback').expect(200);
    expect(list.body.stats).toMatchObject({
      count: 1,
      averageRating: 2,
      csat: 0,
      openComplaints: 1,
    });
    await post(s.owner, `/feedback/${list.body.feedback[0].id}/resolve`, {
      resolution: 'Chegirma kuponi berildi',
    }).expect(200);
    expect(
      (await s.owner.get('/api/feedback').expect(200)).body.stats
        .openComplaints,
    ).toBe(0);

    const yes = await ctx.db.customer.create({
      data: { tenantId: s.tenantId, phone: '+998901110001', name: 'Rozi' },
    });
    await ctx.db.customer.create({
      data: { tenantId: s.tenantId, phone: '+998901110002', name: 'Rozi emas' },
    });
    await s.owner
      .patch(`/api/customers/${yes.id}`)
      .set('Origin', ORIGIN)
      .send({ marketingConsent: true })
      .expect(200);
    const csv = await s.owner
      .get('/api/customers-export/marketing')
      .expect(200);
    expect(csv.text).toContain('+998901110001');
    expect(csv.text).not.toContain('+998901110002');
    await addUser(ctx, s.tenantId, {
      username: 'kassir',
      roleIds: [s.tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, s.tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/customers-export/marketing').expect(403);
  });
});
