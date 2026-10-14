import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  Checkbox,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { TeamBonusForm } from './TeamBonusForm';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';

type Employee = {
  userId: string;
  name: string;
  status: string;
  position: string | null;
  payType: 'NONE' | 'HOURLY' | 'DAILY' | 'SHIFT' | 'MONTHLY';
  rate: number;
  perOrder?: number;
  perCustomer?: number;
  salesPercentBp?: number;
  qualityBonus?: number;
  qualityMinRating?: number;
};
type Period = {
  id: string;
  startDate: string;
  endDate: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID';
  total: number;
  employees: number;
};
type Line = {
  userId: string;
  name: string;
  payType: string;
  workedMinutes: number;
  overtimeMinutes: number;
  baseAmount: number;
  overtimeAmount: number;
  bonuses: number;
  penalties: number;
  advances: number;
  commission?: number;
  total: number;
};
const statusTone = {
  DRAFT: 'warning',
  APPROVED: 'accent',
  PAID: 'success',
} as const;
const hoursOf = (minutes: number) => (minutes / 60).toFixed(1);

function useEmployees(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'employees'],
    queryFn: () =>
      api<{ employees: Employee[] }>('/hr/employees').then((d) => d.employees),
    enabled,
  });
}

function EmployeeRate({ employee }: { employee: Employee }) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    position: employee.position ?? '',
    payType: employee.payType,
    rate: employee.rate as number | null,
    perOrder: (employee.perOrder ?? 0) as number | null,
    perCustomer: (employee.perCustomer ?? 0) as number | null,
    percent: String((employee.salesPercentBp ?? 0) / 100),
    qualityBonus: (employee.qualityBonus ?? 0) as number | null,
    qualityMinRating: String(employee.qualityMinRating ?? 4.5),
  });
  return (
    <tr>
      <td>{employee.name}</td>
      <td>
        <input
          aria-label={`${t.hr.position} ${employee.name}`}
          value={form.position}
          onChange={(e) => setForm({ ...form, position: e.target.value })}
        />
      </td>
      <td>
        <select
          aria-label={`${t.hr.payType} ${employee.name}`}
          value={form.payType}
          onChange={(e) =>
            setForm({ ...form, payType: e.target.value as Employee['payType'] })
          }
        >
          {(['NONE', 'HOURLY', 'DAILY', 'SHIFT', 'MONTHLY'] as const).map(
            (type) => (
              <option key={type} value={type}>
                {t.hr.payTypes[type]}
              </option>
            ),
          )}
        </select>
      </td>
      <td>
        <MoneyField
          label={t.hr.rate}
          value={form.rate}
          onChange={(rate) => setForm({ ...form, rate })}
        />
      </td>
      <td>
        <MoneyField
          label={t.hr.perOrder}
          value={form.perOrder}
          onChange={(perOrder) => setForm({ ...form, perOrder })}
        />
        <MoneyField
          label={t.hr.perCustomer}
          value={form.perCustomer}
          onChange={(perCustomer) => setForm({ ...form, perCustomer })}
        />
        <TextField
          label={t.hr.salesPercent}
          inputMode="decimal"
          value={form.percent}
          onChange={(e) =>
            setForm({ ...form, percent: e.target.value.replace(',', '.') })
          }
        />
        <MoneyField
          label={t.hr.qualityBonus}
          value={form.qualityBonus}
          onChange={(qualityBonus) => setForm({ ...form, qualityBonus })}
        />
        <TextField
          label={t.hr.qualityMin}
          inputMode="decimal"
          value={form.qualityMinRating}
          onChange={(e) =>
            setForm({
              ...form,
              qualityMinRating: e.target.value.replace(',', '.'),
            })
          }
        />
      </td>
      <td className="right">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await api(`/hr/employees/${employee.userId}`, {
                method: 'PUT',
                body: {
                  position: form.position || null,
                  payType: form.payType,
                  rate: form.rate ?? 0,
                  perOrder: form.perOrder ?? 0,
                  perCustomer: form.perCustomer ?? 0,
                  qualityBonus: form.qualityBonus ?? 0,
                  qualityMinRating: Math.min(
                    5,
                    Math.max(1, Number(form.qualityMinRating) || 4.5),
                  ),
                  salesPercentBp: Math.round(
                    Math.min(50, Math.max(0, Number(form.percent) || 0)) * 100,
                  ),
                },
              });
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['hr', 'employees'] });
            } catch (caught) {
              toast(
                caught instanceof Error ? caught.message : t.common.errorTitle,
                'error',
              );
            }
          }}
        >
          {t.common.save}
        </Button>
      </td>
    </tr>
  );
}

function PeriodDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: ['payroll', id],
    queryFn: () => api<Period & { lines: Line[] }>(`/payroll/periods/${id}`),
  });
  const act = async (path: string) => {
    try {
      await post(path);
      await client.invalidateQueries({ queryKey: ['payroll'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <Dialog open wide title={t.hr.period} onClose={onClose}>
      {!detail.data ? (
        <LoadingState />
      ) : (
        <div className="stack">
          <div className="badges">
            <Badge tone={statusTone[detail.data.status]}>
              {t.hr.statuses[detail.data.status]}
            </Badge>
            <Badge>
              {detail.data.startDate.slice(0, 10)} —{' '}
              {detail.data.endDate.slice(0, 10)}
            </Badge>
          </div>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t.hr.employee}</th>
                  <th className="right">{t.hr.worked}</th>
                  <th className="right">{t.hr.overtime}</th>
                  <th className="right">{t.hr.base}</th>
                  <th className="right">{t.hr.overtimePay}</th>
                  <th className="right">{t.hr.bonuses}</th>
                  <th className="right">{t.hr.penalties}</th>
                  <th className="right">{t.hr.advances}</th>
                  <th className="right">{t.hr.commission}</th>
                  <th className="right">{t.hr.total}</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((line) => (
                  <tr key={line.userId}>
                    <td>
                      {line.name}
                      <small className="muted block">
                        {t.hr.payTypes[line.payType]}
                      </small>
                    </td>
                    <td className="right">{hoursOf(line.workedMinutes)}</td>
                    <td className="right">{hoursOf(line.overtimeMinutes)}</td>
                    <td className="right nowrap">
                      {formatMoney(line.baseAmount)}
                    </td>
                    <td className="right nowrap">
                      {formatMoney(line.overtimeAmount)}
                    </td>
                    <td className="right nowrap">
                      {formatMoney(line.bonuses)}
                    </td>
                    <td className="right nowrap">
                      −{formatMoney(line.penalties)}
                    </td>
                    <td className="right nowrap">
                      −{formatMoney(line.advances)}
                    </td>
                    <td className="right nowrap">
                      {formatMoney(line.commission ?? 0)}
                    </td>
                    <td className="right nowrap">
                      <strong>{formatMoney(line.total)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <a
              className="btn btn-secondary btn-md"
              href={`/api/payroll/periods/${id}/export.csv`}
            >
              {t.hr.export}
            </a>
            {detail.data.status === 'DRAFT' && (
              <Button
                onClick={() => void act(`/payroll/periods/${id}/recalculate`)}
              >
                {t.hr.recalculate}
              </Button>
            )}
            {detail.data.status === 'DRAFT' && can(me, 'finance.manage') && (
              <Button
                variant="primary"
                onClick={() => void act(`/payroll/periods/${id}/approve`)}
              >
                {t.hr.approve}
              </Button>
            )}
            {detail.data.status === 'APPROVED' && can(me, 'finance.manage') && (
              <Button
                variant="primary"
                onClick={() => void act(`/payroll/periods/${id}/paid`)}
              >
                {t.hr.markPaid}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

type Tab = 'periods' | 'employees' | 'adjustments';

export function PayrollPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const hr = can(me, 'hr.manage');
  const [tab, setTab] = useState<Tab>('periods');
  const [selected, setSelected] = useState<string | null>(null);
  const month = new Date();
  const [range, setRange] = useState({
    start: new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1))
      .toISOString()
      .slice(0, 10),
    end: new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 0))
      .toISOString()
      .slice(0, 10),
  });
  const [adjustment, setAdjustment] = useState({
    userId: '',
    type: 'BONUS',
    amount: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    reason: '',
    fromCash: false,
  });
  const [error, setError] = useState<unknown>(null);
  const periods = useQuery({
    queryKey: ['payroll', 'periods'],
    queryFn: () =>
      api<{ periods: Period[] }>('/payroll/periods').then((d) => d.periods),
  });
  const employees = useEmployees(hr);
  const tabs: Tab[] = hr
    ? ['periods', 'employees', 'adjustments']
    : ['periods'];
  return (
    <>
      <PageHeader title={t.hr.payrollTitle} subtitle={t.hr.payrollSubtitle} />
      <div className="tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.hr.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'periods' && (
        <div className="stack">
          {hr && (
            <form
              className="inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setError(null);
                try {
                  const created = await post<{ id: string }>(
                    '/payroll/periods',
                    { startDate: range.start, endDate: range.end },
                  );
                  await client.invalidateQueries({ queryKey: ['payroll'] });
                  setSelected(created.id);
                } catch (caught) {
                  setError(caught);
                }
              }}
            >
              <TextField
                label={t.reports.from}
                type="date"
                value={range.start}
                onChange={(e) => setRange({ ...range, start: e.target.value })}
              />
              <TextField
                label={t.reports.to}
                type="date"
                value={range.end}
                onChange={(e) => setRange({ ...range, end: e.target.value })}
              />
              <Button type="submit" variant="primary">
                + {t.hr.newPeriod}
              </Button>
            </form>
          )}
          <FormError error={error} />
          {periods.data && periods.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.hr.period}</th>
                    <th>{t.common.status}</th>
                    <th className="right">{t.hr.employees}</th>
                    <th className="right">{t.hr.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.data.map((period) => (
                    <tr
                      key={period.id}
                      className="clickable"
                      onClick={() => setSelected(period.id)}
                    >
                      <td>
                        <button
                          className="text-link inline"
                          onClick={() => setSelected(period.id)}
                        >
                          {period.startDate.slice(0, 10)} —{' '}
                          {period.endDate.slice(0, 10)}
                        </button>
                      </td>
                      <td>
                        <Badge tone={statusTone[period.status]}>
                          {t.hr.statuses[period.status]}
                        </Badge>
                      </td>
                      <td className="right">{period.employees}</td>
                      <td className="right nowrap">
                        {formatMoney(period.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      )}
      {tab === 'employees' && (
        <div className="stack">
          <p className="notice">{t.hr.rateHint}</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t.hr.employee}</th>
                  <th>{t.hr.position}</th>
                  <th>{t.hr.rate}</th>
                  <th>{t.hr.commission}</th>
                  <th>{t.hr.rate}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(employees.data ?? []).map((employee) => (
                  <EmployeeRate key={employee.userId} employee={employee} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === 'adjustments' && (
        <form
          className="card stack narrow"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await post('/payroll/adjustments', {
                ...adjustment,
                userId: adjustment.userId || employees.data?.[0]?.userId,
                amount: adjustment.amount ?? 0,
              });
              toast(t.common.saved);
              setAdjustment({ ...adjustment, amount: null, reason: '' });
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <SelectField
            label={t.hr.employee}
            value={adjustment.userId || employees.data?.[0]?.userId || ''}
            onChange={(e) =>
              setAdjustment({ ...adjustment, userId: e.target.value })
            }
          >
            {(employees.data ?? []).map((employee) => (
              <option key={employee.userId} value={employee.userId}>
                {employee.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t.orders.type}
            value={adjustment.type}
            onChange={(e) =>
              setAdjustment({ ...adjustment, type: e.target.value })
            }
          >
            {(
              ['BONUS', 'PENALTY', 'ADVANCE', 'LOAN', 'REPAYMENT'] as const
            ).map((type) => (
              <option key={type} value={type}>
                {t.hr.adjustmentTypes[type]}
              </option>
            ))}
          </SelectField>
          <MoneyField
            label={`${t.payment.amount} (${t.menu.sum})`}
            value={adjustment.amount}
            onChange={(amount) => setAdjustment({ ...adjustment, amount })}
            required
          />
          <TextField
            label={t.hr.date}
            type="date"
            value={adjustment.date}
            onChange={(e) =>
              setAdjustment({ ...adjustment, date: e.target.value })
            }
          />
          <TextField
            label={t.inventory.reason}
            value={adjustment.reason}
            onChange={(e) =>
              setAdjustment({ ...adjustment, reason: e.target.value })
            }
            minLength={3}
            required
          />
          {(adjustment.type === 'ADVANCE' || adjustment.type === 'LOAN') && (
            <Checkbox
              label={t.hr.fromCash}
              checked={!!adjustment.fromCash}
              onChange={(fromCash) =>
                setAdjustment({ ...adjustment, fromCash })
              }
            />
          )}
          <FormError error={error} />
          <Button type="submit" variant="primary">
            {t.hr.addAdjustment}
          </Button>
        </form>
      )}
      {hr && (employees.data ?? []).length > 1 && (
        <TeamBonusForm employees={employees.data ?? []} />
      )}
      {selected && (
        <PeriodDetail id={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
