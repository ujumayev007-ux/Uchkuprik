import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { ErrorState, LoadingState } from '../components/ui';
import { t } from '../i18n';
import {
  ReceiptSheet,
  sampleSheet,
  type SheetData,
} from '../components/ReceiptSheet';
import { normalizeLayout, pageCss } from '../lib/receipt';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ShiftSummary } from '../lib/orders';
import { copiesOf, type PrintPlan } from '../lib/print-rules';
import { ShiftTotals } from './ShiftPage';

type Business = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  phone?: string | null;
  header?: string | null;
  footer?: string | null;
};

// Opened by the Kassa application for silent printing on this terminal's own printer
// (?silent=1&width=58|80): the application prints, the page must not open a dialog.
const terminal = () => new URLSearchParams(window.location.search);
/** The terminal's paper width (58/80 mm) wins over the template's when given. */
const forTerminal = <T extends { widthMm: number }>(layout: T): T => {
  const width = Number(terminal().get('width'));
  return width === 58 || width === 80 ? { ...layout, widthMm: width } : layout;
};

/** A receipt type switched off in Chop etish qoidalari: nothing to print. */
function RuleOff() {
  return <p className="notice">{t.printRules.off}</p>;
}

/** Prints once data is rendered; the page is sized for 80 mm receipt printers. */
function useAutoPrint(ready: boolean) {
  useEffect(() => {
    if (!ready || terminal().get('silent') === '1') return;
    const timer = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(timer);
  }, [ready]);
}

function Header({
  business,
  branch,
}: {
  business: Business;
  branch: { name: string; address: string | null };
}) {
  return (
    <header className="receipt-header">
      <strong>{business.name}</strong>
      {business.legalName && <div>{business.legalName}</div>}
      {business.taxId && <div>STIR: {business.taxId}</div>}
      <div>{branch.name}</div>
      {branch.address && <div>{branch.address}</div>}
      {business.header && <div className="receipt-note">{business.header}</div>}
    </header>
  );
}

/**
 * Customer receipt. The printer/template come from the address
 * (?printer=<id>&template=<id>) or, by default, from the restaurant's assignments.
 * The page is exactly as wide as the paper; its length follows the content.
 */
export function ReceiptPage() {
  const { id } = useParams();
  const params = new URLSearchParams(window.location.search);
  const query = [
    params.get('printer') ? `printerId=${params.get('printer')}` : '',
    params.get('template') ? `templateId=${params.get('template')}` : '',
    // This page prints itself: every opening is a printed receipt (counts the copies).
    'print=1',
  ]
    .filter(Boolean)
    .join('&');
  const receipt = useQuery({
    queryKey: ['receipt', id, query],
    queryFn: () =>
      api<{ layout?: unknown; printRule?: PrintPlan } & SheetData>(
        `/orders/${id}/receipt${query ? `?${query}` : ''}`,
      ),
    // Fetched once: a refetch would count another printed copy.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const rule = receipt.data?.printRule;
  useAutoPrint(receipt.isSuccess && rule?.enabled !== false);
  if (receipt.isPending) return <LoadingState />;
  if (receipt.error) return <ErrorState error={receipt.error} />;
  if (rule?.enabled === false) return <RuleOff />;
  const layout = forTerminal(normalizeLayout(receipt.data.layout));
  // The first receipt in the rule's copies (the Kassa application prints one page per
  // call and repeats the call instead).
  const copies =
    terminal().get('silent') === '1' || (receipt.data.copy ?? 0) > 0
      ? 1
      : (rule?.copies ?? 1);
  return (
    <>
      <style>{pageCss(layout)}</style>
      {copiesOf(copies).map((index) => (
        <ReceiptSheet key={index} layout={layout} data={receipt.data} />
      ))}
      <button
        className="btn btn-primary btn-md no-print receipt-print-button"
        onClick={() => window.print()}
      >
        {t.receipt.print}
      </button>
    </>
  );
}

/** Test print of the unsaved designer settings (opened by the designer). */
export function ReceiptTestPage() {
  const raw = sessionStorage.getItem('ff-receipt-test');
  const layout = forTerminal(normalizeLayout(raw ? JSON.parse(raw) : {}));
  useAutoPrint(true);
  return (
    <>
      <style>{pageCss(layout)}</style>
      <ReceiptSheet layout={layout} data={sampleSheet()} />
      <button
        className="btn btn-primary btn-md no-print receipt-print-button"
        onClick={() => window.print()}
      >
        {t.receipt.print}
      </button>
    </>
  );
}

export function ZReportPage() {
  const { id } = useParams();
  const report = useQuery({
    queryKey: ['z-report', id],
    queryFn: () =>
      api<
        ShiftSummary & {
          business: Business;
          branch: { name: string; address: string | null };
          openedBy: string | null;
          closedBy: string | null;
          printRule?: PrintPlan;
        }
      >(`/shifts/${id}/report`),
  });
  const rule = report.data?.printRule;
  useAutoPrint(report.isSuccess && rule?.enabled !== false);
  if (report.isPending) return <LoadingState />;
  if (report.error) return <ErrorState error={report.error} />;
  if (rule?.enabled === false) return <RuleOff />;
  const data = report.data;
  return copiesOf(rule?.copies ?? 1).map((index) => (
    <div className="receipt" key={index}>
      <Header business={data.business} branch={data.branch} />
      <h1 className="receipt-title">{t.shift.zReport}</h1>
      <div className="receipt-meta">
        <span>
          {t.shift.opened}: {formatDateTime(data.shift.openedAt)} ·{' '}
          {data.openedBy}
        </span>
        {data.shift.closedAt && (
          <span>
            {t.shift.closed}: {formatDateTime(data.shift.closedAt)} ·{' '}
            {data.closedBy}
          </span>
        )}
        <span>
          {t.shift.ordersPaid}: {data.ordersPaid}
        </span>
      </div>
      <ShiftTotals summary={data} />
      {index === 0 && (
        <button
          className="btn btn-primary btn-md no-print"
          onClick={() => window.print()}
        >
          {t.receipt.print}
        </button>
      )}
    </div>
  ));
}
