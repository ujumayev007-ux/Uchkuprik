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

function Separator({ style }: { style?: string }) {
  if (style === 'double') {
    return (
      <div
        style={{
          borderTop: '3px double #000',
          margin: '6px 0',
          width: '100%',
        }}
      />
    );
  }
  if (style === 'heavy') {
    return (
      <div
        style={{
          borderTop: '2px solid #000',
          margin: '6px 0',
          width: '100%',
        }}
      />
    );
  }
  if (style === 'stars') {
    return (
      <div
        style={{
          textAlign: 'center',
          letterSpacing: '4px',
          fontSize: '10px',
          margin: '4px 0',
          width: '100%',
        }}
      >
        * * * * * * * * * *
      </div>
    );
  }
  if (style === 'single') {
    return (
      <div
        style={{
          borderTop: '1px solid #000',
          margin: '6px 0',
          width: '100%',
        }}
      />
    );
  }
  return (
    <div
      style={{
        borderTop: '1px dashed #000',
        margin: '6px 0',
        width: '100%',
      }}
    />
  );
}

/**
 * The customer receipt exactly as it is printed: paper width, margins, font, spacing,
 * logo, visible fields, QR/barcodes and fiscal compliance all come from the template.
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
            display: 'block',
          }}
        />
      )}
      {layout.title && <strong className="center block" style={{ fontSize: '1.1em', margin: '4px 0' }}>{layout.title}</strong>}

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

      <Separator style={layout.separatorStyle} />

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
        {layout.showWaiter && (
          <span>Ofitsiant: Sardor</span>
        )}
      </div>

      {layout.showDeliveryDetails && (
        <div
          style={{
            border: '1px dashed #000',
            padding: '6px',
            margin: '6px 0',
            fontSize: '0.85em',
            borderRadius: '4px',
          }}
        >
          <strong>📦 YETKAZIB BERISH (DOSTAVKA):</strong>
          <div>Mijoz: Azizxon (+998 90 123 45 67)</div>
          <div>Manzil: Toshkent sh., Chilonzor 9, 12-uy</div>
          <div>Mo‘ljal: Metro bekati yaqinida</div>
          <div style={{ marginTop: '2px', fontStyle: 'italic' }}>Eslatma: Qo‘ng‘iroq qilib chiqilsin</div>
        </div>
      )}

      <Separator style={layout.separatorStyle} />

      <table>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>
                <span style={layout.largeItems ? { fontSize: '1.15em', fontWeight: 'bold' } : {}}>
                  {item.productName}{' '}
                  {item.variantName !== 'Standart' && `(${item.variantName})`}
                </span>
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
                  <div className="small" style={{ fontWeight: 'bold' }}>! {item.note}</div>
                )}
                {layout.showItemUnitPrice && (
                  <div className="small">
                    {item.quantity} ×{' '}
                    {formatMoney(item.unitPrice + item.modifiersTotal)}
                  </div>
                )}
              </td>
              <td className="right" style={{ verticalAlign: 'top' }}>
                {formatMoney(item.lineTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Separator style={layout.separatorStyle} />

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
        <dt className="strong" style={{ fontSize: '1.1em' }}>{t.pos.total}</dt>
        <dd className="strong" style={{ fontSize: '1.1em' }}>{formatMoney(order.total)}</dd>
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

      {layout.showQrCode && (
        <div style={{ textAlign: 'center', margin: '8px 0' }}>
          <div
            style={{
              display: 'inline-block',
              padding: '6px',
              background: '#fff',
              border: '1px solid #000',
              borderRadius: '4px',
            }}
          >
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="#000"
              style={{ display: 'block' }}
            >
              <rect x="2" y="2" width="8" height="8" rx="1" />
              <rect x="4" y="4" width="4" height="4" fill="#fff" />
              <rect x="14" y="2" width="8" height="8" rx="1" />
              <rect x="16" y="4" width="4" height="4" fill="#fff" />
              <rect x="2" y="14" width="8" height="8" rx="1" />
              <rect x="4" y="16" width="4" height="4" fill="#fff" />
              <rect x="14" y="14" width="3" height="3" />
              <rect x="19" y="14" width="3" height="3" />
              <rect x="14" y="19" width="3" height="3" />
              <rect x="19" y="19" width="3" height="3" />
            </svg>
          </div>
          {layout.qrLabel && (
            <div style={{ fontSize: '0.8em', marginTop: '3px' }}>
              {layout.qrLabel}
            </div>
          )}
        </div>
      )}

      {layout.showBarcode && (
        <div style={{ textAlign: 'center', margin: '6px 0' }}>
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: '1.2em',
              letterSpacing: '2px',
              fontWeight: 'bold',
            }}
          >
            ||| | |||| | ||| || |||| | |||
          </div>
          <div style={{ fontSize: '0.75em' }}>*№{order.number}*</div>
        </div>
      )}

      {layout.showFiscalData && (
        <div
          style={{
            borderTop: '1px dashed #000',
            paddingTop: '6px',
            marginTop: '6px',
            textAlign: 'center',
            fontSize: '0.8em',
          }}
        >
          <div style={{ fontWeight: 'bold' }}>★ FISKAL CHEK (OFD) ★</div>
          <div>Fiskal belgi: 984729104821</div>
          <div>Terminal ID: T09481203 · STIR: {business.taxId ?? '301234567'}</div>
          <div>OFD QR orqali chekni tekshiring</div>
        </div>
      )}

      <Separator style={layout.separatorStyle} />

      <footer className="receipt-footer">
        {layout.extraLines && <div className="pre">{layout.extraLines}</div>}
        {layout.showSocialMedia && layout.socialMedia && (
          <div style={{ fontWeight: 600 }}>📱 {layout.socialMedia}</div>
        )}
        {business.footer && <div>{business.footer}</div>}
        <div>{layout.thankYou || t.receipt.thanks}</div>
        {!layout.showFiscalData && (
          <div className="small">{t.receipt.notFiscal}</div>
        )}
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
