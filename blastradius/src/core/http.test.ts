import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureKey, HttpClient, HttpError, OfflineMissError, readBodyLimited, ResponseTooLargeError, type Transport } from './http.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'br-http-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeTransport(responses: Record<string, { status: number; body: unknown }>) {
  return vi.fn<Transport>(async (req) => {
    const r = responses[req.url];
    if (!r) return { status: 404, body: '{"error":"not found"}' };
    return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  });
}

const noSleep = async () => {};

describe('HttpClient', () => {
  it('fetches JSON through the transport and caches on disk', async () => {
    const transport = fakeTransport({ 'https://x.test/a': { status: 200, body: { ok: 1 } } });
    const c1 = new HttpClient({ transport, cacheDir: dir, offline: false, minIntervalMs: 0 });
    expect(await c1.fetchJson('https://x.test/a')).toEqual({ ok: 1 });
    // New client, same cache dir: served from disk.
    const c2 = new HttpClient({ transport, cacheDir: dir, offline: false, minIntervalMs: 0 });
    expect(await c2.fetchJson('https://x.test/a')).toEqual({ ok: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expiry', async () => {
    let t = 1_000;
    const transport = fakeTransport({ 'https://x.test/a': { status: 200, body: { v: 1 } } });
    const c = new HttpClient({ transport, cacheDir: dir, offline: false, minIntervalMs: 0, defaultTtlMs: 100, now: () => t });
    await c.fetchJson('https://x.test/a');
    t += 50;
    await c.fetchJson('https://x.test/a');
    expect(transport).toHaveBeenCalledTimes(1);
    t += 100;
    await c.fetchJson('https://x.test/a');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('keys POST cache entries by body', async () => {
    const transport = vi.fn<Transport>(async (req) => ({ status: 200, body: req.body ?? '' }));
    const c = new HttpClient({ transport, cacheDir: dir, offline: false, minIntervalMs: 0 });
    expect(await c.fetchJson('https://x.test/q', { method: 'POST', body: { a: 1 } })).toEqual({ a: 1 });
    expect(await c.fetchJson('https://x.test/q', { method: 'POST', body: { a: 2 } })).toEqual({ a: 2 });
    expect(await c.fetchJson('https://x.test/q', { method: 'POST', body: { a: 1 } })).toEqual({ a: 1 });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0].headers['content-type']).toBe('application/json');
  });

  it('throws HttpError on non-2xx and returns null on 404 when asked', async () => {
    const transport = fakeTransport({ 'https://x.test/forbidden': { status: 403, body: {} } });
    const c = new HttpClient({ transport, cacheDir: false, offline: false, minIntervalMs: 0 });
    await expect(c.fetchJson('https://x.test/forbidden')).rejects.toBeInstanceOf(HttpError);
    expect(await c.fetchJsonOrNull('https://x.test/missing')).toBeNull();
  });

  it('retries 5xx then succeeds', async () => {
    let n = 0;
    const transport = vi.fn<Transport>(async () => (++n < 3 ? { status: 503, body: '' } : { status: 200, body: '[1]' }));
    const sleep = vi.fn(noSleep);
    const c = new HttpClient({ transport, cacheDir: false, offline: false, minIntervalMs: 0, sleep });
    expect(await c.fetchJson('https://x.test/r')).toEqual([1]);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('rate-limits per host', async () => {
    let t = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const transport = vi.fn<Transport>(async () => ({ status: 200, body: '{}' }));
    const c = new HttpClient({ transport, cacheDir: false, offline: false, minIntervalMs: 200, now: () => t, sleep });
    await Promise.all([c.fetchJson('https://a.test/1'), c.fetchJson('https://a.test/2'), c.fetchJson('https://b.test/1')]);
    expect(waits).toEqual([200]); // second a.test request waits; b.test does not
  });

  it('rejects non-http URLs', async () => {
    const c = new HttpClient({ transport: fakeTransport({}), cacheDir: false, offline: false });
    await expect(c.fetchJson('file:///etc/passwd')).rejects.toThrow(/Unsupported protocol/);
  });

  describe('offline', () => {
    it('serves in-memory fixtures by URL or key and never calls the transport', async () => {
      const transport = fakeTransport({});
      const body = { queries: [{ package: { name: 'a' } }] };
      const c = new HttpClient({
        transport,
        cacheDir: false,
        offline: true,
        fixtures: {
          'https://x.test/a': { hello: 'world' },
          [fixtureKey('https://x.test/q', 'POST', body)]: { results: [] },
          'https://x.test/gone': { status: 404, response: { error: 'nope' } },
        },
      });
      expect(await c.fetchJson('https://x.test/a')).toEqual({ hello: 'world' });
      expect(await c.fetchJson('https://x.test/q', { method: 'POST', body })).toEqual({ results: [] });
      expect(await c.fetchJsonOrNull('https://x.test/gone')).toBeNull();
      expect(transport).not.toHaveBeenCalled();
    });

    it('loads fixture envelopes from a directory recursively', async () => {
      const fx = join(dir, 'fx');
      await mkdir(join(fx, 'npm'), { recursive: true });
      await writeFile(join(fx, 'npm', 'lodash.json'), JSON.stringify({ request: { url: 'https://registry.npmjs.org/lodash' }, response: { name: 'lodash' } }));
      await writeFile(join(fx, 'osv.json'), JSON.stringify({ request: { url: 'https://api.osv.dev/v1/querybatch', method: 'POST' }, response: { results: [{}] } }));
      await writeFile(join(fx, 'notes.json'), JSON.stringify({ unrelated: true }));
      const c = new HttpClient({ cacheDir: false, offline: true, fixturesDir: fx, transport: fakeTransport({}) });
      expect(await c.fetchJson('https://registry.npmjs.org/lodash')).toEqual({ name: 'lodash' });
      // Envelope without body matches any POST body to that URL.
      expect(await c.fetchJson('https://api.osv.dev/v1/querybatch', { method: 'POST', body: { x: 1 } })).toEqual({ results: [{}] });
    });

    it('falls back to stale cache, then throws OfflineMissError', async () => {
      const online = new HttpClient({ transport: fakeTransport({ 'https://x.test/c': { status: 200, body: [42] } }), cacheDir: dir, offline: false, minIntervalMs: 0, defaultTtlMs: 1, now: () => 0 });
      await online.fetchJson('https://x.test/c');
      const transport = fakeTransport({});
      const off = new HttpClient({ transport, cacheDir: dir, offline: true, now: () => 1e12 });
      expect(await off.fetchJson('https://x.test/c')).toEqual([42]);
      const err = await off.fetchJson('https://x.test/none').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OfflineMissError);
      expect((err as Error).message).toContain('GET https://x.test/none');
      expect(transport).not.toHaveBeenCalled();
    });

    it('defaults to offline from BLASTRADIUS_OFFLINE', () => {
      expect(process.env.BLASTRADIUS_OFFLINE).toBe('1');
      expect(new HttpClient({ cacheDir: false }).offline).toBe(true);
    });
  });
});

// Regression: a scanned checkout must not be able to plant cache entries that are trusted.
describe('HttpClient cache hardening', () => {
  const URL_ = 'https://registry.npmjs.org/left-pad';
  const cacheFile = (cacheDir: string) =>
    join(cacheDir, `${createHash('sha256').update(`GET ${URL_}`).digest('hex')}.json`);

  it('rejects cache entries with a future, missing or non-finite storedAt', async () => {
    for (const storedAt of [9e15, undefined, 'x', null]) {
      await mkdir(dir, { recursive: true });
      await writeFile(cacheFile(dir), JSON.stringify({ key: `GET ${URL_}`, storedAt, status: 200, body: '{"poisoned":true}' }));
      const transport = fakeTransport({ [URL_]: { status: 200, body: { name: 'left-pad' } } });
      const c = new HttpClient({ transport, cacheDir: dir, offline: false, minIntervalMs: 0 });
      expect(await c.fetchJson(URL_)).toEqual({ name: 'left-pad' });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('defaults to a per-user cache dir, not the working directory', async () => {
    const prev = { cwd: process.cwd(), env: process.env.BLASTRADIUS_CACHE_DIR };
    const userCache = join(dir, 'user-cache');
    process.env.BLASTRADIUS_CACHE_DIR = userCache;
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.blastradius-cache'), { recursive: true });
    await writeFile(
      cacheFile(join(repo, '.blastradius-cache')),
      JSON.stringify({ key: `GET ${URL_}`, storedAt: Date.now(), status: 200, body: '{"poisoned":true}' }),
    );
    process.chdir(repo);
    try {
      const transport = fakeTransport({ [URL_]: { status: 200, body: { name: 'left-pad' } } });
      const c = new HttpClient({ transport, offline: false, minIntervalMs: 0 });
      expect(c.cacheDirectory).toBe(join(userCache, 'http'));
      expect(await c.fetchJson(URL_)).toEqual({ name: 'left-pad' });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(prev.cwd);
      if (prev.env === undefined) delete process.env.BLASTRADIUS_CACHE_DIR;
      else process.env.BLASTRADIUS_CACHE_DIR = prev.env;
    }
  });
});

describe('response size limit', () => {
  it('stops reading a streamed body once maxBytes is exceeded and cancels the stream', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulls++;
        ctrl.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBodyLimited(new Response(stream), 'https://x.test/big', 250)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('rejects an announced Content-Length over the limit without reading, and measures bytes not chars', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'content-length': '999999' } });
    await expect(readBodyLimited(res, 'https://x.test/a', 100)).rejects.toThrow(/too large/);
    // 4 chars, 12 bytes of UTF-8.
    await expect(readBodyLimited(new Response('€€€€'), 'https://x.test/b', 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(await readBodyLimited(new Response('\uFEFF€€€€'), 'https://x.test/c', 15)).toBe('€€€€');
  });

  it('passes maxBytes to the transport, checks bytes as a backstop and does not retry', async () => {
    const transport = vi.fn<Transport>(async () => ({ status: 200, body: '"' + '€'.repeat(20) + '"' }));
    const c = new HttpClient({ transport, cacheDir: false, offline: false, minIntervalMs: 0, maxBytes: 30, sleep: noSleep });
    await expect(c.fetchJson('https://x.test/eur')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(transport.mock.calls[0]![0].maxBytes).toBe(30);

    const throwing = vi.fn<Transport>(async (req) => {
      throw new ResponseTooLargeError(req.url, 200, req.maxBytes!);
    });
    const c2 = new HttpClient({ transport: throwing, cacheDir: false, offline: false, minIntervalMs: 0, maxBytes: 30, sleep: noSleep });
    await expect(c2.fetchJson('https://x.test/big')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('default transport aborts an endless response from a real server', async () => {
    let closed!: () => void;
    const closedP = new Promise<void>((r) => (closed = r));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => res.write('x'.repeat(4096)), 1);
      res.on('close', () => {
        clearInterval(timer);
        closed();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const c = new HttpClient({ cacheDir: false, offline: false, minIntervalMs: 0, maxBytes: 64 * 1024, maxRetries: 0 });
      await expect(c.fetchText(`http://127.0.0.1:${port}/stream`)).rejects.toBeInstanceOf(ResponseTooLargeError);
      await closedP;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
