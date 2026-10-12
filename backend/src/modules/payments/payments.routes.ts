import express, { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import { netPaid } from '../orders/engine.js';
import { clickCheckoutUrl, clickHandler } from './click.js';
import { paymeCheckoutUrl, paymeHandler } from './payme.js';

const providerInput = z.object({
  merchantId: z.string().trim().min(1).max(64),
  serviceId: z.string().trim().max(64).nullable().optional(),
  merchantUserId: z.string().trim().max(64).nullable().optional(),
  // Write-only: omitted on updates keeps the stored secret.
  secret: z.string().min(8).max(200).optional(),
  isActive: z.boolean().default(true),
  testMode: z.boolean().default(false),
});

export function paymentsRouter(services: Services, appOrigin: string) {
  const { db } = services;
  const router = Router();

  // --- Provider callbacks (authenticated by provider signatures, not sessions) ---
  router.post('/webhooks/payme/:configId', paymeHandler(services));
  router.post(
    '/webhooks/click/:configId/prepare',
    express.urlencoded({ extended: false, limit: '10kb' }),
    clickHandler(services, 'prepare'),
  );
  router.post(
    '/webhooks/click/:configId/complete',
    express.urlencoded({ extended: false, limit: '10kb' }),
    clickHandler(services, 'complete'),
  );

  // --- Merchant configuration ---
  router.get(
    '/payments/providers',
    requireAuth(),
    requirePermission('settings.manage'),
    async (_req, res) => {
      const auth = getAuth(res);
      const configs = await db.paymentProviderConfig.findMany({
        where: { tenantId: auth.tenantId },
      });
      res.json({
        providers: (['PAYME', 'CLICK'] as const).map((provider) => {
          const config = configs.find((item) => item.provider === provider);
          return {
            provider,
            configured: !!config,
            merchantId: config?.merchantId ?? null,
            serviceId: config?.serviceId ?? null,
            merchantUserId: config?.merchantUserId ?? null,
            isActive: config?.isActive ?? false,
            testMode: config?.testMode ?? false,
            // URLs to register in the provider's merchant cabinet.
            callbackUrls: config
              ? provider === 'PAYME'
                ? [`${appOrigin}/api/webhooks/payme/${config.id}`]
                : [
                    `${appOrigin}/api/webhooks/click/${config.id}/prepare`,
                    `${appOrigin}/api/webhooks/click/${config.id}/complete`,
                  ]
              : [],
          };
        }),
      });
    },
  );

  router.put(
    '/payments/providers/:provider',
    requireAuth(),
    requirePermission('settings.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const provider = parse(z.enum(['PAYME', 'CLICK']), req.params.provider);
      const input = parse(providerInput, req.body);
      if (provider === 'CLICK' && !input.serviceId)
        throw errors.validation([{ path: 'serviceId' }]);
      const existing = await db.paymentProviderConfig.findUnique({
        where: { tenantId_provider: { tenantId: auth.tenantId, provider } },
      });
      if (!existing && !input.secret)
        throw errors.validation([{ path: 'secret' }]);
      const data = {
        merchantId: input.merchantId,
        serviceId: input.serviceId ?? null,
        merchantUserId: input.merchantUserId ?? null,
        isActive: input.isActive,
        testMode: input.testMode,
        ...(input.secret
          ? { secretEnc: services.secrets.encrypt(input.secret) }
          : {}),
      };
      await db.$transaction(async (tx) => {
        if (existing)
          await tx.paymentProviderConfig.update({
            where: { id: existing.id },
            data,
          });
        else
          await tx.paymentProviderConfig.create({
            data: {
              tenantId: auth.tenantId,
              provider,
              ...data,
              secretEnc: services.secrets.encrypt(input.secret!),
            },
          });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'payments.provider.update',
          entityType: 'payment_provider',
          entityId: provider,
          data: {
            merchantId: input.merchantId,
            isActive: input.isActive,
            testMode: input.testMode,
            secretChanged: !!input.secret,
          },
        });
      });
      res.json({ ok: true });
    },
  );

  // --- Customer pay links for an online order (by tracking token) ---
  router.get('/public/orders/:token/pay', async (req, res) => {
    const token = parse(
      z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
      req.params.token,
    );
    const order = await db.order.findUnique({
      where: { trackingToken: token },
    });
    if (!order) throw errors.notFound();
    const due = order.total - netPaid(order);
    if (
      due <= 0 ||
      ['CANCELLED', 'COMPLETED', 'DRAFT'].includes(order.status)
    ) {
      res.json({ due: 0, links: [] });
      return;
    }
    const configs = await db.paymentProviderConfig.findMany({
      where: { tenantId: order.tenantId, isActive: true },
    });
    const returnUrl = `${appOrigin}/buyurtma/${token}`;
    res.json({
      due,
      links: configs.map((config) =>
        config.provider === 'PAYME'
          ? {
              provider: 'PAYME',
              url: paymeCheckoutUrl(
                config.merchantId,
                order.id,
                due,
                returnUrl,
                config.testMode,
              ),
            }
          : {
              provider: 'CLICK',
              url: clickCheckoutUrl(
                config.serviceId ?? '',
                config.merchantId,
                order.id,
                due,
                returnUrl,
              ),
            },
      ),
    });
  });

  // --- Reconciliation of provider transactions against recorded payments ---
  router.get(
    '/payments/reconciliation',
    requireAuth(),
    requirePermission('finance.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      const query = parse(z.object({ from: isoDate, to: isoDate }), req.query);
      const from = new Date(`${query.from}T00:00:00.000Z`);
      const to = new Date(
        new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000,
      );
      const [transactions, payments] = await Promise.all([
        db.providerTransaction.findMany({
          where: { tenantId: auth.tenantId, createdAt: { gte: from, lt: to } },
        }),
        db.payment.findMany({
          where: {
            tenantId: auth.tenantId,
            method: { in: ['PAYME', 'CLICK'] },
            createdAt: { gte: from, lt: to },
          },
        }),
      ]);
      const paymentById = new Map(
        payments.map((payment) => [payment.id, payment]),
      );
      const linked = new Set(
        transactions.map((tx) => tx.paymentId).filter((id) => id !== null),
      );
      const issues = [
        ...transactions
          .filter(
            (tx) =>
              tx.state === 'PERFORMED' &&
              (!tx.paymentId ||
                paymentById.get(tx.paymentId)?.amount !== tx.amount),
          )
          .map((tx) => ({
            kind: 'PROVIDER_WITHOUT_PAYMENT',
            provider: tx.provider,
            externalId: tx.externalId,
            orderId: tx.orderId,
            amount: tx.amount,
          })),
        ...payments
          .filter((payment) => !linked.has(payment.id))
          .map((payment) => ({
            kind: 'PAYMENT_WITHOUT_PROVIDER',
            provider: payment.method,
            externalId: payment.reference,
            orderId: payment.orderId,
            amount: payment.amount,
          })),
      ];
      const summary = (['PAYME', 'CLICK'] as const).map((provider) => {
        const rows = transactions.filter((tx) => tx.provider === provider);
        const performed = rows.filter((tx) => tx.state === 'PERFORMED');
        return {
          provider,
          performedCount: performed.length,
          performedAmount: performed.reduce((sum, tx) => sum + tx.amount, 0),
          cancelledCount: rows.filter((tx) => tx.state === 'CANCELLED').length,
          openCount: rows.filter((tx) => tx.state === 'CREATED').length,
          recordedAmount: payments
            .filter((payment) => payment.method === provider)
            .reduce((sum, payment) => sum + payment.amount, 0),
        };
      });
      res.json({ from: query.from, to: query.to, summary, issues });
    },
  );

  return router;
}
