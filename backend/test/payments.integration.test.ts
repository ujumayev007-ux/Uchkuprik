import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
const PAYME_KEY = 'paycom-test-key-1234';
const run = Date.now().toString().slice(-9);
const pm = (name: string) => `${name}-${run}`;
const clickId = (n: number) => `${run}${n}`;
const CLICK_SECRET = 'click-secret-key-5678';

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  await ctx.db.tenantProfile.create({
    data: { tenantId, publicOrdering: true },
  });
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
  await owner
    .put('/api/payments/providers/PAYME')
    .set('Origin', ORIGIN)
    .send({ merchantId: 'pm-merchant', secret: PAYME_KEY })
    .expect(200);
  await owner
    .put('/api/payments/providers/CLICK')
    .set('Origin', ORIGIN)
    .send({
      merchantId: '777',
      serviceId: '1234',
      merchantUserId: '99',
      secret: CLICK_SECRET,
    })
    .expect(200);
  const configs = await ctx.db.paymentProviderConfig.findMany({
    where: { tenantId },
  });
  return {
    tenant,
    tenantId,
    owner,
    variant,
    payme: configs.find((c) => c.provider === 'PAYME')!.id,
    click: configs.find((c) => c.provider === 'CLICK')!.id,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function onlineOrder(s: Setup) {
  const created = await ctx
    .agent()
    .post('/api/public/orders')
    .set('Origin', ORIGIN)
    .send({
      idempotencyKey: randomUUID(),
      source: {
        kind: 'web',
        slug: s.tenant.slug,
        branchId: s.tenant.branch.id,
        type: 'TAKEAWAY',
      },
      customerName: 'Mijoz',
      customerPhone: '+998901112233',
      items: [{ variantId: s.variant.id, quantity: 1 }],
    })
    .expect(201);
  const order = await ctx.db.order.findFirstOrThrow({
    where: { trackingToken: created.body.trackingToken },
  });
  return { order, token: created.body.trackingToken as string };
}

const payme = (
  configId: string,
  method: string,
  params: object,
  key = PAYME_KEY,
) =>
  ctx
    .agent()
    .post(`/api/webhooks/payme/${configId}`)
    .set(
      'Authorization',
      `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}`,
    )
    .send({ jsonrpc: '2.0', id: 1, method, params })
    .expect(200);

describe('Payme Merchant API', () => {
  it('authenticates, validates amounts and performs a payment exactly once', async () => {
    const s = await setup();
    const { order, token } = await onlineOrder(s);
    const account = { order_id: order.id };
    expect(
      (
        await payme(
          s.payme,
          'CheckPerformTransaction',
          { amount: 4000000, account },
          'wrong-key',
        )
      ).body.error.code,
    ).toBe(-32504);
    expect(
      (
        await payme(s.payme, 'CheckPerformTransaction', {
          amount: 3900000,
          account,
        })
      ).body.error.code,
    ).toBe(-31001);
    expect(
      (
        await payme(s.payme, 'CheckPerformTransaction', {
          amount: 4000000,
          account: { order_id: randomUUID() },
        })
      ).body.error.code,
    ).toBe(-31050);
    expect(
      (
        await payme(s.payme, 'CheckPerformTransaction', {
          amount: 4000000,
          account,
        })
      ).body.result,
    ).toEqual({ allow: true });

    const time = Date.now();
    const created = await payme(s.payme, 'CreateTransaction', {
      id: pm('pm-tx-1'),
      time,
      amount: 4000000,
      account,
    });
    expect(created.body.result).toMatchObject({ create_time: time, state: 1 });
    const again = await payme(s.payme, 'CreateTransaction', {
      id: pm('pm-tx-1'),
      time,
      amount: 4000000,
      account,
    });
    expect(again.body.result.transaction).toBe(created.body.result.transaction);
    expect(
      (
        await payme(s.payme, 'CreateTransaction', {
          id: pm('pm-tx-2'),
          time,
          amount: 4000000,
          account,
        })
      ).body.error.code,
    ).toBe(-31052);

    const performed = await payme(s.payme, 'PerformTransaction', {
      id: pm('pm-tx-1'),
    });
    expect(performed.body.result.state).toBe(2);
    const repeat = await payme(s.payme, 'PerformTransaction', {
      id: pm('pm-tx-1'),
    });
    expect(repeat.body.result.perform_time).toBe(
      performed.body.result.perform_time,
    );
    const paid = await ctx.db.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    // A verified online payment accepts the PENDING order automatically.
    expect(paid).toMatchObject({ paidTotal: 40000, status: 'PLACED' });
    const payments = await ctx.db.payment.findMany({
      where: { orderId: order.id },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'PAYME',
      amount: 40000,
      shiftId: null,
      reference: pm('pm-tx-1'),
    });

    expect(
      (
        await payme(s.payme, 'CancelTransaction', {
          id: pm('pm-tx-1'),
          reason: 5,
        })
      ).body.error.code,
    ).toBe(-31007);
    expect(
      (await payme(s.payme, 'CheckTransaction', { id: pm('pm-tx-1') })).body
        .result.state,
    ).toBe(2);
    expect(
      (await payme(s.payme, 'CheckTransaction', { id: 'unknown' })).body.error
        .code,
    ).toBe(-31003);
    const statement = await payme(s.payme, 'GetStatement', {
      from: time - 1000,
      to: time + 1000,
    });
    expect(statement.body.result.transactions).toEqual([
      expect.objectContaining({ id: pm('pm-tx-1'), amount: 4000000, state: 2 }),
    ]);
    expect((await payme(s.payme, 'Unknown', {})).body.error.code).toBe(-32601);

    // The customer no longer gets pay links once the order is paid.
    const links = await ctx
      .agent()
      .get(`/api/public/orders/${token}/pay`)
      .expect(200);
    expect(links.body).toEqual({ due: 0, links: [] });
  });

  it('expires unperformed transactions after 12 hours and isolates tenants', async () => {
    const s = await setup();
    const { order } = await onlineOrder(s);
    const old = Date.now() - 13 * 3_600_000;
    await payme(s.payme, 'CreateTransaction', {
      id: pm('pm-old'),
      time: old,
      amount: 4000000,
      account: { order_id: order.id },
    });
    expect(
      (await payme(s.payme, 'PerformTransaction', { id: pm('pm-old') })).body
        .error.code,
    ).toBe(-31008);
    expect(
      (await payme(s.payme, 'CheckTransaction', { id: pm('pm-old') })).body
        .result,
    ).toMatchObject({ state: -1, reason: 4 });
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .paidTotal,
    ).toBe(0);

    const other = await setup();
    const { order: foreign } = await onlineOrder(other);
    const cross = await payme(s.payme, 'CheckPerformTransaction', {
      amount: 4000000,
      account: { order_id: foreign.id },
    });
    expect(cross.body.error.code).toBe(-31050);
  });
});

const clickSign = (
  body: Record<string, string>,
  complete: boolean,
  secret = CLICK_SECRET,
) =>
  createHash('md5')
    .update(
      `${body.click_trans_id}${body.service_id}${secret}${body.merchant_trans_id}${complete ? body.merchant_prepare_id : ''}${body.amount}${body.action}${body.sign_time}`,
    )
    .digest('hex');

const click = (
  configId: string,
  stage: 'prepare' | 'complete',
  fields: Record<string, string>,
) => {
  const body = {
    service_id: '1234',
    click_paydoc_id: '555',
    sign_time: '2026-10-12 12:00:00',
    error: '0',
    error_note: 'Success',
    ...fields,
  };
  return ctx
    .agent()
    .post(`/api/webhooks/click/${configId}/${stage}`)
    .type('form')
    .send({
      ...body,
      sign_string: fields.sign_string ?? clickSign(body, stage === 'complete'),
    })
    .expect(200);
};

describe('Click SHOP API', () => {
  it('verifies signatures and captures the payment on complete', async () => {
    const s = await setup();
    const { order } = await onlineOrder(s);
    const base = {
      click_trans_id: clickId(1),
      merchant_trans_id: order.id,
      amount: '40000',
    };
    expect(
      (
        await click(s.click, 'prepare', {
          ...base,
          action: '0',
          sign_string: 'bad',
        })
      ).body.error,
    ).toBe(-1);
    expect(
      (
        await click(s.click, 'prepare', {
          ...base,
          amount: '1000',
          action: '0',
        })
      ).body.error,
    ).toBe(-2);
    const prepared = await click(s.click, 'prepare', { ...base, action: '0' });
    expect(prepared.body).toMatchObject({
      error: 0,
      merchant_prepare_id: Number(clickId(1)),
    });
    const completed = await click(s.click, 'complete', {
      ...base,
      action: '1',
      merchant_prepare_id: clickId(1),
    });
    expect(completed.body).toMatchObject({
      error: 0,
      merchant_confirm_id: Number(clickId(1)),
    });
    expect(
      await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ).toMatchObject({ paidTotal: 40000, status: 'PLACED' });
    expect(
      (
        await click(s.click, 'complete', {
          ...base,
          action: '1',
          merchant_prepare_id: clickId(1),
        })
      ).body.error,
    ).toBe(-4);
    expect(await ctx.db.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );
  });

  it('cancels when Click reports a failed payment', async () => {
    const s = await setup();
    const { order } = await onlineOrder(s);
    const base = {
      click_trans_id: clickId(2),
      merchant_trans_id: order.id,
      amount: '40000',
    };
    await click(s.click, 'prepare', { ...base, action: '0' });
    const failed = await click(s.click, 'complete', {
      ...base,
      action: '1',
      merchant_prepare_id: clickId(2),
      error: '-5017',
    });
    expect(failed.body.error).toBe(-9);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .paidTotal,
    ).toBe(0);
  });
});

describe('payment administration', () => {
  it('never returns secrets, builds checkout links and reconciles provider payments', async () => {
    const s = await setup();
    const providers = await s.owner.get('/api/payments/providers').expect(200);
    expect(JSON.stringify(providers.body)).not.toContain(PAYME_KEY);
    expect(JSON.stringify(providers.body)).not.toContain(CLICK_SECRET);
    expect(providers.body.providers[0].callbackUrls[0]).toBe(
      `${ORIGIN}/api/webhooks/payme/${s.payme}`,
    );

    const { order, token } = await onlineOrder(s);
    const links = await ctx
      .agent()
      .get(`/api/public/orders/${token}/pay`)
      .expect(200);
    expect(links.body.due).toBe(40000);
    const paymeUrl = links.body.links.find(
      (l: { provider: string }) => l.provider === 'PAYME',
    ).url as string;
    const decoded = Buffer.from(
      paymeUrl.split('/').pop()!,
      'base64',
    ).toString();
    expect(decoded).toBe(
      `m=pm-merchant;ac.order_id=${order.id};a=4000000;c=${ORIGIN}/buyurtma/${token}`,
    );
    expect(
      links.body.links.find((l: { provider: string }) => l.provider === 'CLICK')
        .url,
    ).toContain('service_id=1234');

    await payme(s.payme, 'CreateTransaction', {
      id: pm('pm-rec'),
      time: Date.now(),
      amount: 4000000,
      account: { order_id: order.id },
    });
    await payme(s.payme, 'PerformTransaction', { id: pm('pm-rec') });
    const today = new Date().toISOString().slice(0, 10);
    const report = await s.owner
      .get(`/api/payments/reconciliation?from=${today}&to=${today}`)
      .expect(200);
    expect(
      report.body.summary.find(
        (row: { provider: string }) => row.provider === 'PAYME',
      ),
    ).toMatchObject({
      performedCount: 1,
      performedAmount: 40000,
      recordedAmount: 40000,
    });
    expect(report.body.issues).toEqual([]);
  });
});
