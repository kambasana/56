/**
 * Static Python dependency parsers (Tier 0): requirements*.txt (pinned `==` entries, `-r`
 * includes, `--hash`, the `# via` graph that pip-compile and `uv pip compile` write), uv.lock,
 * poetry.lock, Pipfile.lock and pyproject.toml (the root dependencies of a lockfile).
 *
 * Only versions a lockfile or an exact pin resolves become components. Ranges and unpinned
 * entries are reported as unresolved, never guessed. Nothing is installed or executed; all input
 * is untrusted, size-capped and validated.
 */
import { formatPurl, type Component, type DepEdge, type DepScope, type Purl } from '../core/types.js';
import { cap, isRecord, own } from './fs.js';
import { parseToml, tomlArray, tomlString, tomlTable, type TomlTable, type TomlValue } from './toml.js';

const MAX_VERSION = 128;
const MAX_URL = 2048;
const MAX_ENTRIES = 20_000;

/** PEP 503 normalised name: lower case, runs of "-", "_" and "." become "-". */
export function normalizePypiName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** PEP 508 project names: letters, digits, ".", "_", "-"; starts and ends with a letter or digit. */
export function isValidPypiName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/.test(name);
}

/** PEP 440-ish version (exact release, pre/post/dev, local): no wildcards, no ranges. */
export function isExactPypiVersion(v: string): boolean {
  return v.length > 0 && v.length <= MAX_VERSION && /^v?\d+(\.\d+)*((a|b|rc|c|alpha|beta|pre|preview)[-_.]?\d*)?([-_.]?(post|rev|r)[-_.]?\d*)?([-_.]?dev[-_.]?\d*)?(\+[A-Za-z0-9.]+)?$/i.test(v) || /^\d+!\d+(\.\d+)*/.test(v);
}

/** pkg:pypi/<normalised name>@<version> (purl-spec: PyPI names are lower case, "_" → "-"). */
export function pypiPurl(name: string, version?: string, qualifiers?: Record<string, string>): string {
  const p: Purl = { type: 'pypi', name: normalizePypiName(name) };
  if (version) p.version = version;
  if (qualifiers) p.qualifiers = qualifiers;
  return formatPurl(p);
}

function pypiComponent(name: string, version: string, extra: Partial<Component> = {}, qualifiers?: Record<string, string>): Component {
  const n = normalizePypiName(name);
  return { purl: pypiPurl(n, version, qualifiers), ecosystem: 'pypi', name: n, version: cap(version, MAX_VERSION), ...extra };
}

/** "sha256:<hex>" → SRI "sha256-<base64>"; undefined for anything else. */
export function hashToSri(hash: string | undefined): string | undefined {
  const m = /^sha(256|384|512)[:=]([0-9a-f]{64,128})$/i.exec(hash?.trim() ?? '');
  if (!m) return undefined;
  return `sha${m[1]}-${Buffer.from(m[2]!, 'hex').toString('base64')}`;
}

/**
 * Scope a requirements file implies from its path: dev for development, test, lint, docs, CI and
 * translation sets (requirements/development.txt, requirements-test.txt, docs/requirements.txt),
 * runtime otherwise (requirements.txt, requirements/base.txt, requirements/prod.txt).
 */
export function requirementsScope(file: string): DepScope {
  const lower = file.toLowerCase();
  return /(^|[-_./])(dev|devel|develop|development|test|tests|testing|lint|linting|docs?|ci|typing|mypy|translations?|local|tox|bench|benchmarks?|integration|e2e|style|format|check|tools?|build)([-_./]|$)/.test(lower)
    ? 'dev'
    : 'runtime';
}

export interface PythonParseResult {
  components: Component[];
  edges: DepEdge[];
  /** Entries that no lockfile or exact pin resolves (ranges, URLs, unpinned names). */
  unresolved: string[];
  warnings: string[];
}

/** Deduplicating collector (same rules as the npm parser). */
class Collector {
  readonly components = new Map<string, Component>();
  readonly edges: DepEdge[] = [];
  private readonly keys = new Set<string>();
  add(c: Component): void {
    const prev = this.components.get(c.purl);
    if (!prev) this.components.set(c.purl, c);
    else prev.integrity ??= c.integrity;
  }
  edge(e: DepEdge): void {
    if (e.from === e.to) return;
    const k = `${e.from}\u0000${e.to}\u0000${e.scope}\u0000${e.direct}`;
    if (this.keys.has(k)) return;
    this.keys.add(k);
    this.edges.push(e);
  }
  result(unresolved: string[], warnings: string[]): PythonParseResult {
    return { components: [...this.components.values()], edges: this.edges, unresolved, warnings };
  }
}

// ---------------------------------------------------------------------------
// requirements*.txt
// ---------------------------------------------------------------------------

export interface RequirementEntry {
  name: string;
  version?: string;
  /** Raw specifier text when not an exact pin. */
  spec?: string;
  hashes: string[];
  /** `# via` sources: package names, or "-r file" / "<name> (pyproject.toml)" for the project itself. */
  via: string[];
  line: number;
}

export interface RequirementsFile {
  entries: RequirementEntry[];
  /** `-r` / `--requirement` includes (relative paths as written). */
  includes: string[];
  /** Local / editable entries (`-e ./pkg`, `./pkg`): the project's own code, not third-party. */
  local: string[];
  /** Entries that cannot be resolved (ranges, URLs, VCS, unparsable). */
  unresolved: string[];
  /** The file names the project itself (pip-compile `via ... (pyproject.toml)`, `-r x.in`). */
  mentionsProject: boolean;
}

const OPTION_WITH_ARG = /^(-i|--index-url|--extra-index-url|-f|--find-links|--trusted-host|--no-binary|--only-binary|--use-feature|--config-settings|--global-option|--hash)(=|\s|$)/;
const OPTION_FLAG = /^(--pre|--prefer-binary|--require-hashes|--no-index|--no-deps|--use-pep517)\b/;

/** Parse requirements text. Comments become the `# via` graph; nothing is fetched or executed. */
export function parseRequirements(text: string): RequirementsFile {
  const out: RequirementsFile = { entries: [], includes: [], local: [], unresolved: [], mentionsProject: false };
  const rawLines = text.replace(/^﻿/, '').split(/\r?\n/);
  let last: RequirementEntry | undefined;
  let inVia = false;
  for (let i = 0; i < rawLines.length && out.entries.length < MAX_ENTRIES; i++) {
    let line = rawLines[i]!;
    const lineNo = i + 1;
    // Comment-only lines: the pip-compile `# via` graph.
    const comment = /^(\s*)#(.*)$/.exec(line);
    if (comment) {
      const body = comment[2]!;
      const c = body.trim();
      if (/pyproject\.toml|setup\.(py|cfg)/.test(c)) out.mentionsProject = true;
      const via = /^via\b\s*(.*)$/.exec(c);
      if (via && last && comment[1]!.length > 0) {
        inVia = true;
        if (via[1]) last.via.push(via[1].trim());
      } else if (inVia && last && /^\s{2,}\S/.test(body)) last.via.push(c);
      else inVia = false;
      continue;
    }
    inVia = false;
    // Line continuations.
    while (line.endsWith('\\') && i + 1 < rawLines.length) line = line.slice(0, -1) + ' ' + rawLines[++i]!;
    // Inline comment (" #" after content).
    const hash = line.search(/\s#/);
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(-r|--requirement)(?:=|\s+)(\S+)$/.exec(line))) {
      out.includes.push(cap(m[2]!, 512));
      continue;
    }
    if (/^(-c|--constraint)(=|\s)/.test(line)) continue;
    if ((m = /^(-e|--editable)(?:=|\s+)(\S+)/.exec(line))) {
      const target = m[2]!;
      if (/^(\.|\/|file:)/.test(target)) {
        out.local.push(cap(target, 512));
        out.mentionsProject = true;
      } else out.unresolved.push(cap(target, 200));
      last = undefined;
      continue;
    }
    if (OPTION_WITH_ARG.test(line) || OPTION_FLAG.test(line)) continue;
    if (/^([a-z][a-z0-9+.-]*:\/\/|git\+)/i.test(line)) {
      out.unresolved.push(cap(line, 200)); // a VCS or URL requirement: no version to resolve
      last = undefined;
      continue;
    }
    if (/^(\.{1,2}\/|\/|file:)/.test(line)) {
      out.local.push(cap(line, 512));
      last = undefined;
      continue;
    }
    // Hashes ride on the requirement line.
    const hashes: string[] = [];
    line = line.replace(/--hash[=\s]+(\S+)/g, (_, h: string) => {
      hashes.push(h);
      return '';
    });
    const req = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line.trim());
    if (!req || !isValidPypiName(req[1]!)) {
      out.unresolved.push(cap(line, 200));
      last = undefined;
      continue;
    }
    const name = normalizePypiName(req[1]!);
    const rest = req[3]!.trim();
    const spec = rest.split(';')[0]!.trim();
    const pin = /^===?\s*([^\s,;*]+)$/.exec(spec);
    const entry: RequirementEntry = { name, hashes, via: [], line: lineNo };
    if (pin && isExactPypiVersion(pin[1]!)) entry.version = cap(pin[1]!, MAX_VERSION);
    else {
      entry.spec = cap(spec || '(no version)', 200);
      out.unresolved.push(`${name}${spec ? ` ${cap(spec, 100)}` : ''}`);
    }
    out.entries.push(entry);
    last = entry;
  }
  return out;
}

/**
 * Components and edges for one requirements file (with its includes already merged by the
 * caller). Entries whose `# via` names other packages of the same file become transitive edges;
 * entries the project requires itself (or with no `# via` at all) are direct.
 */
export function requirementsInventory(req: RequirementsFile, assetId: string, scope: DepScope): PythonParseResult {
  const col = new Collector();
  const byName = new Map<string, string>();
  for (const e of req.entries) {
    if (!e.version) continue;
    const sri = e.hashes.map(hashToSri).find((x): x is string => x !== undefined);
    const c = pypiComponent(e.name, e.version, sri ? { integrity: sri } : {});
    col.add(c);
    byName.set(e.name, c.purl);
  }
  for (const e of req.entries) {
    const to = e.version ? byName.get(e.name) : undefined;
    if (!to) continue;
    let direct = e.via.length === 0;
    for (const v of e.via) {
      // "-r requirements/base.in", "-c constraints.txt", "apache-superset (pyproject.toml)", "setup.py".
      if (/^-[rc]\s/.test(v) || /\((pyproject\.toml|setup\.(py|cfg))\)$/.test(v) || /^(pyproject\.toml|setup\.(py|cfg))$/.test(v)) {
        direct = true;
        continue;
      }
      const from = byName.get(normalizePypiName(v.replace(/\[.*$/, '')));
      if (from) col.edge({ from, to, scope: 'runtime', direct: false });
      else direct = true; // the project itself, or a package resolved elsewhere
    }
    if (direct) col.edge({ from: assetId, to, scope, direct: true });
  }
  return col.result([...req.unresolved], []);
}

// ---------------------------------------------------------------------------
// pyproject.toml (root dependencies only; versions come from a lockfile)
// ---------------------------------------------------------------------------

export interface PyprojectDeps {
  name?: string;
  /** Normalised names with their scope (runtime, optional, dev). */
  deps: { name: string; scope: DepScope; spec?: string }[];
}

/** Name and specifier of a PEP 508 requirement string. */
export function pep508Name(req: string): { name: string; spec: string } | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)/.exec(req);
  if (!m || !isValidPypiName(m[1]!)) return undefined;
  return { name: normalizePypiName(m[1]!), spec: m[3]!.trim() };
}

export function parsePyproject(text: string): PyprojectDeps {
  const doc = parseToml(text);
  const out: PyprojectDeps = { deps: [] };
  const project = tomlTable(doc['project']);
  const poetry = tomlTable(tomlTable(doc['tool'])?.['poetry']);
  const name = tomlString(project?.['name']) ?? tomlString(poetry?.['name']);
  if (name) out.name = normalizePypiName(name);
  const add = (n: string, scope: DepScope, spec?: string): void => {
    if (out.deps.length >= MAX_ENTRIES) return;
    out.deps.push({ name: normalizePypiName(n), scope, ...(spec ? { spec: cap(spec, 200) } : {}) });
  };
  for (const r of tomlArray(project?.['dependencies'])) {
    const p = typeof r === 'string' ? pep508Name(r) : undefined;
    if (p) add(p.name, 'runtime', p.spec);
  }
  for (const list of Object.values(tomlTable(project?.['optional-dependencies']) ?? {})) {
    for (const r of tomlArray(list)) {
      const p = typeof r === 'string' ? pep508Name(r) : undefined;
      if (p) add(p.name, 'optional', p.spec);
    }
  }
  for (const list of Object.values(tomlTable(doc['dependency-groups']) ?? {})) {
    for (const r of tomlArray(list)) {
      const p = typeof r === 'string' ? pep508Name(r) : undefined;
      if (p) add(p.name, 'dev', p.spec);
    }
  }
  const poetryDeps = (t: TomlValue | undefined, scope: DepScope): void => {
    for (const [k, v] of Object.entries(tomlTable(t) ?? {})) {
      if (k.toLowerCase() === 'python' || !isValidPypiName(k)) continue;
      const optional = scope === 'runtime' && tomlTable(v)?.['optional'] === true;
      add(k, optional ? 'optional' : scope, typeof v === 'string' ? v : tomlString(tomlTable(v)?.['version']));
    }
  };
  poetryDeps(poetry?.['dependencies'], 'runtime');
  poetryDeps(poetry?.['dev-dependencies'], 'dev');
  for (const g of Object.values(tomlTable(poetry?.['group']) ?? {})) poetryDeps(tomlTable(g)?.['dependencies'], 'dev');
  return out;
}

// ---------------------------------------------------------------------------
// uv.lock
// ---------------------------------------------------------------------------

export interface LockImporterMap {
  /** Asset id for a local project of the lock (path relative to the lockfile directory, "" = root). */
  assetIdFor: (projectDir: string, projectName: string | undefined) => string | undefined;
}

function sourceOf(pkg: TomlTable): { kind: string; value: string } | undefined {
  const s = tomlTable(pkg['source']);
  if (!s) return undefined;
  for (const kind of ['registry', 'editable', 'virtual', 'directory', 'path', 'git', 'url']) {
    const v = tomlString(s[kind]);
    if (v !== undefined) return { kind, value: v };
  }
  return undefined;
}

function firstHash(pkg: TomlTable): string | undefined {
  const sdist = tomlTable(pkg['sdist']);
  const h = tomlString(sdist?.['hash']);
  if (h) return hashToSri(h);
  for (const w of tomlArray(pkg['wheels'])) {
    const wh = tomlString(tomlTable(w)?.['hash']);
    if (wh) return hashToSri(wh);
  }
  return undefined;
}

/** Parse uv.lock: every registry / git package becomes a component; local projects are the importers. */
export function parseUvLock(text: string, opts: LockImporterMap): PythonParseResult {
  const doc = parseToml(text);
  const col = new Collector();
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const packages = tomlArray(doc['package']).map(tomlTable).filter((p): p is TomlTable => p !== undefined);
  /** name → [{version, id}] where id is a purl (component) or an asset id (local project). */
  const byName = new Map<string, { version?: string; id: string; local: boolean }[]>();
  const nodes: { pkg: TomlTable; id: string; local: boolean }[] = [];
  for (const pkg of packages.slice(0, MAX_ENTRIES)) {
    const rawName = tomlString(pkg['name']);
    if (!rawName || !isValidPypiName(rawName)) continue;
    const name = normalizePypiName(rawName);
    const version = tomlString(pkg['version']);
    const src = sourceOf(pkg);
    let id: string | undefined;
    let local = false;
    if (src && ['editable', 'virtual', 'directory'].includes(src.kind)) {
      local = true;
      const dir = src.value === '.' ? '' : src.value.replace(/^\.\//, '').replace(/\/+$/, '');
      if (dir.startsWith('..') || dir.startsWith('/')) continue;
      id = opts.assetIdFor(dir, name);
    } else if (src?.kind === 'path') {
      continue; // a local wheel or sdist: not a third-party package
    } else if (version && isExactPypiVersion(version)) {
      const qualifiers: Record<string, string> | undefined =
        src?.kind === 'git' ? { vcs_url: cap(src.value.replace(/#.*$/, ''), MAX_URL) } : src?.kind === 'url' ? { download_url: cap(src.value, MAX_URL) } : undefined;
      const sri = firstHash(pkg);
      const c = pypiComponent(name, version, sri ? { integrity: sri } : {}, qualifiers);
      if (src?.kind === 'registry' && /^https?:/.test(src.value)) c.resolved = cap(src.value, MAX_URL);
      col.add(c);
      id = c.purl;
    } else {
      unresolved.push(`${name}${version ? ` ${cap(version, 60)}` : ''}`);
      continue;
    }
    if (!id) continue;
    const list = byName.get(name) ?? byName.set(name, []).get(name)!;
    list.push({ ...(version ? { version } : {}), id, local });
    nodes.push({ pkg, id, local });
  }
  const resolve = (dep: TomlTable): string | undefined => {
    const n = tomlString(dep['name']);
    if (!n) return undefined;
    const list = byName.get(normalizePypiName(n));
    if (!list || list.length === 0) return undefined;
    const v = tomlString(dep['version']);
    return (v ? list.find((x) => x.version === v) : undefined)?.id ?? list[0]!.id;
  };
  // Extras that some package requests from another: their optional-dependencies are real edges.
  const requestedExtras = new Map<string, Set<string>>();
  for (const { pkg } of nodes) {
    const groups = [tomlArray(pkg['dependencies']), ...Object.values(tomlTable(pkg['optional-dependencies']) ?? {}).map(tomlArray), ...Object.values(tomlTable(pkg['dev-dependencies']) ?? {}).map(tomlArray)];
    for (const d of groups.flat().map(tomlTable)) {
      const to = d ? resolve(d) : undefined;
      if (!to || !d) continue;
      for (const x of tomlArray(d['extra'])) if (typeof x === 'string') (requestedExtras.get(to) ?? requestedExtras.set(to, new Set()).get(to)!).add(x);
    }
  }
  for (const { pkg, id, local } of nodes) {
    const link = (list: TomlValue | undefined, scope: DepScope): void => {
      for (const d of tomlArray(list).map(tomlTable)) {
        const to = d ? resolve(d) : undefined;
        if (!to || to === id) continue;
        col.edge({ from: id, to, scope, direct: local });
      }
    };
    link(pkg['dependencies'], 'runtime');
    for (const [extra, list] of Object.entries(tomlTable(pkg['optional-dependencies']) ?? {})) {
      // A project's own extras are optional; a dependency's extras count only when requested.
      link(list, !local && requestedExtras.get(id)?.has(extra) ? 'runtime' : 'optional');
    }
    for (const list of Object.values(tomlTable(pkg['dev-dependencies']) ?? {})) link(list, 'dev');
  }
  // Local projects that are dependencies of another local project are not third-party: their
  // edges hang off their own asset, which is what we want.
  return col.result(unresolved, warnings);
}

// ---------------------------------------------------------------------------
// poetry.lock
// ---------------------------------------------------------------------------

/** Parse poetry.lock. Root dependencies come from pyproject.toml when given, else from the lock's groups. */
export function parsePoetryLock(text: string, assetId: string, pyproject?: PyprojectDeps): PythonParseResult {
  const doc = parseToml(text);
  const col = new Collector();
  const unresolved: string[] = [];
  const warnings: string[] = [];
  const packages = tomlArray(doc['package']).map(tomlTable).filter((p): p is TomlTable => p !== undefined);
  const metaFiles = tomlTable(tomlTable(doc['metadata'])?.['files']);
  const byName = new Map<string, string>();
  const info = new Map<string, { pkg: TomlTable; dev: boolean; optional: boolean }>();
  for (const pkg of packages.slice(0, MAX_ENTRIES)) {
    const rawName = tomlString(pkg['name']);
    const version = tomlString(pkg['version']);
    if (!rawName || !isValidPypiName(rawName)) continue;
    const name = normalizePypiName(rawName);
    const src = tomlTable(pkg['source']);
    const srcType = tomlString(src?.['type']);
    if (srcType === 'directory' || srcType === 'file') continue; // local code
    if (!version || !isExactPypiVersion(version)) {
      unresolved.push(`${name}${version ? ` ${cap(version, 60)}` : ''}`);
      continue;
    }
    const qualifiers = srcType === 'git' ? { vcs_url: cap(tomlString(src?.['url']) ?? '', MAX_URL) } : undefined;
    const files = tomlArray(pkg['files']).length > 0 ? tomlArray(pkg['files']) : tomlArray(metaFiles?.[rawName] ?? metaFiles?.[name]);
    const sri = files.map((f) => hashToSri(tomlString(tomlTable(f)?.['hash']))).find((x): x is string => x !== undefined);
    const c = pypiComponent(name, version, sri ? { integrity: sri } : {}, qualifiers && qualifiers.vcs_url ? qualifiers : undefined);
    col.add(c);
    byName.set(name, c.purl);
    const groups = tomlArray(pkg['groups']).filter((g): g is string => typeof g === 'string');
    const category = tomlString(pkg['category']);
    info.set(c.purl, { pkg, dev: category === 'dev' || (groups.length > 0 && !groups.includes('main')), optional: pkg['optional'] === true });
  }
  // Transitive edges.
  const depended = new Set<string>();
  for (const [from, { pkg, dev, optional }] of info) {
    for (const [dep, spec] of Object.entries(tomlTable(pkg['dependencies']) ?? {})) {
      const to = byName.get(normalizePypiName(dep));
      if (!to) continue;
      depended.add(to);
      const specs = Array.isArray(spec) ? spec : [spec];
      const opt = specs.every((s) => tomlTable(s)?.['optional'] === true);
      const childDev = info.get(to)?.dev ?? false;
      const scope: DepScope = dev || childDev ? 'dev' : optional || opt ? 'optional' : 'runtime';
      col.edge({ from, to, scope, direct: false });
    }
  }
  // Direct edges.
  if (pyproject && pyproject.deps.length > 0) {
    for (const d of pyproject.deps) {
      const to = byName.get(d.name);
      if (to) col.edge({ from: assetId, to, scope: d.scope, direct: true });
    }
  } else {
    if (pyproject === undefined) warnings.push('poetry.lock without pyproject.toml: direct dependencies inferred from the lockfile');
    for (const [purl, { dev, optional }] of info) {
      if (depended.has(purl)) continue;
      col.edge({ from: assetId, to: purl, scope: dev ? 'dev' : optional ? 'optional' : 'runtime', direct: true });
    }
  }
  return col.result(unresolved, warnings);
}

// ---------------------------------------------------------------------------
// Pipfile.lock (JSON)
// ---------------------------------------------------------------------------

export function parsePipfileLock(text: string, assetId: string): PythonParseResult {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('Pipfile.lock is not an object');
  const col = new Collector();
  const unresolved: string[] = [];
  for (const [section, scope] of [
    ['default', 'runtime'],
    ['develop', 'dev'],
  ] as const) {
    const deps = own(raw, section);
    if (!isRecord(deps)) continue;
    for (const [rawName, entry] of Object.entries(deps).slice(0, MAX_ENTRIES)) {
      if (!isValidPypiName(rawName) || !isRecord(entry)) continue;
      const v = own(entry, 'version');
      const pin = typeof v === 'string' ? /^===?\s*(\S+)$/.exec(v.trim()) : null;
      if (!pin || !isExactPypiVersion(pin[1]!)) {
        unresolved.push(`${normalizePypiName(rawName)}${typeof v === 'string' ? ` ${cap(v, 60)}` : ''}`);
        continue;
      }
      const hashes = own(entry, 'hashes');
      const sri = Array.isArray(hashes) ? hashes.map((h) => (typeof h === 'string' ? hashToSri(h) : undefined)).find((x): x is string => x !== undefined) : undefined;
      const c = pypiComponent(rawName, pin[1]!, sri ? { integrity: sri } : {});
      col.add(c);
      col.edge({ from: assetId, to: c.purl, scope, direct: true });
    }
  }
  return col.result(unresolved, []);
}
