/**
 * Outbound proxy support for Node's built-in fetch.
 *
 * Node's fetch ignores HTTPS_PROXY / HTTP_PROXY unless the process was started with
 * NODE_USE_ENV_PROXY=1 (or --use-env-proxy), so a CLI behind an egress proxy could not reach
 * any registry. `installEnvProxy()` (called by the CLI entry point, which covers `scan` and
 * `serve`) replaces fetch's global dispatcher with an undici Agent, Node's own class, whose
 * connector opens an HTTP CONNECT tunnel through the proxy for every host that NO_PROXY does
 * not exclude. No dependency: undici's Agent is taken from the dispatcher Node itself creates,
 * and it is installed under undici's documented cross-copy global symbol (the same thing the
 * undici package's setGlobalDispatcher() writes).
 *
 * Proxy choice follows undici's EnvHttpProxyAgent and curl:
 * - https: URLs use HTTPS_PROXY (or https_proxy), else HTTP_PROXY (http_proxy).
 * - http: URLs use HTTP_PROXY (http_proxy).
 * - NO_PROXY (no_proxy): comma- or space-separated; `*` disables the proxy; an entry matches the
 *   host itself and its subdomains (`example.com`, `.example.com`, `*.example.com`), may carry a
 *   port (`example.com:8443`), and may be an IP address or an IPv4/IPv6 CIDR (`10.0.0.0/8`).
 * - The proxy URL may be http: or https: and may carry user:password (sent as Basic
 *   Proxy-Authorization).
 */
import { BlockList, connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export type ProxyEnv = Readonly<Record<string, string | undefined>>;

/** undici's global dispatcher slot, shared by every undici copy (Node's fetch included). */
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;

function envVar(env: ProxyEnv, name: string): string | undefined {
  const v = env[name] ?? env[name.toLowerCase()];
  return v && v.trim() ? v.trim() : undefined;
}

function parseProxyUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** True when NO_PROXY excludes this host:port from the proxy. */
export function noProxyMatches(hostname: string, port: number, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, '');
  const hostIp = isIP(host);
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    // CIDR (10.0.0.0/8, fd00::/8)
    const slash = entry.indexOf('/');
    if (slash > 0) {
      const net = stripBrackets(entry.slice(0, slash));
      const bits = Number(entry.slice(slash + 1));
      const family = isIP(net);
      if (!hostIp || !family || !Number.isInteger(bits)) continue;
      const list = new BlockList();
      try {
        list.addSubnet(net, bits, family === 6 ? 'ipv6' : 'ipv4');
        if (list.check(host, hostIp === 6 ? 'ipv6' : 'ipv4')) return true;
      } catch {
        // malformed entry: ignore
      }
      continue;
    }
    // Optional :port (not for a bare IPv6 address).
    let entryPort: number | null = null;
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    if (m && isIP(stripBrackets(entry)) !== 6) {
      entry = m[1]!;
      entryPort = Number(m[2]);
    }
    entry = stripBrackets(entry);
    if (entryPort !== null && entryPort !== port) continue;
    if (entry.startsWith('*.')) entry = entry.slice(1);
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
    } else if (host === entry || (!isIP(entry) && host.endsWith(`.${entry}`))) {
      return true;
    }
  }
  return false;
}

/** The proxy to use for a request to `protocol//hostname:port`, or null for a direct connection. */
export function proxyFor(protocol: string, hostname: string, port: number, env: ProxyEnv = process.env): URL | null {
  const raw = protocol === 'https:' ? (envVar(env, 'HTTPS_PROXY') ?? envVar(env, 'HTTP_PROXY')) : envVar(env, 'HTTP_PROXY');
  if (!raw) return null;
  if (noProxyMatches(hostname, port, envVar(env, 'NO_PROXY'))) return null;
  return parseProxyUrl(raw);
}

/** True when the environment names an HTTP(S) proxy. */
export function hasProxyEnv(env: ProxyEnv = process.env): boolean {
  return Boolean(envVar(env, 'HTTPS_PROXY') ?? envVar(env, 'HTTP_PROXY'));
}

/** Options undici passes to a custom connector. */
export interface ConnectorOptions {
  hostname: string;
  host?: string;
  protocol: string;
  port: string | number;
  servername?: string | null;
}
export type ConnectorCallback = (err: Error | null, socket: Socket | TLSSocket | null) => void;
export type Connector = (opts: ConnectorOptions, cb: ConnectorCallback) => void;

export class ProxyConnectError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ProxyConnectError';
  }
}

/** Calls `cb` once, and gives up (destroying the socket) after the connect timeout. */
function guarded(socket: Socket, cb: ConnectorCallback): { ok: (s: Socket | TLSSocket) => void; fail: (e: Error) => void } {
  let done = false;
  const timer = setTimeout(() => fail(new ProxyConnectError(`connect timed out after ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);
  timer.unref?.();
  function fail(e: Error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.destroy();
    cb(e, null);
  }
  function ok(s: Socket | TLSSocket) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(null, s);
  }
  return { ok, fail };
}

function startTls(socket: Socket | undefined, host: string, port: number, servername: string | null | undefined): TLSSocket {
  const sni = servername || (isIP(host) ? undefined : host);
  return tlsConnect({
    ...(socket ? { socket } : { host, port }),
    ...(sni ? { servername: sni } : {}),
    ALPNProtocols: ['http/1.1'],
  });
}

/**
 * An undici connector: tunnels through the proxy chosen by `proxyFor` (HTTP CONNECT, then TLS to
 * the origin for https:), or connects directly when no proxy applies.
 */
export function proxyConnector(env: ProxyEnv = process.env): Connector {
  return (opts, cb) => {
    const host = stripBrackets(opts.hostname);
    const port = Number(opts.port) || defaultPort(opts.protocol);
    const secure = opts.protocol === 'https:';
    const proxy = proxyFor(opts.protocol, host, port, env);

    if (!proxy) {
      const socket = secure ? startTls(undefined, host, port, opts.servername) : netConnect({ host, port });
      const g = guarded(socket, cb);
      socket.once(secure ? 'secureConnect' : 'connect', () => g.ok(socket));
      socket.once('error', g.fail);
      return;
    }

    const proxyHost = stripBrackets(proxy.hostname);
    const proxyPort = Number(proxy.port) || defaultPort(proxy.protocol);
    const raw = proxy.protocol === 'https:' ? startTls(undefined, proxyHost, proxyPort, null) : netConnect({ host: proxyHost, port: proxyPort });
    const g = guarded(raw, cb);
    raw.once('error', g.fail);
    raw.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxy.username || proxy.password) {
        const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(cred).toString('base64')}`);
      }
      raw.write(`${lines.join('\r\n')}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > MAX_CONNECT_RESPONSE_BYTES) g.fail(new ProxyConnectError('proxy CONNECT response too large'));
          return;
        }
        raw.off('data', onData);
        const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1] ?? 0);
        if (status !== 200) {
          g.fail(new ProxyConnectError(`proxy refused CONNECT ${authority}: HTTP ${status || 'invalid response'}`, status || undefined));
          return;
        }
        const rest = buf.subarray(end + 4);
        if (rest.length > 0) raw.unshift(rest);
        if (!secure) {
          g.ok(raw);
          return;
        }
        const tlsSocket = startTls(raw, host, port, opts.servername);
        tlsSocket.once('secureConnect', () => {
          // The TLS socket reports errors from here on; keep a late error on the tunnel from crashing.
          raw.on('error', () => undefined);
          g.ok(tlsSocket);
        });
        tlsSocket.once('error', g.fail);
      };
      raw.on('data', onData);
    });
  };
}

type DispatcherCtor = new (opts: { connect: Connector }) => object;

/**
 * Route Node's global fetch through HTTPS_PROXY / HTTP_PROXY (respecting NO_PROXY). Does nothing
 * when no proxy is configured, or when Node already does it (NODE_USE_ENV_PROXY=1 or
 * --use-env-proxy). Returns true when it installed the proxy dispatcher.
 */
export async function installEnvProxy(env: ProxyEnv = process.env): Promise<boolean> {
  if (!hasProxyEnv(env)) return false;
  if (env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return false;
  const g = globalThis as Record<symbol, unknown>;
  // Node creates its default undici Agent on the first fetch; a data: URL makes no connection.
  if (!g[GLOBAL_DISPATCHER]) await fetch('data:,').catch(() => undefined);
  const current = g[GLOBAL_DISPATCHER] as { constructor?: unknown } | undefined;
  const Agent = current?.constructor as DispatcherCtor | undefined;
  if (typeof Agent !== 'function') return false;
  g[GLOBAL_DISPATCHER] = new Agent({ connect: proxyConnector(env) });
  return true;
}
