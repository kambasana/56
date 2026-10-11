/**
 * Licence values from the package registry's own metadata (source "registry"), used to fill
 * releases deps.dev has no licence data for. Deterministic, declared by the author at upload:
 *   - PyPI JSON API, GET https://pypi.org/pypi/{name}/{version}/json: `info.license_expression`
 *     (PEP 639, SPDX), else `info.license` (a short string; full licence texts are skipped), else
 *     the "License ::" trove classifiers.
 *   - npm registry packument, GET https://registry.npmjs.org/{name}: `versions[v].license` (string
 *     or legacy {type}), else the legacy `licenses` array. Fetched through the shared packument
 *     fetch, so a scan that already read the packument for the npm enricher reuses it.
 */
import type { HttpClient } from '../../core/http.js';
import { fetchPackument, isValidNpmName, npmPackagePage } from '../npm/registry.js';
import type { DeclaredEntry } from '../../licenses/value.js';

export const PYPI_API = 'https://pypi.org';

/** Registry value of one release: declared entries and the URL that states them. */
export interface RegistryRelease {
  version: string;
  entries: DeclaredEntry[];
  evidence: string;
  /** Upload time the registry states (PyPI earliest file upload, npm `time[v]`), ISO. */
  publishedAt?: string;
}

/** Earliest `upload_time_iso_8601` of a PyPI release's files. */
export function pypiUploadTime(urls: unknown): string | undefined {
  const times = (Array.isArray(urls) ? urls : [])
    .map((u) => (u && typeof u === 'object' ? (u as { upload_time_iso_8601?: unknown }).upload_time_iso_8601 : undefined))
    .filter((t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0];
}

export function pypiVersionUrl(name: string, version: string, base: string = PYPI_API): string {
  return `${base.replace(/\/+$/, '')}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Declared entries from a PyPI release's `info` object (empty when it declares nothing usable). */
export function pypiLicenseEntries(info: unknown): DeclaredEntry[] {
  if (!info || typeof info !== 'object') return [];
  const i = info as { license?: unknown; license_expression?: unknown; classifiers?: unknown };
  const expression = str(i.license_expression);
  if (expression) return [{ raw: expression, spdx: expression }];
  const license = str(i.license);
  // A licence field holding the full licence text (multi-line or long) states no identifier.
  if (license && !/^unknown$/i.test(license) && license.length <= 100 && !/[\r\n]/.test(license)) return [{ raw: license }];
  const classifiers = (Array.isArray(i.classifiers) ? i.classifiers : [])
    .map(str)
    .filter((c) => c.startsWith('License :: '))
    .map((c) => c.slice('License :: '.length).replace(/^OSI Approved :: /, ''))
    .filter((c) => c && c !== 'OSI Approved');
  return [...new Set(classifiers)].slice(0, 20).map((raw) => ({ raw }));
}

/** Declared entries from an npm version manifest (`license`, else legacy `licenses`). */
export function npmLicenseEntries(manifest: unknown): DeclaredEntry[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as { license?: unknown; licenses?: unknown };
  const one = (v: unknown): string => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? str((v as { type?: unknown }).type) : '');
  const license = one(m.license);
  if (license) return [{ raw: license }];
  const list = (Array.isArray(m.licenses) ? m.licenses : []).map(one).filter(Boolean);
  return [...new Set(list)].slice(0, 20).map((raw) => ({ raw }));
}

/** deps.dev systems the registry metadata covers. */
export function registrySupports(system: string): boolean {
  return system === 'PYPI' || system === 'NPM';
}

/**
 * Registry values for the given releases of one package. Releases the registry does not know or
 * declares nothing for are left out. Throws HttpError / OfflineMissError like the HttpClient.
 */
export async function fetchRegistryReleases(http: HttpClient, system: string, name: string, versions: readonly string[], opts: { pypiBase?: string } = {}): Promise<RegistryRelease[]> {
  const out: RegistryRelease[] = [];
  if (system === 'NPM') {
    if (!isValidNpmName(name)) return out;
    const p = await fetchPackument(http, name);
    const all: Record<string, unknown> = p?.versions && typeof p.versions === 'object' ? p.versions : {};
    for (const v of versions) {
      if (!Object.hasOwn(all, v)) continue;
      const entries = npmLicenseEntries(all[v]);
      if (entries.length === 0) continue;
      const r: RegistryRelease = { version: v, entries, evidence: npmPackagePage(name, v) };
      const t = p?.time && typeof p.time === 'object' ? (p.time as Record<string, unknown>)[v] : undefined;
      if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) r.publishedAt = t;
      out.push(r);
    }
    return out;
  }
  if (system === 'PYPI') {
    for (const v of versions) {
      const url = pypiVersionUrl(name, v, opts.pypiBase);
      const res = await http.fetchJsonOrNull<{ info?: unknown; urls?: unknown }>(url);
      const entries = pypiLicenseEntries(res?.info);
      if (entries.length === 0) continue;
      const r: RegistryRelease = { version: v, entries, evidence: pypiVersionUrl(name, v) };
      const t = pypiUploadTime(res?.urls);
      if (t) r.publishedAt = t;
      out.push(r);
    }
  }
  return out;
}
