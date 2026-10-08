/**
 * Alerts: what fired, newest first (GET /api/alerts). Stage 2 adds the WHEN → THEN rule builder
 * and the team Slack channel here (needs the manage_alert_rules permission).
 */
import { useAuth } from '@/auth';
import { PageHeader } from '@/components/PageHeader';
import { AlertsCard } from './d-parts/IncidentPanel';

export default function Alerts() {
  const { me } = useAuth();
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Alerts', to: '/alerts' },
  ];
  return (
    <>
      <PageHeader crumbs={crumbs} title="Alerts" meta="new advisories that hit a project" />
      <div className="flex max-w-5xl flex-col gap-4 p-4">
        <AlertsCard />
      </div>
    </>
  );
}
