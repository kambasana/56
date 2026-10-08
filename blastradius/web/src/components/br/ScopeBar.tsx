/**
 * ScopeBar: which projects, environment and time range a page covers. It sits under the page
 * title on Overview, Findings and Incidents, lives in the URL and carries across those pages
 * (the sidebar keeps SCOPE_PARAMS on its links: see scopeSearch()).
 *
 * URL: `projects=<id>,<id>` (absent = all projects), `env=prod|dev` (absent = production and
 * dev), `range=7d|30d|90d|all` (absent = 30d). Each change pushes a history entry.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown } from 'lucide-react';
import type { ProjectRef } from '@server/api-types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { readList, useUpdateParams } from './url-state';

export type ScopeEnv = 'all' | 'prod' | 'dev';
export type ScopeRange = '7d' | '30d' | '90d' | 'all';

export interface Scope {
  /** Selected project ids; empty means every project. */
  projects: string[];
  env: ScopeEnv;
  range: ScopeRange;
}

/** The search params ScopeBar owns. */
export const SCOPE_PARAMS = ['projects', 'env', 'range'] as const;
export const DEFAULT_SCOPE: Scope = { projects: [], env: 'all', range: '30d' };

export const ENV_LABEL: Record<ScopeEnv, string> = { all: 'Production and dev', prod: 'Production', dev: 'Dev and test' };
export const RANGE_LABEL: Record<ScopeRange, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' };

const ENVS = Object.keys(ENV_LABEL) as ScopeEnv[];
const RANGES = Object.keys(RANGE_LABEL) as ScopeRange[];

export function parseScope(sp: URLSearchParams): Scope {
  const env = sp.get('env');
  const range = sp.get('range');
  return {
    projects: readList(sp, 'projects'),
    env: env && (ENVS as string[]).includes(env) ? (env as ScopeEnv) : DEFAULT_SCOPE.env,
    range: range && (RANGES as string[]).includes(range) ? (range as ScopeRange) : DEFAULT_SCOPE.range,
  };
}

/** Only the scope params of `sp`, as "?…" (or "" when all are default). For carrying scope in links. */
export function scopeSearch(sp: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of SCOPE_PARAMS) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** The page's scope from the URL, and a setter that pushes history. */
export function useScope(): [Scope, (patch: Partial<Scope>) => void] {
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const scope = useMemo(() => parseScope(sp), [sp]);
  const set = (patch: Partial<Scope>) =>
    update({
      ...(patch.projects !== undefined ? { projects: patch.projects } : {}),
      ...(patch.env !== undefined ? { env: patch.env === DEFAULT_SCOPE.env ? null : patch.env } : {}),
      ...(patch.range !== undefined ? { range: patch.range === DEFAULT_SCOPE.range ? null : patch.range } : {}),
    });
  return [scope, set];
}

export function projectsLabel(selected: readonly string[], projects: readonly ProjectRef[]): string {
  if (selected.length === 0) return 'All projects';
  if (selected.length === 1) return projects.find((p) => p.id === selected[0])?.name ?? '1 project';
  return `${selected.length} projects`;
}

export interface ScopeBarProps {
  /** Projects the viewer can pick from. */
  projects: readonly ProjectRef[];
  /** Hide the time control on pages where time does not apply. */
  showRange?: boolean;
  className?: string;
}

function Trigger({ label, name }: { label: string; name: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-label font-normal" aria-label={`${name}: ${label}`}>
        {label}
        <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
  );
}

export function ScopeBar({ projects, showRange = true, className }: ScopeBarProps) {
  const [scope, setScope] = useScope();
  const toggleProject = (id: string, on: boolean) => {
    const next = on ? [...scope.projects, id] : scope.projects.filter((p) => p !== id);
    setScope({ projects: projects.filter((p) => next.includes(p.id)).map((p) => p.id) });
  };
  return (
    <div role="group" aria-label="Scope" data-slot="scope-bar" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <DropdownMenu>
        <Trigger name="Projects" label={projectsLabel(scope.projects, projects)} />
        <DropdownMenuContent align="start" className="max-h-80 min-w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setScope({ projects: [] })} disabled={scope.projects.length === 0}>
            All projects
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {projects.map((p) => (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={scope.projects.includes(p.id)}
              onCheckedChange={(on) => toggleProject(p.id, on === true)}
              onSelect={(e) => e.preventDefault()}
            >
              {p.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <Trigger name="Environment" label={ENV_LABEL[scope.env]} />
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={scope.env} onValueChange={(v) => setScope({ env: v as ScopeEnv })}>
            {ENVS.map((e) => (
              <DropdownMenuRadioItem key={e} value={e}>
                {ENV_LABEL[e]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {showRange && (
        <DropdownMenu>
          <Trigger name="Time" label={RANGE_LABEL[scope.range]} />
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={scope.range} onValueChange={(v) => setScope({ range: v as ScopeRange })}>
              {RANGES.map((r) => (
                <DropdownMenuRadioItem key={r} value={r}>
                  {RANGE_LABEL[r]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
