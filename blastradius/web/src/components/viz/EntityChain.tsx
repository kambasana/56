/**
 * EntityChain (design system: EntityChain): who is behind a package, drawn top-down in SVG.
 * Shape says the type (pill package, circle account or person, square organisation, diamond
 * funder, rounded rectangle repository); line style says confidence (solid High, dashed Medium,
 * dotted Low) and the word is always written too. Nodes are buttons (Tab, Enter); "+N" expands a
 * node's links. The page's Table toggle is the accessible equivalent.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { confidenceWord, relationText, type ChainLayout, type ChainNode } from './entity';

const DASH: Record<string, string | undefined> = { High: undefined, Medium: '6 4', Low: '2 3' };
const STROKE: Record<string, string> = { High: 'stroke-edge-runtime', Medium: 'stroke-edge-dev', Low: 'stroke-edge-optional' };

function Shape({ n, selected }: { n: ChainNode; selected: boolean }) {
  const cls = cn('fill-node-surface [stroke-width:1.5]', n.depth === 0 ? 'stroke-focus-path [stroke-width:2]' : 'stroke-node-border', selected && 'stroke-focus-path [stroke-width:3]');
  switch (n.kind) {
    case 'package':
      return <rect x={n.x - 60} y={n.y - 15} width={120} height={30} rx={15} className={cls} />;
    case 'org':
      return <rect x={n.x - 16} y={n.y - 16} width={32} height={32} rx={3} className={cls} />;
    case 'funder':
      return <rect x={n.x - 12} y={n.y - 12} width={24} height={24} transform={`rotate(45 ${n.x} ${n.y})`} className={cls} />;
    case 'repo':
      return <rect x={n.x - 22} y={n.y - 14} width={44} height={28} rx={7} className={cls} />;
    default:
      return <circle cx={n.x} cy={n.y} r={16} className={cls} />;
  }
}

export interface EntityChainProps {
  layout: ChainLayout;
  selected: string | null;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  summary: string;
  /** Rendered over the canvas, bottom right (legend). */
  legend?: ReactNode;
}

export function EntityChain({ layout, selected, onSelect, onExpand, summary, legend }: EntityChainProps) {
  const byId = new Map(layout.nodes.map((n) => [n.id, n] as const));
  const key = (e: KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
  return (
    <div data-slot="entity-chain" className="relative overflow-auto rounded-xl border bg-recessed">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ minWidth: 560, maxHeight: 620 }} role="group" aria-label={summary}>
        {layout.nodes
          .filter((n) => n.link)
          .map((n) => {
            const parent = byId.get(n.link!.from);
            if (!parent) return null;
            const word = confidenceWord(n.link!.confidence);
            const midX = (parent.x + n.x) / 2;
            const midY = (parent.y + n.y) / 2;
            return (
              <g key={`e-${n.id}`}>
                <line x1={parent.x} y1={parent.y + 16} x2={n.x} y2={n.y - 18} className={cn(STROKE[word], word === 'High' ? '[stroke-width:2]' : '[stroke-width:1.5]')} strokeDasharray={DASH[word]} />
                <text x={midX + 6} y={midY} className="fill-text-secondary text-[11.5px]">
                  {relationText(n.link!.relation)} · {word}
                </text>
              </g>
            );
          })}
        {layout.nodes.map((n) => {
          const sel = selected === n.id;
          const sources = n.link ? n.link.evidence.length : 0;
          return (
            <g key={n.id}>
              <g
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                aria-label={`${n.label}${n.link ? `: ${relationText(n.link.relation)}, ${confidenceWord(n.link.confidence)} confidence, ${sources} ${sources === 1 ? 'source' : 'sources'}` : ''}. Show details.`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => key(e, () => onSelect(n.id))}
                className="cursor-pointer outline-none focus-visible:[&>*:first-child]:stroke-ring focus-visible:[&>*:first-child]:[stroke-width:3]"
              >
                <Shape n={n} selected={sel} />
                {n.kind === 'package' ? (
                  <text x={n.x} y={n.y + 4} textAnchor="middle" className="fill-foreground font-mono text-[12px] font-medium">
                    {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
                  </text>
                ) : (
                  <>
                    <text x={n.x} y={n.y + 36} textAnchor="middle" className="fill-foreground text-[12px] font-medium">
                      {n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label}
                    </text>
                    {n.link && (
                      <text x={n.x} y={n.y + 51} textAnchor="middle" className="fill-muted-foreground text-[11.5px]">
                        {sources} {sources === 1 ? 'source' : 'sources'}
                        {!n.link.reviewed && n.link.confidence < 0.8 ? ' · Unreviewed' : ''}
                      </text>
                    )}
                  </>
                )}
              </g>
              {n.hidden > 0 && (
                <g role="button" tabIndex={0} aria-label={`Show ${n.hidden} more ${n.hidden === 1 ? 'link' : 'links'} from ${n.label}`} onClick={() => onExpand(n.id)} onKeyDown={(e) => key(e, () => onExpand(n.id))} className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-ring focus-visible:[&>rect]:[stroke-width:3]">
                  <rect x={n.x + (n.kind === 'package' ? 66 : 24)} y={n.y - 10} width={44} height={20} rx={10} className="fill-background stroke-input" />
                  <text x={n.x + (n.kind === 'package' ? 88 : 46)} y={n.y + 4} textAnchor="middle" className="fill-foreground text-[11px] font-semibold">
                    +{n.hidden}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {legend}
    </div>
  );
}
