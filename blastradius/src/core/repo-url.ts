/**
 * Shared URL checks (Tier 0.5). Pure; no I/O.
 *
 * - `isNonRepositoryUrl`: a URL that names a page on a code host or a funding platform, never a
 *   source repository. deps.dev lists `https://github.com/sponsors/encode` as uvicorn 0.52.0's
 *   SOURCE_REPO; read as owner "sponsors", repository "encode", it was cloned (and failed). Every
 *   place that turns a declared URL into a repository to read or clone checks this first.
 * - `nonRegistryTarball`: a lockfile `resolved` URL that is not a registry tarball (xlsx 0.20.3 from
 *   cdn.sheetjs.com), so advisory ranges written for registry releases may not apply.
 */

/**
 * First path segments on github.com that are site pages, not owners: /sponsors/<x>, /orgs/<x>,
 * /apps/<x>, /marketplace/… (GitHub reserves these names; no account can take them).
 */
const GITHUB_RESERVED = new Set([
  'sponsors',
  'orgs',
  'apps',
  'marketplace',
  'features',
  'topics',
  'collections',
  'settings',
  'notifications',
  'explore',
  'trending',
  'site',
  'about',
  'pricing',
  'enterprise',
  'security',
  'login',
  'join',
  'users',
  'search',
  'customer-stories',
  'readme',
  'events',
]);

/** Funding and donation platforms: a link there is a funding page, never a repository. */
const FUNDING_HOSTS = new Set([
  'opencollective.com',
  'patreon.com',
  'ko-fi.com',
  'liberapay.com',
  'tidelift.com',
  'buymeacoffee.com',
  'www.buymeacoffee.com',
  'paypal.me',
  'paypal.com',
  'www.paypal.com',
  'thanks.dev',
  'polar.sh',
  'issuehunt.io',
  'funding.communitybridge.org',
  'lfx.linuxfoundation.org',
]);

function parse(input: string): URL | undefined {
  let s = input.trim().replace(/^git\+/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

/** True when `url` is a funding page or a code-host site page (github.com/sponsors/<x>, opencollective.com/<x>, …). */
export function isNonRepositoryUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (FUNDING_HOSTS.has(host) || FUNDING_HOSTS.has(u.hostname.toLowerCase())) return true;
  const first = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (host === 'github.com' && first !== undefined && GITHUB_RESERVED.has(first)) return true;
  // github.com/<owner>/<repo>?sponsor=1 is the sponsor button of a repository, not the repository.
  if (host === 'github.com' && u.searchParams.has('sponsor')) return true;
  return false;
}

/**
 * The host a lockfile installs `name` from when that is not a registry tarball, else undefined.
 * A registry tarball has the layout `<registry>/<name>/-/<file>.tgz` (npm, yarn, GitHub Packages,
 * Artifactory and Verdaccio mirrors all keep it), so a private registry counts as a registry. Git
 * and GitHub release URLs are reported the same way (their versions are not registry versions).
 */
export function nonRegistryTarball(name: string, resolved: string | undefined): { host: string; url: string } | undefined {
  if (!resolved) return undefined;
  const u = parse(resolved);
  if (!u || !/^(https?|git|ssh|git\+ssh|git\+https):$/.test(u.protocol)) return undefined;
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  if (/^https?:$/.test(u.protocol) && path.includes(`/${name}/-/`)) return undefined;
  return { host: u.hostname.toLowerCase(), url: `${u.protocol}//${u.host}${u.pathname}`.slice(0, 500) };
}

/**
 * A product name for a scan target, never an absolute path (Tier 0.5: CycloneDX
 * `metadata.component.name` was the scan machine's directory): the repository name of a git URL
 * (`https://github.com/parse-community/parse-server.git` → "parse-server"), else the directory's own
 * name (`/tmp/…/targets/jitsi-meet` → "jitsi-meet").
 */
export function productNameOf(target: string): string {
  const t = target.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const last = t.split(/[/\\:]/).filter(Boolean).pop();
  return (last ?? 'project').slice(0, 200) || 'project';
}
