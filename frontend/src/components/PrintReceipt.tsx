import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import { EReceiptButton } from './EReceiptDialog';
import { Button, useToast } from './ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { useBusy } from '../lib/busy';
import { printOnTerminal, terminalPrinter } from './TerminalPrinter';

function useReceiptPrinters() {
  const { data: me } = useMe();
  const branchId = me?.activeBranchId;
  return useQuery({
    queryKey: ['receipt-printers', branchId],
    queryFn: () =>
      api<{ printers: { id: string; name: string }[] }>(
        `/receipt-printers${branchId ? `?branchId=${branchId}` : ''}`,
      ).then((data) => data.printers),
    enabled: !!branchId,
    staleTime: 60_000,
    retry: false,
  });
}

/** Qaytarish cheki of one refund on a receipt printer (again, marked NUSXA). */
export function RefundPrintButton({
  orderId,
  refundId,
}: {
  orderId: string;
  refundId: string;
}) {
  const toast = useToast();
  const printers = useReceiptPrinters();
  const first = printers.data?.[0];
  if (!first) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await post(`/orders/${orderId}/refunds/${refundId}/print`, {
            printerId: first.id,
          });
          toast(t.printRules.refundPrinted);
        } catch (caught) {
          toast(errorMessage(caught), 'error');
        }
      }}
    >
      {t.printRules.refundPrint} · {first.name}
    </Button>
  );
}

/**
 * Receipt buttons: open the receipt in the browser (laid out by the template of the
 * chosen printer, or the restaurant default) or send it straight to a receipt printer.
 */
export function PrintReceipt({ orderId }: { orderId: string }) {
  // Printing is never interrupted.
  useBusy('print');
  const toast = useToast();
  const [printerId, setPrinterId] = useState('');
  const printers = useReceiptPrinters();
  const list = printers.data ?? [];
  return (
    <>
      {list.length > 0 && (
        <select
          aria-label={t.receiptTpl.printTo}
          value={printerId}
          onChange={(event) => setPrinterId(event.target.value)}
        >
          <option value="">{t.receiptTpl.printerDefault}</option>
          {list.map((printer) => (
            <option key={printer.id} value={printer.id}>
              {printer.name}
            </option>
          ))}
        </select>
      )}
      <Button
        onClick={async () => {
          // Kassa application: straight to this terminal's own Windows printer.
          if (terminalPrinter() && !printerId) {
            try {
              await printOnTerminal(orderId);
              toast(t.terminalPrinter.printed);
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
            return;
          }
          window.open(
            `/chek/${orderId}${printerId ? `?printer=${printerId}` : ''}`,
            '_blank',
            'noopener,width=420,height=700',
          );
        }}
      >
        {t.payment.printReceipt}
      </Button>
      <EReceiptButton orderId={orderId} />
      {printerId && (
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await post(`/orders/${orderId}/receipt/print`, { printerId });
              toast(t.receiptTpl.printSent);
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
          }}
        >
          {t.receiptTpl.printTo}
        </Button>
      )}
    </>
  );
}
