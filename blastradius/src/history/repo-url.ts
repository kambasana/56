/**
 * Which declared repository URLs the history enricher may clone (Tier 0.5). Funding and site pages
 * (github.com/sponsors/encode, which deps.dev listed as uvicorn's SOURCE_REPO, and opencollective.com)
 * are decided by the shared check in src/core/repo-url.ts; this module only adds the shape the clone
 * cache accepts (an https repository on github.com, gitlab.com or bitbucket.org).
 */
import { isNonRepositoryUrl } from '../core/repo-url.js';

/** GitLab / Bitbucket first path segments that are site pages. */
const OTHER_RESERVED = new Set(['explore', 'users', 'groups', 'dashboard', 'help', 'search', 'account', 'blog', 'product']);

/** True for `https://host/owner/name` on github.com, gitlab.com or bitbucket.org that is not a funding or site page. */
export function isHistoryRepoUrl(url: string): boolean {
  if (isNonRepositoryUrl(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'github.com') return true;
  if (host === 'gitlab.com' || host === 'bitbucket.org') return !OTHER_RESERVED.has(parts[0]!.toLowerCase());
  return false;
}

/** A funding or site page rather than a repository (labels: never "the repository"). */
export function isFundingUrl(url: string): boolean {
  return isNonRepositoryUrl(url);
}
