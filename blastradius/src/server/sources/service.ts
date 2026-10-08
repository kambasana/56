/**
 * Connected sources at run time (docs/CONNECTORS.md §2): install, discovery, fetch-only scans,
 * webhooks and health. Repos become projects, so findings, alerts and blast radius are unchanged.
 *
 * Health is shown, never hidden: when the host refuses (revoked or suspended install, 401) the
 * source and its repos are marked access_lost. Nothing is deleted.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { touchesInventory } from '../../ingest/select.js';
import type { SourceHostName } from '../api-types.js';
import { SafeScanError, type FetchedTarget, type ScanJobs } from '../jobs.js';
import {
  connectSource,
  consumeInstallState,
  createPendingSource,
  createProject,
  enqueueScan,
  finishDelivery,
  getProject,
  getSourceById,
  getSourceByInstallation,
  getSourceRepoByHostId,
  getSourceRepoById,
  isStoreError,
  listProjects,
  listSourceRepos,
  markReposAccessLost,
  markSourceRepoRemoved,
  patchSourceRepo,
  pruneDeliveries,
  recordDelivery,
  setSourceStatus,
  sourceRepoForProject,
  updateSourceSettings,
  upsertSourceRepo,
  userAccess,
  type SourceRecord,
  type SourceRepoRecord,
  type Store,
} from '../store/index.js';
import type { GitHubAdapter } from './github.js';
import { materialiseRepo } from './materialise.js';
import { SourceAccessError } from './types.js';

/** Audit actor for changes made on a host's behalf (webhooks, discovery). */
export const GITHUB_ACTOR = 'github-app';
const STATE_TTL_MS = 30 * 60_000;
const LAST_SCAN_FAILED = 'Last scan failed';

export interface SourceServiceOptions {
  store: Store;
  jobs: ScanJobs;
  github: GitHubAdapter | null;
  log?: (m: string) => void;
  /** Max repos inspected at once during discovery (default 2). */
  concurrency?: number;
}

export type DeliveryOutcome = string;

export class SourceService {
  readonly github: GitHubAdapter | null;
  /** Deliveries dropped for a missing or bad signature since start. */
  rejectedDeliveries = 0;
  private readonly store: Store;
  private readonly jobs: ScanJobs;
  private readonly log: (m: string) => void;
  private readonly concurrency: number;
  private readonly background = new Set<Promise<unknown>>();
  /** Projects whose repo changed while a scan was already queued or running: scan again after. */
  private readonly rescanAfter = new Set<string>();
  private readonly stateKey: Buffer;

  constructor(opts: SourceServiceOptions) {
    this.store = opts.store;
    this.jobs = opts.jobs;
    this.github = opts.github;
    this.log = opts.log ?? (() => {});
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    // Install states are signed (key derived from the webhook secret) and also stored hashed, single use.
    this.stateKey = opts.github ? opts.github.deriveKey('install-state') : randomBytes(32);
  }

  configured(host: SourceHostName): boolean {
    return host === 'github' && this.github !== null;
  }

  /** Resolves when no discovery or webhook follow-up is running (tests). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private spawn(label: string, fn: () => Promise<unknown>): void {
    const p = fn()
      .catch((err) => this.log(`sources: ${label} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  // ---- Install ---------------------------------------------------------------

  private sign(payload: string): string {
    return createHmac('sha256', this.stateKey).update(payload).digest('base64url');
  }

  /** Start a GitHub App install for the org. The state is signed, single use and expires in 30 min. */
  async startInstall(orgId: string, actor: string, autoWatch: boolean): Promise<{ source: SourceRecord; installUrl: string; expiresAt: string }> {
    if (!this.github) throw new InstallError('GitHub App is not configured on this server');
    const secret = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.store.now().getTime() + STATE_TTL_MS);
    const source = createPendingSource(this.store, orgId, { host: 'github', autoWatch, stateSecret: secret, expiresAt }, actor);
    const body = `${source.id}.${secret}`;
    const installUrl = await this.github.installUrl(`${body}.${this.sign(body)}`);
    return { source, installUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * GitHub sent the browser back after an install. The state must be ours, unexpired and unused;
   * its creator must still hold manage_projects; and the OAuth `code` must belong to a GitHub user
   * who can see `installationId` (the setup URL alone can be forged).
   */
  async completeInstall(input: { state: string; installationId: string; code: string | undefined }): Promise<SourceRecord> {
    if (!this.github) throw new InstallError('GitHub App is not configured on this server');
    const parts = input.state.split('.');
    if (parts.length !== 3) throw new InstallError('Install link is not valid');
    const [sourceId, secret, sig] = parts as [string, string, string];
    const want = Buffer.from(this.sign(`${sourceId}.${secret}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new InstallError('Install link is not valid');
    if (!/^\d{1,15}$/.test(input.installationId)) throw new InstallError('Installation id is not valid');
    const pending = consumeInstallState(this.store, sourceId, secret);
    if (!pending) throw new InstallError('Install link has expired or was already used: start again');
    if (!userAccess(this.store, pending.orgId, pending.createdBy).permissions.includes('manage_projects')) {
      throw new InstallError('The person who started this install can no longer manage projects');
    }
    if (!input.code || !(await this.github.installerCanSee(input.code, input.installationId))) {
      throw new InstallError('GitHub did not confirm you can access this installation');
    }
    const inst = await this.github.getInstallation(input.installationId);
    if (inst.suspended) throw new InstallError('This installation is suspended on GitHub');
    const source = connectSource(
      this.store,
      pending.id,
      { installationId: inst.id, account: inst.account, accountType: inst.accountType, repositorySelection: inst.repositorySelection },
      pending.createdBy,
    );
    this.spawn(`discover ${source.id}`, () => this.discover(source.id, pending.createdBy));
    return source;
  }

  // ---- Discovery -------------------------------------------------------------

  /** List the installation's repos, record them, then inspect each (lockfiles, project, scan). */
  async discover(sourceId: string, actor: string): Promise<void> {
    const source = getSourceById(this.store, sourceId);
    if (!source || !source.installationId || !this.github || source.status === 'disconnected' || source.status === 'pending') return;
    let repos;
    try {
      repos = await this.github.listRepos(source.installationId);
    } catch (err) {
      if (err instanceof SourceAccessError) return this.accessLost(source, err, actor);
      throw err;
    }
    let current = source.status === 'access_lost' ? setSourceStatus(this.store, source.id, 'connected', null, actor) : source;
    current = getSourceById(this.store, current.id)!;
    const seen = new Set<string>();
    for (const r of repos) {
      seen.add(r.id);
      upsertSourceRepo(this.store, current, { repoId: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private, htmlUrl: r.htmlUrl }, actor);
    }
    for (const row of listSourceRepos(this.store, current.id)) {
      if (!seen.has(row.repoId)) markSourceRepoRemoved(this.store, row, actor);
    }
    const queue = listSourceRepos(this.store, current.id).filter((r) => r.status !== 'removed');
    const worker = async (): Promise<void> => {
      for (let r = queue.shift(); r; r = queue.shift()) await this.inspect(r.id, actor);
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
  }

  /**
   * Read the repo's tree at its default branch: record its lockfiles and the files the inventory
   * reads, then link a project and queue a scan when there is something to scan.
   */
  async inspect(repoRowId: string, actor: string, reason = 'discovery'): Promise<void> {
    const repo = getSourceRepoById(this.store, repoRowId);
    const source = repo ? getSourceById(this.store, repo.sourceId) : null;
    if (!repo || !source || !this.github || !source.installationId || source.status !== 'connected' || repo.status === 'removed') return;
    let listing;
    let branch = repo.defaultBranch;
    try {
      if (!branch) branch = await this.github.defaultBranch(source.installationId, repo.fullName);
      listing = await this.github.findLockfiles(source.installationId, repo.fullName, branch);
    } catch (err) {
      if (err instanceof SourceAccessError) return this.accessLost(source, err, actor, repo);
      throw err;
    }
    const lockfiles = listing.files.filter((f) => f.kind === 'lockfile' || f.kind === 'unsupported_lockfile').map((f) => f.path);
    const filesRead = listing.files.filter((f) => f.kind !== 'unsupported_lockfile').map((f) => f.path);
    const base = { lockfiles, filesRead, lastCommit: listing.commit, defaultBranch: branch };
    if (!repo.watching) {
      // Listed for the person choosing repos (screen 3); nothing is scanned until it is watched.
      patchSourceRepo(this.store, repo.id, { ...base, status: 'not_watched' });
      return;
    }
    if (listing.truncated) {
      patchSourceRepo(this.store, repo.id, { ...base, status: 'unsupported', statusDetail: 'Repository tree is too large to list through the API' });
      return;
    }
    if (listing.files.length === 0) {
      patchSourceRepo(this.store, repo.id, { ...base, status: 'no_lockfile', statusDetail: 'No package.json, lockfile or workflow found' });
      return;
    }
    const npmLock = listing.files.some((f) => f.kind === 'lockfile');
    const onlyUnsupported = !npmLock && lockfiles.length > 0;
    const projectId = this.ensureProject(source, repo, actor);
    patchSourceRepo(this.store, repo.id, {
      ...base,
      projectId,
      status: onlyUnsupported ? 'unsupported' : 'watching',
      statusDetail: onlyUnsupported ? 'yarn.lock / pnpm-lock.yaml are not parsed yet: package.json pins and workflows are read' : null,
    });
    this.queueScan(getSourceRepoById(this.store, repo.id)!, actor, reason);
  }

  /** The repo's project, created on first need (name: owner/repo; target: its web URL). */
  private ensureProject(source: SourceRecord, repo: SourceRepoRecord, actor: string): string {
    if (repo.projectId && getProject(this.store, source.orgId, repo.projectId)) return repo.projectId;
    const taken = new Set(listProjects(this.store, source.orgId).map((p) => p.name.toLowerCase()));
    let name = repo.fullName;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${repo.fullName} (${source.host}${i > 2 ? ` ${i - 1}` : ''})`;
    const project = createProject(
      this.store,
      source.orgId,
      { name: name.slice(0, 120), tier: 'Standard', target: repo.htmlUrl ?? `https://github.com/${repo.fullName}`, owner: `GitHub · ${source.account ?? 'app'}` },
      actor,
    );
    return project.id;
  }

  /** Queue a scan of a connected repo; remembers one more if a scan is already active. */
  private queueScan(repo: SourceRepoRecord, actor: string, reason: string): 'queued' | 'queued_after_active' | 'not_watched' {
    if (!repo.projectId || !repo.watching) return 'not_watched';
    try {
      const scan = enqueueScan(this.store, repo.orgId, repo.projectId, { requestedBy: actor });
      patchSourceRepo(this.store, repo.id, { status: repo.status === 'unsupported' ? 'unsupported' : 'scanning', lastScanId: scan.id });
      this.log(`sources: queued scan ${scan.id} of ${repo.fullName} (${reason})`);
      this.jobs.kick();
      return 'queued';
    } catch (err) {
      if (isStoreError(err) && err.code === 'conflict') {
        this.rescanAfter.add(repo.projectId);
        return 'queued_after_active';
      }
      throw err;
    }
  }

  // ---- Scans -----------------------------------------------------------------

  /** ScanJobs hook: fetch-only checkout for connected projects, null for everything else. */
  async materialiseForProject(projectId: string, ref: string | undefined): Promise<FetchedTarget | null> {
    const link = sourceRepoForProject(this.store, projectId);
    if (!link) return null;
    const { source, repo } = link;
    if (!this.github || source.host !== 'github') throw new SafeScanError('GitHub App is not configured on this server');
    if (source.status !== 'connected' || !source.installationId) throw new SafeScanError('Access to this repository was lost: reconnect the source');
    if (repo.status === 'access_lost' || repo.status === 'removed') throw new SafeScanError('This repository is no longer readable by the installation');
    try {
      const m = await materialiseRepo(this.github, source.installationId, repo.fullName, ref ?? repo.defaultBranch ?? 'HEAD');
      patchSourceRepo(this.store, repo.id, {
        lastCommit: m.commit,
        filesRead: m.fetched.slice().sort(),
        lockfiles: m.files.filter((f) => f.kind === 'lockfile' || f.kind === 'unsupported_lockfile').map((f) => f.path),
      });
      return { dir: m.dir, commit: m.commit, cleanup: m.cleanup };
    } catch (err) {
      if (err instanceof SourceAccessError) {
        this.accessLost(source, err, GITHUB_ACTOR, repo);
        throw new SafeScanError(err.level === 'scope' ? 'Access to the GitHub installation was lost' : 'This repository is no longer readable by the installation');
      }
      throw err;
    }
  }

  /** ScanJobs hook: repo status after a scan, and the rescan a push asked for meanwhile. */
  onScanFinished(projectId: string, scanId: string, ok: boolean): void {
    const link = sourceRepoForProject(this.store, projectId);
    if (!link) return;
    const { repo } = link;
    const status = repo.status === 'scanning' ? 'watching' : repo.status;
    const statusDetail = ok ? (repo.statusDetail === LAST_SCAN_FAILED ? null : repo.statusDetail) : status === 'watching' ? LAST_SCAN_FAILED : repo.statusDetail;
    patchSourceRepo(this.store, repo.id, { status, statusDetail, lastScanId: scanId, lastScanAt: this.store.now().toISOString() });
    if (this.rescanAfter.delete(projectId)) {
      const fresh = getSourceRepoById(this.store, repo.id)!;
      if (fresh.watching && link.source.status === 'connected') this.queueScan(fresh, GITHUB_ACTOR, 'push during scan');
    }
  }

  // ---- Health ----------------------------------------------------------------

  private accessLost(source: SourceRecord, err: SourceAccessError, actor: string, repo?: SourceRepoRecord): void {
    if (err.level === 'scope' || !repo) {
      const health = err.status === 404 ? 'The GitHub App installation was removed or cannot be found' : err.status === 403 ? 'The GitHub App installation is suspended' : 'GitHub refused the installation token';
      setSourceStatus(this.store, source.id, 'access_lost', health, actor);
      markReposAccessLost(this.store, source, health, actor);
      this.log(`sources: ${source.id} access lost (${err.status ?? 'error'})`);
    } else {
      markReposAccessLost(this.store, source, 'The installation can no longer read this repository', actor, repo.id);
    }
  }

  /** Re-check a source with the host: restores it (and rediscovers) or marks access lost. */
  async check(sourceId: string, actor: string): Promise<SourceRecord> {
    const source = getSourceById(this.store, sourceId);
    if (!source) throw new SafeScanError('Source not found');
    if (!this.github || !source.installationId || source.status === 'pending' || source.status === 'disconnected') return source;
    try {
      const inst = await this.github.getInstallation(source.installationId);
      if (inst.suspended) {
        this.accessLost(source, new SourceAccessError('suspended', 'scope', 403), actor);
        return getSourceById(this.store, sourceId)!;
      }
      updateSourceSettings(this.store, source.orgId, source.id, { repositorySelection: inst.repositorySelection, account: inst.account }, actor);
      await this.discover(source.id, actor);
    } catch (err) {
      if (!(err instanceof SourceAccessError)) throw err;
      this.accessLost(source, err, actor);
    }
    return getSourceById(this.store, sourceId)!;
  }

  /** Stop watching everything of a source. Projects and history stay; uninstalling on GitHub is the user's step. */
  disconnect(source: SourceRecord, actor: string): SourceRecord {
    const out = setSourceStatus(this.store, source.id, 'disconnected', 'Disconnected in Blastradius (uninstall the App on GitHub to revoke access)', actor);
    for (const r of listSourceRepos(this.store, source.id)) if (r.status !== 'removed') patchSourceRepo(this.store, r.id, { status: 'not_watched' });
    return out;
  }

  /** A user turned watching on: inspect (and scan) in the background. */
  watchTurnedOn(repo: SourceRepoRecord, actor: string): void {
    this.spawn(`inspect ${repo.id}`, () => this.inspect(repo.id, actor, 'watch turned on'));
  }

  // ---- Webhooks ----------------------------------------------------------------

  /**
   * A signed GitHub delivery. Deduplicated by delivery id first; the outcome is recorded.
   * Returns null for a duplicate.
   */
  async handleGitHubDelivery(deliveryId: string, event: string, payload: Record<string, unknown>): Promise<DeliveryOutcome | null> {
    const action = typeof payload.action === 'string' ? payload.action.slice(0, 64) : null;
    const installationId = String((payload.installation as { id?: unknown } | undefined)?.id ?? '');
    const source = /^\d{1,15}$/.test(installationId) ? getSourceByInstallation(this.store, 'github', installationId) : null;
    if (!recordDelivery(this.store, { host: 'github', deliveryId, event, action, sourceId: source?.id ?? null, outcome: 'received' })) return null;
    if (Math.random() < 0.01) pruneDeliveries(this.store);
    let outcome: string;
    let repoRowId: string | null = null;
    try {
      if (event === 'ping') outcome = 'pong';
      else if (!source) outcome = event === 'installation' && action === 'created' ? 'unclaimed_installation' : 'unknown_installation';
      else if (event === 'installation') outcome = this.onInstallation(source, action);
      else if (event === 'installation_repositories') outcome = this.onInstallationRepositories(source, payload);
      else if (event === 'push') ({ outcome, repoRowId } = this.onPush(source, payload));
      else outcome = 'ignored';
    } catch (err) {
      outcome = 'error';
      this.log(`sources: delivery ${deliveryId} (${event}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    finishDelivery(this.store, 'github', deliveryId, outcome, source?.id ?? null, repoRowId);
    return outcome;
  }

  private onInstallation(source: SourceRecord, action: string | null): string {
    switch (action) {
      case 'deleted':
        this.accessLost(source, new SourceAccessError('uninstalled', 'scope', 404), GITHUB_ACTOR);
        return 'access_lost';
      case 'suspend':
        this.accessLost(source, new SourceAccessError('suspended', 'scope', 403), GITHUB_ACTOR);
        return 'access_lost';
      case 'unsuspend':
      case 'new_permissions_accepted':
      case 'created':
        if (source.status === 'disconnected') return 'ignored_disconnected';
        this.spawn(`check ${source.id}`, () => this.check(source.id, GITHUB_ACTOR));
        return 'rechecking';
      default:
        return 'ignored';
    }
  }

  private onInstallationRepositories(source: SourceRecord, payload: Record<string, unknown>): string {
    if (source.status === 'disconnected') return 'ignored_disconnected';
    const list = (k: string) => (Array.isArray(payload[k]) ? (payload[k] as { id?: unknown; full_name?: unknown; private?: unknown }[]) : []);
    const sel = payload.repository_selection;
    if (sel === 'all' || sel === 'selected') updateSourceSettings(this.store, source.orgId, source.id, { repositorySelection: sel }, GITHUB_ACTOR);
    const fresh = getSourceById(this.store, source.id)!;
    let added = 0;
    let removed = 0;
    for (const r of list('repositories_added')) {
      if ((typeof r.id !== 'number' && typeof r.id !== 'string') || typeof r.full_name !== 'string') continue;
      const { repo } = upsertSourceRepo(this.store, fresh, { repoId: String(r.id), fullName: r.full_name, private: r.private !== false, htmlUrl: null }, GITHUB_ACTOR);
      added++;
      if (fresh.status === 'connected') this.spawn(`inspect ${repo.id}`, () => this.inspect(repo.id, GITHUB_ACTOR, 'added to installation'));
    }
    for (const r of list('repositories_removed')) {
      const row = getSourceRepoByHostId(this.store, source.id, String(r.id ?? ''));
      if (row) {
        markSourceRepoRemoved(this.store, row, GITHUB_ACTOR);
        removed++;
      }
    }
    return `repos_added:${added},removed:${removed}`;
  }

  private onPush(source: SourceRecord, payload: Record<string, unknown>): { outcome: string; repoRowId: string | null } {
    const push = this.github?.parsePush(payload);
    if (!push) return { outcome: 'malformed', repoRowId: null };
    const repo = getSourceRepoByHostId(this.store, source.id, push.repoId);
    if (!repo) return { outcome: 'unknown_repo', repoRowId: null };
    const at = this.store.now().toISOString();
    const done = (outcome: string) => {
      patchSourceRepo(this.store, repo.id, { lastDelivery: { at, outcome } });
      return { outcome, repoRowId: repo.id };
    };
    const branchFromPayload = (payload.repository as { default_branch?: unknown } | undefined)?.default_branch;
    const defaultBranch = typeof branchFromPayload === 'string' && branchFromPayload ? branchFromPayload : repo.defaultBranch;
    if (defaultBranch && defaultBranch !== repo.defaultBranch) patchSourceRepo(this.store, repo.id, { defaultBranch });
    if (source.status !== 'connected') return done('skipped_source_not_connected');
    if (!repo.watching || repo.status === 'removed' || repo.status === 'access_lost') return done('skipped_not_watched');
    if (push.ref !== `refs/heads/${defaultBranch}`) return done('skipped_not_default_branch');
    if (push.deleted) return done('skipped_branch_deleted');
    if (!push.incomplete && !touchesInventory(push.changedPaths)) return done('skipped_no_inventory_change');
    if (!repo.projectId || repo.status === 'no_lockfile' || repo.status === 'discovering') {
      // A manifest or lockfile may have appeared: look again (creates the project if needed).
      this.spawn(`inspect ${repo.id}`, () => this.inspect(repo.id, GITHUB_ACTOR, 'push'));
      return done('inspecting');
    }
    return done(this.queueScan(getSourceRepoById(this.store, repo.id)!, GITHUB_ACTOR, 'push'));
  }
}

/** An install could not be finished; the message is safe to show. */
export class InstallError extends Error {}
