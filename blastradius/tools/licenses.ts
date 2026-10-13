/**
 * Licence check for both packages (docs/ARCHITECTURE.md §2.5; docs/REFACTOR.md).
 *
 *   npm run licenses        every package in package-lock.json and web/package-lock.json must have a
 *                           licence on the allow-list, or be listed in tools/license-exceptions.json
 *
 * Reads the lockfiles (npm records each package's declared licence there), so it needs no install
 * and runs in the engine job without installing the web app. Allow-list: MIT, ISC, Apache-2.0,
 * BSD-*, BlueOak-*, 0BSD, CC0-1.0; Python-2.0 for dev dependencies only (the dev tool chain).
 * SPDX expressions are evaluated: `A OR B` needs one allowed side, `A AND B` both.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parse, { type SpdxNode } from 'spdx-expression-parse';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCEPTIONS_FILE = path.join(ROOT, 'tools', 'license-exceptions.json');

export const LOCKFILES: Record<string, string> = { engine: 'package-lock.json', web: 'web/package-lock.json' };

const ALLOWED = /^(MIT|ISC|Apache-2\.0|BSD-[\w.-]+|BlueOak-[\w.-]+|0BSD|CC0-1\.0)$/;
const ALLOWED_DEV_ONLY = /^Python-2\.0$/;

export interface LicenseException {
  /** Package name; `*` matches any characters (lightningcss-* covers the platform binaries). */
  package: string;
  /** The licence expression as the lockfile records it; a different licence needs a new review. */
  license: string;
  /** engine, web, or both. */
  scope: 'engine' | 'web' | 'both';
  reason: string;
}

export interface LockedPackage {
  scope: 'engine' | 'web';
  name: string;
  version: string;
  license: string;
  dev: boolean;
}

export function licenseAllowed(expression: string, dev: boolean): boolean {
  let tree: SpdxNode;
  try {
    tree = parse(expression);
  } catch {
    return false;
  }
  const ok = (n: SpdxNode): boolean => {
    if ('license' in n) return ALLOWED.test(n.license) || (dev && ALLOWED_DEV_ONLY.test(n.license));
    return n.conjunction === 'or' ? ok(n.left) || ok(n.right) : ok(n.left) && ok(n.right);
  };
  return ok(tree);
}

function licenseOf(entry: { license?: unknown }, dir: string): string {
  if (typeof entry.license === 'string' && entry.license) return entry.license;
  // Older lockfiles may lack the field: fall back to the installed package.json when there is one.
  const pkg = path.join(dir, 'package.json');
  if (existsSync(pkg)) {
    const lic = (JSON.parse(readFileSync(pkg, 'utf8')) as { license?: unknown }).license;
    if (typeof lic === 'string' && lic) return lic;
  }
  return 'UNKNOWN';
}

export function lockedPackages(): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const [scope, file] of Object.entries(LOCKFILES) as ['engine' | 'web', string][]) {
    const lock = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as { packages: Record<string, { name?: string; version?: string; license?: unknown; dev?: boolean; link?: boolean }> };
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '' || entry.link) continue; // the package itself, workspace links
      const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ scope, name, version: entry.version ?? '?', license: licenseOf(entry, path.join(ROOT, path.dirname(file), key)), dev: entry.dev === true });
    }
  }
  return out;
}

function exceptionMatches(e: LicenseException, p: LockedPackage): boolean {
  const name = new RegExp(`^${e.package.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return name.test(p.name) && e.license === p.license && (e.scope === 'both' || e.scope === p.scope);
}

function main(): number {
  const t0 = Date.now();
  const exceptions = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')) as { exceptions: LicenseException[] };
  const packages = lockedPackages();
  const used = new Map<LicenseException, string[]>();
  const failures: string[] = [];
  let excepted = 0;
  for (const p of packages) {
    if (licenseAllowed(p.license, p.dev)) continue;
    const e = exceptions.exceptions.find((x) => exceptionMatches(x, p));
    const line = `${p.scope}: ${p.name}@${p.version} (${p.license}${p.dev ? ', dev' : ''})`;
    if (e) {
      used.set(e, [...(used.get(e) ?? []), `${p.scope}:${p.name}@${p.version}`]);
      excepted++;
    } else failures.push(line);
  }
  for (const e of exceptions.exceptions) if (!used.has(e)) console.log(`licenses: exception no longer needed (remove it): ${e.package} ${e.license} (${e.scope})`);
  for (const [e, hits] of used) console.log(`licenses: exception ${e.package} (${e.license}, ${e.scope}): ${hits.length} package(s), e.g. ${hits.slice(0, 2).join(', ')}`);
  for (const f of failures) console.log(`NOT ALLOWED ${f}`);
  console.log(`licenses: ${failures.length === 0 ? 'ok' : 'FAILED'}: ${packages.length} package(s) in ${Object.keys(LOCKFILES).length} lockfile(s), ${excepted} by exception, ${failures.length} not allowed (${Date.now() - t0} ms)`);
  if (failures.length > 0) console.log('licenses: replace the dependency, or add a reviewed exception with a reason to tools/license-exceptions.json (docs/REFACTOR.md).');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
