import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, del, post } from '../lib/api';
import { formatMoney } from '../lib/format';

type Expense = {
  id: string;
  category: string;
  amount: number;
  date: string;
  note: string | null;
  recipient?: string | null;
  attachmentId?: string | null;
  fromCash?: boolean;
  approvalStatus?: string;
};

async function uploadEvidence(
  file: File,
  endpoint: string,
): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Fayl yuklashda xatolik yuz berdi');
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

export function ChiqimlarPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000)
    .toISOString()
    .slice(0, 10);

  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);

  const expenses = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () =>
      api<{ expenses: Expense[] }>(`/expenses?from=${from}&to=${to}`).then(
        (d) => d.expenses,
      ),
  });

  const [form, setForm] = useState({
    category: '',
    amount: null as number | null,
    date: today,
    note: '',
    recipient: '',
    fromCash: true, // Default to true in POS/Cashier for clear cash register accounting
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const canManage = can(me, 'finance.manage');

  const totalAmount = (expenses.data ?? []).reduce(
    (sum, item) => sum + (item.approvalStatus !== 'REJECTED' ? item.amount : 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Chiqimlar"
        subtitle="Restoran xarajatlari, kassa chiqimlari va operatsion to‘lovlar"
      />

      <div className="card stack">
        <h2>+ Yangi chiqim kiritish</h2>
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            if (!form.amount || form.amount <= 0) {
              toast('Chiqim summasini to‘g‘ri kiriting', 'error');
              return;
            }
            setBusy(true);
            try {
              const attachmentId = file
                ? await uploadEvidence(file, '/api/finance/attachments')
                : null;

              const created = await post<{ approvalStatus: string }>(
                '/expenses',
                {
                  ...form,
                  amount: form.amount,
                  note: form.note || null,
                  recipient: form.recipient || null,
                  attachmentId,
                },
              );

              if (created.approvalStatus === 'PENDING') {
                toast('Chiqim kiritildi va tasdiqlash uchun yuborildi');
              } else {
                toast('Chiqim muvaffaqiyatli saqlandi');
              }

              setForm({
                category: '',
                amount: null,
                date: today,
                note: '',
                recipient: '',
                fromCash: true,
              });
              setFile(null);
              await client.invalidateQueries({ queryKey: ['expenses'] });
              await client.invalidateQueries({ queryKey: ['finance'] });
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label="Kategoriya / Maqsad"
            placeholder="Masalan: Bozorlik transporti, idishlar, xo‘jalik"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            minLength={2}
            required
          />
          <MoneyField
            label="Summa (so‘m)"
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
            required
          />
          <TextField
            label="Sana"
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
          <TextField
            label="Kimga / Qayerga (ixtiyoriy)"
            placeholder="Haydovchi, do‘kon yoki ta’minotchi"
            value={form.recipient}
            onChange={(e) => setForm({ ...form, recipient: e.target.value })}
          />
          <TextField
            label="Izoh"
            placeholder="Qo‘shimcha ma’lumot"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <label className="field">
            <span className="field-label">Chek rasmi yoki hujjati</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Checkbox
            label="Kassa g‘aznasidan to‘lash (naqd chiqim)"
            description="Kassa smenasi hisobotida naqd pul kamayishi sifatida aks etadi"
            checked={form.fromCash}
            onChange={(fromCash) => setForm({ ...form, fromCash })}
          />
          <div className="form-actions" style={{ gridColumn: '1 / -1' }}>
            <Button type="submit" variant="primary" busy={busy}>
              + Chiqimni saqlash
            </Button>
          </div>
        </form>
        <FormError error={error} />
      </div>

      <div className="card stack">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <h2>Chiqimlar tarixi</h2>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <TextField
              label="Dan"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextField
              label="Gacha"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>

        <div style={{ fontWeight: 600, fontSize: '1.1rem', color: 'var(--color-text-subtle)' }}>
          Jami xarajat: <strong style={{ color: 'var(--color-text)' }}>{formatMoney(totalAmount)}</strong>
        </div>

        {expenses.isPending && <LoadingState />}
        {expenses.error && (
          <ErrorState
            error={expenses.error}
            onRetry={() => void expenses.refetch()}
          />
        )}

        {expenses.data && expenses.data.length === 0 && (
          <EmptyState title="Chiqimlar mavjud emas">
            Tanlangan davr uchun hech qanday xarajat kiritilmagan.
          </EmptyState>
        )}

        {expenses.data && expenses.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Kategoriya / Izoh</th>
                  <th>To‘lov turi</th>
                  <th>Holati</th>
                  <th className="right">Summa</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {expenses.data.map((expense) => (
                  <tr key={expense.id}>
                    <td>{expense.date.slice(0, 10)}</td>
                    <td>
                      <strong>{expense.category}</strong>
                      {expense.recipient && (
                        <small className="muted block">
                          Qabul qiluvchi: {expense.recipient}
                        </small>
                      )}
                      {expense.note && (
                        <small className="muted block">
                          Izoh: {expense.note}
                        </small>
                      )}
                      {expense.attachmentId && (
                        <a
                          className="text-link block"
                          href={`/api/finance/attachments/${expense.attachmentId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          📎 Biriktirilgan chek / hujjat
                        </a>
                      )}
                    </td>
                    <td>
                      {expense.fromCash ? (
                        <Badge tone="accent">💵 Kassa naqdi</Badge>
                      ) : (
                        <Badge tone="neutral">Hisobdan</Badge>
                      )}
                    </td>
                    <td>
                      {expense.approvalStatus === 'APPROVED' ? (
                        <Badge tone="success">Tasdiqlangan</Badge>
                      ) : expense.approvalStatus === 'PENDING' ? (
                        <Badge tone="warning">Kutilmoqda</Badge>
                      ) : expense.approvalStatus === 'REJECTED' ? (
                        <Badge tone="danger">Rad etilgan</Badge>
                      ) : (
                        <Badge tone="neutral">—</Badge>
                      )}
                    </td>
                    <td className="right nowrap" style={{ fontWeight: 600 }}>
                      {formatMoney(expense.amount)}
                    </td>
                    {canManage && (
                      <td className="right">
                        <button
                          className="text-link"
                          style={{ color: 'var(--color-danger)' }}
                          onClick={async () => {
                            if (!window.confirm('Haqiqatan ham bu chiqimni o‘chirmoqchimisiz?')) return;
                            try {
                              await del(`/expenses/${expense.id}`);
                              toast('Chiqim o‘chirildi');
                              await client.invalidateQueries({
                                queryKey: ['expenses'],
                              });
                              await client.invalidateQueries({
                                queryKey: ['finance'],
                              });
                            } catch (caught) {
                              toast(
                                caught instanceof Error
                                  ? caught.message
                                  : t.common.errorTitle,
                                'error',
                              );
                            }
                          }}
                        >
                          O‘chirish
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
