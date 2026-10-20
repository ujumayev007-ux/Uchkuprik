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
  normalizeLayout,
  sectionCatalog,
  sectionKeys,
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
        catalog: sectionKeys.map((key) => ({
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

  return router;
}
