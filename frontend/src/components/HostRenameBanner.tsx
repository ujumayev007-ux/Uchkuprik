import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { Button, useToast } from './ui';

type Request = { id: string; name: string; status: string };

const desktop = (
  window as unknown as {
    fastfoodDesktop?: {
      renameComputer?: (
        name: string,
      ) => Promise<{ ok: boolean; error?: string }>;
    };
  }
).fastfoodDesktop;

/**
 * The Owner asked to rename this Windows computer. Nothing happens without the
 * restaurant Admin's consent here, and Windows itself asks for administrator
 * permission; only the FastFood Server app on that very computer can do it.
 */
export function HostRenameBanner() {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['control-link', 'host-rename'],
    queryFn: () =>
      api<{ request: Request | null; agent: boolean }>(
        '/control/link/host-rename',
      ),
    refetchInterval: 60_000,
  });
  const request = query.data?.request;
  if (!request) return null;
  const text = t.hostRename;
  const canRename = !!desktop?.renameComputer && query.data?.agent;

  const answer = async (
    status: 'REJECTED' | 'DONE' | 'FAILED',
    message: string | null = null,
  ) => {
    await post('/control/link/host-rename', {
      id: request.id,
      status,
      message,
    });
    await client.invalidateQueries({ queryKey: ['control-link'] });
  };
  const approve = async () => {
    setBusy(true);
    try {
      const result = await desktop!.renameComputer!(request.name);
      await answer(
        result.ok ? 'DONE' : 'FAILED',
        result.ok ? null : (result.error ?? null),
      );
      toast(
        result.ok ? text.done : text.failed,
        result.ok ? 'success' : 'error',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : text.failed, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="billing-banner warning" role="alert">
      <span>
        <strong>{text.title}</strong>
        <br />
        {text.text.replace('{name}', request.name)}
        {!canRename && (
          <>
            <br />
            <small>{text.onlyServer}</small>
          </>
        )}
      </span>
      {canRename && (
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          onClick={() => void approve()}
        >
          {text.approve}
        </Button>
      )}
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void answer('REJECTED')
            .then(() => toast(text.rejected))
            .catch((error: unknown) =>
              toast(
                error instanceof Error ? error.message : t.common.errorTitle,
                'error',
              ),
            )
        }
      >
        {text.reject}
      </Button>
    </div>
  );
}
