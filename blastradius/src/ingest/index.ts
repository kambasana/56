/**
 * Ingest stage (PLAN §3.1): local directory or git URL → Inventory.
 *
 * Everything is parsed statically. Nothing from the target is installed,
 * built or executed; symlinks are never followed outside the target and every
 * file read is size-capped.
 */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, Component, DepEdge, Inventory, NotAnalysedManifest } from '../core/types.js';
import { applyOverrides, inferEnvironment, parseConfig, type BlastradiusConfig } from './config.js';
import { dockerfileInventory, parseDockerfile } from './docker.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_LOCKFILE_BYTES, readTargetFile, walkTarget } from './fs.js';
import { cloneRepo, looksLikeGitUrl, type GitRunner } from './git.js';
import { manifestDeps, parsePackageJson, parsePackageLock, type PackageManifest } from './npm.js';
import { notAnalysedEntry } from './manifests.js';
import {
  parsePipfileLock,
  parsePoetryLock,
  parsePyproject,
  parseRequirements,
  parseUvLock,
  requirementsInventory,
  requirementsScope,
  type PyprojectDeps,
  type RequirementsFile,
} from './python.js';
import { runSyft, type CycloneDxImport } from './syft.js';
import { parseWorkflow, type WorkflowInfo } from './workflows.js';

export interface IngestOptions {
  /** Sink for non-fatal problems (they are also returned in IngestResult.warnings). */
  warn?: (message: string) => void;
  /** Cap for package.json / workflow / Dockerfile / config reads (default 2 MB). */
  maxFileBytes?: number;
  /** Cap for lockfile reads (default 64 MB). */
  maxLockfileBytes?: number;
  /** Max files visited while walking the target (default 200k). */
  maxFiles?: number;
  /** Import a Syft CycloneDX SBOM when `syft` is on PATH (default false). */
  syft?: boolean;
  /** Injected Syft runner (tests). Defaults to running `syft` from PATH. */
  syftRunner?: (dir: string) => Promise<CycloneDxImport | null>;
  /** Options for cloning a git URL target. */
  git?: { runner?: GitRunner; tmpDir?: string; timeoutMs?: number };
  /** Keep the temporary clone on disk (default false: removed after ingest). */
  keepClone?: boolean;
}

export interface IngestResult {
  /** Target as given (path or URL). */
  target: string;
  /** Directory that was scanned (a temp dir for git targets; removed unless keepClone). */
  root: string;
  inventory: Inventory;
  /** Per-workflow permissions/triggers/actions, for the outbound score. */
  workflows: WorkflowInfo[];
  warnings: string[];
  /** Manifests found but not analysed (unsupported formats, no lockfile, unresolved entries). */
  notAnalysed: NotAnalysedManifest[];
}

/** Ingest a local directory or git URL and return the Inventory. */
export async function ingest(target: string, opts: IngestOptions = {}): Promise<Inventory> {
  return (await ingestDetailed(target, opts)).inventory;
}

/** Like `ingest`, but also returns workflow details and warnings. */
export async function ingestDetailed(target: string, opts: IngestOptions = {}): Promise<IngestResult> {
  if (looksLikeGitUrl(target)) {
    const clone = await cloneRepo(target, opts.git ?? {});
    try {
      const res = await ingestDirectory(clone.dir, { ...opts, rootName: repoNameFromUrl(target) });
      return { ...res, target };
    } finally {
      if (!opts.keepClone) await clone.cleanup();
    }
  }
  const res = await ingestDirectory(target, opts);
  return { ...res, target };
}

export function repoNameFromUrl(url: string): string {
  const last = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? 'repo';
  return last.replace(/\.git$/i, '') || 'repo';
}

const posixJoin = (a: string, b: string): string => {
  const j = path.posix.normalize(path.posix.join(a, b));
  return j === '.' ? '' : j;
};
const dirOf = (rel: string): string => {
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
};

/** Ingest a local directory (no cloning). */
export async function ingestDirectory(dir: string, opts: IngestOptions & { rootName?: string } = {}): Promise<IngestResult> {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
    opts.warn?.(m);
  };
  const root = await realpath(path.resolve(dir));
  if (!(await stat(root)).isDirectory()) throw new Error(`scan target is not a directory: ${dir}`);
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxLock = opts.maxLockfileBytes ?? DEFAULT_MAX_LOCKFILE_BYTES;
  const rootName = opts.rootName ?? path.basename(root);

  const found = await walkTarget(root, opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {});
  if (found.truncated) warn(`file limit reached after ${found.visited} files; inventory may be incomplete`);
  for (const s of found.skippedSymlinks.slice(0, 20)) warn(`symlink not followed: ${s}`);

  const read = async (rel: string, limit: number): Promise<string | null> => {
    try {
      return await readTargetFile(root, rel, limit);
    } catch (err) {
      warn(`${rel}: ${(err as Error).message}`);
      return null;
    }
  };

  // --- config -----------------------------------------------------------------
  let config: BlastradiusConfig = { assets: [] };
  if (found.config) {
    const text = await read(found.config, maxFile);
    if (text !== null) {
      const parsed = parseConfig(text);
      config = parsed.config;
      parsed.warnings.forEach(warn);
    }
  }

  const components = new Map<string, Component>();
  const edgeKeys = new Set<string>();
  const edges: DepEdge[] = [];
  const assets = new Map<string, Asset>();
  const addComponents = (cs: Component[]): void => {
    for (const c of cs) {
      const prev = components.get(c.purl);
      if (!prev) components.set(c.purl, { ...c });
      else {
        if (c.hasInstallScript) prev.hasInstallScript = true;
        prev.resolved ??= c.resolved;
        prev.integrity ??= c.integrity;
      }
    }
  };
  const addEdges = (es: DepEdge[]): void => {
    for (const e of es) {
      const k = `${e.from}\u0000${e.to}\u0000${e.scope}\u0000${e.direct}`;
      if (edgeKeys.has(k)) continue;
      edgeKeys.add(k);
      edges.push(e);
    }
  };

  // --- npm package roots ---------------------------------------------------------
  const manifests = new Map<string, PackageManifest>();
  for (const rel of found.packageJsons) {
    const text = await read(rel, maxFile);
    if (text === null) continue;
    try {
      manifests.set(dirOf(rel), parsePackageJson(text));
    } catch (err) {
      warn(`${rel}: could not parse package.json (${(err as Error).message.slice(0, 200)})`);
    }
  }

  const repoAssetByDir = new Map<string, Asset>();
  const usedIds = new Set<string>();
  const ensureRepoAsset = (pkgDir: string, sourceFile: string, name?: string): Asset => {
    const existing = repoAssetByDir.get(pkgDir);
    if (existing) return existing;
    const display = name ?? (pkgDir === '' ? rootName : path.posix.basename(pkgDir));
    let id = `repo:${display}`;
    if (usedIds.has(id)) id = `repo:${display}#${pkgDir || '.'}`;
    usedIds.add(id);
    const base: Asset = {
      id,
      kind: 'repo',
      name: display,
      environment: inferEnvironment(pkgDir, 'repo'),
      criticality: 3,
      sourceFile,
    };
    const asset = applyOverrides(base, config, pkgDir);
    repoAssetByDir.set(pkgDir, asset);
    assets.set(asset.id, asset);
    return asset;
  };
  // Create assets for every package.json first, shallowest first (stable ids).
  const pkgDirs = [...manifests.keys()].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const d of pkgDirs) ensureRepoAsset(d, posixJoin(d, 'package.json'), manifests.get(d)?.name);

  // Lockfiles: prefer npm-shrinkwrap.json over package-lock.json in the same dir.
  const lockByDir = new Map<string, string>();
  for (const rel of found.lockfiles) {
    const d = dirOf(rel);
    const prev = lockByDir.get(d);
    if (!prev || rel.endsWith('npm-shrinkwrap.json')) lockByDir.set(d, rel);
  }
  const covered = new Set<string>();
  const lockDirs = [...lockByDir.keys()].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const lockDir of lockDirs) {
    const rel = lockByDir.get(lockDir)!;
    const text = await read(rel, maxLock);
    if (text === null) continue;
    try {
      const rootManifest = manifests.get(lockDir);
      const res = parsePackageLock(text, {
        ...(rootManifest ? { rootManifest } : {}),
        assetIdFor: (importerDir, importerName) => {
          const pkgDir = posixJoin(lockDir, importerDir);
          if (pkgDir.startsWith('..')) return undefined; // file: dep outside the tree
          covered.add(pkgDir);
          const hasManifest = manifests.has(pkgDir);
          return ensureRepoAsset(pkgDir, hasManifest ? posixJoin(pkgDir, 'package.json') : rel, manifests.get(pkgDir)?.name ?? importerName?.toLowerCase()).id;
        },
      });
      addComponents(res.components);
      addEdges(res.edges);
      for (const w of res.warnings) warn(`${rel}: ${w}`);
    } catch (err) {
      warn(`${rel}: could not parse lockfile (${(err as Error).message.slice(0, 200)})`);
    }
  }

  // package.json without a lockfile: nothing is resolved (Tier 0: only lockfile-resolved versions
  // become components). Exact pins, placeholders such as 0.0.0 and ranges are one warning per
  // manifest, and the manifest is listed as not analysed.
  const notAnalysed: NotAnalysedManifest[] = [];
  const unsupportedDirs = found.unsupportedLockfiles.map(dirOf);
  const coveredByUnsupported = (d: string): boolean => unsupportedDirs.some((u) => u === '' || d === u || d.startsWith(`${u}/`));
  for (const d of pkgDirs) {
    if (covered.has(d)) continue;
    const m = manifests.get(d)!;
    const deps = manifestDeps(m);
    if (deps.length === 0) continue;
    const file = posixJoin(d, 'package.json');
    const specOf = (spec: string): string => spec.trim().replace(/^npm:.+@(?=[^@]+$)/, '');
    const placeholders = deps.filter((x) => /^v?0\.0\.0(-.*)?$/.test(specOf(x.spec))).length;
    const exact = deps.filter((x) => /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(specOf(x.spec))).length - placeholders;
    const ranges = deps.length - placeholders - exact;
    const detail = [placeholders ? `${placeholders} placeholder 0.0.0` : '', exact ? `${exact} exact pin(s)` : '', ranges ? `${ranges} range(s) or other spec(s)` : ''].filter(Boolean).join(', ');
    const other = found.unsupportedLockfiles.find((f) => dirOf(f) === d);
    warn(`${file}: ${deps.length} unresolved manifest entries (${detail}): no package-lock.json${other ? ` (${other} is not supported yet)` : ''} resolves them, so none became a component`);
    if (!coveredByUnsupported(d)) notAnalysed.push({ file, ecosystem: 'npm', reason: 'no package-lock.json: versions not resolved', packages: deps.length });
  }

  // --- Python (Tier 0): requirements*.txt, uv.lock, poetry.lock, Pipfile.lock, pyproject.toml ---------
  await ingestPython(found.python, {
    read,
    maxFile,
    maxLock,
    warn,
    notAnalysed,
    ensureAsset: (pkgDir, sourceFile, name) => ensureRepoAsset(pkgDir, sourceFile, name).id,
    addComponents,
    addEdges,
  });
  const pythonDirs = new Set(found.python.map(dirOf));

  // --- Manifests we recognise but do not analyse: listed, never silently dropped ------------------
  const others = new Set(found.otherManifests);
  const sameDir = (rel: string, base: string): boolean => others.has(posixJoin(dirOf(rel), base));
  for (const rel of found.otherManifests) {
    const base = path.posix.basename(rel).toLowerCase();
    const d = dirOf(rel);
    // A manifest whose lockfile sits next to it is counted once, through the lockfile.
    if (base === 'gemfile' && sameDir(rel, 'Gemfile.lock')) continue;
    if (base === 'composer.json' && sameDir(rel, 'composer.lock')) continue;
    if (base === 'cargo.toml' && found.otherManifests.some((f) => path.posix.basename(f) === 'Cargo.lock' && (dirOf(f) === '' || d === dirOf(f) || d.startsWith(`${dirOf(f)}/`)))) continue;
    if (/\.(cs|fs|vb)proj$/.test(base) && sameDir(rel, 'packages.lock.json')) continue;
    if (base === 'pipfile' && found.python.includes(posixJoin(d, 'Pipfile.lock'))) continue;
    if ((base === 'setup.py' || base === 'setup.cfg') && pythonDirs.has(d)) continue;
    const text = await read(rel, maxLock);
    const entry = notAnalysedEntry(rel, text);
    if (entry) notAnalysed.push(entry);
  }
  notAnalysed.sort((a, b) => cmp(a.file, b.file));

  // --- GitHub Actions workflows ---------------------------------------------------
  const workflows: WorkflowInfo[] = [];
  for (const rel of found.workflows) {
    const text = await read(rel, maxFile);
    if (text === null) continue;
    try {
      const wf = parseWorkflow(text, rel);
      const asset = applyOverrides(wf.asset, config);
      assets.set(asset.id, asset);
      addComponents(wf.components);
      addEdges(wf.edges);
      workflows.push(wf.info);
      wf.warnings.forEach(warn);
    } catch (err) {
      warn(`${rel}: could not parse workflow (${(err as Error).message.slice(0, 200)})`);
    }
  }

  // --- Dockerfiles ------------------------------------------------------------------
  for (const rel of found.dockerfiles) {
    const text = await read(rel, maxFile);
    if (text === null) continue;
    const parsed = parseDockerfile(text, rel);
    parsed.warnings.forEach(warn);
    if (parsed.images.length === 0) continue;
    const res = dockerfileInventory(parsed, rel, { environment: inferEnvironment(rel, 'image'), criticality: 3 });
    const asset = applyOverrides(res.asset, config, dirOf(rel));
    assets.set(asset.id, asset);
    addComponents(res.components);
    addEdges(res.edges);
  }

  // --- optional Syft SBOM -----------------------------------------------------------
  if (opts.syft) {
    try {
      const sbom = await (opts.syftRunner ?? runSyft)(root);
      if (!sbom) warn('syft not found on PATH; SBOM import skipped');
      else mergeSbom(sbom, { components, addComponents, addEdges, edges, rootAsset: repoAssetByDir.get('') ?? ensureRepoAsset('', '.', undefined), warn });
    } catch (err) {
      warn(`syft: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  const inventory: Inventory = {
    assets: [...assets.values()].sort((a, b) => cmp(a.id, b.id)),
    components: [...components.values()].sort((a, b) => cmp(a.purl, b.purl)),
    edges: edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.scope, b.scope)),
  };
  workflows.sort((a, b) => cmp(a.path, b.path));
  return { target: dir, root, inventory, workflows, warnings, notAnalysed };
}

interface PythonContext {
  read: (rel: string, limit: number) => Promise<string | null>;
  maxFile: number;
  maxLock: number;
  warn: (m: string) => void;
  notAnalysed: NotAnalysedManifest[];
  ensureAsset: (pkgDir: string, sourceFile: string, name?: string) => string;
  addComponents: (cs: Component[]) => void;
  addEdges: (es: DepEdge[]) => void;
}

/** The project directory a requirements file belongs to ("requirements/base.txt" → ""). */
function requirementsProjectDir(rel: string): string {
  const d = dirOf(rel);
  const base = path.posix.basename(d).toLowerCase();
  return base === 'requirements' || base === 'reqs' ? dirOf(d) : d;
}

async function ingestPython(files: readonly string[], ctx: PythonContext): Promise<void> {
  const byBase = (base: string) => files.filter((f) => path.posix.basename(f).toLowerCase() === base);
  const unresolvedWarning = (rel: string, list: readonly string[]): void => {
    if (list.length === 0) return;
    const shown = list.slice(0, 5).join(', ');
    ctx.warn(`${rel}: ${list.length} unresolved manifest entries (unpinned, ranges or URLs; no lockfile resolves them): ${shown}${list.length > 5 ? ', …' : ''}`);
    ctx.notAnalysed.push({ file: rel, ecosystem: 'pypi', reason: `${list.length} unresolved entries (no exact pin or lockfile)`, packages: list.length });
  };
  /** Directories whose pyproject.toml a lockfile or compiled requirements file covers. */
  const coveredProjects = new Set<string>();
  const pyprojects = new Map<string, { rel: string; deps?: PyprojectDeps; error?: string }>();
  for (const rel of byBase('pyproject.toml')) {
    const text = await ctx.read(rel, ctx.maxFile);
    if (text === null) continue;
    try {
      pyprojects.set(dirOf(rel), { rel, deps: parsePyproject(text) });
    } catch (err) {
      pyprojects.set(dirOf(rel), { rel, error: (err as Error).message.slice(0, 200) });
    }
  }

  for (const rel of byBase('uv.lock')) {
    const text = await ctx.read(rel, ctx.maxLock);
    if (text === null) continue;
    const lockDir = dirOf(rel);
    try {
      const res = parseUvLock(text, {
        assetIdFor: (projectDir, name) => {
          const d = posixJoin(lockDir, projectDir);
          if (d.startsWith('..')) return undefined;
          coveredProjects.add(d);
          return ctx.ensureAsset(d, pyprojects.has(d) ? posixJoin(d, 'pyproject.toml') : rel, d === lockDir ? undefined : name);
        },
      });
      coveredProjects.add(lockDir);
      ctx.addComponents(res.components);
      ctx.addEdges(res.edges);
      res.warnings.forEach((w) => ctx.warn(`${rel}: ${w}`));
      unresolvedWarning(rel, res.unresolved);
    } catch (err) {
      ctx.warn(`${rel}: could not parse uv.lock (${(err as Error).message.slice(0, 200)})`);
      ctx.notAnalysed.push({ file: rel, ecosystem: 'pypi', reason: 'uv.lock could not be parsed' });
    }
  }

  for (const rel of byBase('poetry.lock')) {
    const text = await ctx.read(rel, ctx.maxLock);
    if (text === null) continue;
    const d = dirOf(rel);
    try {
      const res = parsePoetryLock(text, ctx.ensureAsset(d, pyprojects.has(d) ? posixJoin(d, 'pyproject.toml') : rel), pyprojects.get(d)?.deps);
      coveredProjects.add(d);
      ctx.addComponents(res.components);
      ctx.addEdges(res.edges);
      res.warnings.forEach((w) => ctx.warn(`${rel}: ${w}`));
      unresolvedWarning(rel, res.unresolved);
    } catch (err) {
      ctx.warn(`${rel}: could not parse poetry.lock (${(err as Error).message.slice(0, 200)})`);
      ctx.notAnalysed.push({ file: rel, ecosystem: 'pypi', reason: 'poetry.lock could not be parsed' });
    }
  }

  for (const rel of byBase('pipfile.lock')) {
    const text = await ctx.read(rel, ctx.maxLock);
    if (text === null) continue;
    const d = dirOf(rel);
    try {
      const res = parsePipfileLock(text, ctx.ensureAsset(d, rel));
      coveredProjects.add(d);
      ctx.addComponents(res.components);
      ctx.addEdges(res.edges);
      unresolvedWarning(rel, res.unresolved);
    } catch (err) {
      ctx.warn(`${rel}: could not parse Pipfile.lock (${(err as Error).message.slice(0, 200)})`);
      ctx.notAnalysed.push({ file: rel, ecosystem: 'pypi', reason: 'Pipfile.lock could not be parsed' });
    }
  }

  // requirements*.txt: exact pins become components; `-r` includes are followed (inside the root).
  const requirements = files.filter((f) => !['uv.lock', 'poetry.lock', 'pipfile.lock', 'pyproject.toml'].includes(path.posix.basename(f).toLowerCase()));
  for (const rel of requirements) {
    const merged: RequirementsFile = { entries: [], includes: [], local: [], unresolved: [], mentionsProject: false };
    const visited = new Set<string>();
    const visit = async (file: string, depth: number): Promise<void> => {
      if (visited.has(file) || depth > 10 || file.startsWith('..')) return;
      visited.add(file);
      const text = await ctx.read(file, ctx.maxFile);
      if (text === null) return;
      const r = parseRequirements(text);
      merged.entries.push(...r.entries);
      merged.local.push(...r.local);
      merged.unresolved.push(...r.unresolved);
      merged.mentionsProject ||= r.mentionsProject;
      for (const inc of r.includes) await visit(posixJoin(dirOf(file), inc), depth + 1);
    };
    await visit(rel, 0);
    const projectDir = requirementsProjectDir(rel);
    const res = requirementsInventory(merged, ctx.ensureAsset(projectDir, rel), requirementsScope(rel));
    if (merged.mentionsProject || merged.local.length > 0) coveredProjects.add(projectDir);
    ctx.addComponents(res.components);
    ctx.addEdges(res.edges);
    unresolvedWarning(rel, [...new Set(res.unresolved)]);
  }

  // pyproject.toml with nothing that resolves its versions.
  for (const [d, p] of pyprojects) {
    if (coveredProjects.has(d)) continue;
    const n = p.deps?.deps.length;
    if (n === 0) continue;
    ctx.notAnalysed.push({
      file: p.rel,
      ecosystem: 'pypi',
      reason: p.error ? `pyproject.toml could not be parsed (${p.error})` : 'pyproject.toml without a lockfile (uv.lock, poetry.lock) or compiled requirements: versions not resolved',
      ...(n !== undefined ? { packages: n } : {}),
    });
  }
}

function mergeSbom(
  sbom: CycloneDxImport,
  ctx: {
    components: Map<string, Component>;
    edges: DepEdge[];
    addComponents: (cs: Component[]) => void;
    addEdges: (es: DepEdge[]) => void;
    rootAsset: Asset;
    warn: (m: string) => void;
  },
): void {
  sbom.warnings.forEach(ctx.warn);
  const fresh = sbom.components.filter((c) => !ctx.components.has(c.purl));
  // Licences the SBOM declares for components the static parsers already found (lockfile first).
  for (const c of sbom.components) {
    const known = ctx.components.get(c.purl);
    if (known && !known.declaredLicenses && c.declaredLicenses) known.declaredLicenses = c.declaredLicenses;
  }
  ctx.addComponents(fresh);
  const newEdges: DepEdge[] = [];
  const hasInbound = new Set(ctx.edges.map((e) => e.to));
  for (const [from, tos] of sbom.dependencies) {
    for (const to of tos) {
      newEdges.push({ from, to, scope: 'runtime', direct: false });
      hasInbound.add(to);
    }
  }
  // Components Syft found that nothing else reaches: attach to the root asset so they are counted.
  for (const c of fresh) if (!hasInbound.has(c.purl)) newEdges.push({ from: ctx.rootAsset.id, to: c.purl, scope: 'runtime', direct: true });
  ctx.addEdges(newEdges);
  if (fresh.length > 0) ctx.warn(`syft: added ${fresh.length} component(s) not found by the static parsers (scope assumed runtime)`);
}

function depth(d: string): number {
  return d === '' ? 0 : d.split('/').length;
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { parsePackageJson, parsePackageLock, componentsFromManifest, resolveLockVersion, nameFromInstallPath } from './npm.js';
export { parseRequirements, requirementsInventory, parseUvLock, parsePoetryLock, parsePipfileLock, parsePyproject, normalizePypiName, pypiPurl } from './python.js';
export { notAnalysedEntry, notAnalysedLine, estimatePackages, unsupportedKind } from './manifests.js';
export type { PackageManifest, LockfileParseOptions, LockfileParseResult } from './npm.js';
export { parseWorkflow, parseUses, classifyActionRef } from './workflows.js';
export type { WorkflowInfo, WorkflowJobInfo, ActionRef, ActionPinning, PermissionsSpec, PermissionLevel, ParsedWorkflow } from './workflows.js';
export { parseDockerfile, parseImageRef, imageComponent, dockerfileInventory } from './docker.js';
export type { ImageRef, ParsedDockerfile, DockerfileImage } from './docker.js';
export { parseConfig, inferEnvironment, applyOverrides } from './config.js';
export type { BlastradiusConfig, AssetOverride } from './config.js';
export { checkGitUrl, looksLikeGitUrl, cloneRepo, cloneArgs } from './git.js';
export type { GitRunner, CloneResult } from './git.js';
export { parseCycloneDx, runSyft, findOnPath } from './syft.js';
export type { CycloneDxImport } from './syft.js';
export { walkTarget, readTargetFile } from './fs.js';
