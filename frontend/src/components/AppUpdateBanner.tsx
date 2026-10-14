import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { appVersion } from '../lib/pwa';
import { Button, useConfirm, useToast } from './ui';

const u = t.updates;

type DesktopUpdates = {
  checkUpdate?: () => Promise<{
    current: string;
    update: { version: string; notes: string; size: number | null } | null;
  }>;
  installUpdate?: () => Promise<{ ok: boolean; version: string }>;
};

const bridge = (window as unknown as { fastfoodDesktop?: DesktopUpdates })
  .fastfoodDesktop;

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

// Version of the phone app shell, which the APK adds to its user agent.
const androidVersion = /FastFoodAndroid\/(\d+\.\d+\.\d+)/.exec(
  navigator.userAgent,
)?.[1];

/** "New version available" bar: installs on the computer, or offers the new APK on phones. */
export function AppUpdateBanner() {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [update, setUpdate] = useState<{
    version: string;
    notes: string;
    size: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge?.checkUpdate) return;
    const check = () =>
      void bridge.checkUpdate!()
        .then((result) => setUpdate(result.update))
        .catch(() => undefined);
    const first = setTimeout(check, 15_000);
    const timer = setInterval(check, 60 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  if (androidVersion && newer(appVersion, androidVersion))
    return (
      <div className="billing-banner info" role="status">
        <span>📱 {u.phone.replace('{version}', appVersion)}</span>
        <a className="btn btn-primary btn-sm" href="/downloads/FastFood.apk">
          {u.downloadApk}
        </a>
      </div>
    );
  if (!update) return null;
  return (
    <div className="billing-banner info" role="status">
      <span>
        ⬆ {u.available.replace('{version}', update.version)}
        {update.notes ? ` — ${update.notes}` : ''}
      </span>
      <Button
        size="sm"
        variant="primary"
        busy={busy}
        onClick={async () => {
          if (
            !(await confirm(
              `${u.confirmTitle.replace('{version}', update.version)} ${u.confirmText}`,
            ))
          )
            return;
          setBusy(true);
          toast(u.downloading);
          try {
            await bridge!.installUpdate!();
          } catch (caught) {
            toast(
              (caught instanceof Error
                ? caught.message
                : String(caught)
              ).replace(
                /^Error invoking remote method '[^']+': (Error: )?/,
                '',
              ),
              'error',
            );
            setBusy(false);
          }
        }}
      >
        {u.install}
      </Button>
      {element}
    </div>
  );
}
