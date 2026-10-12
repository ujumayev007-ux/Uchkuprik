import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';

export const webhookEvents = [
  'order.completed',
  'order.cancelled',
  'order.online_created',
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

/** Signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export function signPayload(secret: string, body: string, timestamp: number) {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Queues the event for every active endpoint subscribed to it (same transaction). */
export async function emitWebhook(
  tx: Tx | Db,
  tenantId: string,
  event: WebhookEvent,
  data: Prisma.InputJsonObject,
) {
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { tenantId, isActive: true, events: { has: event } },
    select: { id: true },
  });
  if (endpoints.length === 0) return 0;
  await tx.webhookDelivery.createMany({
    data: endpoints.map((endpoint) => ({
      tenantId,
      endpointId: endpoint.id,
      event,
      payload: { event, data } as Prisma.InputJsonObject,
    })),
  });
  return endpoints.length;
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:')
  );
}

/**
 * Rejects URLs that are not public HTTPS endpoints. Resolution happens at every
 * delivery so a DNS change cannot redirect deliveries into the private network.
 */
export async function assertPublicUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Webhook URL must be public HTTPS');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress))
    throw new Error('Webhook URL resolves to a private address');
}

export type WebhookSender = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<number>;

export const httpWebhookSender: WebhookSender = async (url, headers, body) => {
  await assertPublicUrl(url);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
};

const MAX_ATTEMPTS = 8;

export async function processWebhookDeliveries(services: Services, limit = 20) {
  const { db } = services;
  const send = services.webhookSender ?? httpWebhookSender;
  const now = services.now?.() ?? new Date();
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_deliveries
      WHERE status = 'PENDING' AND "nextTryAt" <= ${now}
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx.webhookDelivery.updateMany({
      where: { id: { in: ids } },
      data: { nextTryAt: new Date(now.getTime() + 60_000) },
    });
    return tx.webhookDelivery.findMany({
      where: { id: { in: ids } },
      include: { endpoint: true },
    });
  });
  let sent = 0;
  for (const delivery of claimed) {
    const body = JSON.stringify({
      id: delivery.id,
      createdAt: delivery.createdAt,
      ...(delivery.payload as object),
    });
    let status: number | null = null;
    let error: string | null = null;
    try {
      if (!delivery.endpoint.isActive) throw new Error('Endpoint disabled');
      status = await send(
        delivery.endpoint.url,
        {
          'Content-Type': 'application/json',
          'User-Agent': 'FastFood-Webhooks/1',
          'X-Fastfood-Event': delivery.event,
          'X-Fastfood-Delivery': delivery.id,
          'X-Fastfood-Signature': signPayload(
            services.secrets.decrypt(delivery.endpoint.secretEnc),
            body,
            Math.floor(Date.now() / 1000),
          ),
        },
        body,
      );
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (caught) {
      error =
        caught instanceof Error && /private|HTTPS|disabled/.test(caught.message)
          ? caught.message
          : 'Network error';
    }
    const attempts = delivery.attempts + 1;
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: error
        ? {
            attempts,
            responseStatus: status,
            lastError: error,
            status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
            nextTryAt: new Date(Date.now() + 15_000 * 2 ** (attempts - 1)),
          }
        : {
            attempts,
            responseStatus: status,
            lastError: null,
            status: 'SENT',
            sentAt: new Date(),
          },
    });
    if (!error) sent++;
  }
  return { claimed: claimed.length, sent };
}

export function startWebhookWorker(services: Services) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processWebhookDeliveries(services)
      .catch(() => services.logger.error('Webhook worker iteration failed'))
      .finally(() => {
        running = false;
      });
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
