import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { ErrorState, LoadingState } from '../components/ui';
import { t } from '../i18n';
import type { ReceiptLayout } from './ReceiptDesignPage';
import { api } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import type { Order, ShiftSummary } from '../lib/orders';
import { ShiftTotals } from './ShiftPage';

type Business = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  phone?: string | null;
  header?: string | null;
  footer?: string | null;
};

/** Prints once data is rendered; the page is sized for 80 mm receipt printers. */
function useAutoPrint(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
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

export function ReceiptPage() {
  const { id } = useParams();
  const receipt = useQuery({
    queryKey: ['receipt', id],
    queryFn: () =>
      api<{
        business: Business;
        branch: { name: string; address: string | null };
        cashier: string | null;
        layout?: ReceiptLayout;
        order: Order & {
          items: (Order['items'][number] & {
            components?: { name: string; quantity: number }[];
          })[];
        };
      }>(`/orders/${id}/receipt`),
  });
  useAutoPrint(receipt.isSuccess);
  if (receipt.isPending) return <LoadingState />;
  if (receipt.error) return <ErrorState error={receipt.error} />;
  const { business, branch, cashier, order } = receipt.data;
  const layout: ReceiptLayout = receipt.data.layout ?? {
    paperWidth: '80',
    fontSize: 'normal',
    showBusinessName: true,
    showLegalName: true,
    showTaxId: true,
    showBranch: true,
    showPhone: true,
    showCashier: true,
    showOrderType: true,
    showModifiers: true,
    showPayments: true,
    title: '',
    extraLines: '',
    thankYou: '',
  };
  return (
    <div
      className={`receipt paper-${layout.paperWidth} font-${layout.fontSize}`}
    >
      {layout.title && <strong className="center block">{layout.title}</strong>}
      <Header
        business={{
          ...business,
          name: layout.showBusinessName ? business.name : '',
          legalName: layout.showLegalName ? business.legalName : null,
          taxId: layout.showTaxId ? business.taxId : null,
          phone: layout.showPhone ? (business.phone ?? null) : null,
        }}
        branch={layout.showBranch ? branch : { name: '', address: null }}
      />
      <div className="receipt-meta">
        <span>
          {t.receipt.order} {t.orders.number}
          {order.number}
        </span>
        <span>{formatDateTime(order.createdAt)}</span>
        {layout.showOrderType && (
          <span>
            {t.pos.types[order.type]}
            {order.table ? ` · ${order.table.name}` : ''}
          </span>
        )}
        {layout.showCashier && cashier && (
          <span>
            {t.receipt.cashier}: {cashier}
          </span>
        )}
      </div>
      <table>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.productName}{' '}
                {item.variantName !== 'Standart' && `(${item.variantName})`}
                {layout.showModifiers && item.modifiers.length > 0 && (
                  <div className="small">
                    + {item.modifiers.map((m) => m.name).join(', ')}
                  </div>
                )}
                {layout.showModifiers && (item.components ?? []).length > 0 && (
                  <div className="small">
                    {(item.components ?? [])
                      .map((part) => `${part.quantity}× ${part.name}`)
                      .join(', ')}
                  </div>
                )}
                <div className="small">
                  {item.quantity} ×{' '}
                  {formatMoney(item.unitPrice + item.modifiersTotal)}
                </div>
              </td>
              <td className="right">{formatMoney(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals">
        {order.discountTotal > 0 && (
          <>
            <dt>{t.pos.discount}</dt>
            <dd>−{formatMoney(order.discountTotal)}</dd>
          </>
        )}
        {order.serviceCharge > 0 && (
          <>
            <dt>{t.pos.serviceCharge}</dt>
            <dd>{formatMoney(order.serviceCharge)}</dd>
          </>
        )}
        <dt className="strong">{t.pos.total}</dt>
        <dd className="strong">{formatMoney(order.total)}</dd>
        {layout.showPayments &&
          order.payments.map((payment) => (
            <div key={payment.id} className="totals-row">
              <dt>{t.payment.methods[payment.method]}</dt>
              <dd>{formatMoney(payment.tendered ?? payment.amount)}</dd>
              {payment.change ? (
                <>
                  <dt>{t.payment.change}</dt>
                  <dd>{formatMoney(payment.change)}</dd>
                </>
              ) : null}
            </div>
          ))}
        {order.due > 0 && (
          <>
            <dt className="strong">{t.pos.due}</dt>
            <dd className="strong">{formatMoney(order.due)}</dd>
          </>
        )}
      </dl>
      <footer className="receipt-footer">
        {layout.extraLines && <div className="pre">{layout.extraLines}</div>}
        {business.footer && <div>{business.footer}</div>}
        <div>{layout.thankYou || t.receipt.thanks}</div>
        {/* Fiscal QR and receipt numbers require an authorized fiscal provider (Phase 8). */}
        <div className="small">{t.receipt.notFiscal}</div>
      </footer>
      <button
        className="btn btn-primary btn-md no-print"
        onClick={() => window.print()}
      >
        {t.receipt.print}
      </button>
    </div>
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
