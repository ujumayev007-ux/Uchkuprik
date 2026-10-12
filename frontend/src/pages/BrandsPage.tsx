import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { useBrands, type Brand } from '../lib/brands';
import { formatMoney } from '../lib/format';

type BrandReport = {
  brands: {
    brandId: string | null;
    brandName: string | null;
    branchCount: number;
    orders: number;
    revenue: number;
    averageCheck: number;
    branches: {
      branchId: string;
      name: string;
      orders: number;
      revenue: number;
    }[];
  }[];
};

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

function BrandForm({
  brand,
  onDone,
}: {
  brand: Brand | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    code: brand?.code ?? '',
    name: brand?.name ?? '',
    logoUrl: brand?.logoUrl ?? '',
    primaryColor: brand?.primaryColor ?? '#ce431b',
    receiptHeader: brand?.receiptHeader ?? '',
    receiptFooter: brand?.receiptFooter ?? '',
    isActive: brand?.isActive ?? true,
    sortOrder: brand?.sortOrder ?? 0,
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
        const body = {
          ...form,
          logoUrl: form.logoUrl.trim() || null,
          receiptHeader: form.receiptHeader.trim() || null,
          receiptFooter: form.receiptFooter.trim() || null,
        };
        try {
          if (brand) await api(`/brands/${brand.id}`, { method: 'PUT', body });
          else await post('/brands', body);
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
          maxLength={80}
          required
        />
        <TextField
          label={t.brands.code}
          hint={t.brands.codeHint}
          value={form.code}
          autoCapitalize="none"
          pattern="[a-z0-9][a-z0-9\-]{0,38}[a-z0-9]"
          onChange={(event) =>
            setForm({ ...form, code: event.target.value.toLowerCase() })
          }
          required
        />
        <TextField
          label={`${t.brands.logoUrl} (${t.common.optional})`}
          type="url"
          pattern="https://.*"
          value={form.logoUrl}
          onChange={set('logoUrl')}
        />
        <TextField
          label={t.brands.color}
          type="color"
          value={form.primaryColor}
          onChange={set('primaryColor')}
        />
        <TextField
          label={`${t.brands.receiptHeader} (${t.common.optional})`}
          value={form.receiptHeader}
          maxLength={300}
          onChange={set('receiptHeader')}
        />
        <TextField
          label={`${t.brands.receiptFooter} (${t.common.optional})`}
          value={form.receiptFooter}
          maxLength={300}
          onChange={set('receiptFooter')}
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
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

function BrandReportSection() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ['brand-report', from, to],
    queryFn: () => api<BrandReport>(`/reports/brands?from=${from}&to=${to}`),
  });
  return (
    <section className="card stack">
      <div className="toolbar">
        <h2 className="section-title">{t.brands.report}</h2>
        <TextField
          label={t.brands.from}
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextField
          label={t.brands.to}
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      {report.isPending ? (
        <LoadingState />
      ) : report.error ? (
        <ErrorState
          error={report.error}
          onRetry={() => void report.refetch()}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.brands.brand}</th>
                <th className="right">{t.brands.branches}</th>
                <th className="right">{t.brands.orders}</th>
                <th className="right">{t.brands.revenue}</th>
                <th className="right">{t.brands.averageCheck}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.brands.map((row) => (
                <tr key={row.brandId ?? 'none'}>
                  <td>
                    <strong>{row.brandName ?? t.brands.withoutBrand}</strong>
                    {row.branches.length > 0 && (
                      <div className="muted small">
                        {row.branches
                          .map(
                            (branch) =>
                              `${branch.name}: ${formatMoney(branch.revenue)}`,
                          )
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="right">{row.branchCount}</td>
                  <td className="right">{row.orders}</td>
                  <td className="right nowrap">{formatMoney(row.revenue)}</td>
                  <td className="right nowrap">
                    {formatMoney(row.averageCheck)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BrandsPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const brands = useBrands();
  const [editing, setEditing] = useState<Brand | 'new' | null>(null);
  const manage = can(me, 'brands.manage');
  return (
    <div className="stack">
      <PageHeader
        title={t.brands.title}
        subtitle={t.brands.subtitle}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + {t.brands.add}
            </Button>
          )
        }
      />
      {brands.isPending ? (
        <LoadingState />
      ) : brands.error ? (
        <ErrorState
          error={brands.error}
          onRetry={() => void brands.refetch()}
        />
      ) : brands.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="brand-grid">
          {brands.data.map((brand) => (
            <article
              key={brand.id}
              className="card brand-card"
              style={{ borderTopColor: brand.primaryColor ?? undefined }}
            >
              <header>
                {brand.logoUrl ? (
                  <img src={brand.logoUrl} alt="" width={40} height={40} />
                ) : (
                  <span
                    className="brand-swatch"
                    aria-hidden="true"
                    style={{ background: brand.primaryColor ?? undefined }}
                  >
                    {brand.name.slice(0, 1)}
                  </span>
                )}
                <div>
                  <h3>{brand.name}</h3>
                  <span className="muted small">{brand.code}</span>
                </div>
                {!brand.isActive && <Badge>{t.common.inactive}</Badge>}
              </header>
              <p className="muted small">
                {t.brands.branches}: {brand.branchCount} · {t.brands.categories}
                : {brand.categoryCount}
              </p>
              {manage && (
                <div>
                  <Button size="sm" onClick={() => setEditing(brand)}>
                    {t.common.edit}
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {can(me, 'reports.view') && <BrandReportSection />}
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? t.brands.add : t.brands.edit}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <BrandForm
            brand={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void client.invalidateQueries({ queryKey: ['brands'] });
              void client.invalidateQueries({ queryKey: ['brand-report'] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
