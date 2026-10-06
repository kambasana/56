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
 * Fetch a packument through the shared HttpClient. Results are memoised per
 * client, so the GitHub enricher can reuse what the npm enricher fetched.
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
    p = http.fetchJsonOrNull<unknown>(url).then((data) => (isObject(data) ? (data as Packument) : null));
    // Do not memoise failures: a later caller may retry.
    p.catch(() => byUrl.delete(url));
    byUrl.set(url, p);
  }
  return p;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
