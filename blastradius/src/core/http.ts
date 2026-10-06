/**
 * Small HTTP layer shared by all enrichers.
 *
 * - Injectable transport (tests never touch the network).
 * - On-disk JSON cache keyed by a hash of the request, with TTL.
 * - Per-host rate limiter (minimum interval between requests to the same host).
 * - Offline mode (option or BLASTRADIUS_OFFLINE=1): answers from fixtures
 *   (in-memory map and/or a fixtures directory), then from the cache (even if
 *   stale), and otherwise throws OfflineMissError naming the missing key.
 * - Retries 429/5xx with exponential backoff.
 *
 * Responses are untrusted data: size-capped and parsed with JSON.parse only.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultCacheDir } from './paths.js';

export type HttpMethod = 'GET' | 'POST';

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

/** Performs a single request. Replace in tests. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface RequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Request body; objects are JSON-encoded (and Content-Type set). */
  body?: unknown;
  /** Cache TTL for this request in ms. 0 disables caching for it. */
  ttlMs?: number;
  timeoutMs?: number;
}

export interface FixtureEnvelope {
  request: { url: string; method?: HttpMethod; body?: unknown };
  /** Defaults to 200. */
  status?: number;
  /** JSON value (or a string for text responses). */
  response: unknown;
}

export interface HttpClientOptions {
  transport?: Transport;
  /** Cache directory. Default: a per-user cache dir (see core/paths.ts), never the cwd. `false` disables the disk cache. */
  cacheDir?: string | false;
  /** Default TTL in ms (default 24h). */
  defaultTtlMs?: number;
  /** Offline mode. Defaults to process.env.BLASTRADIUS_OFFLINE === '1'. */
  offline?: boolean;
  /** In-memory fixtures: key (see fixtureKey) or plain URL → JSON value / FixtureEnvelope-like {status, response}. */
  fixtures?: Record<string, unknown>;
  /** Directory of fixture envelope JSON files (searched recursively). Defaults to env BLASTRADIUS_FIXTURES. */
  fixturesDir?: string;
  /** Minimum ms between requests to the same host (default 100). Per-host overrides via `hostIntervals`. */
  minIntervalMs?: number;
  hostIntervals?: Record<string, number>;
  /** Retries on 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Max response size in bytes (default 25 MB). */
  maxBytes?: number;
  userAgent?: string;
  /** Clock and sleep, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export class OfflineMissError extends Error {
  constructor(
    readonly url: string,
    readonly key: string,
  ) {
    super(
      `Offline mode: no fixture or cached response for ${key}. ` +
        `Add a fixture envelope {"request":{"url":...},"response":...} to the fixtures dir, or run online.`,
    );
    this.name = 'OfflineMissError';
  }
}

const DAY = 24 * 60 * 60 * 1000;
/** Tolerated clock skew for cache timestamps written by another process. */
const CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Normalise the request body to the exact string that is sent (or undefined). */
function encodeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Lookup key for a request: "GET <url>" or "POST <url> <sha256(body)[0..16]>".
 * Fixtures may be keyed by this, or by the plain URL (matches any method/body).
 */
export function fixtureKey(url: string, method: HttpMethod = 'GET', body?: unknown): string {
  const b = encodeBody(body);
  return method === 'GET' || b === undefined ? `${method} ${url}` : `${method} ${url} ${sha256(b).slice(0, 16)}`;
}

interface CacheEntry {
  key: string;
  storedAt: number;
  status: number;
  body: string;
}

interface StoredResponse {
  status: number;
  body: string;
}

const defaultTransport: Transport = async (req) => {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: AbortSignal.timeout(req.timeoutMs),
    redirect: 'follow',
  };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetch(req.url, init);
  return { status: res.status, body: await res.text() };
};

export class HttpClient {
  readonly offline: boolean;
  private readonly transport: Transport;
  private readonly cacheDir: string | false;
  private readonly defaultTtlMs: number;
  private readonly fixtures = new Map<string, StoredResponse>();
  private readonly fixturesDir: string | undefined;
  private fixturesDirLoaded: Promise<void> | undefined;
  private readonly minIntervalMs: number;
  private readonly hostIntervals: Record<string, number>;
  private readonly maxRetries: number;
  private readonly maxBytes: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** host → time the next request may start. */
  private readonly hostNext = new Map<string, number>();
  /** Resolved disk cache directory, or false when disabled. */
  get cacheDirectory(): string | false {
    return this.cacheDir;
  }
  /** Number of transport calls made (for metrics / tests). */
  requestCount = 0;

  constructor(opts: HttpClientOptions = {}) {
    this.transport = opts.transport ?? defaultTransport;
    this.cacheDir = opts.cacheDir === undefined ? join(defaultCacheDir(), 'http') : opts.cacheDir;
    this.defaultTtlMs = opts.defaultTtlMs ?? DAY;
    this.offline = opts.offline ?? process.env.BLASTRADIUS_OFFLINE === '1';
    this.fixturesDir = opts.fixturesDir ?? process.env.BLASTRADIUS_FIXTURES ?? undefined;
    this.minIntervalMs = opts.minIntervalMs ?? 100;
    this.hostIntervals = opts.hostIntervals ?? {};
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
    this.userAgent = opts.userAgent ?? 'blastradius/0.1 (+supply-chain auditor)';
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (const [k, v] of Object.entries(opts.fixtures ?? {})) this.addFixture(k, v);
  }

  /** Register a fixture under a fixtureKey() or a plain URL. */
  addFixture(key: string, value: unknown): void {
    const stored: StoredResponse =
      isEnvelopeLike(value) && typeof value.status === 'number'
        ? { status: value.status, body: toBody(value.response) }
        : { status: 200, body: toBody(value) };
    this.fixtures.set(key, stored);
  }

  /** GET/POST and parse JSON. Throws HttpError on non-2xx, OfflineMissError offline. */
  async fetchJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, opts);
    if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status);
    return parseJson<T>(url, res.body);
  }

  /** Like fetchJson but returns null on 404 (e.g. unknown package). */
  async fetchJsonOrNull<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T | null> {
    const res = await this.request(url, opts);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status);
    return parseJson<T>(url, res.body);
  }

  /** Raw text (e.g. FUNDING.yml). Throws HttpError on non-2xx. */
  async fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.request(url, opts);
    if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status);
    return res.body;
  }

  /** Low-level: returns status + body after fixtures/cache/rate limit/retries. */
  async request(url: string, opts: RequestOptions = {}): Promise<StoredResponse> {
    const parsed = safeUrl(url);
    const method = opts.method ?? 'GET';
    const body = encodeBody(opts.body);
    const key = fixtureKey(url, method, body);
    const ttl = opts.ttlMs ?? this.defaultTtlMs;

    const fixture = await this.lookupFixture(key, url);
    if (fixture) return fixture;

    const cached = await this.readCache(key);
    if (cached && (this.offline || (ttl > 0 && this.now() - cached.storedAt <= ttl))) {
      return { status: cached.status, body: cached.body };
    }
    if (this.offline) throw new OfflineMissError(url, key);

    const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: 'application/json', ...opts.headers };
    if (body !== undefined && typeof opts.body !== 'string' && !hasHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const req: TransportRequest = { url, method, headers, timeoutMs: opts.timeoutMs ?? 30_000 };
    if (body !== undefined) req.body = body;

    const res = await this.sendWithRetry(parsed.host, req);
    if (res.body.length > this.maxBytes) throw new HttpError(url, res.status, `Response too large from ${url}`);
    if (ttl > 0 && ((res.status >= 200 && res.status < 300) || res.status === 404)) {
      await this.writeCache({ key, storedAt: this.now(), status: res.status, body: res.body });
    }
    return res;
  }

  private async sendWithRetry(host: string, req: TransportRequest): Promise<TransportResponse> {
    let attempt = 0;
    for (;;) {
      await this.waitForHost(host);
      this.requestCount++;
      let res: TransportResponse | undefined;
      let err: unknown;
      try {
        res = await this.transport(req);
      } catch (e) {
        err = e;
      }
      const retryable = err !== undefined || (res !== undefined && (res.status === 429 || res.status >= 500));
      if (!retryable && res) return res;
      if (attempt >= this.maxRetries) {
        if (res) return res;
        throw err instanceof Error ? err : new Error(String(err));
      }
      await this.sleep(500 * 2 ** attempt);
      attempt++;
    }
  }

  /** Reserve a slot for `host` and wait until it starts. Concurrency-safe. */
  private async waitForHost(host: string): Promise<void> {
    const interval = this.hostIntervals[host] ?? this.minIntervalMs;
    if (interval <= 0) return;
    const now = this.now();
    const start = Math.max(now, this.hostNext.get(host) ?? 0);
    this.hostNext.set(host, start + interval);
    if (start > now) await this.sleep(start - now);
  }

  private async lookupFixture(key: string, url: string): Promise<StoredResponse | undefined> {
    if (this.fixturesDir) {
      this.fixturesDirLoaded ??= this.loadFixturesDir(this.fixturesDir);
      await this.fixturesDirLoaded;
    }
    return this.fixtures.get(key) ?? this.fixtures.get(url);
  }

  private async loadFixturesDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = (await readdir(dir, { recursive: true })) as string[];
    } catch (e) {
      throw new Error(`Cannot read fixtures dir ${dir}: ${(e as Error).message}`);
    }
    for (const rel of entries.sort()) {
      if (!rel.endsWith('.json')) continue;
      let data: unknown;
      try {
        data = JSON.parse(await readFile(join(dir, rel), 'utf8'));
      } catch {
        continue; // not a fixture envelope (or a directory named *.json)
      }
      if (!isFixtureEnvelope(data)) continue;
      const method = data.request.method ?? 'GET';
      const key = data.request.body === undefined ? data.request.url : fixtureKey(data.request.url, method, data.request.body);
      if (!this.fixtures.has(key)) this.addFixture(key, { status: data.status ?? 200, response: data.response });
    }
  }

  private cachePath(key: string): string | undefined {
    return this.cacheDir ? join(this.cacheDir, `${sha256(key)}.json`) : undefined;
  }

  private async readCache(key: string): Promise<CacheEntry | undefined> {
    const p = this.cachePath(key);
    if (!p) return undefined;
    try {
      const entry = JSON.parse(await readFile(p, 'utf8')) as CacheEntry;
      if (entry.key !== key || typeof entry.body !== 'string' || typeof entry.status !== 'number') return undefined;
      // A missing, non-finite or future storedAt would make the entry fresh forever: reject it.
      if (typeof entry.storedAt !== 'number' || !Number.isFinite(entry.storedAt)) return undefined;
      if (entry.storedAt > this.now() + CACHE_CLOCK_SKEW_MS) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    const p = this.cachePath(entry.key);
    if (!p || !this.cacheDir) return;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, p);
    } catch {
      // Cache is best-effort.
    }
  }
}

function safeUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Unsupported protocol in ${url.slice(0, 200)}`);
  return u;
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name);
}

function toBody(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function isEnvelopeLike(v: unknown): v is { status?: number; response: unknown } {
  return typeof v === 'object' && v !== null && 'response' in v && 'status' in v;
}

function isFixtureEnvelope(v: unknown): v is FixtureEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const r = (v as { request?: unknown }).request;
  return (
    'response' in v && typeof r === 'object' && r !== null && typeof (r as { url?: unknown }).url === 'string'
  );
}

function parseJson<T>(url: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(url, 200, `Invalid JSON from ${url}`);
  }
}

/** Process-wide default client (lazily created). */
let defaultClient: HttpClient | undefined;

export function getDefaultHttpClient(): HttpClient {
  defaultClient ??= new HttpClient();
  return defaultClient;
}

/** Convenience wrapper. Pass `client` to use a specific HttpClient (e.g. EnrichContext.http). */
export function fetchJson<T = unknown>(url: string, opts: RequestOptions & { client?: HttpClient } = {}): Promise<T> {
  const { client, ...rest } = opts;
  return (client ?? getDefaultHttpClient()).fetchJson<T>(url, rest);
}
