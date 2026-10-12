import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getReadiness } from '../api';
import { useTheme } from '../components/ui';
import { defaultLocale, t, text } from '../i18n';

type Status = 'loading' | 'ready' | 'unavailable' | 'offline';

export function StatusPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { dark, toggle } = useTheme();
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let active = true;
    pending.current = true;
    void getReadiness(controller.signal)
      .then((result) => {
        if (active) setStatus(result);
      })
      .catch(() => {
        if (active) setStatus('offline');
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) {
          pending.current = false;
          setCheckedAt(new Date());
        }
      });
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  const description = {
    loading: text.loadingDescription,
    ready: text.readyDescription,
    unavailable: text.unavailableDescription,
    offline: text.offlineDescription,
  }[status];

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label={text.brand}>
          <span className="brand-mark" aria-hidden="true">
            F<span>•</span>
          </span>
          <span>
            <strong>{text.brand}</strong>
            <small>{text.product}</small>
          </span>
        </Link>
        <button
          className="theme-button"
          onClick={toggle}
          aria-label={dark ? text.lightTheme : text.darkTheme}
        >
          <span aria-hidden="true">{dark ? '☀' : '☾'}</span>
          <span>{dark ? text.lightTheme : text.darkTheme}</span>
        </button>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <span className="eyebrow">
            <span aria-hidden="true" />
            {text.eyebrow}
          </span>
          <h1 id="page-title">
            {text.title}
            <br />
            <em>{text.titleAccent}</em>
          </h1>
          <p>{text.description}</p>
        </section>

        <section className="status-card" aria-labelledby="status-heading">
          <div className="card-header">
            <h2 id="status-heading">{text.statusLabel}</h2>
            <span className="phase-badge">{text.phase}</span>
          </div>
          <div
            className={`connection-state ${status}`}
            role="status"
            aria-live="polite"
            aria-busy={status === 'loading'}
          >
            <span className="status-icon" aria-hidden="true">
              {status === 'ready' ? '✓' : status === 'loading' ? '↻' : '!'}
            </span>
            <h3>{text[status]}</h3>
            <p>{description}</p>
          </div>
          <button
            className="primary-button"
            disabled={status === 'loading'}
            onClick={() => {
              if (pending.current) return;
              setStatus('loading');
              setAttempt((value) => value + 1);
            }}
          >
            <span aria-hidden="true">↻</span>
            {text.retry}
          </button>
          {checkedAt && (
            <p className="last-checked">
              {text.checkedAt}:{' '}
              <time dateTime={checkedAt.toISOString()}>
                {new Intl.DateTimeFormat(defaultLocale, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }).format(checkedAt)}
              </time>
            </p>
          )}
        </section>
        <p className="phase-note">
          <span aria-hidden="true">◈</span>
          {text.phaseDescription}
        </p>
      </main>
      <footer>
        <span>{text.brand}</span>
        <p>{text.footer}</p>
        <Link className="locale" to="/kirish">
          {t.auth.submit}
        </Link>
      </footer>
    </div>
  );
}
