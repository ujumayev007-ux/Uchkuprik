import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, del, patch, post } from '../lib/api';
import { useRoles, type Role } from './UsersPage';

type PermissionItem = { key: string; label: string };

function RoleForm({
  role,
  catalog,
  grantable,
  onDone,
}: {
  role: Role | null;
  catalog: PermissionItem[];
  grantable: (key: string) => boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<string[]>(
    role?.permissions ?? [],
  );
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
          name,
          description: description.trim() || null,
          permissions,
        };
        try {
          if (role) await patch(`/roles/${role.id}`, body);
          else await post('/roles', body);
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
          value={name}
          minLength={2}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <TextField
          label={`${t.common.description} (${t.common.optional})`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <fieldset>
        <legend>{t.roles.permissions}</legend>
        <div className="check-grid">
          {catalog.map((item) => (
            <Checkbox
              key={item.key}
              label={item.label}
              checked={permissions.includes(item.key)}
              disabled={!grantable(item.key)}
              onChange={(on) =>
                setPermissions((list) =>
                  on
                    ? [...list, item.key]
                    : list.filter((key) => key !== item.key),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

export function RolesPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const roles = useRoles();
  const catalog = useQuery({
    queryKey: ['permissions'],
    queryFn: () =>
      api<{ permissions: PermissionItem[] }>('/permissions').then(
        (data) => data.permissions,
      ),
  });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const manage = can(me, 'roles.manage');
  const isOwner = me?.roleKeys.includes('owner') ?? false;
  const grantable = (key: string) =>
    isOwner || (me?.permissions.includes(key) ?? false);
  const labels = new Map(
    (catalog.data ?? []).map((item) => [item.key, item.label]),
  );
  const refresh = () => client.invalidateQueries({ queryKey: ['roles'] });

  return (
    <>
      <PageHeader
        title={t.roles.title}
        subtitle={t.roles.subtitle}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + {t.roles.add}
            </Button>
          )
        }
      />
      {roles.isPending || catalog.isPending ? (
        <LoadingState />
      ) : roles.error || catalog.error ? (
        <ErrorState
          error={roles.error ?? catalog.error}
          onRetry={() => void roles.refetch()}
        />
      ) : (
        <div className="card-list">
          {roles.data.map((role) => (
            <article key={role.id} className="card role-card">
              <header>
                <div>
                  <h2>{role.name}</h2>
                  {role.description && (
                    <p className="muted">{role.description}</p>
                  )}
                </div>
                <div className="badges">
                  {role.systemKey && (
                    <Badge tone="accent">{t.roles.system}</Badge>
                  )}
                  <Badge>
                    {t.roles.users}: {role.userCount}
                  </Badge>
                </div>
              </header>
              <div className="badges">
                {role.permissions.map((key) => (
                  <Badge key={key}>{labels.get(key) ?? key}</Badge>
                ))}
              </div>
              {role.systemKey === 'owner' ? (
                <p className="muted small">{t.roles.ownerLocked}</p>
              ) : (
                manage && (
                  <div className="form-actions">
                    <Button size="sm" onClick={() => setEditing(role)}>
                      {t.common.edit}
                    </Button>
                    {!role.systemKey && role.userCount === 0 && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!(await confirm(t.roles.deleteConfirm))) return;
                          try {
                            await del(`/roles/${role.id}`);
                            await refresh();
                          } catch (caught) {
                            toast(
                              caught instanceof Error
                                ? caught.message
                                : t.common.errorTitle,
                              'error',
                            );
                          }
                        }}
                      >
                        {t.common.delete}
                      </Button>
                    )}
                  </div>
                )
              )}
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={editing !== null}
        wide
        title={editing === 'new' ? t.roles.createTitle : t.roles.editTitle}
        onClose={() => setEditing(null)}
      >
        {editing !== null && (
          <RoleForm
            role={editing === 'new' ? null : editing}
            catalog={catalog.data ?? []}
            grantable={grantable}
            onDone={async () => {
              toast(t.common.saved);
              setEditing(null);
              await refresh();
            }}
          />
        )}
      </Dialog>
      {confirmElement}
    </>
  );
}
