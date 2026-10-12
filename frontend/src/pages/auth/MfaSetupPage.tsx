import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { meKey } from '../../auth/session';
import { Button, FormError, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { post } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

export function MfaSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(
    null,
  );
  const [svg, setSvg] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!setup) return;
    // Rendered locally: the secret never leaves the browser for a third-party QR service.
    // Loaded on demand to keep the main bundle small.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(setup.uri, { type: 'svg', margin: 1, width: 220 }),
      )
      .then(setSvg);
  }, [setup]);

  if (!setup)
    return (
      <div className="stack">
        <FormError error={error} />
        <Button
          variant="primary"
          size="lg"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setSetup(
                await post<{ secret: string; uri: string }>('/auth/mfa/setup'),
              );
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.auth.mfaStart}
        </Button>
      </div>
    );

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/auth/mfa/enable', { code });
          onDone();
        } catch (caught) {
          setError(caught);
          setCode('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div
        className="qr"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="secret-box">
        <span>{t.auth.mfaManualKey}</span>
        <code>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
      </div>
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
      />
      <FormError error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.auth.mfaEnable}
      </Button>
    </form>
  );
}

export function MfaSetupPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <AuthLayout title={t.auth.mfaSetupTitle} subtitle={t.auth.mfaSetupSubtitle}>
      <MfaSetup
        onDone={async () => {
          await client.invalidateQueries({ queryKey: meKey });
          navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
