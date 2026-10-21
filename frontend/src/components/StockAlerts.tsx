import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { can, useMe } from '../auth/session';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { chime } from '../lib/realtime';
import { Button, Dialog, LoadingState, useToast } from './ui';

type Severity = 'LOW' | 'CRITICAL' | 'OUT';
type Alert = {
  id: string;
  name: string;
  unitLabel: string;
  severity: Severity;
  status: 'OPEN' | 'ACKNOWLEDGED';
  quantity: string;
  threshold: string;
  openedAt: string;
};
type Settings = {
  enabled: boolean;
  soundEnabled: boolean;
  criticalPercent: number;
  reminderMinutes: number;
};

const MUTE_KEY = 'ff-stock-sound';
const readMuted = () => {
  try {
    return localStorage.getItem(MUTE_KEY) === 'off';
  } catch {
    return false;
  }
};

const rank: Record<Severity, number> = { LOW: 1, CRITICAL: 2, OUT: 3 };
const say = (alert: Alert) =>
  t.stockAlerts.message
    .replace('{severity}', t.stockAlerts.severity[alert.severity])
    .replace('{name}', alert.name)
    .replace('{quantity}', `${alert.quantity} ${alert.unitLabel}`)
    .replace('{threshold}', `${alert.threshold} ${alert.unitLabel}`);

/**
 * Low-stock notices for the Admin: a bell with the number of unacknowledged alerts, a
 * pop-up and a short sound when an item crosses its minimum (and again when it gets
 * worse), and a reminder while nobody acknowledged it. A device without audio, or a
 * muted one, only loses the sound.
 */
export function StockAlerts() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(readMuted);
  const known = useRef<Map<string, string> | null>(null);
  const enabled = !!me?.activeBranchId && can(me, 'inventory.view');
  const alerts = useQuery({
    queryKey: ['inventory', 'stock-alerts', me?.activeBranchId],
    queryFn: () =>
      api<{ alerts: Alert[]; settings: Settings }>(
        `/inventory/stock-alerts?branchId=${me?.activeBranchId}`,
      ),
    enabled,
    refetchInterval: 60_000,
  });
  const list = alerts.data?.alerts ?? [];
  const settings = alerts.data?.settings;
  const unacknowledged = list.filter((alert) => alert.status === 'OPEN');
  const beep = () => {
    if (settings?.soundEnabled && !muted) chime();
  };

  // New or worse alerts: one pop-up and one sound each, never a loop.
  useEffect(() => {
    if (!alerts.data) return;
    const next = new Map(
      list.map((alert) => [alert.id, `${alert.severity}:${alert.status}`]),
    );
    if (known.current) {
      const fresh = list.filter((alert) => {
        const before = known.current!.get(alert.id);
        return (
          alert.status === 'OPEN' &&
          (!before ||
            rank[before.split(':')[0] as Severity] < rank[alert.severity] ||
            before.endsWith('ACKNOWLEDGED'))
        );
      });
      if (fresh.length) {
        for (const alert of fresh.slice(0, 3)) toast(say(alert), 'error');
        beep();
      }
    }
    known.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.data]);

  // Reminder while something stays unacknowledged (0 minutes = off).
  const reminder = settings?.reminderMinutes ?? 0;
  useEffect(() => {
    if (!reminder || unacknowledged.length === 0) return;
    const timer = window.setInterval(() => {
      toast(
        t.stockAlerts.reminder.replace('{n}', String(unacknowledged.length)),
        'error',
      );
      beep();
    }, reminder * 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminder, unacknowledged.length, muted, settings?.soundEnabled]);

  if (!enabled) return null;
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? 'off' : 'on');
    } catch {
      /* The mute switch is a per-device convenience. */
    }
  };
  const acknowledge = async (id: string) => {
    try {
      await post(`/inventory/stock-alerts/${id}/ack`);
      await client.invalidateQueries({ queryKey: ['inventory'] });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };
  return (
    <>
      <button
        className="icon-button"
        aria-label={t.stockAlerts.title}
        title={t.stockAlerts.title}
        onClick={() => setOpen(true)}
      >
        📦
        {unacknowledged.length > 0 && (
          <span className="badge-dot">{unacknowledged.length}</span>
        )}
      </button>
      {open && (
        <Dialog
          open
          wide
          title={t.stockAlerts.title}
          description={t.stockAlerts.subtitle}
          onClose={() => setOpen(false)}
        >
          {alerts.isPending ? (
            <LoadingState />
          ) : (
            <div className="stack">
              <div className="toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={muted}
                    onChange={toggleMute}
                  />{' '}
                  {t.stockAlerts.muteHere}
                </label>
                <Button
                  onClick={() => {
                    setOpen(false);
                    void navigate('/ombor');
                  }}
                >
                  {t.stockAlerts.openInventory}
                </Button>
              </div>
              {list.length === 0 ? (
                <p className="muted">{t.stockAlerts.none}</p>
              ) : (
                <ul className="stack">
                  {list.map((alert) => (
                    <li
                      key={alert.id}
                      className={`card ${alert.severity === 'LOW' ? '' : 'danger-text'}`}
                    >
                      <strong>{alert.name}</strong> —{' '}
                      {t.stockAlerts.severity[alert.severity]}
                      <br />
                      <span className="muted">
                        {alert.quantity} {alert.unitLabel} /{' '}
                        {t.stockAlerts.minimum} {alert.threshold}{' '}
                        {alert.unitLabel}
                      </span>
                      <div className="toolbar">
                        {alert.status === 'OPEN' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => void acknowledge(alert.id)}
                          >
                            {t.stockAlerts.acknowledge}
                          </Button>
                        ) : (
                          <span className="muted">
                            {t.stockAlerts.acknowledged}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {can(me, 'inventory.manage') && settings && (
                <SettingsForm settings={settings} />
              )}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(settings);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('/inventory/stock-alert-settings', {
        method: 'PUT',
        body: value,
      });
      await client.invalidateQueries({ queryKey: ['inventory'] });
      toast(t.common.saved);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>{t.stockAlerts.settings}</summary>
      <div className="stack">
        <label>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
          />{' '}
          {t.stockAlerts.enabled}
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.soundEnabled}
            onChange={(e) =>
              setValue({ ...value, soundEnabled: e.target.checked })
            }
          />{' '}
          {t.stockAlerts.sound}
        </label>
        <label>
          {t.stockAlerts.criticalPercent}{' '}
          <input
            type="number"
            min={1}
            max={99}
            value={value.criticalPercent}
            onChange={(e) =>
              setValue({ ...value, criticalPercent: Number(e.target.value) })
            }
          />
        </label>
        <label>
          {t.stockAlerts.reminderMinutes}{' '}
          <input
            type="number"
            min={0}
            max={240}
            value={value.reminderMinutes}
            onChange={(e) =>
              setValue({ ...value, reminderMinutes: Number(e.target.value) })
            }
          />
        </label>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {t.common.save}
        </Button>
      </div>
    </details>
  );
}
