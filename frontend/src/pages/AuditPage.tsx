import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
  roles?: string | null;
  session?: string | null;
  data?: unknown;
  createdAt: string;
};

const tones = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  DENIED: 'warning',
} as const;

export function AuditPage({ platform = false }: { platform?: boolean }) {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const users = useQuery({
    queryKey: ['users', 'audit-filter'],
    queryFn: () =>
      api<{ users: { id: string; displayName: string }[] }>('/users').then(
        (data) => data.users,
      ),
    enabled: !platform,
  });
  const base = platform ? '/platform/audit-logs' : '/audit-logs';
  const log = useInfiniteQuery({
    queryKey: [
      'audit',
      platform,
      action,
      actor,
      orderNumber,
      outcome,
      from,
      to,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('action', action);
      if (actor) params.set('actorUserId', actor);
      if (/^\d+$/.test(orderNumber)) params.set('orderNumber', orderNumber);
      if (outcome) params.set('outcome', outcome);
      if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
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
        {!platform && (
          <select
            aria-label={t.audit.employee}
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          >
            <option value="">{t.audit.allEmployees}</option>
            {(users.data ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
          </select>
        )}
        <input
          className="input"
          inputMode="numeric"
          placeholder={t.audit.orderNumber}
          aria-label={t.audit.orderNumber}
          value={orderNumber}
          onChange={(event) =>
            setOrderNumber(event.target.value.replace(/\D/g, ''))
          }
          style={{ maxWidth: 140 }}
        />
        <select
          aria-label={t.audit.outcome}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="">
            {t.audit.outcome}: {t.common.all}
          </option>
          {(['SUCCESS', 'DENIED', 'FAILURE'] as const).map((key) => (
            <option key={key} value={key}>
              {t.audit.outcomes[key]}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="date"
          aria-label={t.audit.from}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <input
          className="input"
          type="date"
          aria-label={t.audit.to}
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
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
                    <td>
                      {entry.actorName ?? t.audit.system}
                      {entry.roles && (
                        <small className="muted block">
                          {entry.roles}
                          {entry.session ? ` · #${entry.session}` : ''}
                        </small>
                      )}
                    </td>
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
