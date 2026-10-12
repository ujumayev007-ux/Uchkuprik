import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { meKey, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  LoadingState,
  PageHeader,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { PasswordForm } from './auth/ChangePasswordPage';
import { MfaSetup } from './auth/MfaSetupPage';

type Session = {
  id: string;
  authMethod: 'PASSWORD' | 'PIN';
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
};

export function AccountPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'password' | 'mfa' | null>(null);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () =>
      api<{ sessions: Session[] }>('/auth/sessions').then(
        (data) => data.sessions,
      ),
  });
  if (!me) return null;
  const done = async (message: string) => {
    setDialog(null);
    toast(message);
    await client.invalidateQueries({ queryKey: meKey });
    await sessions.refetch();
  };

  return (
    <>
      <PageHeader title={t.account.title} subtitle={t.account.subtitle} />
      <div className="grid-cards">
        <section className="card">
          <h2>{t.account.changePassword}</h2>
          <p className="muted">{t.auth.passwordRule}</p>
          <Button onClick={() => setDialog('password')}>
            {t.account.changePassword}
          </Button>
        </section>
        <section className="card">
          <h2>{t.account.mfa}</h2>
          <p>
            {me.mfaEnabled ? (
              <Badge tone="success">{t.account.mfaEnabled}</Badge>
            ) : (
              <Badge tone="warning">{t.account.mfaDisabled}</Badge>
            )}
          </p>
          {me.mfaEnabled ? (
            !me.isPlatformAdmin && (
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await post('/auth/mfa/disable');
                    await done(t.common.saved);
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
                {t.account.disableMfa}
              </Button>
            )
          ) : (
            <Button variant="primary" onClick={() => setDialog('mfa')}>
              {t.auth.mfaSetupTitle}
            </Button>
          )}
        </section>
      </div>
      <h2 className="section-title">{t.account.sessions}</h2>
      {sessions.isPending ? (
        <LoadingState />
      ) : sessions.error ? (
        <ErrorState
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.dashboard.signedInWith}</th>
                <th>{t.common.createdAt}</th>
                <th>{t.devices.lastSeen}</th>
                <th>IP</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((session) => (
                <tr key={session.id}>
                  <td>
                    {session.authMethod === 'PIN'
                      ? t.dashboard.methodPin
                      : t.dashboard.methodPassword}
                    <small className="muted block">
                      {session.userAgent?.slice(0, 60) ?? '—'}
                    </small>
                  </td>
                  <td>{formatDateTime(session.createdAt)}</td>
                  <td>{formatDateTime(session.lastSeenAt)}</td>
                  <td>
                    <code>{session.ipAddress ?? '—'}</code>
                  </td>
                  <td className="right">
                    {session.current ? (
                      <Badge tone="accent">{t.account.current}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
                          await post(
                            `/auth/sessions/${session.id}/revoke`,
                          ).catch(() => undefined);
                          await sessions.refetch();
                        }}
                      >
                        {t.account.endSession}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={dialog === 'password'}
        title={t.account.changePassword}
        onClose={() => setDialog(null)}
      >
        {dialog === 'password' && (
          <PasswordForm onDone={() => void done(t.common.saved)} />
        )}
      </Dialog>
      <Dialog
        open={dialog === 'mfa'}
        title={t.auth.mfaSetupTitle}
        description={t.auth.mfaSetupSubtitle}
        onClose={() => setDialog(null)}
      >
        {dialog === 'mfa' && (
          <MfaSetup onDone={() => void done(t.common.saved)} />
        )}
      </Dialog>
    </>
  );
}
