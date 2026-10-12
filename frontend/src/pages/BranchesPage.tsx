import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBranches, type Branch } from '../components/AppShell';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { patch, post } from '../lib/api';

function BranchForm({
  branch,
  onDone,
}: {
  branch: Branch | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    code: branch?.code ?? '',
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    phone: branch?.phone ?? '',
    timezone: branch?.timezone ?? 'Asia/Tashkent',
    isActive: branch?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          ...form,
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
        };
        try {
          if (branch) await patch(`/branches/${branch.id}`, body);
          else await post('/branches', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          minLength={2}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <TextField
          label={t.common.code}
          hint={t.branches.codeHint}
          value={form.code}
          pattern="[a-z0-9\-]{2,30}"
          autoCapitalize="none"
          onChange={(e) =>
            setForm({ ...form, code: e.target.value.toLowerCase() })
          }
          required
        />
        <TextField
          label={`${t.common.address} (${t.common.optional})`}
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
        <TextField
          label={`${t.common.phone} (${t.common.optional})`}
          type="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <TextField
          label={t.branches.timezone}
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          required
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

export function BranchesPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const branches = useBranches();
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const manage = can(me, 'branches.manage');
  return (
    <>
      <PageHeader
        title={t.branches.title}
        subtitle={t.branches.subtitle}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + {t.branches.add}
            </Button>
          )
        }
      />
      {branches.isPending ? (
        <LoadingState />
      ) : branches.error ? (
        <ErrorState
          error={branches.error}
          onRetry={() => void branches.refetch()}
        />
      ) : branches.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{t.common.code}</th>
                <th>{t.common.address}</th>
                <th>{t.common.phone}</th>
                <th>{t.common.status}</th>
                {manage && <th className="right">{t.common.actions}</th>}
              </tr>
            </thead>
            <tbody>
              {branches.data.map((branch) => (
                <tr key={branch.id}>
                  <td>
                    <strong>{branch.name}</strong>
                  </td>
                  <td>
                    <code>{branch.code}</code>
                  </td>
                  <td>{branch.address ?? '—'}</td>
                  <td>{branch.phone ?? '—'}</td>
                  <td>
                    {branch.isActive ? (
                      <Badge tone="success">{t.common.active}</Badge>
                    ) : (
                      <Badge>{t.common.inactive}</Badge>
                    )}
                  </td>
                  {manage && (
                    <td className="right">
                      <Button size="sm" onClick={() => setEditing(branch)}>
                        {t.common.edit}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={editing !== null}
        wide
        title={
          editing === 'new' ? t.branches.createTitle : t.branches.editTitle
        }
        onClose={() => setEditing(null)}
      >
        {editing !== null && (
          <BranchForm
            branch={editing === 'new' ? null : editing}
            onDone={async () => {
              toast(t.common.saved);
              setEditing(null);
              await client.invalidateQueries({ queryKey: ['branches'] });
            }}
          />
        )}
      </Dialog>
    </>
  );
}
