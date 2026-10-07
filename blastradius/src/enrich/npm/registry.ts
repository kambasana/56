/**
 * npm registry access: name validation, packument URL, memoised fetch.
 */
import type { HttpClient } from '../../core/http.js';
import type { Packument } from './types.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * npm package names: ≤214 chars, lower-case URL-safe characters, optional scope.
 * (Legacy packages may contain upper-case letters; they are accepted.)
 */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;

export function isValidNpmName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_NAME_RE.test(name) && !name.startsWith('.') && !name.startsWith('_');
}

/** Full-document URL: scoped names keep "@" and encode the slash ("@scope%2fname"). */
export function packumentUrl(name: string, registry: string = NPM_REGISTRY): string {
  if (!isValidNpmName(name)) throw new Error(`Invalid npm package name: ${JSON.stringify(name.slice(0, 220))}`);
  const base = registry.replace(/\/+$/, '');
  return `${base}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
}

/** Public package page (used as evidence). */
export function npmPackagePage(name: string, version?: string): string {
  return `https://www.npmjs.com/package/${name}${version ? `/v/${encodeURIComponent(version)}` : ''}`;
}

const memo = new WeakMap<HttpClient, Map<string, Promise<Packument | null>>>();

/**
 * Fetch a packument through the shared HttpClient. Concurrent requests for the same package
 * share one fetch; later ones are answered by the HttpClient's cache. Only the fields the
 * enrichers read are kept (slimPackument).
 * Returns null for unknown packages (404). Throws HttpError / OfflineMissError.
 */
export function fetchPackument(http: HttpClient, name: string, registry: string = NPM_REGISTRY): Promise<Packument | null> {
  const url = packumentUrl(name, registry);
  let byUrl = memo.get(http);
  if (!byUrl) {
    byUrl = new Map();
    memo.set(http, byUrl);
  }
  let p = byUrl.get(url);
  if (!p) {
    p = http.fetchJsonOrNull<unknown>(url).then((data) => (isObject(data) ? slimPackument(data) : null));
    // Only requests in flight are shared. A settled packument is not kept for the rest of the scan
    // (thousands of them do not fit in memory on a large monorepo); a later caller gets it again
    // from the HttpClient's disk cache. Failures are never kept either: a later caller may retry.
    const done = () => {
      if (byUrl.get(url) === p) byUrl.delete(url);
    };
    p.then(done, done);
    byUrl.set(url, p);
  }
  return p;
}

/** Top-level packument fields read by the npm and GitHub enrichers (see types.ts). */
const PACKUMENT_FIELDS = ['_id', 'name', 'dist-tags', 'versions', 'time', 'maintainers', 'repository'] as const;
/** Version-manifest fields read by the enrichers (see NpmVersionManifest). */
const MANIFEST_FIELDS = [
  'name',
  'version',
  '_npmUser',
  'maintainers',
  'scripts',
  'dependencies',
  'optionalDependencies',
  'repository',
  'funding',
  'deprecated',
  'gypfile',
  'hasInstallScript',
] as const;

function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(src, k)) out[k] = src[k];
  return out;
}

/**
 * Keep only the packument fields the enrichers read. Packuments are memoised for the whole scan
 * (the GitHub enricher reuses them), and a full one carries READMEs, descriptions, keywords and
 * every version's devDependencies, files, bin, engines and dist (tarball, integrity, signatures):
 * a large monorepo scan held thousands of them at once (2+ GB). Every derivation (packument.ts,
 * the GitHub repo lookup) sees exactly the same values for the fields it reads.
 */
export function slimPackument(data: Record<string, unknown>): Packument {
  const out = pick(data, PACKUMENT_FIELDS);
  if (isObject(data.versions)) {
    const versions: Record<string, unknown> = {};
    for (const [v, m] of Object.entries(data.versions)) {
      if (!isObject(m)) {
        versions[v] = m;
        continue;
      }
      const slim = pick(m, MANIFEST_FIELDS);
      if (Object.hasOwn(m, 'dist')) slim.dist = isObject(m.dist) ? pick(m.dist, ['attestations']) : m.dist;
      versions[v] = slim;
    }
    out.versions = versions;
  }
  return out as Packument;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
