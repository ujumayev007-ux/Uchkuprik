import { useEffect, useRef, useState } from 'react';
import { useMe } from '../auth/session';
import { t } from '../i18n';
import { post, setReauthHandler } from '../lib/api';
import { Button, Dialog, FormError, TextField } from './ui';

/** Answers REAUTH_REQUIRED responses from anywhere in the app with a password prompt. */
export function ReauthDialog() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setPassword('');
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  return (
    <Dialog
      open={open}
      title={t.auth.reauthTitle}
      description={t.auth.reauthSubtitle}
      onClose={() => finish(false)}
    >
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post(
              '/auth/reauth',
              me?.mfaEnabled ? { password, code } : { password },
            );
            finish(true);
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t.auth.password}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
        />
        {me?.mfaEnabled && (
          <TextField
            label={t.auth.mfaCode}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            required
          />
        )}
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={() => finish(false)}>{t.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t.common.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
