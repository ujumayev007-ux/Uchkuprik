import { Fragment, useMemo, useState } from 'react';
import { ParamFields } from '../../components/ParamFields';
import {
  Badge,
  Button,
  Checkbox,
  SelectField,
  TextField,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import {
  ownerPut,
  type FeatureDef,
  type FeatureOverride,
  type ParamValue,
  type PolicyDoc,
} from '../../lib/owner';

// Roles every restaurant has; SUPER_OWNER can decide per role.
const ROLES: { key: string; name: string }[] = [
  { key: 'owner', name: 'Egasi' },
  { key: 'admin', name: 'Administrator' },
  { key: 'cashier', name: 'Kassir' },
  { key: 'waiter', name: 'Ofitsiant' },
  { key: 'kitchen', name: 'Oshxona xodimi' },
  { key: 'courier', name: 'Kuryer' },
  { key: 'warehouse', name: 'Omborchi' },
];

const p = t.owner.policy;

type Draft = Record<string, FeatureOverride>;

const modeOf = (def: FeatureDef, draft: Draft) =>
  draft[def.key]?.mode ?? def.defaultMode ?? 'ON';

/** Drops entries equal to the catalog defaults so only real decisions are stored. */
function sparse(defs: FeatureDef[], draft: Draft): Draft {
  const result: Draft = {};
  for (const def of defs) {
    const value = draft[def.key];
    if (!value) continue;
    const entry: FeatureOverride = {};
    if (value.mode && value.mode !== (def.defaultMode ?? 'ON'))
      entry.mode = value.mode;
    if (value.online === false) entry.online = false;
    if (
      def.offlineCapable &&
      value.offline !== undefined &&
      value.offline !== def.defaultOffline
    )
      entry.offline = value.offline;
    if (value.params && Object.keys(value.params).length)
      entry.params = value.params;
    const roles = Object.fromEntries(
      Object.entries(value.roles ?? {}).filter(
        ([, role]) =>
          role.enabled !== undefined ||
          (role.params && Object.keys(role.params).length > 0),
      ),
    );
    if (Object.keys(roles).length) entry.roles = roles;
    if (Object.keys(entry).length) result[def.key] = entry;
  }
  return result;
}

/** The vendor's expiring exception to local-network-only operation. */
function NetworkException({
  customerId,
  policy,
  onSaved,
}: {
  customerId: string;
  policy: PolicyDoc;
  onSaved: () => void;
}) {
  const toast = useToast();
  const n = t.owner.policy.network;
  const current = policy.network?.override ?? null;
  const live =
    current && Date.parse(current.expiresAt) > Date.now() ? current : null;
  const [days, setDays] = useState('1');
  const [roles, setRoles] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (
    networkOverride: null | { days: number; roles: string[]; reason: string },
  ) => {
    setBusy(true);
    try {
      await ownerPut(`/customers/${customerId}/policy`, {
        features: policy.features,
        offlineEnabled: policy.offlineEnabled,
        maxOfflineMinutes: policy.maxOfflineMinutes,
        minAppVersion: policy.minAppVersion,
        minVersionFrom: policy.minVersionFrom,
        networkOverride,
      });
      toast(networkOverride ? n.granted : n.revoked);
      setReason('');
      onSaved();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="stack">
      <legend>{n.title}</legend>
      <p className="muted small">{n.intro}</p>
      {live ? (
        <div className="stack">
          <Badge tone="warning">
            {n.active.replace(
              '{date}',
              new Date(live.expiresAt).toLocaleString('uz-UZ'),
            )}
          </Badge>
          <span className="muted small">
            {n.rolesLabel.replace(
              '{roles}',
              live.roles.length ? live.roles.join(', ') : n.allRoles,
            )}{' '}
            · {n.reasonLabel.replace('{reason}', live.reason)}
          </span>
          <Button variant="danger" busy={busy} onClick={() => void send(null)}>
            {n.revoke}
          </Button>
        </div>
      ) : (
        <p className="muted">{n.none}</p>
      )}
      <div className="form-grid">
        <SelectField
          label={n.days}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          {['1', '3', '7', '14', '30', '90'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
        <TextField
          label={n.reason}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={200}
        />
      </div>
      <div className="chip-row" aria-label={n.roles}>
        {ROLES.map((role) => (
          <Checkbox
            key={role.key}
            label={role.name}
            checked={roles.includes(role.key)}
            onChange={(on) =>
              setRoles((list) =>
                on
                  ? [...list, role.key]
                  : list.filter((key) => key !== role.key),
              )
            }
          />
        ))}
      </div>
      <p className="muted small">{n.timing}</p>
      <p className="muted small">{n.loginNote}</p>
      <Button
        variant="primary"
        busy={busy}
        disabled={reason.trim().length < 3}
        onClick={() =>
          void send({ days: Number(days), roles, reason: reason.trim() })
        }
      >
        {n.grant}
      </Button>
    </fieldset>
  );
}

/** Searchable feature matrix + offline rules of one customer. */
export function PolicyEditor({
  customerId,
  catalog,
  policy,
  onSaved,
}: {
  customerId: string;
  catalog: FeatureDef[];
  policy: PolicyDoc;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(policy.features);
  const [offlineEnabled, setOfflineEnabled] = useState(policy.offlineEnabled);
  const [hours, setHours] = useState(String(policy.maxOfflineMinutes / 60));
  const [minVersion, setMinVersion] = useState(policy.minAppVersion ?? '');
  const [minFrom, setMinFrom] = useState(
    policy.minVersionFrom ? policy.minVersionFrom.slice(0, 16) : '',
  );
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const groups = useMemo(
    () => [...new Set(catalog.map((def) => def.group))],
    [catalog],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter(
      (def) =>
        (!group || def.group === group) &&
        (!needle ||
          def.label.toLowerCase().includes(needle) ||
          def.key.toLowerCase().includes(needle) ||
          def.group.toLowerCase().includes(needle)),
    );
  }, [catalog, query, group]);

  const patch = (key: string, change: FeatureOverride) =>
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], ...change },
    }));

  const setParam = (
    key: string,
    role: string | null,
    param: string,
    value: ParamValue | undefined,
  ) =>
    setDraft((current) => {
      const entry = { ...(current[key] ?? {}) };
      const apply = (
        params: Record<string, ParamValue> | undefined,
      ): Record<string, ParamValue> => {
        const next = { ...(params ?? {}) };
        if (value === undefined) delete next[param];
        else next[param] = value;
        return next;
      };
      if (role === null) entry.params = apply(entry.params);
      else {
        const roles = { ...(entry.roles ?? {}) };
        roles[role] = {
          ...(roles[role] ?? {}),
          params: apply(roles[role]?.params),
        };
        entry.roles = roles;
      }
      return { ...current, [key]: entry };
    });

  const setRoleEnabled = (
    key: string,
    role: string,
    value: boolean | undefined,
  ) =>
    setDraft((current) => {
      const entry = { ...(current[key] ?? {}) };
      const roles = { ...(entry.roles ?? {}) };
      const next = { ...(roles[role] ?? {}) };
      if (value === undefined) delete next.enabled;
      else next.enabled = value;
      roles[role] = next;
      entry.roles = roles;
      return { ...current, [key]: entry };
    });

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        features: sparse(catalog, draft),
        offlineEnabled,
        maxOfflineMinutes: offlineEnabled
          ? Math.round(Number(hours || '0') * 60)
          : 0,
        minAppVersion: /^\d+\.\d+\.\d+$/.test(minVersion) ? minVersion : null,
        minVersionFrom: minFrom ? new Date(minFrom).toISOString() : null,
      };
      const result = await ownerPut<{ version: number }>(
        `/customers/${customerId}/policy`,
        body,
      );
      toast(p.saved.replace('{v}', String(result.version)));
      onSaved();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h3 className="section-title">{p.title}</h3>
      <p className="muted small">
        <strong>{p.limitationTitle}:</strong> {p.limitation}
      </p>
      <p className="muted small">{p.timing}</p>
      <p className="muted small">{p.cashierFinancial}</p>

      <NetworkException
        customerId={customerId}
        policy={policy}
        onSaved={onSaved}
      />

      <fieldset className="stack">
        <legend>{p.offlineTitle}</legend>
        <Checkbox
          label={p.offlineEnabled}
          checked={offlineEnabled}
          onChange={setOfflineEnabled}
        />
        {offlineEnabled && (
          <TextField
            label={p.maxOffline}
            inputMode="decimal"
            value={hours}
            onChange={(event) =>
              setHours(event.target.value.replace(/[^\d.]/g, ''))
            }
          />
        )}
        <div className="form-grid">
          <TextField
            label={p.minVersion}
            placeholder="1.8.0"
            value={minVersion}
            onChange={(event) => setMinVersion(event.target.value.trim())}
          />
          <TextField
            label={p.minVersionFrom}
            type="datetime-local"
            value={minFrom}
            onChange={(event) => setMinFrom(event.target.value)}
          />
        </div>
      </fieldset>

      <div className="form-grid">
        <TextField
          label={t.common.search}
          placeholder={p.searchFeatures}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SelectField
          label={p.allGroups}
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        >
          <option value="">{p.allGroups}</option>
          {groups.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="table-wrap">
        <table className="table policy-table">
          <thead>
            <tr>
              <th>{p.feature}</th>
              <th>{p.mode}</th>
              <th>{p.online}</th>
              <th>{p.offline}</th>
              <th>{p.valuesTitle}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((def) => {
              const mode = modeOf(def, draft);
              const off = mode === 'OFF';
              const online = draft[def.key]?.online ?? true;
              const offline = draft[def.key]?.offline ?? def.defaultOffline;
              const reportOnly =
                def.kind === 'report_field' || def.kind === 'financial';
              return (
                <Fragment key={def.key}>
                  <tr>
                    <td>
                      <strong>{def.label}</strong>{' '}
                      <Badge>{p.kinds[def.kind]}</Badge>
                      {def.sensitive && (
                        <Badge tone="warning">{p.sensitive}</Badge>
                      )}
                      <div className="muted small">
                        {def.group} · {def.key}
                        {def.hint ? ` · ${def.hint}` : ''}
                      </div>
                    </td>
                    <td data-label={p.mode}>
                      <select
                        aria-label={`${def.label}: ${p.mode}`}
                        value={mode}
                        onChange={(event) =>
                          patch(def.key, {
                            mode: event.target.value as 'ON' | 'OFF' | 'ADMIN',
                          })
                        }
                      >
                        <option value="ON">{p.modes.ON}</option>
                        <option value="OFF">{p.modes.OFF}</option>
                        <option value="ADMIN">{p.modes.ADMIN}</option>
                      </select>
                    </td>
                    <td data-label={p.online}>
                      <input
                        type="checkbox"
                        aria-label={`${def.label}: ${p.online}`}
                        checked={!off && online}
                        disabled={off || reportOnly}
                        onChange={(event) =>
                          patch(def.key, { online: event.target.checked })
                        }
                      />
                    </td>
                    <td data-label={p.offline}>
                      {def.offlineCapable && !reportOnly ? (
                        <input
                          type="checkbox"
                          aria-label={`${def.label}: ${p.offline}`}
                          checked={!off && offline}
                          disabled={off || !offlineEnabled}
                          onChange={(event) =>
                            patch(def.key, { offline: event.target.checked })
                          }
                        />
                      ) : reportOnly ? (
                        <span className="muted small">—</span>
                      ) : (
                        <span className="muted small">{p.never}</span>
                      )}
                    </td>
                    <td data-label={p.valuesTitle}>
                      {!reportOnly && (
                        <button
                          className="text-link"
                          aria-expanded={open === def.key}
                          onClick={() =>
                            setOpen(open === def.key ? null : def.key)
                          }
                        >
                          {open === def.key ? '▲' : '▼'} {p.valuesTitle}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open === def.key && (
                    <tr>
                      <td colSpan={5}>
                        <div className="stack card">
                          {def.params && def.params.length > 0 && (
                            <>
                              <strong>{p.valuesTitle}</strong>
                              <ParamFields
                                defs={def.params}
                                values={draft[def.key]?.params ?? {}}
                                onChange={(param, value) =>
                                  setParam(def.key, null, param, value)
                                }
                              />
                              {mode === 'ADMIN' && (
                                <p className="muted small">{p.adminCap}</p>
                              )}
                            </>
                          )}
                          <strong>{p.rolesTitle}</strong>
                          <p className="muted small">{p.rolesHint}</p>
                          <div className="stack compact">
                            {ROLES.map((role) => {
                              const roleValue =
                                draft[def.key]?.roles?.[role.key];
                              return (
                                <div key={role.key} className="stack compact">
                                  <label className="field">
                                    <span className="field-label">
                                      {role.name}
                                    </span>
                                    <select
                                      disabled={off}
                                      value={
                                        roleValue?.enabled === undefined
                                          ? ''
                                          : roleValue.enabled
                                            ? '1'
                                            : '0'
                                      }
                                      onChange={(event) =>
                                        setRoleEnabled(
                                          def.key,
                                          role.key,
                                          event.target.value === ''
                                            ? undefined
                                            : event.target.value === '1',
                                        )
                                      }
                                    >
                                      <option value="">{p.roleDefault}</option>
                                      <option value="1">{p.roleOn}</option>
                                      <option value="0">{p.roleOff}</option>
                                    </select>
                                  </label>
                                  {def.params && def.params.length > 0 && (
                                    <ParamFields
                                      defs={def.params}
                                      values={roleValue?.params ?? {}}
                                      inherited={draft[def.key]?.params ?? {}}
                                      disabled={off}
                                      onChange={(param, value) =>
                                        setParam(
                                          def.key,
                                          role.key,
                                          param,
                                          value,
                                        )
                                      }
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {p.save}
        </Button>
      </div>
    </section>
  );
}
