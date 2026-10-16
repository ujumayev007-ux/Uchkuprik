import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTheme } from '../../components/ui';
import { t, text } from '../../i18n';
import {
  applySkin,
  loginPanel,
  mediaUrl,
  useLoginBranding,
  type Skin,
} from '../../lib/branding';

const TENANT_KEY = 'ff-last-tenant';

function rememberedTenant() {
  try {
    return localStorage.getItem(TENANT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Readable text colour for a custom accent colour chosen by the Owner. */
function onColor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#14110a' : '#ffffff';
}

export function AuthLayout({
  title,
  subtitle,
  children,
  wide = false,
  tenant,
}: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  wide?: boolean;
  // The business code typed so far: the design may differ per restaurant.
  tenant?: string;
}) {
  const theme = useTheme();
  // The design follows the typed business code once typing pauses.
  const [code, setCode] = useState(tenant ?? rememberedTenant());
  useEffect(() => {
    const timer = setTimeout(() => setCode(tenant ?? rememberedTenant()), 600);
    return () => clearTimeout(timer);
  }, [tenant]);
  const branding = useLoginBranding(code);
  const data = branding.data;
  const panel = loginPanel();
  const skin: Skin =
    data?.panels[panel].loginSkin ?? data?.login.skin ?? 'classic';
  useEffect(() => {
    applySkin(skin);
    return () => applySkin(null);
  }, [skin]);
  const accent = data?.login.accent ?? null;
  const background = data?.login.background ?? null;
  const style = {
    ...(background ? { '--auth-bg': `url(${mediaUrl(background)})` } : {}),
    ...(accent
      ? {
          '--accent': accent,
          '--accent-soft': `color-mix(in srgb, ${accent} 16%, var(--surface))`,
          '--on-accent': onColor(accent),
        }
      : {}),
  } as CSSProperties;
  return (
    <div
      className={`auth-page ${background ? 'has-bg' : ''}`}
      data-login-skin={skin}
      style={style}
    >
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
        {data?.login.logo && (
          <img className="auth-logo" src={mediaUrl(data.login.logo)} alt="" />
        )}
        <h1>{title}</h1>
        {data?.login.welcome && (
          <p className="auth-welcome">{data.login.welcome}</p>
        )}
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </main>
    </div>
  );
}
