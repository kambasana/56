/**
 * Scan pipeline (PLAN §3):
 *   ingest → enrich (osv, depsdev, npm, github) → incident KB + OSV MAL-* import
 *   → entity resolution (+ review state) → scoring (intrinsic, entity, inbound/outbound blast radius)
 *   → ScanResult (+ rendered reports).
 *
 * Nothing here executes code from the scanned target. All network I/O goes through one
 * HttpClient per scan, which honours offline mode and recorded fixtures.
 */
import { productNameOf } from './core/repo-url.js';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from './core/http.js';
import { defaultCacheDir, isPathInside } from './core/paths.js';
import { looksLikeGitUrl } from './ingest/git.js';
import { enricherStages, type EnrichContext, type Enricher } from './core/plugin.js';
import type { Fact, HistoryReport, Incident, Inventory, ScanResult, SourceCoverage, StabilityReport } from './core/types.js';
import { ingestDetailed, type IngestOptions, type WorkflowInfo } from './ingest/index.js';
import { createOsvEnricher } from './enrich/osv/index.js';
import { createDepsDevEnricher } from './enrich/depsdev/index.js';
import { createNpmEnricher } from './enrich/npm/index.js';
import { createPypiEnricher } from './enrich/pypi/index.js';
import { createGithubEnricher } from './enrich/github/index.js';
import { createLicenseEnricher } from './enrich/licenses/index.js';
import { buildLicenseReport } from './licenses/report.js';
import { createHistoryEnricher, type HistoryEnricherOptions, type HistorySelection } from './enrich/history/index.js';
import { buildHistoryReport } from './history/report.js';
import { createAgenticEnricher, type AgenticEnricherOptions } from './enrich/agentic/index.js';
import type { AgenticReport } from './core/agentic-types.js';
import { buildStabilityReport } from './stability/report.js';
import type { LicensePolicy } from './licenses/policy.js';
import { incidentsFromMalwareFacts, loadIncidents, validateKbDir } from './incidents/index.js';
import { applyReviewState, buildEntityGraph, loadReviewState, resolveEntities, type EntityGraphData } from './entities/index.js';
import { buildScanResult, scoreInventory } from './scoring/index.js';
import { createPackEnricher } from './pack/enricher.js';
import { loadPack, type LoadedPack } from './pack/load.js';
import { REPORT_FILENAMES, renderReport, type ReportFormat } from './report/index.js';

export type OutputFormat = ReportFormat;
/** Formats written by default. */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'sarif', 'html'];
/** Every format, including the SBOM exports (CycloneDX 1.6, SPDX 2.3). */
export const ALL_OUTPUT_FORMATS: readonly OutputFormat[] = [...OUTPUT_FORMATS, 'cyclonedx', 'spdx'];

/** Incident KB shipped with the package (works from src/ and dist/). */
export const DEFAULT_KB_DIR = fileURLToPath(new URL('../kb/incidents', import.meta.url));

export interface ScanOptions {
  /** Local path or git URL. */
  target: string;
  /** Report formats to write (default: all three). */
  formats?: OutputFormat[];
  /** Output directory. When unset, no files are written (the ScanResult is still returned). */
  outDir?: string;
  /** No live network: answer from fixtures / cache only. */
  offline: boolean;
  /** Directory of recorded API responses (fixture envelopes, searched recursively). */
  fixturesDir?: string;
  /** HTTP cache directory; false disables the disk cache (default: per-user cache dir, see core/paths.ts). */
  cacheDir?: string | false;
  /** Disk budget of the HTTP cache in MB (Tier 0.6, --cache-max-mb; default DEFAULT_HTTP_CACHE_MAX_MB). */
  cacheMaxMb?: number;
  /** Reference time for decay and history (backtests). Defaults to now. */
  now?: Date;
  /** Incident KB directory (default: the bundled kb/incidents). */
  kbDir?: string;
  /** Knowledge pack file (docs/DATA-ML.md); default $BLASTRADIUS_PACK. Adds its known-bad list. */
  packFile?: string;
  /** Entity-link review decisions (JSON). Optional. */
  reviewFile?: string;
  /** Import a Syft SBOM when syft is on PATH. */
  syft?: boolean;
  /**
   * Collect git history of the source repositories (blobless clones; docs/WHO-BEHIND-PLAN.md P2).
   * Off by default. An object passes options to the history enricher (tests: recorded histories).
   */
  history?: boolean | Omit<HistoryEnricherOptions, 'repoFacts'>;
  /** History will be added later by a background job (web, Tier 0): the stability report says `pending`. */
  historyPending?: boolean;
  /**
   * Agentic gap-filler (src/agentic): after every deterministic collector, ask a model with tools
   * for the facts that are still missing; only facts the app verifies are kept. Off by default;
   * needs ANTHROPIC_API_KEY unless a model is injected (tests replay recorded responses).
   */
  agentic?: boolean | Omit<AgenticEnricherOptions, 'facts' | 'onReport'>;
  /** Licence policy for the HTML report's Licences section (default: the shipped template). */
  licensePolicy?: LicensePolicy;
  /** Injected enrichers (tests). Defaults to osv, depsdev, npm, github. */
  enrichers?: (getFacts: () => readonly Fact[]) => Enricher[];
  /** Injected HttpClient (tests). */
  http?: HttpClient;
  /** Ingest overrides (tests: git runner, syft runner). */
  ingest?: Omit<IngestOptions, 'warn' | 'syft'>;
  /** Progress messages (e.g. stderr in the CLI). */
  log?: (message: string) => void;
  /** The product the SBOMs name (CLI --product-name / --product-version); default: the target's repository or directory name. */
  product?: { name?: string; version?: string };
}

export interface ScanOutput {
  result: ScanResult;
  inventory: Inventory;
  facts: Fact[];
  incidents: Incident[];
  workflows: WorkflowInfo[];
  entities: EntityGraphData;
  /** Paths of report files written (empty when outDir is unset). */
  files: string[];
  /** OSV answered for every component (the stability labels' finished test; addHistory reuses it). */
  osvComplete?: boolean;
}

const packCache = new Map<string, Promise<LoadedPack>>();
/** The server scans many times with the same pack: parse it once per path. */
function cachedPack(path: string): Promise<LoadedPack> {
  let p = packCache.get(path);
  if (!p) {
    p = loadPack(path);
    p.catch(() => packCache.delete(path));
    packCache.set(path, p);
  }
  return p;
}

/** Default enricher set; github reads repo facts collected by the earlier enrichers. */
export function defaultEnrichers(getFacts: () => readonly Fact[]): Enricher[] {
  return [createOsvEnricher(), createDepsDevEnricher(), createNpmEnricher(), createPypiEnricher(), createLicenseEnricher(), createGithubEnricher({ repoFacts: getFacts })];
}

/**
 * Advisories published after the reference time did not exist yet; drop them for replays
 * (backtests with --as-of). Facts without a publication date are kept.
 */
export function factsKnownAt(facts: readonly Fact[], now: Date): Fact[] {
  const t = now.getTime();
  return facts.filter((f) => {
    if (f.kind !== 'vuln' && f.kind !== 'malware') return true;
    const p = f.value.published ? Date.parse(f.value.published) : Number.NaN;
    return Number.isNaN(p) || p <= t;
  });
}

/**
 * Incidents not yet known at the reference time are dropped for replays. KB dates are calendar
 * days (YYYY-MM-DD) without a time, so an incident counts as known only once its whole day has
 * passed: an intraday replay on the incident day (e.g. before the advisory) must not see it.
 */
export function incidentsKnownAt(incidents: readonly Incident[], now: Date): Incident[] {
  const t = now.getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  return incidents.filter((i) => {
    const d = Date.parse(i.date);
    if (Number.isNaN(d)) return true;
    const knownFrom = /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? d + DAY_MS : d;
    return knownFrom <= t;
  });
}

export async function scan(opts: ScanOptions): Promise<ScanOutput> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  // 1. Ingest (static parsing only).
  if (opts.offline && looksLikeGitUrl(opts.target)) {
    throw new Error('offline mode cannot clone a git URL; scan a local checkout instead');
  }
  log(`ingesting ${opts.target}`);
  const ingested = await ingestDetailed(opts.target, { ...(opts.ingest ?? {}), syft: opts.syft === true });
  warnings.push(...ingested.warnings);
  const inventory = ingested.inventory;

  // 2. Enrich.
  // The scanned checkout is untrusted: never read cached API responses from inside it.
  let cacheDir: string | false = opts.cacheDir === undefined ? join(defaultCacheDir(), 'http') : opts.cacheDir;
  if (cacheDir !== false && !looksLikeGitUrl(opts.target) && isPathInside(cacheDir, opts.target)) {
    warn(`cache directory ${cacheDir} is inside the scan target ${resolve(opts.target)}; disk cache disabled for this scan`);
    cacheDir = false;
  }
  const http =
    opts.http ??
    new HttpClient({
      offline: opts.offline,
      ...(opts.fixturesDir !== undefined ? { fixturesDir: opts.fixturesDir } : {}),
      ...(opts.cacheMaxMb !== undefined ? { cacheMaxMb: opts.cacheMaxMb } : {}),
      cacheDir,
    });
  const historical = opts.now !== undefined && opts.now.getTime() < Date.now() - 24 * 60 * 60 * 1000;
  const ctx: EnrichContext = { http, now, offline: opts.offline || http.offline, warn, historical };
  const facts: Fact[] = [];
  const enrichers = (opts.enrichers ?? defaultEnrichers)(() => facts);
  let historySelection: HistorySelection | undefined;
  if (opts.history) {
    const h = typeof opts.history === 'object' ? opts.history : {};
    const cache = h.cache ?? (typeof opts.cacheDir === 'string' ? { dir: join(opts.cacheDir, 'git-history') } : undefined);
    enrichers.push(
      createHistoryEnricher({
        ...h,
        ...(cache ? { cache } : {}),
        repoFacts: () => facts,
        onSelection: (sel) => {
          historySelection = sel;
          h.onSelection?.(sel);
        },
      }),
    );
  }
  const packFile = opts.packFile ?? process.env.BLASTRADIUS_PACK;
  if (packFile) {
    const loaded = await cachedPack(packFile);
    log(`knowledge pack ${loaded.path} (built ${loaded.pack.builtAt.slice(0, 10)}, ${loaded.pack.counts.compromisedVersions} bad releases, ${loaded.pack.counts.malwarePackages} malicious packages)`);
    enrichers.push(createPackEnricher(loaded, () => facts));
  }
  let agenticReport: AgenticReport | undefined;
  if (opts.agentic) {
    const a = typeof opts.agentic === 'object' ? opts.agentic : {};
    const cacheDir = a.cacheDir ?? (typeof opts.cacheDir === 'string' ? join(opts.cacheDir, 'agentic') : opts.cacheDir === false ? false : undefined);
    // Last: it only asks for what every other collector left missing.
    enrichers.push(createAgenticEnricher({ ...a, ...(cacheDir !== undefined ? { cacheDir } : {}), facts: () => facts, onReport: (r) => (agenticReport = r) }));
  }
  // Independent enrichers (OSV, deps.dev, npm) talk to different hosts, so they run concurrently;
  // one that reads earlier facts (GitHub) waits for them. Facts and warnings are still appended
  // in the declared enricher order, so the result is the same as running them one by one.
  // Whether OSV answered for every component (no warning, no failure): the stability labels' finished /
  // low-surface test needs "no advisory" to be a checked fact, not a missing one.
  let osvComplete = false;
  const coverage: SourceCoverage[] = [];
  for (const stage of enricherStages(enrichers)) {
    const results = await Promise.all(
      stage.map(async (e) => {
        log(`enriching: ${e.name}`);
        const notes: string[] = [];
        const ectx: EnrichContext = { ...ctx, warn: (m) => notes.push(m) };
        try {
          const out = await e.enrich(inventory, ectx);
          if (e.name === 'osv' && notes.length === 0) osvComplete = true;
          return { name: e.name, facts: out, notes, threw: false };
        } catch (err) {
          notes.push(`enricher ${e.name} failed: ${(err as Error).message}`);
          return { name: e.name, facts: [] as Fact[], notes, threw: true };
        }
      }),
    );
    for (const r of results) {
      facts.push(...r.facts);
      for (const n of r.notes) warn(n);
      coverage.push(sourceCoverage(r.name, r.facts.length, r.notes, r.threw, inventory.components.length));
    }
  }
  const down = http.unavailableHosts();
  if (down.length > 0) log(`skipped unreachable host(s) after repeated network errors: ${down.join(', ')}`);
  if (down.length > 0) warn(`unreachable host(s), lookups skipped: ${down.join(', ')}`);

  const known = factsKnownAt(facts, now);
  if (known.length < facts.length) {
    log(`ignoring ${facts.length - known.length} advisory fact(s) published after ${now.toISOString()}`);
    facts.splice(0, facts.length, ...known);
  }

  // 3. Incidents: curated KB + OSV MAL-* advisories, restricted to what was known at `now`.
  const kb = await loadIncidents(opts.kbDir ?? DEFAULT_KB_DIR);
  for (const e of kb.errors) warn(`kb: ${e.file}: ${e.message}`);
  const incidents = incidentsKnownAt([...kb.incidents, ...incidentsFromMalwareFacts(facts)], now);

  // 4. Entities (+ human review decisions).
  let entities = resolveEntities(facts, { incidents });
  if (opts.reviewFile) {
    const review = applyReviewState(entities.links, await loadReviewState(opts.reviewFile));
    entities = { ...entities, links: review.links };
    if (review.unmatched.length > 0) warn(`review: ${review.unmatched.length} decision(s) did not match any link`);
  }

  // 5. Score + blast radius.
  log('scoring');
  const score = scoreInventory(inventory, facts, {
    now,
    incidents,
    entityPaths: buildEntityGraph(entities, incidents),
    workflows: ingested.workflows,
  });
  const result = buildScanResult({ target: opts.target, inventory, score, generatedAt: now, warnings: dedupe(warnings) });
  result.product = { name: opts.product?.name?.trim() || productNameOf(opts.target), ...(opts.product?.version?.trim() ? { version: opts.product.version.trim() } : {}) };
  // Tier 0: never a silent all-clear. Manifests we found but did not analyse are listed in every report.
  if (ingested.notAnalysed.length > 0) result.notAnalysed = ingested.notAnalysed;
  if (coverage.length > 0) result.coverage = { sources: coverage };
  // Licences (shown from others): declared values with their sources and changes; no score impact.
  // Always present on new scans (components without data count as unknown), so a missing section
  // means a scan made before licences were collected.
  result.licenses = buildLicenseReport(inventory, facts);
  const history = buildHistoryReport(facts);
  if (history) result.history = history;
  if (agenticReport) result.agentic = agenticReport;
  // Stability labels (plan §4, P3): repo-level facts only; not risk, no effect on findings.
  const httpCache = await http.cacheUsage?.();
  result.stability = buildStabilityReport(inventory, facts, now, {
    advisoriesChecked: osvComplete,
    ...(historySelection ? { historySelection } : {}),
    ...(httpCache ? { httpCache } : {}),
    historyStatus: opts.history ? 'done' : opts.historyPending ? 'pending' : 'off',
  });

  // 6. Reports.
  const files: string[] = [];
  if (opts.outDir !== undefined) {
    // The default out dir ("out" in the cwd) is often inside the scanned checkout, which may
    // commit symlinks there: never write through one.
    const scanRoot = looksLikeGitUrl(opts.target) ? undefined : opts.target;
    await assertNoSymlinkedOutDir(opts.outDir, scanRoot);
    await mkdir(opts.outDir, { recursive: true });
    await assertNoSymlinkedOutDir(opts.outDir, scanRoot);
    for (const format of opts.formats ?? OUTPUT_FORMATS) {
      files.push(
        await writeReportFile(
          opts.outDir,
          REPORT_FILENAMES[format],
          renderReport(result, format, { assets: inventory.assets, inventory, ...(opts.licensePolicy ? { licensePolicy: opts.licensePolicy, licensePolicyLabel: 'custom (--license-policy)' } : {}) }),
        ),
      );
    }
  }
  return { result, inventory, facts, incidents, workflows: ingested.workflows, entities, files, osvComplete };
}

/**
 * Add git history to a finished scan (web background job, Tier 0): run the history enricher on the
 * scan's own facts and rebuild the history and stability sections. Everything else in the result
 * (findings, exposure) stays as it was, so the exposure answer can be shown before history is read.
 */
export async function addHistory(out: Pick<ScanOutput, 'result' | 'inventory' | 'facts' | 'osvComplete'>, opts: { now: Date; http?: HttpClient; offline?: boolean; cacheDir?: string | false; cacheMaxMb?: number; history?: Omit<HistoryEnricherOptions, 'repoFacts'> }): Promise<{ history?: HistoryReport; stability: StabilityReport }> {
  const facts = [...out.facts];
  let historySelection: HistorySelection | undefined;
  const h = opts.history ?? {};
  const cache = h.cache ?? (typeof opts.cacheDir === 'string' ? { dir: join(opts.cacheDir, 'git-history') } : undefined);
  const enricher = createHistoryEnricher({ ...h, ...(cache ? { cache } : {}), repoFacts: () => facts, onSelection: (sel) => (historySelection = sel) });
  const http = opts.http ?? new HttpClient({ offline: opts.offline === true, ...(opts.cacheMaxMb !== undefined ? { cacheMaxMb: opts.cacheMaxMb } : {}), cacheDir: opts.cacheDir === undefined ? join(defaultCacheDir(), 'http') : opts.cacheDir });
  const warnings: string[] = [];
  facts.push(...(await enricher.enrich(out.inventory, { http, now: opts.now, offline: opts.offline === true || http.offline, warn: (m) => warnings.push(m) })));
  const history = buildHistoryReport(facts);
  const httpCache = await http.cacheUsage?.();
  const stability = buildStabilityReport(out.inventory, facts, opts.now, { advisoriesChecked: out.osvComplete === true, ...(historySelection ? { historySelection } : {}), ...(httpCache ? { httpCache } : {}), historyStatus: 'done' });
  return { ...(history ? { history } : {}), stability };
}

/** Sources whose data decides whether a component is known-vulnerable or malicious. */
export const SECURITY_SOURCES: ReadonlySet<string> = new Set(['osv', 'pack']);

/**
 * Coverage of one enricher run (Tier 0): failed when it threw, or reported problems and produced
 * nothing while there were components to check; partial when it reported problems; ok otherwise.
 */
export function sourceCoverage(source: string, factCount: number, notes: readonly string[], threw: boolean, components: number): SourceCoverage {
  const status: SourceCoverage['status'] = threw || (notes.length > 0 && factCount === 0 && components > 0) ? 'failed' : notes.length > 0 ? 'partial' : 'ok';
  const reason = notes.length > 0 ? `${notes[0]!.slice(0, 300)}${notes.length > 1 ? ` (+${notes.length - 1} more)` : ''}` : undefined;
  return { source, status, security: SECURITY_SOURCES.has(source), facts: factCount, problems: notes.length, ...(reason ? { reason } : {}) };
}

/** Back-compat wrapper returning only the ScanResult. */
export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  return (await scan(opts)).result;
}

async function lstatOrUndefined(p: string) {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Refuse an output directory that is a symlink, or that reaches the filesystem through a
 * symlinked directory inside the scan target (whose contents the scanned repo controls).
 */
async function assertNoSymlinkedOutDir(outDir: string, scanRoot: string | undefined): Promise<void> {
  const abs = resolve(outDir);
  const check = [abs];
  if (scanRoot !== undefined && isPathInside(abs, scanRoot)) {
    const root = resolve(scanRoot);
    for (let d = dirname(abs); d !== root && isPathInside(d, root); d = dirname(d)) check.push(d);
  }
  for (const p of check) {
    if ((await lstatOrUndefined(p))?.isSymbolicLink()) throw new Error(`refusing to write reports: ${p} is a symbolic link`);
  }
}

/**
 * Write one report without following a symlink at the destination: refuse an existing symlink or
 * non-regular file, write a fresh temp file (O_EXCL) and rename it over the destination (rename
 * replaces a directory entry, it never writes through a link created in the meantime).
 */
async function writeReportFile(dir: string, name: string, data: string): Promise<string> {
  const file = join(dir, name);
  const st = await lstatOrUndefined(file);
  if (st && !st.isFile()) throw new Error(`refusing to write report: ${file} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}`);
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { flag: 'wx', mode: 0o644 });
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return file;
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}

export interface KbValidationResult {
  ok: boolean;
  files: number;
  errors: { file: string; message: string }[];
}

export async function validateKb(dir: string = DEFAULT_KB_DIR): Promise<KbValidationResult> {
  return validateKbDir(dir);
}
