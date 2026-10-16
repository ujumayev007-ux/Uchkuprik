import { t } from '../i18n';
import { formatDateTime, formatMoney } from '../lib/format';
import type { Order } from '../lib/orders';
import { sheetStyle, type ReceiptLayout } from '../lib/receipt';

export type SheetBusiness = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  phone?: string | null;
  header?: string | null;
  footer?: string | null;
};

export type SheetData = {
  business: SheetBusiness;
  branch: { name: string; address: string | null };
  cashier: string | null;
  order: Order & {
    items: (Order['items'][number] & {
      components?: { name: string; quantity: number }[];
    })[];
  };
};

/**
 * The customer receipt exactly as it is printed: paper width, margins, font, spacing,
 * logo and visible fields all come from the template. The designer preview, the test
 * print and the real receipt use this one component, so they always look the same.
 */
export function ReceiptSheet({
  layout,
  data,
  className = '',
}: {
  layout: ReceiptLayout;
  data: SheetData;
  className?: string;
}) {
  const { business, branch, cashier, order } = data;
  const rows = order.items.filter((item) => item.status === 'ACTIVE');
  return (
    <div
      className={`receipt receipt-sheet ${className}`}
      style={sheetStyle(layout)}
    >
      {layout.showLogo && layout.logo && (
        <img
          className="receipt-logo"
          src={layout.logo}
          alt=""
          style={{
            width: `${layout.logoWidthPct}%`,
            marginLeft: layout.logoAlign === 'left' ? 0 : 'auto',
            marginRight: layout.logoAlign === 'right' ? 0 : 'auto',
          }}
        />
      )}
      {layout.title && <strong className="center block">{layout.title}</strong>}
      <header className="receipt-header">
        {layout.showBusinessName && <strong>{business.name}</strong>}
        {layout.showLegalName && business.legalName && (
          <div>{business.legalName}</div>
        )}
        {layout.showTaxId && business.taxId && (
          <div>STIR: {business.taxId}</div>
        )}
        {layout.showBranch && (
          <>
            <div>{branch.name}</div>
            {branch.address && <div>{branch.address}</div>}
          </>
        )}
        {layout.showPhone && business.phone && <div>{business.phone}</div>}
        {business.header && (
          <div className="receipt-note">{business.header}</div>
        )}
      </header>
      <div className="receipt-meta">
        {layout.showOrderNumber && (
          <span>
            {t.receipt.order} {t.orders.number}
            {order.number}
          </span>
        )}
        {layout.showDateTime && <span>{formatDateTime(order.createdAt)}</span>}
        {(layout.showOrderType || (layout.showTable && order.table)) && (
          <span>
            {layout.showOrderType ? t.pos.types[order.type] : ''}
            {layout.showTable && order.table
              ? `${layout.showOrderType ? ' · ' : ''}${order.table.name}`
              : ''}
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
          {rows.map((item) => (
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
                {layout.showNotes && item.note && (
                  <div className="small">! {item.note}</div>
                )}
                {layout.showItemUnitPrice && (
                  <div className="small">
                    {item.quantity} ×{' '}
                    {formatMoney(item.unitPrice + item.modifiersTotal)}
                  </div>
                )}
              </td>
              <td className="right">{formatMoney(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals">
        {layout.showDiscount && order.discountTotal > 0 && (
          <>
            <dt>{t.pos.discount}</dt>
            <dd>−{formatMoney(order.discountTotal)}</dd>
          </>
        )}
        {layout.showServiceCharge && order.serviceCharge > 0 && (
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
              {layout.showChange && payment.change ? (
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
        <div className="small">{t.receipt.notFiscal}</div>
      </footer>
    </div>
  );
}

/** Sample receipt for previews and test printing. */
export function sampleSheet(businessName = 'FAST FOOD'): SheetData {
  const now = new Date().toISOString();
  return {
    business: {
      name: businessName,
      legalName: '“Restoran” MChJ',
      taxId: '301234567',
      phone: '+998 90 000 00 00',
      header: null,
      footer: null,
    },
    branch: { name: 'Markaziy filial', address: 'Chilonzor, Bunyodkor 1' },
    cashier: 'Dilnoza',
    order: {
      id: 'sample',
      number: 15,
      type: 'DINE_IN',
      table: { id: 't', name: 'Stol 4' },
      createdAt: now,
      subtotal: 115_000,
      discountTotal: 5_000,
      serviceCharge: 0,
      total: 110_000,
      due: 0,
      items: [
        {
          id: '1',
          productName: 'Oila seti',
          variantName: 'Standart',
          unitPrice: 95_000,
          modifiers: [{ optionId: 'm', name: 'Achchiq sous', price: 0 }],
          modifiersTotal: 0,
          quantity: 1,
          lineTotal: 95_000,
          note: 'Piyozsiz',
          status: 'ACTIVE',
        },
        {
          id: '2',
          productName: 'Kola 0.5 L',
          variantName: 'Standart',
          unitPrice: 10_000,
          modifiers: [],
          modifiersTotal: 0,
          quantity: 2,
          lineTotal: 20_000,
          note: null,
          status: 'ACTIVE',
        },
      ],
      payments: [
        {
          id: 'p',
          method: 'CASH',
          amount: 110_000,
          tendered: 120_000,
          change: 10_000,
          reference: null,
          createdAt: now,
        },
      ],
    } as unknown as SheetData['order'],
  };
}
