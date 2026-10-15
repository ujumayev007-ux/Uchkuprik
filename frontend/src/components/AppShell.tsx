import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { LiveClock } from './LiveClock';
import { AppUpdateBanner } from './AppUpdateBanner';
import { can, hasFeature, meKey, useMe, type Me } from '../auth/session';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import {
  appVersion,
  applyUpdate,
  promptInstall,
  toggleFullscreen,
  usePwa,
} from '../lib/pwa';
import { useRealtime } from '../lib/realtime';
import { WalkinAlerts } from './WalkinAlerts';
import {
  LicenseLock,
  licenseBlocks,
  useLicense,
  type License,
} from '../pages/LicensePage';
import { isVendorComputer } from '../pages/VendorPage';
import { PendingOrders } from './PendingOrders';
import { StaffAnnouncer, VoiceButton } from './StaffAnnouncer';
import { ReauthDialog } from './ReauthDialog';
import { useTheme, useToast } from './ui';

export type Branch = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  currency: string;
  isActive: boolean;
  brandId: string | null;
};

type NavItem = {
  to: string;
  label: string;
  icon: string;
  visible: (me: Me) => boolean;
  // Opens in its own window (e.g. the queue TV screen).
  popup?: boolean;
};

/** Bridge exposed by the desktop (EXE) app; absent in browsers and the APK. */
type DesktopBridge = {
  openAnyDesk: () => Promise<{ installed: boolean; id: string | null }>;
};
export const desktop = (
  window as unknown as { fastfoodDesktop?: DesktopBridge }
).fastfoodDesktop;

/** Front-line staff (cashier, waiter, kitchen) get a compact panel without the admin sidebar. */
export const isFrontLine = (me: Me) =>
  me.tenantKind === 'BUSINESS' &&
  !can(me, 'reports.view') &&
  !can(me, 'settings.manage') &&
  !can(me, 'users.view');

// Items appear only when the server-issued permissions allow them. Hiding a link is a
// convenience; every endpoint still enforces authorization on the server.
export const navItems: NavItem[] = [
  {
    to: '/',
    label: t.nav.dashboard,
    icon: '◧',
    visible: (me) => me.tenantKind === 'BUSINESS',
  },
  {
    to: '/kassa',
    label: t.nav.pos,
    icon: '⊞',
    visible: (me) => can(me, 'pos.access'),
  },
  {
    to: '/buyurtmalar',
    label: t.nav.orders,
    icon: '☰',
    visible: (me) => can(me, 'orders.view'),
  },
  {
    to: '/oshxona',
    label: t.nav.kitchen,
    icon: '♨',
    visible: (me) => can(me, 'kitchen.access'),
  },
  {
    to: '/navbat',
    label: t.nav.queue,
    icon: '▣',
    visible: (me) => can(me, 'orders.view') || can(me, 'kitchen.access'),
    popup: true,
  },
  {
    to: '/ofitsiant',
    label: t.nav.waiter,
    icon: '▦',
    visible: (me) => can(me, 'orders.create'),
  },
  {
    to: '/smena',
    label: t.nav.shift,
    icon: '◴',
    visible: (me) => can(me, 'shifts.manage'),
  },
  {
    to: '/hisobotlar',
    label: t.nav.reports,
    icon: '▤',
    visible: (me) => can(me, 'reports.view'),
  },
  {
    to: '/tahlil',
    label: t.nav.insights,
    icon: '↗',
    visible: (me) => can(me, 'reports.view'),
  },
  {
    to: '/ombor',
    label: t.nav.warehouse,
    icon: '▥',
    visible: (me) =>
      hasFeature(me, 'inventory') &&
      (can(me, 'inventory.view') || can(me, 'purchasing.manage')),
  },
  {
    to: '/yetkazish',
    label: t.delivery.title,
    icon: '➤',
    visible: (me) => hasFeature(me, 'delivery') && can(me, 'delivery.manage'),
  },
  {
    to: '/kuryer',
    label: t.delivery.courierTitle,
    icon: '➤',
    visible: (me) =>
      hasFeature(me, 'delivery') &&
      can(me, 'delivery.courier') &&
      !can(me, 'delivery.manage'),
  },
  {
    to: '/mijozlar',
    label: t.crm.title,
    icon: '☺',
    visible: (me) => can(me, 'customers.view'),
  },
  {
    to: '/operatsiyalar',
    label: t.nav.operations,
    icon: '✓',
    visible: (me) =>
      hasFeature(me, 'operations') &&
      (can(me, 'operations.perform') || can(me, 'operations.manage')),
  },
  {
    to: '/uskunalar',
    label: t.nav.assets,
    icon: '⚙',
    visible: (me) =>
      hasFeature(me, 'operations') &&
      (can(me, 'assets.manage') ||
        can(me, 'operations.manage') ||
        can(me, 'operations.perform')),
  },
  {
    to: '/oqitish',
    label: t.nav.training,
    icon: '✎',
    visible: (me) => hasFeature(me, 'operations'),
  },
  {
    to: '/tasdiqlar',
    label: t.nav.approvals,
    icon: '✔',
    visible: (me) =>
      hasFeature(me, 'operations') && can(me, 'approvals.decide'),
  },
  {
    to: '/ish-vaqti',
    label: t.hr.attendanceTitle,
    icon: '◷',
    visible: (me) => me.tenantKind === 'BUSINESS',
  },
  {
    to: '/ish-haqi',
    label: t.hr.payrollTitle,
    icon: '₴',
    visible: (me) =>
      hasFeature(me, 'hr') && (can(me, 'hr.manage') || can(me, 'finance.view')),
  },
  {
    to: '/moliya',
    label: t.finance.title,
    icon: '∑',
    visible: (me) => hasFeature(me, 'finance') && can(me, 'finance.view'),
  },
  {
    to: '/menyu',
    label: t.nav.menu,
    icon: '☷',
    visible: (me) => can(me, 'menu.view'),
  },
  {
    to: '/zallar',
    label: t.nav.floor,
    icon: '▦',
    visible: (me) => can(me, 'tables.manage'),
  },
  {
    to: '/xodimlar',
    label: t.nav.staff,
    icon: '◉',
    visible: (me) => can(me, 'users.view'),
  },
  {
    to: '/rollar',
    label: t.nav.roles,
    icon: '⚿',
    visible: (me) => can(me, 'users.view'),
  },
  {
    to: '/brendlar',
    label: t.nav.brands,
    icon: '❖',
    visible: (me) =>
      hasFeature(me, 'multi_brand') &&
      (can(me, 'brands.manage') || can(me, 'reports.view')),
  },
  {
    to: '/franshiza',
    label: t.nav.franchise,
    icon: '⚑',
    visible: (me) => hasFeature(me, 'franchise') && can(me, 'franchise.manage'),
  },
  {
    to: '/portal',
    label: t.nav.franchisePortal,
    icon: '⚑',
    visible: (me) =>
      hasFeature(me, 'franchise') &&
      can(me, 'franchise.portal') &&
      !can(me, 'franchise.manage'),
  },
  {
    to: '/filiallar',
    label: t.nav.branches,
    icon: '⌂',
    visible: (me) => can(me, 'branches.view') || can(me, 'branches.manage'),
  },
  {
    to: '/qurilmalar',
    label: t.nav.devices,
    icon: '▣',
    visible: (me) => can(me, 'devices.manage'),
  },
  {
    to: '/sozlamalar',
    label: t.nav.settings,
    icon: '⚙',
    visible: (me) => can(me, 'settings.manage'),
  },
  {
    to: '/printerlar',
    label: t.nav.printers,
    icon: '⎙',
    visible: (me) =>
      hasFeature(me, 'kitchen_printing') && can(me, 'settings.manage'),
  },
  {
    to: '/tolovlar',
    label: t.nav.payments,
    icon: '₪',
    visible: (me) =>
      hasFeature(me, 'online_payments') && can(me, 'settings.manage'),
  },
  {
    to: '/obuna',
    label: t.nav.billing,
    icon: '◇',
    visible: (me) => can(me, 'settings.manage'),
  },
  {
    to: '/bildirishnomalar',
    label: t.nav.notifications,
    icon: '✉',
    visible: (me) => can(me, 'notifications.manage'),
  },
  {
    to: '/integratsiyalar',
    label: t.nav.developer,
    icon: '⌘',
    visible: (me) =>
      hasFeature(me, 'developer_api') && can(me, 'developer.manage'),
  },
  {
    to: '/qr-tolov',
    label: t.nav.qrPay,
    icon: '▩',
    visible: (me) => can(me, 'settings.manage'),
  },
  {
    to: '/chek-dizayni',
    label: t.nav.receiptDesign,
    icon: '🧾',
    visible: (me) => can(me, 'settings.manage'),
  },
  {
    to: '/sotuvchi',
    label: t.nav.vendor,
    icon: '★',
    visible: () => isVendorComputer(),
  },
  {
    to: '/litsenziya',
    label: t.nav.license,
    icon: '🔑',
    visible: (me) => me.tenantKind === 'BUSINESS' && !!desktop,
  },
  {
    to: '/audit',
    label: t.nav.audit,
    icon: '☰',
    visible: (me) => can(me, 'audit.view'),
  },
  {
    to: '/platforma/bizneslar',
    label: t.nav.tenants,
    icon: '◈',
    visible: (me) => me.isPlatformAdmin,
  },
  {
    to: '/platforma/obunalar',
    label: t.nav.platformBilling,
    icon: '◇',
    visible: (me) => me.isPlatformAdmin,
  },
  {
    to: '/platforma/audit',
    label: t.nav.platformAudit,
    icon: '☰',
    visible: (me) => me.isPlatformAdmin,
  },
  {
    to: '/hisob',
    label: t.nav.account,
    icon: '☺',
    visible: (me) => me.authMethod === 'PASSWORD',
  },
];

export function useBranches(enabled = true) {
  return useQuery({
    queryKey: ['branches'],
    queryFn: () =>
      api<{ branches: Branch[] }>('/branches').then((data) => data.branches),
    enabled,
  });
}

function BranchSwitcher({ me }: { me: Me }) {
  const branches = useBranches(me.tenantKind === 'BUSINESS');
  const client = useQueryClient();
  const toast = useToast();
  const active = branches.data?.filter((branch) => branch.isActive) ?? [];
  if (me.tenantKind !== 'BUSINESS' || active.length === 0) return null;
  if (me.authMethod === 'PIN') {
    const branch = active.find((item) => item.id === me.activeBranchId);
    return <span className="branch-pill">⌂ {branch?.name ?? '—'}</span>;
  }
  return (
    <label className="branch-select">
      <span className="sr-only">{t.nav.branch}</span>
      <select
        value={me.activeBranchId ?? ''}
        onChange={async (event) => {
          try {
            await post('/auth/branch', { branchId: event.target.value });
            await client.invalidateQueries();
          } catch {
            toast(t.common.errorTitle, 'error');
          }
        }}
      >
        {!me.activeBranchId && <option value="">{t.nav.selectBranch}</option>}
        {active.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Trial and payment reminders for tenant managers. */
function BillingBanner({ me }: { me: Me }) {
  const billing = me.billing;
  if (!billing) return null;
  let text: string | null = null;
  let tone = 'info';
  if (billing.status === 'PAST_DUE' || billing.status === 'SUSPENDED') {
    text = t.billing.pastDueBanner;
    tone = 'danger';
  } else if (billing.openInvoice) {
    text = t.billing.dueBanner
      .replace('{amount}', formatMoney(billing.openInvoice.amount))
      .replace('{date}', formatDateTime(billing.openInvoice.dueDate));
    tone = 'warning';
  } else if (billing.trialDaysLeft !== null && billing.trialDaysLeft <= 7)
    text = t.billing.trialBanner.replace(
      '{days}',
      String(billing.trialDaysLeft),
    );
  if (!text) return null;
  return (
    <div className={`billing-banner ${tone}`} role="status">
      <span>{text}</span>
      <NavLink to="/obuna" className="btn btn-sm btn-secondary">
        {t.billing.openBilling}
      </NavLink>
    </div>
  );
}

/** Reports this terminal's app version and liveness for the device fleet view. */
function useDeviceHeartbeat() {
  useEffect(() => {
    const beat = () =>
      void post('/devices/heartbeat', { version: appVersion }).catch(
        () => undefined,
      );
    beat();
    const timer = setInterval(beat, 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
}

/** Queue/TV screens open in their own window so the main app stays usable. */
function openPopup(path: string) {
  window.open(path, 'fastfood-tv', 'popup,width=1280,height=760');
}

/** Offline / expired / blocked state decided by the central control (server-enforced). */
function ControlBanner({ me }: { me: Me }) {
  const control = me.control;
  if (!control || control.mode === 'ONLINE' || control.mode === 'UNLINKED')
    return null;
  const b = t.control.banner;
  let text: string;
  if (control.mode === 'OFFLINE')
    text = b.OFFLINE.replace(
      '{until}',
      control.offlineUntil
        ? new Date(control.offlineUntil).toLocaleString('uz-UZ')
        : '—',
    );
  else if (control.mode === 'BLOCKED') text = b.BLOCKED;
  else text = control.reason === 'CLOCK' ? b.CLOCK : b.EXPIRED;
  return (
    <div
      className={`billing-banner ${control.mode === 'OFFLINE' ? 'warning' : 'danger'}`}
      role="status"
    >
      <span>{text}</span>
    </div>
  );
}

function LicenseBanner({ license }: { license: License | undefined }) {
  if (!license?.selfHosted) return null;
  if (license.status !== 'EXPIRING' && license.status !== 'TRIAL') return null;
  const text = (
    license.status === 'TRIAL' ? t.license.trialBanner : t.license.banner
  ).replace('{days}', String(license.daysLeft ?? 0));
  return (
    <div className="billing-banner warning" role="status">
      <span>{text}</span>
      <NavLink to="/litsenziya" className="btn btn-sm btn-secondary">
        {t.license.title}
      </NavLink>
    </div>
  );
}

function UpdateBanner() {
  const pwa = usePwa();
  if (!pwa.updateReady) return null;
  return (
    <div className="billing-banner info" role="status">
      <span>{t.pwa.updateReady}</span>
      <button className="btn btn-sm btn-primary" onClick={applyUpdate}>
        {t.pwa.update}
      </button>
    </div>
  );
}

export function AppShell() {
  const { data: me } = useMe();
  const theme = useTheme();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const pwa = usePwa();
  const location = useLocation();
  const toast = useToast();
  const license = useLicense(me?.tenantKind === 'BUSINESS');
  useDeviceHeartbeat();
  const online = useRealtime(
    me?.tenantKind === 'BUSINESS' ? me.activeBranchId : null,
  );
  if (!me) return null;
  // Menus the vendor switched off for this install (via the licence).
  const hidden = license.data?.hiddenMenus ?? [];
  const items = navItems.filter(
    (item) => item.visible(me) && !hidden.includes(item.to),
  );
  const menuDisabled = hidden.some(
    (path) =>
      location.pathname === path || location.pathname.startsWith(`${path}/`),
  );
  const compact = isFrontLine(me);

  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    client.setQueryData(meKey, null);
    client.clear();
    navigate(me.authMethod === 'PIN' ? '/pin' : '/kirish', { replace: true });
  };

  return (
    <div
      className={`shell ${menuOpen ? 'menu-open' : ''} ${compact ? 'compact' : ''}`}
    >
      <aside className="sidebar" aria-label={t.nav.openMenu}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            F<span>•</span>
          </span>
          <span>
            <strong>FAST FOOD</strong>
            <small>{me.tenant.name}</small>
          </span>
        </div>
        <nav>
          {items.map((item) =>
            item.popup ? (
              <a
                key={item.to}
                href={item.to}
                className="nav-link"
                onClick={(event) => {
                  event.preventDefault();
                  setMenuOpen(false);
                  openPopup(item.to);
                }}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label} ↗
              </a>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `nav-link ${isActive ? 'active' : ''}`
                }
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-footer">
          <NavLink to="/holat" className="nav-link subtle">
            <span aria-hidden="true">◎</span>
            {t.nav.systemStatus}
          </NavLink>
        </div>
      </aside>
      <div className="shell-main">
        <header className="shell-topbar">
          <button
            className="icon-button menu-toggle"
            aria-label={t.nav.openMenu}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            ☰
          </button>
          <BranchSwitcher me={me} />
          <div className="topbar-spacer" />
          <LiveClock />
          {me.tenantKind === 'BUSINESS' && can(me, 'orders.view') && (
            <>
              <VoiceButton />
              <StaffAnnouncer />
            </>
          )}
          {me.tenantKind === 'BUSINESS' && (
            <span
              className={`live-dot ${online ? 'on' : 'off'}`}
              role="status"
              title={online ? t.live.online : t.live.offline}
              aria-label={online ? t.live.online : t.live.offline}
            />
          )}
          {desktop && (
            <button
              className="icon-button topbar-optional"
              aria-label={t.remote.anydesk}
              title={t.remote.anydesk}
              onClick={async () => {
                const result = await desktop!.openAnyDesk();
                toast(
                  !result.installed
                    ? t.remote.notInstalled
                    : result.id
                      ? t.remote.yourId.replace('{id}', result.id)
                      : t.remote.opened,
                );
              }}
            >
              🖥
            </button>
          )}
          {pwa.installable && (
            <button
              className="btn btn-ghost btn-sm topbar-optional"
              onClick={() => void promptInstall()}
            >
              {t.pwa.install}
            </button>
          )}
          {document.fullscreenEnabled && (
            <button
              className="icon-button topbar-optional"
              onClick={() => void toggleFullscreen()}
              aria-label={t.pwa.fullscreen}
              title={t.pwa.fullscreen}
            >
              ⛶
            </button>
          )}
          <button
            className="icon-button"
            onClick={theme.toggle}
            aria-label={theme.dark ? t.nav.lightTheme : t.nav.darkTheme}
            title={theme.dark ? t.nav.lightTheme : t.nav.darkTheme}
          >
            {theme.dark ? '☀' : '☾'}
          </button>
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">
              {me.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-name">{me.displayName}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            {t.nav.logout}
          </button>
        </header>
        <main className="shell-content" id="main">
          {can(me, 'orders.approve') && me.activeBranchId && (
            <PendingOrders branchId={me.activeBranchId} />
          )}
          {compact && (
            <nav className="compact-nav" aria-label={t.nav.openMenu}>
              {items.map((item) =>
                item.popup ? (
                  <a
                    key={item.to}
                    href={item.to}
                    className="compact-link"
                    onClick={(event) => {
                      event.preventDefault();
                      openPopup(item.to);
                    }}
                  >
                    {item.icon} {item.label}
                  </a>
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `compact-link ${isActive ? 'active' : ''}`
                    }
                  >
                    {item.icon} {item.label}
                  </NavLink>
                ),
              )}
            </nav>
          )}
          <UpdateBanner />
          <LicenseBanner license={license.data} />
          <AppUpdateBanner />
          <BillingBanner me={me} />
          <ControlBanner me={me} />
          <WalkinAlerts />
          {licenseBlocks(license.data) ? (
            <LicenseLock license={license.data!} />
          ) : menuDisabled ? (
            <div className="state">
              <h1>{t.vendor.menuOffTitle}</h1>
              <p>{t.vendor.menuOffText}</p>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
      {menuOpen && (
        <button
          className="scrim"
          aria-label={t.common.close}
          onClick={() => setMenuOpen(false)}
        />
      )}
      <ReauthDialog />
    </div>
  );
}
