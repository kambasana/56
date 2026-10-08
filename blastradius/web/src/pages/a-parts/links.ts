/**
 * Links from these screens to pages owned elsewhere (package reach, who's behind it, incidents,
 * exposure). They delegate to the route helpers in nav.ts so the paths and params always match.
 * Kept in one place so a route rename is a one-line change.
 */
import { behindPath as navBehindPath, exposurePath as navExposurePath, incidentPath as navIncidentPath, packagePath } from '@/nav';

/** The package reach page (every project and path): /packages?name=&version=. */
export function reachPath(name: string, version?: string | null): string {
  return packagePath(name, version);
}

/** Who's behind a package (entity chain page). /packages/behind reads `name` only: links are per package, not per version. */
export function behindPath(name: string): string {
  return navBehindPath(name);
}

/** One incident. Its id is the advisory id exactly as the alert stored it (GET /api/incidents/:id). */
export function incidentPath(advisoryId: string): string {
  return navIncidentPath(advisoryId);
}

/** The org-wide Exposure matrix, optionally narrowed to some projects (?projects=a,b). */
export function exposurePath(projectIds: readonly string[] = []): string {
  return navExposurePath(projectIds);
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
