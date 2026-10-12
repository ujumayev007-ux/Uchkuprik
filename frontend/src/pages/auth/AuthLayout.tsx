import type { ReactNode } from 'react';
import { useTheme } from '../../components/ui';
import { t, text } from '../../i18n';

export function AuthLayout({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  wide?: boolean;
}) {
  const theme = useTheme();
  return (
    <div className="auth-page">
      <header className="auth-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            F<span>•</span>
          </span>
          <span>
            <strong>{text.brand}</strong>
            <small>{text.product}</small>
          </span>
        </span>
        <button
          className="icon-button"
          onClick={theme.toggle}
          aria-label={theme.dark ? t.nav.lightTheme : t.nav.darkTheme}
        >
          {theme.dark ? '☀' : '☾'}
        </button>
      </header>
      <main className={`auth-card ${wide ? 'auth-card-wide' : ''}`}>
        <h1>{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </main>
    </div>
  );
}
