/**
 * In-process scan queue. Queued scans live in the store; this runner picks them up oldest
 * first, runs at most `concurrency` at a time through the engine pipeline, and records the
 * outcome. Scanning never executes repository code (the pipeline only parses manifests).
 */
import type { HistoryEnricherOptions } from '../enrich/history/index.js';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isPathInside } from '../core/paths.js';
import { addHistory, scan, type ScanOptions, type ScanOutput } from '../pipeline.js';
import { recordedHistories } from '../history/fixture.js';
import type { GitRunner } from '../ingest/git.js';
import { ApiHttpError } from './errors.js';
import { checkTarget, cloneTarget } from './targets.js';
import { attachScanHistory, completeScan, failScan, getScanById, listQueuedScans, markScanRunning, type Store } from './store/index.js';

export interface ScanJobOverrides {
  /** Reference time (backtests / fixture replays). */
  asOf?: Date;
  /** Force offline with this fixtures dir. */
  fixturesDir?: string;
  offline?: boolean;
  /** Git ref for git targets. */
  ref?: string;
}

export interface ScanJobsOptions {
  store: Store;
  /** Max scans at once (1–4, default 2). */
  concurrency?: number;
  /** Local scan roots (realpath-checked again at run time). */
  localRoots: () => readonly string[];
  /** Server-wide offline mode with a fixtures dir. */
  offline?: boolean;
  fixturesDir?: string;
  /** Server-wide reference time (offline demos). */
  asOf?: Date;
  /**
   * Fixture replay (--dev-seed): local targets inside `root` scan offline against `fixturesDir`
   * as of `asOf`. Every other target scans with the real current date (unless `asOf` is set).
   */
  fixtureReplay?: FixtureReplay;
  /** Extra engine options (tests inject an offline HttpClient, cache dir). */
  scanOptions?: Partial<ScanOptions>;
  /** Git runner override (tests). */
  gitRunner?: GitRunner;
  /** Called after a scan succeeds (alert check, account index). `mode` is how the scan fetched registry data. Must not throw. */
  onScanSucceeded?: (projectId: string, mode: { offline: boolean; fixturesDir?: string }) => void;
  /** Clone timeout (ms). */
  cloneTimeoutMs?: number;
  /**
   * Tier 0: read git history for online scans as a background job after the scan is stored (the
   * exposure answer first), so the web shows the same stability labels as `scan --history`.
   * `maxRepos` is the per-scan cap (default 300). Off by default (tests); `serve` turns it on.
   */
  history?: false | { maxRepos?: number; maxMb?: number; cacheDir?: string; recorded?: HistoryEnricherOptions['recorded'] };
  /** Called after the background history job attached its result (tests, logs). */
  onHistoryDone?: (scanId: string, ok: boolean) => void;
  log?: (m: string) => void;
}

export interface FixtureReplay {
  root: string;
  asOf: Date;
  fixturesDir: string;
}

/** The replay settings when `localPath` (already realpath-resolved) is inside the replay root. */
export function fixtureReplayFor(replay: FixtureReplay | undefined, localPath: string): FixtureReplay | undefined {
  if (!replay) return undefined;
  let root: string;
  try {
    root = realpathSync(replay.root);
  } catch {
    return undefined;
  }
  return isPathInside(localPath, root) ? replay : undefined;
}

export class ScanJobs {
  private readonly running = new Set<string>();
  private readonly overrides = new Map<string, ScanJobOverrides>();
  private readonly waiters = new Map<string, (() => void)[]>();
  /** Background history jobs, one at a time (clones are disk- and network-heavy). */
  private readonly historyQueue: { scanId: string; out: ScanOutput; now: Date }[] = [];
  private historyRunning: Promise<void> | null = null;
  private readonly concurrency: number;
  private stopped = false;

  constructor(private readonly opts: ScanJobsOptions) {
    this.concurrency = Math.min(4, Math.max(1, Math.floor(opts.concurrency ?? 2)));
  }

  /** Remember per-scan options (call right after enqueueScan, before kick). */
  setOverrides(scanId: string, o: ScanJobOverrides): void {
    this.overrides.set(scanId, o);
  }

  /** Fixture replay settings that apply to a local target path (see ScanJobsOptions.fixtureReplay). */
  replayFor(localPath: string): FixtureReplay | undefined {
    return fixtureReplayFor(this.opts.fixtureReplay, localPath);
  }

  get activeCount(): number {
    return this.running.size;
  }

  /** Start queued scans up to the concurrency limit. Safe to call any time. */
  kick(): void {
    if (this.stopped) return;
    const free = this.concurrency - this.running.size;
    if (free <= 0) return;
    const queued = listQueuedScans(this.opts.store, 50).filter((s) => !this.running.has(s.id));
    for (const s of queued.slice(0, free)) {
      this.running.add(s.id);
      void this.run(s.id).finally(() => {
        this.running.delete(s.id);
        this.overrides.delete(s.id);
        for (const w of this.waiters.get(s.id) ?? []) w();
        this.waiters.delete(s.id);
        this.kick();
      });
    }
  }

  /** Resolves when the scan has finished (succeeded or failed). For tests and the dev seed. */
  waitFor(scanId: string): Promise<void> {
    const s = getScanById(this.opts.store, scanId);
    if (!s || s.status === 'succeeded' || s.status === 'failed') return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(scanId) ?? [];
      list.push(resolve);
      this.waiters.set(scanId, list);
    });
  }

  /** Resolves when no background history job is queued or running. */
  async historyIdle(): Promise<void> {
    while (this.historyRunning) await this.historyRunning;
  }

  private runHistoryQueue(): void {
    if (this.historyRunning || this.historyQueue.length === 0) return;
    const log = this.opts.log ?? (() => {});
    this.historyRunning = (async () => {
      while (this.historyQueue.length > 0 && !this.stopped) {
        const job = this.historyQueue.shift()!;
        let ok = false;
        try {
          const h = this.opts.history || {};
          const sections = await addHistory(job.out, {
            now: job.now,
            ...(this.opts.scanOptions?.http ? { http: this.opts.scanOptions.http } : {}),
            ...(this.opts.scanOptions?.cacheDir !== undefined ? { cacheDir: this.opts.scanOptions.cacheDir } : {}),
            history: { ...(h.maxRepos !== undefined ? { maxRepos: h.maxRepos } : {}), ...(h.maxMb !== undefined ? { maxMb: h.maxMb } : {}), ...(h.cacheDir ? { cache: { dir: h.cacheDir } } : {}), ...(h.recorded ? { recorded: h.recorded } : {}) },
          });
          ok = attachScanHistory(this.opts.store, job.scanId, sections);
          log(`scan ${job.scanId}: git history attached (${sections.stability.coverage?.line ?? 'no coverage line'})`);
        } catch (err) {
          log(`scan ${job.scanId}: git history failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.opts.onHistoryDone?.(job.scanId, ok);
      }
    })().finally(() => {
      this.historyRunning = null;
      if (this.historyQueue.length > 0 && !this.stopped) this.runHistoryQueue();
    });
  }

  /** Resolves when nothing is running or queued. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running.size === 0 && listQueuedScans(this.opts.store, 1).length === 0) return;
      await Promise.all([...this.running].map((id) => this.waitFor(id)));
      if (this.running.size === 0) this.kick();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Stop starting new scans. */
  stop(): void {
    this.stopped = true;
  }

  /** Wait for the scans running right now (they cannot be cancelled mid-pipeline). */
  async drain(): Promise<void> {
    await Promise.all([...this.running].map((id) => this.waitFor(id)));
  }

  private async run(scanId: string): Promise<void> {
    const { store } = this.opts;
    const log = this.opts.log ?? (() => {});
    const o = this.overrides.get(scanId) ?? {};
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const s = markScanRunning(store, scanId);
      const target = checkTarget(s.target, this.opts.localRoots());
      const replay = target.kind === 'local' ? fixtureReplayFor(this.opts.fixtureReplay, target.path) : undefined;
      const fixturesDir = o.fixturesDir ?? (this.opts.offline ? this.opts.fixturesDir : undefined) ?? replay?.fixturesDir;
      const offline = o.offline === true || s.offline || this.opts.offline === true || o.fixturesDir !== undefined || replay !== undefined;
      let dir: string;
      let commit: string | null = null;
      if (target.kind === 'git') {
        if (offline) throw new SafeScanError('Offline scans need a local target');
        const cloned = await cloneTarget(target.url, {
          ...(o.ref !== undefined ? { ref: o.ref } : {}),
          ...(this.opts.gitRunner ? { runner: this.opts.gitRunner } : {}),
          ...(this.opts.cloneTimeoutMs !== undefined ? { timeoutMs: this.opts.cloneTimeoutMs } : {}),
        });
        cleanup = cloned.cleanup;
        dir = cloned.dir;
        commit = cloned.commit;
      } else {
        dir = target.path;
      }
      log(`scan ${scanId}: started`);
      const asOf = o.asOf ?? this.opts.asOf ?? replay?.asOf;
      // Online scans: git history runs afterwards in the background (Tier 0), so the exposure answer
      // is stored first and the stability labels say "pending" until history arrives.
      const backgroundHistory = this.opts.history !== undefined && this.opts.history !== false && !offline;
      const out = await scan({
        ...(backgroundHistory ? { historyPending: true } : {}),
        // Offline fixture replays also replay recorded git histories (<fixtures>/history/recorded), so
        // the stability labels have their repo-level facts; nothing is cloned.
        ...(offline && fixturesDir !== undefined ? { history: { recorded: recordedHistories(join(fixturesDir, 'history', 'recorded')) } } : {}),
        ...this.opts.scanOptions,
        target: dir,
        offline,
        ...(fixturesDir !== undefined ? { fixturesDir } : {}),
        ...(asOf ? { now: asOf } : {}),
      });
      // Report the target as the project knows it, not the temp checkout path.
      const result = { ...out.result, target: s.target };
      completeScan(store, scanId, { result, inventory: out.inventory, commit });
      log(`scan ${scanId}: succeeded (${result.findings.length} findings)`);
      this.opts.onScanSucceeded?.(s.projectId, { offline, ...(fixturesDir !== undefined ? { fixturesDir } : {}) });
      if (backgroundHistory) {
        this.historyQueue.push({ scanId, out, now: asOf ?? new Date() });
        this.runHistoryQueue();
      }
    } catch (err) {
      log(`scan ${scanId}: failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        failScan(store, scanId, safeScanMessage(err));
      } catch {
        // The scan row may already be final (or gone with its project).
      }
    } finally {
      if (cleanup) await cleanup().catch(() => {});
    }
  }
}

/** An error whose message is safe to show to users as-is. */
export class SafeScanError extends Error {}

/** One safe line for the scan row: no file system paths, no URLs with secrets, no stack. */
export function safeScanMessage(err: unknown): string {
  if (err instanceof SafeScanError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  if (/^git clone failed/i.test(raw)) {
    if (/not found|does not exist|Repository not found/i.test(raw)) return 'Git clone failed: repository not found or not public';
    if (/timed out|ETIMEDOUT|SIGTERM/i.test(raw)) return 'Git clone failed: timed out';
    if (/Remote branch .* not found/i.test(raw)) return 'Git clone failed: ref not found';
    return 'Git clone failed';
  }
  // Request-validation errors (targets.ts) are written for users; anything else is redacted below.
  if (err instanceof ApiHttpError) return raw.slice(0, 200);
  const cleaned = raw
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(^|[\s'"(=])(\/|[A-Za-z]:\\)[^\s'"),]*/g, '$1<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return cleaned ? `Scan failed: ${cleaned}` : 'Scan failed';
}
