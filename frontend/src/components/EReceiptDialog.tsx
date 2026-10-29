import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { errorMessage, post } from '../lib/api';
import { Button, Dialog, useToast } from './ui';

const e = t.eReceipt;

/**
 * Elektron chek: the order's public page behind an unguessable link, shown as a QR code
 * the guest scans, a link to copy, or a Telegram share.
 */
export function EReceiptButton({ orderId }: { orderId: string }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [svg, setSvg] = useState('');
  useEffect(() => {
    if (!url) return;
    // Made locally; the link never goes to a third-party QR service.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(url, { type: 'svg', margin: 1, width: 240 }),
      )
      .then(setSvg);
  }, [url]);
  return (
    <>
      <Button
        onClick={async () => {
          try {
            const result = await post<{ path: string }>(
              `/orders/${orderId}/e-receipt`,
              {},
            );
            setUrl(`${window.location.origin}${result.path}`);
          } catch (caught) {
            toast(errorMessage(caught), 'error');
          }
        }}
      >
        {e.button}
      </Button>
      {url && (
        <Dialog
          open
          title={e.title}
          onClose={() => {
            setUrl(null);
            setSvg('');
          }}
        >
          <div className="stack center">
            <p className="muted small">{e.hint}</p>
            <div
              className="qr"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <a
              className="text-link center break"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
            <div className="toolbar">
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    toast(e.copied);
                  } catch (caught) {
                    toast(errorMessage(caught), 'error');
                  }
                }}
              >
                {e.copy}
              </Button>
              <a
                className="btn btn-secondary"
                href={`https://t.me/share/url?url=${encodeURIComponent(url)}`}
                target="_blank"
                rel="noreferrer"
              >
                {e.telegram}
              </a>
              <Button
                onClick={async () => {
                  try {
                    await post(`/orders/${orderId}/e-receipt/telegram`);
                    toast(e.botSent);
                  } catch (caught) {
                    toast(errorMessage(caught), 'error');
                  }
                }}
              >
                {e.botSend}
              </Button>
            </div>
            <p className="muted small">{e.lanWarning}</p>
          </div>
        </Dialog>
      )}
    </>
  );
}
