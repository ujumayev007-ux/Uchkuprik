import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

export type QrPayment = {
  enabled: boolean;
  provider: 'PAYNET' | 'CLICK' | 'PAYME' | 'UZUM' | 'OTHER';
  label: string;
  payload: string;
  image: string;
  instructions: string;
  requireReference: boolean;
};

export function useQrPayment() {
  return useQuery({
    queryKey: ['qr-payment'],
    queryFn: () => api<QrPayment>('/settings/qr-payment'),
    staleTime: 5 * 60_000,
  });
}

/** Big merchant QR with the amount, for the customer to scan in Paynet (or similar). */
export function QrPayPanel({ qr, amount }: { qr: QrPayment; amount: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (qr.image || !qr.payload) return;
    let cancelled = false;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(qr.payload, { type: 'svg', margin: 1, width: 280 }),
      )
      .then((value) => {
        if (!cancelled) setSvg(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [qr.image, qr.payload]);
  return (
    <div className="qr-pay">
      {qr.image ? (
        <img src={qr.image} alt={qr.label} className="qr-pay-code" />
      ) : svg ? (
        <div
          className="qr-pay-code"
          // Generated locally by the qrcode library from the owner's QR text.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
      <strong className="qr-pay-amount">{formatMoney(amount)}</strong>
      <p>{qr.instructions}</p>
      <p className="muted small">{t.qrPay.cashierHint}</p>
    </div>
  );
}
