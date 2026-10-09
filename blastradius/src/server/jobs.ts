/**
 * In-process scan queue. Queued scans live in the store; this runner picks them up oldest
 * first, runs at most `concurrency` at a time through the engine pipeline, and records the
 * outcome. Scanning never executes repository code (the pipeline only parses manifests).
 */
import { realpathSync } from 'node:fs';
import { isPathInside } from '../core/paths.js';
import { scan, type ScanOptions } from '../pipeline.js';
import type { GitRunner } from '../ingest/git.js';
import { ApiHttpError } from './errors.js';
import { checkTarget, cloneTarget } from './targets.js';
import { completeScan, failScan, getScanById, listQueuedScans, markScanRunning, type Store } from './store/index.js';

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
  /** Called after every scan, succeeded or failed (connected-repo bookkeeping). Must not throw. */
  onScanFinished?: (projectId: string, scanId: string, ok: boolean) => void;
  /**
   * Fetch-only scans for projects linked to a connected repo (sources): the inventory files at
   * the ref, written to a temp dir. Null means the project is not connected: use its target.
   */
  materialise?: (projectId: string, ref: string | undefined) => Promise<FetchedTarget | null>;
  /** Clone timeout (ms). */
  cloneTimeoutMs?: number;
  log?: (m: string) => void;
}

export interface FetchedTarget {
  dir: string;
  commit: string | null;
  cleanup: () => Promise<void>;
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
    let projectId: string | undefined;
    let ok = false;
    try {
      const s = markScanRunning(store, scanId);
      projectId = s.projectId;
      let dir: string;
      let commit: string | null = null;
      let offline: boolean;
      let fixturesDir: string | undefined;
      let replay: FixtureReplay | undefined;
      const fetched = this.opts.materialise ? await this.opts.materialise(s.projectId, o.ref) : null;
      if (fetched) {
        // A connected repo: only its manifests, lockfiles and workflows, read through the host API.
        cleanup = fetched.cleanup;
        offline = o.offline === true || s.offline || this.opts.offline === true || o.fixturesDir !== undefined;
        if (offline) throw new SafeScanError('Offline scans need a local target');
        dir = fetched.dir;
        commit = fetched.commit;
      } else {
        const target = checkTarget(s.target, this.opts.localRoots());
        replay = target.kind === 'local' ? fixtureReplayFor(this.opts.fixtureReplay, target.path) : undefined;
        fixturesDir = o.fixturesDir ?? (this.opts.offline ? this.opts.fixturesDir : undefined) ?? replay?.fixturesDir;
        offline = o.offline === true || s.offline || this.opts.offline === true || o.fixturesDir !== undefined || replay !== undefined;
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
      }
      log(`scan ${scanId}: started`);
      const asOf = o.asOf ?? this.opts.asOf ?? replay?.asOf;
      const out = await scan({
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
      ok = true;
      this.opts.onScanSucceeded?.(s.projectId, { offline, ...(fixturesDir !== undefined ? { fixturesDir } : {}) });
    } catch (err) {
      log(`scan ${scanId}: failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        failScan(store, scanId, safeScanMessage(err));
      } catch {
        // The scan row may already be final (or gone with its project).
      }
    } finally {
      if (cleanup) await cleanup().catch(() => {});
      if (projectId !== undefined) {
        try {
          this.opts.onScanFinished?.(projectId, scanId, ok);
        } catch {
          // bookkeeping only
        }
      }
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
