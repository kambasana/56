/**
 * GitHub App connector (docs/CONNECTORS.md). Permissions: Contents read, Metadata read.
 *
 * - App credentials (id, private key, webhook secret, OAuth client) come from the environment and
 *   are never logged, stored or returned by the API.
 * - Installation tokens are minted per use: every operation builds a fresh App (so no token is
 *   cached between operations) and revokes its token when done. Tokens last an hour at most.
 * - Webhooks: HMAC-SHA256 of the raw body against X-Hub-Signature-256, compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { selectInventoryFiles } from '../../ingest/select.js';
import { SourceAccessError, type PushInfo, type RepoInventoryFiles, type SourceAdapter, type SourceRepoInfo, type WebhookRequest } from './types.js';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  /** OAuth client of the App: proves the person finishing an install can see that installation. */
  clientId?: string;
  clientSecret?: string;
  /** REST API base (default https://api.github.com; GHES: https://HOST/api/v3). */
  apiUrl?: string;
  /** Web base for OAuth (default https://github.com). */
  webUrl?: string;
  /** Injected fetch (tests replay a fake GitHub). Defaults to the global fetch (proxy-aware). */
  fetch?: typeof fetch;
}

/** Thrown for a partial or malformed GitHub App configuration. Never carries secret values. */
export class GitHubConfigError extends Error {}

/**
 * GitHub App settings from the environment, or null when no App is configured.
 *   BLASTRADIUS_GITHUB_APP_ID, BLASTRADIUS_GITHUB_PRIVATE_KEY (PEM) or BLASTRADIUS_GITHUB_PRIVATE_KEY_FILE,
 *   BLASTRADIUS_GITHUB_WEBHOOK_SECRET, BLASTRADIUS_GITHUB_CLIENT_ID, BLASTRADIUS_GITHUB_CLIENT_SECRET,
 *   optional BLASTRADIUS_GITHUB_API_URL / BLASTRADIUS_GITHUB_WEB_URL (GitHub Enterprise Server).
 */
export function githubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const v = (k: string): string | undefined => {
    const x = env[`BLASTRADIUS_GITHUB_${k}`];
    return x && x.trim() ? x.trim() : undefined;
  };
  const appId = v('APP_ID');
  const keyFile = v('PRIVATE_KEY_FILE');
  let privateKey = v('PRIVATE_KEY');
  const webhookSecret = v('WEBHOOK_SECRET');
  if (!appId && !privateKey && !keyFile && !webhookSecret) return null;
  if (!privateKey && keyFile) {
    try {
      privateKey = readFileSync(keyFile, 'utf8');
    } catch {
      throw new GitHubConfigError('BLASTRADIUS_GITHUB_PRIVATE_KEY_FILE cannot be read');
    }
  }
  const missing = [!appId && 'BLASTRADIUS_GITHUB_APP_ID', !privateKey && 'BLASTRADIUS_GITHUB_PRIVATE_KEY(_FILE)', !webhookSecret && 'BLASTRADIUS_GITHUB_WEBHOOK_SECRET'].filter(Boolean);
  if (missing.length > 0) throw new GitHubConfigError(`GitHub App is partly configured; missing ${missing.join(', ')}`);
  if (!/^\d{1,12}$/.test(appId!)) throw new GitHubConfigError('BLASTRADIUS_GITHUB_APP_ID must be the numeric App ID');
  // Keys pasted into one env line often carry literal "\n".
  privateKey = privateKey!.includes('\\n') && !privateKey!.includes('\n') ? privateKey!.replace(/\\n/g, '\n') : privateKey!;
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) throw new GitHubConfigError('GitHub App private key is not a PEM private key');
  if (webhookSecret!.length < 16) throw new GitHubConfigError('BLASTRADIUS_GITHUB_WEBHOOK_SECRET must be at least 16 characters');
  const clientId = v('CLIENT_ID');
  const clientSecret = v('CLIENT_SECRET');
  return {
    appId: appId!,
    privateKey,
    webhookSecret: webhookSecret!,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(v('API_URL') ? { apiUrl: v('API_URL')!.replace(/\/+$/, '') } : {}),
    ...(v('WEB_URL') ? { webUrl: v('WEB_URL')!.replace(/\/+$/, '') } : {}),
  };
}

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, raw body). */
export function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signGitHubBody(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const NAME_PART = /^[A-Za-z0-9._-]{1,100}$/;

function splitFullName(fullName: string): [string, string] {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0 || !NAME_PART.test(owner) || !NAME_PART.test(repo) || repo === '.' || repo === '..') {
    throw new SourceAccessError('Invalid repository name', 'repo');
  }
  return [owner, repo];
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

interface GhRepo {
  id: number;
  full_name: string;
  default_branch?: string;
  private: boolean;
  archived?: boolean;
  html_url: string;
}

function toRepoInfo(r: GhRepo): SourceRepoInfo {
  return {
    id: String(r.id),
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? 'main',
    private: r.private === true,
    archived: r.archived === true,
    htmlUrl: r.html_url,
  };
}

export interface GitHubInstallation {
  id: string;
  account: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

type Kit = InstanceType<typeof Octokit>;

export class GitHubAdapter implements SourceAdapter {
  readonly host = 'github' as const;
  private readonly OctokitWithDefaults: typeof Octokit;
  private readonly appClient: App;
  /** path → blob sha for recent listings, so reads fetch exactly the listed blobs. */
  private readonly blobs = new Map<string, Map<string, string>>();

  constructor(private readonly config: GitHubAppConfig) {
    this.OctokitWithDefaults = Octokit.defaults({
      ...(config.apiUrl ? { baseUrl: config.apiUrl } : {}),
      userAgent: 'blastradius-connector',
      request: { ...(config.fetch ? { fetch: config.fetch } : {}), retries: 0 },
    });
    this.appClient = this.newApp();
  }

  private newApp(): App {
    return new App({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      Octokit: this.OctokitWithDefaults,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
  }

  /** True when the OAuth client is configured (needed to finish an install). */
  get canVerifyInstaller(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  /** Run `fn` with a freshly minted installation token, revoked afterwards. */
  async withInstallation<T>(scope: string, fn: (kit: Kit) => Promise<T>): Promise<T> {
    if (!/^\d{1,15}$/.test(scope)) throw new SourceAccessError('Invalid installation id', 'scope');
    const app = this.newApp();
    let kit: Kit;
    try {
      kit = (await app.getInstallationOctokit(Number(scope))) as unknown as Kit;
      await kit.auth({ type: 'installation' });
    } catch (err) {
      const status = statusOf(err);
      if (status === 401 || status === 403 || status === 404) throw new SourceAccessError(`GitHub refused an installation token (${status})`, 'scope', status);
      throw err;
    }
    try {
      return await fn(kit);
    } catch (err) {
      if (statusOf(err) === 401) throw new SourceAccessError('GitHub refused the installation token (401)', 'scope', 401);
      throw err;
    } finally {
      await kit.request('DELETE /installation/token').catch(() => {});
    }
  }

  /** The installation as GitHub reports it (App JWT). 404 / 401 → SourceAccessError('scope'). */
  async getInstallation(scope: string): Promise<GitHubInstallation> {
    if (!/^\d{1,15}$/.test(scope)) throw new SourceAccessError('Invalid installation id', 'scope');
    try {
      const { data } = await this.appClient.octokit.request('GET /app/installations/{installation_id}', { installation_id: Number(scope) });
      const account = data.account as { login?: string; slug?: string; type?: string } | null;
      return {
        id: String(data.id),
        account: account?.login ?? account?.slug ?? 'unknown',
        accountType: account?.type ?? 'Organization',
        repositorySelection: data.repository_selection === 'selected' ? 'selected' : 'all',
        suspended: Boolean(data.suspended_at),
      };
    } catch (err) {
      const status = statusOf(err);
      if (status === 401 || status === 403 || status === 404) throw new SourceAccessError(`GitHub installation is not available (${status})`, 'scope', status);
      throw err;
    }
  }

  /** https://github.com/apps/<slug>/installations/new?state=… */
  async installUrl(state: string): Promise<string> {
    return this.appClient.getInstallationUrl({ state });
  }

  /**
   * Proof that the person finishing an install can see `installationId`: exchange the OAuth `code`
   * GitHub added to the callback and list that user's installations of this App. The setup URL's
   * installation_id alone can be forged; this cannot.
   */
  async installerCanSee(code: string, installationId: string): Promise<boolean> {
    if (!this.config.clientId || !this.config.clientSecret) return false;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return false;
    const doFetch = this.config.fetch ?? fetch;
    const web = this.config.webUrl ?? 'https://github.com';
    const res = await doFetch(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    const token = typeof body?.access_token === 'string' ? body.access_token : null;
    if (!token) return false;
    const user = new this.OctokitWithDefaults({ auth: token });
    for (let page = 1; page <= 20; page++) {
      const { data } = await user.request('GET /user/installations', { per_page: 100, page });
      if (data.installations.some((i) => String(i.id) === installationId)) return true;
      if (data.installations.length < 100) break;
    }
    return false;
  }

  async listRepos(scope: string): Promise<SourceRepoInfo[]> {
    return this.withInstallation(scope, async (kit) => {
      const out: SourceRepoInfo[] = [];
      for (let page = 1; page <= 50; page++) {
        const { data } = await kit.request('GET /installation/repositories', { per_page: 100, page });
        out.push(...data.repositories.map((r) => toRepoInfo(r as GhRepo)));
        if (data.repositories.length < 100 || out.length >= data.total_count) break;
      }
      return out;
    });
  }

  async getRepo(scope: string, fullName: string): Promise<SourceRepoInfo | null> {
    const [owner, repo] = splitFullName(fullName);
    return this.withInstallation(scope, async (kit) => {
      try {
        const { data } = await kit.request('GET /repos/{owner}/{repo}', { owner, repo });
        return toRepoInfo(data as GhRepo);
      } catch (err) {
        if (statusOf(err) === 404 || statusOf(err) === 403) return null;
        throw err;
      }
    });
  }

  async defaultBranch(scope: string, fullName: string): Promise<string> {
    const r = await this.getRepo(scope, fullName);
    if (!r) throw new SourceAccessError('Repository is not accessible to the installation', 'repo', 404);
    return r.defaultBranch;
  }

  async findLockfiles(scope: string, fullName: string, ref: string): Promise<RepoInventoryFiles> {
    const [owner, repo] = splitFullName(fullName);
    if (!/^[A-Za-z0-9._/-]{1,250}$/.test(ref) || ref.includes('..')) throw new SourceAccessError('Invalid ref', 'repo');
    return this.withInstallation(scope, async (kit) => {
      try {
        const commit = await kit.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref, mediaType: { format: 'sha' } });
        const sha = shaFromResponse(commit.data as unknown);
        if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('GitHub returned no commit sha');
        const { data } = await kit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner, repo, tree_sha: sha, recursive: '1' });
        // Regular files only: symlinks (120000) and submodules (commit) are not read, as in a hook-free clone.
        const blobs = data.tree.filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755') && typeof e.path === 'string');
        const selected = selectInventoryFiles(blobs.map((e) => e.path!));
        const byPath = new Map(blobs.map((e) => [e.path!, e]));
        const shas = new Map<string, string>();
        const files = selected.map((f) => {
          const e = byPath.get(f.path)!;
          if (e.sha) shas.set(f.path, e.sha);
          return { ...f, size: typeof e.size === 'number' ? e.size : 0 };
        });
        this.rememberBlobs(`${fullName}@${sha}`, shas);
        return { commit: sha, files, truncated: data.truncated === true };
      } catch (err) {
        if (statusOf(err) === 404 || statusOf(err) === 409 || statusOf(err) === 422) {
          throw new SourceAccessError(`Repository or ref not found (${statusOf(err)})`, 'repo', statusOf(err));
        }
        throw err;
      }
    });
  }

  private rememberBlobs(key: string, shas: Map<string, string>): void {
    this.blobs.delete(key);
    this.blobs.set(key, shas);
    while (this.blobs.size > 64) this.blobs.delete(this.blobs.keys().next().value!);
  }

  async readFiles(scope: string, fullName: string, ref: string, paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    const [owner, repo] = splitFullName(fullName);
    const known = this.blobs.get(`${fullName}@${ref}`);
    return this.withInstallation(scope, async (kit) => {
      const out = new Map<string, Uint8Array>();
      const queue = [...paths];
      const worker = async (): Promise<void> => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          const sha = known?.get(p);
          try {
            if (sha) {
              const { data } = await kit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner, repo, file_sha: sha });
              out.set(p, Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8'));
            } else {
              const encoded = p.split('/').map(encodeURIComponent).join('/');
              const res = await kit.request(`GET /repos/{owner}/{repo}/contents/${encoded}`, { owner, repo, ref, mediaType: { format: 'raw' } });
              const d = res.data as unknown;
              out.set(p, typeof d === 'string' ? Buffer.from(d, 'utf8') : new Uint8Array(d as ArrayBuffer));
            }
          } catch (err) {
            if (statusOf(err) === 404) continue; // removed since the listing: not in the snapshot
            throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
      return out;
    });
  }

  verifyWebhook(req: WebhookRequest): boolean {
    return verifyGitHubSignature(this.config.webhookSecret, req.body, req.headers.get('x-hub-signature-256'));
  }

  parsePush(payload: unknown): PushInfo | null {
    return parseGitHubPush(payload);
  }
}

/** The commit sha from GET …/commits/{ref}: text (sha media type), bytes, or the JSON commit. */
function shaFromResponse(d: unknown): string {
  if (typeof d === 'string') return d.trim();
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8').trim();
  if (d && typeof d === 'object' && typeof (d as { sha?: unknown }).sha === 'string') return (d as { sha: string }).sha;
  return '';
}

/** GitHub push payload → PushInfo. GitHub lists at most 20 commits; more means incomplete. */
export function parseGitHubPush(payload: unknown): PushInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as {
    ref?: unknown;
    after?: unknown;
    deleted?: unknown;
    forced?: unknown;
    repository?: { id?: unknown; full_name?: unknown };
    commits?: unknown;
  };
  if (typeof p.ref !== 'string' || !p.repository || (typeof p.repository.id !== 'number' && typeof p.repository.id !== 'string')) return null;
  if (typeof p.repository.full_name !== 'string') return null;
  const commits = Array.isArray(p.commits) ? (p.commits as { added?: unknown; removed?: unknown; modified?: unknown }[]) : [];
  const changed = new Set<string>();
  for (const c of commits) {
    for (const list of [c?.added, c?.removed, c?.modified]) {
      if (Array.isArray(list)) for (const f of list) if (typeof f === 'string') changed.add(f);
    }
  }
  const deleted = p.deleted === true;
  const after = typeof p.after === 'string' && /^[0-9a-f]{40,64}$/.test(p.after) && !/^0+$/.test(p.after) ? p.after : null;
  return {
    repoId: String(p.repository.id),
    fullName: p.repository.full_name,
    ref: p.ref,
    after,
    deleted,
    changedPaths: [...changed].sort(),
    incomplete: !deleted && (commits.length === 0 || commits.length >= 20 || p.forced === true),
  };
}
