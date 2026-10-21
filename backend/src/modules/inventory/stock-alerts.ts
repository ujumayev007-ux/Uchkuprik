import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { defaultAlertSettings } from './alert-sync.js';
import { baseUnitLabels, defaultWarehouse } from './ledger.js';

const settingsInput = z.object({
  enabled: z.boolean(),
  soundEnabled: z.boolean(),
  criticalPercent: z.number().int().min(1).max(99),
  reminderMinutes: z.number().int().min(0).max(240),
});

export function stockAlertsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const view = [requireAuth(), requirePermission('inventory.view')];
  const manage = [requireAuth(), requirePermission('inventory.manage')];

  const settingsOf = async (tenantId: string) => ({
    ...defaultAlertSettings,
    ...(await db.stockAlertSettings.findUnique({ where: { tenantId } })),
  });

  // Active alerts of the branch's warehouse (or the recent history).
  router.get('/inventory/stock-alerts', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        scope: z.enum(['active', 'history']).default('active'),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const warehouse = await db.$transaction((tx) =>
      defaultWarehouse(tx, auth.tenantId, branch.id),
    );
    const alerts = await db.stockAlert.findMany({
      where: {
        tenantId: auth.tenantId,
        warehouseId: warehouse.id,
        ...(query.scope === 'active'
          ? { status: { not: 'RESOLVED' } }
          : { status: 'RESOLVED' }),
      },
      orderBy:
        query.scope === 'active'
          ? [{ openedAt: 'desc' }]
          : [{ resolvedAt: 'desc' }],
      take: query.scope === 'active' ? 200 : 100,
    });
    const items = await db.stockItem.findMany({
      where: { id: { in: alerts.map((alert) => alert.stockItemId) } },
      select: { id: true, name: true, baseUnit: true },
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    res.json({
      settings: await settingsOf(auth.tenantId),
      alerts: alerts.map((alert) => {
        const item = byId.get(alert.stockItemId);
        return {
          id: alert.id,
          stockItemId: alert.stockItemId,
          name: item?.name ?? '—',
          unitLabel: item ? baseUnitLabels[item.baseUnit] : '',
          severity: alert.severity,
          status: alert.status,
          quantity: alert.quantity.toString(),
          threshold: alert.threshold.toString(),
          openedAt: alert.openedAt,
          acknowledgedAt: alert.acknowledgedAt,
          resolvedAt: alert.resolvedAt,
        };
      }),
    });
  });

  router.post('/inventory/stock-alerts/:id/ack', ...view, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.stockAlert.updateMany({
      where: { id, tenantId: auth.tenantId, status: 'OPEN' },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedById: auth.userId,
      },
    });
    if (result.count === 0) {
      // Pressed twice, or already resolved: report only what exists in this restaurant.
      const existing = await db.stockAlert.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!existing) throw errors.notFound();
    }
    res.json({ ok: true });
  });

  router.get('/inventory/stock-alert-settings', ...view, async (_req, res) => {
    res.json(await settingsOf(getAuth(res).tenantId));
  });

  router.put('/inventory/stock-alert-settings', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(settingsInput, req.body);
    await db.stockAlertSettings.upsert({
      where: { tenantId: auth.tenantId },
      create: { tenantId: auth.tenantId, ...input, updatedById: auth.userId },
      update: { ...input, updatedById: auth.userId },
    });
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'inventory.alert_settings.update',
      entityType: 'stock_alert_settings',
      entityId: auth.tenantId,
    });
    res.json(await settingsOf(auth.tenantId));
  });

  return router;
}
