/**
 * A fake GitHub for tests: the REST endpoints the GitHub App connector uses, served from memory
 * through an injected fetch. App JWTs are verified against a throwaway RSA key generated per
 * test run; installation tokens are random and short-lived. No network, no real credentials.
 */
import { createHash, createHmac, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { selectInventoryFiles } from '../../ingest/select.js';

export function throwawayAppKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** git's blob id: sha1("blob <len>\0" + content). */
export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface FakeRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  refs: Map<string, string>;
  trees: Map<string, { tree: TreeEntry[]; truncated: boolean }>;
  /** commit → path → content */
  files: Map<string, Map<string, Uint8Array>>;
}

interface FakeInstallation {
  id: number;
  account: string;
  accountType: string;
  selection: 'all' | 'selected';
  repos: Set<string>;
  revoked: boolean;
  suspended: boolean;
}

export interface FakeRequestLog {
  method: string;
  path: string;
  auth: 'jwt' | 'installation' | 'user' | 'none';
}

const BASE = 'https://api.github.com';
const WEB = 'https://github.com';

export class FakeGitHub {
  readonly appId = '424242';
  readonly key = throwawayAppKey();
  readonly webhookSecret = randomBytes(24).toString('hex');
  readonly clientId = 'Iv1.fakeclient';
  readonly clientSecret = randomBytes(20).toString('hex');
  readonly repos = new Map<string, FakeRepo>();
  readonly installations = new Map<number, FakeInstallation>();
  /** token → installation id */
  private readonly tokens = new Map<string, number>();
  /** OAuth code → installation ids the user can see */
  private readonly codes = new Map<string, number[]>();
  private readonly userTokens = new Map<string, number[]>();
  readonly log: FakeRequestLog[] = [];
  tokensMinted = 0;
  tokensRevoked = 0;
  private nextRepoId = 1000;

  get config() {
    return {
      appId: this.appId,
      privateKey: this.key.privateKey,
      webhookSecret: this.webhookSecret,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      fetch: this.fetch,
    };
  }

  addInstallation(id: number, account: string, repos: string[] = [], selection: 'all' | 'selected' = 'selected'): FakeInstallation {
    const inst: FakeInstallation = { id, account, accountType: 'Organization', selection, repos: new Set(repos), revoked: false, suspended: false };
    this.installations.set(id, inst);
    return inst;
  }

  /** Add a repo whose default branch points at a commit with these files. Returns the commit sha. */
  addRepo(fullName: string, files: Record<string, string | Uint8Array>, opts: { defaultBranch?: string; private?: boolean; id?: number } = {}): string {
    const repo: FakeRepo = {
      id: opts.id ?? this.nextRepoId++,
      fullName,
      defaultBranch: opts.defaultBranch ?? 'main',
      private: opts.private ?? true,
      refs: new Map(),
      trees: new Map(),
      files: new Map(),
    };
    this.repos.set(fullName, repo);
    return this.commit(fullName, files);
  }

  /** A new commit on the default branch with exactly `files`. */
  commit(fullName: string, files: Record<string, string | Uint8Array>): string {
    const repo = this.repos.get(fullName)!;
    const contents = new Map(Object.entries(files).map(([p, c]) => [p, typeof c === 'string' ? Buffer.from(c, 'utf8') : c]));
    const sha = createHash('sha1').update(`${fullName}:${repo.files.size}:${randomBytes(8).toString('hex')}`).digest('hex');
    const tree: TreeEntry[] = [...contents.entries()].map(([path, c]) => ({ path, mode: '100644', type: 'blob', sha: gitBlobSha(c), size: c.byteLength }));
    repo.trees.set(sha, { tree, truncated: false });
    repo.files.set(sha, contents);
    repo.refs.set(repo.defaultBranch, sha);
    return sha;
  }

  /** A recorded GitHub tree listing plus the contents of the files it lists that we have. */
  addRecordedCommit(fullName: string, commit: string, tree: TreeEntry[], files: Record<string, string>, opts: { id?: number; defaultBranch?: string } = {}): void {
    let repo = this.repos.get(fullName);
    if (!repo) {
      repo = { id: opts.id ?? this.nextRepoId++, fullName, defaultBranch: opts.defaultBranch ?? 'main', private: false, refs: new Map(), trees: new Map(), files: new Map() };
      this.repos.set(fullName, repo);
    }
    repo.trees.set(commit, { tree, truncated: false });
    repo.files.set(commit, new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c, 'utf8')])));
    repo.refs.set(repo.defaultBranch, commit);
  }

  /** An OAuth code for a user who can see these installations. */
  issueCode(installationIds: number[]): string {
    const code = randomBytes(10).toString('hex');
    this.codes.set(code, installationIds);
    return code;
  }

  /** Webhook delivery headers for `body`, signed with the App's secret (or `secret`). */
  deliveryHeaders(event: string, body: string, opts: { secret?: string | null; id?: string } = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': opts.id ?? crypto.randomUUID(),
    };
    const secret = opts.secret === undefined ? this.webhookSecret : opts.secret;
    if (secret !== null) h['X-Hub-Signature-256'] = `sha256=${createHmacHex(secret, body)}`;
    return h;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const authz = req.headers.get('authorization') ?? '';
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const notFound = () => json(404, { message: 'Not Found' });

    if (url.origin === WEB && url.pathname === '/login/oauth/access_token' && method === 'POST') {
      const body = (await req.json()) as { client_id?: string; client_secret?: string; code?: string };
      this.log.push({ method, path: url.pathname, auth: 'none' });
      const ids = body.code ? this.codes.get(body.code) : undefined;
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret || !ids) return json(200, { error: 'bad_verification_code' });
      this.codes.delete(body.code!);
      const token = `ghu_${randomBytes(12).toString('hex')}`;
      this.userTokens.set(token, ids);
      return json(200, { access_token: token, token_type: 'bearer' });
    }
    if (url.origin !== BASE) return notFound();
    const path = url.pathname;

    // ---- App (JWT) -----------------------------------------------------------
    if (/^bearer ey/i.test(authz)) {
      this.log.push({ method, path, auth: 'jwt' });
      if (!this.verifyJwt(authz.slice(7))) return json(401, { message: 'A JSON web token could not be decoded' });
      if (path === '/app' && method === 'GET') return json(200, { id: Number(this.appId), slug: 'blastradius-test', html_url: `${WEB}/apps/blastradius-test` });
      let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (m && method === 'POST') {
        const inst = this.installations.get(Number(m[1]));
        if (!inst || inst.revoked) return notFound();
        if (inst.suspended) return json(403, { message: 'This installation has been suspended' });
        const token = `ghs_${randomBytes(16).toString('hex')}`;
        this.tokens.set(token, inst.id);
        this.tokensMinted++;
        return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'read', metadata: 'read' }, repository_selection: inst.selection });
      }
      m = /^\/app\/installations\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        const inst = this.installations.get(Number(m[1]));
        if (!inst || inst.revoked) return notFound();
        return json(200, {
          id: inst.id,
          account: { login: inst.account, type: inst.accountType },
          repository_selection: inst.selection,
          suspended_at: inst.suspended ? new Date().toISOString() : null,
        });
      }
      return notFound();
    }

    // ---- User (OAuth) ----------------------------------------------------------
    const bearer = /^(?:token|bearer) (\S+)$/i.exec(authz)?.[1];
    if (bearer && this.userTokens.has(bearer)) {
      this.log.push({ method, path, auth: 'user' });
      if (path === '/user/installations') {
        const ids = this.userTokens.get(bearer)!;
        return json(200, { total_count: ids.length, installations: ids.map((id) => ({ id })) });
      }
      return notFound();
    }

    // ---- Installation token ------------------------------------------------------
    const instId = bearer ? this.tokens.get(bearer) : undefined;
    this.log.push({ method, path, auth: instId !== undefined ? 'installation' : 'none' });
    if (instId === undefined) return json(401, { message: 'Bad credentials' });
    const inst = this.installations.get(instId)!;
    if (inst.revoked) return json(401, { message: 'Bad credentials' });
    if (path === '/installation/token' && method === 'DELETE') {
      this.tokens.delete(bearer!);
      this.tokensRevoked++;
      return new Response(null, { status: 204 });
    }
    if (path === '/installation/repositories') {
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = [...inst.repos].map((n) => this.repos.get(n)).filter((r): r is FakeRepo => r !== undefined);
      return json(200, { total_count: all.length, repositories: all.slice((page - 1) * per, page * per).map((r) => this.repoJson(r)) });
    }
    const rm = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!rm) return notFound();
    const fullName = `${decodeURIComponent(rm[1]!)}/${decodeURIComponent(rm[2]!)}`;
    const repo = this.repos.get(fullName);
    if (!repo || !inst.repos.has(fullName)) return notFound();
    const rest = rm[3] ?? '';
    if (rest === '') return json(200, this.repoJson(repo));
    let m = /^\/commits\/(.+)$/.exec(rest);
    if (m) {
      const ref = decodeURIComponent(m[1]!);
      const sha = repo.trees.has(ref) ? ref : repo.refs.get(ref);
      if (!sha) return json(422, { message: 'No commit found for SHA' });
      if ((req.headers.get('accept') ?? '').includes('application/vnd.github.sha')) return new Response(sha, { status: 200, headers: { 'content-type': 'application/vnd.github.sha; charset=utf-8' } });
      return json(200, { sha });
    }
    m = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (m) {
      const t = repo.trees.get(m[1]!);
      if (!t) return notFound();
      return json(200, { sha: m[1], truncated: t.truncated, tree: t.tree.map((e) => ({ ...e, url: `${BASE}/x` })) });
    }
    m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (m) {
      for (const files of repo.files.values()) {
        for (const c of files.values()) {
          if (gitBlobSha(c) === m[1]) return json(200, { sha: m[1], size: c.byteLength, encoding: 'base64', content: Buffer.from(c).toString('base64') });
        }
      }
      return notFound();
    }
    m = /^\/contents\/(.+)$/.exec(rest);
    if (m) {
      const p = m[1]!.split('/').map(decodeURIComponent).join('/');
      const ref = url.searchParams.get('ref') ?? repo.refs.get(repo.defaultBranch)!;
      const c = repo.files.get(ref)?.get(p);
      if (!c) return notFound();
      return new Response(c, { status: 200, headers: { 'content-type': 'application/vnd.github.raw' } });
    }
    return notFound();
  };

  private repoJson(r: FakeRepo) {
    return { id: r.id, full_name: r.fullName, default_branch: r.defaultBranch, private: r.private, archived: false, html_url: `${WEB}/${r.fullName}` };
  }

  private verifyJwt(jwt: string): boolean {
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const v = createVerify('RSA-SHA256');
    v.update(`${parts[0]}.${parts[1]}`);
    if (!v.verify(this.key.publicKey, Buffer.from(parts[2]!, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: unknown; exp?: number };
    return String(claims.iss) === this.appId && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now();
  }

  /** Inventory files of a repo's head commit (what discovery should report). */
  inventoryPaths(fullName: string): string[] {
    const repo = this.repos.get(fullName)!;
    const sha = repo.refs.get(repo.defaultBranch)!;
    return selectInventoryFiles(repo.trees.get(sha)!.tree.filter((e) => e.type === 'blob').map((e) => e.path)).map((f) => f.path);
  }
}

function createHmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
