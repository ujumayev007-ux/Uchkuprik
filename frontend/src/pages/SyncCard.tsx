import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, FormError, useToast } from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const s = t.sync;

type Status =
  | { attached: false; canAttach: boolean }
  | {
      attached: true;
      canAttach: boolean;
      role: 'spoke' | 'hub';
      pending: number;
      conflicts: number;
      parked: number;
      lastSyncAt: string | null;
      lastError: string | null;
    };

/**
 * "Markaz bilan sinxronlash": this restaurant's data is kept the same on the Kassa
 * server and on the central server, so the Admin can work through the centre even
 * when the Kassa computer is off.
 */
export function SyncCard() {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const query = useQuery({
    queryKey: ['replication', 'status'],
    queryFn: () => api<Status>('/replication/status'),
    refetchInterval: 10_000,
    retry: false,
  });
  const data = query.data;
  if (!data || (!data.attached && !data.canAttach)) return null;

  const attach = async () => {
    if (!window.confirm(s.confirm)) return;
    setBusy(true);
    setError(null);
    try {
      await post('/replication/attach', {});
      toast(s.attached);
      await client.invalidateQueries({ queryKey: ['replication'] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h2>🔄 {s.title}</h2>
      <p className="muted small">{s.hint}</p>
      {data.attached ? (
        <div className="stack compact">
          <div>
            <Badge
              tone={
                data.lastError
                  ? 'danger'
                  : data.pending > 0
                    ? 'warning'
                    : 'success'
              }
            >
              {data.lastError
                ? s.offline
                : data.pending > 0
                  ? s.pending.replace('{n}', String(data.pending))
                  : s.ok}
            </Badge>{' '}
            <span className="muted small">
              {data.role === 'hub' ? s.roleHub : s.roleKassa}
            </span>
          </div>
          <div className="small">
            {s.lastSync}:{' '}
            {data.lastSyncAt ? formatDateTime(data.lastSyncAt) : s.never}
          </div>
          {data.lastError && (
            <div className="small danger-text">{data.lastError}</div>
          )}
          {(data.conflicts > 0 || data.parked > 0) && (
            <div className="small danger-text">
              {s.conflicts
                .replace('{n}', String(data.conflicts))
                .replace('{p}', String(data.parked))}
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="small">{s.notAttached}</p>
          <FormError error={error} />
          <div className="toolbar">
            <Button variant="primary" busy={busy} onClick={() => void attach()}>
              {s.attach}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
