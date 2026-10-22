import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import {
  buildReportDoc,
  displayCell,
  layoutSchema,
  layoutSectionKeys,
  normalizeLayout,
  sectionCatalog,
} from './document.js';
import { toDocx } from './export/docx.js';
import { toPdf } from './export/pdf.js';
import { toXlsx } from './export/xlsx.js';
import { loadInventory } from './inventory.js';
import { loadSales, salesQuery } from './sales.js';

const formats = {
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    build: toXlsx,
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    build: toDocx,
  },
  pdf: { mime: 'application/pdf', build: toPdf },
} as const;

export function reportsRouter(services: Services) {
  const { db } = services;
  const router = Router();

  // Sales summary for a branch over business dates (inclusive). Money in so‘m.
  router.get(
    '/reports/sales',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(salesQuery, req.query);
      const { report } = await loadSales(services, auth, query);
      res.json(report);
    },
  );

  // Stock balances and movements of the period (same ledger as the Ombor screen).
  router.get(
    '/reports/inventory',
    requireAuth(),
    requirePermission('inventory.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(salesQuery, req.query);
      const { balances, movements, warehouse } = await loadInventory(
        services,
        auth,
        query,
      );
      res.json({ warehouse, balances, movements });
    },
  );

  // Which sections and columns this restaurant shows (screen, preview and exports).
  router.get(
    '/reports/layout',
    requireAuth(),
    requirePermission('reports.view'),
    async (_req, res) => {
      const auth = getAuth(res);
      const row = await db.reportLayout.findUnique({
        where: { tenantId: auth.tenantId },
      });
      res.json({
        layout: normalizeLayout(row?.config),
        catalog: layoutSectionKeys.map((key) => ({
          key,
          title: sectionCatalog[key].title,
          // A section the user may not see is listed but can not be exported.
          allowed: auth.permissions.has(sectionCatalog[key].permission),
          columns: sectionCatalog[key].columns.map(
            ({ key: column, label, fixed }) => ({
              key: column,
              label,
              fixed: !!fixed,
            }),
          ),
        })),
      });
    },
  );

  router.put(
    '/reports/layout',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(layoutSchema, req.body);
      const layout = normalizeLayout(input);
      await db.reportLayout.upsert({
        where: { tenantId: auth.tenantId },
        create: {
          tenantId: auth.tenantId,
          config: layout,
          updatedById: auth.userId,
        },
        update: { config: layout, updatedById: auth.userId },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'reports.layout.update',
        entityType: 'report_layout',
        entityId: auth.tenantId,
      });
      res.json({ layout });
    },
  );

  // The same dataset as the files, as text, for the on-screen preview.
  router.get(
    '/reports/preview',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(salesQuery, req.query);
      const row = await db.reportLayout.findUnique({
        where: { tenantId: auth.tenantId },
      });
      const doc = await buildReportDoc(
        services,
        auth,
        query,
        normalizeLayout(row?.config),
      );
      res.json({
        ...doc,
        sections: doc.sections.map((section) => ({
          key: section.key,
          title: section.title,
          note: section.note ?? null,
          columns: section.columns.map(({ key, label, align }) => ({
            key,
            label,
            align,
          })),
          rows: section.rows.map((r) =>
            section.columns.map((column) => displayCell(column, r[column.key])),
          ),
          totals: section.totals
            ? section.columns.map((column) =>
                displayCell(column, section.totals![column.key]),
              )
            : null,
        })),
      });
    },
  );

  // The same dataset as .xlsx, .docx or .pdf.
  router.get(
    '/reports/export',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        salesQuery.extend({ format: z.enum(['xlsx', 'docx', 'pdf']) }),
        req.query,
      );
      const row = await db.reportLayout.findUnique({
        where: { tenantId: auth.tenantId },
      });
      const doc = await buildReportDoc(
        services,
        auth,
        query,
        normalizeLayout(row?.config),
      );
      const format = formats[query.format];
      const file = await format.build(doc);
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'reports.export',
        entityType: 'report',
        data: { format: query.format, period: doc.period },
      });
      const stamp = doc.period.replace(/[^0-9-]+/g, '_');
      res
        .status(200)
        .set({
          'Content-Type': format.mime,
          'Content-Disposition': `attachment; filename="hisobot-${stamp}.${query.format}"`,
          'Cache-Control': 'no-store',
        })
        .send(file);
    },
  );

  // Ombor (inventory) export: the chosen stock sections and columns for the chosen days,
  // filtered by name and stock status. Each section keeps its own permission check
  // (purchases need purchasing.manage, cost values the cost permission).
  const stockSections = [
    'stockBalances',
    'stockLowStock',
    'stockMovements',
    'stockPurchases',
  ] as const;
  router.get(
    '/inventory/export',
    requireAuth(),
    requirePermission('inventory.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        salesQuery.extend({
          format: z.enum(['xlsx', 'docx', 'pdf']),
          sections: z
            .string()
            .transform((value) => value.split(',').filter(Boolean))
            .pipe(z.array(z.enum(stockSections)).min(1).max(4)),
          // "section.column" pairs to leave out.
          hidden: z
            .string()
            .max(1000)
            .optional()
            .transform((value) => (value ? value.split(',') : [])),
          q: z.string().trim().max(60).optional(),
          status: z.enum(['all', 'low', 'out']).default('all'),
          // Chosen products: comma list of stock item ids (empty = all).
          items: z
            .string()
            .max(20_000)
            .optional()
            .transform((value) => (value ? value.split(',') : []))
            .pipe(z.array(z.uuid()).max(500)),
        }),
        req.query,
      );
      const hiddenColumns: Record<string, string[]> = {};
      for (const pair of query.hidden) {
        const [section, column] = pair.split('.');
        if (section && column) (hiddenColumns[section] ??= []).push(column);
      }
      const layout = layoutSchema.parse({
        sections: [...new Set(query.sections)].map((key) => ({
          key,
          enabled: true,
        })),
        hiddenColumns,
      });
      const doc = await buildReportDoc(services, auth, query, layout, {
        title: 'Ombor hisoboti',
        ...(query.q ? { search: query.q } : {}),
        stockStatus: query.status,
        items: query.items,
      });
      const format = formats[query.format];
      const file = await format.build(doc);
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'inventory.export',
        entityType: 'report',
        data: {
          format: query.format,
          period: doc.period,
          sections: query.sections,
        },
      });
      const stamp = doc.period.replace(/[^0-9-]+/g, '_');
      res
        .status(200)
        .set({
          'Content-Type': format.mime,
          'Content-Disposition': `attachment; filename="ombor-${stamp}.${query.format}"`,
          'Cache-Control': 'no-store',
        })
        .send(file);
    },
  );

  return router;
}
