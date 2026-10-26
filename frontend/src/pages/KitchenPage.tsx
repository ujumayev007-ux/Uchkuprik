import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBusy } from '../lib/busy';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { chime } from '../lib/realtime';
import { VoiceSettingsDialog } from '../components/VoiceSettingsDialog';
import { StockRequestsTab } from './StockRequestsTab';
import { useKitchenTheme } from '../lib/ordering';
import { KitchenStats, KitchenThemeDialog } from './KitchenThemes';

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
  kitchen?: {
    acceptedAt: string | null;
    acceptedBy: string | null;
    rejectedAt: string | null;
    rejectedBy: string | null;
    rejectReason: string | null;
  };
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
  template?: import('./StationTemplateDialog').TicketTemplate;
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

/** Where a ticket stands in the kitchen: new -> accepted -> preparing -> ready (or refused). */
type Stage = 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'REJECTED';
const STAGES: Stage[] = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'REJECTED'];

function stageOf(ticket: Ticket): Stage {
  if (ticket.kitchen?.rejectedAt) return 'REJECTED';
  if (ticket.status === 'READY') return 'READY';
  if (ticket.status === 'PREPARING') return 'PREPARING';
  // Orders sent before the kitchen confirmation existed count as accepted once started.
  return ticket.kitchen?.acceptedAt ? 'ACCEPTED' : 'NEW';
}

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

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('uz-UZ', {
    hour: '2-digit',
    minute: '2-digit',
  });

export function KitchenPage() {
  // The kitchen is never covered by advertisements (small banners only).
  useBusy('kitchen');
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
  const [requestOpen, setRequestOpen] = useState(false);
  const [refusing, setRefusing] = useState<Ticket | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const kitchenTheme = useKitchenTheme();
  const theme = kitchenTheme.theme;
  const now = useNow();
  // Correct for device clock drift using the server time of the last response.
  const skew = tickets.data
    ? new Date(tickets.data.serverTime).getTime() - tickets.dataUpdatedAt
    : 0;
  const canReject = can(me, 'kitchen.reject');

  useEffect(() => {
    if (!tickets.data) return;
    const ids = new Set(tickets.data.tickets.map((ticket) => ticket.orderId));
    if (known.current && [...ids].some((id) => !known.current!.has(id)))
      chime();
    known.current = ids;
  }, [tickets.data]);

  // A ticket nobody accepted is never forgotten: the chime repeats until someone does.
  const waiting = (tickets.data?.tickets ?? []).filter(
    (ticket) => stageOf(ticket) === 'NEW',
  ).length;
  useEffect(() => {
    if (waiting === 0) return;
    const timer = window.setInterval(chime, 20_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  // Overdue alert: one double chime when a ticket passes its preparation time.
  const late = useRef(new Set<string>());
  useEffect(() => {
    for (const ticket of tickets.data?.tickets ?? []) {
      if (
        ticket.status === 'READY' ||
        ticket.kitchen?.rejectedAt ||
        late.current.has(ticket.orderId)
      )
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

  const run = async (fn: () => Promise<unknown>, id?: string) => {
    // One press at a time per ticket: a double tap can not confirm twice.
    if (id) {
      if (busyId === id) return;
      setBusyId(id);
    }
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
      await client.invalidateQueries({ queryKey: ['kitchen'] });
    } finally {
      if (id) setBusyId(null);
    }
  };

  const bump = (ticket: Ticket, status: 'PREPARING' | 'READY') =>
    run(
      () =>
        post(`/kitchen/orders/${ticket.orderId}/bump`, {
          status,
          ...(stationId ? { stationId } : {}),
        }),
      ticket.orderId,
    );

  const renderTicket = (ticket: Ticket, stage: Stage) => {
    const limit =
      Math.max(...ticket.items.map((item) => item.prepTimeMinutes ?? 15)) *
      60_000;
    const age = now + skew - new Date(ticket.placedAt).getTime();
    const tone =
      stage === 'READY'
        ? 'ready'
        : stage === 'REJECTED'
          ? 'late'
          : age > limit
            ? 'late'
            : age > limit * 0.7
              ? 'warn'
              : 'ok';
    const accepted = stage !== 'NEW' && stage !== 'REJECTED';
    const pressing = busyId === ticket.orderId;
    return (
      <article
        key={ticket.orderId}
        className={`ticket ticket-${tone} ticket-stage-${stage.toLowerCase()} ${ticket.priority ? 'ticket-rush' : ''}`}
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
        {theme === 'smart' && stage !== 'READY' && stage !== 'REJECTED' && (
          <div
            className={`ticket-progress progress-${tone}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round((age / limit) * 100))}
          >
            <span style={{ width: `${Math.min(100, (age / limit) * 100)}%` }} />
          </div>
        )}
        <p className="ticket-source">
          {t.kitchen.orderTime}: {clock(ticket.placedAt)}
          {' · '}
          {ticket.waiter
            ? `👤 ${ticket.waiter}`
            : ticket.channel && ticket.channel !== 'POS'
              ? `📱 ${ticket.channel}`
              : '💳 Kassa'}
          {ticket.version && ticket.version > 1 ? ` · v${ticket.version}` : ''}
          {' · '}
          <strong>{t.kitchen.stages[stage]}</strong>
          {accepted && ticket.kitchen?.acceptedBy
            ? ` (${ticket.kitchen.acceptedBy})`
            : ''}
        </p>
        {ticket.priority > 0 && <Badge tone="danger">{t.kitchen.rush}</Badge>}
        {stage === 'REJECTED' && (
          <p className="ticket-note" role="alert">
            {t.kitchen.rejectedBecause}: {ticket.kitchen?.rejectReason}
            {ticket.kitchen?.rejectedBy
              ? ` — ${ticket.kitchen.rejectedBy}`
              : ''}
          </p>
        )}
        <ul className="ticket-items">
          {ticket.items.map((item) => (
            <li key={item.id}>
              <button
                className={`ticket-item item-${item.kitchenStatus.toLowerCase()}`}
                disabled={!accepted}
                onClick={() =>
                  void run(
                    () =>
                      post(`/kitchen/items/${item.id}/status`, {
                        status: nextStatus[item.kitchenStatus],
                      }),
                    ticket.orderId,
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
                  {accepted ? t.kitchen.items[item.kitchenStatus] : ''}
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
                          post(`/kitchen/items/${item.id}/cancel-request`, {
                            accept: true,
                          }),
                        )
                      }
                    >
                      {t.orderEdit.accept}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void run(() =>
                          post(`/kitchen/items/${item.id}/cancel-request`, {
                            accept: false,
                          }),
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
        <footer className="ticket-actions">
          {stage === 'REJECTED' ? (
            <span className="muted">{t.kitchen.rejectedHint}</span>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={accepted || pressing}
                onClick={() =>
                  void run(
                    () => post(`/kitchen/orders/${ticket.orderId}/accept`),
                    ticket.orderId,
                  )
                }
              >
                {t.kitchen.accept}
              </Button>
              <Button
                disabled={
                  !accepted ||
                  stage === 'PREPARING' ||
                  stage === 'READY' ||
                  pressing
                }
                onClick={() => void bump(ticket, 'PREPARING')}
              >
                {t.kitchen.start}
              </Button>
              <Button
                variant="primary"
                disabled={!accepted || stage === 'READY' || pressing}
                onClick={() => void bump(ticket, 'READY')}
              >
                {t.kitchen.ready}
              </Button>
              {canReject && stage !== 'READY' && (
                <Button
                  variant="danger"
                  disabled={pressing}
                  onClick={() => {
                    setReason('');
                    setRefusing(ticket);
                  }}
                >
                  {t.kitchen.reject}
                </Button>
              )}
              {stage === 'READY' &&
                (can(me, 'kitchen.access') || can(me, 'orders.edit')) && (
                  <Button
                    variant="primary"
                    onClick={() =>
                      void run(
                        () => post(`/orders/${ticket.orderId}/serve`),
                        ticket.orderId,
                      )
                    }
                  >
                    {t.kitchen.serve}
                  </Button>
                )}
            </>
          )}
        </footer>
      </article>
    );
  };

  return (
    <div className={`kds kds-theme-${theme}`}>
      <div className="kds-header">
        <h1>{t.kitchen.title}</h1>
        {kitchenTheme.canChange && (
          <button
            className="icon-button"
            aria-label={t.kitchenTheme.open}
            title={t.kitchenTheme.open}
            onClick={() => setThemeOpen(true)}
          >
            🎨
          </button>
        )}
        <button
          className="icon-button"
          aria-label={t.voice.title}
          title={t.voice.title}
          onClick={() => setVoiceOpen(true)}
        >
          🔊
        </button>
        <button
          className="icon-button"
          aria-label={t.stockRequests.new}
          title={t.stockRequests.new}
          onClick={() => setRequestOpen(true)}
        >
          📦
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
        <>
          {theme === 'smart' && (
            <KitchenStats
              tickets={tickets.data.tickets.map((ticket) => ({
                stage: stageOf(ticket),
                placedAt: ticket.placedAt,
                limitMs:
                  Math.max(
                    ...ticket.items.map((item) => item.prepTimeMinutes ?? 15),
                  ) * 60_000,
              }))}
              now={now + skew}
            />
          )}
          <div className="kds-stages" aria-label={t.kitchen.stagesTitle}>
            {STAGES.map((stage) => (
              <span
                key={stage}
                className={`kds-stage-count stage-${stage.toLowerCase()}`}
              >
                {t.kitchen.stages[stage]}:{' '}
                <strong>
                  {
                    tickets.data.tickets.filter((x) => stageOf(x) === stage)
                      .length
                  }
                </strong>
              </span>
            ))}
          </div>
          <div className="kds-board">
          {STAGES.map((stage) => {
            const list = tickets.data.tickets.filter(
              (ticket) => stageOf(ticket) === stage,
            );
            // Ustunli: every working column stays on screen, even when empty.
            const keepEmpty = theme === 'columns' && stage !== 'REJECTED';
            if (list.length === 0 && !keepEmpty) return null;
            return (
              <section key={stage} className="kds-section">
                <h2
                  className={`kds-section-title stage-${stage.toLowerCase()}`}
                >
                  {t.kitchen.stages[stage]} ({list.length})
                </h2>
                <div className="kds-grid">
                  {list.map((ticket) => renderTicket(ticket, stage))}
                </div>
              </section>
            );
          })}
          </div>
        </>
      )}
      <p className="muted small center">{t.kitchen.tapHint}</p>
      {refusing && (
        <Dialog
          open
          title={`${t.orders.number}${refusing.number}: ${t.kitchen.reject}`}
          description={t.kitchen.rejectAsk}
          onClose={() => setRefusing(null)}
          footer={
            <>
              <Button onClick={() => setRefusing(null)}>
                {t.common.cancel}
              </Button>
              <Button
                variant="danger"
                disabled={reason.trim().length < 2}
                onClick={() => {
                  const target = refusing;
                  setRefusing(null);
                  void run(
                    () =>
                      post(`/kitchen/orders/${target.orderId}/reject`, {
                        reason: reason.trim(),
                      }),
                    target.orderId,
                  );
                }}
              >
                {t.kitchen.reject}
              </Button>
            </>
          }
        >
          <TextField
            label={t.kitchen.rejectReason}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            autoFocus
          />
        </Dialog>
      )}
      {requestOpen && (
        <Dialog
          open
          wide
          title={t.stockRequests.new}
          onClose={() => setRequestOpen(false)}
        >
          <StockRequestsTab />
        </Dialog>
      )}
      {voiceOpen && <VoiceSettingsDialog onClose={() => setVoiceOpen(false)} />}
      {themeOpen && (
        <KitchenThemeDialog
          theme={theme}
          previous={kitchenTheme.previous}
          onChange={(next) => {
            kitchenTheme.change(next);
            toast(
              t.kitchenTheme.applied.replace(
                '{name}',
                t.kitchenTheme.names[next],
              ),
            );
          }}
          onClose={() => setThemeOpen(false)}
        />
      )}
    </div>
  );
}
