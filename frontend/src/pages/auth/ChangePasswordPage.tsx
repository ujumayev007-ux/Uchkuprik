import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { meKey } from '../../auth/session';
import { Button, FormError, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { post } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

export function PasswordForm({ onDone }: { onDone: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (newPassword !== repeat) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        setBusy(true);
        setError(null);
        try {
          await post('/auth/password', { currentPassword, newPassword });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={t.auth.currentPassword}
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrent(event.target.value)}
        required
      />
      <TextField
        label={t.auth.newPassword}
        hint={t.auth.passwordRule}
        type="password"
        autoComplete="new-password"
        minLength={10}
        value={newPassword}
        onChange={(event) => setNew(event.target.value)}
        required
      />
      <TextField
        label={t.auth.repeatPassword}
        type="password"
        autoComplete="new-password"
        value={repeat}
        error={mismatch ? t.auth.passwordMismatch : undefined}
        onChange={(event) => setRepeat(event.target.value)}
        required
      />
      <FormError error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.common.save}
      </Button>
    </form>
  );
}

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <AuthLayout
      title={t.auth.changePasswordTitle}
      subtitle={t.auth.changePasswordSubtitle}
    >
      <PasswordForm
        onDone={async () => {
          await client.invalidateQueries({ queryKey: meKey });
          navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
