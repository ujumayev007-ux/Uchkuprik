import { Link } from 'react-router';
import { useMe } from '../auth/session';
import { navItems, useBranches } from '../components/AppShell';
import { Badge, PageHeader } from '../components/ui';
import { ClockCard } from './AttendancePage';
import { t } from '../i18n';

export function DashboardPage() {
  const { data: me } = useMe();
  const branches = useBranches(me?.tenantKind === 'BUSINESS');
  if (!me) return null;
  const branch = branches.data?.find((item) => item.id === me.activeBranchId);
  const links = navItems.filter((item) => item.to !== '/' && item.visible(me));
  return (
    <>
      <PageHeader
        title={`${t.dashboard.greeting}, ${me.displayName}`}
        subtitle={me.tenant.name}
      />
      <div className="grid-cards">
        <ClockCard />
        <section className="card">
          <h2>{t.dashboard.activeBranch}</h2>
          <p className="big">
            {branch?.name ?? (me.allBranches ? t.dashboard.allBranches : '—')}
          </p>
          <p className="muted">
            {t.dashboard.signedInWith}:{' '}
            {me.authMethod === 'PIN'
              ? t.dashboard.methodPin
              : t.dashboard.methodPassword}
          </p>
        </section>
        <section className="card">
          <h2>{t.dashboard.security}</h2>
          <p className="big">
            {me.mfaEnabled ? (
              <Badge tone="success">{t.dashboard.mfaOn}</Badge>
            ) : (
              <Badge tone="warning">{t.dashboard.mfaOff}</Badge>
            )}
          </p>
          <p className="muted">
            {t.dashboard.permissions}: {me.permissions.length}
          </p>
        </section>
        {links.length > 0 && (
          <section className="card">
            <h2>{t.dashboard.quickLinks}</h2>
            <div className="link-list">
              {links.map((item) => (
                <Link key={item.to} to={item.to} className="quick-link">
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
      <p className="phase-note">
        <span aria-hidden="true">◈</span>
        {t.dashboard.nextModules}
      </p>
    </>
  );
}
