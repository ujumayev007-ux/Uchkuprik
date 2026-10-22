import { useQuery } from '@tanstack/react-query';
import { shellKind } from '../lib/shell';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMe } from '../auth/session';
import { LiveClock } from '../components/LiveClock';
import { VoiceSettingsDialog } from '../components/VoiceSettingsDialog';
import { t } from '../i18n';
import { api, ApiError } from '../lib/api';
import { defaultOrdering, type Ordering } from '../lib/ordering';
import { useFlip } from '../lib/flip';
import { useRealtime } from '../lib/realtime';
import { formatOrderNo, readyAnnouncement } from '../lib/uzbek-number';
import { speak } from '../lib/voice';

type Queue = {
  branch: { name: string };
  display?: Ordering['tv'];
  preparing: number[];
  ready: { id?: string; number: number; readyAt: string | null }[];
};

const ANNOUNCED_KEY = 'ff-queue-announced';
const ANNOUNCED_TTL_MS = 6 * 60 * 60_000;

/** Announcements already made, kept for the session so reloads never repeat them. */
function loadAnnounced(): Map<string, number> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ANNOUNCED_KEY) ?? '{}');
    const now = Date.now();
    return new Map(
      Object.entries(raw as Record<string, number>).filter(
        ([, at]) => typeof at === 'number' && now - at < ANNOUNCED_TTL_MS,
      ),
    );
  } catch {
    return new Map();
  }
}

function saveAnnounced(map: Map<string, number>) {
  try {
    sessionStorage.setItem(
      ANNOUNCED_KEY,
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    /* Storage blocked: duplicates are only prevented while the page is open. */
  }
}

/**
 * Full-screen customer queue display for a TV at the pickup counter. Numbers run
 * top to bottom as №001, №002…; "preparing" is yellow and "ready" green. A ready
 * order is announced once in natural Uzbek («Yettinchi buyurtma tayyor.»).
 * Layout, visible statuses and voice come from the central settings.
 */
export function QueuePage() {
  const { data: me } = useMe();
  const online = useRealtime(me?.activeBranchId);
  const queue = useQuery({
    queryKey: ['queue', me?.activeBranchId],
    queryFn: () => api<Queue>('/queue'),
    enabled: !!me?.activeBranchId,
    refetchInterval: 15_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 403) && count < 2,
  });
  // Browsers only allow audio after a user gesture: one tap on the overlay.
  // The TV application plays the ready announcements without a tap.
  const [sound, setSound] = useState(() => shellKind() === 'tv');
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const announced = useRef<Map<string, number> | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const board = useRef<HTMLDivElement | null>(null);
  useFlip(board);

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);

  const display = queue.data?.display ?? defaultOrdering.tv;
  const ready = useMemo(
    () =>
      (queue.data?.ready ?? []).map((item) => ({
        ...item,
        // Old servers did not send ids: the number is unique for the day.
        key: `${item.id ?? item.number}|${item.readyAt ?? ''}`,
      })),
    [queue.data],
  );

  const known = () => {
    if (announced.current === null) announced.current = loadAnnounced();
    return announced.current;
  };

  // Switching the sound on is a baseline: orders that are already ready are not
  // announced, only the ones that become ready afterwards.
  useEffect(() => {
    if (!sound) return;
    const map = known();
    for (const item of ready)
      if (!map.has(item.key)) map.set(item.key, Date.now());
    saveAnnounced(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound]);

  // Every ready order is announced exactly once, whatever reconnects or repeated
  // events refetch the queue: the identity is order id + the moment it became ready.
  useEffect(() => {
    if (!queue.data || !sound) return;
    const map = known();
    const fresh = ready.filter((item) => !map.has(item.key));
    if (fresh.length === 0) return;
    for (const item of fresh) map.set(item.key, Date.now());
    saveAnnounced(map);
    if (!display.voice.enabled) return;
    for (const item of fresh)
      speak(readyAnnouncement(item.number, display.voice.phrase), {
        repeat: display.voice.repeat,
        volume: display.voice.volume,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data, ready, sound, display.voice]);

  if (queue.error instanceof ApiError && queue.error.status === 403)
    return (
      <div className="queue-screen">
        <h1>{t.ordering.tv.disabled}</h1>
      </div>
    );

  const showPreparing = display.showPreparing;
  const showReady = display.showReady;
  const preparing = queue.data?.preparing ?? [];
  const columns = [showPreparing, showReady].filter(Boolean).length;
  const empty =
    (showPreparing ? preparing.length : 0) + (showReady ? ready.length : 0) ===
    0;

  return (
    <div className={`queue-screen ${display.layout}`}>
      <header>
        <h1>{queue.data?.branch.name ?? t.queue.title}</h1>
        <LiveClock large />
        <button
          className="btn btn-ghost btn-sm queue-close"
          onClick={() => {
            // Opened as its own window from the menu: close it; otherwise go back.
            if (window.opener) window.close();
            else
              window.history.length > 1
                ? window.history.back()
                : window.location.assign('/');
          }}
        >
          ✕ {t.common.close}
        </button>
        {!sound ? (
          <button
            className="btn btn-secondary btn-md"
            onClick={() => setSound(true)}
          >
            🔊 {t.queue.enableSound}
          </button>
        ) : (
          <span className="muted">🔊 {t.queue.soundOn}</span>
        )}
        <button
          className="btn btn-ghost btn-sm"
          aria-label={t.voice.title}
          onClick={() => setVoiceOpen(true)}
        >
          ⚙ 🔊
        </button>
        <span
          className={`live-dot ${online ? 'on' : 'off'}`}
          title={online ? t.live.online : t.live.offline}
        />
      </header>
      {(!online || queue.isError) && (
        <p className="queue-offline" role="alert">
          {t.queue.offline}
        </p>
      )}
      <div ref={board} className="queue-board">
        {display.layout === 'single' ? (
          <div
            className="queue-columns"
            style={{ ['--tv-columns' as string]: 1 }}
          >
            <section>
              <ul className="tv-list single" aria-label={t.queue.title}>
                {showReady &&
                  ready.map((item) => (
                    <li
                      key={`r-${item.key}`}
                      data-flip={`n${item.number}`}
                      className="tv-row is-ready"
                    >
                      <b>{formatOrderNo(item.number)}</b>
                      <span>{t.ordering.tv.ready}</span>
                    </li>
                  ))}
                {showPreparing &&
                  preparing.map((number) => (
                    <li
                      key={`p-${number}`}
                      data-flip={`n${number}`}
                      className="tv-row is-preparing"
                    >
                      <b>{formatOrderNo(number)}</b>
                      <span>{t.ordering.tv.preparing}</span>
                    </li>
                  ))}
              </ul>
              {empty && <p className="muted">{t.ordering.tv.empty}</p>}
            </section>
          </div>
        ) : (
          <div
            className="queue-columns"
            style={{ ['--tv-columns' as string]: Math.max(1, columns) }}
          >
            {showPreparing && (
              <section className="preparing">
                <h2 className="tv-title">
                  {t.ordering.tv.preparing}
                  <span className="tv-count">{preparing.length}</span>
                </h2>
                <ul className="tv-list">
                  {preparing.map((number) => (
                    <li key={number} data-flip={`n${number}`}>
                      {formatOrderNo(number)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {showReady && (
              <section className="ready">
                <h2 className="tv-title">
                  {t.queue.ready}
                  <span className="tv-count">{ready.length}</span>
                </h2>
                <ul className="tv-list">
                  {ready.map((item) => (
                    <li key={item.key} data-flip={`n${item.number}`}>
                      {formatOrderNo(item.number)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
      {!sound && !overlayDismissed && display.voice.enabled && (
        <div className="tv-sound-overlay">
          <div className="stack center">
            <button
              className="btn btn-primary"
              onClick={() => setSound(true)}
              autoFocus
            >
              🔊 {t.queue.enableSound}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setOverlayDismissed(true)}
            >
              {t.common.close}
            </button>
          </div>
        </div>
      )}
      {voiceOpen && <VoiceSettingsDialog onClose={() => setVoiceOpen(false)} />}
    </div>
  );
}
