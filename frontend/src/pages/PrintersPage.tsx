import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import {
  terminalPrinter,
  TerminalPrinterButton,
} from '../components/TerminalPrinter';
import { t } from '../i18n';
import { api, del, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStations } from './KitchenPage';

const p = t.printers;

export type Printer = {
  id: string;
  name: string;
  kind: 'RECEIPT' | 'KITCHEN';
  stationId: string | null;
  fallbackPrinterId: string | null;
  paperWidth?: number;
  host: string;
  port: number;
  isActive: boolean;
};

type Job = {
  id: string;
  printer: string;
  kind: string;
  purpose: string;
  fallback: boolean;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

/** The networks of the restaurant computer (where printers must be reachable from). */
function useServerSubnets() {
  return useQuery({
    queryKey: ['printer-subnets'],
    queryFn: () =>
      api<{ subnets: string[]; addresses: string[] }>('/printers/subnets'),
    staleTime: 60_000,
  });
}

const FULL_IP = /^\d{1,3}(\.\d{1,3}){3}$/;

function PrinterForm({
  printer,
  branchId,
  others,
  onDone,
}: {
  printer: Printer | null;
  branchId: string;
  others: Printer[];
  onDone: () => void;
}) {
  const stations = useStations();
  const toast = useToast();
  const [form, setForm] = useState({
    name: printer?.name ?? '',
    kind: printer?.kind ?? ('KITCHEN' as const),
    stationId: printer?.stationId ?? '',
    fallbackPrinterId: printer?.fallbackPrinterId ?? '',
    paperWidth: printer?.paperWidth ?? 80,
    host: printer?.host ?? '',
    port: printer?.port ?? 9100,
    isActive: printer?.isActive ?? true,
    allowDuplicate: false,
  });
  const [pingResult, setPingResult] = useState<{
    online: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [pinging, setPinging] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const subnets = useServerSubnets().data?.subnets ?? [];
  const base = subnets[0];
  // Only the last number typed ("50"): completed with the computer's network.
  const completeHost = (value: string) =>
    base && /^\d{1,3}$/.test(value) ? `${base}.${value}` : value;
  const prefix = form.host.split('.').slice(0, 3).join('.');
  const otherNetwork =
    FULL_IP.test(form.host) && subnets.length > 0 && !subnets.includes(prefix);

  // Check for duplicate IP/port collision with another active printer
  const duplicate = others.find(
    (other) =>
      other.id !== printer?.id &&
      other.host === form.host &&
      other.port === form.port &&
      other.isActive,
  );

  const testPing = async (host = form.host) => {
    if (!host) return;
    setPinging(true);
    setPingResult(null);
    try {
      const res = await post<{ online: boolean; latencyMs: number; error?: string }>(
        '/printers/ping-host',
        { host, port: form.port },
      );
      setPingResult(res);
      if (res.online) {
        toast(`${p.pingSuccess.replace('{ms}', String(res.latencyMs))}`);
      } else {
        toast(`${p.pingFail}: ${res.error ?? ''}`, 'error');
      }
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : p.pingFail, 'error');
    } finally {
      setPinging(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          ...form,
          host: completeHost(form.host),
          branchId,
          stationId: form.kind === 'KITCHEN' ? (form.stationId || null) : null,
          fallbackPrinterId: form.fallbackPrinterId || null,
        };
        try {
          if (printer) await patch(`/printers/${printer.id}`, body);
          else await post('/printers', body);
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
          placeholder="Masalan: Kassa chek yoki Oshxona issiq sex"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <SelectField
          label={p.kind}
          value={form.kind}
          onChange={(e) =>
            setForm({ ...form, kind: e.target.value as Printer['kind'] })
          }
        >
          <option value="KITCHEN">{p.kinds.KITCHEN}</option>
          <option value="RECEIPT">{p.kinds.RECEIPT}</option>
        </SelectField>

        {form.kind === 'KITCHEN' && (
          <SelectField
            label={p.department}
            value={form.stationId}
            onChange={(e) => setForm({ ...form, stationId: e.target.value })}
          >
            <option value="">{p.allDepartments}</option>
            {(stations.data ?? []).map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </SelectField>
        )}

        <SelectField
          label={p.paper}
          value={
            form.paperWidth === 58 || form.paperWidth === 80
              ? String(form.paperWidth)
              : 'custom'
          }
          onChange={(e) =>
            setForm({
              ...form,
              paperWidth:
                e.target.value === 'custom' ? 72 : Number(e.target.value),
            })
          }
        >
          <option value="80">80 mm (Standart termal qog‘oz — XPrinter XP-Q80AS)</option>
          <option value="58">58 mm (Kichik kassa qog‘ozi)</option>
          <option value="custom">{t.receiptTpl.custom}</option>
        </SelectField>

        {form.paperWidth !== 58 && form.paperWidth !== 80 && (
          <TextField
            label={t.receiptTpl.widthMm}
            type="number"
            min={40}
            max={112}
            value={form.paperWidth}
            onChange={(e) =>
              setForm({
                ...form,
                paperWidth: Math.min(
                  112,
                  Math.max(40, Math.round(Number(e.target.value)) || 40),
                ),
              })
            }
          />
        )}

        <div className="stack" style={{ gap: '4px' }}>
          <TextField
            label={p.host}
            hint={base ? p.hostSubnetHint.replace('{subnet}', base) : p.hostHint}
            value={form.host}
            inputMode="decimal"
            placeholder={base ? `${base}.100` : '192.168.1.100'}
            pattern="\d{1,3}(\.\d{1,3}){3}|\d{1,3}"
            onChange={(e) => setForm({ ...form, host: e.target.value.trim() })}
            onBlur={() => {
              const host = completeHost(form.host);
              if (host !== form.host) setForm({ ...form, host });
              // Checked by itself as soon as a whole address is there.
              if (FULL_IP.test(host)) void testPing(host);
            }}
            required
          />
          {otherNetwork && (
            <p
              className="small"
              style={{ color: 'var(--color-danger, #dc3545)', margin: 0 }}
            >
              ⚠ {p.otherNetwork.replace('{subnet}', subnets.join(', '))}
            </p>
          )}
          {form.host && (
            <div style={{ marginTop: '4px' }}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                busy={pinging}
                onClick={() => void testPing()}
              >
                ⚡ {p.ping}
              </Button>
              {pingResult && (
                <span
                  style={{
                    marginLeft: '8px',
                    fontSize: '0.85rem',
                    color: pingResult.online ? 'var(--color-success, #28a745)' : 'var(--color-danger, #dc3545)',
                    fontWeight: 600,
                  }}
                >
                  {pingResult.online
                    ? p.pingSuccess.replace('{ms}', String(pingResult.latencyMs))
                    : `${p.pingFail} (${pingResult.error ?? ''})`}
                </span>
              )}
            </div>
          )}
        </div>

        <TextField
          label={p.port}
          type="number"
          min={9100}
          max={9109}
          value={form.port}
          onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
        />

        <SelectField
          label={p.fallback}
          hint={p.fallbackHint}
          value={form.fallbackPrinterId}
          onChange={(e) =>
            setForm({ ...form, fallbackPrinterId: e.target.value })
          }
        >
          <option value="">{p.noFallback}</option>
          {others
            .filter((other) => other.id !== printer?.id)
            .map((other) => (
              <option key={other.id} value={other.id}>
                {other.name} ({other.host}:{other.port})
              </option>
            ))}
        </SelectField>
      </div>

      {duplicate && (
        <div
          className="card"
          style={{
            background: 'var(--color-bg-warning-subtle, #fff3cd)',
            borderColor: '#ffeeba',
            padding: '12px 16px',
          }}
        >
          <strong style={{ color: '#856404' }}>
            {p.duplicateIpWarning
              .replace('{ip}', `${form.host}:${form.port}`)
              .replace('{name}', duplicate.name)}
          </strong>
          <div style={{ marginTop: '6px' }}>
            <Checkbox
              label={p.allowDuplicateIp}
              checked={form.allowDuplicate}
              onChange={(allowDuplicate) =>
                setForm({ ...form, allowDuplicate })
              }
            />
          </div>
        </div>
      )}

      <p className="muted small">ℹ️ {p.cutAndDrawer}</p>

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

/** Automatic discovery modal for Windows USB printers and LAN network printers. */
function DiscoveryDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (info: { name: string; host: string; port: number; widthMm: number }) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [subnet, setSubnet] = useState('');
  const serverSubnets = useServerSubnets().data?.subnets;
  const [windowsPrinters, setWindowsPrinters] = useState<
    Array<{ name: string; label: string }>
  >([]);
  const [lanPrinters, setLanPrinters] = useState<
    Array<{ host: string; port: number; latencyMs: number }>
  >([]);

  const toast = useToast();
  // This computer's receipt or kitchen printer (the same setting as Kassa → 🖨 Printerlar);
  // switched on for automatic printing, which can be changed there.
  const chooseLocal = async (deviceName: string, role: 'receipt' | 'kitchen') => {
    const bridge = terminalPrinter();
    if (!bridge) return;
    try {
      if (role === 'receipt')
        await bridge.set({ ...(await bridge.get()), deviceName, auto: true });
      else if (bridge.kitchenGet && bridge.kitchenSet)
        await bridge.kitchenSet({
          ...(await bridge.kitchenGet()),
          deviceName,
          auto: true,
        });
      toast(role === 'receipt' ? p.savedReceipt : p.savedKitchen);
      onClose();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : t.common.errorTitle, 'error');
    }
  };

  // Load local Windows printers
  useState(() => {
    const bridge = terminalPrinter();
    if (bridge?.list) {
      bridge
        .list()
        .then((list) => setWindowsPrinters(list))
        .catch(() => undefined);
    }
  });

  const scanLan = async (target = subnet.trim() || serverSubnets?.[0] || '') => {
    setScanning(true);
    try {
      const res = await post<{
        discovered: Array<{ host: string; port: number; latencyMs: number }>;
      }>('/printers/discover-lan', target ? { subnet: target } : {});
      setLanPrinters(res.discovered);
    } catch {
      setLanPrinters([]);
    } finally {
      setScanning(false);
    }
  };

  // Opened: the computer's own network is filled in and searched at once.
  const firstSubnet = serverSubnets?.[0];
  useEffect(() => {
    if (!firstSubnet) return;
    setSubnet((current) => current || firstSubnet);
    void scanLan(firstSubnet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSubnet]);

  return (
    <Dialog open title={p.discoveryTitle} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">{p.discoveryHint}</p>

        {windowsPrinters.length > 0 && (
          <section className="card stack">
            <h3 style={{ margin: 0 }}>🖨️ {p.windowsPrinters}</h3>
            <div className="variant-list">
              {windowsPrinters.map((wp) => (
                <div
                  key={wp.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--color-bg-subtle, #f8f9fa)',
                    borderRadius: '6px',
                  }}
                >
                  <div>
                    <strong>{wp.label}</strong>
                    <div className="muted small">Windows / USB / Driver</div>
                  </div>
                  {/* A Windows / USB printer is this computer's own printer (printed by
                      the application), not a network printer with an IP address. */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void chooseLocal(wp.name, 'receipt')}
                    >
                      🧾 {p.asReceipt}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void chooseLocal(wp.name, 'kitchen')}
                    >
                      🍳 {p.asKitchen}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card stack">
          <h3 style={{ margin: 0 }}>🌐 {p.lanPrinters}</h3>
          <div className="toolbar">
            <TextField
              label={p.scanSubnet}
              value={subnet}
              placeholder={firstSubnet ?? '192.168.1'}
              onChange={(e) => setSubnet(e.target.value.trim())}
            />
            <Button busy={scanning} onClick={() => void scanLan()}>
              🔍 {p.scanNow}
            </Button>
          </div>

          {lanPrinters.length > 0 ? (
            <div className="variant-list">
              {lanPrinters.map((lp) => (
                <div
                  key={lp.host}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--color-bg-subtle, #f8f9fa)',
                    borderRadius: '6px',
                  }}
                >
                  <div>
                    <strong>
                      Termal printer ({lp.host}:{lp.port})
                    </strong>
                    <div className="muted small">
                      {p.pingSuccess.replace('{ms}', String(lp.latencyMs))}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onPick({
                        name: `Printer (${lp.host})`,
                        host: lp.host,
                        port: lp.port,
                        widthMm: 80,
                      });
                      onClose();
                    }}
                  >
                    + Qo‘shish
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">
              {scanning ? p.discovering : p.noPrintersFound}
            </p>
          )}
        </section>

        <div className="form-actions">
          <Button onClick={onClose}>{t.common.close}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function PrintersPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmDialog } = useConfirm();
  const stations = useStations();
  const branchId = me?.activeBranchId ?? '';
  // Oshxona and Ofitsiant: this device's printer, status and test print only.
  const manage = can(me, 'settings.manage') || can(me, 'pos.access');
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [pingStatus, setPingStatus] = useState<
    Record<string, { online: boolean; latencyMs?: number; error?: string }>
  >({});

  const printers = useQuery({
    queryKey: ['printers', branchId],
    queryFn: () =>
      api<{ printers: Printer[] }>(`/printers?branchId=${branchId}`).then(
        (data) => data.printers,
      ),
    enabled: !!branchId,
  });

  const jobs = useQuery({
    queryKey: ['printers', 'jobs', branchId],
    queryFn: () =>
      api<{ jobs: Job[] }>(`/print-jobs?branchId=${branchId}`).then(
        (data) => data.jobs,
      ),
    enabled: !!branchId && manage,
    refetchInterval: 5_000,
  });

  const action = async (
    fn: () => Promise<unknown>,
    message = t.common.saved,
  ) => {
    try {
      await fn();
      toast(message);
      await client.invalidateQueries({ queryKey: ['printers'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };

  const pingPrinter = async (printer: Printer) => {
    try {
      const res = await post<{
        online: boolean;
        latencyMs: number;
        error?: string;
      }>(`/printers/${printer.id}/ping`);
      setPingStatus((prev) => ({ ...prev, [printer.id]: res }));
      if (res.online) {
        toast(`${printer.name}: ${p.pingSuccess.replace('{ms}', String(res.latencyMs))}`);
      } else {
        toast(`${printer.name}: ${p.pingFail}`, 'error');
      }
    } catch {
      setPingStatus((prev) => ({
        ...prev,
        [printer.id]: { online: false, error: 'Xato' },
      }));
      toast(`${printer.name}: ${p.pingFail}`, 'error');
    }
  };

  const seedStandardDepartments = async () => {
    setSeeding(true);
    try {
      await post('/printers/seed-departments');
      toast(p.departmentsSeeded);
      await client.invalidateQueries({ queryKey: ['kitchen', 'stations'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setSeeding(false);
    }
  };

  const stationMap = new Map((stations.data ?? []).map((s) => [s.id, s.name]));
  const printerMap = new Map((printers.data ?? []).map((pr) => [pr.id, pr.name]));

  return (
    <>
      {confirmDialog}
      <PageHeader
        title={p.title}
        subtitle={p.subtitle}
        actions={
          <div className="toolbar">
            <TerminalPrinterButton />
            {manage && (
              <>
            <Button
              variant="ghost"
              size="sm"
              busy={seeding}
              onClick={seedStandardDepartments}
              title="Baliqxona, Kabobxona, Fastfud, Ichimliklar bo‘limlarini qo‘shish"
            >
              🏢 {p.seedDepartments}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiscovering(true)}
            >
              {p.discover}
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              + {p.add}
            </Button>
              </>
            )}
          </div>
        }
      />
      <p className="notice">{p.agentNote}</p>

      {printers.isPending ? (
        <LoadingState />
      ) : printers.error ? (
        <ErrorState
          error={printers.error}
          onRetry={() => void printers.refetch()}
        />
      ) : printers.data.length === 0 ? (
        <EmptyState title="Hozircha biriktirilgan printerlar yo‘q" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{p.department} / {p.kind}</th>
                <th>{p.host}</th>
                <th>{p.paper}</th>
                <th>{p.fallback}</th>
                <th>{t.common.status}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {printers.data.map((printer) => {
                const ping = pingStatus[printer.id];
                const deptName =
                  printer.kind === 'RECEIPT'
                    ? 'Kassa (Chek)'
                    : printer.stationId
                      ? stationMap.get(printer.stationId) ?? 'Bo‘lim'
                      : p.allDepartments;
                const backupName = printer.fallbackPrinterId
                  ? printerMap.get(printer.fallbackPrinterId) ?? 'Zaxira'
                  : '—';
                return (
                  <tr key={printer.id}>
                    <td>
                      <strong>{printer.name}</strong>
                    </td>
                    <td>
                      <Badge
                        tone={printer.kind === 'RECEIPT' ? 'accent' : 'neutral'}
                      >
                        {deptName}
                      </Badge>
                    </td>
                    <td>
                      <code>
                        {printer.host}:{printer.port}
                      </code>
                    </td>
                    <td>{printer.paperWidth ?? 80} mm</td>
                    <td className="small">{backupName}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {printer.isActive ? (
                          <Badge tone="success">{t.common.active}</Badge>
                        ) : (
                          <Badge>{t.common.inactive}</Badge>
                        )}
                        {ping && (
                          <span
                            style={{
                              fontSize: '0.8rem',
                              fontWeight: 600,
                              color: ping.online ? '#28a745' : '#dc3545',
                            }}
                          >
                            {ping.online ? `● ${ping.latencyMs}ms` : '✕ Oflayn'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void pingPrinter(printer)}
                        title={p.ping}
                      >
                        ⚡ {p.ping}
                      </Button>{' '}
                      <Button
                        size="sm"
                        onClick={() =>
                          void action(
                            () => post(`/printers/${printer.id}/test`),
                            p.testQueued,
                          )
                        }
                      >
                        {p.test}
                      </Button>{' '}
                      {manage && (
                        <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(printer)}
                      >
                        {t.common.edit}
                      </Button>{' '}
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (
                            await confirm(
                              p.removeConfirm.replace('{name}', printer.name),
                            )
                          )
                            void action(
                              () => del(`/printers/${printer.id}`),
                              p.removed,
                            );
                        }}
                      >
                        {p.remove}
                      </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {manage && <h2 className="section-title">{p.jobs}</h2>}
      {!manage ? null : jobs.data && jobs.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.orders.time}</th>
                <th>{p.title}</th>
                <th>{t.common.status}</th>
                <th>{p.attempts}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((job) => (
                <tr key={job.id}>
                  <td>{formatDateTime(job.createdAt)}</td>
                  <td>
                    {job.printer}
                    {job.purpose === 'UPDATE' && (
                      <small className="muted block">{p.updateTicket}</small>
                    )}
                    {job.fallback && (
                      <small className="muted block">{p.fallbackCopy}</small>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        job.status === 'SENT'
                          ? 'success'
                          : job.status === 'FAILED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {p.statuses[job.status]}
                    </Badge>
                    {job.lastError && (
                      <small className="muted block">{job.lastError}</small>
                    )}
                  </td>
                  <td>{job.attempts}</td>
                  <td className="right">
                    {job.status !== 'SENT' && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void action(() => post(`/print-jobs/${job.id}/retry`))
                        }
                      >
                        {p.retry}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}

      <Dialog
        open={editing !== null}
        title={editing === 'new' ? p.add : p.editTitle}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <PrinterForm
            printer={editing === 'new' ? null : editing}
            branchId={branchId}
            others={printers.data ?? []}
            onDone={async () => {
              setEditing(null);
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['printers'] });
            }}
          />
        )}
      </Dialog>

      {discovering && (
        <DiscoveryDialog
          onClose={() => setDiscovering(false)}
          onPick={(info) => {
            setEditing({
              id: '',
              name: info.name,
              kind: 'KITCHEN',
              stationId: null,
              fallbackPrinterId: null,
              paperWidth: info.widthMm,
              host: info.host,
              port: info.port,
              isActive: true,
            });
          }}
        />
      )}
    </>
  );
}
