import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  FormError,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';

type ImportRow = {
  row: number;
  name: string;
  category: string;
  price: number | null;
  cost: number | null;
  variant: string;
  isActive: boolean;
  newCategory: boolean;
  errors: string[];
};

const text = t.menuImport;
const errorText = (key: string) =>
  (text as Record<string, string>)[key] ?? key;

async function sendFile(file: File, mode: 'preview' | 'commit') {
  const response = await fetch(`/api/menu/import?mode=${mode}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  }).catch(() => {
    throw new ApiError(0, 'NETWORK', t.common.errorOffline);
  });
  const payload = (await response.json().catch(() => null)) as
    | ({ code?: string; message?: string } & Record<string, unknown>)
    | null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload?.code ?? 'UNKNOWN',
      payload?.message ?? text.badFile,
    );
  return payload ?? {};
}

/**
 * "Exceldan yuklash": the filled template is checked row by row first (preview with
 * the reasons in Uzbek); only after confirmation are the rows that passed saved.
 * Existing products are never changed.
 */
export function MenuImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const good = rows?.filter((row) => row.errors.length === 0) ?? [];
  const bad = (rows?.length ?? 0) - good.length;

  const preview = async (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    setRows(null);
    setError(null);
    setBusy(true);
    try {
      const result = (await sendFile(chosen, 'preview')) as { rows?: ImportRow[] };
      if (!result.rows?.length) setError(new Error(text.noRows));
      else setRows(result.rows);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const commit = async () => {
    if (!file || good.length === 0) return;
    if (!(await confirm(text.confirmAsk.replace('{count}', String(good.length)))))
      return;
    setBusy(true);
    setError(null);
    try {
      const result = (await sendFile(file, 'commit')) as {
        created?: number;
        rejected?: ImportRow[];
      };
      toast(
        text.done
          .replace('{created}', String(result.created ?? 0))
          .replace('{rejected}', String(result.rejected?.length ?? 0)),
      );
      onDone();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      title={text.title}
      description={text.hint}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy && !!rows}
            disabled={good.length === 0}
            onClick={() => void commit()}
          >
            {text.confirm.replace('{count}', String(good.length))}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="toolbar">
          <a
            className="btn btn-secondary btn-md"
            href="/api/menu/import/template"
            download
          >
            ⬇ {t.menu.excelTemplate}
          </a>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(event) => void preview(event.target.files?.[0])}
          />
          <Button
            variant="primary"
            busy={busy && !rows}
            onClick={() => input.current?.click()}
          >
            ⬆ {text.choose}
          </Button>
          {file && <span className="muted small">{file.name}</span>}
        </div>
        {busy && !rows && <p className="muted">{text.reading}</p>}
        <FormError error={error} />
        {rows && (
          <>
            <p className={bad ? 'notice' : 'muted'}>
              {text.summary
                .replace('{ok}', String(good.length))
                .replace('{bad}', String(bad))}
            </p>
            <div className="table-wrap" style={{ maxHeight: '50vh' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{text.row}</th>
                    <th>{text.status}</th>
                    <th>{t.menu.productName}</th>
                    <th>{t.menu.category}</th>
                    <th>{text.variant}</th>
                    <th className="right">{t.menu.price}</th>
                    <th className="right">{t.menu.cost}</th>
                    <th>{t.menu.visibleField}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td className="import-status">
                        {row.errors.length === 0 ? (
                          <Badge tone="success">{text.ok}</Badge>
                        ) : (
                          row.errors.map((key) => (
                            <Badge key={key} tone="danger">
                              {errorText(key)}
                            </Badge>
                          ))
                        )}
                      </td>
                      <td>{row.name || '—'}</td>
                      <td>
                        {row.category || '—'}
                        {row.newCategory && (
                          <small className="muted block">
                            + {text.willCreateCategory}
                          </small>
                        )}
                      </td>
                      <td>{row.variant}</td>
                      <td className="right">
                        {row.price != null ? formatMoney(row.price) : '—'}
                      </td>
                      <td className="right">
                        {row.cost != null ? formatMoney(row.cost) : '—'}
                      </td>
                      <td>{row.isActive ? t.menu.visible : t.menu.hidden}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {element}
    </Dialog>
  );
}
