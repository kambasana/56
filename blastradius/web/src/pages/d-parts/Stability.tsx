/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, P3): Fragile, Watch, Steady, Unknown, each with the
 * rules that fired and the facts behind them, their source and confidence. Upkeep from public
 * records, shown beside findings and never counted as risk; the wording is factual, never a verdict.
 * Used by the Maintenance tab (Findings), the Package page and the Changes page.
 */
import type { ProjectStabilityResponse, StabilityDecision, StabilityEntry, StabilityEvent, StabilityLabel, StabilityReason, UpkeepEventsResponse } from '@server/api-types';
import { Badge } from '@/components/ui/badge';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { ReachTag } from '@/components/br';
import { SidePanel } from '@/components/SidePanel';
import { cn } from '@/lib/utils';
import { fmtNum } from '@/lib/cn';
import { DetailList, Section } from './ui';

export const STABILITY_LABEL_TEXT: Record<StabilityLabel, string> = { fragile: 'Fragile', watch: 'Watch', steady: 'Steady', unknown: 'Unknown' };

/** One line per label: what it means, in plain words. */
export const STABILITY_LABEL_HINT: Record<StabilityLabel, string> = {
  fragile:
    'A Fragile rule fired: single active contributor and no activity in 18 months (not a small, finished package), ended (deprecated or archived) while used in production, or an open advisory with no fixed release and no activity.',
  watch: 'A Watch rule fired (for example a small, finished package with a single maintainer); see the facts behind it.',
  steady: 'No stability rule fired: from git history, or (when it was not read) from a recent release or the OpenSSF Scorecard Maintained check; the details say which.',
  unknown: 'Not enough data for a label; it says what is missing.',
};

const STYLE: Record<StabilityLabel, string> = {
  fragile: 'border-transparent bg-warning-soft text-warning font-semibold',
  watch: 'border-border text-foreground',
  steady: 'border-transparent bg-transparent px-0 text-foreground',
  unknown: 'border-dashed border-border text-muted-foreground',
};

/** Fragile is amber; Watch is neutral with a dot; Steady is plain text; Unknown is grey. Never a severity colour. */
export function StabilityBadge({ label, className }: { label: StabilityLabel; className?: string }) {
  return (
    <Badge variant="outline" data-stability={label} title={STABILITY_LABEL_HINT[label]} className={cn('gap-1.5', STYLE[label], className)}>
      {label === 'watch' && <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />}
      {STABILITY_LABEL_TEXT[label]}
    </Badge>
  );
}

const FINISHED_TEXT = { yes: 'Yes', no: 'No', unknown: 'Not known' } as const;

/** Finished / low-surface test: the answer, the size of the largest version in use, what was not met. */
function finishedText(f: NonNullable<StabilityEntry['finished']>): string {
  const size = f.size ? ` · ${(f.size.unpackedSize / 1024).toFixed(1)} kB, ${fmtNum(f.size.fileCount)} files, ${fmtNum(f.size.dependencies)} dependencies` : '';
  return `${FINISHED_TEXT[f.state]}${size}${f.notMet.length ? ` · ${f.notMet.join('; ')}` : ''}`;
}

const STATE_TEXT: Record<StabilityEntry['s3']['state'], string> = { active: 'Active', quiet: 'Quiet', inactive: 'Inactive', ended: 'Ended', unknown: 'Unknown' };
const SOURCE_TEXT: Record<string, string> = {
  npm: 'npm registry',
  git: 'git history',
  'git+npm': 'git history and npm',
  'npm+git': 'npm and git history',
  scorecard: 'OpenSSF Scorecard',
  depsdev: 'deps.dev',
  github: 'GitHub',
  'npm.readme': 'README on npm',
  inventory: 'this scan',
};

export function sourceText(s: string): string {
  return SOURCE_TEXT[s] ?? s;
}

function FactLine({ f }: { f: StabilityReason }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="break-words">{f.text}</span>
      <span className="text-caption text-muted-foreground">
        {f.signal} · {sourceText(f.source)} · {f.confidence} confidence
        {f.evidence?.map((u) => (
          <span key={u}>
            {' · '}
            <a href={u} target="_blank" rel="noreferrer noopener" className="break-all underline underline-offset-2">
              {u.replace(/^https:\/\/(www\.)?/, '')}
            </a>
          </span>
        ))}
      </span>
    </li>
  );
}

/** The label with its rules, facts, context and what is missing. */
export function StabilityDetails({ entry, disclaimer, headingLevel = 3 }: { entry: StabilityEntry; disclaimer: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StabilityBadge label={entry.label} />
        <span className="break-words">{entry.summary}</span>
      </div>
      {entry.action && (
        <p className="m-0 break-words font-medium" data-testid="stability-action">
          {entry.action}
        </p>
      )}
      {entry.rules.length > 0 && (
        <section aria-label="Rules that fired" className="flex flex-col gap-2">
          {entry.rules.map((r) => (
            <div key={r.rule} className="flex flex-col gap-1">
              <H className="m-0 text-label font-semibold">{r.name}</H>
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5">
                {r.facts.map((f, i) => (
                  <FactLine key={i} f={f} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {entry.missing.length > 0 && (
        <section aria-label="Missing data" className="flex flex-col gap-1">
          <H className="m-0 text-label font-semibold">Missing</H>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            {entry.missing.map((m) => (
              <li key={m} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        </section>
      )}
      {entry.context.length > 0 && (
        <section aria-label="Context" className="flex flex-col gap-1">
          <H className="m-0 text-label font-semibold">Context (decided nothing)</H>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-text-secondary">
            {entry.context.map((f, i) => (
              <FactLine key={i} f={f} />
            ))}
          </ul>
        </section>
      )}
      <p className="m-0 text-caption text-muted-foreground">Funding not yet assessed: the funding rules (F2, F3) are not applied. {disclaimer}</p>
    </div>
  );
}

function StabilityPanel({ entry, disclaimer, onClose }: { entry: StabilityEntry; disclaimer: string; onClose: () => void }) {
  return (
    <SidePanel label="Stability details" onClose={onClose} eyebrow={<StabilityBadge label={entry.label} />} title={entry.name}>
      <div className="flex flex-col divide-y">
        <Section title="Why">
          <StabilityDetails entry={entry} disclaimer={disclaimer} />
        </Section>
        <Section title="Details">
          <DetailList
            items={[
              ['Versions', <span className="font-mono text-xs">{entry.versions.join(', ')}</span>],
              ['Where', <ReachTag reach={entry.production ? 'production' : 'dev'} />],
              ['Maintenance (S3)', `${STATE_TEXT[entry.s3.state]} (${entry.s3.confidence} confidence)${entry.s3.lastCommit ? ` · last commit ${entry.s3.lastCommit}` : ''}${entry.s3.lastRelease ? ` · last release ${entry.s3.lastRelease}` : ''}`],
              ['Contributor absence factor (S2)', entry.caf ? `${entry.caf.value} over ${fmtNum(entry.caf.commits)} commits, ${entry.caf.from} to ${entry.caf.to}` : 'Not known'],
              ...(entry.finished ? ([['Small, finished package', finishedText(entry.finished)]] as [string, string][]) : []),
              ['Upkeep from', BASIS_TEXT[entry.basis ?? 'git']],
              ...(entry.repo ? ([['Repository', `${entry.repo.current.replace(/^https:\/\//, '')}${entry.repo.directory ? ` (${entry.repo.directory})` : ''}${entry.repo.previous?.length ? ` · earlier: ${entry.repo.previous.map((u) => u.replace(/^https:\/\//, '')).join(', ')}` : ''}`]] as [string, string][]) : []),
              ['Release regularity (S4)', entry.s4 ? `${entry.s4.irregular ? 'Irregular' : 'Regular'}: median ${Math.round(entry.s4.medianDays)} days, CV ${entry.s4.cv}` : 'Not known'],
              ['Package ID', <span className="break-all font-mono text-xs text-muted-foreground">{entry.package}</span>],
            ]}
          />
        </Section>
      </div>
    </SidePanel>
  );
}

const BASIS_TEXT: Record<NonNullable<StabilityEntry['basis']>, string> = {
  git: 'Git history of the current repository',
  'scorecard+npm': 'OpenSSF Scorecard (via deps.dev) and the npm release record; git history not read',
  npm: 'The npm release record; git history not read',
  'scorecard+pypi': 'OpenSSF Scorecard (via deps.dev) and the PyPI release record; git history not read',
  pypi: 'The PyPI release record; git history not read',
  none: 'Nothing: no repository history, Scorecard result or registry release record',
};

/** Family decision rows (Tier 0): one row per direct dependency to change. */
function DecisionList({ rows }: { rows: StabilityDecision[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="h-stability-decisions" className="flex flex-col gap-2">
      <h3 id="h-stability-decisions" className="m-0 text-label font-semibold">
        Decisions for production dependencies ({fmtNum(rows.length)})
      </h3>
      <ul aria-label="Upkeep decisions" className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.slice(0, 20).map((d) => (
          <li key={`${d.direct}:${d.packages.join(',')}`} className="flex flex-wrap items-baseline gap-2">
            <StabilityBadge label={d.label} />
            <span className="break-words">{d.action}</span>
            {d.packages.length > 1 && <span className="text-caption text-muted-foreground">{fmtNum(d.packages.length)} packages</span>}
          </li>
        ))}
      </ul>
      {rows.length > 20 && <p className="m-0 text-caption text-muted-foreground">{fmtNum(rows.length - 20)} more in the table below.</p>}
    </section>
  );
}

const LABEL_RANK: Record<StabilityLabel, number> = { fragile: 3, watch: 2, unknown: 1, steady: 0 };

const COLUMNS: ColumnDef<StabilityEntry, any>[] = [
  { id: 'package', header: 'Package', accessorFn: (r) => r.name, cell: (c) => <span className="font-mono text-xs">{c.row.original.name}</span>, size: 220 },
  { id: 'label', header: 'Stability', accessorFn: (r) => LABEL_RANK[r.label], cell: (c) => <StabilityBadge label={c.row.original.label} />, size: 110, sortDescFirst: true },
  {
    id: 'summary',
    header: 'Why',
    accessorFn: (r) => r.summary,
    cell: (c) => <span className="text-muted-foreground">{c.getValue<string>()}</span>,
    enableSorting: false,
    size: 440,
    meta: { className: 'min-w-[260px]' },
  },
  { id: 'where', header: 'Where', accessorFn: (r) => (r.production ? 1 : 0), cell: (c) => <ReachTag reach={c.row.original.production ? 'production' : 'dev'} />, size: 120, sortDescFirst: true },
  { id: 's3', header: 'Maintenance', accessorFn: (r) => STATE_TEXT[r.s3.state], size: 110 },
  { id: 'purl', header: 'Package ID', accessorFn: (r) => r.package },
];

export function StabilitySection({ data, loading }: { data: ProjectStabilityResponse | null; loading: boolean }) {
  const entries = data?.entries ?? [];
  const counts = data?.counts;
  return (
    <section aria-labelledby="h-stability" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="h-stability" className="m-0 text-heading font-semibold">
          Stability
        </h2>
        {counts && (
          <span className="text-label text-text-secondary">
            {(['fragile', 'watch', 'steady', 'unknown'] as const).map((l) => `${STABILITY_LABEL_TEXT[l]} ${fmtNum(counts[l])}`).join(' · ')}
          </span>
        )}
      </div>
      <p className="m-0 text-caption text-muted-foreground">
        {data?.disclaimer ?? 'Stability describes upkeep from public records. It is not a security verdict.'} Funding not yet assessed.
      </p>
      {data?.coverage && (
        <p className="m-0 break-words text-label text-text-secondary" data-testid="stability-coverage">
          {data.coverage.line}
        </p>
      )}
      {data?.historyStatus === 'pending' && (
        <p className="m-0 text-label text-muted-foreground" role="status">
          Git history is being read in the background; labels below use the Scorecard / npm fallback until it is done.
        </p>
      )}
      {data?.decisions && <DecisionList rows={data.decisions} />}
      {data && data.entries === null ? (
        <p className="m-0 text-label text-muted-foreground">The newest scan was made before stability labels existed. Run a scan to see them.</p>
      ) : (
        <DataTable<StabilityEntry>
          label="Stability labels"
          data={entries}
          loading={loading}
          columns={COLUMNS}
          getRowId={(r) => r.package}
          filterPlaceholder="Filter by package or reason…"
          initialSorting={[{ id: 'label', desc: true }]}
          initialColumnVisibility={{ purl: false }}
          total={entries.length}
          emptyTitle="No npm packages in this scan"
          emptyDescription="Stability labels cover npm packages."
          renderPanel={(row, close) => <StabilityPanel entry={row} disclaimer={data?.disclaimer ?? ''} onClose={close} />}
        />
      )}
    </section>
  );
}

const EVENT_KIND_TEXT: Record<StabilityEvent['kind'], string> = {
  label_worsened: 'Label got worse',
  release_continuity: 'Release by a new account',
};

/**
 * Changes page (Tier 0): upkeep events between the two scans, dated to the commit or release that
 * caused them; last 90 days, production only, at most 20, one row per account event.
 */
export function UpkeepEventsSection({ upkeep }: { upkeep: UpkeepEventsResponse }) {
  const left = upkeep.omitted.older + upkeep.omitted.overLimit;
  return (
    <section aria-labelledby="h-upkeep-events" className="flex flex-col gap-2 border-t px-4 py-3">
      <h2 id="h-upkeep-events" className="m-0 text-heading font-semibold">
        Upkeep events
      </h2>
      <p className="m-0 text-caption text-muted-foreground">
        Thresholds crossed between the previous scan and this one, dated to the commit or release that caused them, since {upkeep.since}. Production dependencies only. Facts from public records, not findings and not a statement about any person.
      </p>
      {upkeep.baseline ? (
        <p className="m-0 text-label text-muted-foreground">This is the first scan of the project: it is the baseline, so there are no upkeep events yet.</p>
      ) : upkeep.events.length === 0 ? (
        <p className="m-0 text-label text-muted-foreground">No upkeep thresholds crossed since the previous scan.</p>
      ) : (
        <ul aria-label="Upkeep events" className="m-0 flex list-none flex-col gap-2 p-0">
          {upkeep.events.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{e.packages.length > 1 ? `${e.packages[0]} and ${e.packages.length - 1} more` : e.packages[0]}</span>
                <Badge variant="outline">{EVENT_KIND_TEXT[e.kind]}</Badge>
                {e.to && <StabilityBadge label={e.to} />}
                <span className="text-caption text-muted-foreground">
                  {e.date}
                  {e.dateIsScan ? ' (scan date; no dated fact)' : ''}
                </span>
              </div>
              <span className="break-words text-text-secondary">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
      {left > 0 && (
        <p className="m-0 text-caption text-muted-foreground">
          {fmtNum(left)} older or further crossings not listed{upkeep.omitted.notProduction ? `; ${fmtNum(upkeep.omitted.notProduction)} in dev-only dependencies left out` : ''}.
        </p>
      )}
    </section>
  );
}
