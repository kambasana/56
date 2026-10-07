import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inventory } from '../core/types.js';
import { addOsvRecord, emptyPack, finishPack } from '../pack/build.js';
import { createUser } from './store/auth.js';
import { openStore, type Store } from './store/db.js';
import { createOrg } from './store/orgs.js';
import { createProject } from './store/projects.js';
import { completeScan, enqueueScan, markScanRunning } from './store/scans.js';
import { makeResult, steppingClock } from './store/testing.js';
import { AlertWatcher, alertMessage, webhookAllowed } from './watch.js';

const posts: string[] = [];
let hookUrl = '';
const hook = createServer((req: IncomingMessage, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    posts.push(body);
    res.end('ok');
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((r) => hook.close(() => r())));

const dir = mkdtempSync(join(tmpdir(), 'watch-'));
const packFile = join(dir, 'pack.json.gz');
function writePack(records: Parameters<typeof addOsvRecord>[1][], mtime: number): void {
  const p = emptyPack('2026-10-07T00:00:00.000Z');
  for (const r of records) addOsvRecord(p.malware, r);
  writeFileSync(packFile, gzipSync(Buffer.from(JSON.stringify(finishPack(p, [])))));
  utimesSync(packFile, mtime, mtime);
}
const npm = (name: string) => ({ name, ecosystem: 'npm' });

function inventory(): Inventory {
  const purl = (n: string, v: string) => `pkg:npm/${n}@${v}`;
  return {
    assets: [{ id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 5, sourceFile: 'package.json' }],
    components: [
      { purl: purl('chalk', '5.6.1'), name: 'chalk', version: '5.6.1', ecosystem: 'npm' },
      { purl: purl('debug', '4.4.2'), name: 'debug', version: '4.4.2', ecosystem: 'npm' },
      { purl: purl('lodash', '4.17.21'), name: 'lodash', version: '4.17.21', ecosystem: 'npm' },
    ] as Inventory['components'],
    edges: [
      { from: 'repo:app', to: purl('chalk', '5.6.1'), scope: 'runtime' },
      { from: purl('chalk', '5.6.1'), to: purl('debug', '4.4.2'), scope: 'runtime' },
      { from: 'repo:app', to: purl('lodash', '4.17.21'), scope: 'runtime' },
    ] as Inventory['edges'],
  };
}

function setup(): { s: Store; orgId: string; projectId: string } {
  const s = openStore({ now: steppingClock() });
  const actor = createUser(s, { email: 'a@x', name: 'A' }).id;
  const orgId = createOrg(s, { name: 'Acme' }, actor).id;
  const projectId = createProject(s, orgId, { name: 'payments', tier: 'Small', target: '/srv/app' }, actor).id;
  const q = enqueueScan(s, orgId, projectId, { requestedBy: actor, offline: true });
  markScanRunning(s, q.id);
  completeScan(s, q.id, { result: makeResult([{ name: 'lodash', score: 10 }]), inventory: inventory() });
  return { s, orgId, projectId };
}

describe('AlertWatcher', () => {
  it('raises alerts from the pack once, posts them to the webhook, and picks up a refreshed pack', async () => {
    const { s, projectId } = setup();
    writePack([{ id: 'MAL-2025-46969', affected: [{ package: npm('chalk'), versions: ['5.6.1'] }] }], 1_000);
    const logs: string[] = [];
    const w = new AlertWatcher(s, { packPath: packFile, webhookUrl: hookUrl, publicUrl: 'https://br.example', log: (m) => logs.push(m) });
    expect(w.enabled).toBe(true);

    expect(await w.checkAll()).toBe(1);
    expect(posts).toHaveLength(1);
    const msg = JSON.parse(posts[0]!) as { text: string };
    expect(msg.text).toMatch(/1 new supply-chain alert in Acme\* \(1 in production\)/);
    expect(msg.text).toMatch(/\*payments\*: `chalk@5\.6\.1` \(MAL-2025-46969\) \*production\*: Direct dependency/);
    expect(msg.text).toContain('<https://br.example/|Open Blastradius>');

    expect(await w.checkAll()).toBe(0); // same pack, same inventory: nothing new, nothing posted
    expect(posts).toHaveLength(1);

    // The pack is refreshed (new mtime) with a debug advisory: the next sweep finds it.
    writePack(
      [
        { id: 'MAL-2025-46969', affected: [{ package: npm('chalk'), versions: ['5.6.1'] }] },
        { id: 'MAL-2025-46974', affected: [{ package: npm('debug'), versions: ['4.4.2'] }] },
      ],
      2_000,
    );
    expect(await w.checkAll()).toBe(1);
    expect(JSON.parse(posts[1]!).text).toMatch(/debug@4\.4\.2.*Brought in by chalk/);

    // After a scan, only that project is checked; no new hits means no post.
    w.afterScan(projectId);
    await w.idle();
    expect(posts).toHaveLength(2);
    expect(logs.filter((l) => /failed/.test(l))).toEqual([]);
  });

  it('does nothing without a pack', async () => {
    const { s } = setup();
    const saved = process.env.BLASTRADIUS_PACK;
    delete process.env.BLASTRADIUS_PACK;
    try {
      const w = new AlertWatcher(s, {});
      expect(w.enabled).toBe(false);
      expect(await w.checkAll()).toBe(0);
    } finally {
      if (saved !== undefined) process.env.BLASTRADIUS_PACK = saved;
    }
  });

  it('only sends to https webhooks (or http on this machine), never with credentials in the URL', () => {
    expect(webhookAllowed('https://hooks.slack.com/services/T/B/x')).toBe(true);
    expect(webhookAllowed('http://127.0.0.1:9000/hook')).toBe(true);
    expect(webhookAllowed('http://example.com/hook')).toBe(false);
    expect(webhookAllowed('https://user:pass@example.com/hook')).toBe(false);
    expect(webhookAllowed('file:///etc/passwd')).toBe(false);
    expect(webhookAllowed('not a url')).toBe(false);
  });

  it('keeps long batches short', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, projectId: 'p', projectName: 'p', scanId: null, purl: `pkg:npm/x${i}@1.0.0`, advisoryId: 'MAL-1', advisoryPublished: null, production: false, reachText: 'r', createdAt: 't' }));
    const { text } = alertMessage('Acme', many);
    expect(text.split('\n')).toHaveLength(1 + 15 + 1);
    expect(text).toMatch(/and 5 more$/);
  });
});
