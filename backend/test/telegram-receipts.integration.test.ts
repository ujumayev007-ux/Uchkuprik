import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import type { TelegramTransport } from '../src/modules/notifications/notify.js';
import { handleTelegramUpdate } from '../src/modules/telegram/bot.js';
import { sendTelegramReceipt } from '../src/modules/telegram/receipt.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Elektron chek in Telegram: sent once when the order is paid, only to the chat the
// order came from or a chat whose number Telegram confirmed as the guest's own.

const ctx = createTestContext();
const calls: { method: string; body: Record<string, unknown> }[] = [];
const fake: TelegramTransport = {
  async send(_token, chatId, text) {
    calls.push({ method: 'sendMessage', body: { chat_id: chatId, text } });
  },
  async getMe() {
    return { username: 'lazzat_bot' };
  },
  async setWebhook() {},
  async api(_token, method, body) {
    calls.push({ method, body: body as Record<string, unknown> });
    return true;
  },
};
const PUBLIC = 'https://lazzat.example.uz';
const services: Services = {
  ...ctx.services,
  telegram: fake,
  appOrigin: PUBLIC,
  afterOrderChange: async (orderId) => {
    await sendTelegramReceipt(services, orderId, { origin: PUBLIC });
  },
};
const probe = createDatabase(loadConfig().DATABASE_URL);
const app = createApp({
  config: { APP_ORIGIN: ORIGIN },
  database: probe,
  logger: services.logger,
  services,
});
afterAll(async () => {
  await probe.close();
  await ctx.close();
});
const agent = () => request.agent(app);
type Agent = ReturnType<typeof agent>;
const post = (a: Agent, path: string, body: object = {}) =>
  a.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const TOKEN = '123456:AAHk-valid_token_for_tests_000000000000';
// Receipts only (not the bot's replies).
const sent = (chatId: string) =>
  calls.filter(
    (call) =>
      call.method === 'sendMessage' &&
      String(call.body.chat_id) === chatId &&
      String(call.body.text).includes('— elektron chek'),
  );

let update = 1;
const message = (chat: number, from: number, extra: object) => ({
  update_id: update++,
  message: {
    chat: { id: chat },
    from: { id: from, first_name: 'Ali' },
    ...extra,
  },
});

describe('electronic receipts in Telegram', () => {
  it('a guest links their own number; paid orders get the receipt once; others never', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await owner
      .put('/api/notifications/telegram')
      .set('Origin', ORIGIN)
      .send({ botToken: TOKEN, receiptsEnabled: true, ordersEnabled: false })
      .expect(200);
    expect(
      (await owner.get('/api/notifications/settings').expect(200)).body
        .receiptsEnabled,
    ).toBe(true);

    // Someone else's contact card: refused. Their own: linked and confirmed.
    await handleTelegramUpdate(
      services,
      tenantId,
      message(7001, 7001, {
        contact: { phone_number: '998901110000', user_id: 9999 },
      }),
    );
    await handleTelegramUpdate(
      services,
      tenantId,
      message(7001, 7001, { contact: { phone_number: '998901110000' } }),
    );
    expect(
      await ctx.db.telegramChat.count({
        where: { tenantId, phoneVerified: true },
      }),
    ).toBe(0);
    await handleTelegramUpdate(
      services,
      tenantId,
      message(7001, 7001, {
        contact: { phone_number: '+998 90 111 22 33', user_id: 7001 },
      }),
    );
    const chat = await ctx.db.telegramChat.findFirstOrThrow({
      where: { tenantId, chatId: '7001' },
    });
    expect(chat).toMatchObject({ phone: '+998901112233', phoneVerified: true });

    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Osh' },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        name: 'Standart',
        price: 30_000,
      },
    });
    await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
    const order = async (phone: string | null) =>
      (
        await post(owner, '/orders', {
          idempotencyKey: randomUUID(),
          type: 'TAKEAWAY',
          customerPhone: phone,
          items: [{ variantId: variant.id, quantity: 2 }],
        }).expect(201)
      ).body.id as string;
    const pay = (id: string, amount: number) =>
      post(owner, `/orders/${id}/payments`, {
        idempotencyKey: randomUUID(),
        method: 'CASH',
        amount,
        tendered: amount,
      }).expect(201);

    const id = await order('+998901112233');
    await pay(id, 20_000);
    // Not paid in full yet: nothing.
    expect(sent('7001')).toHaveLength(0);
    await pay(id, 40_000);
    const receipts = sent('7001');
    expect(receipts).toHaveLength(1);
    const text = String(receipts[0]!.body.text);
    expect(text).toContain('elektron chek');
    expect(text).toContain('2 × Osh — 60 000');
    expect(text).toContain('JAMI: 60 000');
    expect(text).toMatch(new RegExp(`${PUBLIC}/buyurtma/[A-Za-z0-9_-]{16,}`));
    // Later changes do not send it again.
    await sendTelegramReceipt(services, id, { origin: PUBLIC });
    expect(sent('7001')).toHaveLength(1);
    // Staff may send it again by hand.
    await post(owner, `/orders/${id}/e-receipt/telegram`).expect(200);
    expect(sent('7001')).toHaveLength(2);

    // A number nobody linked (or linked without confirmation): no message.
    const stranger = await order('+998901110000');
    await pay(stranger, 60_000);
    expect(
      calls.filter((call) =>
        String(call.body.text ?? '').includes('— elektron chek'),
      ),
    ).toHaveLength(2);
    const refused = await post(
      owner,
      `/orders/${stranger}/e-receipt/telegram`,
    ).expect(409);
    expect(refused.body.code).toBe('TELEGRAM_NO_CHAT');

    // /stop: no more receipts.
    await handleTelegramUpdate(
      services,
      tenantId,
      message(7001, 7001, { text: '/stop' }),
    );
    const after = await order('+998901112233');
    await pay(after, 60_000);
    expect(sent('7001')).toHaveLength(2);
  });

  it('switched off: nothing is sent', async () => {
    const tenant = await createTenant(ctx);
    const owner = agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await owner
      .put('/api/notifications/telegram')
      .set('Origin', ORIGIN)
      .send({ botToken: TOKEN })
      .expect(200);
    const before = calls.length;
    const category = await ctx.db.menuCategory.create({
      data: { tenantId: tenant.tenant.id, name: 'T' },
    });
    const product = await ctx.db.product.create({
      data: {
        tenantId: tenant.tenant.id,
        categoryId: category.id,
        name: 'Choy',
      },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId: tenant.tenant.id,
        productId: product.id,
        name: 'Standart',
        price: 5_000,
      },
    });
    await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
    const created = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      customerPhone: '+998901112233',
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);
    await post(owner, `/orders/${created.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 5_000,
      tendered: 5_000,
    }).expect(201);
    expect(
      calls.slice(before).filter((call) => call.method === 'sendMessage'),
    ).toHaveLength(0);
  });
});
