/**
 * Licences (/licenses org-wide, /projects/:id/licenses for one project; docs/WHO-BEHIND-PLAN.md
 * L1, L2, L4). Shown from others: declared licences from deps.dev, ClearlyDefined, the package
 * registry (where deps.dev has no data) and the scanned lockfiles, each value with its source. Computed here: the obligation category (Blue Oak Council,
 * ScanCode LicenseDB), the org policy result with the rule that decided, and licence changes
 * between releases. Not legal advice.
 *
 * Layout (docs/UX.md): "Needs attention" tiles that filter the table → components by category
 * with a Chart/Table toggle (the table is the accessible view) → the component list with URL
 * filters → licence changes → the policy. Data: GET /api/licenses, /api/license-policy.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { LicenseChangeRow, LicenseRow, LicensesResponse, ProjectRef } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { packagePath, projectCrumb, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { AppliedFilters, applyFilters, FilterChips, NotAllowedHint, StateBlock, useFilters, type FilterDef, type QuickFilter } from '@/components/br';
import { Button } from '@/components/ui/button';
import { useViewParam, ViewToggle } from '@/components/viz/ViewToggle';
import { useApi } from '@/lib/useApi';
import { safeHref } from '@/lib/safe-href';
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, DECISION_GLYPH, DECISION_LABEL, DECISIONS, licenseText, pct, SOURCE_LABEL, STATUS_NOTE } from './licenses-parts/labels';
import { PolicyEditor } from './licenses-parts/PolicyEditor';

const PAGE = 100;

function filtersFor(rows: readonly LicenseRow[], projects: readonly ProjectRef[] | null): FilterDef[] {
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  const defs: FilterDef[] = [
    { key: 'decision', label: 'Policy', options: DECISIONS.map((d) => ({ value: d, label: DECISION_LABEL[d] })), info: 'What your licence policy says about the licence: allowed, needs review or denied.' },
    { key: 'category', label: 'Category', options: CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })), info: 'Kind of obligations, from Blue Oak Council and ScanCode LicenseDB.' },
    { key: 'source', label: 'Source', options: sources.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s })), info: 'Where the licence shown comes from.' },
    { key: 'disagree', label: 'Sources', options: [{ value: 'yes', label: 'Disagree' }], info: 'Two sources state different licences for the same version.' },
  ];
  if (projects) defs.push({ key: 'project', label: 'Project', options: projects.map((p) => ({ value: p.id, label: p.name })) });
  return defs;
}

const QUICK: QuickFilter[] = [
  { label: 'Denied', key: 'decision', value: 'deny' },
  { label: 'Needs review', key: 'decision', value: 'review' },
  { label: 'Unknown licence', key: 'category', value: 'unknown' },
];

function Decision({ d }: { d: LicenseRow['decision'] }) {
  return (
    <span className={d === 'deny' ? 'font-semibold' : d === 'allow' ? 'text-text-secondary' : undefined}>
      <span aria-hidden="true">{DECISION_GLYPH[d]} </span>
      {DECISION_LABEL[d]}
    </span>
  );
}

function Tile({ label, value, hint, onClick, pressed }: { label: string; value: number; hint: string; onClick: () => void; pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${label}: ${value}, ${hint}`}
      onClick={onClick}
      className="flex min-w-[9rem] flex-1 flex-col items-start gap-0.5 rounded-xl border bg-card px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-foreground"
    >
      <span className="text-label text-text-secondary">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-caption text-text-secondary">{hint}</span>
    </button>
  );
}

function CategoryChart({ data }: { data: LicensesResponse }) {
  const total = data.counts.components;
  const max = Math.max(1, ...CATEGORIES.map((c) => data.counts.byCategory[c]));
  const summary = `Components by licence category: ${CATEGORIES.map((c) => `${CATEGORY_LABEL[c]} ${data.counts.byCategory[c]}`).join(', ')} of ${total}.`;
  return (
    <figure className="m-0" aria-label={summary}>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {CATEGORIES.map((c) => (
          <li key={c} className="grid grid-cols-[minmax(8rem,10rem)_minmax(0,1fr)_auto] items-center gap-2">
            <span className="text-label">{CATEGORY_LABEL[c]}</span>
            <span aria-hidden="true" className="h-2.5 rounded-[3px] bg-muted">
              <span className="block h-full rounded-[3px] bg-reach-prod" style={{ width: `${(data.counts.byCategory[c] / max) * 100}%` }} />
            </span>
            <span className="text-right text-label tabular-nums text-text-secondary">
              {data.counts.byCategory[c]} · {pct(data.counts.byCategory[c], total)}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function CategoryTable({ data, rows }: { data: LicensesResponse; rows: readonly LicenseRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Components by licence category" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Category</th>
            <th scope="col" className="px-2 py-2 font-medium">What it usually asks</th>
            <th scope="col" className="px-2 py-2 font-medium">Components</th>
            <th scope="col" className="px-2 py-2 font-medium">Your policy</th>
            <th scope="col" className="px-3 py-2 font-medium">Denied · needs review</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((c) => {
            const inCat = rows.filter((r) => r.category === c);
            return (
              <tr key={c} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {CATEGORY_LABEL[c]}
                </th>
                <td className="px-2 py-2 text-text-secondary">{CATEGORY_HINT[c]}</td>
                <td className="px-2 py-2 tabular-nums">
                  {data.counts.byCategory[c]} ({pct(data.counts.byCategory[c], data.counts.components)})
                </td>
                <td className="px-2 py-2">
                  <Decision d={data.policy.categories[c]} />
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {inCat.filter((r) => r.decision === 'deny').length} · {inCat.filter((r) => r.decision === 'review').length}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceCell({ r }: { r: LicenseRow }) {
  const chosen = r.sources.find((s) => s.source === r.source);
  const href = chosen?.evidence?.[0] ? safeHref(chosen.evidence[0]) : null;
  const others = r.sources.filter((s) => s.source !== r.source);
  return (
    <span className="flex flex-col">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
          {SOURCE_LABEL[r.source] ?? r.source}
        </a>
      ) : (
        <span>{SOURCE_LABEL[r.source] ?? r.source}</span>
      )}
      {chosen?.basis === 'repository' && <span className="text-caption text-text-secondary">Repository licence today, not per version</span>}
      {r.disagreement && (
        <span className="text-caption text-text-secondary">
          Sources disagree:{' '}
          {others
            .map((s) => `${SOURCE_LABEL[s.source] ?? s.source} says ${s.status === 'unlicensed' ? 'UNLICENSED' : s.expressions.join(' · ') || s.raw.join(' · ') || 'nothing'}`)
            .join('; ')}
        </span>
      )}
    </span>
  );
}

function ComponentTable({ rows, orgWide }: { rows: readonly LicenseRow[]; orgWide: boolean }) {
  const [shown, setShown] = useState(PAGE);
  const visible = rows.slice(0, shown);
  return (
    <>
      <div className="overflow-x-auto rounded-xl border">
        <table aria-label="Component licences" className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-muted text-label text-text-secondary">
              <th scope="col" className="px-3 py-2 font-medium">Package</th>
              <th scope="col" className="px-2 py-2 font-medium">Licence</th>
              <th scope="col" className="px-2 py-2 font-medium">Category</th>
              <th scope="col" className="px-2 py-2 font-medium">Policy</th>
              <th scope="col" className="px-2 py-2 font-medium">Source</th>
              {orgWide && (
                <th scope="col" className="px-3 py-2 font-medium">
                  Projects
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.purl} className="border-t align-top">
                <td className="px-3 py-2">
                  <span className="flex flex-col">
                    {r.ecosystem === 'npm' ? (
                      <Link to={packagePath(r.name, r.version)} className="font-mono text-[12px]">
                        {r.name}@{r.version}
                      </Link>
                    ) : (
                      <span className="font-mono text-[12px]">
                        {r.name}@{r.version}
                      </span>
                    )}
                    <span className="text-caption text-text-secondary">{r.ecosystem}</span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <span className="font-mono text-[12px]">{licenseText(r)}</span>
                    {STATUS_NOTE[r.status] && <span className="text-caption text-text-secondary">{STATUS_NOTE[r.status]}</span>}
                  </span>
                </td>
                <td className="px-2 py-2">{CATEGORY_LABEL[r.category]}</td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <Decision d={r.decision} />
                    <span className="text-caption text-text-secondary">{r.rule}</span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <SourceCell r={r} />
                </td>
                {orgWide && <td className="px-3 py-2">{r.projects.map((p) => p.name).join(', ')}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <div className="flex items-center gap-3">
          <span className="text-label text-text-secondary">
            Showing {visible.length} of {rows.length}
          </span>
          <Button variant="outline" size="sm" className="h-7" onClick={() => setShown((n) => n + PAGE)}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const RELATION_TEXT: Record<LicenseChangeRow['relation'], string> = {
  in_use_or_earlier: 'Already in the version you use',
  after_in_use: 'Upgrading past it changes the licence',
  mixed: 'Some versions in use are past it',
  unknown: 'Cannot place it against the version in use',
};

function ChangesTable({ changes, orgWide }: { changes: readonly LicenseChangeRow[]; orgWide: boolean }) {
  if (changes.length === 0) return <p className="m-0 text-label text-text-secondary">No licence changes in the release history checked for these packages.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Licence changes" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Package</th>
            <th scope="col" className="px-2 py-2 font-medium">From</th>
            <th scope="col" className="px-2 py-2 font-medium">To</th>
            <th scope="col" className="px-2 py-2 font-medium">Where</th>
            <th scope="col" className="px-2 py-2 font-medium">In use</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => {
            const href = c.evidence?.[0] ? safeHref(c.evidence[0]) : null;
            return (
              <tr key={`${c.purl} ${c.version}`} className="border-t align-top">
                <td className="px-3 py-2 font-mono text-[12px]">{c.name}</td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <span className="font-mono text-[12px]">{c.from.join(' · ')}</span>
                    <span className="text-caption text-text-secondary">{CATEGORY_LABEL[c.fromCategory]}</span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <span className="font-mono text-[12px]">{c.to.join(' · ')}</span>
                    <span className={c.categoryChange ? 'text-caption font-semibold' : 'text-caption text-text-secondary'}>
                      {CATEGORY_LABEL[c.toCategory]}
                      {c.categoryChange ? ' (category changed)' : ''}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    {c.unknownBetween ? (
                      <>
                        <span className="tabular-nums">
                          Between {c.previousVersion} and {c.version}
                        </span>
                        <span className="text-caption text-text-secondary">
                          {plural(c.unknownBetween, 'release')} in between had no licence data
                          {c.date ? ` · ${c.version} published ${c.date.slice(0, 10)}` : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="tabular-nums">
                          {c.previousVersion} → {c.version}
                        </span>
                        <span className="text-caption text-text-secondary">{c.date ? c.date.slice(0, 10) : 'date unknown'}</span>
                      </>
                    )}
                    {c.primary && (
                      <span className="text-caption text-text-secondary">
                        {SOURCE_LABEL[c.primary.source] ?? c.primary.source} alone: between {c.primary.previousVersion} and {c.primary.version}
                        {c.primary.unknownBetween ? `, ${plural(c.primary.unknownBetween, 'release')} without licence data` : ''}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <span className="tabular-nums">{c.inUse.join(', ')}</span>
                    <span className="text-caption text-text-secondary">{RELATION_TEXT[c.relation]}</span>
                    {orgWide && <span className="text-caption text-text-secondary">{c.projects.map((p) => p.name).join(', ')}</span>}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
                      {SOURCE_LABEL[c.source] ?? c.source}
                    </a>
                  ) : (
                    (SOURCE_LABEL[c.source] ?? c.source)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PolicySection({ data, onSaved }: { data: LicensesResponse; onSaved: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const policyApi = useApi((s) => api.licensePolicy(s), []);
  const mayEdit = can('manage_projects');
  return (
    <section aria-labelledby="lic-policy" className="flex flex-col gap-2 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="lic-policy" className="m-0 text-heading font-semibold">
          Policy
        </h2>
        <span className="flex flex-col items-end gap-0.5">
          <Button variant="outline" size="sm" className="h-7" disabled={!mayEdit || !policyApi.data} aria-describedby={mayEdit ? undefined : 'lic-policy-hint'} onClick={() => setOpen(true)}>
            Edit policy
          </Button>
          {!mayEdit && <NotAllowedHint id="lic-policy-hint" permission="manage_projects" />}
        </span>
      </div>
      <p className="m-0 text-text-secondary">
        {data.policyIsDefault ? 'The default template: permissive licences allowed, everything else needs review. Nothing is denied until you say so.' : `Your org policy${policyApi.data?.updatedBy ? `, last changed by ${policyApi.data.updatedBy}` : ''}.`}
      </p>
      <ul className="m-0 grid list-none gap-x-6 gap-y-1 p-0 sm:grid-cols-2">
        {CATEGORIES.map((c) => (
          <li key={c} className="flex justify-between gap-3 text-label">
            <span>{CATEGORY_LABEL[c]}</span>
            <Decision d={data.policy.categories[c]} />
          </li>
        ))}
      </ul>
      {data.policy.ids.length > 0 && (
        <p className="m-0 text-label">
          Licence rules: {data.policy.ids.map((r) => `${r.id} ${DECISION_LABEL[r.decision].toLowerCase()}`).join(', ')}
        </p>
      )}
      {policyApi.data && (
        <PolicyEditor
          open={open}
          onOpenChange={setOpen}
          policy={policyApi.data.policy}
          defaultPolicy={policyApi.data.defaultPolicy}
          onSaved={() => {
            policyApi.reload();
            onSaved();
          }}
        />
      )}
    </section>
  );
}

export default function Licenses() {
  const { me } = useAuth();
  const { project, projects } = useProject();
  const projectId = useParams().id;
  const orgWide = projectId === undefined;
  const { data, error, loading, reload } = useApi((s) => api.licenses(projectId ? { project: projectId } : {}, s), [projectId]);
  const [view, setView] = useViewParam(['chart', 'table'] as const, 'chart');
  const filterDefs = useMemo(() => filtersFor(data?.rows ?? [], orgWide ? projects : null), [data, orgWide, projects]);
  const filters = useFilters(filterDefs);
  const rows = useMemo(() => {
    const order = { deny: 0, review: 1, allow: 2 } as const;
    const list = applyFilters(data?.rows ?? [], filters.values, (r, key) =>
      key === 'decision' ? r.decision : key === 'category' ? r.category : key === 'source' ? r.source : key === 'disagree' ? (r.disagreement ? 'yes' : 'no') : key === 'project' ? r.projects.map((p) => p.id) : null,
    );
    return list.sort((a, b) => order[a.decision] - order[b.decision] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, [data, filters.values]);
  const changes = useMemo(() => {
    const wanted = filters.values.project;
    return (data?.changes ?? []).filter((c) => !wanted?.length || c.projects.some((p) => wanted.includes(p.id)));
  }, [data, filters.values]);

  const crumbs = orgWide
    ? [
        { label: me?.org?.name ?? 'Organization', to: '/' },
        { label: 'Licences', to: '/licenses' },
      ]
    : [projectCrumb(project), { label: 'Licences', to: projectPath(projectId, 'licenses') }];
  const toggle = (key: string, value: string) => filters.set(key, filters.has(key, value) && (filters.values[key]?.length ?? 0) === 1 ? [] : [value]);

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading licences" rows={6} columns={5} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load licences" cause={error.message} onRetry={reload} />;
  else if (data && data.scans.length === 0)
    body = <StateBlock kind="no-results" title={orgWide ? 'No project has a finished scan yet' : 'This project has no finished scan yet'} description="Licences come from the latest successful scan." actions={orgWide ? [{ label: 'Open projects', to: '/projects' }] : [{ label: 'Open scans', to: projectPath(projectId, 'scans') }]} />;
  else if (data && data.counts.components === 0)
    body = (
      <StateBlock
        kind="no-results"
        title="No licence data in the latest scan"
        description={data.scansWithoutLicences > 0 ? `${data.scansWithoutLicences} scan(s) ran before licences were collected. Run a new scan to see them.` : 'The latest scan found no components.'}
        actions={orgWide ? [{ label: 'Open projects', to: '/projects' }] : [{ label: 'Open scans', to: projectPath(projectId, 'scans') }]}
      />
    );
  else if (data) {
    const c = data.counts;
    body = (
      <>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Needs attention">
          <Tile label="Denied" value={c.byDecision.deny} hint="by your policy" pressed={filters.has('decision', 'deny')} onClick={() => toggle('decision', 'deny')} />
          <Tile label="Needs review" value={c.byDecision.review} hint="by your policy" pressed={filters.has('decision', 'review')} onClick={() => toggle('decision', 'review')} />
          <Tile label="Unknown licence" value={c.byCategory.unknown} hint="nothing we could identify" pressed={filters.has('category', 'unknown')} onClick={() => toggle('category', 'unknown')} />
          <Tile label="Sources disagree" value={c.disagreements} hint="deps.dev vs others" pressed={filters.has('disagree', 'yes')} onClick={() => toggle('disagree', 'yes')} />
          <a href="#lic-changes" aria-label={`Licence changes: ${c.changes}, between releases`} className="flex min-w-[9rem] flex-1 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3 text-foreground no-underline hover:bg-muted">
            <span className="text-label text-text-secondary">Licence changes</span>
            <span className="font-mono text-2xl font-semibold tabular-nums">{c.changes}</span>
            <span className="text-caption text-text-secondary">between releases</span>
          </a>
        </div>

        <section aria-labelledby="lic-categories" className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="lic-categories" className="m-0 text-heading font-semibold">
              Components by category
            </h2>
            <ViewToggle value={view} onChange={setView} label="Category view" options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
          </div>
          {view === 'chart' ? <CategoryChart data={data} /> : <CategoryTable data={data} rows={data.rows} />}
          <p className="m-0 text-caption text-text-secondary">
            Categories:{' '}
            {data.classification.map((s, i) => (
              <span key={s.name}>
                {i > 0 ? ', ' : ''}
                <a href={safeHref(s.url) ?? undefined} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
                  {s.name}
                </a>{' '}
                ({s.version}, {s.license})
              </span>
            ))}
            .
          </p>
        </section>

        <section aria-labelledby="lic-components" className="flex flex-col gap-2">
          <h2 id="lic-components" className="m-0 text-heading font-semibold">
            Components
          </h2>
          <FilterChips filters={filterDefs} quick={QUICK} />
          <AppliedFilters filters={filterDefs} count={`${rows.length} of ${c.components} components`} />
          {rows.length === 0 ? (
            <StateBlock kind="no-results" title="No component matches these filters" actions={[{ label: 'Clear filters', onClick: filters.clearAll }]} />
          ) : (
            <ComponentTable key={JSON.stringify(filters.values)} rows={rows} orgWide={orgWide} />
          )}
          {data.truncated && <p className="m-0 text-label text-text-secondary">The server listed the first 5,000 components.</p>}
        </section>

        <section aria-labelledby="lic-changes-h" id="lic-changes" className="flex flex-col gap-2">
          <h2 id="lic-changes-h" className="m-0 text-heading font-semibold">
            Licence changes
          </h2>
          <p className="m-0 text-text-secondary">A release whose declared licence differs from the release before it, from deps.dev release history.</p>
          <ChangesTable changes={changes} orgWide={orgWide} />
        </section>

        <PolicySection data={data} onSaved={reload} />
      </>
    );
  }

  return (
    <>
      <PageHeader crumbs={crumbs} title="Licences" meta={data ? `${data.counts.components} components · ${data.policyIsDefault ? 'default policy' : 'org policy'}` : undefined} />
      <div className="flex flex-col gap-4 p-4">
        <p className="m-0 text-text-secondary">
          Declared licences from deps.dev, ClearlyDefined, the package registry and your lockfiles, each with its source. Policy results apply your rules. This is not legal advice.
        </p>
        {data && data.scansWithoutLicences > 0 && data.counts.components > 0 && (
          <p className="m-0 text-label text-text-secondary" role="note">
            {data.scansWithoutLicences} project(s) last scanned before licences were collected; rescan them to include their licences.
          </p>
        )}
        {body}
      </div>
    </>
  );
}
