import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { chime } from '../lib/realtime';
import { VoiceSettingsDialog } from '../components/VoiceSettingsDialog';

type KitchenStatus = 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED';
type Ticket = {
  orderId: string;
  number: number;
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  status: string;
  priority: number;
  channel?: string;
  waiter?: string | null;
  version?: number;
  table: string | null;
  note: string | null;
  placedAt: string;
  items: {
    id: string;
    productName: string;
    variantName: string;
    modifiers: string[];
    quantity: number;
    note: string | null;
    kitchenStatus: KitchenStatus;
    prepTimeMinutes: number | null;
    prepStartedAt: string | null;
    cancelRequested?: { reason: string | null } | null;
  }[];
};
export type Station = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
};

export function useStations(enabled = true) {
  return useQuery({
    queryKey: ['kitchen', 'stations'],
    queryFn: () =>
      api<{ stations: Station[] }>('/kitchen/stations').then(
        (data) => data.stations,
      ),
    enabled,
  });
}

// One tap: preparing (yellow) -> ready (green); a second tap undoes it.
const nextStatus: Record<KitchenStatus, KitchenStatus> = {
  QUEUED: 'READY',
  PREPARING: 'READY',
  READY: 'PREPARING',
  SERVED: 'SERVED',
};

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function elapsed(fromIso: string, now: number) {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(fromIso).getTime()) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function KitchenPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const stations = useStations();
  const [stationId, setStationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ff-station');
    } catch {
      return null;
    }
  });
  const tickets = useQuery({
    queryKey: ['kitchen', 'tickets', me?.activeBranchId, stationId],
    queryFn: () =>
      api<{ serverTime: string; tickets: Ticket[] }>(
        `/kitchen/tickets${stationId ? `?stationId=${stationId}` : ''}`,
      ),
    enabled: !!me?.activeBranchId,
    refetchInterval: 20_000,
  });
  const known = useRef<Set<string> | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const now = useNow();
  // Correct for device clock drift using the server time of the last response.
  const skew = tickets.data
    ? new Date(tickets.data.serverTime).getTime() - tickets.dataUpdatedAt
    : 0;

  useEffect(() => {
    if (!tickets.data) return;
    const ids = new Set(tickets.data.tickets.map((ticket) => ticket.orderId));
    if (known.current && [...ids].some((id) => !known.current!.has(id)))
      chime();
    known.current = ids;
  }, [tickets.data]);

  // Overdue alert: one double chime when a ticket passes its preparation time.
  const late = useRef(new Set<string>());
  useEffect(() => {
    for (const ticket of tickets.data?.tickets ?? []) {
      if (ticket.status === 'READY' || late.current.has(ticket.orderId))
        continue;
      const limit =
        Math.max(...ticket.items.map((item) => item.prepTimeMinutes ?? 15)) *
        60_000;
      if (now + skew - new Date(ticket.placedAt).getTime() > limit) {
        late.current.add(ticket.orderId);
        chime();
        setTimeout(chime, 700);
      }
    }
  }, [now, skew, tickets.data]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };

  return (
    <div className="kds">
      <div className="kds-header">
        <h1>{t.kitchen.title}</h1>
        <button
          className="icon-button"
          aria-label={t.voice.title}
          title={t.voice.title}
          onClick={() => setVoiceOpen(true)}
        >
          🔊
        </button>
        <div className="chip-row">
          <button
            className={`chip ${!stationId ? 'active' : ''}`}
            onClick={() => setStationId(null)}
          >
            {t.kitchen.allStations}
          </button>
          {(stations.data ?? [])
            .filter((station) => station.isActive)
            .map((station) => (
              <button
                key={station.id}
                className={`chip ${stationId === station.id ? 'active' : ''}`}
                onClick={() => {
                  setStationId(station.id);
                  try {
                    localStorage.setItem('ff-station', station.id);
                  } catch {
                    /* Remembering the station is a convenience only. */
                  }
                }}
              >
                {station.name}
              </button>
            ))}
        </div>
      </div>
      {tickets.isPending ? (
        <LoadingState />
      ) : tickets.error ? (
        <ErrorState
          error={tickets.error}
          onRetry={() => void tickets.refetch()}
        />
      ) : tickets.data.tickets.length === 0 ? (
        <EmptyState title={t.kitchen.noTickets} />
      ) : (
        <div
          className={`kds-grid kds-n-${Math.min(tickets.data.tickets.length, 5)}`}
        >
          {tickets.data.tickets.map((ticket) => {
            const limit =
              Math.max(
                ...ticket.items.map((item) => item.prepTimeMinutes ?? 15),
              ) * 60_000;
            const age = now + skew - new Date(ticket.placedAt).getTime();
            const allReady =
              ticket.status === 'READY' ||
              ticket.items.every((item) => item.kitchenStatus === 'READY');
            const tone = allReady
              ? 'ready'
              : age > limit
                ? 'late'
                : age > limit * 0.7
                  ? 'warn'
                  : 'ok';
            return (
              <article
                key={ticket.orderId}
                className={`ticket ticket-${tone} ${ticket.priority ? 'ticket-rush' : ''}`}
                aria-label={`${t.orders.number}${ticket.number}`}
              >
                <header>
                  <strong className="ticket-number">
                    {t.orders.number}
                    {ticket.number}
                  </strong>
                  <span className="ticket-meta">
                    {t.pos.types[ticket.type]}
                    {ticket.table && ` · ${ticket.table}`}
                  </span>
                  <time className="ticket-timer" title={t.kitchen.elapsed}>
                    {elapsed(ticket.placedAt, now + skew)}
                  </time>
                </header>
                <p className="ticket-source">
                  {ticket.waiter
                    ? `👤 ${ticket.waiter}`
                    : ticket.channel && ticket.channel !== 'POS'
                      ? `📱 ${ticket.channel}`
                      : ''}
                  {ticket.version && ticket.version > 1
                    ? ` · v${ticket.version}`
                    : ''}
                  {' · '}
                  <strong>
                    {allReady
                      ? t.kitchen.items.READY
                      : t.kitchen.items.PREPARING}
                  </strong>
                </p>
                {ticket.priority > 0 && (
                  <Badge tone="danger">{t.kitchen.rush}</Badge>
                )}
                <ul className="ticket-items">
                  {ticket.items.map((item) => (
                    <li key={item.id}>
                      <button
                        className={`ticket-item item-${item.kitchenStatus.toLowerCase()}`}
                        onClick={() =>
                          void run(() =>
                            post(`/kitchen/items/${item.id}/status`, {
                              status: nextStatus[item.kitchenStatus],
                            }),
                          )
                        }
                        aria-label={`${item.quantity} × ${item.productName}: ${t.kitchen.items[item.kitchenStatus]}`}
                      >
                        <span className="qty">{item.quantity}×</span>
                        <span>
                          <strong>{item.productName}</strong>
                          {item.variantName !== 'Standart' && (
                            <span className="muted"> {item.variantName}</span>
                          )}
                          {item.modifiers.length > 0 && (
                            <small className="block">
                              + {item.modifiers.join(', ')}
                            </small>
                          )}
                          {item.note && (
                            <small className="block note">! {item.note}</small>
                          )}
                        </span>
                        <span className="item-state">
                          {t.kitchen.items[item.kitchenStatus]}
                        </span>
                      </button>
                      {item.cancelRequested && (
                        <div className="cancel-request" role="alert">
                          <strong>⚠ {t.orderEdit.cookTitle}</strong>
                          {item.cancelRequested.reason && (
                            <span> — {item.cancelRequested.reason}</span>
                          )}
                          <div className="toolbar">
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() =>
                                void run(() =>
                                  post(
                                    `/kitchen/items/${item.id}/cancel-request`,
                                    { accept: true },
                                  ),
                                )
                              }
                            >
                              {t.orderEdit.accept}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() =>
                                void run(() =>
                                  post(
                                    `/kitchen/items/${item.id}/cancel-request`,
                                    { accept: false },
                                  ),
                                )
                              }
                            >
                              {t.orderEdit.refuse}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {ticket.note && <p className="ticket-note">{ticket.note}</p>}
                <footer>
                  {ticket.status !== 'READY' ? (
                    <>
                      <Button
                        onClick={() =>
                          void run(() =>
                            post(`/kitchen/orders/${ticket.orderId}/bump`, {
                              status: 'PREPARING',
                              ...(stationId ? { stationId } : {}),
                            }),
                          )
                        }
                      >
                        {t.kitchen.start}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() =>
                          void run(() =>
                            post(`/kitchen/orders/${ticket.orderId}/bump`, {
                              status: 'READY',
                              ...(stationId ? { stationId } : {}),
                            }),
                          )
                        }
                      >
                        {t.kitchen.ready}
                      </Button>
                    </>
                  ) : (
                    (can(me, 'kitchen.access') || can(me, 'orders.edit')) && (
                      <Button
                        variant="primary"
                        onClick={() =>
                          void run(() =>
                            post(`/orders/${ticket.orderId}/serve`),
                          )
                        }
                      >
                        {t.kitchen.serve}
                      </Button>
                    )
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      <p className="muted small center">{t.kitchen.tapHint}</p>
      {voiceOpen && <VoiceSettingsDialog onClose={() => setVoiceOpen(false)} />}
    </div>
  );
}
