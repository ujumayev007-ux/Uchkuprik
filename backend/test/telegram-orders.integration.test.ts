import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import type { TelegramTransport } from '../src/modules/notifications/notify.js';
import { verifyOrderCode } from '../src/modules/orders/codes.js';
import {
  handleTelegramUpdate,
  notifyTelegramCustomer,
} from '../src/modules/telegram/bot.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
// Fake Bot API: records every call, answers getMe.
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
    return method === 'getUpdates' ? [] : true;
  },
};
const services: Services = { ...ctx.services, telegram: fake };
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
const put = (a: Agent, path: string, body: object = {}) =>
  a.put(`/api${path}`).set('Origin', ORIGIN).send(body);
const TOKEN = '123456:AAHk-valid_token_for_tests_000000000000';

let updateId = 1;
const CHAT = 555001;
const message = (extra: object) => ({
  update_id: updateId++,
  message: {
    chat: { id: CHAT },
    from: { id: CHAT, first_name: 'Ali' },
    ...extra,
  },
});
const press = (data: string) => ({
  update_id: updateId++,
  callback_query: {
    id: `q${updateId}`,
    data,
    from: { id: CHAT, first_name: 'Ali' },
    message: { chat: { id: CHAT } },
  },
});
const lastText = () =>
  String(
    [...calls].reverse().find((call) => call.method === 'sendMessage')?.body
      .text ?? '',
  );
const lastButtons = () =>
  (
    [...calls].reverse().find((call) => call.method === 'sendMessage')?.body
      .reply_markup as { inline_keyboard?: { callback_data: string }[][] }
  )?.inline_keyboard?.flat() ?? [];

describe('Telegram bot ordering', () => {
  it('takes an order in the chat, lets one employee accept it and sends a code', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await addUser(ctx, tenantId, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    const category = await post(owner, '/menu/categories', {
      name: 'Lavashlar',
    }).expect(201);
    await post(owner, '/menu/products', {
      categoryId: category.body.id,
      name: 'Lavash',
      variants: [{ name: 'Standart', price: 30000 }],
    }).expect(201);
    await put(owner, '/notifications/telegram', {
      botToken: TOKEN,
      ordersEnabled: true,
    }).expect(200);
    const settings = await owner.get('/api/notifications/settings').expect(200);
    expect(settings.body.ordersEnabled).toBe(true);

    await handleTelegramUpdate(services, tenantId, message({ text: '/start' }));
    const categoryButton = lastButtons().find((b) =>
      b.callback_data.startsWith('c:'),
    )!;
    await handleTelegramUpdate(
      services,
      tenantId,
      press(categoryButton.callback_data),
    );
    const add = lastButtons().find((b) => b.callback_data.startsWith('a:'))!;
    await handleTelegramUpdate(services, tenantId, press(add.callback_data));
    await handleTelegramUpdate(services, tenantId, press(add.callback_data));
    expect(lastText()).toContain('60 000');
    await handleTelegramUpdate(services, tenantId, press('checkout'));
    expect(lastText()).toContain('Telefon');
    // Someone else's contact is refused.
    await handleTelegramUpdate(
      services,
      tenantId,
      message({ contact: { phone_number: '998901112233', user_id: 999 } }),
    );
    expect(lastText()).toContain('o‘zingizning');
    await handleTelegramUpdate(
      services,
      tenantId,
      message({ contact: { phone_number: '998901112233', user_id: CHAT } }),
    );
    await handleTelegramUpdate(services, tenantId, press('t:T'));
    expect(lastText()).toContain('tekshiring');
    await handleTelegramUpdate(services, tenantId, press('ok'));
    await handleTelegramUpdate(services, tenantId, press('ok')); // double tap
    const orders = await ctx.db.order.findMany({
      where: { tenantId, channel: 'TELEGRAM' },
    });
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order).toMatchObject({
      status: 'PENDING',
      total: 60000,
      customerPhone: '+998901112233',
      telegramChatId: String(CHAT),
    });

    // Cashier and owner accept at the same time: exactly one wins.
    const results = await Promise.all([
      post(owner, `/orders/${order.id}/approve`),
      post(cashier, `/orders/${order.id}/approve`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    await notifyTelegramCustomer(services, order.id);
    await notifyTelegramCustomer(services, order.id); // once per stage
    const notices = calls.filter(
      (call) =>
        call.method === 'sendMessage' &&
        String(call.body.text).includes('qabul qilindi'),
    );
    expect(notices).toHaveLength(1);
    const code = String(notices[0]!.body.text).match(/(\d{6})/)![1]!;
    const stored = await ctx.db.orderCode.findFirstOrThrow({
      where: { orderId: order.id, purpose: 'PICKUP' },
    });
    expect(stored.codeHash).not.toContain(code);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const wrong = await ctx.db.$transaction((tx) =>
      verifyOrderCode(tx, services.secrets, {
        orderId: order.id,
        purpose: 'PICKUP',
        code: code === '000000' ? '111111' : '000000',
        now: new Date(),
      }),
    );
    expect(wrong.ok).toBe(false);
    const right = await ctx.db.$transaction((tx) =>
      verifyOrderCode(tx, services.secrets, {
        orderId: order.id,
        purpose: 'PICKUP',
        code,
        now: new Date(),
      }),
    );
    expect(right.ok).toBe(true);
    // A consumed code cannot be reused.
    await expect(
      ctx.db.$transaction((tx) =>
        verifyOrderCode(tx, services.secrets, {
          orderId: order.id,
          purpose: 'PICKUP',
          code,
          now: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CODE_MISSING' });
  });
});
