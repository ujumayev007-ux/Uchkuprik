import { useState } from 'react';
import {
  Button,
  Checkbox,
  FormError,
  MoneyField,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { post } from '../lib/api';

/** One bonus amount split across a team, equally or by each member's sales. */
export function TeamBonusForm({
  employees,
}: {
  employees: { userId: string; name: string }[];
}) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    userIds: [] as string[],
    amount: null as number | null,
    split: 'EQUAL' as 'EQUAL' | 'SALES',
    date: today,
    from: today.slice(0, 8) + '01',
    to: today,
    reason: '',
  });
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="card stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await post('/payroll/team-bonus', {
            ...form,
            amount: form.amount ?? 0,
          });
          toast(t.hr.teamDone);
          setForm({ ...form, userIds: [], amount: null, reason: '' });
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <h3>👥 {t.hr.teamBonus}</h3>
      <p className="muted small">{t.hr.teamHint}</p>
      <div className="check-grid">
        {employees.map((employee) => (
          <Checkbox
            key={employee.userId}
            label={employee.name}
            checked={form.userIds.includes(employee.userId)}
            onChange={(on) =>
              setForm({
                ...form,
                userIds: on
                  ? [...form.userIds, employee.userId]
                  : form.userIds.filter((id) => id !== employee.userId),
              })
            }
          />
        ))}
      </div>
      <div className="form-grid">
        <MoneyField
          label={`${t.payment.amount} (${t.menu.sum})`}
          value={form.amount}
          onChange={(amount) => setForm({ ...form, amount })}
          required
        />
        <SelectField
          label={t.hr.teamBonus}
          value={form.split}
          onChange={(e) =>
            setForm({ ...form, split: e.target.value as 'EQUAL' | 'SALES' })
          }
        >
          <option value="EQUAL">{t.hr.splitEqual}</option>
          <option value="SALES">{t.hr.splitSales}</option>
        </SelectField>
        {form.split === 'SALES' && (
          <>
            <TextField
              label={t.audit.from}
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
            <TextField
              label={t.audit.to}
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </>
        )}
        <TextField
          label={t.hr.date}
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
        />
        <TextField
          label={t.inventory.reason}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          minLength={3}
          required
        />
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={form.userIds.length === 0}
        >
          {t.hr.addAdjustment}
        </Button>
      </div>
    </form>
  );
}
