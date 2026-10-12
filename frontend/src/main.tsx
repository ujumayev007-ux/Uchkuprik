import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useLocation,
} from 'react-router';
import { can, useMe, type Me } from './auth/session';
import { AppShell } from './components/AppShell';
import { ErrorState, LoadingState, ToastProvider } from './components/ui';
import { t } from './i18n';
import { ApiError } from './lib/api';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage';
import { LoginPage } from './pages/auth/LoginPage';
import { MfaSetupPage } from './pages/auth/MfaSetupPage';
import { MfaVerifyPage } from './pages/auth/MfaVerifyPage';
import { PinPage } from './pages/auth/PinPage';
import { BranchesPage } from './pages/BranchesPage';
import { DashboardPage } from './pages/DashboardPage';
import { DevicesPage } from './pages/DevicesPage';
import { FloorPage } from './pages/FloorPage';
import { InventoryPage } from './pages/InventoryPage';
import { KitchenPage } from './pages/KitchenPage';
import { MenuPage } from './pages/MenuPage';
import { PrintersPage } from './pages/PrintersPage';
import {
  TableMenuPage,
  TrackingPage,
  WebsiteMenuPage,
} from './pages/public/PublicPages';
import { QueuePage } from './pages/QueuePage';
import { OrdersPage } from './pages/OrdersPage';
import { PosPage } from './pages/PosPage';
import { ReceiptPage, ZReportPage } from './pages/PrintPages';
import { ReportsPage } from './pages/ReportsPage';
import { ShiftPage } from './pages/ShiftPage';
import { PlatformTenantsPage } from './pages/PlatformTenantsPage';
import { SettingsPage } from './pages/SettingsPage';
import { RolesPage } from './pages/RolesPage';
import { StatusPage } from './pages/StatusPage';
import { UsersPage } from './pages/UsersPage';
import './styles.css';
import './ui.css';
import './pos.css';
import './kitchen.css';
import './public.css';

/** The next step a partially authenticated session must complete, if any. */
function pendingStep(me: Me): string | null {
  if (!me.mfaVerified) return '/kirish/tasdiqlash';
  if (me.mustChangePassword) return '/kirish/parol';
  if (me.mfaSetupRequired) return '/kirish/2fa';
  return null;
}

function RequireSession() {
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  if (me.error)
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/kirish" replace />;
  const step = pendingStep(me.data);
  if (step) return <Navigate to={step} replace />;
  return <AppShell />;
}

/** Login-flow pages: redirect away once the session no longer needs that step. */
function AuthStep({
  step,
  children,
}: {
  step: string | null;
  children: React.ReactNode;
}) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <LoadingState />;
  if (!me.data)
    return step ? <Navigate to="/kirish" replace /> : <>{children}</>;
  const pending = pendingStep(me.data);
  if (pending === location.pathname) return <>{children}</>;
  return <Navigate to={pending ?? '/'} replace />;
}

/** Print views render without the application shell but still need a session. */
function SessionOnly({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  if (!me.data) return <Navigate to="/kirish" replace />;
  return <>{children}</>;
}

function Home() {
  const { data: me } = useMe();
  if (me?.tenantKind === 'PLATFORM')
    return <Navigate to="/platforma/bizneslar" replace />;
  // Terminal staff start on the POS screen.
  if (me?.authMethod === 'PIN' && can(me, 'pos.access'))
    return <Navigate to="/kassa" replace />;
  if (me?.authMethod === 'PIN' && can(me, 'kitchen.access'))
    return <Navigate to="/oshxona" replace />;
  return <DashboardPage />;
}

function Guard({
  allow,
  children,
}: {
  allow: (me: Me) => boolean;
  children: React.ReactNode;
}) {
  const { data: me } = useMe();
  if (!me || !allow(me))
    return (
      <ErrorState error={new ApiError(403, 'FORBIDDEN', t.common.errorTitle)} />
    );
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="state">
      <h1>{t.notFound.title}</h1>
      <p>{t.notFound.description}</p>
      <a className="btn btn-primary" href="/">
        {t.notFound.home}
      </a>
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/holat', element: <StatusPage /> },
  {
    path: '/kirish',
    element: (
      <AuthStep step={null}>
        <LoginPage />
      </AuthStep>
    ),
  },
  {
    path: '/kirish/tasdiqlash',
    element: (
      <AuthStep step="mfa">
        <MfaVerifyPage />
      </AuthStep>
    ),
  },
  {
    path: '/kirish/parol',
    element: (
      <AuthStep step="password">
        <ChangePasswordPage />
      </AuthStep>
    ),
  },
  {
    path: '/kirish/2fa',
    element: (
      <AuthStep step="mfa-setup">
        <MfaSetupPage />
      </AuthStep>
    ),
  },
  { path: '/pin', element: <PinPage /> },
  // Public customer pages: no staff session required.
  { path: '/t/:token', element: <TableMenuPage /> },
  { path: '/r/:slug', element: <WebsiteMenuPage /> },
  { path: '/buyurtma/:token', element: <TrackingPage /> },
  {
    path: '/navbat',
    element: (
      <SessionOnly>
        <QueuePage />
      </SessionOnly>
    ),
  },
  {
    path: '/chek/:id',
    element: (
      <SessionOnly>
        <ReceiptPage />
      </SessionOnly>
    ),
  },
  {
    path: '/z-hisobot/:id',
    element: (
      <SessionOnly>
        <ZReportPage />
      </SessionOnly>
    ),
  },
  {
    element: <RequireSession />,
    children: [
      { path: '/', element: <Home /> },
      {
        path: '/kassa',
        element: (
          <Guard allow={(me) => can(me, 'pos.access')}>
            <PosPage />
          </Guard>
        ),
      },
      {
        path: '/buyurtmalar',
        element: (
          <Guard allow={(me) => can(me, 'orders.view')}>
            <OrdersPage />
          </Guard>
        ),
      },
      {
        path: '/oshxona',
        element: (
          <Guard allow={(me) => can(me, 'kitchen.access')}>
            <KitchenPage />
          </Guard>
        ),
      },
      {
        path: '/printerlar',
        element: (
          <Guard allow={(me) => can(me, 'settings.manage')}>
            <PrintersPage />
          </Guard>
        ),
      },
      {
        path: '/smena',
        element: (
          <Guard allow={(me) => can(me, 'shifts.manage')}>
            <ShiftPage />
          </Guard>
        ),
      },
      {
        path: '/hisobotlar',
        element: (
          <Guard allow={(me) => can(me, 'reports.view')}>
            <ReportsPage />
          </Guard>
        ),
      },
      {
        path: '/ombor',
        element: (
          <Guard
            allow={(me) =>
              can(me, 'inventory.view') || can(me, 'purchasing.manage')
            }
          >
            <InventoryPage />
          </Guard>
        ),
      },
      {
        path: '/menyu',
        element: (
          <Guard allow={(me) => can(me, 'menu.view')}>
            <MenuPage />
          </Guard>
        ),
      },
      {
        path: '/zallar',
        element: (
          <Guard
            allow={(me) => can(me, 'tables.manage') || can(me, 'orders.view')}
          >
            <FloorPage />
          </Guard>
        ),
      },
      {
        path: '/sozlamalar',
        element: (
          <Guard allow={(me) => me.tenantKind === 'BUSINESS'}>
            <SettingsPage />
          </Guard>
        ),
      },
      {
        path: '/xodimlar',
        element: (
          <Guard allow={(me) => can(me, 'users.view')}>
            <UsersPage />
          </Guard>
        ),
      },
      {
        path: '/rollar',
        element: (
          <Guard allow={(me) => can(me, 'users.view')}>
            <RolesPage />
          </Guard>
        ),
      },
      {
        path: '/filiallar',
        element: (
          <Guard allow={(me) => me.tenantKind === 'BUSINESS'}>
            <BranchesPage />
          </Guard>
        ),
      },
      {
        path: '/qurilmalar',
        element: (
          <Guard allow={(me) => can(me, 'devices.manage')}>
            <DevicesPage />
          </Guard>
        ),
      },
      {
        path: '/audit',
        element: (
          <Guard allow={(me) => can(me, 'audit.view')}>
            <AuditPage />
          </Guard>
        ),
      },
      {
        path: '/hisob',
        element: (
          <Guard allow={(me) => me.authMethod === 'PASSWORD'}>
            <AccountPage />
          </Guard>
        ),
      },
      {
        path: '/platforma/bizneslar',
        element: (
          <Guard allow={(me) => me.isPlatformAdmin}>
            <PlatformTenantsPage />
          </Guard>
        ),
      },
      {
        path: '/platforma/audit',
        element: (
          <Guard allow={(me) => me.isPlatformAdmin}>
            <AuditPage platform />
          </Guard>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      // Authorization failures will not succeed on retry; network errors might.
      retry: (count, error) =>
        !(error instanceof ApiError && error.status > 0) && count < 2,
    },
  },
});

// A session that expires mid-use sends the user back to sign-in.
queryClient.getQueryCache().subscribe((event) => {
  const error = event.query.state.error;
  if (
    event.type === 'updated' &&
    error instanceof ApiError &&
    error.status === 401 &&
    event.query.queryKey[0] !== 'auth'
  )
    void queryClient.invalidateQueries({ queryKey: ['auth'] });
});

const root = document.getElementById('root');
if (!root) throw new Error('Application root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
