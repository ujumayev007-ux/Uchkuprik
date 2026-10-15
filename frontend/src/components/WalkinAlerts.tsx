import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '../auth/session';
import { Button } from './ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import {
  androidAlertStatus,
  androidBridge,
  type AlertStatus,
} from '../lib/android';
import type { Order } from '../lib/orders';
import { useRealtimeEvent } from '../lib/realtime';
import { formatOrderNo, walkinAnnouncement } from '../lib/uzbek-number';
import { speak } from '../lib/voice';

const SEEN_KEY = 'ff-walkin-seen';
const SEEN_TTL_MS = 3 * 60 * 60_000;
// Guests taken longer ago than this are not announced after a reconnect.
const FRESH_MS = 30 * 60_000;

type Waiting = { orderId: string; number: number };

function loadSeen(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed as Record<string, number>).filter(
        ([, at]) => typeof at === 'number' && now - at < SEEN_TTL_MS,
      ),
    );
  } catch {
    return {};
  }
}

function saveSeen(seen: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* Storage blocked: duplicates are only prevented for this page. */
  }
}

/**
 * Alerts the waiter that a guest ordered at the cashier and needs a table.
 * In the Android app the native service does the announcing (also with the screen
 * off); this component hands it the central settings and shows nothing. In a
 * browser it listens to the real-time socket, speaks Uzbek and shows a banner.
 * Each order is announced once, also across reconnects and page reloads.
 */
export function WalkinAlerts() {
  const { data: me } = useMe();
  const settings = me?.ordering?.waiterAlerts;
  const native = androidBridge();
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [soundReady, setSoundReady] = useState(false);
  const [status, setStatus] = useState<AlertStatus | null>(null);
  const seen = useRef<Record<string, number>>(loadSeen());
  const reminders = useRef(0);
  const enabled = !!settings?.enabled;

  // Android: give the native service the settings decided centrally.
  useEffect(() => {
    if (!native) return;
    if (enabled && settings) {
      native.configureAlerts(JSON.stringify(settings));
      setStatus(androidAlertStatus());
    } else native.stopAlerts();
  }, [native, enabled, settings]);

  const announce = (order: Waiting) => {
    if (!settings || !enabled) return;
    if (seen.current[order.orderId]) return;
    seen.current = { ...seen.current, [order.orderId]: Date.now() };
    saveSeen(seen.current);
    setWaiting((current) =>
      current.some((item) => item.orderId === order.orderId)
        ? current
        : [...current, order],
    );
    if (settings.voice || settings.sound)
      speak(walkinAnnouncement, {
        repeat: settings.repeat,
        volume: settings.volume,
        force: true,
        chimeOnly: !settings.voice,
      });
  };

  useRealtimeEvent((event, payload) => {
    if (native || !enabled) return;
    const orderId = String(payload.orderId ?? '');
    if (!orderId) return;
    if (event === 'order.table_needed') {
      if (payload.byUserId && payload.byUserId === me?.userId) return;
      announce({ orderId, number: Number(payload.number ?? 0) });
    }
    if (event === 'order.table_assigned')
      setWaiting((current) =>
        current.filter((item) => item.orderId !== orderId),
      );
  });

  // After (re)connecting, pick up guests that arrived while this screen was offline.
  useEffect(() => {
    if (native || !enabled || !me?.activeBranchId) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const data = await api<{ orders: Order[] }>(
          `/orders?scope=active&branchId=${me.activeBranchId}`,
        );
        if (cancelled) return;
        const open = data.orders.filter(
          (order) => order.type === 'DINE_IN' && !order.table,
        );
        setWaiting((current) =>
          current.filter((item) => open.some((o) => o.id === item.orderId)),
        );
        for (const order of open)
          if (Date.now() - new Date(order.createdAt).getTime() < FRESH_MS)
            announce({ orderId: order.id, number: order.number });
      } catch {
        /* Offline: the next reconnect tries again. */
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, enabled, me?.activeBranchId]);

  // Optional reminder while a guest still has no table.
  useEffect(() => {
    if (native || !enabled || !settings?.reminderSeconds) return;
    if (waiting.length === 0) {
      reminders.current = 0;
      return;
    }
    const timer = setInterval(() => {
      if (reminders.current >= 5) return;
      reminders.current += 1;
      speak(walkinAnnouncement, {
        repeat: 1,
        volume: settings.volume,
        force: true,
      });
    }, settings.reminderSeconds * 1000);
    return () => clearInterval(timer);
  }, [native, enabled, settings, waiting.length]);

  if (!enabled) return null;
  if (native)
    return status && !status.notifications ? (
      <div className="walkin-alerts" role="alert">
        <div className="walkin-alert">
          <strong>{t.ordering.newGuest}</strong>
          <span>{t.ordering.alertHint}</span>
          <Button
            variant="primary"
            onClick={() => native.requestNotificationPermission()}
          >
            {t.ordering.alertSound}
          </Button>
        </div>
      </div>
    ) : null;
  if (waiting.length === 0 && soundReady) return null;
  return (
    <div className="walkin-alerts" role="alert" aria-live="assertive">
      {!soundReady && (
        <div className="walkin-alert">
          <span>{t.ordering.alertHint}</span>
          <Button variant="secondary" onClick={() => setSoundReady(true)}>
            🔊 {t.ordering.alertSound}
          </Button>
        </div>
      )}
      {waiting.map((order) => (
        <div key={order.orderId} className="walkin-alert">
          <strong>{t.ordering.newGuest}</strong>
          <span>
            {t.ordering.needTable.replace('{n}', formatOrderNo(order.number))}
          </span>
          <div className="form-actions">
            <Button
              variant="primary"
              onClick={() =>
                navigate(`/ofitsiant?stol-belgilash=${order.orderId}`)
              }
            >
              {t.ordering.assignTable}
            </Button>
            <Button
              onClick={() =>
                setWaiting((current) =>
                  current.filter((item) => item.orderId !== order.orderId),
                )
              }
            >
              {t.common.close}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
