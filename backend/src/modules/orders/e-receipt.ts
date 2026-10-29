import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db.js';
import { randomToken, type SecretBox } from '../../lib/crypto.js';

/**
 * Elektron chek access. A staff-taken order's receipt (items, amounts, payments) opens
 * only with its 6-digit code: the QR / Telegram link carries it after '#' (never sent
 * to the server in the address, never in logs), so a forwarded bare link shows only
 * the order status. Codes are kept encrypted, valid for 90 days, and five wrong codes
 * lock the receipt for 15 minutes. Online orders keep their token-only tracking page.
 */
export const RECEIPT_DAYS = 90;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

const staffTaken = (channel: string) =>
  channel === 'POS' || channel === 'WAITER';

/** The order's link and code (made once; issuing again extends the validity). */
export async function issueReceiptAccess(
  db: Db,
  secrets: SecretBox,
  orderId: string,
  now: Date,
) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const token = order.trackingToken ?? randomToken(18);
  const protect = staffTaken(order.channel);
  const code = protect
    ? order.receiptCodeEnc
      ? secrets.decrypt(order.receiptCodeEnc)
      : String(randomInt(0, 1_000_000)).padStart(6, '0')
    : null;
  await db.order.update({
    where: { id: order.id },
    data: {
      ...(order.trackingToken ? {} : { trackingToken: token }),
      ...(code && !order.receiptCodeEnc
        ? { receiptCodeEnc: secrets.encrypt(code) }
        : {}),
      ...(protect
        ? {
            receiptExpiresAt: new Date(
              now.getTime() + RECEIPT_DAYS * 86_400_000,
            ),
          }
        : {}),
    },
  });
  return {
    token,
    code,
    // The code rides in the fragment: browsers never send it to the server.
    path: `/buyurtma/${token}${code ? `#k=${code}` : ''}`,
  };
}

export type ReceiptAccess =
  'OPEN' | 'GRANTED' | 'LOCKED' | 'EXPIRED' | 'CODE_NEEDED' | 'WRONG';

/** Whether this request may see the receipt details; counts wrong codes. */
export async function checkReceiptAccess(
  db: Db,
  secrets: SecretBox,
  order: {
    id: string;
    receiptCodeEnc: string | null;
    receiptExpiresAt: Date | null;
    receiptCodeFails: number;
    receiptLockedUntil: Date | null;
  },
  code: string | undefined,
  now: Date,
): Promise<ReceiptAccess> {
  if (!order.receiptCodeEnc) return 'OPEN';
  if (order.receiptExpiresAt && order.receiptExpiresAt < now) return 'EXPIRED';
  if (order.receiptLockedUntil && order.receiptLockedUntil > now)
    return 'LOCKED';
  if (!code) return 'CODE_NEEDED';
  const expected = Buffer.from(secrets.decrypt(order.receiptCodeEnc));
  const given = Buffer.from(code.padEnd(expected.length, ' ').slice(0, 12));
  const ok =
    given.length === expected.length && timingSafeEqual(given, expected);
  if (ok) {
    if (order.receiptCodeFails > 0)
      await db.order.update({
        where: { id: order.id },
        data: { receiptCodeFails: 0, receiptLockedUntil: null },
      });
    return 'GRANTED';
  }
  const fails = order.receiptCodeFails + 1;
  await db.order.update({
    where: { id: order.id },
    data:
      fails >= MAX_FAILS
        ? {
            receiptCodeFails: 0,
            receiptLockedUntil: new Date(now.getTime() + LOCK_MS),
          }
        : { receiptCodeFails: fails },
  });
  return fails >= MAX_FAILS ? 'LOCKED' : 'WRONG';
}
