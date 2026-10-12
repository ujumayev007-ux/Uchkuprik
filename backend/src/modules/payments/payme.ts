import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Services } from '../../context.js';
import {
  afterCapture,
  captureProviderPayment,
  CaptureError,
  payableOrder,
} from './capture.js';

/**
 * Payme Merchant API (JSON-RPC 2.0) as specified by Payme Business. Payme calls this
 * endpoint; amounts are in tiyin (1 so‘m = 100 tiyin). Authentication is HTTP Basic
 * with login "Paycom" and the cashbox key. Responses are always HTTP 200.
 */

const TIMEOUT_MS = 43_200_000; // 12 hours: unperformed transactions expire.

const errorMessages: Record<number, { uz: string; ru: string; en: string }> = {
  [-32504]: {
    uz: 'Ruxsat yo‘q',
    ru: 'Недостаточно привилегий',
    en: 'Insufficient privileges',
  },
  [-32700]: {
    uz: 'So‘rov formati noto‘g‘ri',
    ru: 'Ошибка разбора запроса',
    en: 'Parse error',
  },
  [-32600]: {
    uz: 'So‘rov noto‘g‘ri',
    ru: 'Неверный запрос',
    en: 'Invalid request',
  },
  [-32601]: {
    uz: 'Metod topilmadi',
    ru: 'Метод не найден',
    en: 'Method not found',
  },
  [-31001]: {
    uz: 'Summa noto‘g‘ri',
    ru: 'Неверная сумма',
    en: 'Incorrect amount',
  },
  [-31003]: {
    uz: 'Tranzaksiya topilmadi',
    ru: 'Транзакция не найдена',
    en: 'Transaction not found',
  },
  [-31007]: {
    uz: 'Buyurtma bajarilgan, bekor qilib bo‘lmaydi',
    ru: 'Заказ выполнен, отмена невозможна',
    en: 'Order performed, cannot cancel',
  },
  [-31008]: {
    uz: 'Amalni bajarib bo‘lmaydi',
    ru: 'Невозможно выполнить операцию',
    en: 'Unable to perform operation',
  },
  [-31050]: {
    uz: 'Buyurtma topilmadi',
    ru: 'Заказ не найден',
    en: 'Order not found',
  },
  [-31051]: {
    uz: 'Buyurtma allaqachon to‘langan yoki yopilgan',
    ru: 'Заказ уже оплачен или закрыт',
    en: 'Order already paid or closed',
  },
  [-31052]: {
    uz: 'Buyurtma boshqa to‘lovni kutmoqda',
    ru: 'Заказ ожидает другую оплату',
    en: 'Order awaits another payment',
  },
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    readonly data?: string,
  ) {
    super(String(code));
  }
}

const stateOf = (tx: { state: string; performedAt: Date | null }) =>
  tx.state === 'CREATED'
    ? 1
    : tx.state === 'PERFORMED'
      ? 2
      : tx.performedAt
        ? -2
        : -1;

function authorized(header: string | undefined, key: string) {
  const expected = Buffer.from(
    `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}`,
  );
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function captureCode(error: CaptureError) {
  return error.reason === 'ORDER_NOT_FOUND'
    ? -31050
    : error.reason === 'WRONG_AMOUNT'
      ? -31001
      : -31051;
}

export function paymeHandler(services: Services) {
  const { db } = services;
  return async (req: Request, res: Response) => {
    const body = req.body as
      | { id?: unknown; method?: unknown; params?: Record<string, unknown> }
      | undefined;
    const id = body?.id ?? null;
    const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
    const fail = (code: number, data?: string) =>
      res.json({
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message: errorMessages[code] ?? errorMessages[-31008],
          ...(data ? { data } : {}),
        },
      });

    const config = await db.paymentProviderConfig.findFirst({
      where: {
        id: String(req.params.configId ?? ''),
        provider: 'PAYME',
        isActive: true,
      },
    });
    if (!config) return fail(-32504);
    if (
      !authorized(
        req.get('authorization'),
        services.secrets.decrypt(config.secretEnc),
      )
    )
      return fail(-32504);
    if (
      !body ||
      typeof body.method !== 'string' ||
      typeof body.params !== 'object' ||
      body.params === null
    )
      return fail(-32600);
    const params = body.params;
    const now = services.now?.() ?? new Date();
    const tenantId = config.tenantId;

    try {
      const orderIdOf = () => {
        const account = params.account as { order_id?: unknown } | undefined;
        const value = String(account?.order_id ?? '');
        if (!/^[0-9a-f-]{36}$/i.test(value))
          throw new RpcError(-31050, 'order_id');
        return value;
      };
      const tiyin = () => {
        const amount = Number(params.amount);
        if (!Number.isInteger(amount) || amount <= 0 || amount % 100 !== 0)
          throw new RpcError(-31001);
        return amount / 100;
      };
      const findTx = async () => {
        const tx = await db.providerTransaction.findUnique({
          where: {
            provider_externalId: {
              provider: 'PAYME',
              externalId: String(params.id ?? ''),
            },
          },
        });
        if (!tx || tx.tenantId !== tenantId) throw new RpcError(-31003);
        return tx;
      };
      const expire = async (txId: string) => {
        await db.providerTransaction.update({
          where: { id: txId },
          data: { state: 'CANCELLED', cancelledAt: now, cancelReason: 4 },
        });
        throw new RpcError(-31008);
      };

      switch (body.method) {
        case 'CheckPerformTransaction': {
          const amount = tiyin();
          const { due } = await db.$transaction((tx) =>
            payableOrder(tx, tenantId, orderIdOf()),
          );
          if (amount !== due) throw new RpcError(-31001);
          return reply({ allow: true });
        }
        case 'CreateTransaction': {
          const externalId = String(params.id ?? '');
          const time = Number(params.time);
          if (!externalId || !Number.isFinite(time)) throw new RpcError(-32600);
          const existing = await db.providerTransaction.findUnique({
            where: { provider_externalId: { provider: 'PAYME', externalId } },
          });
          if (existing) {
            if (existing.tenantId !== tenantId || existing.state !== 'CREATED')
              throw new RpcError(-31008);
            if (now.getTime() - Number(existing.providerTime) > TIMEOUT_MS)
              await expire(existing.id);
            return reply({
              create_time: Number(existing.providerTime),
              transaction: existing.id,
              state: 1,
            });
          }
          const amount = tiyin();
          const orderId = orderIdOf();
          const created = await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
            const { due } = await payableOrder(tx, tenantId, orderId);
            if (amount !== due) throw new RpcError(-31001);
            // Only one open Payme transaction per order.
            const open = await tx.providerTransaction.count({
              where: { orderId, provider: 'PAYME', state: 'CREATED' },
            });
            if (open > 0) throw new RpcError(-31052);
            return tx.providerTransaction.create({
              data: {
                tenantId,
                configId: config.id,
                provider: 'PAYME',
                externalId,
                orderId,
                amount,
                providerTime: BigInt(time),
              },
            });
          });
          return reply({
            create_time: time,
            transaction: created.id,
            state: 1,
          });
        }
        case 'PerformTransaction': {
          const tx = await findTx();
          if (tx.state === 'PERFORMED')
            return reply({
              transaction: tx.id,
              perform_time: tx.performedAt!.getTime(),
              state: 2,
            });
          if (tx.state === 'CANCELLED') throw new RpcError(-31008);
          if (now.getTime() - Number(tx.providerTime) > TIMEOUT_MS)
            await expire(tx.id);
          const performed = await db.$transaction(async (dbTx) => {
            const payment = await captureProviderPayment(dbTx, services, {
              tenantId,
              orderId: tx.orderId,
              provider: 'PAYME',
              externalId: tx.externalId,
              amount: tx.amount,
            });
            return dbTx.providerTransaction.update({
              where: { id: tx.id },
              data: {
                state: 'PERFORMED',
                performedAt: now,
                paymentId: payment.id,
              },
            });
          });
          await afterCapture(services, tx.orderId);
          return reply({
            transaction: performed.id,
            perform_time: performed.performedAt!.getTime(),
            state: 2,
          });
        }
        case 'CancelTransaction': {
          const tx = await findTx();
          if (tx.state === 'CANCELLED')
            return reply({
              transaction: tx.id,
              cancel_time: tx.cancelledAt!.getTime(),
              state: stateOf(tx),
            });
          // Performed payments are refunded by staff (with approval), not by provider cancel.
          if (tx.state === 'PERFORMED') throw new RpcError(-31007);
          const cancelled = await db.providerTransaction.update({
            where: { id: tx.id },
            data: {
              state: 'CANCELLED',
              cancelledAt: now,
              cancelReason: Number(params.reason) || null,
            },
          });
          return reply({
            transaction: cancelled.id,
            cancel_time: cancelled.cancelledAt!.getTime(),
            state: -1,
          });
        }
        case 'CheckTransaction': {
          const tx = await findTx();
          return reply({
            create_time: Number(tx.providerTime),
            perform_time: tx.performedAt?.getTime() ?? 0,
            cancel_time: tx.cancelledAt?.getTime() ?? 0,
            transaction: tx.id,
            state: stateOf(tx),
            reason: tx.cancelReason,
          });
        }
        case 'GetStatement': {
          const from = BigInt(Math.trunc(Number(params.from) || 0));
          const to = BigInt(Math.trunc(Number(params.to) || 0));
          const rows = await db.providerTransaction.findMany({
            where: {
              tenantId,
              provider: 'PAYME',
              providerTime: { gte: from, lte: to },
            },
            orderBy: { providerTime: 'asc' },
          });
          return reply({
            transactions: rows.map((tx) => ({
              id: tx.externalId,
              time: Number(tx.providerTime),
              amount: tx.amount * 100,
              account: { order_id: tx.orderId },
              create_time: Number(tx.providerTime),
              perform_time: tx.performedAt?.getTime() ?? 0,
              cancel_time: tx.cancelledAt?.getTime() ?? 0,
              transaction: tx.id,
              state: stateOf(tx),
              reason: tx.cancelReason,
            })),
          });
        }
        default:
          return fail(-32601);
      }
    } catch (error) {
      if (error instanceof RpcError) return fail(error.code, error.data);
      if (error instanceof CaptureError) return fail(captureCode(error));
      services.logger.error({ provider: 'payme' }, 'Payme callback failed');
      return fail(-31008);
    }
  };
}

/** Customer checkout link (Payme hosted page). Payment is confirmed only by callbacks. */
export function paymeCheckoutUrl(
  merchantId: string,
  orderId: string,
  amountSom: number,
  returnUrl: string,
  test: boolean,
) {
  const params = `m=${merchantId};ac.order_id=${orderId};a=${amountSom * 100};c=${returnUrl}`;
  return `https://${test ? 'checkout.test.paycom.uz' : 'checkout.paycom.uz'}/${Buffer.from(params).toString('base64')}`;
}
