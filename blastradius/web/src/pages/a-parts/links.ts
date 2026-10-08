/**
 * Links from these screens to pages owned elsewhere (package reach, who's behind it, incidents).
 * Kept in one place so a route rename is a one-line change.
 */
import { packagePath } from '@/nav';

/** The package reach page (every project and path). */
export function reachPath(name: string, version?: string | null): string {
  return packagePath(name, version);
}

/** Who's behind a package (entity chain page). */
export function behindPath(name: string, version?: string | null): string {
  const q = new URLSearchParams({ name });
  if (version) q.set('version', version);
  return `/packages/behind?${q}`;
}

/** One incident: an advisory that hit a package. */
export function incidentPath(advisoryId: string): string {
  return `/incidents/${encodeURIComponent(advisoryId)}`;
}

/** "GHSA-…", "CVE-…", "MAL-…", "INC-…" ids in text or URLs, first seen first. */
export function advisoryIds(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(/\b(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,}|MAL-\d{4}-\d+|INC-\d{4}-\d+)\b/gi)) {
      const raw = m[1]!;
      const norm = /^ghsa/i.test(raw) ? `GHSA${raw.slice(4).toLowerCase()}` : raw.toUpperCase();
      if (!out.includes(norm)) out.push(norm);
    }
  }
  return out;
}
