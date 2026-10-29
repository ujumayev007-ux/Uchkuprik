import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  FormError,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const o = t.offsite;

type Target = {
  name: string | null;
  at: string | null;
  ok: boolean | null;
  error: string | null;
};
type Data = {
  config: {
    folder: string | null;
    central: boolean;
    keep: number;
    hasPassword: boolean;
  };
  state: { folder: Target; central: Target };
  centralLinked: boolean;
};

function TargetLine({ label, target }: { label: string; target: Target }) {
  return (
    <div className="small">
      <strong>{label}:</strong>{' '}
      {target.at ? (
        <>
          {formatDateTime(target.at)}{' '}
          <Badge tone={target.ok ? 'success' : 'danger'}>
            {target.ok ? o.ok : o.failed}
          </Badge>
          {target.error && (
            <span className="danger-text"> · {target.error}</span>
          )}
        </>
      ) : (
        <span className="muted">{o.never}</span>
      )}
    </div>
  );
}

/**
 * Zaxira nusxani boshqa joyga: the newest backup, encrypted with the restaurant's own
 * password, copied automatically to a folder (another disk, USB, network share) and/or
 * the Owner's central server.
 */
export function OffsiteBackupSection() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['backups', 'offsite'],
    queryFn: () => api<Data>('/backups/offsite'),
    retry: false,
  });
  const [folder, setFolder] = useState('');
  const [central, setCentral] = useState(false);
  const [keep, setKeep] = useState('7');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setFolder(query.data.config.folder ?? '');
    setCentral(query.data.config.central);
    setKeep(String(query.data.config.keep));
  }, [query.data]);
  if (!query.data) return null;
  const data = query.data;
  const passwordOk =
    password === ''
      ? data.config.hasPassword
      : password.length >= 8 && password === again;
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      toast(done);
      await client.invalidateQueries({ queryKey: ['backups', 'offsite'] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="card stack"
      open={!!data.config.folder || data.config.central}
    >
      <summary>
        <strong>{o.title}</strong>
      </summary>
      <p className="muted small">{o.hint}</p>
      <TargetLine label={o.folderStatus} target={data.state.folder} />
      <TargetLine label={o.centralStatus} target={data.state.central} />
      <div className="form-grid">
        <TextField
          label={o.folder}
          placeholder="D:\FastFood-zaxira"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        />
        <TextField
          label={o.keep}
          type="number"
          min={1}
          max={60}
          value={keep}
          onChange={(event) => setKeep(event.target.value)}
        />
      </div>
      <Checkbox
        label={o.central}
        description={data.centralLinked ? o.centralHint : o.centralUnlinked}
        checked={central}
        onChange={setCentral}
      />
      <div className="form-grid">
        <TextField
          label={data.config.hasPassword ? o.passwordChange : o.password}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          label={o.passwordAgain}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
        />
      </div>
      <p className="muted small">{o.passwordHint}</p>
      <FormError error={error} />
      <div className="toolbar">
        <Button
          variant="primary"
          busy={busy}
          disabled={!passwordOk && (!!folder.trim() || central)}
          onClick={() =>
            void run(async () => {
              // A recent sign-in, as for every backup setting.
              await post('/backups/unlock');
              await api('/backups/offsite', {
                method: 'PUT',
                body: {
                  folder: folder.trim() || null,
                  central,
                  keep: Math.min(60, Math.max(1, Number(keep) || 7)),
                  ...(password ? { password } : {}),
                },
              });
              setPassword('');
              setAgain('');
            }, o.saved)
          }
        >
          {o.save}
        </Button>
        <Button
          busy={busy}
          disabled={!data.config.folder && !data.config.central}
          onClick={() => void run(() => post('/backups/offsite/run'), o.ran)}
        >
          {o.runNow}
        </Button>
      </div>
    </details>
  );
}
