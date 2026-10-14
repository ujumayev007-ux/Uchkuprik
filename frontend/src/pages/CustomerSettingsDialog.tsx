import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { navItems } from '../components/AppShell';
import {
  Button,
  Checkbox,
  Dialog,
  SelectField,
  TextField,
} from '../components/ui';
import { t } from '../i18n';

const v = t.vendor;

// Entries that always stay: home, licence, own account and vendor tools.
const ALWAYS = new Set(['/', '/litsenziya', '/hisob', '/sotuvchi']);
export const configurableMenus = () =>
  navItems.filter(
    (item) => !ALWAYS.has(item.to) && !item.to.startsWith('/platforma'),
  );

export type CustomerSettings = {
  features: string[];
  hiddenMenus: string[];
  // Order settings fixed by the vendor (absent = restaurant decides).
  lockedOrders: Record<string, boolean>;
  // Permissions switched off for every user of this install.
  deniedPermissions: string[];
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
};

/** Vendor's remote switchboard for one customer: menus, features and limits. */
export function CustomerSettingsDialog({
  name,
  initial,
  onSave,
  onClose,
}: {
  name: string;
  initial: CustomerSettings;
  onSave: (settings: CustomerSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const features = Object.keys(v.features) as (keyof typeof v.features)[];
  const menus = configurableMenus();
  const limit = (value: string) =>
    value.trim() === '' ? null : Number(value.replace(/\D/g, ''));
  const allMenusOn = form.hiddenMenus.length === 0;
  const permissions = useQuery({
    queryKey: ['permissions'],
    queryFn: () =>
      api<{ permissions: { key: string; label: string }[] }>('/permissions'),
  });
  const orderKeys = Object.keys(
    t.orderSettings.labels,
  ) as (keyof typeof t.orderSettings.labels)[];
  return (
    <Dialog
      open
      wide
      title={`${v.settingsTitle}: ${name}`}
      description={v.settingsHint}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(form);
              } finally {
                setBusy(false);
              }
            }}
          >
            {v.saveAndSend}
          </Button>
        </>
      }
    >
      <div className="stack">
        <fieldset>
          <legend>{v.menusTitle}</legend>
          <div className="toolbar">
            <Button
              size="sm"
              onClick={() => setForm({ ...form, hiddenMenus: [] })}
              disabled={allMenusOn}
            >
              {v.showAll}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setForm({ ...form, hiddenMenus: menus.map((item) => item.to) })
              }
            >
              {v.hideAll}
            </Button>
          </div>
          <div className="check-grid">
            {menus.map((item) => (
              <Checkbox
                key={item.to}
                label={`${item.icon} ${item.label}`}
                checked={!form.hiddenMenus.includes(item.to)}
                onChange={(on) =>
                  setForm({
                    ...form,
                    hiddenMenus: on
                      ? form.hiddenMenus.filter((path) => path !== item.to)
                      : [...form.hiddenMenus, item.to],
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{v.featuresTitle}</legend>
          <p className="muted small">{v.featuresHint}</p>
          <div className="check-grid">
            {features.map((key) => (
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
        <fieldset>
          <legend>🔒 {v.locksTitle}</legend>
          <p className="muted small">{v.locksHint}</p>
          <div className="form-grid">
            {orderKeys.map((key) => (
              <SelectField
                key={key}
                label={t.orderSettings.labels[key]}
                value={
                  form.lockedOrders[key] === undefined
                    ? ''
                    : form.lockedOrders[key]
                      ? 'on'
                      : 'off'
                }
                onChange={(event) => {
                  const next = { ...form.lockedOrders };
                  if (event.target.value === '') delete next[key];
                  else next[key] = event.target.value === 'on';
                  setForm({ ...form, lockedOrders: next });
                }}
              >
                <option value="">{v.lockFree}</option>
                <option value="on">🔒 {v.lockOn}</option>
                <option value="off">🔒 {v.lockOff}</option>
              </SelectField>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>👥 {v.permsTitle}</legend>
          <p className="muted small">{v.permsHint}</p>
          <div className="check-grid">
            {(permissions.data?.permissions ?? []).map((permission) => (
              <Checkbox
                key={permission.key}
                label={permission.label}
                checked={!form.deniedPermissions.includes(permission.key)}
                onChange={(on) =>
                  setForm({
                    ...form,
                    deniedPermissions: on
                      ? form.deniedPermissions.filter(
                          (key) => key !== permission.key,
                        )
                      : [...form.deniedPermissions, permission.key],
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        <div className="form-grid">
          <TextField
            label={v.maxBranches}
            inputMode="numeric"
            value={form.maxBranches ?? ''}
            onChange={(event) =>
              setForm({ ...form, maxBranches: limit(event.target.value) })
            }
          />
          <TextField
            label={v.maxUsers}
            inputMode="numeric"
            value={form.maxUsers ?? ''}
            onChange={(event) =>
              setForm({ ...form, maxUsers: limit(event.target.value) })
            }
          />
          <TextField
            label={v.maxDevices}
            inputMode="numeric"
            value={form.maxDevices ?? ''}
            onChange={(event) =>
              setForm({ ...form, maxDevices: limit(event.target.value) })
            }
          />
        </div>
      </div>
    </Dialog>
  );
}
