/**
 * Scenario edits to package.json and package-lock.json (v1, v2 and v3): add or bump one direct
 * dependency to an exact version, as `npm install name@version --save-exact` would record it
 * (resolved URL and integrity included). Used to push "a lockfile change" to a simulated repo.
 */

export interface LockedPackage {
  name: string;
  version: string;
  /** Tarball URL (default: the npm registry's). */
  resolved?: string;
  /** sha512 SRI of the tarball, when known. */
  integrity?: string;
  dev?: boolean;
}

export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1]! : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/** Keep key order and the file's indentation; sort the dependency map as npm does. */
function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function indentOf(text: string): string | number {
  const m = /^\{\r?\n([ \t]+)"/.exec(text);
  return m ? m[1]! : 2;
}

export function bumpPackageJson(text: string, pkg: LockedPackage): string {
  const j = JSON.parse(text) as Record<string, any>;
  const field = pkg.dev ? 'devDependencies' : 'dependencies';
  const other = pkg.dev ? 'dependencies' : 'devDependencies';
  if (j[other]?.[pkg.name] !== undefined) delete j[other][pkg.name];
  j[field] = sortKeys({ ...(j[field] ?? {}), [pkg.name]: pkg.version });
  return `${JSON.stringify(j, null, indentOf(text))}\n`;
}

export function bumpLockfile(text: string, pkg: LockedPackage): string {
  const j = JSON.parse(text) as Record<string, any>;
  const entry = {
    version: pkg.version,
    resolved: pkg.resolved ?? tarballUrl(pkg.name, pkg.version),
    ...(pkg.integrity ? { integrity: pkg.integrity } : {}),
    ...(pkg.dev ? { dev: true } : {}),
  };
  const v = Number(j.lockfileVersion ?? 1);
  if (v >= 2) {
    j.packages ??= {};
    const root = (j.packages[''] ??= {});
    const field = pkg.dev ? 'devDependencies' : 'dependencies';
    root[field] = sortKeys({ ...(root[field] ?? {}), [pkg.name]: pkg.version });
    j.packages = sortPackages({ ...j.packages, [`node_modules/${pkg.name}`]: entry });
  }
  if (v <= 2) {
    // v1 tree (v2 keeps it for older npm).
    j.dependencies = sortKeys({ ...(j.dependencies ?? {}), [pkg.name]: entry });
  }
  return `${JSON.stringify(j, null, indentOf(text))}\n`;
}

function sortPackages(p: Record<string, unknown>): Record<string, unknown> {
  const { '': root, ...rest } = p;
  return { ...(root !== undefined ? { '': root } : {}), ...sortKeys(rest) };
}

/** "name@version" (scoped names too) → { name, version }. */
export function parseSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`expected name@version, got ${spec}`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}
