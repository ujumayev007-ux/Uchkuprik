import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';

type Entry = {
  id: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  entityType: string | null;
  entityId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  createdAt: string;
};

const tones = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  DENIED: 'warning',
} as const;

export function AuditPage({ platform = false }: { platform?: boolean }) {
  const [action, setAction] = useState('');
  const base = platform ? '/platform/audit-logs' : '/audit-logs';
  const log = useInfiniteQuery({
    queryKey: ['audit', platform, action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('action', action);
      if (pageParam) params.set('before', pageParam);
      return api<{ entries: Entry[]; nextBefore: string | null }>(
        `${base}?${params}`,
      );
    },
    getNextPageParam: (page) => page.nextBefore,
  });
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];
  const groups = [
    ...new Set(Object.keys(t.audit.actions).map((key) => key.split('.')[0]!)),
  ];

  return (
    <>
      <PageHeader
        title={platform ? t.nav.platformAudit : t.audit.title}
        subtitle={t.audit.subtitle}
      />
      <div className="toolbar">
        <select
          aria-label={t.audit.filter}
          value={action}
          onChange={(event) => setAction(event.target.value)}
        >
          <option value="">{t.common.all}</option>
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {Object.entries(t.audit.actions)
                .filter(([key]) => key.startsWith(`${group}.`))
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {log.isPending ? (
        <LoadingState />
      ) : log.error ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t.audit.time}</th>
                  <th>{t.audit.action}</th>
                  <th>{t.audit.actor}</th>
                  <th>{t.audit.outcome}</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="nowrap">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td>
                      {t.audit.actions[entry.action] ?? entry.action}
                      <small className="muted block">
                        <code>{entry.action}</code>
                      </small>
                    </td>
                    <td>{entry.actorName ?? t.audit.system}</td>
                    <td>
                      <Badge tone={tones[entry.outcome]}>
                        {t.audit.outcomes[entry.outcome]}
                      </Badge>
                    </td>
                    <td>
                      <code>{entry.ipAddress ?? '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.hasNextPage && (
            <div className="center">
              <Button
                busy={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {t.common.more}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
