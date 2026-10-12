import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBranches } from '../components/AppShell';
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
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

export type Role = {
  id: string;
  name: string;
  description: string | null;
  systemKey: string | null;
  permissions: string[];
  userCount: number;
};

type User = {
  id: string;
  username: string;
  displayName: string;
  phone: string | null;
  status: 'ACTIVE' | 'DISABLED';
  allBranches: boolean;
  branchIds: string[];
  roleIds: string[];
  hasPassword: boolean;
  hasPin: boolean;
  mfaEnabled: boolean;
  locked: boolean;
  lastLoginAt: string | null;
};

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: () => api<{ roles: Role[] }>('/roles').then((data) => data.roles),
  });
}

function UserForm({
  user,
  roles,
  onDone,
}: {
  user: User | null;
  roles: Role[];
  onDone: () => void;
}) {
  const branches = useBranches();
  const [form, setForm] = useState({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    phone: user?.phone ?? '',
    password: '',
    pin: '',
    roleIds: user?.roleIds ?? [],
    allBranches: user?.allBranches ?? false,
    branchIds: user?.branchIds ?? [],
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [credentialError, setCredentialError] = useState(false);
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!user && !form.password && !form.pin) {
          setCredentialError(true);
          return;
        }
        setCredentialError(false);
        setBusy(true);
        setError(null);
        const base = {
          displayName: form.displayName,
          phone: form.phone.trim() || null,
          roleIds: form.roleIds,
          allBranches: form.allBranches,
          branchIds: form.allBranches ? [] : form.branchIds,
        };
        try {
          if (user) await patch(`/users/${user.id}`, base);
          else
            await post('/users', {
              ...base,
              username: form.username,
              ...(form.password ? { password: form.password } : {}),
              ...(form.pin ? { pin: form.pin } : {}),
            });
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
          label={t.users.username}
          value={form.username}
          disabled={!!user}
          autoCapitalize="none"
          spellCheck={false}
          pattern="[a-z0-9._\-]{3,40}"
          onChange={(event) =>
            setForm({ ...form, username: event.target.value.toLowerCase() })
          }
          required
        />
        <TextField
          label={t.users.displayName}
          value={form.displayName}
          minLength={2}
          onChange={(event) =>
            setForm({ ...form, displayName: event.target.value })
          }
          required
        />
        <TextField
          label={`${t.common.phone} (${t.common.optional})`}
          type="tel"
          value={form.phone}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
        />
        {!user && (
          <>
            <TextField
              label={`${t.users.initialPassword} (${t.common.optional})`}
              hint={t.users.initialPasswordHint}
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
            />
            <TextField
              label={`${t.users.pin} (${t.common.optional})`}
              hint={t.users.pinHint}
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              autoComplete="off"
              value={form.pin}
              error={credentialError ? t.users.needCredential : undefined}
              onChange={(event) =>
                setForm({ ...form, pin: event.target.value.replace(/\D/g, '') })
              }
            />
          </>
        )}
      </div>
      <fieldset>
        <legend>{t.users.roles}</legend>
        <div className="check-grid">
          {roles.map((role) => (
            <Checkbox
              key={role.id}
              label={role.name}
              checked={form.roleIds.includes(role.id)}
              onChange={(on) =>
                setForm({ ...form, roleIds: toggle(form.roleIds, role.id, on) })
              }
            />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t.users.branches}</legend>
        <Checkbox
          label={t.users.allBranches}
          checked={form.allBranches}
          onChange={(on) => setForm({ ...form, allBranches: on })}
        />
        {!form.allBranches && (
          <div className="check-grid">
            {(branches.data ?? []).map((branch) => (
              <Checkbox
                key={branch.id}
                label={branch.name}
                checked={form.branchIds.includes(branch.id)}
                onChange={(on) =>
                  setForm({
                    ...form,
                    branchIds: toggle(form.branchIds, branch.id, on),
                  })
                }
              />
            ))}
          </div>
        )}
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

function SecretDialog({
  user,
  kind,
  onClose,
}: {
  user: User;
  kind: 'pin' | 'password';
  onClose: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      title={`${kind === 'pin' ? t.users.setPin : t.users.resetPassword}: ${user.displayName}`}
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post(
              `/users/${user.id}/${kind}`,
              kind === 'pin' ? { pin: value } : { password: value },
            );
            toast(kind === 'pin' ? t.users.pinSaved : t.users.passwordSaved);
            onClose();
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        {kind === 'pin' ? (
          <TextField
            label={t.users.pin}
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            autoComplete="off"
            value={value}
            onChange={(event) =>
              setValue(event.target.value.replace(/\D/g, ''))
            }
            required
            autoFocus
          />
        ) : (
          <TextField
            label={t.auth.newPassword}
            hint={t.auth.passwordRule}
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            autoFocus
          />
        )}
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function UsersPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: User[] }>('/users').then((data) => data.users),
  });
  const roles = useRoles();
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [secret, setSecret] = useState<{
    user: User;
    kind: 'pin' | 'password';
  } | null>(null);
  const [query, setQuery] = useState('');
  const manage = can(me, 'users.manage');
  const roleName = new Map(
    (roles.data ?? []).map((role) => [role.id, role.name]),
  );

  const refresh = () => client.invalidateQueries({ queryKey: ['users'] });
  const action = async (
    fn: () => Promise<unknown>,
    message = t.common.saved,
  ) => {
    try {
      await fn();
      toast(message);
      await refresh();
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };

  const filtered = (users.data ?? []).filter((user) =>
    `${user.displayName} ${user.username}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title={t.users.title}
        subtitle={t.users.subtitle}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + {t.users.add}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder={t.common.search}
          aria-label={t.common.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {users.isPending ? (
        <LoadingState />
      ) : users.error ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.users.displayName}</th>
                <th>{t.users.roles}</th>
                <th>{t.common.status}</th>
                <th>{t.users.lastLogin}</th>
                {manage && <th className="right">{t.common.actions}</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <small className="muted block">@{user.username}</small>
                  </td>
                  <td>
                    {user.roleIds.length === 0 ? (
                      <span className="muted">{t.users.noRoles}</span>
                    ) : (
                      user.roleIds.map((id) => (
                        <Badge key={id}>{roleName.get(id) ?? '—'}</Badge>
                      ))
                    )}
                  </td>
                  <td className="badges">
                    {user.status === 'ACTIVE' ? (
                      <Badge tone="success">{t.common.active}</Badge>
                    ) : (
                      <Badge tone="danger">{t.common.disabled}</Badge>
                    )}
                    {user.locked && (
                      <Badge tone="warning">{t.users.locked}</Badge>
                    )}
                    {user.hasPin && <Badge>PIN</Badge>}
                    {user.mfaEnabled && (
                      <Badge tone="accent">{t.users.mfa}</Badge>
                    )}
                  </td>
                  <td>{formatDateTime(user.lastLoginAt, t.common.never)}</td>
                  {manage && (
                    <td className="right">
                      <details className="menu">
                        <summary className="btn btn-ghost btn-sm">
                          {t.common.actions} ▾
                        </summary>
                        <div className="menu-list">
                          <button onClick={() => setEditing(user)}>
                            {t.common.edit}
                          </button>
                          <button
                            onClick={() => setSecret({ user, kind: 'pin' })}
                          >
                            {t.users.setPin}
                          </button>
                          {user.hasPin && (
                            <button
                              onClick={() =>
                                action(() =>
                                  post(`/users/${user.id}/pin`, { pin: null }),
                                )
                              }
                            >
                              {t.users.removePin}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              setSecret({ user, kind: 'password' })
                            }
                          >
                            {t.users.resetPassword}
                          </button>
                          {user.locked && (
                            <button
                              onClick={() =>
                                action(() => post(`/users/${user.id}/unlock`))
                              }
                            >
                              {t.users.unlock}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              action(() =>
                                post(`/users/${user.id}/sessions/revoke`),
                              )
                            }
                          >
                            {t.users.revokeSessions}
                          </button>
                          {user.id !== me?.userId &&
                            (user.status === 'ACTIVE' ? (
                              <button
                                className="danger"
                                onClick={async () => {
                                  if (await confirm(t.users.disableConfirm))
                                    await action(() =>
                                      post(`/users/${user.id}/status`, {
                                        status: 'DISABLED',
                                      }),
                                    );
                                }}
                              >
                                {t.users.disable}
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  action(() =>
                                    post(`/users/${user.id}/status`, {
                                      status: 'ACTIVE',
                                    }),
                                  )
                                }
                              >
                                {t.users.enable}
                              </button>
                            ))}
                        </div>
                      </details>
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
        title={editing === 'new' ? t.users.createTitle : t.users.editTitle}
        onClose={() => setEditing(null)}
      >
        {editing !== null && (
          <UserForm
            user={editing === 'new' ? null : editing}
            roles={roles.data ?? []}
            onDone={async () => {
              toast(editing === 'new' ? t.users.created : t.common.saved);
              setEditing(null);
              await refresh();
            }}
          />
        )}
      </Dialog>
      {secret && (
        <SecretDialog
          user={secret.user}
          kind={secret.kind}
          onClose={() => {
            setSecret(null);
            void refresh();
          }}
        />
      )}
      {confirmElement}
    </>
  );
}
