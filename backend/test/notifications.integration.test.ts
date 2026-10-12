import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import {
  notify,
  processNotificationJobs,
  runDailySummaries,
  type TelegramTransport,
} from '../src/modules/notifications/notify.js';
import request from 'supertest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
// Fake Telegram transport: records messages and can fail on demand.
const sent: { chatId: string; text: string; token: string }[] = [];
let failSends = false;
const fake: TelegramTransport = {
  async send(token, chatId, text) {
    if (failSends) throw new Error('down');
    sent.push({ token, chatId, text });
  },
  async getMe(token) {
    if (!token.startsWith('123456:')) throw new Error('bad token');
    return { username: 'lazzat_test_bot' };
  },
  async setWebhook() {},
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

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  return { tenant, tenantId: tenant.tenant.id, owner };
}

describe('Telegram notifications', () => {
  it('stores the bot token encrypted and never returns it', async () => {
    const s = await setup();
    const invalid = await put(s.owner, '/notifications/telegram', {
      botToken: '999999:AAHk-not_accepted_token_00000000000000',
    });
    expect(invalid.body.code).toBe('TELEGRAM_TOKEN_INVALID');
    const saved = await put(s.owner, '/notifications/telegram', {
      botToken: TOKEN,
      dailySummaryHour: 0,
    }).expect(200);
    expect(saved.body.botUsername).toBe('lazzat_test_bot');
    const settings = await s.owner
      .get('/api/notifications/settings')
      .expect(200);
    expect(JSON.stringify(settings.body)).not.toContain(TOKEN);
    const row = await ctx.db.telegramConfig.findUniqueOrThrow({
      where: { tenantId: s.tenantId },
    });
    expect(row.botTokenEnc).not.toContain('AAHk');
    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { tenantId: s.tenantId, action: 'notifications.telegram.update' },
    });
    expect(JSON.stringify(audit.data)).not.toContain(TOKEN);
  });

  it('links subscribers through the signed webhook and delivers with retries', async () => {
    const s = await setup();
    await put(s.owner, '/notifications/telegram', { botToken: TOKEN }).expect(
      200,
    );
    const created = await post(s.owner, '/notifications/subscribers', {
      name: 'Boshqaruvchi',
      events: ['incident', 'summary.daily'],
    }).expect(201);
    expect(created.body.linkCode).toMatch(/^[A-Z0-9]{10}$/);

    // The webhook secret is set on the bot; forge attempts are rejected.
    await agent()
      .post(`/api/webhooks/telegram/${s.tenantId}`)
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send({
        message: { text: `/start ${created.body.linkCode}`, chat: { id: 555 } },
      })
      .expect(401);
    // Recreate the secret known to the test by reading the stored hash path:
    // set a known secret directly (the real one is only sent to Telegram).
    const { sha256 } = await import('../src/lib/crypto.js');
    await ctx.db.telegramConfig.update({
      where: { tenantId: s.tenantId },
      data: { webhookSecretHash: sha256('known-secret') },
    });
    await agent()
      .post(`/api/webhooks/telegram/${s.tenantId}`)
      .set('X-Telegram-Bot-Api-Secret-Token', 'known-secret')
      .send({
        message: { text: `/start ${created.body.linkCode}`, chat: { id: 555 } },
      })
      .expect(200);
    const subscriber = await ctx.db.notificationSubscriber.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(subscriber.chatId).toBe('555');
    expect(subscriber.linkCode).toBeNull();

    // Events not subscribed to are not queued; subscribed ones are.
    expect(await notify(ctx.db, s.tenantId, 'stock.low', { item: 'Un' })).toBe(
      0,
    );
    expect(
      await notify(ctx.db, s.tenantId, 'incident', {
        severity: 'Yuqori',
        title: 'Muzlatgich',
        branch: 'Markaziy',
        description: '9 °C',
      }),
    ).toBe(1);

    // Failure → retry with backoff, then success.
    failSends = true;
    await processNotificationJobs(services);
    const failed = await ctx.db.notificationJob.findFirstOrThrow({
      where: { tenantId: s.tenantId, event: 'incident' },
    });
    expect(failed).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Delivery failed',
    });
    failSends = false;
    await ctx.db.notificationJob.updateMany({
      where: { tenantId: s.tenantId },
      data: { nextTryAt: new Date(0) },
    });
    await processNotificationJobs(services);
    const delivered = sent.filter((message) => message.chatId === '555');
    expect(delivered.map((message) => message.text).join('\n')).toContain(
      '⚠️ Hodisa (Yuqori): Muzlatgich',
    );
    expect(delivered[0]!.token).toBe(TOKEN);

    const monitor = await s.owner.get('/api/notifications/jobs').expect(200);
    expect(monitor.body.counts.SENT).toBeGreaterThanOrEqual(2);
  });

  it('uses custom templates, sends one daily summary per day and alerts on events', async () => {
    const s = await setup();
    await put(s.owner, '/notifications/telegram', {
      botToken: TOKEN,
      dailySummaryHour: 0,
    }).expect(200);
    await post(s.owner, '/notifications/subscribers', {
      name: 'Egasi',
      chatId: '777',
      events: [
        'summary.daily',
        'incident',
        'shift.closed',
        'order.online',
        'stock.low',
      ],
    }).expect(201);
    await put(s.owner, '/notifications/templates/summary.daily', {
      body: 'Kun {{date}}: {{orders}} ta buyurtma, {{revenue}}',
    }).expect(200);

    await runDailySummaries(services, s.tenantId);
    await runDailySummaries(services, s.tenantId);
    const jobs = await ctx.db.notificationJob.findMany({
      where: { tenantId: s.tenantId, event: 'summary.daily' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.text).toMatch(
      /^Kun \d{4}-\d{2}-\d{2}: 0 ta buyurtma, 0 so‘m$/,
    );

    // A high-severity incident report triggers an alert.
    await post(s.owner, '/operations/incidents', {
      type: 'INJURY',
      severity: 'CRITICAL',
      title: 'Kuyish jarohati',
      description: 'Oshpaz qo‘lini kuydirdi',
    }).expect(201);
    expect(
      await ctx.db.notificationJob.count({
        where: { tenantId: s.tenantId, event: 'incident' },
      }),
    ).toBe(1);

    // Templates reset to default on empty body.
    await put(s.owner, '/notifications/templates/summary.daily', {
      body: '',
    }).expect(200);
    const templates = await s.owner
      .get('/api/notifications/templates')
      .expect(200);
    expect(
      templates.body.templates.find(
        (row: { event: string }) => row.event === 'summary.daily',
      ).isDefault,
    ).toBe(true);
  });
});
