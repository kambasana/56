/**
 * A stateful, local GitHub for developing and testing the GitHub App connector end to end
 * (docs/CONNECTORS.md, "Develop against the simulator"). Dev and test only: nothing under test/
 * is part of the server bundle.
 *
 * One node:http server, laid out like GitHub Enterprise Server:
 *   {base}/api/v3/…   REST API: the endpoints the GitHub App adapter and install flow use, with
 *                     App JWTs verified (RS256) against the App's public key, short-lived
 *                     installation tokens, OAuth user tokens and pagination
 *   {base}/raw/…      raw file contents
 *   {base}/…          web: the App install page, the OAuth code exchange, html_url pages
 *   {base}/_sim/…     control API: orgs, repos, installs, pushes, revokes, forged webhooks
 *
 * Repos are real public repos at pinned commits (repos.ts); commits made here get real git ids.
 * Webhooks are built from @octokit/webhooks-examples shapes and signed like GitHub's.
 */
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTree, commitSha, gitBlobSha, type CommitIdentity, type FileEntry, type TreeEntry } from './gitobjects.js';
import { bumpLockfile, bumpPackageJson, parseSpec, type LockedPackage } from './lockfile.js';
import { lockedFromRecordings, recordedRepo } from './repos.js';
import {
  basicError,
  fullRepository,
  installation as installationJson,
  integration,
  nodeId,
  repository,
  simpleUser,
  validationError,
  type SimAccount,
  type SimAppMeta,
  type SimInstallationMeta,
  type SimRepoMeta,
  type SimUrls,
} from './shapes.js';
import { payloads, signDelivery, type SignedDelivery, type SimPushCommit } from './webhooks.js';

export interface GitHubSimOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Where webhooks are POSTed (the App's Webhook URL), e.g. http://127.0.0.1:8000/api/hooks/github. */
  hookUrl?: string | null;
  /** The App's Callback URL, e.g. http://127.0.0.1:8000/api/sources/github/callback. */
  callbackUrl?: string | null;
  appId?: number;
  appSlug?: string;
  appName?: string;
  /** Record every REST response (route template, status, body) for OpenAPI validation. */
  capture?: boolean;
  log?: (m: string) => void;
}

interface SimCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: CommitIdentity;
  files: FileEntry[];
  listing: TreeEntry[];
}

interface SimRepo extends SimRepoMeta {
  refs: Map<string, string>;
  commits: Map<string, SimCommit>;
  /** root and sub-tree id → [commit, path prefix] */
  trees: Map<string, [string, string]>;
  /** Where the snapshot came from (real repo@commit), when recorded. */
  source: string | null;
}

interface SimInstallation extends SimInstallationMeta {
  repoIds: Set<number>;
  deleted: boolean;
}

interface Org {
  account: SimAccount;
  admins: Set<string>;
  members: Set<string>;
}

export interface CapturedResponse {
  method: string;
  /** OpenAPI path template, e.g. /repos/{owner}/{repo}/git/trees/{tree_sha}. */
  route: string;
  status: number;
  contentType: string;
  body: unknown;
}

export interface DeliveryRecord {
  id: string;
  event: string;
  action: string | null;
  signed: 'valid' | 'forged' | 'unsigned';
  status: number | null;
  response: string;
  delivery: SignedDelivery;
}

export interface SimEnv {
  BLASTRADIUS_GITHUB_APP_ID: string;
  BLASTRADIUS_GITHUB_PRIVATE_KEY: string;
  BLASTRADIUS_GITHUB_WEBHOOK_SECRET: string;
  BLASTRADIUS_GITHUB_CLIENT_ID: string;
  BLASTRADIUS_GITHUB_CLIENT_SECRET: string;
  BLASTRADIUS_GITHUB_API_URL: string;
  BLASTRADIUS_GITHUB_WEB_URL: string;
}

type Auth =
  | { kind: 'jwt' }
  | { kind: 'installation'; installation: SimInstallation; token: string }
  | { kind: 'user'; user: string; token: string }
  | { kind: 'basic'; clientId: string }
  | { kind: 'none' };

interface Reply {
  status: number;
  body?: unknown;
  raw?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
}

interface Ctx {
  req: IncomingMessage;
  url: URL;
  auth: Auth;
  accept: string;
  body: Buffer;
}

type AuthKind = Auth['kind'];

interface Route {
  method: string;
  /** OpenAPI path template. */
  template: string;
  re: RegExp;
  auth: AuthKind[];
  handle: (ctx: Ctx, p: Record<string, string>) => Reply | Promise<Reply>;
}

const DOCS = 'https://docs.github.com/rest';
const ZERO = '0'.repeat(40);
const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, ...(headers ? { headers } : {}) });
const notFound = () => json(404, basicError('Not Found', DOCS, 404));

function template(t: string): RegExp {
  const parts = t.split(/(\{[^}]+\})/).map((s) => {
    if (!s.startsWith('{')) return s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    const name = s.slice(1, -1);
    // {path} and {ref} may contain slashes.
    return name === 'path' || name === 'ref' ? `(?<${name}>.+)` : `(?<${name}>[^/]+)`;
  });
  return new RegExp(`^${parts.join('')}$`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function readBody(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function b64lines(buf: Buffer): string {
  return (buf.toString('base64').match(/.{1,60}/g) ?? ['']).join('\n') + '\n';
}

export class GitHubSim {
  readonly appMeta: SimAppMeta;
  readonly key: { privateKey: string; publicKey: string };
  readonly webhookSecret = randomBytes(32).toString('hex');
  readonly clientSecret = randomBytes(20).toString('hex');
  hookUrl: string | null;
  callbackUrl: string | null;
  /** The user the web pages act as (the person "signed in" to the simulated GitHub). */
  webUser = 'sim-admin';
  readonly captured: CapturedResponse[] = [];
  readonly deliveries: DeliveryRecord[] = [];
  readonly requests: { method: string; path: string; route: string | null; status: number; auth: AuthKind }[] = [];
  tokensMinted = 0;
  tokensRevoked = 0;
  userTokensRevoked = 0;

  private readonly opts: GitHubSimOptions;
  private server: Server | null = null;
  private base = '';
  private readonly users = new Map<string, SimAccount>();
  private readonly orgs = new Map<string, Org>();
  private readonly repos = new Map<string, SimRepo>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly installations = new Map<number, SimInstallation>();
  private readonly installTokens = new Map<string, { installationId: number; expiresAt: number }>();
  private readonly oauthCodes = new Map<string, { user: string; expiresAt: number }>();
  private readonly userTokens = new Map<string, { user: string; expiresAt: number }>();
  private nextId = { account: 9_100_001, repo: 7_200_001, installation: 51_000_001 };
  private readonly hookId = 4_400_001;
  private readonly routes: Route[];
  private readonly log: (m: string) => void;
  private clockSkew = 0;

  constructor(opts: GitHubSimOptions = {}) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.hookUrl = opts.hookUrl ?? null;
    this.callbackUrl = opts.callbackUrl ?? null;
    this.key = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const owner = this.addUser('sim-app-owner');
    this.appMeta = {
      id: opts.appId ?? 424_242,
      slug: opts.appSlug ?? 'blastradius-sim',
      name: opts.appName ?? 'Blastradius (simulated)',
      clientId: `Iv23li${randomBytes(7).toString('hex')}`,
      owner,
      createdAt: '2026-10-01T00:00:00Z',
    };
    this.addUser(this.webUser);
    this.routes = this.apiRoutes();
  }

  // ---- lifecycle -------------------------------------------------------------------

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.dispatch(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, this.opts.host ?? '127.0.0.1', () => resolve());
    });
    this.server = server;
    const addr = server.address() as AddressInfo;
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    this.base = `http://${host}:${addr.port}`;
    return this;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get urls(): SimUrls {
    if (!this.base) throw new Error('simulator is not started');
    return { api: `${this.base}/api/v3`, web: this.base, raw: `${this.base}/raw` };
  }

  /** The environment that points `blastradius serve` at this simulator. */
  env(): SimEnv {
    return {
      BLASTRADIUS_GITHUB_APP_ID: String(this.appMeta.id),
      BLASTRADIUS_GITHUB_PRIVATE_KEY: this.key.privateKey,
      BLASTRADIUS_GITHUB_WEBHOOK_SECRET: this.webhookSecret,
      BLASTRADIUS_GITHUB_CLIENT_ID: this.appMeta.clientId,
      BLASTRADIUS_GITHUB_CLIENT_SECRET: this.clientSecret,
      BLASTRADIUS_GITHUB_API_URL: this.urls.api,
      BLASTRADIUS_GITHUB_WEB_URL: this.urls.web,
    };
  }

  /** Move the simulator's clock (token and JWT expiry). */
  advance(ms: number): void {
    this.clockSkew += ms;
  }

  private now(): number {
    return Date.now() + this.clockSkew;
  }

  private iso(t = this.now()): string {
    return new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  }

  // ---- state: accounts and repos -------------------------------------------------------

  addUser(login: string): SimAccount {
    const existing = this.users.get(login.toLowerCase());
    if (existing) return existing;
    const u: SimAccount = { login, id: this.nextId.account++, type: 'User', name: login };
    this.users.set(login.toLowerCase(), u);
    return u;
  }

  /** An organisation; `admins` may install Apps on it (default: the web user). */
  addOrg(login: string, admins: string[] = [this.webUser], members: string[] = []): SimAccount {
    const existing = this.orgs.get(login.toLowerCase());
    if (existing) return existing.account;
    for (const u of [...admins, ...members]) this.addUser(u);
    const account: SimAccount = { login, id: this.nextId.account++, type: 'Organization', name: login };
    this.orgs.set(login.toLowerCase(), { account, admins: new Set(admins.map((a) => a.toLowerCase())), members: new Set(members.map((a) => a.toLowerCase())) });
    return account;
  }

  private account(login: string): SimAccount | null {
    return this.orgs.get(login.toLowerCase())?.account ?? this.users.get(login.toLowerCase()) ?? null;
  }

  /** Can `user` see repos and installations of `account`? */
  private canSee(user: string, account: SimAccount): boolean {
    const u = user.toLowerCase();
    if (account.type === 'User') return account.login.toLowerCase() === u;
    const org = this.orgs.get(account.login.toLowerCase());
    return !!org && (org.admins.has(u) || org.members.has(u));
  }

  private canAdmin(user: string, account: SimAccount): boolean {
    const u = user.toLowerCase();
    if (account.type === 'User') return account.login.toLowerCase() === u;
    return this.orgs.get(account.login.toLowerCase())?.admins.has(u) ?? false;
  }

  repo(fullName: string): SimRepo | null {
    return this.repos.get(fullName.toLowerCase()) ?? null;
  }

  repoMeta(fullName: string): SimRepoMeta & { head: string; source: string | null } {
    const r = this.mustRepo(fullName);
    return { ...r, head: r.refs.get(r.defaultBranch)!, source: r.source };
  }

  private mustRepo(fullName: string): SimRepo {
    const r = this.repo(fullName);
    if (!r) throw new SimError(404, `no repository ${fullName}`);
    return r;
  }

  /**
   * A repository in `owner` (an org or user). `from` is a recorded real repo (owner/name): the
   * new repo is a fork of it at the recorded commit, with its real tree and commit id. Otherwise
   * `files` make its first commit. A repo created in an org with an "all repositories"
   * installation is added to it, and GitHub tells the App (installation_repositories.added).
   */
  async createRepo(
    owner: string,
    name: string,
    opts: { from?: string; files?: Record<string, string>; private?: boolean; defaultBranch?: string; description?: string } = {},
  ): Promise<SimRepoMeta> {
    const acct = this.account(owner) ?? this.addOrg(owner);
    const fullName = `${acct.login}/${name}`;
    if (this.repo(fullName)) throw new SimError(422, `repository ${fullName} already exists`);
    const t = this.iso();
    const repo: SimRepo = {
      id: this.nextId.repo++,
      owner: acct,
      name,
      fullName,
      private: opts.private ?? false,
      fork: Boolean(opts.from),
      description: opts.description ?? (opts.from ? `Simulated fork of ${opts.from}` : null),
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: t,
      updatedAt: t,
      pushedAt: t,
      language: 'JavaScript',
      sizeKb: 0,
      refs: new Map(),
      commits: new Map(),
      trees: new Map(),
      source: null,
    };
    if (opts.from) {
      const rec = recordedRepo(opts.from);
      const files: FileEntry[] = rec.tree.filter((e) => e.type !== 'tree').map((e) => ({ path: e.path, mode: e.mode, sha: e.sha, ...(e.size !== undefined ? { size: e.size } : {}) }));
      for (const [p, c] of Object.entries(rec.files)) {
        const buf = Buffer.from(c, 'utf8');
        const sha = gitBlobSha(buf);
        if (files.find((f) => f.path === p)?.sha !== sha) throw new Error(`recording of ${opts.from}: ${p} does not match its blob id`);
        this.blobs.set(sha, buf);
      }
      const { rootSha, entries } = buildTree(files);
      // The recorded tree's sub-tree ids are git's: rebuilding them from the blobs must agree.
      const recordedTrees = rec.tree.filter((e) => e.type === 'tree');
      for (const e of recordedTrees) {
        if (entries.find((x) => x.path === e.path)?.sha !== e.sha) throw new Error(`recording of ${opts.from}: tree ${e.path} does not hash to its recorded id`);
      }
      const when = Math.floor(Date.parse(rec.recordedAt) / 1000);
      const commit: SimCommit = { sha: rec.commit, tree: rootSha, parents: [], message: `Snapshot of ${opts.from}@${rec.commit}`, author: { name: 'recorded', email: 'recorded@sim.invalid', time: when }, files, listing: entries };
      this.storeCommit(repo, commit);
      repo.refs.set(repo.defaultBranch, rec.commit);
      repo.source = `${opts.from}@${rec.commit}`;
      repo.sizeKb = Math.ceil(files.reduce((n, f) => n + (f.size ?? 0), 0) / 1024);
    } else {
      this.writeCommit(repo, null, opts.files ?? { 'README.md': `# ${name}\n` }, 'Initial commit', this.webUser);
    }
    this.repos.set(fullName.toLowerCase(), repo);
    for (const inst of this.liveInstallations()) {
      if (inst.account.id === acct.id && inst.selection === 'all') {
        inst.repoIds.add(repo.id);
        await this.deliver('installation_repositories', payloads.installationRepositories('added', inst, this.appMeta, [repo], [], this.mustUser(this.webUser), this.urls));
      }
    }
    return repo;
  }

  private mustUser(login: string): SimAccount {
    return this.users.get(login.toLowerCase()) ?? this.addUser(login);
  }

  private storeCommit(repo: SimRepo, c: SimCommit): void {
    repo.commits.set(c.sha, c);
    repo.trees.set(c.tree, [c.sha, '']);
    for (const e of c.listing) if (e.type === 'tree') repo.trees.set(e.sha, [c.sha, e.path]);
  }

  /** A commit on top of `parent` with `changes` (null deletes a path). Returns the commit and what changed. */
  private writeCommit(repo: SimRepo, parent: SimCommit | null, changes: Record<string, string | Buffer | null>, message: string, by: string) {
    const files = new Map((parent?.files ?? []).map((f) => [f.path, f]));
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [p, c] of Object.entries(changes)) {
      if (!/^[^/\0][^\0]*$/.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..' || s === '.git')) throw new SimError(422, `invalid path ${p}`);
      if (c === null) {
        if (files.delete(p)) removed.push(p);
        continue;
      }
      const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
      const sha = gitBlobSha(buf);
      this.blobs.set(sha, buf);
      const before = files.get(p);
      if (before?.sha === sha) continue;
      (before ? modified : added).push(p);
      files.set(p, { path: p, mode: before?.mode ?? '100644', sha, size: buf.byteLength });
    }
    const list = [...files.values()];
    const { rootSha, entries } = buildTree(list);
    const user = this.mustUser(by);
    const time = Math.max(Math.floor(this.now() / 1000), (parent?.author.time ?? 0) + 1);
    const author: CommitIdentity = { name: user.login, email: `${user.id}+${user.login}@users.noreply.sim.invalid`, time };
    const sha = commitSha({ tree: rootSha, parents: parent ? [parent.sha] : [], author, committer: author, message });
    const commit: SimCommit = { sha, tree: rootSha, parents: parent ? [parent.sha] : [], message, author, files: list, listing: entries };
    this.storeCommit(repo, commit);
    repo.refs.set(repo.defaultBranch, sha);
    repo.pushedAt = this.iso(time * 1000);
    repo.updatedAt = repo.pushedAt;
    return { commit, added, modified, removed };
  }

  /** File contents at the head of the default branch (only files whose bytes the simulator has). */
  readFile(fullName: string, path: string, ref?: string): string | null {
    const repo = this.mustRepo(fullName);
    const c = repo.commits.get(this.resolveRef(repo, ref ?? repo.defaultBranch) ?? '');
    const f = c?.files.find((x) => x.path === path);
    const b = f ? this.blobs.get(f.sha) : undefined;
    return b ? b.toString('utf8') : null;
  }

  /**
   * Push one commit to the default branch, as `user`. Every installation that can read the repo
   * gets a signed `push` delivery. `bump` adds or bumps a dependency in package.json and
   * package-lock.json (resolved/integrity taken from a real recorded lockfile when one pins it).
   */
  async push(
    fullName: string,
    opts: { files?: Record<string, string | null>; bump?: string | LockedPackage; dev?: boolean; message?: string; by?: string; branch?: string } = {},
  ): Promise<{ commit: string; before: string; added: string[]; modified: string[]; removed: string[]; deliveries: DeliveryRecord[] }> {
    const repo = this.mustRepo(fullName);
    const branch = opts.branch ?? repo.defaultBranch;
    const parentSha = repo.refs.get(branch) ?? repo.refs.get(repo.defaultBranch)!;
    const parent = repo.commits.get(parentSha)!;
    const changes: Record<string, string | null> = { ...(opts.files ?? {}) };
    let message = opts.message;
    if (opts.bump) {
      const pkg: LockedPackage = typeof opts.bump === 'string' ? { ...lockedFromRecordings(parseSpec(opts.bump).name, parseSpec(opts.bump).version), ...(opts.dev ? { dev: true } : {}) } : opts.bump;
      const pj = this.readFile(fullName, 'package.json', parentSha);
      const lock = this.readFile(fullName, 'package-lock.json', parentSha);
      if (pj === null || lock === null) throw new SimError(422, `${fullName} has no package.json and package-lock.json at its root`);
      changes['package.json'] = bumpPackageJson(pj, pkg);
      changes['package-lock.json'] = bumpLockfile(lock, pkg);
      message ??= `Bump ${pkg.name} to ${pkg.version}`;
    }
    if (Object.keys(changes).length === 0) throw new SimError(422, 'nothing to push: give files or bump');
    const saved = repo.defaultBranch;
    repo.defaultBranch = branch;
    const { commit, added, modified, removed } = this.writeCommit(repo, parent, changes, message ?? 'Update files', opts.by ?? this.webUser);
    repo.defaultBranch = saved;
    if (branch !== saved) repo.refs.set(branch, commit.sha);
    const by = this.mustUser(opts.by ?? this.webUser);
    const pushCommit: SimPushCommit = {
      sha: commit.sha,
      tree: commit.tree,
      message: commit.message,
      time: this.iso(commit.author.time * 1000),
      author: { name: by.login, email: commit.author.email, username: by.login },
      added,
      removed,
      modified,
    };
    const deliveries: DeliveryRecord[] = [];
    for (const inst of this.liveInstallations()) {
      if (inst.suspendedAt || !this.installationCovers(inst, repo)) continue;
      const p = payloads.push(repo, { ref: `refs/heads/${branch}`, before: parentSha, after: commit.sha, created: false, deleted: false, forced: false, commits: [pushCommit] }, inst, by, this.urls);
      deliveries.push(await this.deliver('push', p));
    }
    return { commit: commit.sha, before: parentSha, added, modified, removed, deliveries };
  }

  // ---- state: installations ---------------------------------------------------------------

  private liveInstallations(): SimInstallation[] {
    return [...this.installations.values()].filter((i) => !i.deleted);
  }

  installation(id: number): SimInstallation | null {
    const i = this.installations.get(id);
    return i && !i.deleted ? i : null;
  }

  private installationCovers(inst: SimInstallation, repo: SimRepo): boolean {
    if (repo.owner.id !== inst.account.id) return false;
    return inst.selection === 'all' || inst.repoIds.has(repo.id);
  }

  private installationRepos(inst: SimInstallation): SimRepo[] {
    return [...this.repos.values()].filter((r) => this.installationCovers(inst, r)).sort((a, b) => a.id - b.id);
  }

  /**
   * Install (or reconfigure) the App on `account`, as `by` would on GitHub's install page.
   * Sends installation.created for a new installation, installation_repositories for a change.
   */
  async install(account: string, selection: 'all' | 'selected', repoNames: string[] = [], by = this.webUser): Promise<{ installation: SimInstallation; setupAction: 'install' | 'update' }> {
    const acct = this.account(account);
    if (!acct) throw new SimError(404, `no account ${account}`);
    if (!this.canAdmin(by, acct)) throw new SimError(403, `${by} cannot install Apps on ${account}`);
    const repos = repoNames.map((n) => this.mustRepo(n.includes('/') ? n : `${acct.login}/${n}`));
    if (repos.some((r) => r.owner.id !== acct.id)) throw new SimError(422, 'selected repositories must belong to the account');
    const t = this.iso();
    const existing = this.liveInstallations().find((i) => i.account.id === acct.id);
    if (existing) {
      const before = new Set(this.installationRepos(existing).map((r) => r.id));
      existing.selection = selection;
      existing.repoIds = new Set(selection === 'selected' ? repos.map((r) => r.id) : []);
      existing.updatedAt = t;
      const after = this.installationRepos(existing);
      const added = after.filter((r) => !before.has(r.id));
      const removed = [...before].filter((id) => !after.some((r) => r.id === id)).map((id) => [...this.repos.values()].find((r) => r.id === id)!);
      if (added.length || removed.length) {
        await this.deliver('installation_repositories', payloads.installationRepositories(added.length ? 'added' : 'removed', existing, this.appMeta, added, removed, this.mustUser(by), this.urls));
      }
      return { installation: existing, setupAction: 'update' };
    }
    const inst: SimInstallation = {
      id: this.nextId.installation++,
      account: acct,
      selection,
      createdAt: t,
      updatedAt: t,
      suspendedAt: null,
      suspendedBy: null,
      repoIds: new Set(selection === 'selected' ? repos.map((r) => r.id) : []),
      deleted: false,
    };
    this.installations.set(inst.id, inst);
    await this.deliver('installation', payloads.installation('created', inst, this.appMeta, this.installationRepos(inst), this.mustUser(by), this.urls));
    return { installation: inst, setupAction: 'install' };
  }

  /** Add a repository to a "selected" installation (GitHub: Configure → Repository access). */
  async addRepoToInstallation(id: number, fullName: string, by = this.webUser): Promise<DeliveryRecord | null> {
    const inst = this.mustInstallation(id);
    const repo = this.mustRepo(fullName);
    if (repo.owner.id !== inst.account.id) throw new SimError(422, `${fullName} is not in ${inst.account.login}`);
    if (this.installationCovers(inst, repo)) return null;
    inst.repoIds.add(repo.id);
    inst.updatedAt = this.iso();
    return this.deliver('installation_repositories', payloads.installationRepositories('added', inst, this.appMeta, [repo], [], this.mustUser(by), this.urls));
  }

  async removeRepoFromInstallation(id: number, fullName: string, by = this.webUser): Promise<DeliveryRecord | null> {
    const inst = this.mustInstallation(id);
    const repo = this.mustRepo(fullName);
    if (!this.installationCovers(inst, repo)) return null;
    if (inst.selection === 'all') {
      // Turning one repo off switches the installation to a selection of the rest, as on GitHub.
      inst.selection = 'selected';
      inst.repoIds = new Set(this.installationRepos(inst).map((r) => r.id));
    }
    inst.repoIds.delete(repo.id);
    inst.updatedAt = this.iso();
    return this.deliver('installation_repositories', payloads.installationRepositories('removed', inst, this.appMeta, [], [repo], this.mustUser(by), this.urls));
  }

  /** Uninstall the App: tokens stop working, GET /app/installations/{id} is 404, installation.deleted is sent. */
  async revoke(id: number, by = this.webUser): Promise<DeliveryRecord> {
    const inst = this.mustInstallation(id);
    const repos = this.installationRepos(inst);
    inst.deleted = true;
    for (const [t, v] of this.installTokens) if (v.installationId === id) this.installTokens.delete(t);
    return this.deliver('installation', payloads.installation('deleted', inst, this.appMeta, repos, this.mustUser(by), this.urls));
  }

  async suspend(id: number, by = this.webUser): Promise<DeliveryRecord> {
    const inst = this.mustInstallation(id);
    inst.suspendedAt = this.iso();
    inst.suspendedBy = this.mustUser(by);
    return this.deliver('installation', payloads.installation('suspend', inst, this.appMeta, [], this.mustUser(by), this.urls));
  }

  async unsuspend(id: number, by = this.webUser): Promise<DeliveryRecord> {
    const inst = this.mustInstallation(id);
    inst.suspendedAt = null;
    inst.suspendedBy = null;
    return this.deliver('installation', payloads.installation('unsuspend', inst, this.appMeta, [], this.mustUser(by), this.urls));
  }

  private mustInstallation(id: number): SimInstallation {
    const i = this.installation(id);
    if (!i) throw new SimError(404, `no installation ${id}`);
    return i;
  }

  /** An OAuth code for `user`, as GitHub adds to the callback after "Request user authorization". */
  issueCode(user = this.webUser): string {
    this.addUser(user);
    const code = randomBytes(10).toString('hex');
    this.oauthCodes.set(code, { user, expiresAt: this.now() + 10 * 60_000 });
    return code;
  }

  // ---- webhooks --------------------------------------------------------------------------

  /** Sign and POST a delivery to the hook URL; the outcome is recorded. */
  async deliver(event: string, payload: Record<string, unknown>, opts: { secret?: string | null; id?: string } = {}): Promise<DeliveryRecord> {
    const secret = opts.secret === undefined ? this.webhookSecret : opts.secret;
    const d = signDelivery(event, payload, { secret, appId: this.appMeta.id, hookId: this.hookId, ...(opts.id ? { id: opts.id } : {}) });
    return this.post(d, typeof payload.action === 'string' ? payload.action : null, secret === null ? 'unsigned' : secret === this.webhookSecret ? 'valid' : 'forged');
  }

  private async post(d: SignedDelivery, action: string | null, signed: DeliveryRecord['signed']): Promise<DeliveryRecord> {
    const rec: DeliveryRecord = { id: d.id, event: d.event, action, signed, status: null, response: '', delivery: d };
    this.deliveries.push(rec);
    if (!this.hookUrl) {
      rec.response = 'no hook URL configured';
      return rec;
    }
    try {
      const res = await fetch(this.hookUrl, { method: 'POST', headers: d.headers, body: d.body, signal: AbortSignal.timeout(10_000) });
      rec.status = res.status;
      rec.response = (await res.text()).slice(0, 2000);
    } catch (err) {
      rec.response = `delivery failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.log(`webhook ${d.event}${action ? `.${action}` : ''} ${d.id} → ${rec.status ?? 'error'} ${rec.response.slice(0, 120)}`);
    return rec;
  }

  /** A delivery signed with the wrong secret (or unsigned): a forged webhook. */
  async forge(opts: { event?: string; repo?: string; unsigned?: boolean } = {}): Promise<DeliveryRecord> {
    const inst = this.liveInstallations()[0];
    const repo = opts.repo ? this.mustRepo(opts.repo) : [...this.repos.values()][0];
    let payload: Record<string, unknown>;
    if ((opts.event ?? 'push') === 'push' && repo && inst) {
      const head = repo.refs.get(repo.defaultBranch)!;
      payload = payloads.push(repo, { ref: `refs/heads/${repo.defaultBranch}`, before: head, after: head, created: false, deleted: false, forced: false, commits: [] }, inst, this.mustUser(this.webUser), this.urls);
    } else if (inst) {
      payload = payloads.installation('deleted', inst, this.appMeta, [], this.mustUser(this.webUser), this.urls);
    } else {
      payload = { zen: 'Forged.', hook_id: this.hookId };
    }
    return this.deliver(opts.event ?? 'push', payload, { secret: opts.unsigned ? null : randomBytes(32).toString('hex') });
  }

  /** Send a recorded delivery again, byte for byte (same id and signature): a replay. */
  async replay(id?: string): Promise<DeliveryRecord> {
    const prev = id ? this.deliveries.find((d) => d.id === id) : [...this.deliveries].reverse().find((d) => d.signed === 'valid');
    if (!prev) throw new SimError(404, 'no such delivery');
    return this.post(prev.delivery, prev.action, prev.signed);
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base || 'http://127.0.0.1');
    let reply: Reply;
    let route: string | null = null;
    let auth: Auth = { kind: 'none' };
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      if (url.pathname.startsWith('/api/v3/') || url.pathname === '/api/v3') {
        const path = url.pathname.slice('/api/v3'.length) || '/';
        auth = this.authenticate(req);
        const found = this.match(req.method ?? 'GET', path);
        if (!found) reply = notFound();
        else {
          route = found.route.template;
          const ctx: Ctx = { req, url, auth, accept: String(req.headers.accept ?? ''), body };
          reply = await this.runRoute(found.route, found.params, ctx);
        }
      } else if (url.pathname.startsWith('/raw/')) {
        reply = this.raw(url, this.authenticate(req));
      } else if (url.pathname.startsWith('/_sim/')) {
        reply = await this.control(req.method ?? 'GET', url, body);
      } else {
        reply = await this.web(req.method ?? 'GET', url, body, String(req.headers['content-type'] ?? ''), String(req.headers.accept ?? ''));
      }
    } catch (err) {
      if (err instanceof SimError) reply = json(err.status, basicError(err.message, DOCS, err.status));
      else {
        this.log(`sim error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        reply = json(500, basicError('Server Error', DOCS, 500));
      }
    }
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, route, status: reply.status, auth: auth.kind });
    if (route && this.opts.capture) {
      this.captured.push({ method: (req.method ?? 'GET').toUpperCase(), route, status: reply.status, contentType: reply.body !== undefined ? 'application/json' : (reply.contentType ?? ''), body: reply.body });
    }
    const headers: Record<string, string> = { 'x-github-request-id': randomBytes(8).toString('hex').toUpperCase(), ...(reply.headers ?? {}) };
    if (route) Object.assign(headers, { 'x-github-api-version-selected': '2022-11-28', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-resource': 'core' });
    if (reply.body !== undefined) {
      res.writeHead(reply.status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(reply.body));
    } else {
      res.writeHead(reply.status, { ...headers, ...(reply.contentType ? { 'content-type': reply.contentType } : {}) });
      res.end(reply.raw ?? '');
    }
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.re.exec(path);
      if (m) return { route: r, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
    }
    return null;
  }

  private async runRoute(route: Route, params: Record<string, string>, ctx: Ctx): Promise<Reply> {
    if (!route.auth.includes(ctx.auth.kind)) {
      if (ctx.auth.kind === 'none') return json(401, basicError('Requires authentication', DOCS, 401));
      if (route.auth.includes('jwt')) return json(401, basicError('A JSON web token could not be decoded', DOCS, 401));
      if (ctx.auth.kind === 'jwt') return json(403, basicError('Resource not accessible by integration', DOCS, 403));
      return json(401, basicError('Bad credentials', DOCS, 401));
    }
    return route.handle(ctx, params);
  }

  /** Authorization header → who is calling. Invalid credentials are 401 for every route. */
  private authenticate(req: IncomingMessage): Auth {
    const h = String(req.headers.authorization ?? '');
    const basic = /^basic (\S+)$/i.exec(h);
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
      if (id === this.appMeta.clientId && secret === this.clientSecret) return { kind: 'basic', clientId: id };
      throw new SimError(401, 'Bad credentials');
    }
    const tok = /^(?:bearer|token) (\S+)$/i.exec(h)?.[1];
    if (!tok) return { kind: 'none' };
    if (tok.split('.').length === 3 && tok.startsWith('ey')) {
      const why = this.verifyJwt(tok);
      if (why) throw new SimError(401, why);
      return { kind: 'jwt' };
    }
    const it = this.installTokens.get(tok);
    if (it) {
      const inst = this.installations.get(it.installationId);
      if (it.expiresAt <= this.now() || !inst || inst.deleted) throw new SimError(401, 'Bad credentials');
      return { kind: 'installation', installation: inst, token: tok };
    }
    const ut = this.userTokens.get(tok);
    if (ut && ut.expiresAt > this.now()) return { kind: 'user', user: ut.user, token: tok };
    throw new SimError(401, 'Bad credentials');
  }

  /** GitHub's App JWT rules: RS256 by the App's key, iss = App ID (or client ID), exp ≤ 10 min after iat. Returns why it fails. */
  private verifyJwt(jwt: string): string | null {
    const [h, p, s] = jwt.split('.') as [string, string, string];
    let header: { alg?: string };
    let claims: { iss?: unknown; iat?: unknown; exp?: unknown };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      return 'A JSON web token could not be decoded';
    }
    if (header.alg !== 'RS256') return 'A JSON web token could not be decoded';
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    if (!v.verify(this.key.publicKey, Buffer.from(s, 'base64url'))) return 'A JSON web token could not be decoded';
    if (String(claims.iss) !== String(this.appMeta.id) && claims.iss !== this.appMeta.clientId) return "'Issuer' claim ('iss') must be an Integer";
    const now = Math.floor(this.now() / 1000);
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return 'A JSON web token could not be decoded';
    if (claims.iat > now + 60) return "'Issued at' claim ('iat') must be an Integer representing a time in the past";
    if (claims.exp <= now) return "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires";
    if (claims.exp - claims.iat > 660) return "'Expiration time' claim ('exp') is too far in the future";
    return null;
  }

  private canRead(auth: Auth, repo: SimRepo): boolean {
    if (auth.kind === 'installation') return !auth.installation.suspendedAt && this.installationCovers(auth.installation, repo);
    if (auth.kind === 'user') return !repo.private || this.canSee(auth.user, repo.owner);
    return !repo.private && auth.kind === 'none';
  }

  private resolveRef(repo: SimRepo, ref: string): string | null {
    const r = ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
    if (repo.refs.has(r)) return repo.refs.get(r)!;
    if (repo.commits.has(ref)) return ref;
    if (/^[0-9a-f]{7,39}$/.test(ref)) {
      const hits = [...repo.commits.keys()].filter((s) => s.startsWith(ref));
      if (hits.length === 1) return hits[0]!;
    }
    return null;
  }

  private paginate<T>(ctx: Ctx, items: T[], path: string): { page: T[]; headers: Record<string, string> } {
    const per = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('per_page') ?? 30) || 30));
    const pageNo = Math.max(1, Number(ctx.url.searchParams.get('page') ?? 1) || 1);
    const last = Math.max(1, Math.ceil(items.length / per));
    const link = (n: number, rel: string) => `<${this.urls.api}${path}?per_page=${per}&page=${n}>; rel="${rel}"`;
    const links = [pageNo < last ? link(pageNo + 1, 'next') : null, pageNo < last ? link(last, 'last') : null, pageNo > 1 ? link(1, 'first') : null, pageNo > 1 ? link(pageNo - 1, 'prev') : null].filter(Boolean);
    return { page: items.slice((pageNo - 1) * per, pageNo * per), headers: links.length ? { link: links.join(', ') } : {} };
  }

  private repoFor(ctx: Ctx, p: Record<string, string>): SimRepo {
    const repo = this.repo(`${p.owner}/${p.repo}`);
    if (!repo || !this.canRead(ctx.auth, repo)) throw new SimError(404, 'Not Found');
    return repo;
  }

  private apiRoutes(): Route[] {
    const r = (method: string, t: string, auth: AuthKind[], handle: Route['handle']): Route => ({ method, template: t, re: template(t), auth, handle });
    const urls = () => this.urls;
    return [
      r('GET', '/app', ['jwt'], () => json(200, integration(this.appMeta, urls(), this.liveInstallations().length))),
      r('GET', '/app/installations/{installation_id}', ['jwt'], (_c, p) => {
        const i = this.installation(Number(p.installation_id));
        return i ? json(200, installationJson(i, this.appMeta, urls())) : notFound();
      }),
      r('POST', '/app/installations/{installation_id}/access_tokens', ['jwt'], (_c, p) => {
        const i = this.installation(Number(p.installation_id));
        if (!i) return notFound();
        if (i.suspendedAt) return json(403, basicError('This installation has been suspended', DOCS, 403));
        const token = `ghs_${randomBytes(18).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)}`;
        const expiresAt = this.now() + 3600_000;
        this.installTokens.set(token, { installationId: i.id, expiresAt });
        this.tokensMinted++;
        return json(201, { token, expires_at: this.iso(expiresAt), permissions: { contents: 'read', metadata: 'read' }, repository_selection: i.selection });
      }),
      r('DELETE', '/installation/token', ['installation'], (ctx) => {
        if (ctx.auth.kind === 'installation') this.installTokens.delete(ctx.auth.token);
        this.tokensRevoked++;
        return { status: 204 };
      }),
      r('GET', '/installation/repositories', ['installation'], (ctx) => {
        if (ctx.auth.kind !== 'installation') return notFound();
        if (ctx.auth.installation.suspendedAt) return json(403, basicError('This installation has been suspended', DOCS, 403));
        const all = this.installationRepos(ctx.auth.installation);
        const { page, headers } = this.paginate(ctx, all, '/installation/repositories');
        return json(200, { total_count: all.length, repositories: page.map((x) => repository(x, urls())), repository_selection: ctx.auth.installation.selection }, headers);
      }),
      r('GET', '/user/installations', ['user'], (ctx) => {
        if (ctx.auth.kind !== 'user') return notFound();
        const user = ctx.auth.user;
        const mine = this.liveInstallations().filter((i) => this.canSee(user, i.account));
        const { page, headers } = this.paginate(ctx, mine, '/user/installations');
        return json(200, { total_count: mine.length, installations: page.map((i) => installationJson(i, this.appMeta, urls())) }, headers);
      }),
      r('DELETE', '/applications/{client_id}/token', ['basic'], (ctx, p) => {
        if (p.client_id !== this.appMeta.clientId) return notFound();
        let token: unknown;
        try {
          token = (JSON.parse(ctx.body.toString('utf8') || '{}') as { access_token?: unknown }).access_token;
        } catch {
          token = undefined;
        }
        if (typeof token !== 'string' || !this.userTokens.delete(token)) return json(422, validationError('Validation Failed'));
        this.userTokensRevoked++;
        return { status: 204 };
      }),
      r('GET', '/repos/{owner}/{repo}', ['installation', 'user', 'none'], (ctx, p) => json(200, fullRepository(this.repoFor(ctx, p), urls()))),
      r('GET', '/repos/{owner}/{repo}/commits/{ref}', ['installation', 'user', 'none'], (ctx, p) => {
        const repo = this.repoFor(ctx, p);
        const sha = this.resolveRef(repo, p.ref!);
        if (!sha) return json(422, validationError(`No commit found for SHA: ${p.ref}`));
        if (/vnd\.github(\.v3)?\.sha/.test(ctx.accept)) return { status: 200, raw: sha, contentType: 'application/vnd.github.sha; charset=utf-8' };
        return json(200, this.commitJson(repo, repo.commits.get(sha)!));
      }),
      r('GET', '/repos/{owner}/{repo}/git/trees/{tree_sha}', ['installation', 'user', 'none'], (ctx, p) => {
        const repo = this.repoFor(ctx, p);
        const ref = p.tree_sha!;
        let found = repo.trees.get(ref);
        if (!found) {
          const c = this.resolveRef(repo, ref);
          if (c) found = [c, ''];
        }
        if (!found) return notFound();
        const commit = repo.commits.get(found[0])!;
        const prefix = found[1];
        const recursive = ['1', 'true'].includes(ctx.url.searchParams.get('recursive') ?? '');
        const under = commit.listing.filter((e) => (prefix ? e.path.startsWith(`${prefix}/`) : true));
        const rel = under
          .map((e) => ({ ...e, path: prefix ? e.path.slice(prefix.length + 1) : e.path }))
          .filter((e) => recursive || !e.path.includes('/'));
        const treeSha = prefix ? commit.listing.find((e) => e.path === prefix)!.sha : commit.tree;
        const a = `${urls().api}/repos/${repo.fullName}/git`;
        return json(200, {
          sha: treeSha,
          url: `${a}/trees/${treeSha}`,
          tree: rel.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, ...(e.type === 'blob' ? { size: e.size ?? 0, url: `${a}/blobs/${e.sha}` } : e.type === 'tree' ? { url: `${a}/trees/${e.sha}` } : {}) })),
          truncated: false,
        });
      }),
      r('GET', '/repos/{owner}/{repo}/git/blobs/{file_sha}', ['installation', 'user', 'none'], (ctx, p) => {
        const repo = this.repoFor(ctx, p);
        const sha = p.file_sha!;
        const known = [...repo.commits.values()].some((c) => c.files.some((f) => f.sha === sha));
        const buf = known ? this.blobs.get(sha) : undefined;
        if (!buf) return notFound();
        if (/vnd\.github(\.v3)?\.raw/.test(ctx.accept)) return { status: 200, raw: buf, contentType: 'application/vnd.github.raw' };
        return json(200, { sha, node_id: nodeId('04:Blob', `${repo.id}:${sha}`), size: buf.byteLength, url: `${urls().api}/repos/${repo.fullName}/git/blobs/${sha}`, content: b64lines(buf), encoding: 'base64' });
      }),
      r('GET', '/repos/{owner}/{repo}/contents/{path}', ['installation', 'user', 'none'], (ctx, p) => {
        const repo = this.repoFor(ctx, p);
        const refQ = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
        const sha = this.resolveRef(repo, refQ);
        if (!sha) return json(404, basicError(`No commit found for the ref ${refQ}`, DOCS, 404));
        const commit = repo.commits.get(sha)!;
        const path = p.path!.replace(/\/+$/, '');
        const file = commit.files.find((f) => f.path === path);
        const a = `${urls().api}/repos/${repo.fullName}`;
        const links = (pth: string, type: 'blob' | 'tree', s: string) => ({
          url: `${a}/contents/${pth}?ref=${encodeURIComponent(refQ)}`,
          git_url: `${a}/git/${type}s/${s}`,
          html_url: `${urls().web}/${repo.fullName}/${type}/${refQ}/${pth}`,
          download_url: type === 'blob' ? `${urls().raw}/${repo.fullName}/${refQ}/${pth}` : null,
        });
        if (file) {
          const buf = this.blobs.get(file.sha);
          if (!buf || file.mode === '160000' || file.mode === '120000') return notFound();
          if (/vnd\.github(\.v3)?\.raw/.test(ctx.accept)) return { status: 200, raw: buf, contentType: 'application/vnd.github.raw' };
          const l = links(path, 'blob', file.sha);
          return json(200, { type: 'file', encoding: 'base64', size: buf.byteLength, name: path.split('/').pop()!, path, content: b64lines(buf), sha: file.sha, ...l, _links: { self: l.url, git: l.git_url, html: l.html_url } });
        }
        const dir = commit.listing.find((e) => e.type === 'tree' && e.path === path);
        if (!dir && path !== '') return notFound();
        const children = commit.listing.filter((e) => (path ? e.path.startsWith(`${path}/`) : true) && !e.path.slice(path ? path.length + 1 : 0).includes('/'));
        return json(
          200,
          children.map((e) => {
            const kind = e.type === 'tree' ? 'dir' : e.type === 'commit' ? 'submodule' : e.mode === '120000' ? 'symlink' : 'file';
            const l = links(e.path, e.type === 'tree' ? 'tree' : 'blob', e.sha);
            return { type: kind, size: e.size ?? 0, name: e.path.split('/').pop()!, path: e.path, sha: e.sha, ...l, _links: { self: l.url, git: l.git_url, html: l.html_url } };
          }),
        );
      }),
    ];
  }

  private commitJson(repo: SimRepo, c: SimCommit) {
    const a = `${this.urls.api}/repos/${repo.fullName}`;
    const who = { name: c.author.name, email: c.author.email, date: this.iso(c.author.time * 1000) };
    return {
      url: `${a}/commits/${c.sha}`,
      sha: c.sha,
      node_id: nodeId('06:Commit', `${repo.id}:${c.sha}`),
      html_url: `${this.urls.web}/${repo.fullName}/commit/${c.sha}`,
      comments_url: `${a}/commits/${c.sha}/comments`,
      commit: {
        url: `${a}/git/commits/${c.sha}`,
        author: who,
        committer: who,
        message: c.message,
        comment_count: 0,
        tree: { sha: c.tree, url: `${a}/git/trees/${c.tree}` },
        verification: { verified: false, reason: 'unsigned', payload: null, signature: null, verified_at: null },
      },
      author: null,
      committer: null,
      parents: c.parents.map((s) => ({ sha: s, url: `${a}/commits/${s}`, html_url: `${this.urls.web}/${repo.fullName}/commit/${s}` })),
      stats: { total: 0, additions: 0, deletions: 0 },
      files: [],
    };
  }

  /** {raw}/{owner}/{repo}/{ref}/{path}: public repos without auth, private ones with a token that can read them. */
  private raw(url: URL, auth: Auth): Reply {
    const parts = url.pathname.slice('/raw/'.length).split('/').map(decodeURIComponent);
    if (parts.length < 4) return { status: 404, raw: '404: Not Found', contentType: 'text/plain' };
    const repo = this.repo(`${parts[0]}/${parts[1]}`);
    if (!repo || !this.canRead(auth, repo)) return { status: 404, raw: '404: Not Found', contentType: 'text/plain' };
    // The ref may contain slashes: try the longest ref that resolves.
    for (let i = parts.length - 1; i >= 3; i--) {
      const sha = this.resolveRef(repo, parts.slice(2, i).join('/'));
      if (!sha) continue;
      const f = repo.commits.get(sha)!.files.find((x) => x.path === parts.slice(i).join('/'));
      const buf = f ? this.blobs.get(f.sha) : undefined;
      if (buf) return { status: 200, raw: buf, contentType: 'text/plain; charset=utf-8' };
    }
    return { status: 404, raw: '404: Not Found', contentType: 'text/plain' };
  }

  // ---- web: install page and OAuth ----------------------------------------------------------

  private page(title: string, body: string, status = 200): Reply {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1f2328}fieldset{border:1px solid #d0d7de;border-radius:6px;margin:1rem 0}label{display:block}button{font:inherit;padding:.4rem 1rem;background:#1f883d;color:#fff;border:0;border-radius:6px}.note{color:#59636e;font-size:13px}</style>
</head><body><p class="note">Simulated GitHub (Blastradius dev). Signed in as <b>${escapeHtml(this.webUser)}</b>.</p>${body}</body></html>`;
    return { status, raw: html, contentType: 'text/html; charset=utf-8' };
  }

  private async web(method: string, url: URL, body: Buffer, contentType: string, accept: string): Promise<Reply> {
    const slug = this.appMeta.slug;
    const p = url.pathname;
    if (method === 'GET' && p === `/apps/${slug}/installations/new`) return this.installPage(url);
    if (method === 'POST' && p === `/apps/${slug}/installations`) return this.installSubmit(new URLSearchParams(body.toString('utf8')));
    if (method === 'POST' && p === '/login/oauth/access_token') return this.oauthExchange(url, body, contentType, accept);
    if (method === 'GET' && p === `/apps/${slug}`) return this.page(this.appMeta.name, `<h1>${escapeHtml(this.appMeta.name)}</h1><p><a href="/apps/${slug}/installations/new">Install</a></p>`);
    if (method === 'GET' && p === '/') return this.page('GitHub simulator', `<h1>GitHub simulator</h1><p>API: <code>${escapeHtml(this.urls.api)}</code></p><p><a href="/apps/${slug}/installations/new">Install ${escapeHtml(this.appMeta.name)}</a></p>`);
    const repoPage = /^\/([^/]+)\/([^/]+)$/.exec(p);
    if (method === 'GET' && repoPage && this.repo(`${repoPage[1]}/${repoPage[2]}`)) {
      const r = this.repo(`${repoPage[1]}/${repoPage[2]}`)!;
      return this.page(r.fullName, `<h1>${escapeHtml(r.fullName)}</h1><p>${escapeHtml(r.description ?? '')}</p><p>Head: <code>${r.refs.get(r.defaultBranch)}</code></p>`);
    }
    return this.page('Not Found', '<h1>404</h1>', 404);
  }

  /** "Install <App>": pick an account, then all or selected repositories (GitHub's two steps). */
  private installPage(url: URL): Reply {
    const state = url.searchParams.get('state');
    const target = url.searchParams.get('target_id');
    const accounts = [this.mustUser(this.webUser), ...[...this.orgs.values()].filter((o) => o.admins.has(this.webUser.toLowerCase())).map((o) => o.account)];
    const keep = (extra: Record<string, string>) => `/apps/${this.appMeta.slug}/installations/new?${new URLSearchParams({ ...(state ? { state } : {}), ...extra }).toString()}`;
    if (!target) {
      const items = accounts.map((a) => `<li><a data-account="${escapeHtml(a.login)}" href="${keep({ target_id: String(a.id) })}">Install on ${escapeHtml(a.login)}</a></li>`).join('');
      return this.page(`Install ${this.appMeta.name}`, `<h1>Install ${escapeHtml(this.appMeta.name)}</h1><p>Where do you want to install ${escapeHtml(this.appMeta.name)}?</p><ul>${items}</ul>`);
    }
    const acct = accounts.find((a) => String(a.id) === target);
    if (!acct) return this.page('Not allowed', `<h1>You cannot install Apps on that account</h1>`, 403);
    const repos = [...this.repos.values()].filter((r) => r.owner.id === acct.id).sort((a, b) => a.name.localeCompare(b.name));
    const existing = this.liveInstallations().find((i) => i.account.id === acct.id);
    const checked = (r: SimRepo) => (existing && this.installationCovers(existing, r) ? ' checked' : '');
    const boxes = repos.map((r) => `<label><input type="checkbox" name="repository_ids" value="${r.id}"${checked(r)}> ${escapeHtml(r.fullName)}</label>`).join('');
    const sel = existing?.selection ?? 'all';
    const form = `<h1>Install ${escapeHtml(this.appMeta.name)} on ${escapeHtml(acct.login)}</h1>
<p>Repository access: <b>Contents</b> read and <b>Metadata</b> read.</p>
<form method="post" action="/apps/${this.appMeta.slug}/installations">
${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}
<input type="hidden" name="target_id" value="${acct.id}">
<fieldset><legend>Repository access</legend>
<label><input type="radio" name="repository_selection" value="all"${sel === 'all' ? ' checked' : ''}> All repositories (and new ones)</label>
<label><input type="radio" name="repository_selection" value="selected"${sel === 'selected' ? ' checked' : ''}> Only select repositories</label>
${boxes}
</fieldset>
<button type="submit">${existing ? 'Save' : 'Install'}</button>
</form>`;
    return this.page(`Install ${this.appMeta.name} on ${acct.login}: all repos / selected`, form);
  }

  private async installSubmit(form: URLSearchParams): Promise<Reply> {
    const acct = [this.mustUser(this.webUser), ...[...this.orgs.values()].map((o) => o.account)].find((a) => String(a.id) === form.get('target_id'));
    if (!acct) return this.page('Not Found', '<h1>Unknown account</h1>', 404);
    const selection = form.get('repository_selection') === 'selected' ? 'selected' : 'all';
    const ids = new Set(form.getAll('repository_ids').map(Number));
    const names = [...this.repos.values()].filter((r) => r.owner.id === acct.id && ids.has(r.id)).map((r) => r.fullName);
    if (selection === 'selected' && names.length === 0) return this.page('Select repositories', '<h1>Select at least one repository</h1>', 422);
    let result;
    try {
      result = await this.install(acct.login, selection, names, this.webUser);
    } catch (err) {
      if (err instanceof SimError) return this.page('Not allowed', `<h1>${escapeHtml(err.message)}</h1>`, err.status);
      throw err;
    }
    const q = new URLSearchParams({ code: this.issueCode(this.webUser), installation_id: String(result.installation.id), setup_action: result.setupAction });
    const state = form.get('state');
    if (state) q.set('state', state);
    if (!this.callbackUrl) return this.page('Installed', `<h1>Installed on ${escapeHtml(acct.login)}</h1><p>Installation ${result.installation.id}. No callback URL is configured.</p>`);
    return { status: 302, headers: { location: `${this.callbackUrl}?${q.toString()}` }, raw: '' };
  }

  /** POST /login/oauth/access_token: the App's client id + secret + a single-use code → a user token. */
  private oauthExchange(url: URL, body: Buffer, contentType: string, accept: string): Reply {
    let params: Record<string, string> = Object.fromEntries(url.searchParams);
    const text = body.toString('utf8');
    if (contentType.includes('json')) {
      try {
        params = { ...params, ...(JSON.parse(text) as Record<string, string>) };
      } catch {
        /* treated as missing fields */
      }
    } else if (text) params = { ...params, ...Object.fromEntries(new URLSearchParams(text)) };
    const asJson = accept.includes('json');
    const out = (o: Record<string, string | number>): Reply =>
      asJson ? json(200, o) : { status: 200, raw: new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString(), contentType: 'application/x-www-form-urlencoded; charset=utf-8' };
    if (params.client_id !== this.appMeta.clientId || params.client_secret !== this.clientSecret) {
      return out({ error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.', error_uri: 'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#incorrect-client-credentials' });
    }
    const code = params.code ? this.oauthCodes.get(params.code) : undefined;
    if (params.code) this.oauthCodes.delete(params.code);
    if (!code || code.expiresAt <= this.now()) {
      return out({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.', error_uri: 'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code' });
    }
    const token = `ghu_${randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)}`;
    this.userTokens.set(token, { user: code.user, expiresAt: this.now() + 8 * 3600_000 });
    return out({ access_token: token, expires_in: 28800, refresh_token: `ghr_${randomBytes(40).toString('hex').slice(0, 76)}`, refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '' });
  }

  // ---- control API ---------------------------------------------------------------------------

  /** Public summary of the simulator's state (no secrets). */
  state() {
    return {
      app: { id: this.appMeta.id, slug: this.appMeta.slug, name: this.appMeta.name, installUrl: `${this.urls.web}/apps/${this.appMeta.slug}/installations/new` },
      urls: this.urls,
      hookUrl: this.hookUrl,
      callbackUrl: this.callbackUrl,
      webUser: this.webUser,
      orgs: [...this.orgs.values()].map((o) => ({ login: o.account.login, id: o.account.id, admins: [...o.admins] })),
      repos: [...this.repos.values()].map((r) => ({ fullName: r.fullName, id: r.id, private: r.private, defaultBranch: r.defaultBranch, head: r.refs.get(r.defaultBranch), source: r.source })),
      installations: [...this.installations.values()].map((i) => ({
        id: i.id,
        account: i.account.login,
        selection: i.selection,
        repos: this.installationRepos(i).map((r) => r.fullName),
        suspended: Boolean(i.suspendedAt),
        deleted: i.deleted,
      })),
      deliveries: this.deliveries.map((d) => ({ id: d.id, event: d.event, action: d.action, signed: d.signed, status: d.status, response: d.response })),
      tokens: { minted: this.tokensMinted, revoked: this.tokensRevoked, userTokensRevoked: this.userTokensRevoked, live: this.installTokens.size },
    };
  }

  private async control(method: string, url: URL, body: Buffer): Promise<Reply> {
    const p = url.pathname.slice('/_sim'.length);
    let input: Record<string, any> = {};
    if (body.length) {
      try {
        input = JSON.parse(body.toString('utf8')) as Record<string, any>;
      } catch {
        throw new SimError(400, 'control API bodies are JSON');
      }
    }
    const rec = (d: DeliveryRecord | null) => (d ? { id: d.id, event: d.event, action: d.action, signed: d.signed, status: d.status, response: d.response } : null);
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/state') return json(200, this.state());
    if (method === 'POST' && p === '/web-user') {
      this.addUser(String(input.login));
      this.webUser = String(input.login);
      return json(200, { webUser: this.webUser });
    }
    if (method === 'POST' && p === '/config') {
      if ('hookUrl' in input) this.hookUrl = input.hookUrl ? String(input.hookUrl) : null;
      if ('callbackUrl' in input) this.callbackUrl = input.callbackUrl ? String(input.callbackUrl) : null;
      return json(200, { hookUrl: this.hookUrl, callbackUrl: this.callbackUrl });
    }
    if (method === 'POST' && p === '/orgs') return json(201, this.addOrg(String(input.login), input.admins ?? [this.webUser], input.members ?? []));
    if (method === 'POST' && p === '/repos') {
      const r = await this.createRepo(String(input.owner), String(input.name), { ...(input.from ? { from: String(input.from) } : {}), ...(input.files ? { files: input.files } : {}), ...(input.private !== undefined ? { private: Boolean(input.private) } : {}) });
      return json(201, { fullName: r.fullName, id: r.id });
    }
    if (method === 'POST' && p === '/installations') {
      const { installation, setupAction } = await this.install(String(input.account), input.selection === 'selected' ? 'selected' : 'all', input.repos ?? [], input.by ?? this.webUser);
      return json(201, { id: installation.id, setupAction, code: this.issueCode(input.by ?? this.webUser) });
    }
    if ((m = /^\/installations\/(\d+)\/repositories$/.exec(p)) && method === 'POST') return json(200, { delivery: rec(await this.addRepoToInstallation(Number(m[1]), String(input.repo))) });
    if ((m = /^\/installations\/(\d+)\/repositories\/([^/]+\/[^/]+)$/.exec(p)) && method === 'DELETE') return json(200, { delivery: rec(await this.removeRepoFromInstallation(Number(m[1]), decodeURIComponent(m[2]!))) });
    if ((m = /^\/installations\/(\d+)\/(revoke|suspend|unsuspend)$/.exec(p)) && method === 'POST') {
      const id = Number(m[1]);
      const d = m[2] === 'revoke' ? await this.revoke(id) : m[2] === 'suspend' ? await this.suspend(id) : await this.unsuspend(id);
      return json(200, { delivery: rec(d) });
    }
    if (method === 'POST' && p === '/push') {
      const out = await this.push(String(input.repo), { ...(input.files ? { files: input.files } : {}), ...(input.bump ? { bump: String(input.bump) } : {}), ...(input.dev ? { dev: true } : {}), ...(input.message ? { message: String(input.message) } : {}), ...(input.branch ? { branch: String(input.branch) } : {}) });
      return json(200, { ...out, deliveries: out.deliveries.map(rec) });
    }
    if (method === 'POST' && p === '/oauth-code') return json(201, { code: this.issueCode(input.user ?? this.webUser) });
    if (method === 'POST' && p === '/webhooks/forge') return json(200, { delivery: rec(await this.forge({ ...(input.event ? { event: String(input.event) } : {}), ...(input.repo ? { repo: String(input.repo) } : {}), unsigned: Boolean(input.unsigned) })) });
    if (method === 'POST' && p === '/webhooks/replay') return json(200, { delivery: rec(await this.replay(input.id ? String(input.id) : undefined)) });
    if (method === 'GET' && p === '/deliveries') return json(200, this.state().deliveries);
    return json(404, { message: `unknown control endpoint ${method} ${p}` });
  }
}

export class SimError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export { ZERO as ZERO_SHA };
