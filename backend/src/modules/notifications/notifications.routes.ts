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

const eventSchema = z.enum(notificationEvents);
const chatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/);

function linkCode() {
  // 10 characters from a token; easy to type after /start.
  return randomToken()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 10)
    .toUpperCase();
}

export function notificationsRouter(services: Services, appOrigin: string) {
  const { db } = services;
  const router = Router();
  const transport = services.telegram ?? telegramTransport;
  const manage = [requireAuth(), requirePermission('notifications.manage')];

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
      webhookUrl: `${appOrigin}/api/webhooks/telegram/${auth.tenantId}`,
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
        }),
        req.body,
      );
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
        // Webhook linking needs a public HTTPS address; otherwise chat ids are entered manually.
        if (appOrigin.startsWith('https://'))
          await transport
            .setWebhook(
              input.botToken,
              `${appOrigin}/api/webhooks/telegram/${auth.tenantId}`,
              secret,
            )
            .catch(() => undefined);
      }
      await db.$transaction(async (tx) => {
        const data = {
          isActive: input.isActive,
          dailySummaryHour: input.dailySummaryHour,
          botUsername,
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
            botUsername,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'notifications.telegram.update',
          entityType: 'telegram_config',
          data: { tokenChanged: !!input.botToken, isActive: input.isActive },
        });
      });
      res.json({ ok: true, botUsername });
    },
  );

  // ------------------------------------------------------------ subscribers

  router.get('/notifications/subscribers', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const subscribers = await db.notificationSubscriber.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ subscribers });
  });

  const subscriberInput = z.object({
    name: z.string().trim().min(2).max(80),
    chatId: chatIdSchema.nullable().optional(),
    events: z.array(eventSchema).max(notificationEvents.length),
    branchIds: z.array(z.uuid()).max(200).default([]),
    isActive: z.boolean().default(true),
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
          linkCode: input.chatId ? null : linkCode(),
          linkedAt: input.chatId ? new Date() : null,
          events: [...new Set(input.events)],
          branchIds: [...new Set(input.branchIds)],
          isActive: input.isActive,
        },
      });
      res
        .status(201)
        .json({ id: subscriber.id, linkCode: subscriber.linkCode });
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
          isActive: input.isActive,
          ...(input.chatId && input.chatId !== found.chatId
            ? { chatId: input.chatId, linkCode: null, linkedAt: new Date() }
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
    res.json({
      jobs,
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
    const code = message?.text
      ?.match(/^\/start\s+([A-Z0-9]{6,12})$/i)?.[1]
      ?.toUpperCase();
    if (message && code) {
      const chatId = String(message.chat.id);
      const subscriber = await db.notificationSubscriber.findFirst({
        where: { tenantId: config.tenantId, linkCode: code },
      });
      if (subscriber) {
        try {
          await db.notificationSubscriber.update({
            where: { id: subscriber.id },
            data: { chatId, linkCode: null, linkedAt: new Date() },
          });
          await notify(db, config.tenantId, 'test', {}, null, [subscriber.id]);
        } catch {
          // The chat is already linked to another subscriber; ignore.
        }
      }
    }
    // Telegram retries non-2xx responses, so acknowledge everything else.
    res.json({ ok: true });
  });

  return router;
}
