import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Services } from '../../context.js';
import {
  afterCapture,
  captureProviderPayment,
  CaptureError,
  payableOrder,
} from './capture.js';

/**
 * Click SHOP API (Prepare = action 0, Complete = action 1). Click posts
 * application/x-www-form-urlencoded data signed with MD5 over the service secret.
 * merchant_prepare_id / merchant_confirm_id reuse the numeric click_trans_id.
 */

type ClickBody = Record<string, string | undefined>;

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
function sameHex(a: string, b: string) {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

export function clickSign(body: ClickBody, secret: string, complete: boolean) {
  return md5(
    `${body.click_trans_id ?? ''}${body.service_id ?? ''}${secret}${body.merchant_trans_id ?? ''}` +
      `${complete ? (body.merchant_prepare_id ?? '') : ''}${body.amount ?? ''}${body.action ?? ''}${body.sign_time ?? ''}`,
  );
}

const codes = {
  signature: -1,
  amount: -2,
  action: -3,
  paid: -4,
  order: -5,
  transaction: -6,
  request: -8,
  cancelled: -9,
} as const;
const notes: Record<number, string> = {
  0: 'Success',
  [-1]: 'SIGN CHECK FAILED!',
  [-2]: 'Incorrect parameter amount',
  [-3]: 'Action not found',
  [-4]: 'Already paid',
  [-5]: 'Order does not exist',
  [-6]: 'Transaction does not exist',
  [-8]: 'Error in request from click',
  [-9]: 'Transaction cancelled',
};

export function clickHandler(
  services: Services,
  stage: 'prepare' | 'complete',
) {
  const { db } = services;
  return async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as ClickBody;
    const respond = (error: number, extra: Record<string, unknown> = {}) =>
      res.json({
        click_trans_id: body.click_trans_id ?? null,
        merchant_trans_id: body.merchant_trans_id ?? null,
        error,
        error_note: notes[error] ?? 'Error',
        ...extra,
      });
    const config = await db.paymentProviderConfig.findFirst({
      where: {
        id: String(req.params.configId ?? ''),
        provider: 'CLICK',
        isActive: true,
      },
    });
    if (!config) return respond(codes.request);
    const complete = stage === 'complete';
    if (
      !body.sign_string ||
      !sameHex(
        body.sign_string,
        clickSign(body, services.secrets.decrypt(config.secretEnc), complete),
      )
    )
      return respond(codes.signature);
    if (body.service_id !== config.serviceId) return respond(codes.request);
    if (body.action !== (complete ? '1' : '0')) return respond(codes.action);
    const externalId = body.click_trans_id ?? '';
    const orderId = body.merchant_trans_id ?? '';
    if (!/^\d{1,20}$/.test(externalId) || !/^[0-9a-f-]{36}$/i.test(orderId))
      return respond(codes.request);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount))
      return respond(codes.amount);
    const tenantId = config.tenantId;
    const now = services.now?.() ?? new Date();

    try {
      if (!complete) {
        const existing = await db.providerTransaction.findUnique({
          where: { provider_externalId: { provider: 'CLICK', externalId } },
        });
        if (existing) {
          if (existing.state === 'CANCELLED') return respond(codes.cancelled);
          if (existing.state === 'PERFORMED') return respond(codes.paid);
          return respond(0, { merchant_prepare_id: Number(externalId) });
        }
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
          const { due } = await payableOrder(tx, tenantId, orderId);
          if (amount !== due) throw new CaptureError('WRONG_AMOUNT');
          await tx.providerTransaction.create({
            data: {
              tenantId,
              configId: config.id,
              provider: 'CLICK',
              externalId,
              orderId,
              amount,
              providerTime: BigInt(externalId),
            },
          });
        });
        return respond(0, { merchant_prepare_id: Number(externalId) });
      }

      const tx = await db.providerTransaction.findUnique({
        where: { provider_externalId: { provider: 'CLICK', externalId } },
      });
      if (
        !tx ||
        tx.tenantId !== tenantId ||
        String(tx.providerTime) !== body.merchant_prepare_id
      )
        return respond(codes.transaction);
      if (tx.orderId !== orderId || tx.amount !== amount)
        return respond(codes.amount);
      if (tx.state === 'PERFORMED') return respond(codes.paid);
      if (tx.state === 'CANCELLED') return respond(codes.cancelled);
      // Click reports a failed payment with a negative "error" in Complete.
      if (Number(body.error ?? 0) < 0) {
        await db.providerTransaction.update({
          where: { id: tx.id },
          data: { state: 'CANCELLED', cancelledAt: now },
        });
        return respond(codes.cancelled);
      }
      await db.$transaction(async (dbTx) => {
        const payment = await captureProviderPayment(dbTx, services, {
          tenantId,
          orderId: tx.orderId,
          provider: 'CLICK',
          externalId,
          amount: tx.amount,
        });
        await dbTx.providerTransaction.update({
          where: { id: tx.id },
          data: { state: 'PERFORMED', performedAt: now, paymentId: payment.id },
        });
      });
      await afterCapture(services, tx.orderId);
      return respond(0, { merchant_confirm_id: Number(externalId) });
    } catch (error) {
      if (error instanceof CaptureError)
        return respond(
          error.reason === 'ORDER_NOT_FOUND'
            ? codes.order
            : error.reason === 'WRONG_AMOUNT'
              ? codes.amount
              : codes.paid,
        );
      services.logger.error({ provider: 'click' }, 'Click callback failed');
      return respond(codes.request);
    }
  };
}

/** Customer checkout link (Click hosted page). Payment is confirmed only by callbacks. */
export function clickCheckoutUrl(
  serviceId: string,
  merchantId: string,
  orderId: string,
  amountSom: number,
  returnUrl: string,
) {
  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    amount: String(amountSom),
    transaction_param: orderId,
    return_url: returnUrl,
  });
  return `https://my.click.uz/services/pay?${params}`;
}
