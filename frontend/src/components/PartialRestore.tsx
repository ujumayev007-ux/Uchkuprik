import { useState } from 'react';
import { t } from '../i18n';
import { Button, Checkbox, TextField } from './ui';

const p = t.partialRestore;
export const PARTIAL_GROUPS = [
  'MENU',
  'FLOOR',
  'RECEIPTS',
  'INVENTORY',
  'CUSTOMERS',
] as const;
export type PartialGroup = (typeof PARTIAL_GROUPS)[number];
export type PartialResult = {
  dryRun: boolean;
  safetyBackup?: string | null;
  tables: {
    group: PartialGroup;
    table: string;
    inBackup: number;
    inserted: number;
    updated: number;
    unchanged: number;
  }[];
};

/** Counts of a preview or of a finished partial restore, one line per group. */
export function PartialResultTable({ result }: { result: PartialResult }) {
  const groups = [...new Set(result.tables.map((row) => row.group))];
  const sum = (
    group: PartialGroup,
    key: 'inserted' | 'updated' | 'unchanged',
  ) =>
    result.tables
      .filter((row) => row.group === group)
      .reduce((total, row) => total + row[key], 0);
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>{p.group}</th>
            <th className="right">{p.inserted}</th>
            <th className="right">{p.updated}</th>
            <th className="right">{p.unchanged}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group}>
              <td>{p.groups[group] ?? group}</td>
              <td className="right">{sum(group, 'inserted')}</td>
              <td className="right">{sum(group, 'updated')}</td>
              <td className="right">{sum(group, 'unchanged')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Qisman tiklash: pick parts, look at what would change, then type TIKLASH. The caller
 * runs the preview / restore (directly on the restaurant computer, or as Owner ops).
 */
export function PartialRestorePanel({
  title,
  busy,
  preview,
  onPreview,
  onRestore,
  onClose,
}: {
  title: string;
  busy: boolean;
  preview: PartialResult | null;
  onPreview: (groups: PartialGroup[]) => void;
  onRestore: (groups: PartialGroup[]) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<PartialGroup[]>(['MENU']);
  const [word, setWord] = useState('');
  return (
    <div
      className="card stack"
      style={{ borderColor: 'var(--warning, #b7791f)' }}
    >
      <strong>{title}</strong>
      <p className="small">{p.hint}</p>
      <div className="check-grid">
        {PARTIAL_GROUPS.map((group) => (
          <Checkbox
            key={group}
            label={p.groups[group] ?? group}
            description={p.modes[group]}
            checked={groups.includes(group)}
            onChange={(on) =>
              setGroups(
                on
                  ? [...groups, group]
                  : groups.filter((item) => item !== group),
              )
            }
          />
        ))}
      </div>
      <div className="toolbar">
        <Button
          busy={busy}
          disabled={groups.length === 0}
          onClick={() => onPreview(groups)}
        >
          {p.preview}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {p.cancel}
        </Button>
      </div>
      {preview && (
        <>
          <PartialResultTable result={preview} />
          <p className="small">{p.warn}</p>
          <TextField
            label={p.typeWord}
            autoComplete="off"
            value={word}
            onChange={(event) => setWord(event.target.value)}
          />
          <div>
            <Button
              variant="danger"
              busy={busy}
              disabled={word.trim() !== 'TIKLASH' || groups.length === 0}
              onClick={() => onRestore(groups)}
            >
              {p.restore}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
