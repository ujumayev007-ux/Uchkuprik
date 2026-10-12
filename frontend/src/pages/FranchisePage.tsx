import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useBranches } from '../components/AppShell';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { BrandSelect } from '../lib/brands';
import { formatDateTime, formatMoney } from '../lib/format';

type Tab = keyof typeof t.franchise.tabs;
type FranchiseeStatus = keyof typeof t.franchise.status;
type Franchisee = {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  status: FranchiseeStatus;
  notes: string | null;
  branches: { id: string; name: string }[];
  contractCount: number;
};
type Contract = {
  id: string;
  franchiseeId: string;
  brandId: string | null;
  number: string;
  territory: string;
  exclusive: boolean;
  startDate: string;
  endDate: string | null;
  royaltyBp: number;
  marketingFeeBp: number;
  minimumMonthlyFee: number;
  status: keyof typeof t.franchise.contractStatus;
  franchisee: { name: string };
  brand: { name: string } | null;
};
type Statement = {
  id: string;
  month: string;
  grossSales: number;
  refunds: number;
  netSales: number;
  royalty: number;
  marketingFee: number;
  minimumTopUp: number;
  total: number;
  status: keyof typeof t.franchise.statementStatus;
  reference: string | null;
  contract: { number: string; franchisee: { name: string } };
};
type Inspection = {
  id: string;
  inspectedAt: string;
  score: number;
  notes: string | null;
  items: { label: string; passed: boolean; note?: string }[];
  branch: { name: string };
};

const date = (value: string | null) => (value ? value.slice(0, 10) : '—');
const percent = (bp: number) => `${(bp / 100).toLocaleString('uz-UZ')}%`;
const lastMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
};
export const scoreTone = (score: number) =>
  score >= 85 ? 'success' : score >= 65 ? 'warning' : 'danger';

function useAction() {
  const toast = useToast();
  const client = useQueryClient();
  return async (run: () => Promise<unknown>, done = t.common.saved) => {
    try {
      await run();
      toast(done);
      await client.invalidateQueries({ queryKey: ['franchise'] });
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };
}

function Loader<T>({
  query,
  children,
}: {
  query: {
    isPending: boolean;
    error: unknown;
    data: T | undefined;
    refetch: () => unknown;
  };
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.error || query.data === undefined)
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  return <>{children(query.data)}</>;
}

// ------------------------------------------------------------ franchisees

function FranchiseeForm({
  franchisee,
  onDone,
}: {
  franchisee: Franchisee | null;
  onDone: () => void;
}) {
  const branches = useBranches();
  const [form, setForm] = useState({
    name: franchisee?.name ?? '',
    legalName: franchisee?.legalName ?? '',
    taxId: franchisee?.taxId ?? '',
    contactName: franchisee?.contactName ?? '',
    phone: franchisee?.phone ?? '',
    email: franchisee?.email ?? '',
    status: franchisee?.status ?? 'ONBOARDING',
    notes: franchisee?.notes ?? '',
    branchIds: franchisee?.branches.map((branch) => branch.id) ?? [],
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (franchisee)
            await api(`/franchise/franchisees/${franchisee.id}`, {
              method: 'PUT',
              body: form,
            });
          else await post('/franchise/franchisees', form);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          onChange={set('name')}
          minLength={2}
          required
        />
        <TextField
          label={`${t.franchise.legalName} (${t.common.optional})`}
          value={form.legalName}
          onChange={set('legalName')}
        />
        <TextField
          label={`${t.franchise.taxId} (${t.common.optional})`}
          value={form.taxId}
          inputMode="numeric"
          pattern="\d{9}|\d{14}"
          onChange={set('taxId')}
        />
        <TextField
          label={`${t.franchise.contactName} (${t.common.optional})`}
          value={form.contactName}
          onChange={set('contactName')}
        />
        <TextField
          label={`${t.common.phone} (${t.common.optional})`}
          type="tel"
          value={form.phone}
          onChange={set('phone')}
        />
        <TextField
          label={`${t.franchise.email} (${t.common.optional})`}
          type="email"
          value={form.email}
          onChange={set('email')}
        />
        <SelectField
          label={t.common.status}
          value={form.status}
          onChange={(event) =>
            setForm({
              ...form,
              status: event.target.value as FranchiseeStatus,
            })
          }
        >
          {Object.entries(t.franchise.status).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label={`${t.franchise.notes} (${t.common.optional})`}
          value={form.notes}
          onChange={set('notes')}
        />
      </div>
      <fieldset>
        <legend>{t.franchise.branches}</legend>
        <div className="check-grid">
          {(branches.data ?? []).map((branch) => (
            <Checkbox
              key={branch.id}
              label={branch.name}
              checked={form.branchIds.includes(branch.id)}
              onChange={(checked) =>
                setForm({
                  ...form,
                  branchIds: checked
                    ? [...form.branchIds, branch.id]
                    : form.branchIds.filter((id) => id !== branch.id),
                })
              }
            />
          ))}
        </div>
      </fieldset>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function FranchiseesTab() {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Franchisee | 'new' | null>(null);
  const query = useQuery({
    queryKey: ['franchise', 'franchisees'],
    queryFn: () =>
      api<{ franchisees: Franchisee[] }>('/franchise/franchisees').then(
        (data) => data.franchisees,
      ),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {t.franchise.addFranchisee}
        </Button>
      </div>
      <Loader query={query}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.franchise.franchisee}</th>
                    <th>{t.franchise.branches}</th>
                    <th>{t.common.phone}</th>
                    <th>{t.common.status}</th>
                    <th className="right">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name}</strong>
                        {row.taxId && (
                          <div className="muted small">
                            {t.franchise.taxId}: {row.taxId}
                          </div>
                        )}
                      </td>
                      <td>
                        {row.branches.map((branch) => branch.name).join(', ') ||
                          '—'}
                      </td>
                      <td className="nowrap">{row.phone ?? '—'}</td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'ACTIVE'
                              ? 'success'
                              : row.status === 'ONBOARDING'
                                ? 'accent'
                                : 'danger'
                          }
                        >
                          {t.franchise.status[row.status]}
                        </Badge>
                      </td>
                      <td className="right">
                        <Button size="sm" onClick={() => setEditing(row)}>
                          {t.common.edit}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loader>
      <Dialog
        open={editing !== null}
        title={t.franchise.addFranchisee}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <FranchiseeForm
            franchisee={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void client.invalidateQueries({ queryKey: ['franchise'] });
              void client.invalidateQueries({ queryKey: ['branches'] });
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

// -------------------------------------------------------------- contracts

function ContractForm({
  contract,
  franchisees,
  onDone,
}: {
  contract: Contract | null;
  franchisees: Franchisee[];
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    franchiseeId: contract?.franchiseeId ?? franchisees[0]?.id ?? '',
    brandId: contract?.brandId ?? '',
    number: contract?.number ?? '',
    territory: contract?.territory ?? '',
    exclusive: contract?.exclusive ?? false,
    startDate: date(contract?.startDate ?? new Date().toISOString()),
    endDate: contract?.endDate ? date(contract.endDate) : '',
    royalty: contract ? String(contract.royaltyBp / 100) : '5',
    marketing: contract ? String(contract.marketingFeeBp / 100) : '0',
    minimumMonthlyFee: contract?.minimumMonthlyFee ?? 0,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  const bp = (value: string) =>
    Math.round(Number(value.replace(',', '.') || 0) * 100);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          franchiseeId: form.franchiseeId,
          brandId: form.brandId || null,
          number: form.number,
          territory: form.territory,
          exclusive: form.exclusive,
          startDate: form.startDate,
          endDate: form.endDate || null,
          royaltyBp: bp(form.royalty),
          marketingFeeBp: bp(form.marketing),
          minimumMonthlyFee: form.minimumMonthlyFee,
        };
        try {
          if (contract)
            await api(`/franchise/contracts/${contract.id}`, {
              method: 'PUT',
              body,
            });
          else await post('/franchise/contracts', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <SelectField
          label={t.franchise.franchisee}
          value={form.franchiseeId}
          onChange={(event) =>
            setForm({ ...form, franchiseeId: event.target.value })
          }
          required
        >
          {franchisees.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </SelectField>
        <BrandSelect
          value={form.brandId}
          emptyLabel={t.franchise.allBrands}
          onChange={(brandId) => setForm({ ...form, brandId })}
        />
        <TextField
          label={t.franchise.number}
          value={form.number}
          onChange={set('number')}
          required
        />
        <TextField
          label={t.franchise.territory}
          value={form.territory}
          onChange={set('territory')}
          minLength={2}
          required
        />
        <TextField
          label={t.franchise.startDate}
          type="date"
          value={form.startDate}
          onChange={set('startDate')}
          required
        />
        <TextField
          label={`${t.franchise.endDate} (${t.common.optional})`}
          type="date"
          value={form.endDate}
          onChange={set('endDate')}
        />
        <TextField
          label={t.franchise.royalty}
          inputMode="decimal"
          value={form.royalty}
          pattern="\d{1,2}([.,]\d{1,2})?"
          onChange={set('royalty')}
          required
        />
        <TextField
          label={t.franchise.marketing}
          inputMode="decimal"
          value={form.marketing}
          pattern="\d{1,2}([.,]\d{1,2})?"
          onChange={set('marketing')}
        />
        <MoneyField
          label={t.franchise.minimumFee}
          value={form.minimumMonthlyFee}
          onChange={(value) =>
            setForm({ ...form, minimumMonthlyFee: value ?? 0 })
          }
        />
      </div>
      <Checkbox
        label={t.franchise.exclusive}
        checked={form.exclusive}
        onChange={(exclusive) => setForm({ ...form, exclusive })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function ContractsTab() {
  const client = useQueryClient();
  const action = useAction();
  const { confirm, element: confirmElement } = useConfirm();
  const [editing, setEditing] = useState<Contract | 'new' | null>(null);
  const [terminating, setTerminating] = useState<Contract | null>(null);
  const [reason, setReason] = useState('');
  const contracts = useQuery({
    queryKey: ['franchise', 'contracts'],
    queryFn: () =>
      api<{ contracts: Contract[] }>('/franchise/contracts').then(
        (data) => data.contracts,
      ),
  });
  const franchisees = useQuery({
    queryKey: ['franchise', 'franchisees'],
    queryFn: () =>
      api<{ franchisees: Franchisee[] }>('/franchise/franchisees').then(
        (data) => data.franchisees,
      ),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <Button
          variant="primary"
          disabled={!franchisees.data?.length}
          onClick={() => setEditing('new')}
        >
          + {t.franchise.addContract}
        </Button>
      </div>
      <Loader query={contracts}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.franchise.contract}</th>
                    <th>{t.franchise.franchisee}</th>
                    <th>{t.franchise.territory}</th>
                    <th>{t.franchise.royalty}</th>
                    <th>{t.franchise.startDate}</th>
                    <th>{t.common.status}</th>
                    <th className="right">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">
                        <strong>{row.number}</strong>
                        {row.brand && (
                          <div className="muted small">{row.brand.name}</div>
                        )}
                      </td>
                      <td>{row.franchisee.name}</td>
                      <td>
                        {row.territory}
                        {row.exclusive && (
                          <>
                            {' '}
                            <Badge tone="accent">{t.franchise.exclusive}</Badge>
                          </>
                        )}
                      </td>
                      <td className="nowrap">
                        {percent(row.royaltyBp)} + {percent(row.marketingFeeBp)}
                      </td>
                      <td className="nowrap">
                        {date(row.startDate)} – {date(row.endDate)}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'ACTIVE'
                              ? 'success'
                              : row.status === 'DRAFT'
                                ? 'neutral'
                                : 'danger'
                          }
                        >
                          {t.franchise.contractStatus[row.status]}
                        </Badge>
                      </td>
                      <td className="right nowrap">
                        {row.status === 'DRAFT' && (
                          <>
                            <Button size="sm" onClick={() => setEditing(row)}>
                              {t.common.edit}
                            </Button>{' '}
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={async () => {
                                if (await confirm(t.franchise.activateConfirm))
                                  await action(() =>
                                    post(
                                      `/franchise/contracts/${row.id}/activate`,
                                    ),
                                  );
                              }}
                            >
                              {t.franchise.activate}
                            </Button>
                          </>
                        )}
                        {row.status === 'ACTIVE' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReason('');
                              setTerminating(row);
                            }}
                          >
                            {t.franchise.terminate}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loader>
      <Dialog
        open={editing !== null}
        title={t.franchise.addContract}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && franchisees.data && (
          <ContractForm
            contract={editing === 'new' ? null : editing}
            franchisees={franchisees.data}
            onDone={() => {
              setEditing(null);
              void client.invalidateQueries({ queryKey: ['franchise'] });
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={terminating !== null}
        title={`${t.franchise.terminate}: ${terminating?.number ?? ''}`}
        onClose={() => setTerminating(null)}
        footer={
          <>
            <Button onClick={() => setTerminating(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              onClick={async () => {
                const id = terminating!.id;
                if (
                  await action(() =>
                    post(`/franchise/contracts/${id}/terminate`, { reason }),
                  )
                )
                  setTerminating(null);
              }}
            >
              {t.franchise.terminate}
            </Button>
          </>
        }
      >
        <TextField
          label={t.franchise.terminateReason}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Dialog>
      {confirmElement}
    </section>
  );
}

// ------------------------------------------------------------- statements

function StatementsTab() {
  const toast = useToast();
  const client = useQueryClient();
  const action = useAction();
  const [month, setMonth] = useState(lastMonth);
  const [paying, setPaying] = useState<Statement | null>(null);
  const [reference, setReference] = useState('');
  const query = useQuery({
    queryKey: ['franchise', 'statements', month],
    queryFn: () =>
      api<{ statements: Statement[] }>(
        `/franchise/statements?month=${month}`,
      ).then((data) => data.statements),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <TextField
          label={t.franchise.month}
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
        <Button
          variant="primary"
          onClick={async () => {
            try {
              const result = await post<{
                created: number;
                updated: number;
                locked: number;
              }>('/franchise/statements/generate', { month });
              toast(
                t.franchise.generated
                  .replace('{created}', String(result.created))
                  .replace('{updated}', String(result.updated))
                  .replace('{locked}', String(result.locked)),
              );
              await client.invalidateQueries({ queryKey: ['franchise'] });
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
          }}
        >
          {t.franchise.generate}
        </Button>
        <a
          className="btn btn-secondary btn-sm"
          href={`/api/franchise/statements.csv?month=${month}`}
        >
          {t.franchise.download}
        </a>
      </div>
      <Loader query={query}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.franchise.franchisee}</th>
                    <th className="right">{t.franchise.netSales}</th>
                    <th className="right">{t.franchise.royalty}</th>
                    <th className="right">{t.franchise.marketingFee}</th>
                    <th className="right">{t.franchise.topUp}</th>
                    <th className="right">{t.franchise.total}</th>
                    <th>{t.common.status}</th>
                    <th className="right">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.contract.franchisee.name}</strong>
                        <div className="muted small">
                          {row.contract.number} · {t.franchise.grossSales}{' '}
                          {formatMoney(row.grossSales)} · {t.franchise.refunds}{' '}
                          {formatMoney(row.refunds)}
                        </div>
                      </td>
                      <td className="right nowrap">
                        {formatMoney(row.netSales)}
                      </td>
                      <td className="right nowrap">
                        {formatMoney(row.royalty)}
                      </td>
                      <td className="right nowrap">
                        {formatMoney(row.marketingFee)}
                      </td>
                      <td className="right nowrap">
                        {formatMoney(row.minimumTopUp)}
                      </td>
                      <td className="right nowrap">
                        <strong>{formatMoney(row.total)}</strong>
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'PAID'
                              ? 'success'
                              : row.status === 'ISSUED'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {t.franchise.statementStatus[row.status]}
                        </Badge>
                      </td>
                      <td className="right nowrap">
                        {row.status === 'DRAFT' && (
                          <Button
                            size="sm"
                            onClick={() =>
                              void action(() =>
                                post(`/franchise/statements/${row.id}/issue`),
                              )
                            }
                          >
                            {t.franchise.issue}
                          </Button>
                        )}
                        {row.status === 'ISSUED' && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              setReference('');
                              setPaying(row);
                            }}
                          >
                            {t.franchise.markPaid}
                          </Button>
                        )}
                        {row.status === 'PAID' && (
                          <span className="muted small">{row.reference}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loader>
      <Dialog
        open={paying !== null}
        title={t.franchise.markPaid}
        onClose={() => setPaying(null)}
        footer={
          <>
            <Button onClick={() => setPaying(null)}>{t.common.cancel}</Button>
            <Button
              variant="primary"
              disabled={reference.trim().length < 2}
              onClick={async () => {
                const id = paying!.id;
                if (
                  await action(() =>
                    post(`/franchise/statements/${id}/paid`, { reference }),
                  )
                )
                  setPaying(null);
              }}
            >
              {t.franchise.markPaid}
            </Button>
          </>
        }
      >
        <TextField
          label={t.franchise.reference}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------ inspections

export function InspectionList({ rows }: { rows: Inspection[] }) {
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t.franchise.inspectedAt}</th>
            <th>{t.franchise.branches}</th>
            <th>{t.franchise.score}</th>
            <th>{t.franchise.checklist}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="nowrap">{formatDateTime(row.inspectedAt)}</td>
              <td>{row.branch.name}</td>
              <td>
                <Badge tone={scoreTone(row.score)}>{row.score}</Badge>
              </td>
              <td className="small">
                {row.items
                  .filter((item) => !item.passed)
                  .map((item) =>
                    item.note
                      ? `✗ ${item.label} (${item.note})`
                      : `✗ ${item.label}`,
                  )
                  .join('; ') || '✓'}
                {row.notes && <div className="muted">{row.notes}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InspectionForm({ onDone }: { onDone: () => void }) {
  const branches = useBranches();
  const [branchId, setBranchId] = useState('');
  const [checklist, setChecklist] = useState(t.franchise.defaultChecklist);
  const labels = checklist
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const [failed, setFailed] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const selected = branchId || branches.data?.[0]?.id || '';
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/franchise/inspections', {
            branchId: selected,
            inspectedAt: new Date().toISOString(),
            items: labels.map((label) => ({
              label,
              passed: !failed.includes(label),
            })),
            notes: notes.trim() || null,
          });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <SelectField
        label={t.franchise.branches}
        value={selected}
        onChange={(event) => setBranchId(event.target.value)}
      >
        {(branches.data ?? []).map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </SelectField>
      <label className="field">
        <span>{t.franchise.checklist}</span>
        <textarea
          rows={5}
          value={checklist}
          aria-describedby="checklist-hint"
          onChange={(event) => setChecklist(event.target.value)}
        />
        <small id="checklist-hint" className="muted">
          {t.franchise.checklistHint}
        </small>
      </label>
      <fieldset>
        <legend>{t.franchise.passed}</legend>
        <div className="check-grid">
          {labels.map((label) => (
            <Checkbox
              key={label}
              label={label}
              checked={!failed.includes(label)}
              onChange={(checked) =>
                setFailed(
                  checked
                    ? failed.filter((item) => item !== label)
                    : [...failed, label],
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <TextField
        label={`${t.franchise.notes} (${t.common.optional})`}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!selected || labels.length === 0}
        >
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function InspectionsTab() {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const query = useQuery({
    queryKey: ['franchise', 'inspections'],
    queryFn: () =>
      api<{ inspections: Inspection[] }>('/franchise/inspections').then(
        (data) => data.inspections,
      ),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setAdding(true)}>
          + {t.franchise.addInspection}
        </Button>
      </div>
      <Loader query={query}>{(rows) => <InspectionList rows={rows} />}</Loader>
      <Dialog
        open={adding}
        title={t.franchise.addInspection}
        onClose={() => setAdding(false)}
        wide
      >
        {adding && (
          <InspectionForm
            onDone={() => {
              setAdding(false);
              void client.invalidateQueries({ queryKey: ['franchise'] });
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------- scorecards

type Scorecard = {
  franchiseeId: string;
  name: string;
  status: FranchiseeStatus;
  branchCount: number;
  activeContracts: number;
  contractEndsAt: string | null;
  sales: number;
  orders: number;
  averageScore: number | null;
  inspections: number;
  lastInspectionAt: string | null;
  outstanding: number;
};

function ScorecardsTab() {
  const [month, setMonth] = useState(lastMonth);
  const query = useQuery({
    queryKey: ['franchise', 'scorecards', month],
    queryFn: () =>
      api<{ scorecards: Scorecard[] }>(
        `/franchise/scorecards?month=${month}`,
      ).then((data) => data.scorecards),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <TextField
          label={t.franchise.month}
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </div>
      <Loader query={query}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="brand-grid">
              {rows.map((card) => (
                <article key={card.franchiseeId} className="card stack">
                  <div className="toolbar">
                    <h3>{card.name}</h3>
                    <Badge
                      tone={
                        card.averageScore === null
                          ? 'neutral'
                          : scoreTone(card.averageScore)
                      }
                    >
                      {card.averageScore ?? '—'}
                    </Badge>
                  </div>
                  <dl className="totals">
                    <dt>{t.franchise.sales}</dt>
                    <dd>{formatMoney(card.sales)}</dd>
                    <dt>{t.franchise.branches}</dt>
                    <dd>{card.branchCount}</dd>
                    <dt>{t.franchise.averageScore}</dt>
                    <dd>
                      {card.averageScore ?? '—'} ({card.inspections})
                    </dd>
                    <dt>{t.franchise.lastInspection}</dt>
                    <dd>{date(card.lastInspectionAt)}</dd>
                    <dt>{t.franchise.outstanding}</dt>
                    <dd>{formatMoney(card.outstanding)}</dd>
                    <dt>{t.franchise.contractEnds}</dt>
                    <dd>{date(card.contractEndsAt)}</dd>
                  </dl>
                </article>
              ))}
            </div>
          )
        }
      </Loader>
    </section>
  );
}

// ------------------------------------------------------ supplier agreements

type Agreement = {
  id: string;
  supplierId: string;
  brandId: string | null;
  title: string;
  startDate: string;
  endDate: string | null;
  paymentTermsDays: number | null;
  terms: string | null;
  isActive: boolean;
  supplier: { name: string };
  brand: { name: string } | null;
};

function AgreementForm({
  agreement,
  onDone,
}: {
  agreement: Agreement | null;
  onDone: () => void;
}) {
  const suppliers = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () =>
      api<{ suppliers: { id: string; name: string }[] }>('/suppliers').then(
        (data) => data.suppliers,
      ),
  });
  const [form, setForm] = useState({
    supplierId: agreement?.supplierId ?? '',
    brandId: agreement?.brandId ?? '',
    title: agreement?.title ?? '',
    startDate: date(agreement?.startDate ?? new Date().toISOString()),
    endDate: agreement?.endDate ? date(agreement.endDate) : '',
    paymentTermsDays:
      agreement?.paymentTermsDays === null ||
      agreement?.paymentTermsDays === undefined
        ? ''
        : String(agreement.paymentTermsDays),
    terms: agreement?.terms ?? '',
    isActive: agreement?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const supplierId = form.supplierId || suppliers.data?.[0]?.id || '';
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          supplierId,
          brandId: form.brandId || null,
          title: form.title,
          startDate: form.startDate,
          endDate: form.endDate || null,
          paymentTermsDays:
            form.paymentTermsDays === '' ? null : Number(form.paymentTermsDays),
          terms: form.terms.trim() || null,
          isActive: form.isActive,
        };
        try {
          if (agreement)
            await api(`/supplier-agreements/${agreement.id}`, {
              method: 'PUT',
              body,
            });
          else await post('/supplier-agreements', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <SelectField
          label={t.franchise.supplier}
          value={supplierId}
          onChange={(event) =>
            setForm({ ...form, supplierId: event.target.value })
          }
          required
        >
          {(suppliers.data ?? []).map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </SelectField>
        <BrandSelect
          value={form.brandId}
          emptyLabel={t.franchise.allBrands}
          onChange={(brandId) => setForm({ ...form, brandId })}
        />
        <TextField
          label={t.franchise.agreementTitle}
          value={form.title}
          onChange={set('title')}
          minLength={2}
          required
        />
        <TextField
          label={t.franchise.startDate}
          type="date"
          value={form.startDate}
          onChange={set('startDate')}
          required
        />
        <TextField
          label={`${t.franchise.endDate} (${t.common.optional})`}
          type="date"
          value={form.endDate}
          onChange={set('endDate')}
        />
        <TextField
          label={`${t.franchise.paymentTerms} (${t.common.optional})`}
          inputMode="numeric"
          pattern="\d{1,3}"
          value={form.paymentTermsDays}
          onChange={set('paymentTermsDays')}
        />
        <TextField
          label={`${t.franchise.terms} (${t.common.optional})`}
          value={form.terms}
          onChange={set('terms')}
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!supplierId}
        >
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function AgreementsTab() {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Agreement | 'new' | null>(null);
  const query = useQuery({
    queryKey: ['franchise', 'agreements'],
    queryFn: () =>
      api<{ agreements: Agreement[] }>('/supplier-agreements').then(
        (data) => data.agreements,
      ),
  });
  return (
    <section className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {t.franchise.addAgreement}
        </Button>
      </div>
      <Loader query={query}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.franchise.agreementTitle}</th>
                    <th>{t.franchise.supplier}</th>
                    <th>{t.franchise.startDate}</th>
                    <th>{t.franchise.paymentTerms}</th>
                    <th>{t.common.status}</th>
                    <th className="right">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.title}</strong>
                        {row.brand && (
                          <div className="muted small">{row.brand.name}</div>
                        )}
                      </td>
                      <td>{row.supplier.name}</td>
                      <td className="nowrap">
                        {date(row.startDate)} – {date(row.endDate)}
                      </td>
                      <td>{row.paymentTermsDays ?? '—'}</td>
                      <td>
                        <Badge tone={row.isActive ? 'success' : 'neutral'}>
                          {row.isActive ? t.common.active : t.common.inactive}
                        </Badge>
                      </td>
                      <td className="right">
                        <Button size="sm" onClick={() => setEditing(row)}>
                          {t.common.edit}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loader>
      <Dialog
        open={editing !== null}
        title={t.franchise.addAgreement}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <AgreementForm
            agreement={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void client.invalidateQueries({ queryKey: ['franchise'] });
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

export function FranchisePage() {
  const [tab, setTab] = useState<Tab>('franchisees');
  return (
    <>
      <PageHeader title={t.franchise.title} subtitle={t.franchise.subtitle} />
      <div className="tabs" role="tablist">
        {(Object.keys(t.franchise.tabs) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.franchise.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'franchisees' && <FranchiseesTab />}
      {tab === 'contracts' && <ContractsTab />}
      {tab === 'statements' && <StatementsTab />}
      {tab === 'inspections' && <InspectionsTab />}
      {tab === 'scorecards' && <ScorecardsTab />}
      {tab === 'agreements' && <AgreementsTab />}
    </>
  );
}

// --------------------------------------------------------------- portal

type Portal = {
  franchisees: {
    id: string;
    name: string;
    legalName: string | null;
    status: FranchiseeStatus;
    branches: { id: string; name: string }[];
    contracts: (Omit<Contract, 'franchisee' | 'franchiseeId' | 'brandId'> & {
      brand: { name: string } | null;
    })[];
  }[];
  statements: (Omit<Statement, 'contract'> & {
    contract: { number: string };
  })[];
  inspections: Inspection[];
};

export function FranchisePortalPage() {
  const query = useQuery({
    queryKey: ['franchise', 'portal'],
    queryFn: () => api<Portal>('/franchise/portal'),
  });
  return (
    <div className="stack">
      <PageHeader
        title={t.franchise.portalTitle}
        subtitle={t.franchise.portalSubtitle}
      />
      <Loader query={query}>
        {(data) =>
          data.franchisees.length === 0 ? (
            <p className="muted">{t.franchise.noPartner}</p>
          ) : (
            <>
              {data.franchisees.map((partner) => (
                <section key={partner.id} className="card stack">
                  <div className="toolbar">
                    <h2 className="section-title">{partner.name}</h2>
                    <Badge>{t.franchise.status[partner.status]}</Badge>
                  </div>
                  <p className="muted">
                    {t.franchise.branches}:{' '}
                    {partner.branches.map((branch) => branch.name).join(', ')}
                  </p>
                  {partner.contracts.map((contract) => (
                    <dl key={contract.id} className="totals">
                      <dt>{t.franchise.contract}</dt>
                      <dd>
                        {contract.number}
                        {contract.brand ? ` · ${contract.brand.name}` : ''}
                      </dd>
                      <dt>{t.franchise.territory}</dt>
                      <dd>{contract.territory}</dd>
                      <dt>{t.franchise.royalty}</dt>
                      <dd>
                        {percent(contract.royaltyBp)} +{' '}
                        {percent(contract.marketingFeeBp)}
                      </dd>
                      <dt>{t.franchise.minimumFee}</dt>
                      <dd>{formatMoney(contract.minimumMonthlyFee)}</dd>
                      <dt>{t.franchise.startDate}</dt>
                      <dd>
                        {date(contract.startDate)} – {date(contract.endDate)}
                      </dd>
                    </dl>
                  ))}
                </section>
              ))}
              <section className="card stack">
                <h2 className="section-title">{t.franchise.tabs.statements}</h2>
                {data.statements.length === 0 ? (
                  <p className="muted">—</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t.franchise.month}</th>
                          <th>{t.franchise.contract}</th>
                          <th className="right">{t.franchise.netSales}</th>
                          <th className="right">{t.franchise.total}</th>
                          <th>{t.common.status}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.statements.map((row) => (
                          <tr key={row.id}>
                            <td>{row.month}</td>
                            <td>{row.contract.number}</td>
                            <td className="right nowrap">
                              {formatMoney(row.netSales)}
                            </td>
                            <td className="right nowrap">
                              {formatMoney(row.total)}
                            </td>
                            <td>{t.franchise.statementStatus[row.status]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="card stack">
                <h2 className="section-title">
                  {t.franchise.tabs.inspections}
                </h2>
                <InspectionList rows={data.inspections} />
              </section>
            </>
          )
        }
      </Loader>
    </div>
  );
}
