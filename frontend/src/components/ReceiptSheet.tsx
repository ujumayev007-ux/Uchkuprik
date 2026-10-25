import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { formatDateTime, formatMoney } from '../lib/format';
import type { Order } from '../lib/orders';
import { sheetStyle, type ReceiptLayout } from '../lib/receipt';

/** A real, scannable QR code (SVG), made in the browser. */
function QrCode({ text, size = 96 }: { text: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    void import('qrcode')
      .then((QRCode) =>
        QRCode.toString(text, { type: 'svg', margin: 0, width: size }),
      )
      .then((markup) => alive && setSvg(markup))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [text, size]);
  return (
    <div
      style={{ width: size, height: size, margin: '0 auto' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// Code 39 (digits only): 9 elements per character, 1 = wide; bars and spaces alternate.
const CODE39: Record<string, string> = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100', '*': '010010100',
};

/** A real Code 39 barcode of the order number (what scanners read). */
function Barcode({ value }: { value: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const char of `*${value}*`) {
    const pattern = CODE39[char];
    if (!pattern) continue;
    [...pattern].forEach((bit, i) => {
      const w = bit === '1' ? 3 : 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    });
    x += 1; // narrow gap between characters
  }
  return (
    <svg
      viewBox={`0 0 ${x} 40`}
      preserveAspectRatio="none"
      style={{ width: '90%', height: 40, display: 'block', margin: '0 auto' }}
    >
      {bars.map((bar, i) => (
        <rect key={i} x={bar.x} y={0} width={bar.w} height={40} fill="#000" />
      ))}
    </svg>
  );
}

/** Text of a Wi-Fi QR code that phones join by scanning. */
const wifiQrText = (name: string, password: string) => {
  const esc = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
  return password
    ? `WIFI:T:WPA;S:${esc(name)};P:${esc(password)};;`
    : `WIFI:T:nopass;S:${esc(name)};;`;
};

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
  // Who opened the order when it was a waiter.
  waiter?: string | null;
  // 0 = the first receipt of the order; 1, 2 … = printed again ("NUSXA").
  copy?: number;
  // Real fiscal data, present only after a certified provider registered the receipt.
  fiscal?: {
    status: string;
    fiscalSign: string | null;
    qrUrl: string | null;
  } | null;
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
  const bigNumber = layout.largeOrderNumber && layout.showOrderNumber;
  const itemCount = rows.reduce((sum, item) => sum + item.quantity, 0);
  const vat =
    layout.showVat && layout.vatPercent > 0
      ? Math.round((order.total * layout.vatPercent) / (100 + layout.vatPercent))
      : 0;
  const fiscalSign = data.fiscal?.fiscalSign ?? null;

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

      {layout.showCopyMark && (data.copy ?? 0) > 0 && (
        <div
          className="center"
          style={{
            fontSize: '1.6em',
            fontWeight: 800,
            letterSpacing: '4px',
            border: '2px solid #000',
            margin: '6px 0',
          }}
        >
          NUSXA
        </div>
      )}

      <Separator style={layout.separatorStyle} />

      {bigNumber && (
        <div
          className="center"
          style={{ fontSize: '2.6em', fontWeight: 800, lineHeight: 1.1 }}
        >
          {t.orders.number}
          {order.number}
        </div>
      )}

      <div className="receipt-meta">
        {layout.showOrderNumber && !bigNumber && (
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
        {layout.showWaiter && data.waiter && (
          <span>Ofitsiant: {data.waiter}</span>
        )}
        {layout.showCustomer && (order.customerName || order.customerPhone) && (
          <span>
            Mijoz:{' '}
            {[order.customerName, order.customerPhone]
              .filter(Boolean)
              .join(', ')}
          </span>
        )}
      </div>

      {layout.showDeliveryDetails && order.deliveryAddress && (
        <div
          style={{
            border: '1px dashed #000',
            padding: '6px',
            margin: '6px 0',
            fontSize: '0.85em',
            borderRadius: '4px',
          }}
        >
          <strong>📦 YETKAZIB BERISH</strong>
          <div>Manzil: {order.deliveryAddress}</div>
          {order.note && (
            <div style={{ marginTop: '2px', fontStyle: 'italic' }}>
              Eslatma: {order.note}
            </div>
          )}
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

      {layout.showItemCount && (
        <div className="receipt-meta" style={{ justifyContent: 'space-between' }}>
          <span>Taomlar soni</span>
          <span>{itemCount}</span>
        </div>
      )}

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
        {vat > 0 && (
          <>
            <dt className="small">Shu jumladan QQS {layout.vatPercent}%</dt>
            <dd className="small">{formatMoney(vat)}</dd>
          </>
        )}
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

      {layout.showWifi && layout.wifiName && (
        <div style={{ textAlign: 'center', margin: '8px 0' }}>
          <div style={{ fontWeight: 600 }}>📶 Wi-Fi: {layout.wifiName}</div>
          {layout.wifiPassword && <div>Parol: {layout.wifiPassword}</div>}
          {layout.wifiQr && (
            <div style={{ marginTop: '4px' }}>
              <QrCode text={wifiQrText(layout.wifiName, layout.wifiPassword)} />
            </div>
          )}
        </div>
      )}

      {layout.showQrCode && layout.qrContent && (
        <div style={{ textAlign: 'center', margin: '8px 0' }}>
          <QrCode text={layout.qrContent} />
          {layout.qrLabel && (
            <div style={{ fontSize: '0.8em', marginTop: '3px' }}>
              {layout.qrLabel}
            </div>
          )}
        </div>
      )}

      {layout.showBarcode && (
        <div style={{ textAlign: 'center', margin: '6px 0' }}>
          <Barcode value={String(order.number).padStart(8, '0')} />
          <div style={{ fontSize: '0.75em' }}>{String(order.number).padStart(8, '0')}</div>
        </div>
      )}

      {/* Real fiscal data only: a receipt the fiscal provider has not registered shows none. */}
      {layout.showFiscalData && fiscalSign && (
        <div
          style={{
            borderTop: '1px dashed #000',
            paddingTop: '6px',
            marginTop: '6px',
            textAlign: 'center',
            fontSize: '0.8em',
          }}
        >
          <div style={{ fontWeight: 'bold' }}>FISKAL CHEK</div>
          {business.taxId && <div>STIR: {business.taxId}</div>}
          <div>Fiskal belgi: {fiscalSign}</div>
          {data.fiscal?.qrUrl && (
            <div style={{ marginTop: '4px' }}>
              <QrCode text={data.fiscal.qrUrl} />
            </div>
          )}
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
        {!fiscalSign && (
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
    // Preview only: shows where these lines appear on a real receipt.
    waiter: 'Ofitsiant',
    fiscal: { status: 'SAMPLE', fiscalSign: 'NAMUNA', qrUrl: null },
    order: {
      id: 'sample',
      number: 15,
      type: 'DINE_IN',
      table: { id: 't', name: 'Stol 4' },
      customerName: 'Mijoz',
      customerPhone: '+998 90 000 00 00',
      deliveryAddress: 'Manzil (yetkazib berishda)',
      note: null,
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
