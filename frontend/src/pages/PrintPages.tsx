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
  ]
    .filter(Boolean)
    .join('&');
  const receipt = useQuery({
    queryKey: ['receipt', id, query],
    queryFn: () =>
      api<{ layout?: unknown } & SheetData>(
        `/orders/${id}/receipt${query ? `?${query}` : ''}`,
      ),
  });
  useAutoPrint(receipt.isSuccess);
  if (receipt.isPending) return <LoadingState />;
  if (receipt.error) return <ErrorState error={receipt.error} />;
  const layout = forTerminal(normalizeLayout(receipt.data.layout));
  return (
    <>
      <style>{pageCss(layout)}</style>
      <ReceiptSheet layout={layout} data={receipt.data} />
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
        }
      >(`/shifts/${id}/report`),
  });
  useAutoPrint(report.isSuccess);
  if (report.isPending) return <LoadingState />;
  if (report.error) return <ErrorState error={report.error} />;
  const data = report.data;
  return (
    <div className="receipt">
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
      <button
        className="btn btn-primary btn-md no-print"
        onClick={() => window.print()}
      >
        {t.receipt.print}
      </button>
    </div>
  );
}
