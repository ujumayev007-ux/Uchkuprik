import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { Checkbox, Dialog, SelectField, TextField } from '../components/ui';
import { t } from '../i18n';

type Section =
  'stockBalances' | 'stockLowStock' | 'stockMovements' | 'stockPurchases';
type Format = 'xlsx' | 'docx' | 'pdf';

const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
};

// The same sections and optional columns as the server's Ombor export (the first,
// fixed column of each section is always included).
const sectionColumns: Record<Section, readonly string[]> = {
  stockBalances: ['unit', 'quantity', 'minStock', 'status', 'value'],
  stockLowStock: ['unit', 'quantity', 'minStock', 'shortage', 'status'],
  stockMovements: [
    'name',
    'type',
    'quantity',
    'unit',
    'balanceAfter',
    'reason',
  ],
  stockPurchases: ['supplier', 'invoiceNo', 'status', 'lines', 'total'],
};
const columnLabel = (section: Section, column: string) =>
  (t.inventory.export.columns as Record<string, string>)[
    `${section}.${column}`
  ] ??
  (t.inventory.export.columns as Record<string, string>)[column] ??
  column;

/** Ombor report as Excel, Word or PDF: dates, sections, columns and filters. */
export function InventoryExportDialog({ onClose }: { onClose: () => void }) {
  const { data: me } = useMe();
  const text = t.inventory.export;
  const purchasing = can(me, 'purchasing.manage');
  // Same rule as the server: cost values only for those allowed to see them.
  const costs =
    (can(me, 'inventory.manage') || can(me, 'finance.view')) &&
    me?.financial?.cost !== false;
  const columnsOf = (key: Section) =>
    sectionColumns[key].filter(
      (column) => costs || !(key === 'stockBalances' && column === 'value'),
    );
  const available = (Object.keys(sectionColumns) as Section[]).filter(
    (key) => key !== 'stockPurchases' || purchasing,
  );
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [chosen, setChosen] = useState<Section[]>(['stockBalances']);
  const [hidden, setHidden] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'low' | 'out'>('all');

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const sections = available.filter((key) => chosen.includes(key));
  const params = new URLSearchParams({
    from,
    to,
    sections: sections.join(','),
    status,
  });
  if (me?.activeBranchId) params.set('branchId', me.activeBranchId);
  const hiddenPairs = hidden.filter((pair) =>
    sections.some((key) => pair.startsWith(`${key}.`)),
  );
  if (hiddenPairs.length) params.set('hidden', hiddenPairs.join(','));
  if (search.trim()) params.set('q', search.trim());
  const ready = sections.length > 0 && !!from && !!to && from <= to;
  const link = (format: Format, label: string) =>
    ready ? (
      <a
        className="btn btn-primary btn-md"
        href={`/api/inventory/export?format=${format}&${params}`}
        download
      >
        {label}
      </a>
    ) : (
      <span className="btn btn-secondary btn-md is-disabled" aria-disabled>
        {label}
      </span>
    );

  return (
    <Dialog
      open
      wide
      title={text.title}
      description={text.hint}
      onClose={onClose}
      footer={
        <>
          {link('xlsx', t.reports.excel)}
          {link('docx', t.reports.word)}
          {link('pdf', t.reports.pdf)}
        </>
      }
    >
      <div className="stack">
        <div className="toolbar">
          <TextField
            label={t.reports.from}
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label={t.reports.to}
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          <TextField
            label={text.search}
            value={search}
            maxLength={60}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SelectField
            label={text.status}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="all">{text.statuses.all}</option>
            <option value="low">{text.statuses.low}</option>
            <option value="out">{text.statuses.out}</option>
          </SelectField>
        </div>
        <p className="muted small">{text.periodHint}</p>
        {available.map((key) => (
          <div key={key} className="card stack">
            <Checkbox
              label={
                key === 'stockBalances' && !costs
                  ? text.sections.stockBalancesPlain
                  : text.sections[key]
              }
              checked={chosen.includes(key)}
              onChange={() => setChosen((list) => toggle(list, key))}
            />
            {chosen.includes(key) && (
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: '0 20px' }}
                aria-label={text.columnsLabel}
              >
                {columnsOf(key).map((column) => {
                  const pair = `${key}.${column}`;
                  return (
                    <Checkbox
                      key={pair}
                      label={columnLabel(key, column)}
                      checked={!hidden.includes(pair)}
                      onChange={() => setHidden((list) => toggle(list, pair))}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {!ready && <p className="muted small">{text.chooseSection}</p>}
      </div>
    </Dialog>
  );
}
