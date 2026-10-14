import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  EmptyState,
  FormError,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const r = t.stockRequests;

export type StockRequest = {
  id: string;
  items: { stockItemId: string; quantity: string; unitName: string }[];
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FULFILLED';
  requestedBy: string | null;
  comment: string | null;
  createdAt: string;
};

export function useStockRequests(status?: StockRequest['status']) {
  return useQuery({
    queryKey: ['inventory', 'requests', status ?? 'all'],
    queryFn: () =>
      api<{ requests: StockRequest[] }>(
        `/inventory/requests${status ? `?status=${status}` : ''}`,
      ).then((data) => data.requests),
  });
}

const tone = {
  PENDING: 'warning',
  APPROVED: 'accent',
  REJECTED: 'danger',
  FULFILLED: 'success',
} as const;

/** Stock requests: staff ask, managers approve; approved ones feed Bozorlik. */
export function StockRequestsTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const items = useQuery({
    queryKey: ['inventory', 'item-names'],
    queryFn: () =>
      api<{
        items: {
          id: string;
          name: string;
          unitLabel: string;
          units: string[];
        }[];
      }>('/inventory/item-names').then((data) => data.items),
  });
  const requests = useStockRequests();
  const manage = can(me, 'inventory.manage') || can(me, 'purchasing.manage');
  const list = items.data ?? [];
  const nameOf = (id: string) =>
    (items.data ?? []).find((item) => item.id === id)?.name ?? '?';
  const [lines, setLines] = useState([
    { stockItemId: '', quantity: '', unitName: '' },
  ]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['inventory', 'requests'] });
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      await refresh();
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  const unitsFor = (id: string) => {
    const item = list.find((candidate) => candidate.id === id);
    return item ? [item.unitLabel, ...item.units] : [];
  };

  return (
    <div className="stack">
      <form
        className="card stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await post('/inventory/requests', {
              items: lines.filter((line) => line.stockItemId && line.quantity),
              note: note || null,
            });
            setLines([{ stockItemId: '', quantity: '', unitName: '' }]);
            setNote('');
            toast(r.sent);
            await refresh();
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        <h2 className="section-title">📦 {r.new}</h2>
        {lines.map((line, index) => (
          <div key={index} className="purchase-row">
            <SelectField
              label={t.market.product}
              value={line.stockItemId}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index
                      ? {
                          ...l,
                          stockItemId: e.target.value,
                          unitName: unitsFor(e.target.value)[0] ?? '',
                        }
                      : l,
                  ),
                )
              }
            >
              <option value="">—</option>
              {list.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t.market.quantity}
              inputMode="decimal"
              value={line.quantity}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index
                      ? { ...l, quantity: e.target.value.replace(',', '.') }
                      : l,
                  ),
                )
              }
            />
            <SelectField
              label={t.market.unit}
              value={line.unitName}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, unitName: e.target.value } : l,
                  ),
                )
              }
            >
              {unitsFor(line.stockItemId).map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </SelectField>
          </div>
        ))}
        <div className="toolbar">
          <Button
            size="sm"
            onClick={() =>
              setLines([
                ...lines,
                { stockItemId: '', quantity: '', unitName: '' },
              ])
            }
          >
            + {t.market.addLine}
          </Button>
          {manage && (
            <Button
              size="sm"
              onClick={() =>
                void act(async () => {
                  const result = await post<{ items: number }>(
                    '/inventory/requests/from-alerts',
                  );
                  toast(
                    result.items
                      ? r.fromAlertsDone.replace('{n}', String(result.items))
                      : r.noAlerts,
                  );
                })
              }
            >
              ⚠ {r.fromAlerts}
            </Button>
          )}
        </div>
        <TextField
          label={t.market.note}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <FormError error={error} />
        <div className="form-actions">
          <Button type="submit" variant="primary">
            {r.send}
          </Button>
        </div>
      </form>

      {(requests.data ?? []).length === 0 ? (
        <EmptyState title={r.empty} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.market.date}</th>
                <th>{t.market.products}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(requests.data ?? []).map((request) => (
                <tr key={request.id}>
                  <td className="nowrap">
                    {formatDateTime(request.createdAt)}
                    <small className="muted block">{request.requestedBy}</small>
                  </td>
                  <td className="small">
                    {request.items
                      .map(
                        (item) =>
                          `${nameOf(item.stockItemId)} ${Number(item.quantity)} ${item.unitName}`,
                      )
                      .join(', ')}
                    {request.note && (
                      <small className="muted block">{request.note}</small>
                    )}
                  </td>
                  <td>
                    <Badge tone={tone[request.status]}>
                      {r.statuses[request.status]}
                    </Badge>
                  </td>
                  <td className="right">
                    {manage && request.status === 'PENDING' && (
                      <div className="toolbar">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            void act(() =>
                              post(`/inventory/requests/${request.id}/decide`, {
                                decision: 'APPROVED',
                              }),
                            )
                          }
                        >
                          {r.approve}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() =>
                            void act(() =>
                              post(`/inventory/requests/${request.id}/decide`, {
                                decision: 'REJECTED',
                                comment: window.prompt(r.rejectWhy) ?? null,
                              }),
                            )
                          }
                        >
                          {r.reject}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
