import { randomBytes } from 'node:crypto';
import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import { sha256 } from '../../lib/crypto.js';

/**
 * «Telegram’da ulash»: a recipient is linked by opening the restaurant bot with a
 * deep link (t.me/<bot>?start=<token>) and pressing Telegram's «Start». The token is
 * random, single-use and valid for 15 minutes; only its hash is stored, and it is
 * looked up within the bot's own restaurant, so a token can never link a chat to
 * another business or another recipient.
 */
export const LINK_TTL_MS = 15 * 60_000;

export type LinkState = 'LINKED' | 'PENDING' | 'EXPIRED' | 'NOT_LINKED';

export function linkState(
  subscriber: {
    chatId: string | null;
    linkTokenHash: string | null;
    linkExpiresAt: Date | null;
    linkCode: string | null;
  },
  now: Date,
): LinkState {
  if (subscriber.chatId) return 'LINKED';
  if (subscriber.linkTokenHash && subscriber.linkExpiresAt) {
    return subscriber.linkExpiresAt > now ? 'PENDING' : 'EXPIRED';
  }
  // An older permanent code (made before deep links) still works.
  if (subscriber.linkCode) return 'PENDING';
  return subscriber.linkExpiresAt ? 'EXPIRED' : 'NOT_LINKED';
}

/** A new pairing token for the recipient (the previous one stops working). */
export async function createLinkToken(db: Db, subscriberId: string, now: Date) {
  const token = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await db.notificationSubscriber.update({
    where: { id: subscriberId },
    data: {
      linkTokenHash: sha256(token),
      linkExpiresAt: expiresAt,
      linkCode: null,
    },
  });
  return { token, expiresAt };
}

const START = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{6,64})\s*$/;

/** Is this a «/start <code>» message (linking), as opposed to ordering? */
export const isLinkStart = (text: string | undefined) =>
  !!text && START.test(text.trim());

/**
 * Links the chat if the message carries a valid code of this restaurant. Returns the
 * Uzbek reply for the chat, or null when the message is not a linking attempt.
 */
export async function handleLinkStart(
  services: Services,
  tenantId: string,
  chatId: string,
  text: string,
): Promise<string | null> {
  const code = START.exec(text.trim())?.[1];
  if (!code) return null;
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const linked = async (id: string, name: string, where: object) => {
    try {
      const result = await db.notificationSubscriber.updateMany({
        where: { id, tenantId, ...where },
        data: {
          chatId,
          linkTokenHash: null,
          linkCode: null,
          linkedAt: now,
        },
      });
      if (result.count === 0)
        return 'Bu ulash kodi allaqachon ishlatilgan. FastFood’da «Telegram’da ulash» tugmasini qayta bosing.';
      return `✅ Ulandi! «${name}» uchun Fast Food xabarlari shu chatga keladi.`;
    } catch {
      // (tenantId, chatId) is unique: this chat already receives for someone else.
      return 'Bu Telegram chat allaqachon boshqa qabul qiluvchiga ulangan.';
    }
  };
  // Older permanent codes (uppercase) keep working.
  if (/^[A-Z0-9]{6,12}$/i.test(code)) {
    const legacy = await db.notificationSubscriber.findFirst({
      where: { tenantId, linkCode: code.toUpperCase() },
    });
    if (legacy)
      return linked(legacy.id, legacy.name, { linkCode: code.toUpperCase() });
  }
  const hash = sha256(code);
  const subscriber = await db.notificationSubscriber.findFirst({
    where: { tenantId, linkTokenHash: hash },
  });
  if (!subscriber)
    return 'Ulash kodi noto‘g‘ri yoki allaqachon ishlatilgan. FastFood’da «Telegram’da ulash» tugmasini qayta bosing.';
  if (!subscriber.linkExpiresAt || subscriber.linkExpiresAt <= now) {
    // Single use: an expired code is spent too (the screen shows «eskirgan»).
    await db.notificationSubscriber.updateMany({
      where: { id: subscriber.id, linkTokenHash: hash },
      data: { linkTokenHash: null },
    });
    return 'Ulash kodi eskirgan. FastFood’da «Telegram’da ulash» tugmasini qayta bosib, yangi kod oling.';
  }
  return linked(subscriber.id, subscriber.name, {
    linkTokenHash: hash,
    linkExpiresAt: { gt: now },
  });
}
