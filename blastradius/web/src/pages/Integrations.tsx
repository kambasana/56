/**
 * Integrations (canvas: Integrations.dc.html). Read-only in Phase 4a: shows what the server
 * reports (GET /api/integrations) plus the destinations that are planned, marked "coming soon".
 * Blastradius investigates and reports; fixes happen in the tools teams already use.
 */
import type { Integration } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { Badge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { Card, ComingSoon } from './e-parts/ui';

const STATUS: Record<Integration['status'], { label: string; className: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  ok: { label: 'Connected', className: 'text-success', variant: 'secondary' },
  not_configured: { label: 'Not configured', className: 'text-muted-foreground', variant: 'outline' },
  error: { label: 'Error', className: '', variant: 'destructive' },
};

interface Planned {
  id: string;
  name: string;
  what: string;
  /** Which server integration (kind) reports its live status, if any. */
  kind?: Integration['kind'];
  available?: string;
}

const PLANNED: Planned[] = [
  {
    id: 'code-scanning',
    name: 'GitHub code scanning',
    what: 'Upload SARIF to GitHub code scanning, PR check annotations, issues in the owning repo and release assets for reports, through the GitHub App.',
    kind: 'github',
    available: 'Today: download a SARIF report from Reports and upload it with github/codeql-action/upload-sarif.',
  },
  {
    id: 'actions',
    name: 'GitHub Actions',
    what: 'Run Blastradius in CI and fail or annotate a pull request when it adds a risky dependency.',
    available: 'Today: run the CLI in a workflow step (blastradius scan . --format sarif).',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    what: 'Findings, changes and reports as JSON signed with HMAC-SHA256, with retries and a delivery log.',
    kind: 'webhook',
  },
  {
    id: 'api',
    name: 'REST API tokens',
    what: 'Read findings, paths, entities and reports and trigger scans with an API token.',
    kind: 'api',
    available: 'Today: the same JSON API the web app uses, with a signed-in session.',
  },
  {
    id: 'connectors',
    name: 'Jira, Slack, Linear, ServiceNow, Splunk',
    what: 'Native connectors for ticketing, chat and SIEM.',
  },
];

export default function Integrations() {
  const { me, can } = useAuth();
  const { data, error, loading, reload } = useApi((s) => api.integrations(s), []);
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Integrations' }];
  const manage = can('manage_integrations');
  const live = new Map((data?.items ?? []).map((i) => [i.kind, i] as const));

  return (
    <>
      <PageHeader crumbs={crumbs} title="Integrations" meta="read-only in this version" />
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="m-0 max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
          Blastradius investigates and reports. Fixing happens in the tools you already use: findings, changes and reports will be routed to them from here.
          {manage ? ' Configuration is not available yet; nothing on this page changes settings.' : ''}
        </p>
        {loading && !data ? (
          <LoadingState label="Loading integrations…" />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <>
            <Card title="Server status" description="What this Blastradius server has configured right now." bodyClassName="flex flex-col">
              <ul className="m-0 list-none p-0">
                {(data?.items ?? []).map((i) => {
                  const st = STATUS[i.status];
                  return (
                    <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 text-[13px] last:border-b-0">
                      <span className="min-w-[140px] font-medium">{i.name}</span>
                      <Badge variant={st.variant} className={st.className}>
                        {st.label}
                      </Badge>
                      <span className="min-w-0 grow text-muted-foreground">{i.detail}</span>
                    </li>
                  );
                })}
                {(data?.items ?? []).length === 0 && <li className="px-4 py-3 text-[13px] text-muted-foreground">No integrations reported by the server.</li>}
              </ul>
            </Card>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" role="list" aria-label="Destinations">
              {PLANNED.map((p) => {
                const st = p.kind ? live.get(p.kind) : undefined;
                return (
                  <div role="listitem" key={p.id}>
                    <Card
                      className="h-full"
                      title={p.name}
                      action={
                        <>
                          {st && st.status === 'ok' && (
                            <Badge variant="secondary" className="text-success">
                              {p.kind === 'github' ? 'Token set' : 'Connected'}
                            </Badge>
                          )}
                          <ComingSoon />
                        </>
                      }
                      bodyClassName="flex flex-col gap-2 px-4 py-3 text-[13px] leading-[18px]"
                    >
                      <p className="m-0">{p.what}</p>
                      {p.available && <p className="m-0 text-muted-foreground">{p.available}</p>}
                      {p.id === 'code-scanning' && can('reports') && (
                        <div>
                          <ButtonLink size="xs" variant="outline" to="/reports">
                            Open Reports
                          </ButtonLink>
                        </div>
                      )}
                    </Card>
                  </div>
                );
              })}
            </div>
            <Card title="API" description="Same JSON as the CLI's report (schemaVersion 1). Session-authenticated in this version." bodyClassName="px-4 py-3">
              <pre className="m-0 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5">
                {[
                  '# Findings for a project (signed-in session cookie)',
                  'GET /api/findings?project=<id>&level=critical,high',
                  '# Report for one snapshot',
                  'GET /api/reports/<scanId>.sarif',
                ].join('\n')}
              </pre>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
