import { z } from 'zod';
import type { Services } from '../../context.js';
import type { AuthContext } from '../auth/session.js';
import { canSeeStockCost, loadInventory, loadPurchases } from './inventory.js';
import { loadSales, reportRange, type SalesQuery } from './sales.js';

// ------------------------------------------------------------------ layout

export const sectionKeys = [
  'summary',
  'payments',
  'cashiers',
  'shifts',
  'categories',
  'products',
  'stockBalances',
  'stockMovements',
  // Ombor exports only (off in the Hisobotlar layout unless switched on there).
  'stockLowStock',
  'stockPurchases',
] as const;
const optInSections = new Set<string>(['stockLowStock', 'stockPurchases']);
export type SectionKey = (typeof sectionKeys)[number];

export type Kind = 'text' | 'money' | 'int' | 'qty' | 'time';
export type Column = {
  key: string;
  label: string;
  align: 'left' | 'right';
  kind: Kind;
  // The first column names the row and can not be hidden.
  fixed?: boolean;
};

const col = (
  key: string,
  label: string,
  kind: Kind = 'text',
  fixed = false,
): Column => ({
  key,
  label,
  kind,
  align: kind === 'text' || kind === 'time' ? 'left' : 'right',
  ...(fixed ? { fixed } : {}),
});

/** What each section is called and which columns it can show. */
export const sectionCatalog: Record<
  SectionKey,
  {
    title: string;
    permission: 'reports.view' | 'inventory.view' | 'purchasing.manage';
    columns: Column[];
  }
> = {
  summary: {
    title: 'Umumiy ko‘rsatkichlar',
    permission: 'reports.view',
    columns: [
      col('metric', 'Ko‘rsatkich', 'text', true),
      col('value', 'Qiymati', 'money'),
    ],
  },
  payments: {
    title: 'To‘lov usullari',
    permission: 'reports.view',
    columns: [
      col('method', 'To‘lov usuli', 'text', true),
      col('count', 'Soni', 'int'),
      col('amount', 'Summa (so‘m)', 'money'),
    ],
  },
  cashiers: {
    title: 'Xodimlar (kassirlar)',
    permission: 'reports.view',
    columns: [
      col('name', 'Xodim', 'text', true),
      col('count', 'To‘lovlar soni', 'int'),
      col('amount', 'Summa (so‘m)', 'money'),
    ],
  },
  shifts: {
    title: 'Kassa smenalari',
    permission: 'reports.view',
    columns: [
      col('cashier', 'Kassir', 'text', true),
      col('openedAt', 'Ochilgan', 'time'),
      col('closedAt', 'Yopilgan', 'time'),
      col('openingCash', 'Boshlang‘ich naqd', 'money'),
      col('expectedCash', 'Kutilgan naqd', 'money'),
      col('countedCash', 'Sanalgan naqd', 'money'),
      col('variance', 'Farq', 'money'),
    ],
  },
  categories: {
    title: 'Toifalar bo‘yicha sotuv',
    permission: 'reports.view',
    columns: [
      col('name', 'Toifa', 'text', true),
      col('quantity', 'Miqdor', 'int'),
      col('revenue', 'Tushum (so‘m)', 'money'),
    ],
  },
  products: {
    title: 'Mahsulotlar bo‘yicha sotuv',
    permission: 'reports.view',
    columns: [
      col('name', 'Mahsulot', 'text', true),
      col('quantity', 'Miqdor', 'int'),
      col('revenue', 'Tushum (so‘m)', 'money'),
    ],
  },
  stockBalances: {
    title: 'Ombor qoldiqlari',
    permission: 'inventory.view',
    columns: [
      col('name', 'Mahsulot', 'text', true),
      col('unit', 'Birlik'),
      col('quantity', 'Qoldiq', 'qty'),
      col('minStock', 'Minimal qoldiq', 'qty'),
      col('status', 'Holati'),
      col('value', 'Qiymati (so‘m)', 'money'),
    ],
  },
  stockMovements: {
    title: 'Ombor harakatlari',
    permission: 'inventory.view',
    columns: [
      col('at', 'Vaqti', 'time', true),
      col('name', 'Mahsulot'),
      col('type', 'Turi'),
      col('quantity', 'Miqdor', 'qty'),
      col('unit', 'Birlik'),
      col('balanceAfter', 'Qoldiq', 'qty'),
      col('reason', 'Izoh'),
    ],
  },
  stockLowStock: {
    title: 'Kam qolgan va tugagan mahsulotlar',
    permission: 'inventory.view',
    columns: [
      col('name', 'Mahsulot', 'text', true),
      col('unit', 'Birlik'),
      col('quantity', 'Qoldiq', 'qty'),
      col('minStock', 'Minimal qoldiq', 'qty'),
      col('shortage', 'Yetishmaydi', 'qty'),
      col('status', 'Holati'),
    ],
  },
  stockPurchases: {
    title: 'Xaridlar',
    permission: 'purchasing.manage',
    columns: [
      col('at', 'Sana', 'time', true),
      col('supplier', 'Yetkazib beruvchi'),
      col('invoiceNo', 'Hujjat raqami'),
      col('status', 'Holati'),
      col('lines', 'Pozitsiyalar', 'int'),
      col('total', 'Summa (so‘m)', 'money'),
    ],
  },
};

export const layoutSchema = z.object({
  sections: z
    .array(z.object({ key: z.enum(sectionKeys), enabled: z.boolean() }))
    .max(sectionKeys.length),
  hiddenColumns: z
    .record(z.string(), z.array(z.string().max(30)).max(12))
    .default({}),
});
export type Layout = z.infer<typeof layoutSchema>;

/** Sections of the Hisobotlar layout (screen, preview and its exports). */
export const layoutSectionKeys = sectionKeys.filter(
  (key) => !optInSections.has(key),
);

/** Every Hisobotlar section appears once, in the saved order; missing ones are appended.
 * The Ombor-only sections stay out of this layout. */
export function normalizeLayout(value: unknown): Layout {
  const parsed = layoutSchema.safeParse(value);
  const saved = parsed.success
    ? parsed.data
    : { sections: [], hiddenColumns: {} };
  const seen = new Set<string>();
  const sections: Layout['sections'] = [];
  for (const entry of saved.sections)
    if (!seen.has(entry.key) && !optInSections.has(entry.key)) {
      seen.add(entry.key);
      sections.push(entry);
    }
  for (const key of layoutSectionKeys)
    if (!seen.has(key)) sections.push({ key, enabled: true });
  const hiddenColumns: Layout['hiddenColumns'] = {};
  for (const key of sectionKeys) {
    const known = new Set(
      sectionCatalog[key].columns.filter((c) => !c.fixed).map((c) => c.key),
    );
    const hidden = (saved.hiddenColumns[key] ?? []).filter((k) => known.has(k));
    if (hidden.length) hiddenColumns[key] = hidden;
  }
  return { sections, hiddenColumns };
}

// ---------------------------------------------------------------- document

export type Cell = string | number | { value: string | number; kind: Kind };
export type SectionDoc = {
  key: SectionKey;
  title: string;
  columns: Column[];
  rows: Record<string, Cell>[];
  totals?: Record<string, Cell>;
  note?: string;
};
export type ReportDoc = {
  title: string;
  restaurant: string;
  branch: string;
  period: string;
  generatedAt: string;
  filters: string[];
  notes: string[];
  sections: SectionDoc[];
};

const methodLabels: Record<string, string> = {
  CASH: 'Naqd',
  CARD: 'Karta',
  CLICK: 'Click',
  PAYME: 'Payme',
  UZUM: 'Uzum',
  QR: 'QR (Paynet)',
  LOYALTY: 'Sodiqlik ballari',
};

const stockStatus: Record<string, string> = {
  OK: 'Yetarli',
  LOW: 'Kam',
  OUT: 'Tugagan',
};

/** "2026-10-21 14:05" in the restaurant's own timezone. */
function localTime(value: Date | string | null, timezone: string): string {
  if (!value) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const numberOrDash = (value: number | null) => (value === null ? '—' : value);

/**
 * One dataset for all three formats: the enabled sections in the saved order, only the
 * visible columns, and only what this user may see (hiding is presentation; the
 * permission check below is the authorization).
 */
export async function buildReportDoc(
  services: Services,
  auth: AuthContext,
  query: SalesQuery,
  layout: Layout,
  // Ombor export: its own title and filters on the stock sections.
  options: {
    title?: string;
    search?: string;
    stockStatus?: 'all' | 'low' | 'out';
  } = {},
): Promise<ReportDoc> {
  const wanted = layout.sections.filter((entry) => entry.enabled);
  const skipped: string[] = [];
  const allowed = wanted.filter((entry) => {
    const ok = auth.permissions.has(sectionCatalog[entry.key].permission);
    if (!ok) skipped.push(sectionCatalog[entry.key].title);
    return ok;
  });
  const needsSales = allowed.some((entry) =>
    [
      'summary',
      'payments',
      'cashiers',
      'shifts',
      'categories',
      'products',
    ].includes(entry.key),
  );
  const needsStock = allowed.some((entry) => entry.key.startsWith('stock'));
  const sales = needsSales
    ? await loadSales(services, auth, query, true)
    : null;
  const stock = needsStock ? await loadInventory(services, auth, query) : null;
  const purchases = allowed.some((entry) => entry.key === 'stockPurchases')
    ? await loadPurchases(services, auth, query)
    : null;
  const search = options.search?.trim().toLocaleLowerCase('uz') ?? '';
  const matches = (name: string) =>
    !search || name.toLocaleLowerCase('uz').includes(search);
  const statusOk = (status: string) =>
    !options.stockStatus ||
    options.stockStatus === 'all' ||
    (options.stockStatus === 'out'
      ? status === 'OUT'
      : status === 'LOW' || status === 'OUT');
  // No sales section: the branch and dates come from the same range check
  // (also when no section is allowed at all, so the file says so instead of failing).
  const range = sales ? null : await reportRange(services, auth, query);
  const branch = sales?.branch ?? range!.branch;
  const tenant = await services.db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { name: true },
  });
  const timezone = branch.timezone;
  const report = sales?.report;
  const from = report?.from ?? range!.from.toISOString().slice(0, 10);
  const to = report?.to ?? range!.to.toISOString().slice(0, 10);

  const sections: SectionDoc[] = [];
  for (const { key } of allowed) {
    const meta = sectionCatalog[key];
    const hidden = new Set(layout.hiddenColumns[key] ?? []);
    let columns = meta.columns.filter((c) => c.fixed || !hidden.has(c.key));
    let rows: Record<string, Cell>[] = [];
    let totals: Record<string, Cell> | undefined;
    let note: string | undefined;

    if (key === 'summary' && report) {
      const n = (value: number): Cell => ({ value, kind: 'int' });
      const money = (value: number): Cell => ({ value, kind: 'money' });
      rows = [
        { metric: 'Sotuv summasi', value: money(report.salesTotal) },
        { metric: 'Buyurtmalar soni', value: n(report.orders) },
        {
          metric: 'Bekor qilingan buyurtmalar',
          value: n(report.cancelledOrders),
        },
        { metric: 'O‘rtacha chek', value: money(report.averageCheck) },
        { metric: 'Chegirmalar', value: money(report.discounts) },
        { metric: 'Xizmat haqi', value: money(report.serviceCharges) },
        {
          metric: 'Yig‘ilgan to‘lov (qaytarishlarsiz)',
          value: money(report.collected),
        },
        ...(report.profit
          ? [
              { metric: 'Tannarx', value: money(report.profit.costOfGoods) },
              {
                metric: 'Yalpi foyda',
                value: money(report.profit.grossProfit),
              },
              {
                metric: 'Marja (%)',
                value: {
                  value: `${(report.profit.marginBp / 100).toFixed(1)}%`,
                  kind: 'text' as const,
                },
              },
            ]
          : []),
      ];
    } else if (key === 'payments' && report) {
      rows = [
        ...report.payments.map((row) => ({
          method: methodLabels[row.method] ?? row.method,
          count: row.count,
          amount: row.amount,
        })),
        ...report.refunds.map((row) => ({
          method: `Qaytarish: ${methodLabels[row.method] ?? row.method}`,
          count: row.count,
          amount: -row.amount,
        })),
      ];
      totals = {
        method: 'Jami (sof)',
        count: rows.reduce((sum, row) => sum + Number(row.count), 0),
        amount: report.collected,
      };
    } else if (key === 'cashiers' && report) {
      rows = report.cashiers.map((row) => ({
        name: row.name,
        count: row.count,
        amount: row.amount,
      }));
      totals = {
        name: 'Jami',
        count: rows.reduce((sum, row) => sum + Number(row.count), 0),
        amount: rows.reduce((sum, row) => sum + Number(row.amount), 0),
      };
    } else if (key === 'shifts' && sales) {
      rows = sales.shifts.map((row) => ({
        cashier: row.cashier,
        openedAt: localTime(row.openedAt, timezone),
        closedAt: localTime(row.closedAt, timezone),
        openingCash: row.openingCash,
        expectedCash: numberOrDash(row.expectedCash),
        countedCash: numberOrDash(row.countedCash),
        variance: numberOrDash(row.variance),
      }));
    } else if (key === 'categories' && sales) {
      rows = sales.categories;
      totals = {
        name: 'Jami',
        quantity: rows.reduce((sum, row) => sum + Number(row.quantity), 0),
        revenue: rows.reduce((sum, row) => sum + Number(row.revenue), 0),
      };
    } else if (key === 'products' && report) {
      rows = report.topProducts.map((row) => ({
        name: row.name,
        quantity: row.quantity,
        revenue: row.revenue,
      }));
      totals = {
        name: 'Jami',
        quantity: rows.reduce((sum, row) => sum + Number(row.quantity), 0),
        revenue: rows.reduce((sum, row) => sum + Number(row.revenue), 0),
      };
      if (rows.length >= 500)
        note = 'Faqat tushumi eng yuqori 500 ta mahsulot ko‘rsatildi.';
    } else if (key === 'stockBalances' && stock) {
      // The value column exists only for those who may see costs.
      if (!canSeeStockCost(auth))
        columns = columns.filter((c) => c.key !== 'value');
      rows = stock.balances
        .filter((row) => matches(row.name) && statusOk(row.status))
        .map((row) => ({
          name: row.name,
          unit: row.unit,
          quantity: row.quantity,
          minStock: row.minStock,
          status: stockStatus[row.status] ?? row.status,
          ...('value' in row ? { value: row.value } : {}),
        }));
      if (columns.some((c) => c.key === 'value'))
        totals = {
          name: 'Jami qiymat',
          value: rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0),
        };
      note = `Ombor: ${stock.warehouse}. Qoldiqlar hisobot tayyorlangan paytdagi holat.`;
    } else if (key === 'stockMovements' && stock) {
      rows = stock.movements
        .filter((row) => matches(row.name))
        .map((row) => ({
          at: localTime(row.at, timezone),
          name: row.name,
          type: row.type,
          quantity: row.quantity,
          unit: row.unit,
          balanceAfter: row.balanceAfter,
          reason: row.reason,
        }));
      if (rows.length >= 2000)
        note =
          'Faqat birinchi 2000 ta harakat ko‘rsatildi: davrni qisqartiring.';
    } else if (key === 'stockLowStock' && stock) {
      rows = stock.balances
        .filter(
          (row) =>
            row.status !== 'OK' && matches(row.name) && statusOk(row.status),
        )
        .map((row) => {
          const short = Number(row.minStock) - Number(row.quantity);
          return {
            name: row.name,
            unit: row.unit,
            quantity: row.quantity,
            minStock: row.minStock,
            shortage: short > 0 ? String(Number(short.toFixed(3))) : '0',
            status: stockStatus[row.status] ?? row.status,
          };
        });
      note = `Ombor: ${stock.warehouse}. ${rows.length} ta mahsulot minimal qoldiqdan kam.`;
    } else if (key === 'stockPurchases' && purchases) {
      rows = purchases
        .filter((row) => matches(row.supplier))
        .map((row) => ({
          at: localTime(row.at, timezone),
          supplier: row.supplier,
          invoiceNo: row.invoiceNo,
          status: row.status,
          lines: row.lines,
          total: row.total,
        }));
      totals = {
        at: 'Jami (bekor qilinganlarsiz)',
        lines: purchases
          .filter((row) => !row.cancelled && matches(row.supplier))
          .reduce((sum, row) => sum + row.lines, 0),
        total: purchases
          .filter((row) => !row.cancelled && matches(row.supplier))
          .reduce((sum, row) => sum + row.total, 0),
      };
      if (rows.length >= 2000)
        note = 'Faqat birinchi 2000 ta xarid ko‘rsatildi: davrni qisqartiring.';
    }
    sections.push({
      key,
      title: meta.title,
      columns,
      rows,
      ...(totals ? { totals } : {}),
      ...(note ? { note } : {}),
    });
  }

  const generated = new Date();
  return {
    title: options.title ?? 'FastFood hisoboti',
    restaurant: tenant?.name ?? '',
    branch: branch.name,
    period: from === to ? from : `${from} — ${to}`,
    generatedAt: localTime(generated, timezone),
    filters: [
      `Filial: ${branch.name}`,
      `Davr: ${from === to ? from : `${from} — ${to}`}`,
      ...(search ? [`Qidiruv: ${options.search?.trim()}`] : []),
      ...(options.stockStatus === 'low'
        ? ['Holat: kam va tugagan']
        : options.stockStatus === 'out'
          ? ['Holat: tugagan']
          : []),
    ],
    notes: skipped.length
      ? [
          `Ruxsat yo‘qligi sababli ko‘rsatilmagan bo‘limlar: ${skipped.join(', ')}.`,
        ]
      : [],
    sections,
  };
}

// ------------------------------------------------------------- formatting

/** "1 234 567" (so‘m has no decimals). */
export function groupDigits(value: number | string): string {
  const text = String(value);
  const negative = text.startsWith('-');
  const [whole = '', fraction] = text.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${grouped}${fraction ? `.${fraction.replace(/0+$/, '')}` : ''}`.replace(
    /\.$/,
    '',
  );
}

export const kindOf = (column: Column, cell: Cell): Kind =>
  typeof cell === 'object' ? cell.kind : column.kind;
export const valueOf = (cell: Cell): string | number =>
  typeof cell === 'object' ? cell.value : cell;

/** Text shown in Word and PDF; Excel keeps real numbers. */
export function displayCell(column: Column, cell: Cell | undefined): string {
  if (cell === undefined) return '';
  const kind = kindOf(column, cell);
  const value = valueOf(cell);
  if (
    typeof value === 'number' ||
    (kind !== 'text' && kind !== 'time' && /^-?\d+(\.\d+)?$/.test(value))
  )
    return groupDigits(value);
  return String(value);
}
