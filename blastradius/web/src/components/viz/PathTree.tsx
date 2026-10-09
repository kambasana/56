/**
 * PathTree (design system: PathTree): how a package reaches each project, as indented paths
 * project → direct dependency → … → the package. Production lane first, top 3 paths per lane with
 * "Show more paths (+N)". Rows are buttons (Up/Down move between them); choosing one selects the
 * path, which PathChain draws in the side rail. Only the package carries severity colour.
 */
import { useState, type KeyboardEvent } from 'react';
import type { ReachPath } from '@server/api-types-incidents';
import { SEVERITY_GLYPH, SEVERITY_LABEL, type Severity } from '@/components/br';
import { cn } from '@/lib/utils';

export const pathKey = (p: ReachPath) => `${p.projectId}|${p.assetId}|${p.nodes.map((n) => n.id).join('>')}`;

const SEV_BORDER: Record<Severity, string> = { critical: 'border-sev-critical', high: 'border-sev-high', medium: 'border-sev-medium', low: 'border-sev-low' };
const SEV_INK: Record<Severity, string> = { critical: 'text-sev-critical', high: 'text-sev-high', medium: 'text-sev-medium', low: 'text-sev-low' };

const scopeWord = (s: string) => (s === 'dev' ? 'dev' : s === 'optional' ? 'optional' : s === 'peer' ? 'peer' : s === 'build' ? 'build' : 'runtime');

export interface PathTreeProps {
  paths: readonly ReachPath[];
  /** Total paths known (the server caps the list it sends). */
  total?: number;
  level: Severity | null;
  selected: string | null;
  onSelect: (key: string) => void;
  perLane?: number;
}

function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const root = e.currentTarget.closest('[data-slot="path-tree"]');
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLButtonElement>('button[data-path-row]')];
  const i = rows.indexOf(e.currentTarget as HTMLButtonElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
  if (rows[next]) {
    e.preventDefault();
    rows[next].focus();
  }
}

function Lane({ title, prod, paths, level, selected, onSelect, perLane }: { title: string; prod: boolean; paths: readonly ReachPath[]; level: Severity | null; selected: string | null; onSelect: (k: string) => void; perLane: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? paths : paths.slice(0, perLane);
  const more = paths.length - shown.length;
  const id = `lane-${prod ? 'prod' : 'dev'}`;
  return (
    <section aria-labelledby={id} className="border-t first:border-t-0">
      <h3 id={id} className={cn('m-0 bg-muted px-3 py-1.5 text-eyebrow font-semibold tracking-[.08em] uppercase', prod ? 'text-reach-prod' : 'text-muted-foreground')}>
        {title} · {shown.length < paths.length ? `${shown.length} of ${paths.length} paths` : `${paths.length} ${paths.length === 1 ? 'path' : 'paths'}`}
      </h3>
      <ul className="m-0 list-none p-0">
        {shown.map((p) => {
          const k = pathKey(p);
          const on = selected === k;
          return (
            <li key={k} className="border-t first:border-t-0">
              <button
                type="button"
                data-path-row=""
                aria-pressed={on}
                aria-label={`${p.projectName} (${p.production ? 'production' : 'dev and test'}): ${p.nodes.map((n) => n.label).join(' → ')}`}
                onClick={() => onSelect(k)}
                onKeyDown={moveFocus}
                className={cn('block w-full px-3 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', on ? 'bg-selection-soft' : 'hover:bg-accent', !prod && 'opacity-95')}
              >
                <span className="flex h-6 items-center">
                  <span aria-hidden="true" className="mr-1 w-5 text-center text-text-secondary">
                    ▭
                  </span>
                  <span className="font-mono text-[12px]">{p.projectName}</span>
                  <span className="ml-2.5 text-caption text-muted-foreground">
                    project · {p.assetName} ({p.environment === 'prod' ? 'production' : p.environment})
                  </span>
                </span>
                {p.nodes.slice(1).map((n, i) => {
                  const last = i === p.nodes.length - 2;
                  const scope = scopeWord(p.scopes[i] ?? 'runtime');
                  return (
                    <span key={`${n.id}-${i}`} className="flex h-6 items-center" style={{ paddingLeft: `${(i + 1) * 20}px` }}>
                      <span aria-hidden="true" className={cn('mr-1 w-5 text-center', last && level ? `${SEV_INK[level]} font-semibold` : 'text-text-secondary')}>
                        {last && level ? SEVERITY_GLYPH[level] : '⬭'}
                      </span>
                      <span className={cn('font-mono text-[12px]', last && 'font-medium')}>{n.label}</span>
                      <span className="ml-2.5 text-caption text-muted-foreground">
                        {scope}
                        {i === 0 ? ' · direct' : ''}
                        {last && level ? ` · ${SEVERITY_LABEL[level]}` : ''}
                      </span>
                    </span>
                  );
                })}
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <div className="border-t px-3 py-2">
          <button type="button" onClick={() => setOpen(true)} className="h-6 rounded-[6px] border border-input bg-background px-2.5 text-label outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
            Show more paths (+{more})
          </button>
        </div>
      )}
    </section>
  );
}

export function PathTree({ paths, total, level, selected, onSelect, perLane = 3 }: PathTreeProps) {
  const prod = paths.filter((p) => p.production);
  const dev = paths.filter((p) => !p.production);
  return (
    <div data-slot="path-tree" className="overflow-hidden rounded-xl border">
      {prod.length > 0 && <Lane title="Production" prod paths={prod} level={level} selected={selected} onSelect={onSelect} perLane={perLane} />}
      {dev.length > 0 && <Lane title="Dev and test" prod={false} paths={dev} level={level} selected={selected} onSelect={onSelect} perLane={perLane} />}
      {total !== undefined && total > paths.length && <p className="m-0 border-t px-3 py-2 text-caption text-muted-foreground">Showing the first {paths.length} of {total} paths.</p>}
    </div>
  );
}

const EDGE_STYLE: Record<string, string> = { runtime: 'border-solid border-edge-runtime', peer: 'border-solid border-edge-runtime', build: 'border-solid border-edge-runtime', dev: 'border-dashed border-edge-dev', optional: 'border-dotted border-edge-optional' };

/** The selected path as a top-down chain (side rail). */
export function PathChain({ path, level, levelNote }: { path: ReachPath; level: Severity | null; levelNote?: string }) {
  return (
    <ol aria-label="Selected path" className="m-0 flex list-none flex-col p-0">
      <li className="flex flex-col">
        <span className="flex flex-col rounded-lg border border-node-border bg-node-surface px-2.5 py-2">
          <span className="font-mono text-[12px] font-medium">{path.projectName}</span>
          <span className="text-caption text-muted-foreground">
            project · {path.assetName} ({path.environment === 'prod' ? 'production' : path.environment})
          </span>
        </span>
      </li>
      {path.nodes.slice(1).map((n, i) => {
        const last = i === path.nodes.length - 2;
        const scope = scopeWord(path.scopes[i] ?? 'runtime');
        return (
          <li key={`${n.id}-${i}`} className="flex flex-col">
            <span className={cn('ml-[18px] border-l-2 py-1.5 pl-3 text-caption text-muted-foreground', EDGE_STYLE[scope])}>depends on ({scope})</span>
            <span
              className={cn(
                'flex flex-col rounded-lg bg-node-surface px-2.5 py-2',
                last && level ? `border-2 ${SEV_BORDER[level]}` : 'border border-node-border',
                i === 0 && path.nodes.length > 2 && 'shadow-[0_0_0_2px_var(--focus-path)]',
              )}
            >
              <span className="font-mono text-[12px] font-medium">{n.label}</span>
              <span className="text-caption text-muted-foreground">
                {last ? (level ? `${SEVERITY_GLYPH[level]} ${SEVERITY_LABEL[level]}${levelNote ? ` · ${levelNote}` : ''}` : 'the package') : i === 0 ? 'brought it in' : 'in between'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
