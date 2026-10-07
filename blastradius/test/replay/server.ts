/**
 * Replay server: answers like registry.npmjs.org and api.osv.dev from the recorded dataset, as of
 * a simulated clock. Anything published after the clock does not exist yet. The engine talks to it
 * over real HTTP through its normal client; only the base URLs differ.
 *
 *   GET  /registry/<name>          packument with versions and time entries up to the clock,
 *                                  dist-tags.latest recomputed
 *   POST /osv/v1/querybatch        OSV batch query over advisories published up to the clock
 *   GET  /osv/v1/vulns/<id>        one advisory, 404 until it is published
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisoryAffects, type AdvisoryLike } from '../../src/watch/match.js';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

type Json = Record<string, any>;

function loadDir(dir: string): Json[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Json);
}

export interface ReplayServer {
  url: string;
  registryUrl: string;
  osvUrl: string;
  /** Move the simulated clock. */
  setClock(at: Date): void;
  clock(): Date;
  /** Requests served (for "no live network" assertions). */
  requests: string[];
  close(): Promise<void>;
}

/** Every version is malicious when a range starts at 0 and is never fixed. */
function allVersions(a: Json): boolean {
  return (a.ranges ?? []).some((r: Json) => {
    const ev: Json[] = r.events ?? [];
    return ev.some((e) => e.introduced === '0') && !ev.some((e) => 'fixed' in e || 'last_affected' in e);
  });
}

export async function startReplayServer(opts: { clock: Date; dataDir?: string }): Promise<ReplayServer> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const packuments = new Map(loadDir(join(dataDir, 'registry')).map((p) => [p.name as string, p]));
  const advisories = loadDir(join(dataDir, 'advisories'));
  let clock = opts.clock.getTime();
  const requests: string[] = [];
  const visible = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= clock;

  function packumentAsOf(name: string): Json | null {
    const p = packuments.get(name);
    if (!p) return null;
    const versions: Json = {};
    const time: Json = {};
    for (const [v, m] of Object.entries(p.versions as Json)) {
      if (!visible(p.time?.[v])) continue;
      const { _replay, ...manifest } = m as Json; // reconstruction notes stay out of the API
      versions[v] = manifest;
      time[v] = p.time[v];
    }
    const order = Object.keys(versions).sort((a, b) => Date.parse(time[a]) - Date.parse(time[b]));
    if (order.length === 0) return null;
    const stable = order.filter((v) => !v.includes('-'));
    time.created = time[order[0]!];
    time.modified = time[order[order.length - 1]!];
    return { ...p, versions, time, 'dist-tags': { latest: (stable.length ? stable : order)[stable.length ? stable.length - 1 : order.length - 1] } };
  }

  function vulnsFor(name: string, version: string | undefined): Json[] {
    return advisories.filter(
      (a) =>
        visible(a.published) &&
        // Same rule as OSV: explicit versions, or the SEMVER ranges when no list is given.
        version !== undefined && advisoryAffects(a as AdvisoryLike, name, version),
    );
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://replay');
    requests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname.startsWith('/registry/')) {
      const name = decodeURIComponent(url.pathname.slice('/registry/'.length));
      const p = packumentAsOf(name);
      return p ? send(200, p) : send(404, { error: 'Not found' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/osv/v1/vulns/')) {
      const id = decodeURIComponent(url.pathname.slice('/osv/v1/vulns/'.length));
      const a = advisories.find((x) => x.id === id && visible(x.published));
      return a ? send(200, a) : send(404, { message: 'Bug not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/osv/v1/querybatch') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const queries = (JSON.parse(body || '{}').queries ?? []) as Json[];
        send(200, { results: queries.map((q) => ({ vulns: vulnsFor(q.package?.name, q.version).map((a) => ({ id: a.id, modified: a.modified })) })) });
      });
      return;
    }
    send(404, { error: 'not served by the replay server' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    registryUrl: `${url}/registry`,
    osvUrl: `${url}/osv/v1`,
    setClock: (at) => {
      clock = at.getTime();
    },
    clock: () => new Date(clock),
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
