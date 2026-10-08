import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addOsvRecord, emptyPack, finishPack } from '../pack/build.js';
import { packMalware } from '../pack/load.js';
import { PackPoller } from './pack-poll.js';
import { openStore } from './store/db.js';
import { AlertWatcher } from './watch.js';

function packBytes(id: string, name: string): Buffer {
  const p = emptyPack('2026-10-08T00:00:00.000Z');
  addOsvRecord(p.malware, { id, affected: [{ package: { name, ecosystem: 'npm' } }] });
  return gzipSync(Buffer.from(JSON.stringify(finishPack(p, []))));
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let served = { etag: '"v1"', pack: packBytes('MAL-1', 'evil-one'), listingSha: '' };
const requests: { url: string; inm?: string }[] = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url!, ...(req.headers['if-none-match'] ? { inm: String(req.headers['if-none-match']) } : {}) });
  if (req.url === '/feeds/listing.json') {
    if (req.headers['if-none-match'] === served.etag) return void res.writeHead(304).end();
    res.writeHead(200, { etag: served.etag, 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ version: served.etag, url: 'pack-x.json.gz', sha256: served.listingSha || sha(served.pack), newestModified: '2026-10-08T10:45:09.061953778Z' }));
  }
  if (req.url === '/feeds/pack-x.json.gz') return void res.writeHead(200).end(served.pack);
  res.writeHead(404).end();
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feeds`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('pack poller', () => {
  it('downloads a newer pack, verifies it, swaps it, and the AlertWatcher sees the new pack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poll-'));
    const packPath = join(dir, 'pack.json.gz');
    const watcher = new AlertWatcher(openStore(), { packPath });
    const swaps: string[] = [];
    const poller = new PackPoller({ listingUrl: `${base}/listing.json`, packPath, onSwap: (i) => void swaps.push(i.sha256) });

    expect(await poller.poll()).toBe('swapped');
    expect(packMalware((await watcher.currentPack())!.pack, 'evil-one', '1.0.0').map((r) => r.id)).toEqual(['MAL-1']);
    // Unchanged listing: conditional request, nothing downloaded.
    expect(await poller.poll()).toBe('not-modified');
    expect(requests.at(-1)).toEqual({ url: '/feeds/listing.json', inm: '"v1"' });

    // A pack whose bytes do not match the listing is refused; the working pack stays.
    served = { etag: '"v2"', pack: packBytes('MAL-2', 'evil-two'), listingSha: 'a'.repeat(64) };
    await expect(poller.poll()).rejects.toThrow(/does not match/);
    expect(sha(readFileSync(packPath))).toBe(swaps[0]);

    served = { etag: '"v3"', pack: packBytes('MAL-2', 'evil-two'), listingSha: '' };
    expect(await poller.poll()).toBe('swapped');
    expect(swaps).toHaveLength(2);
    const now = (await watcher.currentPack())!.pack;
    expect(packMalware(now, 'evil-two', '1.0.0').map((r) => r.id)).toEqual(['MAL-2']);
    expect(packMalware(now, 'evil-one', '1.0.0')).toEqual([]);
  });

  it('refuses a pack that is not a valid knowledge pack, and plain-http listings off this machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poll-'));
    const packPath = join(dir, 'pack.json.gz');
    writeFileSync(packPath, packBytes('MAL-0', 'kept'));
    served = { etag: '"bad"', pack: gzipSync(Buffer.from('{"schema":1}')), listingSha: '' };
    await expect(new PackPoller({ listingUrl: `${base}/listing.json`, packPath }).poll()).rejects.toThrow(/unsupported schema/);
    expect(readFileSync(packPath).equals(packBytes('MAL-0', 'kept'))).toBe(true);
    expect(() => new PackPoller({ listingUrl: 'http://example.com/listing.json', packPath })).toThrow(/https/);
  });
});
