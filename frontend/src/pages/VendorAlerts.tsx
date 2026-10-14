import { useState } from 'react';
import { Badge, Button, TextField, useToast } from '../components/ui';
import { t } from '../i18n';

const a = t.vendorAlerts;

export type AlertsBridge = {
  blockInstall: (
    installId: string,
    blocked: boolean,
  ) => Promise<{ published?: boolean; error?: string }>;
  telegram: (
    token?: string,
  ) => Promise<{ connected: boolean; bot: string | null }>;
  telegramOff: () => Promise<boolean>;
};

const message = (caught: unknown) =>
  (caught instanceof Error ? caught.message : String(caught)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

/** Vendor's Telegram bot (payment reminders) and blocking any install by its ID. */
export function VendorAlerts({
  bridge,
  telegram,
  blockedInstalls,
  onChange,
}: {
  bridge: AlertsBridge;
  telegram: { connected: boolean; bot: string | null } | undefined;
  blockedInstalls: string[];
  onChange: () => void;
}) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [installId, setInstallId] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast(message(caught), 'error');
    } finally {
      setBusy(false);
      onChange();
    }
  };
  const connect = (value?: string) =>
    run(async () => {
      const result = await bridge.telegram(value);
      setToken('');
      toast(
        result.connected
          ? a.connected
          : a.sendStart.replace('{bot}', result.bot ? `@${result.bot}` : 'bot'),
        result.connected ? undefined : 'error',
      );
    });

  return (
    <>
      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">📨 {a.telegramTitle}</h2>
          <Badge tone={telegram?.connected ? 'success' : 'warning'}>
            {telegram?.connected
              ? `${a.on}${telegram.bot ? ` · @${telegram.bot}` : ''}`
              : a.off}
          </Badge>
        </div>
        <p className="sop-body small">{a.telegramHow}</p>
        {telegram?.bot && !telegram.connected && (
          <div className="form-actions">
            <Button busy={busy} onClick={() => connect()}>
              {a.checkStart}
            </Button>
          </div>
        )}
        <TextField
          label={a.botToken}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="form-actions">
          {telegram?.bot && (
            <Button
              variant="ghost"
              busy={busy}
              onClick={() =>
                run(async () => {
                  await bridge.telegramOff();
                  toast(a.disconnected);
                })
              }
            >
              {a.disconnect}
            </Button>
          )}
          <Button
            variant="primary"
            busy={busy}
            disabled={!token.trim()}
            onClick={() => connect(token)}
          >
            {a.connect}
          </Button>
        </div>
      </section>

      <section className="card stack">
        <h2 className="section-title">🚫 {a.blockTitle}</h2>
        <p className="sop-body small">{a.blockHow}</p>
        <TextField
          label={a.installId}
          placeholder="FF-XXXX-XXXX-XXXX"
          value={installId}
          onChange={(event) => setInstallId(event.target.value.toUpperCase())}
        />
        <div className="form-actions">
          <Button
            variant="danger"
            busy={busy}
            disabled={!installId.trim()}
            onClick={() =>
              run(async () => {
                const result = await bridge.blockInstall(installId, true);
                setInstallId('');
                toast(
                  result.error ? `${a.blocked} (${result.error})` : a.blocked,
                );
              })
            }
          >
            {a.block}
          </Button>
        </div>
        {blockedInstalls.length > 0 && (
          <ul className="list">
            {blockedInstalls.map((id) => (
              <li key={id} className="toolbar">
                <code>{id}</code>
                <Button
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    run(async () => {
                      await bridge.blockInstall(id, false);
                      toast(a.unblocked);
                    })
                  }
                >
                  {a.unblock}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
