import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Tx } from '../../db.js';
import type { OrderCodePurpose } from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';
import type { SecretBox } from '../../lib/crypto.js';

/**
 * One-time order verification codes (Telegram pickup, cashier -> courier handoff,
 * courier -> customer delivery). The plain code is returned once to the caller who
 * must deliver it; only a keyed HMAC is stored, so a database leak does not reveal
 * codes. Codes expire, allow a limited number of attempts and are consumed once;
 * issuing a new code revokes older ones of the same purpose.
 */
const TTL_MINUTES: Record<OrderCodePurpose, number> = {
  PICKUP: 12 * 60,
  HANDOFF: 60,
  DELIVERY: 6 * 60,
};
const MAX_ATTEMPTS = 5;

const digest = (secrets: SecretBox, codeId: string, code: string) =>
  secrets.pepperPin(`order-code:${codeId}`, code).toString('hex');

export async function issueOrderCode(
  tx: Tx,
  secrets: SecretBox,
  input: {
    tenantId: string;
    orderId: string;
    purpose: OrderCodePurpose;
    actorId: string | null;
    now: Date;
  },
) {
  await tx.orderCode.updateMany({
    where: {
      orderId: input.orderId,
      purpose: input.purpose,
      consumedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: input.now },
  });
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await tx.orderCode.create({
    data: {
      tenantId: input.tenantId,
      orderId: input.orderId,
      purpose: input.purpose,
      codeHash: 'pending',
      expiresAt: new Date(
        input.now.getTime() + TTL_MINUTES[input.purpose] * 60_000,
      ),
      maxAttempts: MAX_ATTEMPTS,
      createdById: input.actorId,
    },
  });
  await tx.orderCode.update({
    where: { id: row.id },
    data: { codeHash: digest(secrets, row.id, code) },
  });
  return { code, expiresAt: row.expiresAt };
}

/**
 * Checks a code under a row lock. Wrong codes count attempts; the code is consumed
 * on success. Throws CODE_INVALID / CODE_EXPIRED / CODE_LOCKED.
 */
export async function verifyOrderCode(
  tx: Tx,
  secrets: SecretBox,
  input: {
    orderId: string;
    purpose: OrderCodePurpose;
    code: string;
    now: Date;
  },
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM order_codes
    WHERE "orderId" = ${input.orderId}::uuid
      AND purpose = ${input.purpose}::"OrderCodePurpose"
      AND "consumedAt" IS NULL AND "revokedAt" IS NULL
    ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`;
  const id = rows[0]?.id;
  if (!id) throw new AppError(409, 'CODE_MISSING', 'codeMissing');
  const row = await tx.orderCode.findUniqueOrThrow({ where: { id } });
  if (row.expiresAt <= input.now)
    throw new AppError(409, 'CODE_EXPIRED', 'codeExpired');
  if (row.attempts >= row.maxAttempts)
    throw new AppError(429, 'CODE_LOCKED', 'codeLocked');
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(
    digest(secrets, row.id, input.code.replace(/\D/g, '')),
    'hex',
  );
  const ok =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  await tx.orderCode.update({
    where: { id },
    data: ok
      ? { consumedAt: input.now, attempts: { increment: 1 } }
      : { attempts: { increment: 1 } },
  });
  return { ok, attemptsLeft: row.maxAttempts - row.attempts - 1 };
}
