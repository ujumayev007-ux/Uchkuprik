import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';

/** Events a subscriber can receive. Keys are stable; labels live in the UI catalog. */
export const notificationEvents = [
  'shift.opened',
  'shift.closed',
  'attendance.in',
  'attendance.out',
  'stock.low',
  'stock.out',
  'summary.daily',
  // «Telegram’ga yuborish» on the report screen / a report file made successfully.
  'report',
  'report.auto',
  'order.online',
  'incident',
] as const;
export type NotificationEvent = (typeof notificationEvents)[number] | 'test';

// Events naming employees: only recipients allowed to see staff information.
export const staffEvents: readonly NotificationEvent[] = [
  'attendance.in',
  'attendance.out',
];

// Default Uzbek templates; {{name}} placeholders are replaced with plain values.
// {{time}} (date and time in Tashkent) is filled in for every message.
export const defaultTemplates: Record<NotificationEvent, string> = {
  'shift.opened':
    '🟢 Smena ochildi\nFilial: {{branch}}\nKassir: {{cashier}}\nBoshlang‘ich naqd: {{opening}}\n🕒 {{time}}',
  'shift.closed':
    '🧾 Smena yopildi\nFilial: {{branch}}\nKassir: {{cashier}}\nKutilgan naqd: {{expected}}\nSanalgan: {{counted}}\nFarq: {{difference}}\n🕒 {{time}}',
  'attendance.in':
    '👋 Xodim ishga keldi: {{employee}}\nFilial: {{branch}}\n🕒 {{time}}',
  'attendance.out':
    '🚪 Xodim ishdan ketdi: {{employee}}\nFilial: {{branch}}\nIshlagan vaqti: {{worked}}\n🕒 {{time}}',
  'stock.low':
    '📦 Tovar kam qoldi: {{item}}\nFilial: {{branch}} · Ombor: {{warehouse}}\nQoldiq: {{quantity}} (minimal {{minimum}})\n🕒 {{time}}',
  'stock.out':
    '⛔ Tovar tugadi: {{item}}\nFilial: {{branch}} · Ombor: {{warehouse}}\nQoldiq: {{quantity}}\n🕒 {{time}}',
  'summary.daily':
    '📊 Kunlik hisobot {{date}}\nBuyurtmalar: {{orders}}\nTushum: {{revenue}}\nBekor qilingan: {{cancelled}}\n{{branches}}\n🕒 {{time}}',
  report:
    '📊 Hisobot: {{period}}\nFilial: {{branch}}\nBuyurtmalar: {{orders}}\nSavdo: {{sales}}\nO‘rtacha chek: {{average}}\nTo‘lovlar: {{collected}}\nBekor qilingan: {{cancelled}}\n🕒 {{time}}',
  'report.auto':
    '📊 Tayyorlangan hisobot ({{format}}): {{period}}\nFilial: {{branch}}\nBuyurtmalar: {{orders}}\nSavdo: {{sales}}\n🕒 {{time}}',
  'order.online':
    '🛎 Yangi onlayn buyurtma #{{number}}\nFilial: {{branch}}\nSumma: {{total}}\nTasdiqlashni kutmoqda.\n🕒 {{time}}',
  incident:
    '⚠️ Hodisa ({{severity}}): {{title}}\nFilial: {{branch}}\n{{description}}\n🕒 {{time}}',
  test: '✅ Sinov xabari. Fast Food bildirishnomalari shu chatga keladi.\n🕒 {{time}}',
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

const TASHKENT_MS = 5 * 60 * 60_000;
/** «16.11.2026 14:05» in Tashkent time. */
export function localTime(date: Date) {
  const local = new Date(date.getTime() + TASHKENT_MS).toISOString();
  return `${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} ${local.slice(11, 16)}`;
}

export type NotifyOptions = {
  // The same event (a retried request) is queued once per recipient.
  dedupeKey?: string;
  // Money values: shown only to recipients allowed to see financial data.
  financialKeys?: string[];
  now?: Date;
};

/**
 * Queues a notification for every linked subscriber of the event (and branch).
 * Runs inside the caller's transaction so messages exist only if the change commits;
 * sending happens later in the background, so Telegram can never block a sale.
 * Returns the ids of the queued messages.
 */
export async function notify(
  tx: Tx | Db,
  tenantId: string,
  event: NotificationEvent,
  vars: Record<string, string | number>,
  branchId: string | null = null,
  // Restricts delivery to these subscribers (a test message, a confirmation).
  onlySubscriberIds?: string[],
  options: NotifyOptions = {},
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
      (!branchId ||
        subscriber.branchIds.length === 0 ||
        subscriber.branchIds.includes(branchId)) &&
      // Employee names only for recipients allowed to see staff information.
      (!staffEvents.includes(event) || subscriber.staff),
  );
  if (targets.length === 0) return 0;
  const override = await tx.notificationTemplate.findUnique({
    where: { tenantId_event: { tenantId, event } },
  });
  const template = override?.body ?? defaultTemplates[event];
  const base = { time: localTime(options.now ?? new Date()), ...vars };
  const hidden = Object.fromEntries(
    (options.financialKeys ?? []).map((key) => [key, '—']),
  );
  const result = await tx.notificationJob.createMany({
    data: targets.map((subscriber) => ({
      tenantId,
      subscriberId: subscriber.id,
      event,
      text: render(
        template,
        subscriber.financial ? base : { ...base, ...hidden },
      ),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    })),
    // A retried request finds its messages already queued.
    skipDuplicates: true,
  });
  return result.count;
}

export type TelegramTransport = {
  send(token: string, chatId: string, text: string): Promise<void>;
  getMe(token: string): Promise<{ username: string }>;
  setWebhook(token: string, url: string, secret: string): Promise<void>;
  // Generic Bot API call (bot ordering: keyboards, callbacks, polling).
  api?(token: string, method: string, body: object): Promise<unknown>;
};

/** Telegram errors carry a stable code for the screen (and never the token). */
export class TelegramError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = false,
  ) {
    super(code);
  }
}

/** Telegram's answer -> our code; permanent ones are not retried. */
function classify(status: number, description: string): TelegramError {
  const text = description.toLowerCase();
  if (status === 401 || status === 404)
    return new TelegramError('TG_TOKEN_INVALID', true);
  if (status === 403) return new TelegramError('TG_BLOCKED', true);
  if (status === 400 && text.includes('chat not found'))
    return new TelegramError('TG_CHAT_NOT_FOUND', true);
  if (status === 409) return new TelegramError('TG_WEBHOOK_CONFLICT');
  if (status === 429) return new TelegramError('TG_RATE_LIMIT');
  return new TelegramError(`TG_ERROR_${status}`);
}

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
  async api(token, method, body) {
    return call(token, method, body);
  },
  async setWebhook(token, url, secret) {
    await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
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
    throw new TelegramError('TG_NETWORK');
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error_code?: number;
    description?: string;
  } | null;
  if (!response.ok || !payload?.ok)
    throw classify(
      payload?.error_code ?? response.status,
      payload?.description ?? '',
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
    // In the order they happened (a chat must read «keldi» before «ketdi»).
    return tx.notificationJob.findMany({
      where: { id: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
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
      if (!config?.isActive) throw new TelegramError('TG_DISABLED', true);
      if (!subscriber?.chatId) throw new TelegramError('NOT_LINKED', true);
      if (!subscriber.isActive) throw new TelegramError('PAUSED', true);
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
      const known = error instanceof TelegramError ? error : null;
      await db.notificationJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: known?.code ?? 'TG_FAILED',
          // Blocked bot, unknown chat, bad token: retrying cannot help.
          status:
            known?.permanent || attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
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
    // The configured time is hour and minute («Kunlik hisobot» 22:30).
    if (
      config.dailySummaryHour === hour &&
      local.getUTCMinutes() < config.dailySummaryMinute
    )
      continue;
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
      const date = today.toISOString().slice(0, 10);
      const recipients = await tx.notificationSubscriber.findMany({
        where: {
          tenantId: config.tenantId,
          events: { has: 'summary.daily' },
        },
        select: { id: true, branchIds: true },
      });
      // Recipients of every branch: the whole restaurant.
      const everywhere = recipients
        .filter((r) => r.branchIds.length === 0)
        .map((r) => r.id);
      if (everywhere.length)
        await notify(
          tx,
          config.tenantId,
          'summary.daily',
          {
            date,
            orders,
            revenue: money(revenue),
            cancelled,
            branches: lines,
          },
          null,
          everywhere,
          {
            dedupeKey: `summary.daily:${date}`,
            financialKeys: ['revenue', 'branches'],
            now,
          },
        );
      // Recipients of chosen branches: only those branches' figures.
      for (const branch of branches) {
        const only = recipients
          .filter((r) => r.branchIds.includes(branch.id))
          .map((r) => r.id);
        if (only.length === 0) continue;
        const row = completed.find((c) => c.branchId === branch.id);
        const branchCancelled = await tx.order.count({
          where: {
            tenantId: config.tenantId,
            branchId: branch.id,
            status: 'CANCELLED',
            businessDate: today,
          },
        });
        await notify(
          tx,
          config.tenantId,
          'summary.daily',
          {
            date,
            orders: row?._count ?? 0,
            revenue: money(row?._sum.total ?? 0),
            cancelled: branchCancelled,
            branches: `Filial: ${branch.name}`,
          },
          branch.id,
          only,
          {
            dedupeKey: `summary.daily:${date}:${branch.id}`,
            financialKeys: ['revenue'],
            now,
          },
        );
      }
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
