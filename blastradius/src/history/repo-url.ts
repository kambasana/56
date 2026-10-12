/**
 * Which declared repository URLs are source repositories the history enricher may clone (Tier 0.5).
 *
 * Registries carry funding and profile links in their repository / project-URL fields: flask's
 * dependencies declared https://github.com/sponsors/encode, which the history enricher tried to
 * clone. GitHub reserves these first path segments for its own pages (sponsors, orgs, users,
 * marketplace, …): no repository lives under them. Funding platforms are never repositories.
 */

/** GitHub first path segments that are site pages, not repository owners (github.com/sponsors/x, github.com/orgs/x). */
const GITHUB_RESERVED = new Set([
  'sponsors', 'orgs', 'users', 'apps', 'marketplace', 'features', 'topics', 'collections', 'settings', 'about', 'site',
  'login', 'join', 'enterprise', 'pricing', 'security', 'readme', 'explore', 'trending', 'notifications', 'codespaces',
  'issues', 'pulls', 'search', 'events', 'customer-stories', 'contact', 'pages', 'blog', 'team', 'organizations',
]);

/** GitLab / Bitbucket first path segments that are site pages. */
const OTHER_RESERVED = new Set(['explore', 'users', 'groups', 'dashboard', 'help', 'search', 'account', 'blog', 'product']);

/** Funding and donation platforms (never a source repository). */
const FUNDING_HOST_RE = /(^|\.)(opencollective\.com|patreon\.com|ko-fi\.com|liberapay\.com|tidelift\.com|buymeacoffee\.com|polar\.sh|paypal\.(com|me)|thanks\.dev|issuehunt\.io|funding\.communitybridge\.org)$/i;

/**
 * True for an https URL of a repository on github.com, gitlab.com or bitbucket.org
 * (`https://host/owner/name`) whose owner segment is not a site page such as /sponsors/ or /orgs/.
 */
export function isHistoryRepoUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || FUNDING_HOST_RE.test(u.hostname)) return false;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return false;
  const owner = parts[0]!.toLowerCase();
  const host = u.hostname.toLowerCase();
  if (host === 'github.com') return !GITHUB_RESERVED.has(owner);
  if (host === 'gitlab.com' || host === 'bitbucket.org') return !OTHER_RESERVED.has(owner);
  return false;
}

/** A funding / sponsorship page rather than a repository (for labels: never "the repository"). */
export function isFundingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (FUNDING_HOST_RE.test(u.hostname)) return true;
    const owner = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    return u.hostname.toLowerCase() === 'github.com' && owner === 'sponsors';
  } catch {
    return false;
  }
}
