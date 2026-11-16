import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { can, useMe } from '../auth/session';
import { t } from '../i18n';
import { api } from '../lib/api';
import { androidAlertStatus, androidBridge } from '../lib/android';
import { chime, useRealtimeEvent } from '../lib/realtime';
import { formatOrderNo } from '../lib/uzbek-number';
import { Button } from './ui';

const SEEN_KEY = 'ff-ready-seen';
const SEEN_TTL_MS = 6 * 60 * 60_000;
const SHOW_MS = 20_000;

export type ReadyItem = { id: string; name: string; quantity: number };
type Banner = {
  key: string;
  orderId: string;
  number: number;
  table: string | null;
  items: ReadyItem[];
  allReady: boolean;
};

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
    /* storage blocked: duplicates are only prevented on this page */
  }
}

/** «7-stol · №142» (or «№142» without a table); numbers as everywhere else. */
export const whereOf = (table: string | null, number: number) =>
  table ? `${table} · ${formatOrderNo(number)}` : formatOrderNo(number);

/** «7-stol · №142 — 2 ta osh tayyor». */
export const readyLine = (banner: Omit<Banner, 'key' | 'allReady'>) =>
  t.readyAlert.line
    .replace('{where}', whereOf(banner.table, banner.number))
    .replace(
      '{items}',
      banner.items
        .map((item) =>
          t.readyAlert.item
            .replace('{n}', String(item.quantity))
            .replace('{name}', item.name.toLocaleLowerCase('uz')),
        )
        .join(', '),
    );

/**
 * «Tayyor» banner for the waiter: the kitchen marked a dish of one of their orders
 * ready. Shown at the top of whatever screen is open; it never navigates by itself
 * (an order being entered and the cart stay as they are). Each dish once per device.
 * In the Android app the native service shows the system notification when the app
 * is in the background or the phone is locked.
 */
export function ReadyAlerts() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const native = androidBridge();
  // Waiters (the Kassa sees every order on its own screen).
  const takesOrders =
    (can(me, 'orders.create') || can(me, 'orders.edit')) &&
    !can(me, 'pos.access');
  const branchId = me?.activeBranchId ?? null;
  const [banners, setBanners] = useState<Banner[]>([]);
  const [notifications, setNotifications] = useState(true);
  const seen = useRef<Record<string, number>>(loadSeen());
  const timers = useRef(new Map<string, number>());

  const dismiss = (key: string) => {
    setBanners((current) => current.filter((banner) => banner.key !== key));
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
  };

  /** Shows the dishes not shown on this device yet; returns false when none were new. */
  const show = (input: Omit<Banner, 'key'>, silent = false) => {
    const fresh = input.items.filter((item) => !seen.current[item.id]);
    const allKey = `all:${input.orderId}`;
    const allNew = input.allReady && !seen.current[allKey];
    if (fresh.length === 0 && !allNew) return false;
    const at = Date.now();
    seen.current = {
      ...seen.current,
      ...Object.fromEntries(fresh.map((item) => [item.id, at])),
      ...(input.allReady ? { [allKey]: at } : {}),
    };
    saveSeen(seen.current);
    if (silent) return true;
    const key = `${input.orderId}:${at}`;
    const banner: Banner = {
      ...input,
      key,
      items: fresh.length ? fresh : input.items,
    };
    setBanners((current) => [...current.slice(-2), banner]);
    timers.current.set(
      key,
      window.setTimeout(() => dismiss(key), SHOW_MS),
    );
    chime();
    return true;
  };

  useRealtimeEvent((event, payload) => {
    if (event !== 'order.items_ready' || !takesOrders) return;
    if (payload.branchId && payload.branchId !== branchId) return;
    show({
      orderId: String(payload.orderId ?? ''),
      number: Number(payload.number ?? 0),
      table: (payload.table as string | null) ?? null,
      items: (payload.items as ReadyItem[]) ?? [],
      allReady: !!payload.allReady,
    });
  });

  // Dishes that became ready while this screen was offline (after a reconnect). The
  // first check only records what is already ready (it is listed under «Tayyor»).
  useEffect(() => {
    if (!takesOrders || !branchId) return;
    let first = true;
    let cancelled = false;
    const sync = async () => {
      try {
        const data = await api<{
          items: (ReadyItem & {
            orderId: string;
            number: number;
            table: string | null;
          })[];
        }>('/waiter/ready-items');
        if (cancelled) return;
        const byOrder = new Map<string, typeof data.items>();
        for (const item of data.items)
          byOrder.set(item.orderId, [
            ...(byOrder.get(item.orderId) ?? []),
            item,
          ]);
        for (const [orderId, items] of byOrder)
          show(
            {
              orderId,
              number: items[0]!.number,
              table: items[0]!.table,
              items: items.map(({ id, name, quantity }) => ({
                id,
                name,
                quantity,
              })),
              allReady: false,
            },
            first,
          );
        first = false;
      } catch {
        /* offline: the next round tries again */
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takesOrders, branchId]);

  // Android: is the notification permission given (needed with the phone locked)?
  useEffect(() => {
    if (!native || !takesOrders) return;
    const read = () =>
      setNotifications(androidAlertStatus()?.notifications ?? true);
    read();
    window.addEventListener('ff-android-permission', read);
    return () => window.removeEventListener('ff-android-permission', read);
  }, [native, takesOrders]);

  // The walk-in alert banner already asks for the permission when it is switched on.
  const askPermission =
    !!native && !notifications && !me?.ordering?.waiterAlerts?.enabled;
  if (!takesOrders) return null;
  if (banners.length === 0 && !askPermission) return null;
  return (
    <div className="ready-alerts" role="alert" aria-live="assertive">
      {askPermission && (
        <div className="ready-alert ready-alert-muted">
          <span>{t.readyAlert.notifications}</span>
          <Button
            variant="primary"
            onClick={() => native.requestNotificationPermission()}
          >
            {t.readyAlert.allow}
          </Button>
        </div>
      )}
      {banners.map((banner) => (
        <div key={banner.key} className="ready-alert">
          <div className="ready-alert-text">
            <strong>✅ {readyLine(banner)}</strong>
            {banner.allReady && <span>{t.readyAlert.all}</span>}
          </div>
          <div className="ready-alert-actions">
            <Button
              variant="primary"
              onClick={() => {
                dismiss(banner.key);
                navigate(
                  `/ofitsiant?buyurtma=${banner.orderId}&tayyor=${banner.items
                    .map((item) => item.id)
                    .join(',')}`,
                );
              }}
            >
              {t.readyAlert.view}
            </Button>
            <button
              type="button"
              className="icon-button"
              aria-label={t.readyAlert.close}
              onClick={() => dismiss(banner.key)}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
