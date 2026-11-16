import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { sha256 } from '../src/lib/crypto.js';
import {
  processNotificationJobs,
  TelegramError,
  type TelegramTransport,
} from '../src/modules/notifications/notify.js';
import { notifyAttendance } from '../src/modules/notifications/hooks.js';
import { startTelegramPolling } from '../src/modules/telegram/bot.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

/**
 * A separate fake bot (no real Telegram, no live Kassa): records every Bot API call,
 * can hold a webhook of "another server", queue updates for polling, or fail.
 */
const ctx = createTestContext();
// Chat ids unique to this run (the test database keeps earlier runs' messages).
const run = String(Date.now()).slice(-7);
const c = (n: string) => n + run;
const bot = {
  sent: [] as { chatId: string; text: string }[],
  calls: [] as string[],
  webhook: '',
  updates: [] as unknown[],
  // Only this bot (token) gets the queued updates: other test restaurants share the database.
  pollToken: '',
  failure: null as TelegramError | null,
};
const fake: TelegramTransport = {
  async send(_token, chatId, text) {
    if (bot.failure) throw bot.failure;
    bot.sent.push({ chatId, text });
  },
  async getMe() {
    return { username: 'sinov_fastfood_bot' };
  },
  async setWebhook(_token, url) {
    bot.calls.push('setWebhook');
    bot.webhook = url;
  },
  async api(_token, method, body) {
    bot.calls.push(method);
    if (method === 'getWebhookInfo') return { url: bot.webhook };
    if (method === 'getUpdates') {
      if (_token !== bot.pollToken) return [];
      const list = bot.updates;
      bot.updates = [];
      return list;
    }
    if (method === 'sendMessage') {
      const payload = body as { chat_id: string | number; text: string };
      bot.sent.push({ chatId: String(payload.chat_id), text: payload.text });
    }
    return true;
  },
};
const services: Services = { ...ctx.services, telegram: fake };
const probe = createDatabase(loadConfig().DATABASE_URL);
// A local Kassa server: no public HTTPS address.
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
beforeEach(() => {
  bot.sent = [];
  bot.calls = [];
  bot.webhook = '';
  bot.updates = [];
  bot.failure = null;
});
const agent = () => request.agent(app);
type Agent = ReturnType<typeof agent>;
const post = (a: Agent, path: string, body: object = {}) =>
  a.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (a: Agent, path: string, body: object = {}) =>
  a.put(`/api${path}`).set('Origin', ORIGIN).send(body);
// A separate token per test restaurant (they share one test database).
const token = () =>
  `654321:AAHk-separate_test_bot_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const botToken = token();
  await put(owner, '/notifications/telegram', {
    botToken,
    dailySummaryHour: null,
  }).expect(200);
  return { tenant, tenantId: tenant.tenant.id, owner, botToken };
}

const recipient = (
  s: Awaited<ReturnType<typeof setup>>,
  body: Record<string, unknown>,
) =>
  post(s.owner, '/notifications/subscribers', {
    name: 'Qabul qiluvchi',
    events: [],
    ...body,
  }).expect(201);

/** Delivers everything due now (the background worker's job), until the queue is empty. */
async function deliver() {
  await ctx.db.notificationJob.updateMany({
    where: { status: 'PENDING' },
    data: { nextTryAt: new Date(0) },
  });
  for (let round = 0; round < 50; round++)
    if ((await processNotificationJobs(services, 100)).claimed === 0) break;
}

describe('«Telegram’da ulash» (deep link + QR)', () => {
  it('links from the phone with one «Start» on a local Kassa (polling, no HTTPS)', async () => {
    const s = await setup();
    const created = await recipient(s, { name: 'Egasi telefoni' });
    const list1 = await s.owner.get('/api/notifications/subscribers');
    expect(list1.body.subscribers[0].state).toBe('NOT_LINKED');
    const link = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/link`,
    ).expect(200);
    expect(link.body.receiver).toBe('POLLING');
    const token = new URL(link.body.url).searchParams.get('start')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    // The token is not stored or shown again; the state is.
    const pending = await s.owner.get('/api/notifications/subscribers');
    expect(pending.body.subscribers[0].state).toBe('PENDING');
    expect(JSON.stringify(pending.body)).not.toContain(token);

    // The phone pressed «Start»: the Kassa reads it by polling.
    bot.pollToken = s.botToken;
    bot.updates = [
      {
        update_id: 101,
        message: { text: `/start ${token}`, chat: { id: 9001 } },
      },
    ];
    const stop = startTelegramPolling(services, 50);
    await new Promise((resolve) => setTimeout(resolve, 400));
    stop();
    const linked = await s.owner.get('/api/notifications/subscribers');
    expect(linked.body.subscribers[0]).toMatchObject({
      state: 'LINKED',
      linked: true,
      chatId: '…9001',
    });
    expect(bot.sent.at(-1)).toMatchObject({ chatId: '9001' });
    expect(bot.sent.at(-1)!.text).toContain('✅ Ulandi!');
    // Polling never removed or replaced any webhook.
    expect(bot.calls).not.toContain('deleteWebhook');
    expect(bot.calls).not.toContain('setWebhook');
  });

  it('refuses an expired code and a used one («Ulash kodi eskirgan»)', async () => {
    const s = await setup();
    const { sha256: _ } = { sha256 };
    const created = await recipient(s, {});
    const link = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/link`,
    ).expect(200);
    const token = new URL(link.body.url).searchParams.get('start')!;
    await ctx.db.notificationSubscriber.update({
      where: { id: created.body.id },
      data: { linkExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await s.owner.get('/api/notifications/subscribers');
    expect(expired.body.subscribers[0].state).toBe('EXPIRED');
    await ctx.db.telegramConfig.update({
      where: { tenantId: s.tenantId },
      data: { webhookSecretHash: sha256('known') },
    });
    const start = (code: string, chat: number) =>
      agent()
        .post(`/api/webhooks/telegram/${s.tenantId}`)
        .set('X-Telegram-Bot-Api-Secret-Token', 'known')
        .send({ message: { text: `/start ${code}`, chat: { id: chat } } })
        .expect(200);
    await start(token, 7001);
    expect(bot.sent.at(-1)!.text).toContain('Ulash kodi eskirgan');
    expect(
      (
        await ctx.db.notificationSubscriber.findUniqueOrThrow({
          where: { id: created.body.id },
        })
      ).chatId,
    ).toBeNull();
    // A fresh code links once; the same code a second time does not.
    const again = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/link`,
    ).expect(200);
    const fresh = new URL(again.body.url).searchParams.get('start')!;
    await start(fresh, 7001);
    expect(bot.sent.at(-1)!.text).toContain('✅ Ulandi!');
    await start(fresh, 7002);
    expect(bot.sent.at(-1)!.text).toContain('allaqachon ishlatilgan');
    // A code of another restaurant's recipient never links here.
    const other = await setup();
    const theirs = await recipient(other, {});
    const theirLink = await post(
      other.owner,
      `/notifications/subscribers/${theirs.body.id}/link`,
    ).expect(200);
    await start(new URL(theirLink.body.url).searchParams.get('start')!, 7003);
    expect(bot.sent.at(-1)!.text).toContain('noto‘g‘ri');
  });

  it('a bot with another server’s webhook: never replaced or removed, manual chat ID works', async () => {
    const tenant = await createTenant(ctx);
    const owner = agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    bot.webhook = 'https://boshqa-server.example/telegram';
    const saved = await put(owner, '/notifications/telegram', {
      botToken: token(),
    }).expect(200);
    expect(saved.body.webhookConflict).toBe(true);
    const settings = await owner.get('/api/notifications/settings').expect(200);
    expect(settings.body.receiver).toBe('CONFLICT');
    // Polling stays out of the way of that webhook.
    const created = await post(owner, '/notifications/subscribers', {
      name: 'Qo‘lda',
      events: ['shift.opened'],
    }).expect(201);
    await post(
      owner,
      `/notifications/subscribers/${created.body.id}/link`,
    ).expect(200);
    const stop = startTelegramPolling(services, 50);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    expect(bot.calls).not.toContain('getUpdates');
    expect(bot.calls).not.toContain('deleteWebhook');
    expect(bot.calls).not.toContain('setWebhook');
    expect(bot.webhook).toBe('https://boshqa-server.example/telegram');
    // «Qo‘shimcha sozlamalar → Telegram chat ID» (manual fallback).
    await put(owner, `/notifications/subscribers/${created.body.id}`, {
      name: 'Qo‘lda',
      chatId: '424242',
      events: ['shift.opened'],
    }).expect(200);
    const list = await owner.get('/api/notifications/subscribers');
    expect(list.body.subscribers[0].state).toBe('LINKED');
  });
});

describe('«Sinov xabari» and delivery states', () => {
  it('«Navbatda» → «Telegram qabul qildi»; a blocked bot → «Yuborilmadi» with the reason', async () => {
    const s = await setup();
    const created = await recipient(s, { chatId: c('5005') });
    const requestId = randomUUID();
    const test = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/test`,
      { requestId },
    ).expect(200);
    // Pressed twice (or retried): one message.
    const twice = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/test`,
      { requestId },
    ).expect(200);
    expect(twice.body.jobId).toBe(test.body.jobId);
    const queued = await s.owner.get(
      `/api/notifications/jobs/${test.body.jobId}`,
    );
    expect(queued.body.status).toBe('PENDING'); // «Navbatda», not success
    await deliver();
    const done = await s.owner.get(
      `/api/notifications/jobs/${test.body.jobId}`,
    );
    expect(done.body.status).toBe('SENT');
    expect(bot.sent.filter((m) => m.chatId === c('5005'))).toHaveLength(1);

    bot.failure = new TelegramError('TG_BLOCKED', true);
    const blocked = await post(
      s.owner,
      `/notifications/subscribers/${created.body.id}/test`,
      { requestId: randomUUID() },
    ).expect(200);
    await deliver();
    const failed = await s.owner.get(
      `/api/notifications/jobs/${blocked.body.jobId}`,
    );
    // Permanent: not retried five more times.
    expect(failed.body).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'TG_BLOCKED',
    });
  });
});

describe('per-recipient events and branches', () => {
  it('one event off keeps the others; branches stay apart; paused keeps settings; money only when allowed', async () => {
    const s = await setup();
    const main = s.tenant.branch;
    const second = await ctx.db.branch.create({
      data: {
        tenantId: s.tenantId,
        name: 'Chilonzor',
        code: `B${Date.now() % 100000}`,
        timezone: 'Asia/Tashkent',
      },
    });
    const a = await recipient(s, {
      name: 'Faqat markaz',
      chatId: c('1001'),
      events: ['shift.opened', 'shift.closed'],
      branchIds: [main.id],
      financial: false,
    });
    const b = await recipient(s, {
      name: 'Hamma filiallar',
      chatId: c('1002'),
      events: ['shift.closed'],
    });
    const opened = await post(s.owner, '/shifts/open', {
      branchId: main.id,
      openingCash: 100000,
    }).expect(201);
    await post(s.owner, '/shifts/open', {
      branchId: second.id,
      openingCash: 50000,
    }).expect(201);
    await deliver();
    const toA = bot.sent.filter((m) => m.chatId === c('1001'));
    const toB = bot.sent.filter((m) => m.chatId === c('1002'));
    // A: «Smena ochildi» only for its branch, without the money amount.
    expect(toA).toHaveLength(1);
    expect(toA[0]!.text).toContain('Smena ochildi');
    expect(toA[0]!.text).toContain(main.name);
    expect(toA[0]!.text).toContain('Boshlang‘ich naqd: —');
    expect(toA[0]!.text).toMatch(/🕒 \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
    // B: «Smena ochildi» is off for B; «Smena yopildi» stays on.
    expect(toB).toHaveLength(0);
    await post(s.owner, `/shifts/${opened.body.id}/close`, {
      countedCash: 100000,
    }).expect(200);
    await deliver();
    const closedToB = bot.sent.filter(
      (m) => m.chatId === c('1002') && m.text.includes('Smena yopildi'),
    );
    expect(closedToB).toHaveLength(1);
    expect(closedToB[0]!.text).toContain('100 000 so‘m');
    // Paused recipient: nothing arrives, its events and branches are kept.
    await put(s.owner, `/notifications/subscribers/${a.body.id}`, {
      name: 'Faqat markaz',
      events: ['shift.opened', 'shift.closed'],
      branchIds: [main.id],
      isActive: false,
    }).expect(200);
    const paused = await ctx.db.notificationSubscriber.findUniqueOrThrow({
      where: { id: a.body.id },
    });
    expect(paused.events).toEqual(['shift.opened', 'shift.closed']);
    expect(paused.branchIds).toEqual([main.id]);
    void b;
  });

  it('attendance: real clock-in/out, once per record, only to staff-allowed recipients', async () => {
    const s = await setup();
    await recipient(s, {
      name: 'Kadrlar',
      chatId: c('2001'),
      events: ['attendance.in', 'attendance.out'],
    });
    await recipient(s, {
      name: 'Xodimlarsiz',
      chatId: c('2002'),
      events: ['attendance.in', 'attendance.out'],
      staff: false,
    });
    await addUser(ctx, s.tenantId, {
      username: 'oshpaz',
      roleIds: [s.tenant.roleId('kitchen')],
    });
    const cook = agent();
    await login(cook, s.tenant.slug, 'oshpaz').expect(200);
    // Signing in alone is not «ishga keldi».
    await deliver();
    expect(bot.sent.filter((m) => m.chatId === c('2001'))).toHaveLength(0);
    const record = await post(cook, '/attendance/clock-in').expect(201);
    await post(cook, '/attendance/clock-out').expect(200);
    // A retried request finds the message already queued.
    const row = await ctx.db.attendanceRecord.findUniqueOrThrow({
      where: { id: record.body.id },
    });
    await ctx.db.$transaction((tx) =>
      notifyAttendance(tx, {
        id: row.id,
        tenantId: s.tenantId,
        branchId: row.branchId,
        employee: 'Oshpaz',
        clockIn: row.clockIn,
      }),
    );
    await deliver();
    const toStaff = bot.sent.filter((m) => m.chatId === c('2001'));
    expect(toStaff.map((m) => m.text.split('\n')[0])).toEqual([
      expect.stringContaining('Xodim ishga keldi'),
      expect.stringContaining('Xodim ishdan ketdi'),
    ]);
    expect(bot.sent.filter((m) => m.chatId === c('2002'))).toHaveLength(0);
  });

  it('«Tovar tugadi» when stock crosses to zero, separate from «Tovar kam qoldi»', async () => {
    const s = await setup();
    await recipient(s, {
      name: 'Ombor',
      chatId: c('3001'),
      events: ['stock.low', 'stock.out'],
    });
    const item = await post(s.owner, '/inventory/items', {
      name: 'Go‘sht',
      baseUnit: 'G',
      minStock: 2000,
    }).expect(201);
    await post(s.owner, '/purchases/market', {
      supplierName: 'Bozor',
      paid: true,
      paymentMethod: 'CARD',
      lines: [
        {
          stockItemId: item.body.id,
          quantity: '5',
          unitName: 'kg',
          lineTotal: 1,
        },
      ],
    }).expect(201);
    const count = (counted: string) =>
      post(s.owner, '/inventory/stocktakes', {
        counts: [{ stockItemId: item.body.id, counted }],
        reason: 'Sanoq',
      }).expect(201);
    await count('1500'); // below the minimum: «kam qoldi»
    await count('0'); // to zero: «tugadi»
    await deliver();
    const texts = bot.sent
      .filter((m) => m.chatId === c('3001'))
      .map((m) => m.text);
    expect(texts[0]).toContain('Tovar kam qoldi: Go‘sht');
    expect(texts[1]).toContain('Tovar tugadi: Go‘sht');
    expect(texts).toHaveLength(2);
  });
});

describe('reliability and reports', () => {
  it('checkout works while Telegram is unreachable; the message waits in the queue', async () => {
    const s = await setup();
    await recipient(s, { chatId: c('4001'), events: ['shift.opened'] });
    bot.failure = new TelegramError('TG_NETWORK');
    await post(s.owner, '/shifts/open', { openingCash: 10000 }).expect(201);
    const category = await ctx.db.menuCategory.create({
      data: { tenantId: s.tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId: s.tenantId, categoryId: category.id, name: 'Lavash' },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId: s.tenantId,
        productId: product.id,
        name: 'Oddiy',
        price: 30000,
      },
    });
    const order = await post(s.owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);
    await post(s.owner, `/orders/${order.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 30000,
      tendered: 30000,
    }).expect(201);
    await deliver();
    const job = await ctx.db.notificationJob.findFirstOrThrow({
      where: { tenantId: s.tenantId, event: 'shift.opened' },
    });
    expect(job).toMatchObject({ status: 'PENDING', lastError: 'TG_NETWORK' });
    bot.failure = null;
    await deliver();
    expect(
      (
        await ctx.db.notificationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).status,
    ).toBe('SENT');
  });

  it('«Telegram’ga yuborish» sends the report once; auto-send only after a file is made', async () => {
    const s = await setup();
    await recipient(s, {
      name: 'Hisobot',
      chatId: c('6001'),
      events: ['report'],
    });
    await recipient(s, {
      name: 'Avto',
      chatId: c('6002'),
      events: ['report.auto'],
    });
    // Opening the Reports page sends nothing.
    await s.owner.get('/api/reports/sales').expect(200);
    await deliver();
    expect(bot.sent).toHaveLength(0);
    const requestId = randomUUID();
    await post(s.owner, '/reports/telegram', { requestId }).expect(200);
    await post(s.owner, '/reports/telegram', { requestId }).expect(200);
    await s.owner.get('/api/reports/export?format=xlsx').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await deliver();
    expect(bot.sent.filter((m) => m.chatId === c('6001'))).toHaveLength(1);
    expect(bot.sent.find((m) => m.chatId === c('6001'))!.text).toContain(
      '📊 Hisobot:',
    );
    const auto = bot.sent.filter((m) => m.chatId === c('6002'));
    expect(auto).toHaveLength(1);
    expect(auto[0]!.text).toContain('Tayyorlangan hisobot (XLSX)');
  });
});
