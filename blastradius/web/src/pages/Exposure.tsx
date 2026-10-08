/**
 * Exposure (/exposure, canvas screen 13): where risky packages sit across projects. A projects ×
 * packages matrix, production rows first and the most shared packages left; every cell has a
 * glyph and a letter, an empty one "–". A cell opens that finding, a column header the package's
 * reach. Table/Heatmap toggle (the table is the accessible view), CSV export, and the top 40
 * columns unless asked for all. Below it, which npm accounts can publish the largest share of the
 * production dependencies in scope (H3, docs/ACCOUNT-PROOF.md), with its own Chart/Table toggle.
 * Data: GET /api/exposure (org-wide axis), GET /api/accounts/concentration.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, Download } from 'lucide-react';
import type { RiskLevel } from '@server/api-types';
import { api } from '@/api';
import { accountsApi } from '@/api-accounts';
import { ConcentrationSection } from '@/components/viz/Concentration';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { exposurePath, packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ReachTag, ScopeBar, SeverityBadge, StateBlock, useScope, useUpdateParams } from '@/components/br';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ExposureMatrix, MatrixLegend } from '@/components/viz/ExposureMatrix';
import { buildMatrix, COLUMN_CAP, matrixCsv, type MatrixModel } from '@/components/viz/matrix';
import { useViewParam, ViewToggle } from '@/components/viz/ViewToggle';
import { useApi } from '@/lib/useApi';

const LEVELS: RiskLevel[] = ['critical', 'high', 'medium', 'low'];
const MIN_LABEL: Record<RiskLevel, string> = { critical: 'Critical only', high: 'High and above', medium: 'Medium and above', low: 'Every severity' };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MatrixTable({ model }: { model: MatrixModel }) {
  const rows = model.rows.flatMap((r) => model.columns.filter((c) => r.cells.has(c.index)).map((c) => ({ r, c, cell: r.cells.get(c.index)! })));
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Exposure" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Project</th>
            <th scope="col" className="px-2 py-2 font-medium">Environment</th>
            <th scope="col" className="px-2 py-2 font-medium">Package</th>
            <th scope="col" className="px-2 py-2 font-medium">Severity</th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Finding</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, c, cell }) => (
            <tr key={`${r.projectId}-${c.index}`} className="border-t">
              <td className="px-3 py-2 font-medium">{r.name}</td>
              <td className="px-2 py-2">
                <ReachTag reach={cell.production ? 'production' : 'dev'} />
              </td>
              <td className="px-2 py-2 font-mono text-[12px]">
                <Link to={packagePath(c.name, c.version)}>
                  {c.name}@{c.version}
                </Link>
              </td>
              <td className="px-2 py-2">
                <SeverityBadge level={cell.level} variant="plain" />
              </td>
              <td className="px-3 py-2 text-right">{cell.findingId && <Link to={`${projectPath(r.projectId, 'findings')}/${encodeURIComponent(cell.findingId)}`}>Open finding</Link>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Exposure() {
  const { me } = useAuth();
  const { projects } = useProject();
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const [scope, setScope] = useScope();
  const [view, setView] = useViewParam(['heatmap', 'table'] as const, 'heatmap');
  const minRaw = sp.get('min');
  const minLevel: RiskLevel = minRaw && (LEVELS as string[]).includes(minRaw) ? (minRaw as RiskLevel) : 'medium';
  const showAll = sp.get('cols') === 'all';
  const { data, error, loading, reload } = useApi((s) => api.exposure({ minLevel, limit: 200 }, s), [minLevel]);
  const scopeKey = scope.projects.join(',');
  const conc = useApi((s) => accountsApi.concentration(scopeKey ? { projects: scopeKey } : {}, s), [scopeKey]);
  const model = useMemo(() => (data ? buildMatrix(data, { projects: scope.projects, env: scope.env, showAll }) : null), [data, scope.projects, scope.env, showAll]);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Exposure', to: exposurePath() },
  ];

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading the exposure matrix" rows={6} columns={6} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load the exposure matrix" cause={error.message} onRetry={reload} />;
  else if (model && model.totalColumns === 0)
    body =
      data && data.columns.length === 0 ? (
        <StateBlock kind="all-clear" title={`No ${MIN_LABEL[minLevel].toLowerCase()} findings in any project`} description="Checked the latest scan of every project you can see." actions={minLevel !== 'low' ? [{ label: 'Show every severity', onClick: () => update({ min: 'low' }) }] : []} />
      ) : (
        <StateBlock
          kind="no-results"
          title="Nothing in this scope"
          actions={[
            { label: 'Search all projects', onClick: () => setScope({ projects: [], env: 'all' }) },
            ...(minLevel !== 'low' ? [{ label: 'Show every severity', onClick: () => update({ min: 'low' }) }] : []),
          ]}
        />
      );
  else if (model) body = view === 'heatmap' ? <ExposureMatrix model={model} /> : <MatrixTable model={model} />;

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Exposure"
        meta={model ? `${model.rows.length} projects × ${model.columns.length} packages` : undefined}
        actions={
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-label" disabled={!model || model.totalColumns === 0} onClick={() => model && download('blastradius-exposure.csv', matrixCsv(model, window.location.origin))}>
            <Download aria-hidden="true" className="size-3.5" />
            Export CSV
          </Button>
        }
      >
        <ViewToggle value={view} onChange={setView} options={[{ value: 'table', label: 'Table' }, { value: 'heatmap', label: 'Heatmap' }]} />
      </PageHeader>
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0 text-text-secondary">Where risky packages sit across projects. Production first, most-shared packages left.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeBar projects={projects} showRange={false} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-label font-normal" aria-label={`Severity: ${MIN_LABEL[minLevel]}`}>
                {MIN_LABEL[minLevel]}
                <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={minLevel} onValueChange={(v) => update({ min: v === 'medium' ? null : v })}>
                {LEVELS.map((l) => (
                  <DropdownMenuRadioItem key={l} value={l}>
                    {MIN_LABEL[l]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {model && model.totalColumns > COLUMN_CAP && (
          <p className="m-0 flex flex-wrap items-center gap-2 text-label text-text-secondary" role="note">
            {showAll ? `Showing all ${model.totalColumns} packages.` : `Showing the top ${COLUMN_CAP} of ${model.totalColumns} packages by how many projects use them.`}
            <button type="button" className="text-selection underline underline-offset-2" onClick={() => update({ cols: showAll ? null : 'all' })}>
              {showAll ? `Top ${COLUMN_CAP} only` : 'Show all'}
            </button>
          </p>
        )}
        {data?.truncated && <p className="m-0 text-label text-text-secondary">The server listed the 200 riskiest packages; raise the severity to narrow it.</p>}
        {body}
        {model && model.totalColumns > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <MatrixLegend />
            <span className="ml-auto text-caption text-text-secondary">Choose a cell to open that finding, or a column to see how far the package spreads.</span>
          </div>
        )}
        {conc.loading && !conc.data ? (
          <StateBlock kind="loading" label="Loading publishing accounts" rows={3} columns={3} />
        ) : conc.error && !conc.data ? (
          <StateBlock kind="error" title="Could not load publishing accounts" cause={conc.error.message} onRetry={conc.reload} />
        ) : conc.data ? (
          <ConcentrationSection data={conc.data} />
        ) : null}
      </div>
    </>
  );
}
