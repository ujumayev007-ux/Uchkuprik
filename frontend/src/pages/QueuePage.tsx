import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useMe } from '../auth/session';
import { t } from '../i18n';
import { api } from '../lib/api';
import { announce, useRealtime } from '../lib/realtime';

type Queue = {
  branch: { name: string };
  preparing: number[];
  ready: { number: number; readyAt: string | null }[];
};

/** Full-screen customer queue display for a TV at the pickup counter. */
export function QueuePage() {
  const { data: me } = useMe();
  const online = useRealtime(me?.activeBranchId);
  const queue = useQuery({
    queryKey: ['queue', me?.activeBranchId],
    queryFn: () => api<Queue>('/queue'),
    enabled: !!me?.activeBranchId,
    refetchInterval: 15_000,
  });
  // Browsers only allow audio after a user gesture, so sound is enabled with one tap.
  const [sound, setSound] = useState(false);
  const announced = useRef<Set<number> | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);

  useEffect(() => {
    if (!queue.data) return;
    const ready = new Set(queue.data.ready.map((item) => item.number));
    if (announced.current && sound)
      for (const number of ready)
        if (!announced.current.has(number))
          announce(t.queue.announce.replace('{n}', String(number)));
    announced.current = ready;
  }, [queue.data, sound]);

  return (
    <div className="queue-screen">
      <header>
        <h1>{queue.data?.branch.name ?? t.queue.title}</h1>
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
        <span
          className={`live-dot ${online ? 'on' : 'off'}`}
          title={online ? t.live.online : t.live.offline}
        />
      </header>
      <div className="queue-columns">
        <section>
          <h2>{t.queue.preparing}</h2>
          <div className="queue-numbers">
            {(queue.data?.preparing ?? []).map((number) => (
              <span key={number}>{number}</span>
            ))}
          </div>
        </section>
        <section className="ready">
          <h2>{t.queue.ready}</h2>
          <div className="queue-numbers">
            {(queue.data?.ready ?? []).map((item) => (
              <span key={item.number}>{item.number}</span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
