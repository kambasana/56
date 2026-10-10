/** Package queries for ⌘K and the package page (pure, tested). */
import type { SearchExposureResponse } from '@server/api-types';
import type { VerdictData } from '@/components/br/Verdict';

/**
 * "lodash@4.17.20", "@scope/pkg@1.0.0" or "lodash 4.17.20": in both forms the version must start
 * with a digit, optionally after "v" (exact versions only: the exposure search compares them
 * literally, so "lodash@latest" would match nothing). Returns null for anything else.
 */
export function parsePackageQuery(q: string): { name: string; version: string } | null {
  const s = q.trim();
  const at = /^(@?[^@\s]+)@v?(\d[^@\s]*)$/.exec(s);
  if (at) return { name: at[1]!, version: at[2]! };
  const sp = /^(@?[^@\s]+)\s+v?(\d[^\s]*)$/.exec(s);
  if (sp) return { name: sp[1]!, version: sp[2]! };
  return null;
}

/** Verdict numbers from an exposure search response. */
export function verdictFrom(res: SearchExposureResponse): VerdictData {
  const projects = new Map<string, { name: string; production: boolean }>();
  for (const i of res.items) {
    const p = projects.get(i.projectId);
    projects.set(i.projectId, { name: i.projectName, production: (p?.production ?? false) || i.production });
  }
  const list = [...projects.values()].sort((a, b) => Number(b.production) - Number(a.production) || a.name.localeCompare(b.name));
  const prod = list.filter((p) => p.production);
  const dev = list.filter((p) => !p.production);
  const parts = [prod.length ? `${prod.map((p) => p.name).join(', ')} (production)` : '', dev.length ? `${dev.map((p) => p.name).join(', ')} (dev and test)` : ''].filter(Boolean);
  return {
    pkg: res.query.version ? `${res.query.name}@${res.query.version}` : res.query.name,
    projects: list.length,
    production: prod.length,
    searched: res.projectsSearched,
    ...(parts.length ? { detail: parts.join('; ') } : {}),
  };
}

