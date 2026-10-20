import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Button,
  Dialog,
  ErrorState,
  LoadingState,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage } from '../lib/api';

type Preview = {
  restaurant: string;
  period: string;
  generatedAt: string;
  filters: string[];
  notes: string[];
  sections: {
    key: string;
    title: string;
    note: string | null;
    columns: { key: string; label: string; align: 'left' | 'right' }[];
    rows: string[][];
    totals: string[] | null;
  }[];
};
type Layout = {
  sections: { key: string; enabled: boolean }[];
  hiddenColumns: Record<string, string[]>;
};
type LayoutResponse = {
  layout: Layout;
  catalog: {
    key: string;
    title: string;
    allowed: boolean;
    columns: { key: string; label: string; fixed: boolean }[];
  }[];
};

/** Files for the chosen dates: Excel, Word and PDF contain exactly what the preview shows. */
export function ReportExportCard({
  branchId,
  from,
  to,
}: {
  branchId: string;
  from: string;
  to: string;
}) {
  const { data: me } = useMe();
  const [editing, setEditing] = useState(false);
  const query = `branchId=${branchId}&from=${from}&to=${to}`;
  const preview = useQuery({
    queryKey: ['reports', 'preview', branchId, from, to],
    queryFn: () => api<Preview>(`/reports/preview?${query}`),
  });
  const link = (format: 'xlsx' | 'docx' | 'pdf', label: string) => (
    <a
      className="btn btn-secondary btn-md"
      href={`/api/reports/export?format=${format}&${query}`}
      download
    >
      {label}
    </a>
  );
  return (
    <section className="card stack">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{t.reports.exportTitle}</h2>
        {link('xlsx', t.reports.excel)}
        {link('docx', t.reports.word)}
        {link('pdf', t.reports.pdf)}
        {can(me, 'settings.manage') && (
          <Button onClick={() => setEditing(true)}>
            {t.reports.layoutButton}
          </Button>
        )}
      </div>
      <p className="muted small">{t.reports.exportHint}</p>
      {preview.isPending ? (
        <LoadingState />
      ) : preview.error ? (
        <ErrorState
          error={preview.error}
          onRetry={() => void preview.refetch()}
        />
      ) : (
        <details>
          <summary>{t.reports.preview}</summary>
          {preview.data.notes.map((note) => (
            <p key={note} className="muted small">
              {note}
            </p>
          ))}
          {preview.data.sections.map((section) => (
            <div key={section.key}>
              <h3>{section.title}</h3>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      {section.columns.map((column) => (
                        <th
                          key={column.key}
                          className={column.align === 'right' ? 'right' : ''}
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.length === 0 && (
                      <tr>
                        <td colSpan={section.columns.length} className="muted">
                          {t.common.emptyTitle}
                        </td>
                      </tr>
                    )}
                    {section.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((value, cell) => (
                          <td
                            key={cell}
                            className={
                              section.columns[cell]?.align === 'right'
                                ? 'right'
                                : ''
                            }
                          >
                            {value}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {section.totals && (
                      <tr>
                        {section.totals.map((value, cell) => (
                          <th
                            key={cell}
                            className={
                              section.columns[cell]?.align === 'right'
                                ? 'right'
                                : ''
                            }
                          >
                            {value}
                          </th>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {section.note && <p className="muted small">{section.note}</p>}
            </div>
          ))}
        </details>
      )}
      {editing && <LayoutDialog onClose={() => setEditing(false)} />}
    </section>
  );
}

function LayoutDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const current = useQuery({
    queryKey: ['reports', 'layout'],
    queryFn: () => api<LayoutResponse>('/reports/layout'),
  });
  const [layout, setLayout] = useState<Layout | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (current.data && !layout) setLayout(current.data.layout);
  }, [current.data, layout]);
  const meta = (key: string) =>
    current.data?.catalog.find((c) => c.key === key);
  const move = (index: number, by: number) =>
    setLayout((value) => {
      if (!value) return value;
      const next = [...value.sections];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return { ...value, sections: next };
    });
  const toggleColumn = (section: string, column: string) =>
    setLayout((value) => {
      if (!value) return value;
      const hidden = new Set(value.hiddenColumns[section] ?? []);
      if (hidden.has(column)) hidden.delete(column);
      else hidden.add(column);
      return {
        ...value,
        hiddenColumns: { ...value.hiddenColumns, [section]: [...hidden] },
      };
    });
  const save = async () => {
    if (!layout) return;
    setBusy(true);
    try {
      await api('/reports/layout', { method: 'PUT', body: layout });
      await client.invalidateQueries({ queryKey: ['reports'] });
      toast(t.common.saved);
      onClose();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      wide
      title={t.reports.layoutButton}
      description={t.reports.layoutHint}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      {!layout ? (
        <LoadingState />
      ) : (
        <div className="stack">
          {layout.sections.map((entry, index) => {
            const info = meta(entry.key);
            if (!info) return null;
            return (
              <div key={entry.key} className="card stack">
                <div className="toolbar">
                  <label>
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(event) =>
                        setLayout({
                          ...layout,
                          sections: layout.sections.map((s) =>
                            s.key === entry.key
                              ? { ...s, enabled: event.target.checked }
                              : s,
                          ),
                        })
                      }
                    />{' '}
                    <strong>{info.title}</strong>
                    {!info.allowed && (
                      <span className="muted"> — {t.reports.noPermission}</span>
                    )}
                  </label>
                  <Button
                    size="sm"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={t.reports.moveUp}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    disabled={index === layout.sections.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={t.reports.moveDown}
                  >
                    ↓
                  </Button>
                </div>
                {entry.enabled && (
                  <div className="chip-row">
                    {info.columns.map((column) => (
                      <label key={column.key} className="chip">
                        <input
                          type="checkbox"
                          disabled={column.fixed}
                          checked={
                            column.fixed ||
                            !(layout.hiddenColumns[entry.key] ?? []).includes(
                              column.key,
                            )
                          }
                          onChange={() => toggleColumn(entry.key, column.key)}
                        />{' '}
                        {column.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
