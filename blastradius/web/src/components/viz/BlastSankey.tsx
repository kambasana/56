/**
 * BlastSankey (design system: BlastSankey): how far one package spreads. Four labelled columns,
 * package → brought in by → projects → environment; ribbon width = assets reached. Colour only on
 * the package (its severity); ribbons are neutral, production solid and on top, dev lighter.
 * Project nodes are keyboard reachable and pick that project. The Table toggle on the page is the
 * accessible equivalent.
 */
import { useMemo, type KeyboardEvent } from 'react';
import type { Severity } from '@/components/br';
import { SEVERITY_GLYPH, SEVERITY_LABEL } from '@/components/br';
import { cn } from '@/lib/utils';
import { DEV_LABEL, layoutSankey, PROD_LABEL, type SankeyFlowIn, type SankeyNode } from './sankey';

const HEADINGS = ['PACKAGE', 'BROUGHT IN BY', 'PROJECTS', 'WHERE'];
const SEV_FILL: Record<Severity, string> = { critical: 'fill-sev-critical', high: 'fill-sev-high', medium: 'fill-sev-medium', low: 'fill-sev-low' };
const SEV_TEXT: Record<Severity, string> = { critical: 'fill-sev-critical', high: 'fill-sev-high', medium: 'fill-sev-medium', low: 'fill-sev-low' };

export interface BlastSankeyProps {
  pkg: { label: string; level: Severity | null };
  flows: readonly SankeyFlowIn[];
  /** Selected project id (highlighted). */
  selected?: string | null;
  onPickProject?: (projectId: string) => void;
  /** Accessible summary of the whole picture. */
  summary: string;
  width?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BlastSankey({ pkg, flows, selected, onPickProject, summary, width = 720 }: BlastSankeyProps) {
  const layout = useMemo(() => layoutSankey({ label: pkg.label }, flows, { width }), [pkg.label, flows, width]);
  const labelX = (n: SankeyNode) => layout.columnsX[n.column] + layout.nodeWidth + 6;
  const pick = (n: SankeyNode) => n.projectId && onPickProject?.(n.projectId);
  const onKey = (e: KeyboardEvent, n: SankeyNode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(n);
    }
  };

  return (
    <figure data-slot="blast-sankey" className="m-0 flex flex-col gap-2">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${layout.width + 150} ${layout.height}`} width={layout.width + 150} height={layout.height} role="group" aria-label={summary} className="max-w-none">
          {HEADINGS.map((h, i) => (
            <text key={h} x={layout.columnsX[i as 0]} y={12} className="fill-muted-foreground text-[11px] font-semibold tracking-[.08em]">
              {h}
            </text>
          ))}
          {layout.links.map((l) => (
            <path key={l.id} d={l.d} className={cn(l.production ? 'fill-edge-runtime opacity-55' : 'fill-edge-dev opacity-35', 'hover:opacity-80')}>
              <title>{l.title}</title>
            </path>
          ))}
          {layout.nodes.map((n) => {
            const isPkg = n.column === 0;
            const isEnv = n.column === 3;
            const isProject = n.column === 2 && !!n.projectId;
            const sel = isProject && selected === n.projectId;
            const rect = (
              <rect
                x={layout.columnsX[n.column]}
                y={n.y}
                width={layout.nodeWidth}
                height={n.height}
                rx={3}
                className={cn(
                  isPkg ? (pkg.level ? SEV_FILL[pkg.level] : 'fill-node-border') : 'fill-node-surface',
                  !isPkg && 'stroke-node-border',
                  isEnv && n.production && 'stroke-reach-prod [stroke-width:2]',
                  isEnv && !n.production && '[stroke-dasharray:4_3]',
                  sel && 'stroke-focus-path [stroke-width:3]',
                )}
              />
            );
            const ty = Math.max(n.y + Math.min(n.height, 30) / 2 + 4, 30);
            const sub = isPkg
              ? pkg.level
                ? `${SEVERITY_GLYPH[pkg.level]} ${SEVERITY_LABEL[pkg.level]}`
                : 'Not rated'
              : isEnv
                ? plural(n.value, 'asset')
                : n.column === 1
                  ? plural(n.value, 'asset')
                  : n.production
                    ? `${PROD_LABEL} · ${plural(n.value, 'asset')}`
                    : plural(n.value, 'asset');
            const body = (
              <>
                {rect}
                <text x={labelX(n)} y={ty} className={cn('text-[12px]', isEnv ? 'font-sans' : 'font-mono', isEnv && n.production ? 'fill-reach-prod font-semibold' : isEnv ? 'fill-reach-dev' : 'fill-foreground', 'font-medium')}>
                  {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                </text>
                <text x={labelX(n)} y={ty + 14} className={cn('text-[11.5px]', isPkg && pkg.level ? `${SEV_TEXT[pkg.level]} font-semibold` : 'fill-muted-foreground')}>
                  {sub}
                </text>
              </>
            );
            if (!isProject) return <g key={n.id}>{body}</g>;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                aria-label={`${n.label}: ${plural(n.value, 'asset')}${n.production ? ', production' : ', dev and test'}. Show its paths.`}
                onClick={() => pick(n)}
                onKeyDown={(e) => onKey(e, n)}
                className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-ring focus-visible:[&>rect]:[stroke-width:3]"
              >
                <title>{`${n.label} · ${plural(n.value, 'asset')}`}</title>
                {body}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>
          <span aria-hidden="true">━ </span>runtime ({PROD_LABEL})
        </span>
        <span>
          <span aria-hidden="true">╍ </span>dev ({DEV_LABEL})
        </span>
        <span>Width = assets reached</span>
        {layout.hiddenProjects > 0 && <span>{plural(layout.hiddenProjects, 'project')} merged into "+more"; the table lists every one</span>}
        <span>Hover a ribbon for details · choose a project to filter the paths below</span>
      </figcaption>
    </figure>
  );
}
