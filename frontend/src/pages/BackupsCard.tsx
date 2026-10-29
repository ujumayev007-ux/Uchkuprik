import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Badge, Button, TextField, useToast } from '../components/ui';
import { t } from '../i18n';
import { ApiError, api, errorMessage, post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import {
  PartialRestorePanel,
  PartialResultTable,
  type PartialGroup,
  type PartialResult,
} from '../components/PartialRestore';

const b = t.backups;

type Row = {
  name: string;
  kind: string;
  createdAt: string;
  bytes: number;
  totalRows: number | null;
  verified: boolean | null;
};
type Data = {
  available: boolean;
  canRestore: boolean;
  backups: Row[];
  kept: string[];
  status: { lastAt: string | null; ok: boolean | null } | null;
};
// What waits for a password or the confirmation word.
type Pending =
  | { kind: 'export'; name: string }
  | { kind: 'restore'; name: string; at: string }
  | { kind: 'rollback'; name: string }
  | { kind: 'partial'; name: string; at: string };

const keptAt = (name: string) => {
  const d = name.replace('fastfood_before_', '');
  const at = new Date(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}Z`,
  );
  return Number.isNaN(at.getTime()) ? name : formatDateTime(at.toISOString());
};

async function failure(response: Response) {
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  return new ApiError(
    response.status,
    payload?.code ?? 'UNKNOWN',
    payload?.message ?? t.common.errorTitle,
  );
}

/**
 * Zaxira nusxalar of this restaurant computer: back up now, check, download encrypted,
 * load a downloaded copy, restore (swapped in on restart; the current data is kept).
 */
export function BackupsCard() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<Data>('/backups'),
  });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [word, setWord] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [preview, setPreview] = useState<PartialResult | null>(null);
  const [partialDone, setPartialDone] = useState<PartialResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const data = query.data;
  if (!data) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      await client.invalidateQueries({ queryKey: ['backups'] });
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setPending(null);
    setPreview(null);
    setPassword('');
    setAgain('');
    setWord('');
  };
  const download = (name: string) =>
    run(async () => {
      // Asks for the password again first when the sign-in is not recent.
      await post('/backups/unlock');
      const response = await fetch(`/api/backups/${name}/export`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw await failure(response);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name.replace('.ndjson.gz', '')}.ffbk`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      toast(b.exported);
      close();
    });
  const upload = () =>
    run(async () => {
      if (!importFile) return;
      await post('/backups/unlock');
      const response = await fetch('/api/backups/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: importFile,
      });
      if (!response.ok) throw await failure(response);
      const { uploadId } = (await response.json()) as { uploadId: string };
      await post('/backups/import', { uploadId, password: importPassword });
      toast(b.imported);
      setImportFile(null);
      setImportPassword('');
    });

  if (!data.available)
    return (
      <section className="card stack">
        <h2 className="section-title">{b.title}</h2>
        <p className="muted small">{b.unavailable}</p>
      </section>
    );
  if (restarting)
    return (
      <section className="card stack">
        <h2 className="section-title">{b.title}</h2>
        <p className="notice">{b.restarting}</p>
      </section>
    );

  const passwordOk = password.length >= 8 && password === again;
  return (
    <section className="card stack">
      <h2 className="section-title">{b.title}</h2>
      <p className="muted small">{b.hint}</p>
      <div className="toolbar">
        <span className="small">
          {b.last}:{' '}
          {data.status?.lastAt ? formatDateTime(data.status.lastAt) : b.never}{' '}
          {data.status?.ok === false && <Badge tone="danger">{b.failed}</Badge>}
        </span>
        <Button
          size="sm"
          busy={busy}
          onClick={() =>
            void run(async () => {
              await post('/backups');
              toast(b.created);
            })
          }
        >
          {b.createNow}
        </Button>
      </div>

      {pending?.kind === 'partial' && (
        <PartialRestorePanel
          title={t.partialRestore.title.replace(
            '{at}',
            formatDateTime(pending.at),
          )}
          busy={busy}
          preview={preview}
          onClose={close}
          onPreview={(groups: PartialGroup[]) =>
            void run(async () => {
              setPreview(
                await post<PartialResult>(
                  `/backups/${pending.name}/partial/preview`,
                  {
                    groups,
                  },
                ),
              );
            })
          }
          onRestore={(groups: PartialGroup[]) =>
            void run(async () => {
              // A recent sign-in, as for a full restore.
              await post('/backups/unlock');
              const result = await post<PartialResult>(
                `/backups/${pending.name}/partial`,
                { groups, confirm: 'TIKLASH' },
              );
              toast(t.partialRestore.done);
              setPartialDone(result);
              close();
            })
          }
        />
      )}
      {partialDone && (
        <div className="card stack">
          <strong>{t.partialRestore.done}</strong>
          <PartialResultTable result={partialDone} />
        </div>
      )}
      {pending && pending.kind !== 'partial' && (
        <div
          className="card stack"
          style={{ borderColor: 'var(--danger, #c0392b)' }}
        >
          {pending.kind === 'export' ? (
            <>
              <strong>{b.exportTitle}</strong>
              <p className="small">{b.exportHint}</p>
              <TextField
                label={b.password}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <TextField
                label={b.passwordAgain}
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(event) => setAgain(event.target.value)}
              />
            </>
          ) : (
            <>
              <strong>
                {pending.kind === 'restore'
                  ? b.restoreTitle.replace('{at}', formatDateTime(pending.at))
                  : b.rollbackTitle.replace('{at}', keptAt(pending.name))}
              </strong>
              <p className="small">{b.restoreWarn}</p>
              <TextField
                label={b.typeWord}
                autoComplete="off"
                value={word}
                onChange={(event) => setWord(event.target.value)}
              />
            </>
          )}
          <div className="toolbar">
            <Button
              variant={pending.kind === 'export' ? 'primary' : 'danger'}
              busy={busy}
              disabled={
                pending.kind === 'export'
                  ? !passwordOk
                  : word.trim() !== 'TIKLASH'
              }
              onClick={() => {
                if (pending.kind === 'export')
                  return void download(pending.name);
                void run(async () => {
                  if (pending.kind === 'restore')
                    await post(`/backups/${pending.name}/restore`, {
                      confirm: 'TIKLASH',
                    });
                  else
                    await post('/backups/rollback', {
                      database: pending.name,
                      confirm: 'TIKLASH',
                    });
                  close();
                  setRestarting(true);
                });
              }}
            >
              {pending.kind === 'export' ? b.download : b.confirmRestore}
            </Button>
            <Button variant="ghost" onClick={close}>
              {b.cancel}
            </Button>
          </div>
        </div>
      )}

      {data.backups.length === 0 ? (
        <p className="muted small">{b.none}</p>
      ) : (
        <ul className="ops-list">
          {data.backups.map((row) => (
            <li key={row.name} className="ops-item">
              <div className="grow">
                <strong>{formatDateTime(row.createdAt)}</strong>{' '}
                <Badge>{b.kinds[row.kind] ?? row.kind}</Badge>{' '}
                <Badge
                  tone={
                    row.verified === true
                      ? 'success'
                      : row.verified === false
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {row.verified === true
                    ? b.verified
                    : row.verified === false
                      ? b.failed
                      : b.notVerified}
                </Badge>
                <div className="muted small">
                  {(row.bytes / 1024 / 1024).toFixed(1)} MB
                  {row.totalRows !== null &&
                    ` · ${b.rows.replace('{n}', String(row.totalRows))}`}
                </div>
              </div>
              <div className="toolbar small">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await post<{ ok: boolean }>(
                        `/backups/${row.name}/verify`,
                      );
                      toast(
                        result.ok ? b.verifyOk : b.verifyFailed,
                        result.ok ? undefined : 'error',
                      );
                    })
                  }
                >
                  {b.verify}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => setPending({ kind: 'export', name: row.name })}
                >
                  {b.downloadShort}
                </Button>
                {row.verified !== false && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setPreview(null);
                      setPartialDone(null);
                      setPending({
                        kind: 'partial',
                        name: row.name,
                        at: row.createdAt,
                      });
                    }}
                  >
                    {t.partialRestore.button}
                  </Button>
                )}
                {data.canRestore && row.verified !== false && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      setPending({
                        kind: 'restore',
                        name: row.name,
                        at: row.createdAt,
                      })
                    }
                  >
                    {b.restore}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>{b.importTitle}</summary>
        <div className="stack">
          <p className="muted small">{b.importHint}</p>
          <input
            ref={fileInput}
            type="file"
            accept=".ffbk,application/octet-stream"
            onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
          />
          <TextField
            label={b.password}
            type="password"
            autoComplete="off"
            value={importPassword}
            onChange={(event) => setImportPassword(event.target.value)}
          />
          <div>
            <Button
              busy={busy}
              disabled={!importFile || importPassword.length < 8}
              onClick={() => void upload()}
            >
              {b.importButton}
            </Button>
          </div>
        </div>
      </details>

      {data.kept.length > 0 && (
        <details>
          <summary>{b.kept}</summary>
          <p className="muted small">{b.keptHint}</p>
          <ul className="ops-list">
            {data.kept.map((name) => (
              <li key={name} className="ops-item">
                <div className="grow">{keptAt(name)}</div>
                {data.canRestore && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => setPending({ kind: 'rollback', name })}
                  >
                    {b.rollback}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
