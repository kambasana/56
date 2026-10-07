import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReplayServer, type ReplayServer } from './server.js';
import { scanAt } from './scan-at.js';

let server: ReplayServer;
beforeAll(async () => {
  server = await startReplayServer({ clock: new Date('2018-01-01T00:00:00Z') });
});
afterAll(() => server.close());

const finding = (out: Awaited<ReturnType<typeof scanAt>>, purl: string) => out.result.findings.find((f) => f.purl === purl);

describe('replay: event-stream 2018 in davglass/registry-static', () => {
  const repo = 'davglass/registry-static';
  const es = 'pkg:npm/event-stream@3.3.6';

  it('the registry hides what was not published yet', async () => {
    server.setClock(new Date('2018-08-01T00:00:00Z'));
    const res = await fetch(`${server.registryUrl}/event-stream`);
    const p = (await res.json()) as { versions: Record<string, unknown>; 'dist-tags': { latest: string } };
    expect(Object.keys(p.versions)).not.toContain('3.3.5');
    expect(p['dist-tags'].latest).toBe('3.3.4');
  });

  it('before the advisory: an early warning (new publisher), not yet malware', async () => {
    const out = await scanAt(server, repo, new Date('2018-10-01T00:00:00Z'));
    const f = finding(out, es);
    expect(f, 'event-stream 3.3.6 should already be a finding from its publisher change').toBeDefined();
    expect(f!.reasons.map((r) => r.factor)).toContain('publisher_change');
    expect(f!.reasons.map((r) => r.factor)).not.toContain('malware');
  });

  it('after the advisory: critical, with the advisory as evidence', async () => {
    const out = await scanAt(server, repo, new Date('2018-11-27T12:00:00Z'));
    const f = finding(out, es);
    expect(f?.level).toBe('critical');
    expect(f!.reasons.some((r) => r.factor === 'malware' && r.detail.includes('GHSA-mh6f-8j2x-4483'))).toBe(true);
    expect(server.requests.every((r) => r.startsWith('GET /registry/') || r.startsWith('POST /osv/') || r.startsWith('GET /osv/'))).toBe(true);
  });
});
