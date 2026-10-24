import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import {
  Badge,
  Button,
  ErrorState,
  LoadingState,
  PageHeader,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, ApiError, errorMessage } from '../lib/api';

type TvState = {
  enabled: boolean;
  paused: boolean;
  branch: { id: string; name: string };
};

/**
 * Kassa «TV ekrani»: switches the branch's queue TVs off (pause screen) and on again.
 * The TVs keep polling, so they come back by themselves; nothing is set up again.
 */
export function TvSwitchPage() {
  const { data: me } = useMe();
  const toast = useToast();
  const client = useQueryClient();
  const branchId = me?.activeBranchId;
  const [busy, setBusy] = useState(false);
  const state = useQuery({
    queryKey: ['queue-tv', branchId],
    queryFn: () =>
      api<TvState>(`/queue/tv${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: !!branchId,
    retry: false,
  });

  const toggle = async (paused: boolean) => {
    setBusy(true);
    try {
      await api('/queue/tv', {
        method: 'PUT',
        body: { paused, ...(branchId ? { branchId } : {}) },
      });
      toast(paused ? t.ordering.tvSwitch.turnedOff : t.ordering.tvSwitch.turnedOn);
      await client.invalidateQueries({ queryKey: ['queue-tv'] });
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  const centralOff =
    (state.error instanceof ApiError && state.error.code === 'FEATURE_DISABLED') ||
    state.data?.enabled === false;

  return (
    <>
      <PageHeader
        title={t.ordering.tvSwitch.title}
        subtitle={t.ordering.tvSwitch.hint}
      />
      {state.isLoading ? (
        <LoadingState />
      ) : centralOff ? (
        <section className="card stack narrow">
          <Badge tone="danger">{t.ordering.tvSwitch.off}</Badge>
          <p>{t.ordering.tvSwitch.centralOff}</p>
        </section>
      ) : state.error || !state.data ? (
        <ErrorState error={state.error} onRetry={() => void state.refetch()} />
      ) : (
        <section className="card stack narrow">
          <h2>{state.data.branch.name}</h2>
          <p>
            <Badge tone={state.data.paused ? 'danger' : 'success'}>
              {state.data.paused
                ? t.ordering.tvSwitch.off
                : t.ordering.tvSwitch.on}
            </Badge>
          </p>
          <div className="form-actions">
            {state.data.paused ? (
              <Button
                variant="primary"
                size="lg"
                busy={busy}
                onClick={() => void toggle(false)}
              >
                {t.ordering.tvSwitch.turnOn}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="lg"
                busy={busy}
                onClick={() => void toggle(true)}
              >
                {t.ordering.tvSwitch.turnOff}
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
