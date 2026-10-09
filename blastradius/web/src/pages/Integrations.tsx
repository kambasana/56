/**
 * Integrations (canvas: Integrations.dc.html). Read-only in Phase 4a: shows what the server
 * reports (GET /api/integrations) plus the destinations that are planned, as shadcn Cards
 * marked "Coming soon" with a disabled Switch. Blastradius investigates and reports; fixes
 * happen in the tools teams already use.
 */
import { useId } from 'react';
import { BellIcon, CodeIcon, GitPullRequestIcon, PlugIcon, ShieldCheckIcon, WebhookIcon, type LucideIcon } from 'lucide-react';
import type { Integration } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { ButtonLink } from '@/components/Button';
import { ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { ScrollRegion } from '@/components/ScrollRegion';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { ComingSoon, SectionCard } from './e-parts/ui';

const STATUS: Record<Integration['status'], { label: string; variant: 'secondary' | 'outline' | 'destructive'; className?: string }> = {
  ok: { label: 'Connected', variant: 'secondary', className: 'text-success' },
  not_configured: { label: 'Not configured', variant: 'outline', className: 'text-muted-foreground' },
  error: { label: 'Error', variant: 'destructive' },
};

interface Planned {
  id: string;
  name: string;
  icon: LucideIcon;
  what: string;
  /** Which server integration (kind) reports its live status, if any. */
  kind?: Integration['kind'];
  available?: string;
}

const PLANNED: Planned[] = [
  {
    id: 'code-scanning',
    name: 'GitHub code scanning',
    icon: ShieldCheckIcon,
    what: 'Upload SARIF to GitHub code scanning, PR check annotations, issues in the owning repo and release assets for reports, through the GitHub App.',
    kind: 'github',
    available: 'Today: download a SARIF report from Reports and upload it with github/codeql-action/upload-sarif.',
  },
  {
    id: 'actions',
    name: 'GitHub Actions',
    icon: GitPullRequestIcon,
    what: 'Run Blastradius in CI and fail or annotate a pull request when it adds a risky dependency.',
    available: 'Today: run the CLI in a workflow step (blastradius scan . --format sarif).',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    icon: WebhookIcon,
    what: 'Findings, changes and reports as JSON signed with HMAC-SHA256, with retries and a delivery log.',
    kind: 'webhook',
  },
  {
    id: 'api',
    name: 'REST API tokens',
    icon: CodeIcon,
    what: 'Read findings, paths, entities and reports and trigger scans with an API token.',
    kind: 'api',
    available: 'Today: the same JSON API the web app uses, with a signed-in session.',
  },
  {
    id: 'connectors',
    name: 'Jira, Slack, Linear, ServiceNow, Splunk',
    icon: BellIcon,
    what: 'Native connectors for ticketing, chat and SIEM.',
  },
];

function DestinationCard({ p, live, canReports }: { p: Planned; live?: Integration; canReports: boolean }) {
  const switchId = useId();
  const Icon = p.icon;
  return (
    <Card className="h-full gap-3 py-4">
      <CardHeader className="gap-1 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <h3>{p.name}</h3>
        </CardTitle>
        <CardAction className="flex items-center gap-1.5">
          {live?.status === 'ok' && (
            <Badge variant="secondary" className="text-success">
              {p.kind === 'github' ? 'Token set' : 'Connected'}
            </Badge>
          )}
          <ComingSoon />
        </CardAction>
      </CardHeader>
      <CardContent className="flex grow flex-col gap-2 px-4 text-[13px] leading-[18px]">
        <CardDescription className="text-[13px] leading-[18px] text-foreground">{p.what}</CardDescription>
        {p.available && <p className="text-muted-foreground">{p.available}</p>}
      </CardContent>
      <CardFooter className="flex-wrap gap-2 border-t px-4 pt-3 [.border-t]:pt-3">
        <Switch id={switchId} disabled checked={false} />
        <Label htmlFor={switchId} className="font-normal text-muted-foreground">
          Enable {p.name}
        </Label>
        <span className="grow" />
        {p.id === 'code-scanning' && canReports && (
          <ButtonLink size="xs" variant="outline" to="/reports">
            Open Reports
          </ButtonLink>
        )}
      </CardFooter>
    </Card>
  );
}

export default function Integrations() {
  const { me, can } = useAuth();
  const { data, error, loading, reload } = useApi((s) => api.integrations(s), []);
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Integrations' }];
  const manage = can('manage_integrations');
  const live = new Map((data?.items ?? []).map((i) => [i.kind, i] as const));
  const items = data?.items ?? [];

  return (
    <>
      <PageHeader crumbs={crumbs} title="Integrations" meta="read-only in this version" />
      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
          Blastradius investigates and reports. Fixing happens in the tools you already use: findings, changes and reports will be routed to them from here.
          {manage ? ' Configuration is not available yet; nothing on this page changes settings.' : ''}
        </p>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <>
            <SectionCard title="Server status" description="What this Blastradius server has configured right now.">
              <Table aria-label="Server integrations" className="text-[13px]">
                <TableHeader className="bg-muted">
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className="h-8 px-4 text-xs text-muted-foreground">
                      Integration
                    </TableHead>
                    <TableHead scope="col" className="h-8 text-xs text-muted-foreground">
                      Status
                    </TableHead>
                    <TableHead scope="col" className="h-8 px-4 text-xs text-muted-foreground">
                      Detail
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody aria-busy={loading && !data ? true : undefined}>
                  {loading && !data
                    ? Array.from({ length: 3 }, (_, i) => (
                        <TableRow key={i} aria-hidden="true">
                          <TableCell className="px-4">
                            <Skeleton className="h-4 w-28" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-20" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="h-4 w-64" />
                          </TableCell>
                        </TableRow>
                      ))
                    : items.map((i) => {
                        const st = STATUS[i.status];
                        return (
                          <TableRow key={i.id}>
                            <TableCell className="px-4 font-medium">
                              <span className="inline-flex items-center gap-2">
                                <PlugIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                                {i.name}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant={st.variant} className={cn(st.className)}>
                                {st.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="px-4 whitespace-normal text-muted-foreground">{i.detail}</TableCell>
                          </TableRow>
                        );
                      })}
                  {!loading && items.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={3} className="px-4 py-3 text-muted-foreground">
                        No integrations reported by the server.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </SectionCard>
            <section aria-labelledby="dest-h" className="flex flex-col gap-2">
              <h2 id="dest-h" className="text-sm font-semibold">
                Destinations
              </h2>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" aria-label="Destinations">
                {PLANNED.map((p) => (
                  <li key={p.id}>
                    <DestinationCard p={p} live={p.kind ? live.get(p.kind) : undefined} canReports={can('reports')} />
                  </li>
                ))}
              </ul>
            </section>
            <SectionCard title="API" description="Same JSON as the CLI's report (schemaVersion 1). Session-authenticated in this version." contentClassName="p-4">
              <ScrollRegion as="pre" label="API examples" className="rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5">
                {[
                  '# Findings for a project (signed-in session cookie)',
                  'GET /api/findings?project=<id>&level=critical,high',
                  '# Report for one scan',
                  'GET /api/reports/<scanId>.sarif',
                ].join('\n')}
              </ScrollRegion>
            </SectionCard>
          </>
        )}
      </div>
    </>
  );
}
