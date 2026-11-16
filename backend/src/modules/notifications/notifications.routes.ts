import { handleTelegramUpdate } from '../telegram/bot.js';
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import {
  defaultTemplates,
  notificationEvents,
  notify,
  telegramTransport,
} from './notify.js';
import {
  createLinkToken,
  handleLinkStart,
  isLinkStart,
  linkState,
} from './linking.js';

const eventSchema = z.enum(notificationEvents);
const chatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/);

export function notificationsRouter(services: Services, appOrigin: string) {
  const { db } = services;
  const router = Router();
  const transport = services.telegram ?? telegramTransport;
  const manage = [requireAuth(), requirePermission('notifications.manage')];
  const now = () => services.now?.() ?? new Date();
  const ourWebhook = (tenantId: string) =>
    `${appOrigin}/api/webhooks/telegram/${tenantId}`;

  /**
   * Is a webhook of ANOTHER server set on this bot? It is never replaced or removed
   * silently: the screen explains it and the manual chat ID keeps working.
   */
  const foreignWebhook = async (token: string, tenantId: string) => {
    if (!transport.api) return false;
    const info = (await transport
      .api(token, 'getWebhookInfo', {})
      .catch(() => null)) as { url?: string } | null;
    return !!info?.url && info.url !== ourWebhook(tenantId);
  };

  router.get('/notifications/settings', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const config = await db.telegramConfig.findUnique({
      where: { tenantId: auth.tenantId },
    });
    res.json({
      configured: !!config,
      botUsername: config?.botUsername ?? null,
      isActive: config?.isActive ?? false,
      dailySummaryHour: config?.dailySummaryHour ?? null,
      dailySummaryMinute: config?.dailySummaryMinute ?? 0,
      ordersEnabled: config?.ordersEnabled ?? false,
      receiptsEnabled: config?.receiptsEnabled ?? false,
      orderBranchId: config?.orderBranchId ?? null,
      webhookUrl: ourWebhook(auth.tenantId),
      // How this server reads the bot: its HTTPS webhook, or by asking Telegram
      // (local Kassa); CONFLICT = another server's webhook is set on the bot.
      receiver: appOrigin.startsWith('https://')
        ? 'WEBHOOK'
        : config?.webhookConflict
          ? 'CONFLICT'
          : 'POLLING',
      events: notificationEvents,
    });
  });

  // The token is write-only: validated against Telegram, encrypted, never returned.
  router.put(
    '/notifications/telegram',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z.object({
          botToken: z
            .string()
            .trim()
            .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/)
            .optional(),
          isActive: z.boolean().default(true),
          dailySummaryHour: z
            .number()
            .int()
            .min(0)
            .max(23)
            .nullable()
            .default(22),
          dailySummaryMinute: z.number().int().min(0).max(59).default(0),
          // Customers order through the bot (Telegram buyurtmalar).
          ordersEnabled: z.boolean().default(false),
          // Elektron chek sent by the bot once an order is paid.
          receiptsEnabled: z.boolean().default(false),
          orderBranchId: z.uuid().nullable().default(null),
        }),
        req.body,
      );
      if (input.orderBranchId) {
        const branch = await db.branch.findFirst({
          where: { id: input.orderBranchId, tenantId: auth.tenantId },
        });
        if (!branch) throw errors.validation([{ path: 'orderBranchId' }]);
      }
      const existing = await db.telegramConfig.findUnique({
        where: { tenantId: auth.tenantId },
      });
      if (!existing && !input.botToken)
        throw errors.validation([{ path: 'botToken' }]);
      let botUsername = existing?.botUsername ?? null;
      let secret: string | null = null;
      if (input.botToken) {
        try {
          botUsername = (await transport.getMe(input.botToken)).username;
        } catch {
          throw new AppError(
            400,
            'TELEGRAM_TOKEN_INVALID',
            'telegramTokenInvalid',
          );
        }
        secret = randomToken();
      }
      // Another server's webhook on this bot is kept as it is (never replaced or
      // removed here); the screen says so and the manual chat ID still works.
      const token =
        input.botToken ??
        (existing ? services.secrets.decrypt(existing.botTokenEnc) : null);
      const conflict = token
        ? await foreignWebhook(token, auth.tenantId)
        : false;
      // Webhook linking needs a public HTTPS address; a local Kassa reads the bot itself.
      if (input.botToken && appOrigin.startsWith('https://') && !conflict)
        await transport
          .setWebhook(input.botToken, ourWebhook(auth.tenantId), secret!)
          .catch(() => undefined);
      // Bot ordering needs callback updates: re-register the webhook with a new secret.
      if (
        !input.botToken &&
        existing &&
        (input.ordersEnabled || input.receiptsEnabled) &&
        appOrigin.startsWith('https://') &&
        !conflict
      ) {
        secret = randomToken();
        await transport
          .setWebhook(
            services.secrets.decrypt(existing.botTokenEnc),
            ourWebhook(auth.tenantId),
            secret,
          )
          .catch(() => undefined);
      }
      await db.$transaction(async (tx) => {
        const data = {
          isActive: input.isActive,
          dailySummaryHour: input.dailySummaryHour,
          dailySummaryMinute: input.dailySummaryMinute,
          webhookConflict: conflict,
          ordersEnabled: input.ordersEnabled,
          receiptsEnabled: input.receiptsEnabled,
          orderBranchId: input.orderBranchId,
          botUsername,
          ...(secret && !input.botToken
            ? { webhookSecretHash: sha256(secret) }
            : {}),
          ...(input.botToken
            ? {
                botTokenEnc: services.secrets.encrypt(input.botToken),
                webhookSecretHash: sha256(secret!),
              }
            : {}),
        };
        await tx.telegramConfig.upsert({
          where: { tenantId: auth.tenantId },
          update: data,
          create: {
            tenantId: auth.tenantId,
            botTokenEnc: services.secrets.encrypt(input.botToken!),
            webhookSecretHash: sha256(secret!),
            isActive: input.isActive,
            dailySummaryHour: input.dailySummaryHour,
            dailySummaryMinute: input.dailySummaryMinute,
            webhookConflict: conflict,
            ordersEnabled: input.ordersEnabled,
            receiptsEnabled: input.receiptsEnabled,
            orderBranchId: input.orderBranchId,
            botUsername,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'notifications.telegram.update',
          entityType: 'telegram_config',
          data: {
            tokenChanged: !!input.botToken,
            isActive: input.isActive,
            ordersEnabled: input.ordersEnabled,
            receiptsEnabled: input.receiptsEnabled,
          },
        });
      });
      res.json({ ok: true, botUsername, webhookConflict: conflict });
    },
  );

  // ------------------------------------------------------------ subscribers

  router.get('/notifications/subscribers', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const at = now();
    const subscribers = await db.notificationSubscriber.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    // Pairing tokens and codes never leave the server; the state does.
    res.json({
      subscribers: subscribers.map(
        ({ linkTokenHash: _hash, linkCode: _code, chatId, ...rest }) => ({
          ...rest,
          linked: !!chatId,
          // The chat number is shown masked (the manual fallback field shows it).
          chatId: chatId ? `…${chatId.slice(-4)}` : null,
          state: linkState(
            {
              chatId,
              linkTokenHash: _hash,
              linkExpiresAt: rest.linkExpiresAt,
              linkCode: _code,
            },
            at,
          ),
        }),
      ),
    });
  });

  // «Telegram’da ulash»: a single-use deep link (and the same as a QR code on screen).
  router.post(
    '/notifications/subscribers/:id/link',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const subscriber = await db.notificationSubscriber.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!subscriber) throw errors.notFound();
      const config = await db.telegramConfig.findUnique({
        where: { tenantId: auth.tenantId },
      });
      if (!config?.isActive || !config.botUsername)
        throw new AppError(409, 'TELEGRAM_NOT_CONFIGURED', 'conflict');
      const { token, expiresAt } = await createLinkToken(db, id, now());
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'notifications.link.start',
        entityType: 'notification_subscriber',
        entityId: id,
      });
      res.json({
        url: `https://t.me/${config.botUsername}?start=${token}`,
        expiresAt,
        botUsername: config.botUsername,
        // A local server without HTTPS reads the bot itself; a webhook set elsewhere
        // blocks that (it is never removed by this server).
        receiver: appOrigin.startsWith('https://')
          ? 'WEBHOOK'
          : config.webhookConflict
            ? 'CONFLICT'
            : 'POLLING',
      });
    },
  );

  // «Sinov xabari» for one recipient; the screen follows the message's delivery.
  router.post(
    '/notifications/subscribers/:id/test',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { requestId } = parse(
        z.object({ requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }),
        req.body,
      );
      const subscriber = await db.notificationSubscriber.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!subscriber) throw errors.notFound();
      if (!subscriber.chatId) throw new AppError(409, 'NOT_LINKED', 'conflict');
      const dedupeKey = `test:${requestId}`;
      await notify(db, auth.tenantId, 'test', {}, null, [id], { dedupeKey });
      const job = await db.notificationJob.findFirst({
        where: { subscriberId: id, dedupeKey },
      });
      // Bot switched off or recipient paused: nothing was queued.
      if (!job) throw new AppError(409, 'NOT_QUEUED', 'conflict');
      res.json({ jobId: job.id });
    },
  );

  // One message's delivery: «Navbatda», «Telegram qabul qildi» or «Yuborilmadi».
  router.get('/notifications/jobs/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const job = await db.notificationJob.findFirst({
      where: { id, tenantId: auth.tenantId },
      select: {
        id: true,
        status: true,
        attempts: true,
        lastError: true,
        sentAt: true,
        createdAt: true,
      },
    });
    if (!job) throw errors.notFound();
    res.json(job);
  });

  const subscriberInput = z.object({
    name: z.string().trim().min(2).max(80),
    chatId: chatIdSchema.nullable().optional(),
    events: z.array(eventSchema).max(notificationEvents.length),
    branchIds: z.array(z.uuid()).max(200).default([]),
    isActive: z.boolean().default(true),
    // Money amounts and employee names (left out: unchanged).
    financial: z.boolean().optional(),
    staff: z.boolean().optional(),
  });

  async function assertBranches(tenantId: string, branchIds: string[]) {
    if (branchIds.length === 0) return;
    const count = await db.branch.count({
      where: { tenantId, id: { in: branchIds } },
    });
    if (count !== new Set(branchIds).size)
      throw errors.validation([{ path: 'branchIds' }]);
  }

  router.post('/notifications/subscribers', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(subscriberInput, req.body);
    await assertBranches(auth.tenantId, input.branchIds);
    try {
      const subscriber = await db.notificationSubscriber.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          chatId: input.chatId ?? null,
          linkedAt: input.chatId ? new Date() : null,
          events: [...new Set(input.events)],
          branchIds: [...new Set(input.branchIds)],
          isActive: input.isActive,
          ...(input.financial !== undefined
            ? { financial: input.financial }
            : {}),
          ...(input.staff !== undefined ? { staff: input.staff } : {}),
        },
      });
      res.status(201).json({ id: subscriber.id });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw errors.conflict();
      throw error;
    }
  });

  router.put('/notifications/subscribers/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(subscriberInput, req.body);
    await assertBranches(auth.tenantId, input.branchIds);
    const found = await db.notificationSubscriber.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!found) throw errors.notFound();
    try {
      await db.notificationSubscriber.update({
        where: { id },
        data: {
          name: input.name,
          events: [...new Set(input.events)],
          branchIds: [...new Set(input.branchIds)],
          // «Barcha xabarlarni vaqtincha to‘xtatish»: events and branches are kept.
          isActive: input.isActive,
          ...(input.financial !== undefined
            ? { financial: input.financial }
            : {}),
          ...(input.staff !== undefined ? { staff: input.staff } : {}),
          ...(input.chatId && input.chatId !== found.chatId
            ? {
                chatId: input.chatId,
                linkCode: null,
                linkTokenHash: null,
                linkedAt: new Date(),
              }
            : {}),
        },
      });
      res.json({ ok: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw errors.conflict();
      throw error;
    }
  });

  router.post('/notifications/test', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const queued = await notify(db, auth.tenantId, 'test', {});
    res.json({ queued });
  });

  // -------------------------------------------------------------- templates

  router.get('/notifications/templates', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const overrides = await db.notificationTemplate.findMany({
      where: { tenantId: auth.tenantId },
    });
    res.json({
      templates: notificationEvents.map((event) => ({
        event,
        body:
          overrides.find((row) => row.event === event)?.body ??
          defaultTemplates[event],
        isDefault: !overrides.some((row) => row.event === event),
        defaultBody: defaultTemplates[event],
      })),
    });
  });

  router.put('/notifications/templates/:event', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const event = parse(eventSchema, req.params.event);
    const { body } = parse(
      z.object({ body: z.string().trim().max(3000) }),
      req.body,
    );
    // An empty body restores the default template.
    if (!body)
      await db.notificationTemplate.deleteMany({
        where: { tenantId: auth.tenantId, event },
      });
    else
      await db.notificationTemplate.upsert({
        where: { tenantId_event: { tenantId: auth.tenantId, event } },
        update: { body },
        create: { tenantId: auth.tenantId, event, body },
      });
    res.json({ ok: true });
  });

  // ------------------------------------------------------ delivery monitoring

  router.get('/notifications/jobs', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { status } = parse(
      z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional() }),
      req.query,
    );
    const [jobs, counts] = await Promise.all([
      db.notificationJob.findMany({
        where: { tenantId: auth.tenantId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      db.notificationJob.groupBy({
        by: ['status'],
        where: { tenantId: auth.tenantId },
        _count: true,
      }),
    ]);
    const names = new Map(
      (
        await db.notificationSubscriber.findMany({
          where: {
            tenantId: auth.tenantId,
            id: { in: [...new Set(jobs.map((job) => job.subscriberId))] },
          },
          select: { id: true, name: true },
        })
      ).map((row) => [row.id, row.name]),
    );
    res.json({
      jobs: jobs.map((job) => ({
        ...job,
        recipient: names.get(job.subscriberId) ?? null,
      })),
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count])),
    });
  });

  router.post('/notifications/jobs/:id/retry', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.notificationJob.updateMany({
      where: { id, tenantId: auth.tenantId, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextTryAt: new Date() },
    });
    if (result.count === 0) throw errors.conflict();
    res.json({ ok: true });
  });

  // -------------------------------------------------- Telegram webhook (public)

  router.post('/webhooks/telegram/:tenantId', async (req, res) => {
    const tenantId = z.uuid().safeParse(req.params.tenantId);
    const header = req.get('x-telegram-bot-api-secret-token') ?? '';
    const config = tenantId.success
      ? await db.telegramConfig.findUnique({
          where: { tenantId: tenantId.data },
        })
      : null;
    const expected = Buffer.from(config?.webhookSecretHash ?? '0'.repeat(64));
    const actual = Buffer.from(sha256(header));
    if (
      !config ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      res.status(401).json({ ok: false });
      return;
    }
    const update = z
      .object({
        message: z
          .object({
            text: z.string().max(200).optional(),
            chat: z.object({ id: z.union([z.number(), z.string()]) }),
          })
          .optional(),
      })
      .safeParse(req.body);
    const message = update.success ? update.data.message : undefined;
    if (message && isLinkStart(message.text)) {
      // «Start» pressed in the deep link: link this chat (single-use code).
      const chatId = String(message.chat.id);
      const reply = await handleLinkStart(
        services,
        config.tenantId,
        chatId,
        message.text!,
      );
      if (reply)
        await transport
          .send(services.secrets.decrypt(config.botTokenEnc), chatId, reply)
          .catch(() => services.logger.warn('Telegram link reply failed'));
    }
    // Everything else is the customer ordering conversation (when enabled).
    else if (config.ordersEnabled)
      await handleTelegramUpdate(services, config.tenantId, req.body).catch(
        () => services.logger.warn('Telegram update failed'),
      );
    // Telegram retries non-2xx responses, so acknowledge everything else.
    res.json({ ok: true });
  });

  return router;
}
