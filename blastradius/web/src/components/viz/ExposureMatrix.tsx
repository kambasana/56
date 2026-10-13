/**
 * ExposureMatrix heatmap (design system: ExposureMatrix): every cell carries the severity glyph
 * and letter on its soft fill, an empty cell shows "–" on muted. A cell opens that project's
 * finding; a column header opens the package's reach. The page's Table view is the accessible
 * equivalent.
 */
import { Link } from 'react-router';
import { SEVERITY_GLYPH, SEVERITY_LABEL, type Severity } from '@/components/br';
import { packagePath, projectPath } from '@/nav';
import { cn } from '@/lib/utils';
import { levelLetter, type MatrixModel } from './matrix';

const CELL: Record<Severity, string> = {
  critical: 'bg-sev-critical-soft text-sev-critical',
  high: 'bg-sev-high-soft text-sev-high',
  medium: 'bg-sev-medium-soft text-sev-medium',
  low: 'bg-sev-low-soft text-sev-low',
};

export function ExposureMatrix({ model }: { model: MatrixModel }) {
  return (
    <div data-slot="exposure-matrix" className="overflow-auto rounded-xl border p-3">
      <table className="border-separate border-spacing-[3px]" aria-label="Exposure heatmap: projects by packages">
        <thead>
          <tr>
            <td className="w-40" />
            {model.columns.map((c) => (
              <th key={c.index} scope="col" className="px-1.5 py-1 text-center align-bottom font-mono text-[12px] font-medium text-text-secondary">
                <Link to={packagePath(c.name, c.version)} className="text-inherit" title={`How far ${c.name}@${c.version} spreads`}>
                  {c.name}@{c.version}
                </Link>
                <span className="block font-sans text-caption font-normal text-muted-foreground">
                  {c.projects} {c.projects === 1 ? 'project' : 'projects'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.projectId}>
              <th scope="row" className="pr-2.5 text-left font-medium whitespace-nowrap">
                {r.name}
                <span className={cn('block text-caption', r.production ? 'font-semibold text-reach-prod' : 'text-reach-dev')}>{r.production ? 'Production' : 'Dev and test'}</span>
              </th>
              {model.columns.map((c) => {
                const cell = r.cells.get(c.index);
                const base = 'flex h-[34px] w-24 items-center justify-center gap-1 rounded-[6px]';
                if (!cell)
                  return (
                    <td key={c.index} className="p-0">
                      <span className={cn(base, 'bg-muted text-muted-foreground')}>
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">
                          {c.name} not present in {r.name}
                        </span>
                      </span>
                    </td>
                  );
                const label = `${r.name} · ${c.name}@${c.version}: ${SEVERITY_LABEL[cell.level]}${cell.production ? ', production' : ''}. Open finding`;
                const body = (
                  <>
                    <span aria-hidden="true">
                      {SEVERITY_GLYPH[cell.level]} {levelLetter(cell.level)}
                    </span>
                    <span className="sr-only">{label}</span>
                  </>
                );
                return (
                  <td key={c.index} className="p-0">
                    {cell.findingId ? (
                      <Link to={`${projectPath(r.projectId, 'findings')}/${encodeURIComponent(cell.findingId)}`} className={cn(base, 'font-semibold no-underline hover:no-underline focus-visible:shadow-[0_0_0_2px_var(--focus-path)]', CELL[cell.level])}>
                        {body}
                      </Link>
                    ) : (
                      <span className={cn(base, 'font-semibold', CELL[cell.level])}>{body}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatrixLegend() {
  return (
    <p className="m-0 flex flex-wrap items-center gap-3.5 text-caption">
      <span className="font-semibold text-sev-critical">◆ C Critical</span>
      <span className="font-semibold text-sev-high">▲ H High</span>
      <span className="font-semibold text-sev-medium">● M Medium</span>
      <span className="font-semibold text-sev-low">○ L Low</span>
      <span className="text-muted-foreground">– not present</span>
    </p>
  );
}
