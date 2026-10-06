/**
 * Scan pipeline (PLAN §3):
 *   ingest → enrich (osv, depsdev, npm, github) → incident KB + OSV MAL-* import
 *   → entity resolution (+ review state) → scoring (intrinsic, entity, inbound/outbound blast radius)
 *   → ScanResult (+ rendered reports).
 *
 * Nothing here executes code from the scanned target. All network I/O goes through one
 * HttpClient per scan, which honours offline mode and recorded fixtures.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from './core/http.js';
import { defaultCacheDir, isPathInside } from './core/paths.js';
import { looksLikeGitUrl } from './ingest/git.js';
import type { EnrichContext, Enricher } from './core/plugin.js';
import type { Fact, Incident, Inventory, ScanResult } from './core/types.js';
import { ingestDetailed, type IngestOptions, type WorkflowInfo } from './ingest/index.js';
import { createOsvEnricher } from './enrich/osv/index.js';
import { createDepsDevEnricher } from './enrich/depsdev/index.js';
import { createNpmEnricher } from './enrich/npm/index.js';
import { createGithubEnricher } from './enrich/github/index.js';
import { incidentsFromMalwareFacts, loadIncidents, validateKbDir } from './incidents/index.js';
import { applyReviewState, buildEntityGraph, loadReviewState, resolveEntities, type EntityGraphData } from './entities/index.js';
import { buildScanResult, scoreInventory } from './scoring/index.js';
import { REPORT_FILENAMES, renderReport, type ReportFormat } from './report/index.js';

export type OutputFormat = ReportFormat;
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'sarif', 'html'];

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
  /** Reference time for decay and history (backtests). Defaults to now. */
  now?: Date;
  /** Incident KB directory (default: the bundled kb/incidents). */
  kbDir?: string;
  /** Entity-link review decisions (JSON). Optional. */
  reviewFile?: string;
  /** Import a Syft SBOM when syft is on PATH. */
  syft?: boolean;
  /** Injected enrichers (tests). Defaults to osv, depsdev, npm, github. */
  enrichers?: (getFacts: () => readonly Fact[]) => Enricher[];
  /** Injected HttpClient (tests). */
  http?: HttpClient;
  /** Ingest overrides (tests: git runner, syft runner). */
  ingest?: Omit<IngestOptions, 'warn' | 'syft'>;
  /** Progress messages (e.g. stderr in the CLI). */
  log?: (message: string) => void;
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
}

/** Default enricher set; github reads repo facts collected by the earlier enrichers. */
export function defaultEnrichers(getFacts: () => readonly Fact[]): Enricher[] {
  return [createOsvEnricher(), createDepsDevEnricher(), createNpmEnricher(), createGithubEnricher({ repoFacts: getFacts })];
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
      cacheDir,
    });
  const historical = opts.now !== undefined && opts.now.getTime() < Date.now() - 24 * 60 * 60 * 1000;
  const ctx: EnrichContext = { http, now, offline: opts.offline || http.offline, warn, historical };
  const facts: Fact[] = [];
  const enrichers = (opts.enrichers ?? defaultEnrichers)(() => facts);
  for (const e of enrichers) {
    log(`enriching: ${e.name}`);
    try {
      facts.push(...(await e.enrich(inventory, ctx)));
    } catch (err) {
      warn(`enricher ${e.name} failed: ${(err as Error).message}`);
    }
  }

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

  // 6. Reports.
  const files: string[] = [];
  if (opts.outDir !== undefined) {
    await mkdir(opts.outDir, { recursive: true });
    for (const format of opts.formats ?? OUTPUT_FORMATS) {
      const file = join(opts.outDir, REPORT_FILENAMES[format]);
      await writeFile(file, renderReport(result, format, { assets: inventory.assets }));
      files.push(file);
    }
  }
  return { result, inventory, facts, incidents, workflows: ingested.workflows, entities, files };
}

/** Back-compat wrapper returning only the ScanResult. */
export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  return (await scan(opts)).result;
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
