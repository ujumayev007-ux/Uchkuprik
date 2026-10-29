import { copyText } from '../../lib/clipboard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  ownerApi,
  ownerPost,
  type CustomerDetail,
  type CustomerSummary,
  type FeatureDef,
  type LicenseRow,
} from '../../lib/owner';
import { DeviceCards } from './OwnerDevices';
import { OwnerData } from './OwnerData';
import { PolicyEditor } from './OwnerPolicy';
import { WorkflowSection } from './OwnerWorkflow';

const c = t.owner.customers;
const l = t.owner.license;
const pay = t.owner.payments;

const licenseTone = (license: LicenseRow) =>
  license.status !== 'ACTIVE' || license.expired
    ? 'danger'
    : license.daysLeft <= 7
      ? 'warning'
      : 'success';

const numberOrNull = (value: string) =>
  value.trim() === '' ? null : Number(value);

function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await action();
      if (message) toast(message);
      return true;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

function LicenseSection({
  customer,
  onChange,
}: {
  customer: CustomerDetail;
  onChange: () => void;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const { run, busy } = useRun();
  const [form, setForm] = useState({
    months: '1',
    maxInstalls: '1',
    maxDevices: '',
    maxBranches: '',
    maxUsers: '',
  });
  const [issued, setIssued] = useState<string | null>(null);
  const copy = (text: string) =>
    void copyText(text)
      .then(() => toast(l.copied))
      .catch(() => undefined);
  const act = (license: LicenseRow, action: string, body: object = {}) =>
    run(async () => {
      await ownerPost(`/licenses/${license.id}/${action}`, body);
      onChange();
    });

  return (
    <section className="card stack">
      <h3 className="section-title">{l.title}</h3>
      {customer.licenses.length === 0 && <EmptyState title={c.noLicense} />}
      <ul className="ops-list">
        {customer.licenses.map((license) => (
          <li key={license.id} className="ops-item">
            <div className="grow">
              <strong>…{license.keyHint}</strong>{' '}
              <Badge tone={licenseTone(license)}>
                {license.expired ? l.expired : l.status[license.status]}
              </Badge>
              <div className="muted small">
                {l.until} {formatDateTime(license.expiresAt)} ·{' '}
                {l.daysLeft.replace('{n}', String(license.daysLeft))} ·{' '}
                {l.maxInstalls}: {license.maxInstalls} · {l.maxDevices}:{' '}
                {license.maxDevices ?? '∞'} · {l.maxBranches}:{' '}
                {license.maxBranches ?? '∞'} · {l.maxUsers}:{' '}
                {license.maxUsers ?? '∞'}
              </div>
            </div>
            {license.status !== 'REVOKED' && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act(license, 'renew', { months: 1 })}
                >
                  {l.renew}
                </Button>
                {license.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(license, 'suspend')}
                  >
                    {l.suspend}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(license, 'resume')}
                  >
                    {l.resume}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm(l.revokeConfirm))
                      void act(license, 'revoke');
                  }}
                >
                  {l.revoke}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {issued && (
        <div className="stack">
          <p className="muted small">{l.keyOnce}</p>
          <p className="secret-box">{issued}</p>
          <div>
            <Button size="sm" onClick={() => copy(issued)}>
              {l.copy}
            </Button>
          </div>
        </div>
      )}
      <details>
        <summary>{l.issue}</summary>
        <div className="form-grid">
          <TextField
            label={l.months}
            inputMode="numeric"
            value={form.months}
            onChange={(event) =>
              setForm({
                ...form,
                months: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={l.maxInstalls}
            inputMode="numeric"
            value={form.maxInstalls}
            onChange={(event) =>
              setForm({
                ...form,
                maxInstalls: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={l.maxDevices}
            hint={l.limitHint}
            inputMode="numeric"
            value={form.maxDevices}
            onChange={(event) =>
              setForm({
                ...form,
                maxDevices: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={l.maxBranches}
            hint={l.limitHint}
            inputMode="numeric"
            value={form.maxBranches}
            onChange={(event) =>
              setForm({
                ...form,
                maxBranches: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={l.maxUsers}
            hint={l.limitHint}
            inputMode="numeric"
            value={form.maxUsers}
            onChange={(event) =>
              setForm({
                ...form,
                maxUsers: event.target.value.replace(/\D/g, ''),
              })
            }
          />
        </div>
        <Button
          variant="primary"
          busy={busy}
          disabled={!Number(form.months) || !Number(form.maxInstalls)}
          onClick={() =>
            void run(async () => {
              const result = await ownerPost<{ key: string }>(
                `/customers/${customer.id}/licenses`,
                {
                  months: Number(form.months),
                  maxInstalls: Number(form.maxInstalls),
                  maxDevices: numberOrNull(form.maxDevices),
                  maxBranches: numberOrNull(form.maxBranches),
                  maxUsers: numberOrNull(form.maxUsers),
                },
              );
              setIssued(result.key);
              onChange();
            })
          }
        >
          {l.issue}
        </Button>
      </details>
      {element}
    </section>
  );
}

function PaymentSection({
  customer,
  onChange,
}: {
  customer: CustomerDetail;
  onChange: () => void;
}) {
  const { run, busy } = useRun();
  const [form, setForm] = useState({
    amount: '',
    method: 'TRANSFER',
    periodMonths: '1',
    reference: '',
  });
  return (
    <section className="card stack">
      <h3 className="section-title">{pay.title}</h3>
      {customer.payments.length === 0 ? (
        <p className="muted small">{pay.none}</p>
      ) : (
        <ul className="ops-list">
          {customer.payments.map((payment) => (
            <li key={payment.id} className="ops-item">
              <div className="grow">
                <strong>{formatMoney(payment.amount, payment.currency)}</strong>
                <div className="muted small">
                  {formatDateTime(payment.paidAt)} ·{' '}
                  {pay.methods[payment.method as keyof typeof pay.methods] ??
                    payment.method}
                  {payment.periodMonths > 0
                    ? ` · +${payment.periodMonths}`
                    : ''}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>{pay.record}</summary>
        <div className="form-grid">
          <TextField
            label={pay.amount}
            inputMode="numeric"
            value={form.amount}
            onChange={(event) =>
              setForm({
                ...form,
                amount: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <SelectField
            label={pay.method}
            value={form.method}
            onChange={(event) =>
              setForm({ ...form, method: event.target.value })
            }
          >
            {Object.entries(pay.methods).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </SelectField>
          <TextField
            label={pay.period}
            inputMode="numeric"
            value={form.periodMonths}
            onChange={(event) =>
              setForm({
                ...form,
                periodMonths: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={pay.reference}
            value={form.reference}
            onChange={(event) =>
              setForm({ ...form, reference: event.target.value })
            }
          />
        </div>
        <Button
          variant="primary"
          busy={busy}
          disabled={form.amount === ''}
          onClick={() =>
            void run(async () => {
              await ownerPost(`/customers/${customer.id}/payments`, {
                amount: Number(form.amount),
                method: form.method,
                periodMonths: Number(form.periodMonths || '0'),
                reference: form.reference.trim() || null,
              });
              setForm({ ...form, amount: '', reference: '' });
              onChange();
            }, pay.saved)
          }
        >
          {pay.record}
        </Button>
      </details>
    </section>
  );
}

function CustomerDetailView({
  id,
  catalog,
  onBack,
}: {
  id: string;
  catalog: FeatureDef[];
  onBack: () => void;
}) {
  const client = useQueryClient();
  const { confirm, element } = useConfirm();
  const { run, busy } = useRun();
  const detail = useQuery({
    queryKey: ['owner', 'customer', id],
    queryFn: () => ownerApi<CustomerDetail>(`/customers/${id}`),
  });
  if (detail.isPending) return <LoadingState />;
  if (detail.error)
    return (
      <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
    );
  const customer = detail.data;
  const reload = () => {
    void client.invalidateQueries({ queryKey: ['owner'] });
  };
  return (
    <div className="stack">
      <div className="toolbar">
        <Button size="sm" onClick={onBack}>
          {c.back}
        </Button>
        <h2 className="section-title grow">{customer.name}</h2>
        <Badge tone={customer.status === 'ACTIVE' ? 'success' : 'danger'}>
          {c.status[customer.status]}
        </Badge>
        {(customer.blockReasons?.length ?? 0) > 0 && (
          <Badge tone="danger">
            {c.blocked}:{' '}
            {customer
              .blockReasons!.map((reason) => c.blockReason[reason])
              .join(', ')}
          </Badge>
        )}
        {(customer.blockReasons?.length ?? 0) > 0 ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm(c.unblockConfirm.replace('{name}', customer.name))
              )
                void run(async () => {
                  await ownerPost(`/customers/${id}/unblock`);
                  reload();
                }, c.unblocked);
            }}
          >
            {c.unblock}
          </Button>
        ) : customer.status === 'ACTIVE' ? (
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (await confirm(`${customer.name}: ${c.suspend}?`))
                void run(async () => {
                  await ownerPost(`/customers/${id}/status`, {
                    status: 'SUSPENDED',
                  });
                  reload();
                });
            }}
          >
            {c.suspend}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await ownerPost(`/customers/${id}/status`, {
                  status: 'ACTIVE',
                });
                reload();
              })
            }
          >
            {c.reactivate}
          </Button>
        )}
      </div>
      <p className="muted small">
        {[customer.contactName, customer.phone, customer.note]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <LicenseSection customer={customer} onChange={reload} />
      <PaymentSection customer={customer} onChange={reload} />
      <section className="card stack">
        <h3 className="section-title">{t.owner.devices.title}</h3>
        <DeviceCards devices={customer.devices} onChange={reload} />
      </section>
      <section className="card stack">
        <h3 className="section-title">{c.branches}</h3>
        {customer.branches.length === 0 ? (
          <p className="muted small">{c.noBranches}</p>
        ) : (
          <ul className="ops-list">
            {customer.branches.map((branch) => (
              <li key={branch.id} className="ops-item">
                <div className="grow">
                  <strong>{branch.name}</strong>
                  <div className="muted small">
                    {branch.code} · {formatDateTime(branch.lastReportedAt)}
                  </div>
                </div>
                <Badge tone={branch.isActive ? 'success' : 'neutral'}>
                  {branch.isActive ? t.common.active : '—'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
      <WorkflowSection customerId={id} />
      <OwnerData customerId={id} hosted={!!customer.hosted} />
      <PolicyEditor
        key={customer.policy.version}
        customerId={id}
        catalog={catalog}
        policy={customer.policy}
        onSaved={reload}
      />
      {element}
    </div>
  );
}

export function CustomersTab({ catalog }: { catalog: FeatureDef[] }) {
  const client = useQueryClient();
  const { run, busy } = useRun();
  const { confirm, element: confirmElement } = useConfirm();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', contactName: '', phone: '' });
  const list = useQuery({
    queryKey: ['owner', 'customers'],
    queryFn: () => ownerApi<{ customers: CustomerSummary[] }>('/customers'),
    refetchInterval: 30_000,
  });
  if (selected)
    return (
      <CustomerDetailView
        id={selected}
        catalog={catalog}
        onBack={() => setSelected(null)}
      />
    );
  if (list.isPending) return <LoadingState />;
  if (list.error)
    return (
      <ErrorState error={list.error} onRetry={() => void list.refetch()} />
    );
  const needle = query.trim().toLowerCase();
  const rows = list.data.customers.filter(
    (customer) =>
      !needle ||
      customer.name.toLowerCase().includes(needle) ||
      (customer.phone ?? '').includes(needle),
  );
  return (
    <div className="stack">
      <TextField
        label={t.common.search}
        placeholder={c.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {rows.length === 0 ? (
        <EmptyState title={c.none} />
      ) : (
        <ul className="ops-list">
          {rows.map((customer) => (
            <li key={customer.id} className="ops-item">
              <div className="grow">
                <strong>{customer.name}</strong>
                <div className="muted small">
                  {customer.license
                    ? `${l.until} ${formatDateTime(customer.license.expiresAt)}`
                    : c.noLicense}{' '}
                  · {customer.devices.ONLINE} {c.devicesOnline} ·{' '}
                  {customer.devices.OFFLINE} {c.devicesOffline} ·{' '}
                  {customer.devices.BLOCKED} {c.devicesBlocked}
                </div>
              </div>
              {customer.license && (
                <Badge tone={licenseTone(customer.license)}>
                  {customer.license.expired
                    ? l.expired
                    : l.daysLeft.replace(
                        '{n}',
                        String(customer.license.daysLeft),
                      )}
                </Badge>
              )}
              <Badge tone={customer.status === 'ACTIVE' ? 'success' : 'danger'}>
                {c.status[customer.status]}
              </Badge>
              {customer.blocked && (
                <>
                  <Badge tone="danger">
                    {c.blocked}:{' '}
                    {(customer.blockReasons ?? [])
                      .map((reason) => c.blockReason[reason])
                      .join(', ')}
                  </Badge>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirm(
                          c.unblockConfirm.replace('{name}', customer.name),
                        )
                      )
                        void run(async () => {
                          await ownerPost(`/customers/${customer.id}/unblock`);
                          await client.invalidateQueries({
                            queryKey: ['owner'],
                          });
                        }, c.unblocked);
                    }}
                  >
                    {c.unblock}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                aria-label={customer.name}
                title={customer.name}
                onClick={() => setSelected(customer.id)}
              >
                ⚙
              </Button>
            </li>
          ))}
        </ul>
      )}
      <section className="card stack">
        <h3 className="section-title">{c.add}</h3>
        <div className="form-grid">
          <TextField
            label={c.name}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <TextField
            label={c.contact}
            value={form.contactName}
            onChange={(event) =>
              setForm({ ...form, contactName: event.target.value })
            }
          />
          <TextField
            label={c.phone}
            value={form.phone}
            onChange={(event) =>
              setForm({ ...form, phone: event.target.value })
            }
          />
        </div>
        <div>
          <Button
            variant="primary"
            busy={busy}
            disabled={form.name.trim().length < 2}
            onClick={() =>
              void run(async () => {
                const created = await ownerPost<{ id: string }>('/customers', {
                  name: form.name.trim(),
                  contactName: form.contactName.trim() || null,
                  phone: form.phone.trim() || null,
                });
                setForm({ name: '', contactName: '', phone: '' });
                await client.invalidateQueries({ queryKey: ['owner'] });
                setSelected(created.id);
              })
            }
          >
            {c.add}
          </Button>
        </div>
      </section>
      {confirmElement}
    </div>
  );
}
