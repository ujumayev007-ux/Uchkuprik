import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { meKey } from '../../auth/session';
import { Button, FormError, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { post } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

export function MfaVerifyPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title={t.auth.mfaTitle} subtitle={t.auth.mfaSubtitle}>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/auth/mfa/verify', { code });
            await client.invalidateQueries({ queryKey: meKey });
            navigate('/', { replace: true });
          } catch (caught) {
            setError(caught);
            setCode('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t.auth.mfaCode}
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          required
          autoFocus
        />
        <FormError error={error} />
        <Button type="submit" variant="primary" size="lg" busy={busy}>
          {t.auth.verify}
        </Button>
      </form>
    </AuthLayout>
  );
}
