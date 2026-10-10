import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasProxyEnv, installEnvProxy, noProxyMatches, proxyConnector, proxyFor } from './proxy.js';

describe('NO_PROXY matching', () => {
  const list = 'localhost,.internal.example, *.svc.cluster.local registry.npmjs.org 10.0.0.0/8,192.168.1.7,example.org:8443,[::1],fd00::/8';
  it.each([
    ['localhost', 443, true],
    ['registry.npmjs.org', 443, true],
    ['sub.registry.npmjs.org', 443, true],
    ['evilregistry.npmjs.org', 443, false],
    ['a.internal.example', 443, true],
    ['internal.example', 443, true],
    ['x.svc.cluster.local', 443, true],
    ['10.2.3.4', 80, true],
    ['11.2.3.4', 80, false],
    ['192.168.1.7', 443, true],
    ['example.org', 8443, true],
    ['example.org', 443, false],
    ['::1', 443, true],
    ['[::1]', 443, true],
    ['fd00::5', 443, true],
    ['api.osv.dev', 443, false],
  ])('%s:%i -> %s', (host, port, want) => {
    expect(noProxyMatches(host, port, list)).toBe(want);
  });
  it('treats * as "no proxy for anything" and empty as nothing', () => {
    expect(noProxyMatches('api.osv.dev', 443, '*')).toBe(true);
    expect(noProxyMatches('api.osv.dev', 443, '')).toBe(false);
    expect(noProxyMatches('api.osv.dev', 443, undefined)).toBe(false);
  });
});

describe('proxyFor', () => {
  it('uses HTTPS_PROXY for https, HTTP_PROXY for http, falls back to HTTP_PROXY for https, and honours NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://secure-proxy:3128', HTTP_PROXY: 'http://plain-proxy:3128', NO_PROXY: 'localhost' };
    expect(proxyFor('https:', 'api.osv.dev', 443, env)?.host).toBe('secure-proxy:3128');
    expect(proxyFor('http:', 'api.osv.dev', 80, env)?.host).toBe('plain-proxy:3128');
    expect(proxyFor('https:', 'localhost', 443, env)).toBeNull();
    expect(proxyFor('https:', 'api.osv.dev', 443, { http_proxy: 'http://lower:8080' })?.host).toBe('lower:8080');
    expect(proxyFor('https:', 'api.osv.dev', 443, {})).toBeNull();
    expect(hasProxyEnv({})).toBe(false);
    expect(hasProxyEnv({ https_proxy: 'http://p:1' })).toBe(true);
  });
});

describe('fetch through the proxy', () => {
  let target: Server;
  let proxy: Server;
  let targetPort = 0;
  let proxyPort = 0;
  const targetHits: string[] = [];
  const tunnels: { authority: string; auth?: string }[] = [];
  let refuse = false;

  beforeAll(async () => {
    target = createServer((req, res) => {
      targetHits.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    proxy = createServer((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    proxy.on('connect', (req: IncomingMessage, client: Socket) => {
      tunnels.push({ authority: req.url ?? '', ...(req.headers['proxy-authorization'] ? { auth: req.headers['proxy-authorization'] } : {}) });
      if (refuse) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host!, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => target.close(r));
    await new Promise((r) => proxy.close(r));
  });

  afterEach(() => {
    targetHits.length = 0;
    tunnels.length = 0;
    refuse = false;
  });

  const SLOT = Symbol.for('undici.globalDispatcher.1');

  async function agentClass(): Promise<new (o: object) => { close(): Promise<void> }> {
    const g = globalThis as Record<symbol, unknown>;
    if (!g[SLOT]) await fetch('data:,');
    return (g[SLOT] as { constructor: new (o: object) => { close(): Promise<void> } }).constructor;
  }

  it('installEnvProxy routes the global fetch through HTTP_PROXY with a CONNECT tunnel', async () => {
    const g = globalThis as Record<symbol, unknown>;
    if (!g[SLOT]) await fetch('data:,');
    const before = g[SLOT];
    try {
      const installed = await installEnvProxy({ HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${proxyPort}` });
      expect(installed).toBe(true);
      const res = await fetch(`http://127.0.0.1:${targetPort}/via-proxy`);
      expect(await res.json()).toEqual({ ok: true, path: '/via-proxy' });
      expect(tunnels).toEqual([{ authority: `127.0.0.1:${targetPort}`, auth: `Basic ${Buffer.from('user:p@ss').toString('base64')}` }]);
      expect(targetHits).toEqual(['/via-proxy']);
    } finally {
      const mine = g[SLOT] as { close?: () => Promise<void> };
      g[SLOT] = before;
      if (mine !== before) await mine.close?.();
    }
  });

  it('does nothing without a proxy, or when Node already handles it (NODE_USE_ENV_PROXY=1)', async () => {
    const g = globalThis as Record<symbol, unknown>;
    const before = g[SLOT];
    expect(await installEnvProxy({})).toBe(false);
    expect(await installEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:1', NODE_USE_ENV_PROXY: '1' })).toBe(false);
    expect(g[SLOT]).toBe(before);
  });

  it('connects directly to NO_PROXY hosts', async () => {
    const Agent = await agentClass();
    const agent = new Agent({ connect: proxyConnector({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.0/8' }) });
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/direct`, { dispatcher: agent } as RequestInit);
      expect(res.status).toBe(200);
      expect(tunnels).toEqual([]);
      expect(targetHits).toEqual(['/direct']);
    } finally {
      await agent.close();
    }
  });

  it('fails the request when the proxy refuses the tunnel', async () => {
    refuse = true;
    const Agent = await agentClass();
    const agent = new Agent({ connect: proxyConnector({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }) });
    try {
      const err = await fetch(`http://127.0.0.1:${targetPort}/refused`, { dispatcher: agent } as RequestInit).catch((e: unknown) => e as Error & { cause?: Error });
      expect(err).toBeInstanceOf(TypeError);
      expect((err as { cause?: Error }).cause?.message).toMatch(/proxy refused CONNECT .*HTTP 407/);
      expect(targetHits).toEqual([]);
    } finally {
      await agent.close();
    }
  });
});
