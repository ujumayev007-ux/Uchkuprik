import { useQuery } from '@tanstack/react-query';
import { shellKind } from './shell';
import { api } from './api';

// Remote design and advertising as the screens see it (the server resolves the layers).

export const SKINS = [
  'classic',
  'premium',
  'blue',
  'emerald',
  'minimal',
  'luxury',
] as const;
export type Skin = (typeof SKINS)[number];
export type PanelKey = 'admin' | 'cashier' | 'waiter' | 'kitchen' | 'customer';
export type AdPanel = 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN' | 'CUSTOMER';

export type ResolvedDesign = {
  login: {
    skin: Skin;
    background: string | null;
    logo: string | null;
    welcome: string;
    accent: string | null;
  };
  panels: Record<PanelKey, { skin: Skin; loginSkin: Skin | null }>;
  splash: { title: string; subtitle: string; logo: string | null; skin: Skin };
};

export type AdDef = {
  id: string;
  kind: 'TEXT' | 'IMAGE' | 'VIDEO';
  format: 'FULLSCREEN' | 'POPUP' | 'BANNER';
  text: string | null;
  mediaId: string | null;
  panels: AdPanel[];
  durationSec: number;
  closable: boolean;
  autoCloseSec: number | null;
  startsAt: string | null;
  endsAt: string | null;
  everyMinutes: number;
  maxPerDay: number | null;
  priority: number;
  version: number;
};

export type LoginBranding = {
  v: string;
  login: ResolvedDesign['login'];
  panels: ResolvedDesign['panels'];
  splash: ResolvedDesign['splash'];
  ads?: AdDef[];
  serverTime?: string;
};

export type Branding = {
  v: string;
  design: ResolvedDesign;
  delegated: boolean;
  ads: AdDef[];
  serverTime: string;
};

export const SKIN_NAMES: Record<Skin, string> = {
  classic: 'Klassik Fast Food',
  premium: 'Premium qora',
  blue: 'Zamonaviy ko‘k',
  emerald: 'Zumrad yashil',
  minimal: 'Minimal yorug‘',
  luxury: 'Hashamatli restoran',
};

export const mediaUrl = (id: string) => `/api/branding/media/${id}`;

/** Applies a skin to the whole page ("classic" is the original look: no attribute). */
export function applySkin(skin: Skin | null | undefined) {
  const root = document.documentElement;
  if (!skin || skin === 'classic') delete root.dataset.skin;
  else root.dataset.skin = skin;
}

// ---- which application shell hosts this page -------------------------------------
export function loginPanel(): PanelKey {
  const kind = shellKind();
  if (kind === 'admin') return 'admin';
  if (kind === 'cashier') return 'cashier';
  if (kind === 'waiter') return 'waiter';
  if (kind === 'kitchen') return 'kitchen';
  if (kind === 'tv') return 'customer';
  if ((window as unknown as { FastFoodAndroid?: unknown }).FastFoodAndroid)
    return 'waiter';
  if ('fastfoodDesktop' in window) return 'cashier';
  return 'admin';
}

export function panelOfPath(pathname: string): PanelKey {
  if (pathname.startsWith('/kassa')) return 'cashier';
  if (pathname.startsWith('/ofitsiant')) return 'waiter';
  if (pathname.startsWith('/oshxona')) return 'kitchen';
  if (pathname.startsWith('/navbat')) return 'customer';
  return 'admin';
}

export const adPanelOf = (panel: PanelKey): AdPanel =>
  panel.toUpperCase() as AdPanel;

// ---- offline copies (the design must survive restarts and a missing network) -----
const loginKey = (tenant: string) => `ff-branding-login:${tenant}`;
function readCache<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable: the design is then fetched every time. */
  }
}

/** Sign-in design for a business code (public; cached for the next start). */
export function useLoginBranding(tenant: string) {
  const code = tenant.trim().toLowerCase();
  return useQuery({
    queryKey: ['branding', 'login', code],
    queryFn: async () => {
      const value = await api<LoginBranding>(
        `/branding/login${code ? `?tenant=${encodeURIComponent(code)}` : ''}`,
      );
      writeCache(loginKey(code), value);
      return value;
    },
    ...(readCache<LoginBranding>(loginKey(code))
      ? {
          initialData: readCache<LoginBranding>(loginKey(code))!,
          // The device copy is shown at once but counts as stale: it is refreshed right away.
          initialDataUpdatedAt: 0,
        }
      : {}),
    staleTime: 30_000,
    retry: 1,
  });
}

/** Signed-in design and advertisements (refetched on `branding.changed`). */
export function useBranding(enabled = true) {
  return useQuery({
    queryKey: ['branding', 'me'],
    queryFn: async () => {
      const value = await api<Branding>('/branding');
      writeCache('ff-branding-me', value);
      return value;
    },
    enabled,
    ...(readCache<Branding>('ff-branding-me')
      ? {
          // Kept (not dropped) when the server cannot be reached: offline display.
          initialData: readCache<Branding>('ff-branding-me')!,
          initialDataUpdatedAt: 0,
        }
      : {}),
    staleTime: 60_000,
    retry: 1,
  });
}

/** Last sign-in design seen on this device (applied before the network answers). */
export function cachedLoginSkin(tenant: string): Skin | null {
  return (
    readCache<LoginBranding>(loginKey(tenant.trim().toLowerCase()))?.login
      .skin ?? null
  );
}
