/**
 * Static npm manifest / lockfile parsers (package.json, package-lock.json v1–v3,
 * npm-shrinkwrap.json). Nothing here executes or installs anything; lockfile
 * content is untrusted and is size-capped and validated before use.
 */
import { npmPurl, type Component, type DepEdge, type DepScope, type Purl, formatPurl, splitNpmName } from '../core/types.js';
import { cap, isRecord, own, stringEntries } from './fs.js';

export type ManifestSection = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

const SECTION_SCOPE: Record<ManifestSection, DepScope> = {
  dependencies: 'runtime',
  devDependencies: 'dev',
  optionalDependencies: 'optional',
  peerDependencies: 'peer',
};
const SECTIONS = Object.keys(SECTION_SCOPE) as ManifestSection[];

/** Precedence when the same dependency appears in several sections (strongest exposure first). */
const SCOPE_RANK: Record<DepScope, number> = { runtime: 0, build: 1, peer: 2, optional: 3, dev: 4 };

export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

export interface PackageManifest {
  name?: string;
  version?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  /** Install-time hooks the manifest declares (never executed). */
  installHooks: string[];
  /** Workspace globs, if any. */
  workspaces: string[];
  private?: boolean;
}

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;
export function isValidNpmName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_NAME_RE.test(name) && !/^[._]/.test(name) && !/\/[._]/.test(name);
}

const MAX_VERSION = 256;
const MAX_URL = 2048;
const MAX_INTEGRITY = 1024;

/** Parse a package.json text. Throws on invalid JSON. */
export function parsePackageJson(text: string): PackageManifest {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('package.json is not an object');
  const m: PackageManifest = {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    installHooks: [],
    workspaces: [],
  };
  const name = own(raw, 'name');
  if (typeof name === 'string' && isValidNpmName(name)) m.name = name.toLowerCase();
  const version = own(raw, 'version');
  if (typeof version === 'string') m.version = cap(version, MAX_VERSION);
  if (own(raw, 'private') === true) m.private = true;
  for (const s of SECTIONS) {
    for (const [k, v] of stringEntries(own(raw, s))) {
      if (isValidNpmName(k)) m[s][k.toLowerCase()] = cap(v, MAX_URL);
    }
  }
  const scripts = own(raw, 'scripts');
  for (const hook of INSTALL_HOOKS) {
    if (typeof own(scripts, hook) === 'string') m.installHooks.push(hook);
  }
  const ws = own(raw, 'workspaces');
  const wsList = Array.isArray(ws) ? ws : own<unknown[]>(ws, 'packages');
  if (Array.isArray(wsList)) for (const w of wsList) if (typeof w === 'string') m.workspaces.push(cap(w, 512));
  return m;
}

/** Direct dependencies of a manifest as [name, spec, scope], deduplicated by strongest scope. */
export function manifestDeps(m: PackageManifest): { name: string; spec: string; scope: DepScope }[] {
  const byName = new Map<string, { name: string; spec: string; scope: DepScope }>();
  for (const s of SECTIONS) {
    for (const [name, spec] of Object.entries(m[s])) {
      const scope = SECTION_SCOPE[s];
      const prev = byName.get(name);
      if (!prev || SCOPE_RANK[scope] < SCOPE_RANK[prev.scope]) byName.set(name, { name, spec, scope });
    }
  }
  return [...byName.values()];
}

const EXACT_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * For a manifest without a lockfile: components for direct deps pinned to an exact
 * version (or an `npm:name@x.y.z` alias). Ranges cannot be resolved statically.
 */
export function componentsFromManifest(
  m: PackageManifest,
  assetId: string,
): { components: Component[]; edges: DepEdge[]; unresolved: string[] } {
  const components: Component[] = [];
  const edges: DepEdge[] = [];
  const unresolved: string[] = [];
  for (const { name, spec, scope } of manifestDeps(m)) {
    let realName = name;
    let ver = spec.trim();
    const alias = /^npm:(.+)@([^@]+)$/.exec(ver);
    if (alias) {
      realName = alias[1]!.toLowerCase();
      ver = alias[2]!;
    }
    const exact = EXACT_VERSION_RE.exec(ver);
    if (!exact || !isValidNpmName(realName)) {
      unresolved.push(name);
      continue;
    }
    const purl = npmPurl(realName, exact[1]!);
    components.push({ purl, ecosystem: 'npm', name: realName, version: exact[1]! });
    edges.push({ from: assetId, to: purl, scope, direct: true });
  }
  return { components, edges, unresolved };
}

// ---------------------------------------------------------------------------
// package-lock.json
// ---------------------------------------------------------------------------

export interface LockfileParseOptions {
  /**
   * Map a lockfile importer (package root relative to the lockfile directory:
   * "" for the root, "packages/a" for a workspace) to an Asset.id. Return
   * undefined to drop that importer's direct edges.
   */
  assetIdFor: (importerDir: string, importerName: string | undefined) => string | undefined;
  /** Root package.json, used for v1 lockfiles (which do not list root dependencies). */
  rootManifest?: PackageManifest;
}

export interface LockfileParseResult {
  lockfileVersion: number;
  components: Component[];
  edges: DepEdge[];
  /** Importer dirs found ("" = root). */
  importers: string[];
  warnings: string[];
}

interface Flags {
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
}

type FlagClass = 'dev' | 'optional' | 'runtime';

function flagClass(f: Flags): FlagClass {
  if (f.dev || f.devOptional) return 'dev';
  if (f.optional) return 'optional';
  return 'runtime';
}

/** Scope of a transitive edge from parent to child declared in `section`. */
function transitiveScope(parent: FlagClass, child: FlagClass, section: ManifestSection): DepScope {
  if (parent === 'dev' || child === 'dev') return 'dev';
  if (parent === 'optional' || child === 'optional' || section === 'optionalDependencies') return 'optional';
  if (section === 'peerDependencies') return 'peer';
  return 'runtime';
}

/** Scope of a direct edge from an importer. The package's own flags can only weaken it. */
function directScope(section: ManifestSection, child: FlagClass): DepScope {
  const s = SECTION_SCOPE[section];
  if (s === 'dev' || child === 'dev') return 'dev';
  if (s === 'optional' || child === 'optional') return 'optional';
  return s;
}

/** Collects components + edges, deduplicating both. */
class Collector {
  readonly components = new Map<string, Component>();
  private readonly edgeKeys = new Set<string>();
  readonly edges: DepEdge[] = [];

  addComponent(c: Component): void {
    const prev = this.components.get(c.purl);
    if (!prev) {
      this.components.set(c.purl, c);
      return;
    }
    if (c.hasInstallScript) prev.hasInstallScript = true;
    prev.resolved ??= c.resolved;
    prev.integrity ??= c.integrity;
  }

  addEdge(e: DepEdge): void {
    if (e.from === e.to) return;
    const key = `${e.from}\u0000${e.to}\u0000${e.scope}\u0000${e.direct}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push(e);
  }
}

interface ResolvedVersion {
  name: string;
  version: string;
  qualifiers?: Record<string, string>;
}

/**
 * Turn a lockfile (name, version, resolved) triple into a purl-ready version.
 * Returns null for local links / file: deps, which are not third-party components.
 */
export function resolveLockVersion(name: string, version: string | undefined, resolved: string | undefined): ResolvedVersion | null {
  let realName = name.toLowerCase();
  let ver = version?.trim();
  if (!ver) return null;
  // npm alias: "npm:real-name@1.2.3"
  const alias = /^npm:(.+)@([^@]+)$/.exec(ver);
  if (alias) {
    realName = alias[1]!.toLowerCase();
    ver = alias[2]!;
  }
  if (!isValidNpmName(realName)) return null;
  if (/^(file|link):/i.test(ver)) return null;
  const vcs = /^(git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|https?:)/i;
  if (vcs.test(ver)) {
    // v1 records VCS / tarball deps as the version itself.
    const hash = ver.indexOf('#');
    const url = hash >= 0 ? ver.slice(0, hash) : ver;
    const ref = hash >= 0 ? ver.slice(hash + 1) : '';
    return { name: realName, version: cap(ref || 'unknown', MAX_VERSION), qualifiers: { vcs_url: cap(url, MAX_URL) } };
  }
  const out: ResolvedVersion = { name: realName, version: cap(ver, MAX_VERSION) };
  if (resolved && /^git(\+|:)/i.test(resolved)) {
    const hash = resolved.indexOf('#');
    out.qualifiers = { vcs_url: cap(hash >= 0 ? resolved.slice(0, hash) : resolved, MAX_URL) };
  }
  return out;
}

function makeComponent(rv: ResolvedVersion, entry: unknown): Component {
  const p: Purl = { type: 'npm', ...splitNpmName(rv.name), version: rv.version };
  if (rv.qualifiers) p.qualifiers = rv.qualifiers;
  const c: Component = { purl: formatPurl(p), ecosystem: 'npm', name: rv.name, version: rv.version };
  const resolved = own(entry, 'resolved');
  if (typeof resolved === 'string' && resolved) c.resolved = cap(resolved, MAX_URL);
  const integrity = own(entry, 'integrity');
  if (typeof integrity === 'string' && integrity) c.integrity = cap(integrity, MAX_INTEGRITY);
  if (own(entry, 'hasInstallScript') === true) c.hasInstallScript = true;
  return c;
}

function readFlags(entry: unknown): Flags {
  return {
    dev: own(entry, 'dev') === true,
    optional: own(entry, 'optional') === true,
    devOptional: own(entry, 'devOptional') === true,
  };
}

/** Parse package-lock.json / npm-shrinkwrap.json text (v1, v2 or v3). Throws on invalid JSON. */
export function parsePackageLock(text: string, opts: LockfileParseOptions): LockfileParseResult {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('lockfile is not an object');
  const v = own(raw, 'lockfileVersion');
  const lockfileVersion = typeof v === 'number' ? v : 1;
  const packages = own(raw, 'packages');
  if (lockfileVersion >= 2 && isRecord(packages)) return parseV2(lockfileVersion, packages, opts);
  return parseV1(lockfileVersion, own(raw, 'dependencies'), opts);
}

// --- v2 / v3: flat "packages" map keyed by install path -------------------------

/** Package name from an install path: "a/node_modules/@s/b" → "@s/b". */
export function nameFromInstallPath(key: string): string | undefined {
  const idx = key.lastIndexOf('node_modules/');
  if (idx < 0) return undefined;
  const tail = key.slice(idx + 'node_modules/'.length);
  return tail.length > 0 ? tail : undefined;
}

function isInstallPath(key: string): boolean {
  return key.startsWith('node_modules/') || key.includes('/node_modules/');
}

function parseV2(lockfileVersion: number, packages: Record<string, unknown>, opts: LockfileParseOptions): LockfileParseResult {
  const col = new Collector();
  const warnings: string[] = [];
  const importers: string[] = [];
  /** install path → component purl (null for links / non-components). */
  const purlAt = new Map<string, string | null>();
  const classAt = new Map<string, FlagClass>();
  let unresolvedCount = 0;

  const keys = Object.keys(packages).filter((k) => Object.hasOwn(packages, k));
  for (const key of keys) {
    const entry = packages[key];
    if (!isRecord(entry)) continue;
    if (!isInstallPath(key)) {
      importers.push(key);
      continue;
    }
    if (own(entry, 'link') === true) {
      purlAt.set(key, null);
      continue;
    }
    const pathName = nameFromInstallPath(key);
    const entryName = own(entry, 'name');
    const name = typeof entryName === 'string' ? entryName : pathName;
    const version = own(entry, 'version');
    const resolved = own(entry, 'resolved');
    const rv = name
      ? resolveLockVersion(name, typeof version === 'string' ? version : undefined, typeof resolved === 'string' ? resolved : undefined)
      : null;
    if (!rv) {
      purlAt.set(key, null);
      continue;
    }
    const c = makeComponent(rv, entry);
    col.addComponent(c);
    purlAt.set(key, c.purl);
    classAt.set(key, flagClass(readFlags(entry)));
  }

  /** Node module resolution: walk up from `fromKey` looking for node_modules/<dep>. */
  const resolveFrom = (fromKey: string, dep: string): string | undefined => {
    let base = fromKey;
    for (let i = 0; i < 64; i++) {
      const candidate = base === '' ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
      if (purlAt.has(candidate)) return candidate;
      if (base === '') return undefined;
      const idx = base.lastIndexOf('/node_modules/');
      if (idx >= 0) base = base.slice(0, idx);
      else if (base.startsWith('node_modules/')) base = '';
      else base = ''; // workspace dir → hoisted root
    }
    return undefined;
  };

  // Direct edges from importers.
  for (const dir of importers) {
    const entry = packages[dir];
    const name = own(entry, 'name');
    const assetId = opts.assetIdFor(dir, typeof name === 'string' ? name : undefined);
    if (!assetId) continue;
    const seen = new Map<string, DepEdge>();
    for (const section of SECTIONS) {
      for (const [dep] of stringEntries(own(entry, section))) {
        const at = resolveFrom(dir, dep);
        if (at === undefined) {
          if (section !== 'peerDependencies' && section !== 'optionalDependencies') unresolvedCount++;
          continue;
        }
        const purl = purlAt.get(at);
        if (!purl) continue; // link to a workspace / local dir
        const scope = directScope(section, classAt.get(at) ?? 'runtime');
        const prev = seen.get(purl);
        if (!prev || SCOPE_RANK[scope] < SCOPE_RANK[prev.scope]) seen.set(purl, { from: assetId, to: purl, scope, direct: true });
      }
    }
    for (const e of seen.values()) col.addEdge(e);
  }

  // Transitive edges between installed packages.
  for (const key of keys) {
    const fromPurl = purlAt.get(key);
    if (!fromPurl) continue;
    const entry = packages[key];
    const parentClass = classAt.get(key) ?? 'runtime';
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [dep] of stringEntries(own(entry, section))) {
        const at = resolveFrom(key, dep);
        if (at === undefined) {
          if (section === 'dependencies') unresolvedCount++;
          continue;
        }
        const to = purlAt.get(at);
        if (!to) continue;
        col.addEdge({ from: fromPurl, to, scope: transitiveScope(parentClass, classAt.get(at) ?? 'runtime', section), direct: false });
      }
    }
  }

  if (unresolvedCount > 0) warnings.push(`${unresolvedCount} dependency reference(s) in the lockfile could not be resolved to an installed package`);
  return { lockfileVersion, components: [...col.components.values()], edges: col.edges, importers, warnings };
}

// --- v1: nested "dependencies" tree --------------------------------------------

interface V1Node {
  name: string;
  entry: Record<string, unknown>;
  purl: string | null;
  cls: FlagClass;
  children: Map<string, V1Node>;
  parent: V1Node | null;
}

function parseV1(lockfileVersion: number, deps: unknown, opts: LockfileParseOptions): LockfileParseResult {
  const col = new Collector();
  const warnings: string[] = [];
  const root: V1Node = { name: '', entry: {}, purl: null, cls: 'runtime', children: new Map(), parent: null };
  const all: V1Node[] = [];
  let unresolvedCount = 0;

  // Build the tree iteratively (avoid deep recursion on hostile input).
  const stack: { parent: V1Node; deps: unknown; depth: number }[] = [{ parent: root, deps, depth: 0 }];
  while (stack.length > 0) {
    const { parent, deps: d, depth } = stack.pop()!;
    if (!isRecord(d) || depth > 64) continue;
    for (const name of Object.keys(d)) {
      const entry = d[name];
      if (!isRecord(entry)) continue;
      const version = own(entry, 'version');
      const resolved = own(entry, 'resolved');
      const rv = resolveLockVersion(name, typeof version === 'string' ? version : undefined, typeof resolved === 'string' ? resolved : undefined);
      let purl: string | null = null;
      if (rv) {
        const c = makeComponent(rv, entry);
        col.addComponent(c);
        purl = c.purl;
      }
      const node: V1Node = { name: name.toLowerCase(), entry, purl, cls: flagClass(readFlags(entry)), children: new Map(), parent };
      parent.children.set(node.name, node);
      all.push(node);
      stack.push({ parent: node, deps: own(entry, 'dependencies'), depth: depth + 1 });
    }
  }

  const resolveFrom = (node: V1Node, dep: string): V1Node | undefined => {
    for (let n: V1Node | null = node; n; n = n.parent) {
      const hit = n.children.get(dep);
      if (hit) return hit;
    }
    return undefined;
  };

  // Transitive edges via "requires".
  const required = new Set<V1Node>();
  for (const node of all) {
    if (!node.purl) continue;
    for (const [dep] of stringEntries(own(node.entry, 'requires'))) {
      const target = resolveFrom(node, dep.toLowerCase());
      if (!target) {
        unresolvedCount++;
        continue;
      }
      required.add(target);
      if (!target.purl) continue;
      // v1 does not separate optional/peer requires; flags carry the scope.
      col.addEdge({ from: node.purl, to: target.purl, scope: transitiveScope(node.cls, target.cls, 'dependencies'), direct: false });
    }
  }

  // Direct edges from the root importer.
  const assetId = opts.assetIdFor('', opts.rootManifest?.name);
  if (assetId) {
    if (opts.rootManifest) {
      const seen = new Map<string, DepEdge>();
      for (const section of SECTIONS) {
        for (const dep of Object.keys(opts.rootManifest[section])) {
          const target = root.children.get(dep);
          if (!target) {
            if (section === 'dependencies' || section === 'devDependencies') unresolvedCount++;
            continue;
          }
          if (!target.purl) continue;
          const scope = directScope(section, target.cls);
          const prev = seen.get(target.purl);
          if (!prev || SCOPE_RANK[scope] < SCOPE_RANK[prev.scope]) seen.set(target.purl, { from: assetId, to: target.purl, scope, direct: true });
        }
      }
      for (const e of seen.values()) col.addEdge(e);
    } else {
      // No manifest: top-level packages nobody requires are the direct deps.
      warnings.push('lockfile v1 without package.json: direct dependencies inferred from the lockfile tree');
      for (const node of root.children.values()) {
        if (required.has(node) || !node.purl) continue;
        const scope: DepScope = node.cls === 'runtime' ? 'runtime' : node.cls;
        col.addEdge({ from: assetId, to: node.purl, scope, direct: true });
      }
    }
  }

  if (unresolvedCount > 0) warnings.push(`${unresolvedCount} dependency reference(s) in the lockfile could not be resolved to an installed package`);
  return { lockfileVersion, components: [...col.components.values()], edges: col.edges, importers: [''], warnings };
}
