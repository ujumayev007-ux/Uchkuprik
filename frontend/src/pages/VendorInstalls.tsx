import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, useToast } from '../components/ui';
import { t } from '../i18n';
import { formatDateTime } from '../lib/format';

const i = t.vendorInstalls;

export type Install = {
  installId: string;
  version: string;
  installedAt: string;
  firstSeen: string;
  lastSeen: string;
  license: { customer: string; expiresAt: string } | null;
  business: {
    name: string;
    phone: string | null;
    owner: string | null;
    registeredAt: string;
  } | null;
  paid: boolean;
  blocked: boolean;
  sameMachine: string[];
};

export type InstallsBridge = {
  installs: () => Promise<Install[]>;
  checkReports: () => Promise<{ checked: boolean; error?: string }>;
  blockInstall: (
    installId: string,
    blocked: boolean,
  ) => Promise<{ published?: boolean; error?: string }>;
};

const DAY = 86_400_000;

/** Every install that reported in: demos (with days left), paid ones and reinstalls. */
export function VendorInstalls({
  bridge,
  onLicense,
}: {
  bridge: InstallsBridge;
  onLicense: (install: Install) => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<Install[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void bridge.installs().then(setRows);
  }, [bridge]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : String(caught), 'error');
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <section className="card stack">
      <div className="toolbar">
        <h2 className="section-title">🖥 {i.title}</h2>
        <Button
          size="sm"
          busy={busy}
          onClick={() =>
            run(async () => {
              const result = await bridge.checkReports();
              if (result.error) toast(result.error, 'error');
            })
          }
        >
          {i.refresh}
        </Button>
      </div>
      <p className="muted small">{i.hint}</p>
      {rows.length === 0 ? (
        <EmptyState title={i.empty} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{i.business}</th>
                <th>{i.installId}</th>
                <th>{i.state}</th>
                <th>{i.lastSeen}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const demoLeft = Math.ceil(
                  (Date.parse(row.installedAt) + 14 * DAY - Date.now()) / DAY,
                );
                return (
                  <tr key={row.installId}>
                    <td>
                      <strong>{row.business?.name ?? i.notRegistered}</strong>
                      {row.business?.owner && (
                        <div className="small">👤 {row.business.owner}</div>
                      )}
                      {row.business?.phone && (
                        <div className="small">📞 {row.business.phone}</div>
                      )}
                    </td>
                    <td>
                      <code>{row.installId}</code>
                      <div className="small muted">v{row.version}</div>
                      {row.sameMachine.length > 0 && (
                        <div className="small">
                          <Badge tone="warning">
                            ⚠{' '}
                            {i.reinstall.replace(
                              '{n}',
                              String(row.sameMachine.length),
                            )}
                          </Badge>
                        </div>
                      )}
                    </td>
                    <td>
                      {row.blocked ? (
                        <Badge tone="danger">{i.blocked}</Badge>
                      ) : row.paid || row.license ? (
                        <Badge tone="success">
                          {i.paid}
                          {row.license ? ` · ${row.license.expiresAt}` : ''}
                        </Badge>
                      ) : (
                        <Badge tone={demoLeft > 0 ? 'accent' : 'danger'}>
                          {demoLeft > 0
                            ? i.demoLeft.replace('{n}', String(demoLeft))
                            : i.demoOver}
                        </Badge>
                      )}
                    </td>
                    <td className="small">{formatDateTime(row.lastSeen)}</td>
                    <td className="right">
                      <div className="toolbar">
                        {!row.paid && (
                          <Button size="sm" onClick={() => onLicense(row)}>
                            {i.giveLicense}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={row.blocked ? 'secondary' : 'danger'}
                          busy={busy}
                          onClick={() =>
                            run(async () => {
                              await bridge.blockInstall(
                                row.installId,
                                !row.blocked,
                              );
                              toast(row.blocked ? i.unblocked : i.blockedOk);
                            })
                          }
                        >
                          {row.blocked ? i.unblock : i.block}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
