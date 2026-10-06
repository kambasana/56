import { describe, expect, it } from 'vitest';
import type { Finding, Inventory } from '../core/types.js';
import { investigateNode, type ScanFindingSet } from './graph.js';

function set(projectId: string, findings: Finding[], purls: string[]): ScanFindingSet {
  return {
    projectId,
    projectName: projectId,
    findingIds: new Map(findings.map((f, i) => [f.purl, `${projectId}-f${i}`])),
    findings,
    inventory: { assets: [], components: purls.map((purl) => ({ purl })), edges: [] } as unknown as Inventory,
    assetNames: new Map(),
  };
}

const finding = (purl: string): Finding => ({ purl, score: 50, level: 'high', reasons: [], blastRadius: { assets: [], score: 0 }, entityChain: [] });

describe('investigateNode inventory lookup', () => {
  it('knows a component from the inventory of a scan with no findings', () => {
    const res = investigateNode('pkg:npm/left-pad', [set('p1', [], ['pkg:npm/left-pad@1.3.0'])]);
    expect(res).not.toBeNull();
    expect(res).toMatchObject({ id: 'pkg:npm/left-pad', kind: 'component', appearances: [], links: [] });
  });

  it('counts inventory membership in any set, and only for purls', () => {
    const sets = [set('p1', [finding('pkg:npm/other@1.0.0')], []), set('p2', [], ['pkg:npm/left-pad@1.3.0'])];
    expect(investigateNode('pkg:npm/left-pad@1.3.0', sets)).not.toBeNull();
    expect(investigateNode('pkg:npm/absent', sets)).toBeNull();
    expect(investigateNode('left-pad', [set('p3', [], ['left-pad'])])).toBeNull();
  });
});
