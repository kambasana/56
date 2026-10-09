/**
 * Verdict: the answer to "is it anywhere?", given before any list (top of ⌘K results and package
 * pages). It leads with the answer and is one link that opens with Enter.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

export interface VerdictData {
  /** "name@version" or "name". */
  pkg: string;
  /** Projects the package is in. */
  projects: number;
  /** Of those, how many run it in production. */
  production: number;
  /** Projects searched (for the not-found answer). */
  searched: number;
  /** Advisory id, e.g. "GHSA-pjwm-rvh2-c87w". */
  advisory?: string;
  /** One line after the answer, e.g. the project names. */
  detail?: ReactNode;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Yes, it is here: 3 projects, 1 in production" / "Not found in any of 42 projects". */
export function verdictHeadline({ projects, production, searched }: Pick<VerdictData, 'projects' | 'production' | 'searched'>): string {
  if (projects > 0) return `Yes, it is here: ${plural(projects, 'project')}, ${production} in production`;
  return searched === 1 ? 'Not found in the 1 project searched' : `Not found in any of ${plural(searched, 'project')}`;
}

/** The verdict's body without the link (for use inside a cmdk item, which owns Enter). */
export function VerdictContent({ data, actionLabel }: { data: VerdictData; actionLabel?: string }) {
  const found = data.projects > 0;
  return (
    <span data-slot="verdict" data-found={found} className="flex w-full flex-col gap-1">
      <span className="flex items-center gap-2">
        <strong className={cn('font-semibold', !found && 'text-success')}>
          {!found && <span aria-hidden="true">✓ </span>}
          {verdictHeadline(data)}
        </strong>
        {actionLabel && (
          <span className={cn('ml-auto text-label font-semibold whitespace-nowrap', found ? 'text-sev-critical' : 'text-selection')}>
            {actionLabel} <span aria-hidden="true">↵</span>
          </span>
        )}
      </span>
      <span className="text-text-secondary">
        <span className="font-mono text-[12px]">{data.pkg}</span>
        {data.advisory && <> ({data.advisory})</>}
        {data.detail && <>. {data.detail}</>}
      </span>
    </span>
  );
}

export function verdictSurface(found: boolean): string {
  return found ? 'bg-sev-critical-soft' : 'bg-success-soft';
}

export interface VerdictProps {
  data: VerdictData;
  /** The incident or package page. */
  to: string;
  /** Defaults to "Open incident" when found, "Open package" otherwise. */
  actionLabel?: string;
  className?: string;
}

export function Verdict({ data, to, actionLabel, className }: VerdictProps) {
  const found = data.projects > 0;
  return (
    <Link
      to={to}
      data-slot="verdict-link"
      className={cn('flex rounded-lg p-3 text-foreground no-underline outline-none hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring', verdictSurface(found), className)}
    >
      <VerdictContent data={data} actionLabel={actionLabel ?? (found ? 'Open incident' : 'Open package')} />
    </Link>
  );
}
