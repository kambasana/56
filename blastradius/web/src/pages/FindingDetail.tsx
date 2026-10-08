/**
 * Finding (Detail template, docs/UX.md §3): a header with the one severity, the package and one
 * primary split action that moves the status track; an on-page index over stacked sections
 * (Where it reaches, What to do, Who's behind it, Evidence, Timeline), no tabs; and a right rail of
 * fields, where Status and Owner are editable.
 */
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ChevronDown } from 'lucide-react';
import type { FindingDetail as Detail, FindingRow, FindingStatus, UpdateFindingStatusRequest } from '@server/api-types';
import { FINDING_STATUSES } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { projectCrumb } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ACCEPTED_RISK, FINDING_STEPS, NotAllowedHint, ReachTag, SeverityBadge, StateBlock, StatusTrack } from '@/components/br';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useApi } from '@/lib/useApi';
import { factorLabel, purlLabel } from './d-parts/format';
import { BehindIt, EvidenceList } from './d-parts/FindingSections';
import { investigateHref } from './d-parts/FindingPanel';
import { advisoryIds, behindPath, reachPath } from './a-parts/links';
import { AcceptRiskDialog, actionLabel, fmtDay, nextStatus, relTime, STATUS_LABELS, TriageFields, useTriagePerms } from './a-parts/triage';

const SECTIONS = [
  { id: 'reach', label: 'Where it reaches' },
  { id: 'fix', label: 'What to do' },
  { id: 'who', label: "Who's behind it" },
  { id: 'evidence', label: 'Evidence' },
  { id: 'timeline', label: 'Timeline' },
] as const;

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`h-${id}`} className="flex scroll-mt-16 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`h-${id}`} className="m-0 text-heading font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const MALICIOUS = new Set(['malware', 'entity_incident']);

/** Plain next steps from the reasons and paths (never a guess beyond them). */
export function whatToDo(d: Detail): string[] {
  const pkg = `${d.name}@${d.version}`;
  const factors = new Set(d.reasons.map((r) => r.factor));
  const via = d.introducedBy?.via ?? [];
  const steps: string[] = [];
  if ([...factors].some((f) => MALICIOUS.has(f))) {
    steps.push(`Remove ${pkg} or pin a version released before it, then reinstall from a clean lockfile.`);
    steps.push(`Treat any machine that ran an install with ${pkg} since ${fmtDay(d.firstSeenAt)} as exposed: rotate the secrets it could read.`);
  } else if (factors.has('vuln')) {
    steps.push(`Upgrade ${d.name} to a version the advisory lists as fixed.`);
  } else if (factors.has('maintainer_change') || factors.has('publisher_change') || factors.has('install_script') || factors.has('dependency_added')) {
    steps.push(`Check what changed in ${pkg} before taking it further; pin the last version you trust until then.`);
  } else {
    steps.push(`Review the reasons under Evidence and decide: fix, or accept the risk with a reason and an expiry date.`);
  }
  if (via.length > 0) steps.push(`It comes in through ${via.slice(0, 3).join(', ')}: a newer version of ${via.length === 1 ? 'that package' : 'those packages'} may be the change to make.`);
  else if (d.introducedBy?.direct) steps.push(`It is a direct dependency: change it in the manifest.`);
  return steps;
}

interface TimelineItem {
  at: string;
  text: ReactNode;
}

function timeline(d: Detail): TimelineItem[] {
  const items: TimelineItem[] = [];
  items.push({ at: d.firstSeenAt, text: <>First seen in {d.projectName ?? 'this project'} (scan)</> });
  for (const h of d.history) if (h.at !== d.firstSeenAt) items.push({ at: h.at, text: <>Seen again in a scan, as {factorLevel(h.level)}</> });
  for (const a of d.alerts ?? []) items.push({ at: a.createdAt, text: <>Alert: advisory <span className="font-mono text-[12px]">{a.advisoryId}</span> matched this package</> });
  for (const c of d.statusHistory)
    items.push({
      at: c.at,
      text: (
        <>
          {c.byName ?? 'Someone'} set {STATUS_LABELS[c.from]} → {STATUS_LABELS[c.to]}
          {c.note && <span className="text-text-secondary">: {c.note}</span>}
        </>
      ),
    });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

const factorLevel = (l: string) => l[0]!.toUpperCase() + l.slice(1);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-label font-medium text-muted-foreground">{label}</dt>
      <dd className="m-0 text-body">{children}</dd>
    </div>
  );
}

const notRecorded = <span className="text-muted-foreground">Not recorded</span>;

/** "Flagged 9 d before the advisory" when Blastradius saw it first. */
function earlyWarning(d: Detail): ReactNode {
  const published = (d.alerts ?? []).map((a) => a.advisoryPublished).filter((x): x is string => !!x).sort()[0];
  if (!published) return notRecorded;
  const lead = Date.parse(published) - Date.parse(d.firstSeenAt);
  if (!Number.isFinite(lead)) return notRecorded;
  if (lead <= 0) return <span className="text-text-secondary">None: the advisory came first</span>;
  const days = Math.round(lead / 86_400_000);
  return <>First seen {days >= 1 ? `${days} d` : `${Math.max(1, Math.round(lead / 3_600_000))} h`} before the advisory</>;
}

function PrimaryAction({ finding, onChange }: { finding: FindingRow; onChange: (c: UpdateFindingStatusRequest) => Promise<void> }) {
  const perms = useTriagePerms([finding.projectId]);
  const [busy, setBusy] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = nextStatus(finding.status);
  const locked = !perms.review || (finding.status === 'accepted_risk' && !perms.acceptRisk);
  const why = !perms.review ? 'review' : finding.status === 'accepted_risk' && !perms.acceptRisk ? 'accept_risk' : null;
  const go = async (status: FindingStatus) => {
    if (status === 'accepted_risk') {
      setRiskOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onChange({ status });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the status.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="inline-flex" role="group" aria-label="Status action">
        <Button size="sm" className="rounded-r-none" disabled={locked || busy || next === null} aria-describedby={why ? 'primary-why' : undefined} onClick={() => next && void go(next)}>
          {next ? actionLabel(next) : 'Resolved'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="rounded-l-none border-l border-primary-foreground/25 px-2" disabled={locked || busy} aria-label="More status options">
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {FINDING_STATUSES.filter((s) => s !== finding.status).map((s) => (
              <DropdownMenuItem key={s} disabled={s === 'accepted_risk' && !perms.acceptRisk} onSelect={() => void go(s)}>
                {s === 'accepted_risk' ? 'Accept risk…' : s === 'new' ? 'Reopen' : `Set ${STATUS_LABELS[s]}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {why && <NotAllowedHint id="primary-why" permission={why} className="text-caption" />}
      {error && (
        <span role="alert" className="text-caption text-destructive">
          {error}
        </span>
      )}
      <AcceptRiskDialog open={riskOpen} onOpenChange={setRiskOpen} count={1} onConfirm={(note, expiresAt) => onChange({ status: 'accepted_risk', note, expiresAt })} />
    </div>
  );
}

export default function FindingDetail() {
  const { id = '', fid = '' } = useParams();
  const { me, can } = useAuth();
  const { project } = useProject();
  const { data, error, loading, reload } = useApi((s) => api.finding(fid, s), [fid]);
  const [row, setRow] = useState<FindingRow | null>(null);
  const listPath = `/projects/${encodeURIComponent(id)}/findings`;
  const title = data ? `${data.name}@${data.version}` : 'Finding';
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, projectCrumb(project), { label: 'Findings', to: listPath }, { label: title }];

  if (loading && !data) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Finding" />
        <div className="p-4">
          <StateBlock kind="loading" label="Loading finding" rows={5} columns={3} />
        </div>
      </>
    );
  }
  if (error || !data) {
    const missing = isApiError(error, 'not_found');
    return (
      <>
        <PageHeader crumbs={crumbs} title="Finding" />
        <div className="p-4">
          {missing ? (
            <StateBlock kind="no-results" title="Finding not found" description="It may belong to an older scan or another project." actions={[{ label: 'Back to findings', to: listPath }, { label: 'Search all projects', to: '/findings' }]} />
          ) : (
            <StateBlock kind="error" title="Could not load this finding" cause={error?.message ?? 'No data'} onRetry={reload} />
          )}
        </div>
      </>
    );
  }

  const current: FindingRow = row && row.id === data.id ? row : data;
  const detail: Detail = { ...data, ...current };
  const change = async (c: UpdateFindingStatusRequest) => {
    setRow(await api.updateFindingStatus(data.id, c));
    reload();
  };
  const spread = data.spread ?? { projects: 1, prodProjects: data.reach.prodAssets > 0 ? 1 : 0 };
  const prodAssets = data.assets.filter((a) => a.environment === 'prod');
  const advisory = (data.alerts ?? [])[0]?.advisoryId ?? advisoryIds([...data.reasons.flatMap((r) => [r.detail, ...(r.evidence ?? [])]), ...data.entityChain.map((e) => e.entityId)])[0];
  const advisoryPublished = (data.alerts ?? []).map((a) => a.advisoryPublished).find((x) => !!x) ?? null;
  const step = current.status === 'accepted_risk' ? ACCEPTED_RISK : STATUS_LABELS[current.status];
  const items = timeline(detail);

  return (
    <>
      <PageHeader crumbs={crumbs} title={<span className="font-mono">{title}</span>}>
        <PrimaryAction finding={current} onChange={change} />
      </PageHeader>
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge level={data.level} size="md" />
          {data.mainReason && <span className="text-text-secondary">{data.mainReason.detail}</span>}
        </div>
        <StatusTrack steps={FINDING_STEPS} current={step} label="Finding status" />
        {current.status === 'accepted_risk' && current.riskExpiresAt && <span className="text-caption text-text-secondary">Accepted until {fmtDay(current.riskExpiresAt)}</span>}
      </div>
      <div className="flex flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-4 lg:px-8">
          <nav aria-label="On this page" className="flex flex-wrap gap-4 border-b pb-2 text-label">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.label}
              </a>
            ))}
          </nav>

          <Section
            id="reach"
            title="Where it reaches"
            action={
              <span className="flex flex-wrap gap-3 text-label">
                {can('investigate', data.projectId) && <Link to={investigateHref(data.projectId, data.id)}>Open in graph</Link>}
                <Link to={reachPath(data.name, data.version)}>See the full reach and every path →</Link>
              </span>
            }
          >
            <p className="m-0 max-w-[640px] text-text-secondary">
              {spread.projects > 1 ? `In ${spread.projects} projects, ${spread.prodProjects} in production. ` : ''}
              {data.reachText}.
              {prodAssets.length > 0 && (
                <>
                  {' '}
                  In production in <strong className="text-foreground">{prodAssets.map((a) => a.assetName).join(', ')}</strong>.
                </>
              )}
            </p>
            {data.assets.length > 0 ? (
              <ul aria-label="Paths to assets" className="m-0 flex list-none flex-col divide-y overflow-hidden rounded-xl border p-0">
                {[...data.assets]
                  .sort((a, b) => Number(b.environment === 'prod') - Number(a.environment === 'prod'))
                  .map((a) => (
                    <li key={a.assetId} className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[160px_112px_minmax(0,1fr)] sm:items-center">
                      <span className="font-medium">{a.assetName}</span>
                      <ReachTag reach={a.environment === 'prod' ? 'production' : 'dev'} />
                      <span className="font-mono text-[12px] break-words text-text-secondary">
                        {(a.paths[0] ?? []).map((p, i) => (i === 0 ? a.assetName : purlLabel(p))).join(' → ')}
                        {a.paths.length > 1 && <span className="text-muted-foreground"> (+{a.paths.length - 1} more)</span>}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="m-0 text-muted-foreground">No dependency path from this project reaches it.</p>
            )}
          </Section>

          <Section id="fix" title="What to do">
            <ol className="m-0 flex max-w-[640px] flex-col gap-1 pl-5 text-text-secondary">
              {whatToDo(detail).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Section>

          <Section id="who" title="Who's behind it" action={<Link to={behindPath(data.name)} className="text-label">Open the graph →</Link>}>
            <BehindIt chain={data.entityChain} ownership={data.ownership} />
          </Section>

          <Section id="evidence" title="Evidence">
            {data.reasons.length > 0 && (
              <ul aria-label="Reasons" className="m-0 flex max-w-[720px] flex-col gap-1 pl-5">
                {data.reasons.map((r, i) => (
                  <li key={`${r.factor}-${i}`}>
                    <span className="font-medium">{factorLabel(r.factor)}:</span> <span className="text-text-secondary">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <EvidenceList detail={data} />
          </Section>

          <Section id="timeline" title="Timeline">
            <ol aria-label="Timeline" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {items.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-24 shrink-0 text-caption text-muted-foreground" title={t.at}>
                    {relTime(t.at)}
                  </span>
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside aria-label="Details" className="flex w-full shrink-0 flex-col gap-4 border-t p-4 lg:w-rail lg:border-t-0 lg:border-l lg:p-5">
          <TriageFields projectIds={[data.projectId]} status={current.status} ownerId={current.owner?.id ?? ''} onChange={change} />
          <dl className="m-0 flex flex-col gap-3.5">
            <Field label="Affected">
              {spread.projects} {spread.projects === 1 ? 'project' : 'projects'} · {spread.prodProjects} in production
            </Field>
            <Field label="Advisory">{advisory ? <span className="font-mono text-[12px]">{advisory}</span> : notRecorded}</Field>
            <Field label="Released">{notRecorded}</Field>
            <Field label="Advisory published">{advisoryPublished ? fmtDay(advisoryPublished) : notRecorded}</Field>
            <Field label="Early warning">{earlyWarning(detail)}</Field>
            <Field label="First seen">
              {fmtDay(data.firstSeenAt)} <span className="text-muted-foreground">({relTime(data.firstSeenAt)})</span>
            </Field>
          </dl>
        </aside>
      </div>
    </>
  );
}
