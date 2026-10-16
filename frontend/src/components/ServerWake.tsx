import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { t } from '../i18n';
import { pingHealth, reportOk, useServerDown } from '../lib/serverState';

/**
 * Covers the screen with the application's own branded "reconnecting" page while the
 * server is unreachable (a host waking from sleep, a restart, a dropped network), and
 * reconnects by itself. No hosting name or address is ever shown.
 */
export function ServerWake() {
  const down = useServerDown();
  const client = useQueryClient();
  useEffect(() => {
    if (!down) return;
    let stopped = false;
    const attempt = async () => {
      if (await pingHealth()) {
        if (stopped) return;
        reportOk();
        void client.invalidateQueries();
      }
    };
    const timer = setInterval(() => void attempt(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [down, client]);
  if (!down) return null;
  return (
    <div className="wake-overlay" role="alert" aria-live="polite">
      <div>
        <div className="splash-mark">F</div>
        <h1 style={{ letterSpacing: 3, margin: 0 }}>FAST FOOD</h1>
        <p className="muted">{t.wake.title}</p>
        <p className="muted small" style={{ maxWidth: 360 }}>
          {t.wake.text}
        </p>
        <span className="splash-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div style={{ marginTop: 18 }}>
          <button
            className="btn btn-secondary btn-md"
            type="button"
            onClick={async () => {
              if (await pingHealth()) {
                reportOk();
                void client.invalidateQueries();
              }
            }}
          >
            {t.wake.retry}
          </button>
        </div>
      </div>
    </div>
  );
}
