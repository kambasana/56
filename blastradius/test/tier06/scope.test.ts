/**
 * Tier 0.6 (3): Python extras are not production. pip installs [project.optional-dependencies] only
 * when asked for (`pip install flask[async]`); npm installs optionalDependencies by default. Extras
 * get their own scope `extra`. Recorded real data: flask's pyproject.toml and uv.lock at d086db85.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { componentScopes, isProductionScope, productionSet, SCOPE_LABEL } from '../../src/core/scope.js';
import { ingest } from '../../src/ingest/index.js';
import { makeFact } from '../../src/core/types.js';
import { scoreInventory } from '../../src/scoring/index.js';

const FX = join(import.meta.dirname, '..', 'fixtures', 'tier06', 'flask-manifests.json.gz');

async function flaskInventory() {
  const fx = JSON.parse(gunzipSync(readFileSync(FX)).toString('utf8')) as { files: Record<string, string> };
  const dir = mkdtempSync(join(tmpdir(), 'br-t06-flask-'));
  try {
    for (const [n, text] of Object.entries(fx.files)) writeFileSync(join(dir, n), text);
    return await ingest(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Tier 0.6 (3): Python extras get the scope `extra`, not production', () => {
  it('flask at d086db85: production is its 7 runtime packages again; asgiref and python-dotenv are extras', async () => {
    const inv = await flaskInventory();
    const scopes = componentScopes(inv);
    const byName = (n: string) => [...scopes].find(([p]) => p.startsWith(`pkg:pypi/${n}@`))?.[1];
    // asgiref and python-dotenv are flask's extras (async, dotenv) and in its tests group.
    expect(byName('asgiref')).toBe('extra');
    expect(byName('python-dotenv')).toBe('extra');
    expect([...productionSet(inv)].map((p) => p.replace(/^pkg:pypi\/|@.*$/g, '')).sort()).toEqual(['blinker', 'click', 'colorama', 'itsdangerous', 'jinja2', 'markupsafe', 'werkzeug']);
    expect(isProductionScope('extra')).toBe(false);
    expect(isProductionScope('optional')).toBe(true);
    expect(SCOPE_LABEL.extra).toBe('extra (installed only on request)');
  });

  it('a finding on an extra is kept below high and says why', async () => {
    const inv = await flaskInventory();
    const purl = inv.components.find((c) => c.name === 'asgiref')!.purl;
    const now = new Date('2026-10-12T00:00:00Z');
    const facts = [makeFact('vuln', purl, { id: 'GHSA-test-0000-0000', aliases: [], severity: 'critical', cvss: 9.8, fixedVersions: ['9.9.9'] }, { source: 'osv', fetchedAt: now })];
    const out = scoreInventory(inv, facts, { now });
    const f = out.findings.find((x) => x.purl === purl)!;
    expect(f.scope).toBe('extra');
    expect(f.gate?.detail).toMatch(/^Python extra only \(pip installs it only on request\)/);
    expect(f.level).not.toBe('critical');
  });

  it('npm optional dependencies stay production', () => {
    const inv = { assets: [{ id: 'repo:a', kind: 'repo' as const, name: 'a', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' }], components: [], edges: [{ from: 'repo:a', to: 'pkg:npm/fsevents@2.3.3' as const, scope: 'optional' as const, direct: true }] };
    expect(componentScopes(inv).get('pkg:npm/fsevents@2.3.3')).toBe('optional');
    expect(productionSet(inv).has('pkg:npm/fsevents@2.3.3')).toBe(true);
  });
});
