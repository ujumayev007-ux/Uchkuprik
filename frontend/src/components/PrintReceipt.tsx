import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import { Button, useToast } from './ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';

/**
 * Receipt buttons: open the receipt in the browser (laid out by the template of the
 * chosen printer, or the restaurant default) or send it straight to a receipt printer.
 */
export function PrintReceipt({ orderId }: { orderId: string }) {
  const { data: me } = useMe();
  const toast = useToast();
  const branchId = me?.activeBranchId;
  const [printerId, setPrinterId] = useState('');
  const printers = useQuery({
    queryKey: ['receipt-printers', branchId],
    queryFn: () =>
      api<{ printers: { id: string; name: string }[] }>(
        `/receipt-printers${branchId ? `?branchId=${branchId}` : ''}`,
      ).then((data) => data.printers),
    enabled: !!branchId,
    staleTime: 60_000,
    retry: false,
  });
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
        onClick={() =>
          window.open(
            `/chek/${orderId}${printerId ? `?printer=${printerId}` : ''}`,
            '_blank',
            'noopener,width=420,height=700',
          )
        }
      >
        {t.payment.printReceipt}
      </Button>
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
