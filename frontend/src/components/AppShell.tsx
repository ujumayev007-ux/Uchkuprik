import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { can, hasFeature, meKey, useMe, type Me } from '../auth/session';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { useRealtime } from '../lib/realtime';
import { PendingOrders } from './PendingOrders';
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
};

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

export function AppShell() {
  const { data: me } = useMe();
  const theme = useTheme();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const online = useRealtime(
    me?.tenantKind === 'BUSINESS' ? me.activeBranchId : null,
  );
  if (!me) return null;
  const items = navItems.filter((item) => item.visible(me));

  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    client.setQueryData(meKey, null);
    client.clear();
    navigate(me.authMethod === 'PIN' ? '/pin' : '/kirish', { replace: true });
  };

  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
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
          {items.map((item) => (
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
          ))}
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
          {me.tenantKind === 'BUSINESS' && (
            <span
              className={`live-dot ${online ? 'on' : 'off'}`}
              role="status"
              title={online ? t.live.online : t.live.offline}
              aria-label={online ? t.live.online : t.live.offline}
            />
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
          <BillingBanner me={me} />
          <Outlet />
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
