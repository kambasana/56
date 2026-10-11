/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, P3): Fragile, Watch, Steady, Unknown, each with the
 * rules that fired and the facts behind them, their source and confidence. Upkeep from public
 * records, shown beside findings and never counted as risk; the wording is factual, never a verdict.
 * Used by the Maintenance tab (Findings), the Package page and the Changes page.
 */
import type { ContinuityRow, ProjectStabilityResponse, StabilityEntry, StabilityLabel, StabilityReason } from '@server/api-types';
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
  fragile: 'A Fragile rule fired: single active contributor and no activity in 18 months, or ended (deprecated or archived) while used in production.',
  watch: 'A Watch rule fired; see the facts behind it.',
  steady: 'No stability rule fired, with git history and maintenance status known.',
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
              ['Release regularity (S4)', entry.s4 ? `${entry.s4.irregular ? 'Irregular' : 'Regular'}: median ${Math.round(entry.s4.medianDays)} days, CV ${entry.s4.cv}` : 'Not known'],
              ['Package ID', <span className="break-all font-mono text-xs text-muted-foreground">{entry.package}</span>],
            ]}
          />
        </Section>
      </div>
    </SidePanel>
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

const KIND_TEXT: Record<ContinuityRow['kind'], string> = {
  release_by_new_person: 'Release by a new account (git)',
  npm_release_by_new_account: 'Published by a new account (npm)',
  release_takeover: 'Recent top committer makes the releases',
};

/** Changes page: S5a release-continuity observations of the newer scan (last 12 months). */
export function ContinuitySection({ rows }: { rows: ContinuityRow[] }) {
  return (
    <section aria-labelledby="h-continuity" className="flex flex-col gap-2 border-t px-4 py-3">
      <h2 id="h-continuity" className="m-0 text-heading font-semibold">
        Release continuity (S5a)
      </h2>
      <p className="m-0 text-caption text-muted-foreground">
        Releases made or published by an account first seen in the repository less than 180 days earlier, in the last 12 months. Facts from git history and npm, not findings and not a statement about any person.
      </p>
      {rows.length === 0 ? (
        <p className="m-0 text-label text-muted-foreground">No release-continuity observations in the last 12 months.</p>
      ) : (
        <ul aria-label="Release continuity observations" className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{r.name}</span>
                <Badge variant="outline">{KIND_TEXT[r.kind]}</Badge>
                <ReachTag reach={r.production ? 'production' : 'dev'} />
                {r.isNew && <Badge variant="secondary">New since the previous scan</Badge>}
                <span className="text-caption text-muted-foreground">{r.date}</span>
              </div>
              <span className="break-words text-text-secondary">{r.text}</span>
              <span className="text-caption text-muted-foreground">
                {sourceText(r.source)} · {r.confidence} confidence
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
