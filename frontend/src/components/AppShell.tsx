import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { can, meKey, useMe, type Me } from '../auth/session';
import { t } from '../i18n';
import { api, post } from '../lib/api';
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
    to: '/ombor',
    label: t.nav.warehouse,
    icon: '▥',
    visible: (me) => can(me, 'inventory.view') || can(me, 'purchasing.manage'),
  },
  {
    to: '/yetkazish',
    label: t.delivery.title,
    icon: '➤',
    visible: (me) => can(me, 'delivery.manage'),
  },
  {
    to: '/kuryer',
    label: t.delivery.courierTitle,
    icon: '➤',
    visible: (me) => can(me, 'delivery.courier') && !can(me, 'delivery.manage'),
  },
  {
    to: '/mijozlar',
    label: t.crm.title,
    icon: '☺',
    visible: (me) => can(me, 'customers.view'),
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
    visible: (me) => can(me, 'hr.manage') || can(me, 'finance.view'),
  },
  {
    to: '/moliya',
    label: t.finance.title,
    icon: '∑',
    visible: (me) => can(me, 'finance.view'),
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
    visible: (me) => can(me, 'settings.manage'),
  },
  {
    to: '/tolovlar',
    label: t.nav.payments,
    icon: '₪',
    visible: (me) => can(me, 'settings.manage'),
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
