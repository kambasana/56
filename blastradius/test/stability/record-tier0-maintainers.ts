/**
 * Record the Tier 0 maintainer-change fixture ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier0-maintainers.ts
 *
 * The npm/cli packages parse-server's real scan flagged 8 times as MEDIUM "maintainer list changed
 * (added <account>)" (teardown problem 4), at the versions that scan locked. Packuments go through
 * slimPackument (the fields the npm enricher reads), then lose every e-mail address and README; only
 * the versions up to and including the latest are kept, as published.
 * Output: test/fixtures/stability/recorded/tier0-maintainers.json.gz.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { packumentUrl, slimPackument } from '../../src/enrich/npm/registry.js';
import { STABILITY_DIR } from './fixture.js';
import { getJson } from './record-lib.js';

export const NPMCLI = { '@npmcli/arborist': '9.9.2', '@npmcli/config': '10.13.0', libnpmdiff: '8.1.13', libnpmexec: '10.3.3', libnpmfund: '7.0.27', libnpmpack: '9.1.14', libnpmpublish: '11.2.1', npm: '11.20.0' } as const;

if (process.argv[1]?.endsWith('record-tier0-maintainers.ts')) {
  await installEnvProxy();
  const out: { _note: string; recordedAt: string; asOf: string; packuments: Record<string, unknown> } = { _note: '', recordedAt: new Date().toISOString(), asOf: '2026-10-11T22:10:00Z', packuments: {} };
  const noEmail = (m: unknown) => (m && typeof m === 'object' && 'name' in m ? { name: (m as { name: string }).name } : m);
  for (const name of Object.keys(NPMCLI)) {
    const r = await getJson(packumentUrl(name));
    if (!r.body) throw new Error(`${name}: ${r.status}`);
    const p = slimPackument(r.body) as Record<string, any>;
    delete p._declaredStatus;
    p.maintainers = (p.maintainers ?? []).map(noEmail);
    for (const m of Object.values(p.versions ?? {}) as Record<string, any>[]) {
      if (m.maintainers) m.maintainers = m.maintainers.map(noEmail);
      if (m._npmUser) m._npmUser = { name: m._npmUser.name, ...(m._npmUser.trustedPublisher ? { trustedPublisher: m._npmUser.trustedPublisher } : {}) };
      delete m.scripts;
      delete m.dist;
    }
    out.packuments[name] = p;
    console.log(name, Object.keys(p.versions).length);
  }
  out._note = `Recorded live ${out.recordedAt} by test/stability/record-tier0-maintainers.ts: npm packuments of the npm/cli packages in parse-server's real scan, slimmed (slimPackument) with every e-mail address, script and README removed.`;
  writeFileSync(join(STABILITY_DIR, 'tier0-maintainers.json.gz'), gzipSync(JSON.stringify(out), { level: 9 }));
}
