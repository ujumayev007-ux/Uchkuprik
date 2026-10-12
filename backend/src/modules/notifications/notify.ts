import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';

/** Events a subscriber can receive. Keys are stable; labels live in the UI catalog. */
export const notificationEvents = [
  'order.online',
  'incident',
  'shift.closed',
  'stock.low',
  'summary.daily',
] as const;
export type NotificationEvent = (typeof notificationEvents)[number] | 'test';

// Default Uzbek templates; {{name}} placeholders are replaced with plain values.
export const defaultTemplates: Record<NotificationEvent, string> = {
  'order.online':
    '🛎 Yangi onlayn buyurtma #{{number}}\nFilial: {{branch}}\nSumma: {{total}}\nTasdiqlashni kutmoqda.',
  incident:
    '⚠️ Hodisa ({{severity}}): {{title}}\nFilial: {{branch}}\n{{description}}',
  'shift.closed':
    '🧾 Smena yopildi\nFilial: {{branch}}\nKassir: {{cashier}}\nKutilgan naqd: {{expected}}\nSanalgan: {{counted}}\nFarq: {{difference}}',
  'stock.low':
    '📦 Kam qoldiq: {{item}}\nOmbor: {{warehouse}}\nQoldiq: {{quantity}} (minimal {{minimum}})',
  'summary.daily':
    '📊 Kunlik hisobot {{date}}\nBuyurtmalar: {{orders}}\nTushum: {{revenue}}\nBekor qilingan: {{cancelled}}\n{{branches}}',
  test: '✅ Fast Food bildirishnomalari ulandi.',
};

export function render(
  template: string,
  vars: Record<string, string | number>,
) {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
      vars[key] === undefined ? '' : String(vars[key]),
    )
    .slice(0, 4000);
}

export const money = (amount: number) =>
  `${Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

/**
 * Queues a notification for every linked subscriber of the event (and branch).
 * Runs inside the caller's transaction so messages exist only if the change commits.
 */
export async function notify(
  tx: Tx | Db,
  tenantId: string,
  event: NotificationEvent,
  vars: Record<string, string | number>,
  branchId: string | null = null,
  // Restricts delivery to these subscribers (e.g. a confirmation after linking).
  onlySubscriberIds?: string[],
) {
  const config = await tx.telegramConfig.findUnique({ where: { tenantId } });
  if (!config?.isActive) return 0;
  const subscribers = await tx.notificationSubscriber.findMany({
    where: {
      tenantId,
      isActive: true,
      chatId: { not: null },
      ...(event === 'test' ? {} : { events: { has: event } }),
      ...(onlySubscriberIds ? { id: { in: onlySubscriberIds } } : {}),
    },
  });
  const targets = subscribers.filter(
    (subscriber) =>
      !branchId ||
      subscriber.branchIds.length === 0 ||
      subscriber.branchIds.includes(branchId),
  );
  if (targets.length === 0) return 0;
  const override = await tx.notificationTemplate.findUnique({
    where: { tenantId_event: { tenantId, event } },
  });
  const text = render(override?.body ?? defaultTemplates[event], vars);
  await tx.notificationJob.createMany({
    data: targets.map((subscriber) => ({
      tenantId,
      subscriberId: subscriber.id,
      event,
      text,
    })),
  });
  return targets.length;
}

export type TelegramTransport = {
  send(token: string, chatId: string, text: string): Promise<void>;
  getMe(token: string): Promise<{ username: string }>;
  setWebhook(token: string, url: string, secret: string): Promise<void>;
};

class TelegramError extends Error {}

/** Real Telegram Bot API client. Error messages never include the token. */
export const telegramTransport: TelegramTransport = {
  async send(token, chatId, text) {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  },
  async getMe(token) {
    const result = (await call(token, 'getMe', {})) as { username?: string };
    return { username: result.username ?? '' };
  },
  async setWebhook(token, url, secret) {
    await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message'],
    });
  },
};

async function call(token: string, method: string, body: object) {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TelegramError('Telegram network error');
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error_code?: number;
  } | null;
  if (!response.ok || !payload?.ok)
    throw new TelegramError(
      `Telegram error ${payload?.error_code ?? response.status}`,
    );
  return payload.result;
}

const MAX_ATTEMPTS = 6;

/** Delivers due notifications (SKIP LOCKED, exponential backoff, FAILED after 6 tries). */
export async function processNotificationJobs(services: Services, limit = 20) {
  const { db } = services;
  const transport = services.telegram ?? telegramTransport;
  const now = services.now?.() ?? new Date();
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM notification_jobs
      WHERE status = 'PENDING' AND "nextTryAt" <= ${now}
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx.notificationJob.updateMany({
      where: { id: { in: ids } },
      data: { nextTryAt: new Date(now.getTime() + 60_000) },
    });
    return tx.notificationJob.findMany({ where: { id: { in: ids } } });
  });
  let sent = 0;
  for (const job of claimed) {
    try {
      const [config, subscriber] = await Promise.all([
        db.telegramConfig.findUnique({ where: { tenantId: job.tenantId } }),
        db.notificationSubscriber.findUnique({
          where: { id: job.subscriberId },
        }),
      ]);
      if (!config?.isActive) throw new TelegramError('Telegram disabled');
      if (!subscriber?.chatId || !subscriber.isActive)
        throw new TelegramError('Subscriber not linked');
      await transport.send(
        services.secrets.decrypt(config.botTokenEnc),
        subscriber.chatId,
        job.text,
      );
      await db.notificationJob.update({
        where: { id: job.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      sent++;
    } catch (error) {
      const attempts = job.attempts + 1;
      await db.notificationJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError:
            error instanceof TelegramError ? error.message : 'Delivery failed',
          status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          nextTryAt: new Date(Date.now() + 10_000 * 2 ** (attempts - 1)),
        },
      });
    }
  }
  return { claimed: claimed.length, sent };
}

const TASHKENT_OFFSET_MS = 5 * 60 * 60_000;

/** Sends the daily summary once per local day after the configured hour. */
export async function runDailySummaries(services: Services, tenantId?: string) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const hour = local.getUTCHours();
  const today = new Date(`${local.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const configs = await db.telegramConfig.findMany({
    where: {
      isActive: true,
      dailySummaryHour: { not: null, lte: hour },
      OR: [{ lastDailySummary: null }, { lastDailySummary: { lt: today } }],
      ...(tenantId ? { tenantId } : {}),
    },
  });
  for (const config of configs) {
    await db.$transaction(async (tx) => {
      // Claim the day first so concurrent workers never send twice.
      const claimed = await tx.telegramConfig.updateMany({
        where: {
          tenantId: config.tenantId,
          OR: [{ lastDailySummary: null }, { lastDailySummary: { lt: today } }],
        },
        data: { lastDailySummary: today },
      });
      if (claimed.count === 0) return;
      const [branches, completed, cancelled] = await Promise.all([
        tx.branch.findMany({
          where: { tenantId: config.tenantId, deletedAt: null },
          select: { id: true, name: true },
        }),
        tx.order.groupBy({
          by: ['branchId'],
          where: {
            tenantId: config.tenantId,
            status: 'COMPLETED',
            businessDate: today,
          },
          _sum: { total: true },
          _count: true,
        }),
        tx.order.count({
          where: {
            tenantId: config.tenantId,
            status: 'CANCELLED',
            businessDate: today,
          },
        }),
      ]);
      const revenue = completed.reduce(
        (sum, row) => sum + (row._sum.total ?? 0),
        0,
      );
      const orders = completed.reduce((sum, row) => sum + row._count, 0);
      const lines = completed
        .map((row) => {
          const name = branches.find(
            (branch) => branch.id === row.branchId,
          )?.name;
          return `• ${name}: ${money(row._sum.total ?? 0)} (${row._count})`;
        })
        .join('\n');
      await notify(tx, config.tenantId, 'summary.daily', {
        date: today.toISOString().slice(0, 10),
        orders,
        revenue: money(revenue),
        cancelled,
        branches: lines,
      });
    });
  }
  return { tenants: configs.length };
}

export function startNotificationWorker(services: Services) {
  let running = false;
  const deliver = setInterval(() => {
    if (running) return;
    running = true;
    processNotificationJobs(services)
      .catch(() =>
        services.logger.error('Notification worker iteration failed'),
      )
      .finally(() => {
        running = false;
      });
  }, 5000);
  deliver.unref();
  const summaries = setInterval(
    () =>
      void runDailySummaries(services).catch(() =>
        services.logger.error('Daily summary run failed'),
      ),
    5 * 60_000,
  );
  summaries.unref();
  return () => {
    clearInterval(deliver);
    clearInterval(summaries);
  };
}
