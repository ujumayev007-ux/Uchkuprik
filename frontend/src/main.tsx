import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useLocation,
} from 'react-router';
import { can, hasFeature, useMe, type Me } from './auth/session';
import { AppShell } from './components/AppShell';
import { BrandingHost, PublicBrandingHost } from './components/BrandingHost';
import { isPanelShell, shellKind } from './lib/shell';
import { DeviceSetup } from './components/DeviceSetup';
import { ServerWake } from './components/ServerWake';
import { ErrorState, LoadingState, ToastProvider } from './components/ui';
import { t } from './i18n';
import { ApiError } from './lib/api';
import { registerServiceWorker } from './lib/pwa';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage';
import { LoginPage } from './pages/auth/LoginPage';
import { MfaSetupPage } from './pages/auth/MfaSetupPage';
import { MfaVerifyPage } from './pages/auth/MfaVerifyPage';
import { PinPage } from './pages/auth/PinPage';
import { BranchesPage } from './pages/BranchesPage';
import { AttendancePage } from './pages/AttendancePage';
import { CourierPage } from './pages/CourierPage';
import { CustomersPage } from './pages/CustomersPage';
import { DeliveryPage } from './pages/DeliveryPage';
import { DashboardPage } from './pages/DashboardPage';
import { DevicesPage } from './pages/DevicesPage';
import { FinancePage } from './pages/FinancePage';
import { FloorPage } from './pages/FloorPage';
import { InventoryPage } from './pages/InventoryPage';
import { KitchenPage } from './pages/KitchenPage';
import { MenuPage } from './pages/MenuPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { PayrollPage } from './pages/PayrollPage';
import { PrintersPage } from './pages/PrintersPage';
import {
  TableMenuPage,
  TrackingPage,
  WebsiteMenuPage,
} from './pages/public/PublicPages';
import { QueuePage } from './pages/QueuePage';
import { OrdersPage } from './pages/OrdersPage';
import { PosPage } from './pages/PosPage';
import { DeliverySheetPage } from './pages/DeliverySheetPage';
import {
  KitchenTicketPage,
  KitchenTicketTestPage,
} from './pages/KitchenTicketPage';
import { ReceiptPage, ReceiptTestPage, ZReportPage } from './pages/PrintPages';
import { RegisterPage } from './pages/auth/RegisterPage';
import { PlatformBillingPage } from './pages/PlatformBillingPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { BrandsPage } from './pages/BrandsPage';
import { OperationsPage } from './pages/OperationsPage';
import { AssetsPage } from './pages/AssetsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { DeveloperPage } from './pages/DeveloperPage';
import { InsightsPage } from './pages/InsightsPage';
import { LicensePage } from './pages/LicensePage';
import { WaiterPage } from './pages/WaiterPage';
import { DesignPage } from './pages/DesignPage';
import { ReceiptDesignPage } from './pages/ReceiptDesignPage';
import { QrPaymentPage } from './pages/QrPaymentPage';
import { VendorPage } from './pages/VendorPage';
import { ApprovalsPage, TrainingPage } from './pages/TrainingPage';
import { FranchisePage, FranchisePortalPage } from './pages/FranchisePage';
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
import './orders.css';
import './public.css';
import './skins.css';
import './responsive.css';

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
  // Kassa, Oshxona and Ofitsiant start with the staff PIN pad, never the password form;
  // the Queue TV needs no sign-in at all.
  if (!me.data)
    return (
      <Navigate
        to={
          shellKind() === 'tv' ? '/navbat' : isPanelShell() ? '/pin' : '/kirish'
        }
        replace
      />
    );
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

/** Customer queue: signed-in staff, or the Queue TV application's registered device. */
function QueueRoute() {
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  if (!me.data && shellKind() === 'tv') return <QueuePage />;
  return (
    <SessionOnly>
      <BrandingHost forcePanel="customer" />
      <QueuePage />
    </SessionOnly>
  );
}

/** Print views and the TV queue render without the application shell but still need a session. */
function SessionOnly({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  // Terminal applications (Kassa, Oshxona, TV...) sign in with the staff PIN pad.
  if (!me.data)
    return <Navigate to={isPanelShell() ? '/pin' : '/kirish'} replace />;
  return <>{children}</>;
}

/** Managers (reports, staff or settings) land on the dashboard, terminal staff on their panel. */
function manages(me: Me | null | undefined) {
  return (
    can(me, 'reports.view') ||
    can(me, 'users.manage') ||
    can(me, 'settings.manage')
  );
}

function Home() {
  const { data: me } = useMe();
  if (me?.tenantKind === 'PLATFORM')
    return <Navigate to="/platforma/bizneslar" replace />;
  // A fresh Kassa/Oshxona/Ofitsiant application is registered once by the administrator.
  if (
    isPanelShell() &&
    me?.authMethod === 'PASSWORD' &&
    can(me, 'devices.manage')
  )
    return <DeviceSetup />;
  // The Restaurant Admin application always starts on the management dashboard.
  if (shellKind() === 'admin') return <DashboardPage />;
  // The dedicated Kassa and Ofitsiant applications open their own panel directly.
  if (shellKind() === 'cashier' && can(me, 'pos.access'))
    return <Navigate to="/kassa" replace />;
  if (
    shellKind() === 'waiter' &&
    (can(me, 'pos.access') || can(me, 'orders.create'))
  )
    return <Navigate to="/ofitsiant" replace />;
  // The TV application only ever shows the customer queue.
  if (shellKind() === 'tv') return <Navigate to="/navbat" replace />;
  // The dedicated Oshxona application opens the kitchen board directly.
  if (shellKind() === 'kitchen' && can(me, 'kitchen.access'))
    return <Navigate to="/oshxona" replace />;
  // A dedicated application never falls back to the dashboard.
  if (isPanelShell())
    return (
      <div className="state">
        <h1>{t.devices.noAccessTitle}</h1>
        <p>{t.devices.noAccessHint}</p>
      </div>
    );
  // The shared POS application shows the staff member's own panel after sign-in; the
  // menu then offers only the other panels their permissions allow.
  if (me?.roleKeys.includes('waiter') && !can(me, 'reports.view'))
    return <Navigate to="/ofitsiant" replace />;
  if (can(me, 'pos.access') && (me?.authMethod === 'PIN' || !manages(me)))
    return <Navigate to="/kassa" replace />;
  if (can(me, 'kitchen.access') && (me?.authMethod === 'PIN' || !manages(me)))
    return <Navigate to="/oshxona" replace />;
  if (
    can(me, 'delivery.courier') &&
    !can(me, 'delivery.manage') &&
    !can(me, 'pos.access')
  )
    return <Navigate to="/kuryer" replace />;
  return <DashboardPage />;
}

function Guard({
  allow,
  feature,
  children,
}: {
  allow: (me: Me) => boolean;
  // Optional plan module; tenants without it see an upgrade notice.
  feature?: string;
  children: React.ReactNode;
}) {
  const { data: me } = useMe();
  if (!me || !allow(me))
    return (
      <ErrorState error={new ApiError(403, 'FORBIDDEN', t.common.errorTitle)} />
    );
  if (feature && !hasFeature(me, feature))
    return (
      <div className="state">
        <h1>{t.billing.upgradeTitle}</h1>
        <p>{t.billing.upgradeText}</p>
        {can(me, 'settings.manage') && (
          <a className="btn btn-primary" href="/obuna">
            {t.billing.openBilling}
          </a>
        )}
      </div>
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
    path: '/royxatdan-otish',
    element: (
      <AuthStep step={null}>
        <RegisterPage />
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
  // SUPER_OWNER console (central server): own sign-in, outside restaurant sessions.
  {
    path: '/owner',
    element: (
      <div
        className="owner-shell"
        style={{ padding: '1rem', maxWidth: '72rem', margin: '0 auto' }}
      >
        <VendorPage />
      </div>
    ),
  },
  // Public customer pages: no staff session required.
  {
    path: '/t/:token',
    element: (
      <>
        <PublicBrandingHost />
        <TableMenuPage />
      </>
    ),
  },
  {
    path: '/r/:slug',
    element: (
      <>
        <PublicBrandingHost />
        <WebsiteMenuPage />
      </>
    ),
  },
  {
    path: '/buyurtma/:token',
    element: (
      <>
        <PublicBrandingHost />
        <TrackingPage />
      </>
    ),
  },
  {
    path: '/navbat',
    element: <QueueRoute />,
  },
  {
    path: '/dostavka-varaqa/:id',
    element: (
      <SessionOnly>
        <DeliverySheetPage />
      </SessionOnly>
    ),
  },
  {
    path: '/chek-sinov',
    element: (
      <SessionOnly>
        <ReceiptTestPage />
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
    path: '/oshxona-chek-sinov',
    element: (
      <SessionOnly>
        <KitchenTicketTestPage />
      </SessionOnly>
    ),
  },
  {
    path: '/oshxona-chek/:id',
    element: (
      <SessionOnly>
        <KitchenTicketPage />
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
        path: '/tolovlar',
        element: (
          <Guard
            feature="online_payments"
            allow={(me) => can(me, 'settings.manage')}
          >
            <PaymentsPage />
          </Guard>
        ),
      },
      {
        path: '/printerlar',
        element: (
          <Guard
            feature="kitchen_printing"
            allow={(me) => can(me, 'settings.manage')}
          >
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
            feature="inventory"
            allow={(me) =>
              can(me, 'inventory.view') || can(me, 'purchasing.manage')
            }
          >
            <InventoryPage />
          </Guard>
        ),
      },
      {
        path: '/yetkazish',
        element: (
          <Guard feature="delivery" allow={(me) => can(me, 'delivery.manage')}>
            <DeliveryPage />
          </Guard>
        ),
      },
      {
        path: '/kuryer',
        element: (
          <Guard feature="delivery" allow={(me) => can(me, 'delivery.courier')}>
            <CourierPage />
          </Guard>
        ),
      },
      {
        path: '/mijozlar',
        element: (
          <Guard allow={(me) => can(me, 'customers.view')}>
            <CustomersPage />
          </Guard>
        ),
      },
      {
        path: '/ish-vaqti',
        element: (
          <Guard allow={(me) => me.tenantKind === 'BUSINESS'}>
            <AttendancePage />
          </Guard>
        ),
      },
      {
        path: '/ish-haqi',
        element: (
          <Guard
            feature="hr"
            allow={(me) => can(me, 'hr.manage') || can(me, 'finance.view')}
          >
            <PayrollPage />
          </Guard>
        ),
      },
      {
        path: '/moliya',
        element: (
          <Guard feature="finance" allow={(me) => can(me, 'finance.view')}>
            <FinancePage />
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
        path: '/brendlar',
        element: (
          <Guard
            feature="multi_brand"
            allow={(me) => can(me, 'brands.manage') || can(me, 'reports.view')}
          >
            <BrandsPage />
          </Guard>
        ),
      },
      {
        path: '/franshiza',
        element: (
          <Guard
            feature="franchise"
            allow={(me) => can(me, 'franchise.manage')}
          >
            <FranchisePage />
          </Guard>
        ),
      },
      {
        path: '/portal',
        element: (
          <Guard
            feature="franchise"
            allow={(me) => can(me, 'franchise.portal')}
          >
            <FranchisePortalPage />
          </Guard>
        ),
      },
      {
        path: '/operatsiyalar',
        element: (
          <Guard
            feature="operations"
            allow={(me) =>
              can(me, 'operations.perform') || can(me, 'operations.manage')
            }
          >
            <OperationsPage />
          </Guard>
        ),
      },
      {
        path: '/uskunalar',
        element: (
          <Guard
            feature="operations"
            allow={(me) =>
              can(me, 'assets.manage') ||
              can(me, 'operations.manage') ||
              can(me, 'operations.perform')
            }
          >
            <AssetsPage />
          </Guard>
        ),
      },
      {
        path: '/oqitish',
        element: (
          <Guard
            feature="operations"
            allow={(me) => me.tenantKind === 'BUSINESS'}
          >
            <TrainingPage />
          </Guard>
        ),
      },
      {
        path: '/tasdiqlar',
        element: (
          <Guard
            feature="operations"
            allow={(me) => can(me, 'approvals.decide')}
          >
            <ApprovalsPage />
          </Guard>
        ),
      },
      {
        path: '/bildirishnomalar',
        element: (
          <Guard allow={(me) => can(me, 'notifications.manage')}>
            <NotificationsPage />
          </Guard>
        ),
      },
      {
        path: '/integratsiyalar',
        element: (
          <Guard
            feature="developer_api"
            allow={(me) => can(me, 'developer.manage')}
          >
            <DeveloperPage />
          </Guard>
        ),
      },
      {
        path: '/tahlil',
        element: (
          <Guard allow={(me) => can(me, 'reports.view')}>
            <InsightsPage />
          </Guard>
        ),
      },
      {
        path: '/ofitsiant',
        element: (
          <Guard allow={(me) => can(me, 'orders.create')}>
            <WaiterPage />
          </Guard>
        ),
      },
      {
        path: '/qr-tolov',
        element: (
          <Guard allow={(me) => can(me, 'settings.manage')}>
            <QrPaymentPage />
          </Guard>
        ),
      },
      {
        path: '/chek-dizayni',
        element: (
          <Guard allow={(me) => can(me, 'settings.manage')}>
            <ReceiptDesignPage />
          </Guard>
        ),
      },
      {
        path: '/dizayn',
        element: (
          <Guard allow={(me) => can(me, 'settings.manage')}>
            <DesignPage />
          </Guard>
        ),
      },
      { path: '/litsenziya', element: <LicensePage /> },
      { path: '/sotuvchi', element: <VendorPage /> },
      {
        path: '/obuna',
        element: (
          <Guard allow={(me) => can(me, 'settings.manage')}>
            <SubscriptionPage />
          </Guard>
        ),
      },
      {
        path: '/platforma/obunalar',
        element: (
          <Guard allow={(me) => me.isPlatformAdmin}>
            <PlatformBillingPage />
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

registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('Application root element is missing.');
// The branded boot splash from index.html goes away as soon as the application drew.
requestAnimationFrame(() =>
  requestAnimationFrame(() => document.getElementById('boot-splash')?.remove()),
);
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
        <ServerWake />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
