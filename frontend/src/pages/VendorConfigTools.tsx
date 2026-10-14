import { useEffect, useState } from 'react';
import { Button, Checkbox, SelectField, useToast } from '../components/ui';
import { t } from '../i18n';
import type { CustomerSettings } from './CustomerSettingsDialog';

const v = t.vendorTools;

type Config = {
  features: string[];
  hiddenMenus: string[];
  settings: { orders: Record<string, boolean> };
  deniedPermissions: string[];
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
};
type HistoryRow = {
  issuedAt: string;
  expiresAt: string;
  features: string[];
  hiddenMenus: string[];
  deniedPermissions: string[];
  locked: string[];
};
type Tools = {
  templates: () => Promise<Record<string, Partial<Config>>>;
  saveTemplate: (name: string, config: Config) => Promise<unknown>;
  deleteTemplate: (name: string) => Promise<unknown>;
  customerHistory: (installId: string) => Promise<HistoryRow[]>;
  rollback: (installId: string, issuedAt: string) => Promise<unknown>;
};
const tools = (window as unknown as { fastfoodVendor?: Tools }).fastfoodVendor;

const message = (caught: unknown) =>
  (caught instanceof Error ? caught.message : String(caught)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

export const toConfig = (form: CustomerSettings): Config => ({
  features: form.features,
  hiddenMenus: form.hiddenMenus,
  settings: { orders: form.lockedOrders },
  deniedPermissions: form.deniedPermissions,
  maxBranches: form.maxBranches,
  maxUsers: form.maxUsers,
  maxDevices: form.maxDevices,
});

/** Templates, apply-to-others selection and configuration history/rollback. */
export function VendorConfigTools({
  installId,
  form,
  setForm,
  customers,
  alsoFor,
  setAlsoFor,
  onRolledBack,
}: {
  installId: string;
  form: CustomerSettings;
  setForm: (form: CustomerSettings) => void;
  customers: { installId: string; customer: string }[];
  alsoFor: string[];
  setAlsoFor: (ids: string[]) => void;
  onRolledBack: () => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<Record<string, Partial<Config>>>(
    {},
  );
  const [history, setHistory] = useState<HistoryRow[]>([]);
  useEffect(() => {
    void tools?.templates().then(setTemplates);
    void tools?.customerHistory(installId).then(setHistory);
  }, [installId]);
  if (!tools) return null;
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (caught) {
      toast(message(caught), 'error');
    }
  };
  const others = customers.filter((c) => c.installId !== installId);

  return (
    <fieldset className="stack">
      <legend>🗂 {v.title}</legend>
      <div className="toolbar">
        <SelectField
          label={v.apply}
          value=""
          onChange={(event) => {
            const template = templates[event.target.value];
            if (!template) return;
            setForm({
              ...form,
              features: template.features ?? form.features,
              hiddenMenus: template.hiddenMenus ?? form.hiddenMenus,
              lockedOrders: template.settings?.orders ?? form.lockedOrders,
              deniedPermissions:
                template.deniedPermissions ?? form.deniedPermissions,
              maxBranches: template.maxBranches ?? form.maxBranches,
              maxUsers: template.maxUsers ?? form.maxUsers,
              maxDevices: template.maxDevices ?? form.maxDevices,
            });
            toast(v.applied);
          }}
        >
          <option value="">—</option>
          {Object.keys(templates).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </SelectField>
        <Button
          size="sm"
          onClick={() => {
            const name = window.prompt(v.namePrompt)?.trim();
            if (!name) return;
            void run(async () => {
              setTemplates(
                (await tools.saveTemplate(name, toConfig(form))) as Record<
                  string,
                  Partial<Config>
                >,
              );
            }, v.saved);
          }}
        >
          💾 {v.save}
        </Button>
        {Object.keys(templates).length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const name = window.prompt(
                `${v.deletePrompt}\n${Object.keys(templates).join(', ')}`,
              );
              if (!name || !templates[name]) return;
              void run(async () => {
                setTemplates(
                  (await tools.deleteTemplate(name)) as Record<
                    string,
                    Partial<Config>
                  >,
                );
              });
            }}
          >
            {v.delete}
          </Button>
        )}
      </div>
      {others.length > 0 && (
        <details>
          <summary className="small">
            {v.alsoFor} ({alsoFor.length})
          </summary>
          <div className="check-grid">
            {others.map((customer) => (
              <Checkbox
                key={customer.installId}
                label={customer.customer}
                checked={alsoFor.includes(customer.installId)}
                onChange={(on) =>
                  setAlsoFor(
                    on
                      ? [...alsoFor, customer.installId]
                      : alsoFor.filter((id) => id !== customer.installId),
                  )
                }
              />
            ))}
          </div>
        </details>
      )}
      {history.length > 1 && (
        <details>
          <summary className="small">
            {v.history} ({history.length})
          </summary>
          <ul className="list">
            {history.slice(0, 20).map((row, index) => (
              <li key={row.issuedAt} className="toolbar">
                <span className="small">
                  {new Date(row.issuedAt).toLocaleString('uz-UZ')} ·{' '}
                  {v.summary
                    .replace('{f}', String(row.features.length))
                    .replace('{m}', String(row.hiddenMenus.length))
                    .replace('{p}', String(row.deniedPermissions.length))
                    .replace('{l}', String(row.locked.length))}
                </span>
                {index > 0 && (
                  <Button
                    size="sm"
                    onClick={() =>
                      window.confirm(v.rollbackConfirm) &&
                      void run(async () => {
                        await tools.rollback(installId, row.issuedAt);
                        onRolledBack();
                      }, v.rolledBack)
                    }
                  >
                    ↩ {v.rollback}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}
