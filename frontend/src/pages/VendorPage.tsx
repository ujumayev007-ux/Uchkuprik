import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { VendorAlerts, type AlertsBridge } from './VendorAlerts';
import {
  CustomerSettingsDialog,
  type CustomerSettings,
} from './CustomerSettingsDialog';

const v = t.vendor;

type Customer = {
  installId: string;
  customer: string;
  expiresAt: string;
  blocked: boolean;
  features: string[];
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
  hiddenMenus: string[];
  key: string | null;
};
type VendorState = {
  connected: boolean;
  statusUrl: string | null;
  update: { version: string; publishedAt: string } | null;
  telegram?: { connected: boolean; bot: string | null };
  blockedInstalls?: string[];
  customers: Customer[];
};
type Publish = { published?: boolean; error?: string };

/** Bridge from the desktop app; only the vendor's computer reports isVendor. */
export type VendorBridge = AlertsBridge & {
  isVendor: boolean;
  state: () => Promise<VendorState>;
  connect: (token: string) => Promise<VendorState>;
  sign: (payload: object) => Promise<{ key: string } & Publish>;
  extend: (
    installId: string,
    months: number,
  ) => Promise<{ key: string; expiresAt: string } & Publish>;
  update: (
    installId: string,
    changes: CustomerSettings,
  ) => Promise<{ key: string } & Publish>;
  block: (installId: string, blocked: boolean) => Promise<Publish>;
  publishUpdate: (
    notes: string,
  ) => Promise<{ cancelled?: boolean; version?: string; apk?: boolean }>;
};
export const vendor = (window as unknown as { fastfoodVendor?: VendorBridge })
  .fastfoodVendor;
export const isVendorComputer = () => !!vendor?.isVendor;

const FEATURES = Object.keys(
  t.vendor.features,
) as (keyof typeof t.vendor.features)[];
const today = () => new Date().toISOString().slice(0, 10);

function statusOf(customer: Customer) {
  if (customer.blocked) return { tone: 'danger' as const, label: v.blocked };
  if (customer.expiresAt < today())
    return { tone: 'danger' as const, label: v.expired };
  const days = Math.ceil(
    (new Date(`${customer.expiresAt}T23:59:59`).getTime() - Date.now()) /
      86_400_000,
  );
  return days <= 5
    ? {
        tone: 'warning' as const,
        label: v.daysLeft.replace('{days}', String(days)),
      }
    : { tone: 'success' as const, label: v.active };
}

function addMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function VendorPage() {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [state, setState] = useState<VendorState | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    customer: '',
    installId: '',
    months: '1',
    features: FEATURES as string[],
    maxBranches: '',
    maxUsers: '',
    maxDevices: '',
  });
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<Customer | null>(null);
  const [notes, setNotes] = useState('');

  const reload = useCallback(() => {
    void vendor?.state().then(setState);
  }, []);
  useEffect(reload, [reload]);

  if (!vendor?.isVendor) return <EmptyState title={v.notVendor} />;

  const report = (result: Publish, done: string) =>
    toast(
      result.published
        ? `${done} ${v.published}`
        : result.error
          ? `${done} ${v.notPublished}: ${result.error}`
          : `${done} ${v.sendManually}`,
      result.error ? 'error' : undefined,
    );
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : String(caught), 'error');
    } finally {
      setBusy(false);
      reload();
    }
  };
  const num = (value: string) => (value.trim() === '' ? null : Number(value));
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(v.copied))
      .catch(() => undefined);

  return (
    <div className="stack">
      <PageHeader title={v.title} subtitle={v.subtitle} />

      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">{v.remoteTitle}</h2>
          <Badge tone={state?.connected ? 'success' : 'warning'}>
            {state?.connected ? v.remoteOn : v.remoteOff}
          </Badge>
        </div>
        {state?.connected && <p className="muted small">{v.remoteOnHint}</p>}
        <details open={!state?.connected}>
          <summary className="small">{v.replaceToken}</summary>
          <div className="stack">
            <p className="sop-body small">{v.remoteSetup}</p>
            <TextField
              label={v.githubToken}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <div>
              <Button
                variant="primary"
                busy={busy}
                disabled={!token.trim()}
                onClick={() =>
                  void run(async () => {
                    setState(await vendor.connect(token));
                    setToken('');
                    toast(v.connected);
                  })
                }
              >
                {v.connect}
              </Button>
            </div>
          </div>
        </details>
      </section>
      <VendorAlerts
        bridge={vendor}
        telegram={state?.telegram}
        blockedInstalls={state?.blockedInstalls ?? []}
        onChange={reload}
      />

      <section className="card stack">
        <h2 className="section-title">{v.newCustomer}</h2>
        <div className="form-grid">
          <TextField
            label={v.customer}
            value={form.customer}
            onChange={(event) =>
              setForm({ ...form, customer: event.target.value })
            }
          />
          <TextField
            label={v.installId}
            placeholder="FF-XXXX-XXXX-XXXX"
            value={form.installId}
            onChange={(event) =>
              setForm({
                ...form,
                installId: event.target.value.toUpperCase().trim(),
              })
            }
          />
          <SelectField
            label={v.period}
            value={form.months}
            onChange={(event) =>
              setForm({ ...form, months: event.target.value })
            }
          >
            {[1, 3, 6, 12].map((months) => (
              <option key={months} value={months}>
                {v.months.replace('{n}', String(months))}
              </option>
            ))}
          </SelectField>
          <TextField
            label={v.maxBranches}
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
            label={v.maxUsers}
            inputMode="numeric"
            value={form.maxUsers}
            onChange={(event) =>
              setForm({
                ...form,
                maxUsers: event.target.value.replace(/\D/g, ''),
              })
            }
          />
          <TextField
            label={v.maxDevices}
            inputMode="numeric"
            value={form.maxDevices}
            onChange={(event) =>
              setForm({
                ...form,
                maxDevices: event.target.value.replace(/\D/g, ''),
              })
            }
          />
        </div>
        <fieldset>
          <legend>{v.featuresTitle}</legend>
          <div className="check-grid">
            {FEATURES.map((key) => (
              <Checkbox
                key={key}
                label={v.features[key]}
                checked={form.features.includes(key)}
                onChange={(on) =>
                  setForm({
                    ...form,
                    features: on
                      ? [...form.features, key]
                      : form.features.filter((item) => item !== key),
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        <div>
          <Button
            variant="primary"
            busy={busy}
            disabled={!form.customer.trim() || !form.installId}
            onClick={() =>
              void run(async () => {
                const result = await vendor.sign({
                  customer: form.customer.trim(),
                  installId: form.installId,
                  expiresAt: addMonths(Number(form.months)),
                  features: form.features,
                  maxBranches: num(form.maxBranches),
                  maxUsers: num(form.maxUsers),
                  maxDevices: num(form.maxDevices),
                });
                setLastKey(result.key);
                report(result, v.issued);
                setForm({ ...form, customer: '', installId: '' });
              })
            }
          >
            {v.issue}
          </Button>
        </div>
        {lastKey && (
          <div className="stack">
            <p className="muted small">{v.keyHint}</p>
            <p className="secret-box">{lastKey}</p>
            <div>
              <Button size="sm" onClick={() => copy(lastKey)}>
                {v.copyKey}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="card stack">
        <h2 className="section-title">{v.customers}</h2>
        {!state || state.customers.length === 0 ? (
          <EmptyState title={v.noCustomers} />
        ) : (
          <ul className="ops-list">
            {state.customers.map((customer) => {
              const status = statusOf(customer);
              return (
                <li
                  key={customer.installId}
                  className={`ops-item ${status.tone === 'danger' ? 'alarm' : ''}`}
                >
                  <div className="grow">
                    <strong>{customer.customer}</strong>
                    <div className="muted small">
                      {customer.installId} · {v.until} {customer.expiresAt}
                    </div>
                  </div>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await vendor.extend(
                          customer.installId,
                          1,
                        );
                        setLastKey(result.key);
                        report(
                          result,
                          v.extended.replace('{date}', result.expiresAt),
                        );
                      })
                    }
                  >
                    {v.plusMonth}
                  </Button>
                  <Button
                    size="sm"
                    variant={customer.blocked ? 'secondary' : 'danger'}
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !customer.blocked &&
                        !(await confirm(
                          v.blockConfirm.replace('{name}', customer.customer),
                        ))
                      )
                        return;
                      void run(async () => {
                        const result = await vendor.block(
                          customer.installId,
                          !customer.blocked,
                        );
                        report(
                          result,
                          customer.blocked ? v.unblockedDone : v.blockedDone,
                        );
                      });
                    }}
                  >
                    {customer.blocked ? v.unblock : v.block}
                  </Button>
                  <Button size="sm" onClick={() => setConfiguring(customer)}>
                    ⚙ {v.configure}
                  </Button>
                  {customer.key && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copy(customer.key!)}
                    >
                      {v.copyKey}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="card stack">
        <h2 className="section-title">⬆ {t.updates.publishTitle}</h2>
        <p className="muted small">{t.updates.publishHint}</p>
        {state?.update && (
          <p>
            {t.updates.lastPublished}: <strong>{state.update.version}</strong>
          </p>
        )}
        <TextField
          label={t.updates.notes}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div className="form-actions">
          <Button
            variant="primary"
            busy={busy}
            disabled={!state?.connected}
            onClick={() =>
              run(async () => {
                toast(t.updates.uploading);
                const result = await vendor.publishUpdate(notes.trim());
                if (result.cancelled) return;
                setNotes('');
                toast(
                  t.updates.publishedOk.replace(
                    '{version}',
                    result.version ?? '',
                  ),
                );
              })
            }
          >
            {t.updates.publish}
          </Button>
        </div>
      </section>
      <section className="card stack">
        <h2 className="section-title">{v.howTitle}</h2>
        <p className="sop-body small">{v.how}</p>
      </section>
      {configuring && (
        <CustomerSettingsDialog
          name={configuring.customer}
          initial={{
            features: configuring.features,
            hiddenMenus: configuring.hiddenMenus ?? [],
            maxBranches: configuring.maxBranches,
            maxUsers: configuring.maxUsers,
            maxDevices: configuring.maxDevices,
          }}
          onClose={() => setConfiguring(null)}
          onSave={(settings) =>
            run(async () => {
              const result = await vendor.update(
                configuring.installId,
                settings,
              );
              setLastKey(result.key);
              report(result, v.settingsSaved);
              setConfiguring(null);
            })
          }
        />
      )}
      {element}
    </div>
  );
}
