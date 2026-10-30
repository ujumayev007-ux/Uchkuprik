import { loyaltyRulesOf, loyaltyRulesSchema } from '../crm/loyalty-rules.js';
import {
  lockedOrderSettingKeys,
  loadOrderSettings,
  orderSettingsOf,
  orderSettingsSchema,
} from '../orders/settings.js';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import {
  fromLegacyLayout,
  receiptTemplateSchema,
} from '../../printing/receipt-template.js';
import { audit } from '../audit/audit.js';
import { keepVersion } from '../printing/receipt-templates.routes.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const settingsInput = z.object({
  name: z.string().trim().min(2).max(100),
  legalName: optionalText(150),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{9,14}$/)
    .nullable()
    .optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .nullable()
    .optional(),
  address: optionalText(200),
  receiptHeader: optionalText(300),
  receiptFooter: optionalText(300),
  serviceChargeBp: z.number().int().min(0).max(3000),
  requireMfaForAdmins: z.boolean(),
  allowNegativeStock: z.boolean().default(true),
  publicOrdering: z.boolean().default(false),
  loyaltyEarnBp: z.number().int().min(0).max(5000).default(0),
  overtimeAfterMinutes: z.number().int().min(60).max(1440).default(480),
  overtimeMultiplierBp: z.number().int().min(10000).max(30000).default(15000),
  repairApprovalThreshold: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .default(1_000_000),
});

/** Customer receipt layout. Unknown or missing fields fall back to these defaults. */
export const receiptSettingsSchema = z.object({
  paperWidth: z.enum(['58', '80']).default('80'),
  fontSize: z.enum(['small', 'normal', 'large']).default('normal'),
  showBusinessName: z.boolean().default(true),
  showLegalName: z.boolean().default(true),
  showTaxId: z.boolean().default(true),
  showBranch: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  showCashier: z.boolean().default(true),
  showOrderType: z.boolean().default(true),
  showModifiers: z.boolean().default(true),
  showPayments: z.boolean().default(true),
  title: z.string().trim().max(60).default(''),
  extraLines: z.string().trim().max(500).default(''),
  thankYou: z.string().trim().max(120).default('Xaridingiz uchun rahmat!'),
});
export type ReceiptSettings = z.infer<typeof receiptSettingsSchema>;

export function receiptSettingsOf(value: unknown): ReceiptSettings {
  const parsed = receiptSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : receiptSettingsSchema.parse({});
}

/**
 * Merchant QR payment (Paynet, Click, Payme, Uzum…): the customer scans the shop's
 * QR in the provider app and the cashier confirms after seeing the money arrive.
 * Either the QR text (rendered by the app) or a picture of the QR is stored.
 */
export const qrPaymentSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z
    .enum(['PAYNET', 'CLICK', 'PAYME', 'UZUM', 'OTHER'])
    .default('PAYNET'),
  label: z.string().trim().max(40).default('Paynet QR'),
  payload: z.string().trim().max(2000).default(''),
  // data:image/png|jpeg|webp;base64,... up to ~400 KB.
  image: z
    .string()
    .max(560_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .or(z.literal(''))
    .default(''),
  instructions: z
    .string()
    .trim()
    .max(300)
    .default(
      'Paynet ilovasida QR kodni skanerlang va ko‘rsatilgan summani to‘lang.',
    ),
  requireReference: z.boolean().default(false),
});
export type QrPayment = z.infer<typeof qrPaymentSchema>;

export function qrPaymentOf(value: unknown): QrPayment {
  const parsed = qrPaymentSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : qrPaymentSchema.parse({});
}

export function settingsRouter(services: Services) {
  const { db } = services;
  const router = Router();

  router.get('/settings/qr-payment', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const profile = await db.tenantProfile.findUnique({
      where: { tenantId: auth.tenantId },
    });
    res.json(qrPaymentOf(profile?.qrPayment));
  });

  router.put(
    '/settings/qr-payment',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(qrPaymentSchema, req.body);
      if (input.enabled && !input.payload && !input.image)
        throw errors.validation([{ path: 'payload' }]);
      await db.$transaction(async (tx) => {
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          update: { qrPayment: input },
          create: { tenantId: auth.tenantId, qrPayment: input },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.qr_payment.update',
          data: { enabled: input.enabled, provider: input.provider },
        });
      });
      res.json({ ok: true });
    },
  );

  // Order workflow; keys locked by the vendor (licence) are reported and not editable.
  router.get('/settings/orders', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    res.json({
      settings: await loadOrderSettings(db, auth.tenantId),
      locked: lockedOrderSettingKeys(),
    });
  });

  router.put(
    '/settings/orders',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(orderSettingsSchema, req.body);
      const locked = lockedOrderSettingKeys();
      await db.$transaction(async (tx) => {
        const profile = await tx.tenantProfile.findUnique({
          where: { tenantId: auth.tenantId },
        });
        const current = orderSettingsOf(profile?.orderSettings);
        // Locked keys keep their stored value; the vendor's value applies anyway.
        const next = { ...input };
        for (const key of locked)
          (next as Record<string, unknown>)[key] = current[key];
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          update: { orderSettings: next },
          create: { tenantId: auth.tenantId, orderSettings: next },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.orders.update',
          data: { before: current, after: next },
        });
      });
      res.json({
        settings: await loadOrderSettings(db, auth.tenantId),
        locked,
      });
    },
  );

  // Fiscal (OFD) details. The provider secret is write-only and encrypted; no
  // receipts are registered until a certified provider adapter is connected.
  const fiscalSchema = z.object({
    enabled: z.boolean().default(false),
    provider: z.string().trim().max(60).default(''),
    tin: z
      .string()
      .trim()
      .regex(/^(\d{9}|\d{14})?$/)
      .default(''),
    terminalId: z.string().trim().max(60).default(''),
  });
  router.get(
    '/settings/fiscal',
    requireAuth(),
    requirePermission('settings.manage'),
    async (_req, res) => {
      const auth = getAuth(res);
      const profile = await db.tenantProfile.findUnique({
        where: { tenantId: auth.tenantId },
      });
      const parsed = fiscalSchema.safeParse(profile?.fiscalSettings ?? {});
      res.json({
        ...(parsed.success ? parsed.data : fiscalSchema.parse({})),
        hasCredentials: !!profile?.fiscalCredentialsEnc,
        // No certified provider adapter is installed in this build.
        connected: false,
      });
    },
  );
  router.put(
    '/settings/fiscal',
    requireAuth(),
    requirePermission('settings.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        fiscalSchema.extend({
          credentials: z.string().trim().min(8).max(2000).optional(),
          clearCredentials: z.boolean().default(false),
        }),
        req.body,
      );
      const { credentials, clearCredentials, ...settings } = input;
      await db.$transaction(async (tx) => {
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          update: {
            fiscalSettings: settings,
            ...(credentials
              ? { fiscalCredentialsEnc: services.secrets.encrypt(credentials) }
              : clearCredentials
                ? { fiscalCredentialsEnc: null }
                : {}),
          },
          create: {
            tenantId: auth.tenantId,
            fiscalSettings: settings,
            fiscalCredentialsEnc: credentials
              ? services.secrets.encrypt(credentials)
              : null,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.fiscal.update',
          data: {
            ...settings,
            credentialsChanged: !!credentials || clearCredentials,
          },
        });
      });
      res.json({ ok: true });
    },
  );

  router.get('/settings/loyalty-rules', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const profile = await db.tenantProfile.findUnique({
      where: { tenantId: auth.tenantId },
    });
    res.json(loyaltyRulesOf(profile?.loyaltyRules));
  });

  router.put(
    '/settings/loyalty-rules',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(loyaltyRulesSchema, req.body);
      await db.$transaction(async (tx) => {
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          update: { loyaltyRules: input },
          create: { tenantId: auth.tenantId, loyaltyRules: input },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.loyalty.update',
          data: input,
        });
      });
      res.json(input);
    },
  );

  router.get('/settings/receipt', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const profile = await db.tenantProfile.findUnique({
      where: { tenantId: auth.tenantId },
    });
    res.json(fromLegacyLayout(profile?.receiptSettings));
  });

  router.put(
    '/settings/receipt',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      // The restaurant's default template (full template settings; old fields included).
      const input = parse(receiptTemplateSchema, req.body);
      await db.$transaction(async (tx) => {
        const before = await tx.tenantProfile.findUnique({
          where: { tenantId: auth.tenantId },
          select: { receiptSettings: true },
        });
        // The receipt being replaced stays in the designer's history.
        if (before?.receiptSettings)
          await keepVersion(
            tx,
            auth.tenantId,
            null,
            {
              name: 'Asosiy chek',
              kind: 'CUSTOMER',
              settings: fromLegacyLayout(before.receiptSettings),
            },
            auth.userId,
          );
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          update: { receiptSettings: input },
          create: { tenantId: auth.tenantId, receiptSettings: input },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.receipt.update',
        });
      });
      res.json(input);
    },
  );

  router.get('/settings', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      include: { profile: true },
    });
    res.json({
      name: tenant.name,
      slug: tenant.slug,
      requireMfaForAdmins: tenant.requireMfaForAdmins,
      legalName: tenant.profile?.legalName ?? null,
      taxId: tenant.profile?.taxId ?? null,
      phone: tenant.profile?.phone ?? null,
      address: tenant.profile?.address ?? null,
      receiptHeader: tenant.profile?.receiptHeader ?? null,
      receiptFooter: tenant.profile?.receiptFooter ?? null,
      serviceChargeBp: tenant.profile?.serviceChargeBp ?? 0,
      allowNegativeStock: tenant.profile?.allowNegativeStock ?? true,
      publicOrdering: tenant.profile?.publicOrdering ?? false,
      loyaltyEarnBp: tenant.profile?.loyaltyEarnBp ?? 0,
      overtimeAfterMinutes: tenant.profile?.overtimeAfterMinutes ?? 480,
      overtimeMultiplierBp: tenant.profile?.overtimeMultiplierBp ?? 15000,
      repairApprovalThreshold:
        tenant.profile?.repairApprovalThreshold ?? 1_000_000,
    });
  });

  router.patch(
    '/settings',
    requireAuth(),
    requirePermission('settings.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(settingsInput, req.body);
      const profile = {
        legalName: input.legalName ?? null,
        taxId: input.taxId ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        receiptHeader: input.receiptHeader ?? null,
        receiptFooter: input.receiptFooter ?? null,
        serviceChargeBp: input.serviceChargeBp,
        allowNegativeStock: input.allowNegativeStock,
        publicOrdering: input.publicOrdering,
        loyaltyEarnBp: input.loyaltyEarnBp,
        overtimeAfterMinutes: input.overtimeAfterMinutes,
        overtimeMultiplierBp: input.overtimeMultiplierBp,
        repairApprovalThreshold: input.repairApprovalThreshold,
      };
      await db.$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id: auth.tenantId },
          data: {
            name: input.name,
            requireMfaForAdmins: input.requireMfaForAdmins,
          },
        });
        await tx.tenantProfile.upsert({
          where: { tenantId: auth.tenantId },
          create: { tenantId: auth.tenantId, ...profile },
          update: profile,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settings.update',
          entityType: 'tenant',
          entityId: auth.tenantId,
          data: {
            serviceChargeBp: input.serviceChargeBp,
            requireMfaForAdmins: input.requireMfaForAdmins,
          },
        });
      });
      res.json({ ok: true });
    },
  );

  return router;
}
