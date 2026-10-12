import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { Button, Dialog } from './ui';

/** Printable table card with the QR code that opens the table's online menu. */
export function TableQrDialog({
  tableName,
  token,
  onClose,
}: {
  tableName: string;
  token: string;
  onClose: () => void;
}) {
  const url = `${window.location.origin}/t/${token}`;
  const [svg, setSvg] = useState('');
  useEffect(() => {
    // QR codes are generated locally; the table token never goes to a third party.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(url, { type: 'svg', margin: 1, width: 260 }),
      )
      .then(setSvg);
  }, [url]);
  const print = () => {
    const popup = window.open('', '_blank', 'width=420,height=560');
    if (!popup) return;
    // Built with DOM APIs (not string HTML) so table names cannot inject markup.
    const doc = popup.document;
    doc.title = `${t.online.qrTitle} ${tableName}`;
    const card = doc.createElement('div');
    card.style.cssText =
      'font-family:sans-serif;text-align:center;padding:24px';
    const heading = doc.createElement('h1');
    heading.textContent = `${t.online.table} ${tableName}`;
    const image = doc.createElement('img');
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    image.width = 260;
    const caption = doc.createElement('p');
    caption.textContent = t.online.scanToOrder;
    card.append(heading, image, caption);
    doc.body.append(card);
    setTimeout(() => popup.print(), 300);
  };
  return (
    <Dialog open title={`${t.online.qrTitle}: ${tableName}`} onClose={onClose}>
      <div className="stack center">
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
        <Button variant="primary" disabled={!svg} onClick={print}>
          {t.online.printQr}
        </Button>
      </div>
    </Dialog>
  );
}
