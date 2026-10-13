import { describe, expect, it } from 'vitest';
import type { ExposureMatrixResponse } from '@server/api-types';
import { confidenceWord, entityKind, entityLabel, isUnreviewed, layoutChain, MAX_NODES, type BehindLink } from './entity';
import { buildMatrix, COLUMN_CAP, matrixCsv } from './matrix';
import { layoutSankey, MAX_PROJECTS } from './sankey';

describe('sankey layout', () => {
  const flows = [
    { via: 'karma@6.3.4', projectId: 'web', projectName: 'web', production: false, assets: 1 },
    { via: 'browser-sync@2.27.5', projectId: 'pay', projectName: 'payments-api', production: true, assets: 2 },
    { via: 'browser-sync@2.27.5', projectId: 'admin', projectName: 'admin', production: false, assets: 1 },
  ];

  it('builds four columns, production first, widths by assets', () => {
    const l = layoutSankey({ label: 'ua-parser-js' }, flows);
    const col = (c: number) => l.nodes.filter((n) => n.column === c).map((n) => n.label);
    expect(col(0)).toEqual(['ua-parser-js']);
    expect(col(1)).toEqual(['browser-sync@2.27.5', 'karma@6.3.4']);
    expect(col(2)).toEqual(['payments-api', 'admin', 'web']);
    expect(col(3)).toEqual(['Production', 'Dev and test']);
    const pkg = l.nodes[0]!;
    const prod = l.nodes.find((n) => n.label === 'Production')!;
    expect(pkg.value).toBe(4);
    expect(prod.value).toBe(2);
    expect(prod.height).toBeCloseTo(pkg.height / 2, 0);
    expect(l.links.find((x) => x.title.startsWith('browser-sync@2.27.5 → payments-api'))!.title).toBe('browser-sync@2.27.5 → payments-api · runtime · 2 assets');
  });

  it('merges projects past 30 into "+N more" and stays under 50 nodes', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ via: `via-${i % 20}`, projectId: `p${i}`, projectName: `project-${i}`, production: i < 3, assets: 1 }));
    const l = layoutSankey({ label: 'x' }, many);
    expect(l.nodes.length).toBeLessThanOrEqual(50);
    expect(l.hiddenProjects).toBe(45 - MAX_PROJECTS);
    expect(l.nodes.find((n) => n.label === '+15 more projects')).toBeTruthy();
    expect(l.nodes.filter((n) => n.column === 2).slice(0, 3).every((n) => n.production)).toBe(true);
  });
});

describe('entity chain', () => {
  const link = (from: string, entityId: string, relation: BehindLink['relation'], confidence: number, reviewed = true): BehindLink => ({ from, entityId, relation, confidence, evidence: [`https://example.test/${entityId}`], method: confidence >= 0.8 ? 'deterministic' : 'probabilistic', reviewed });
  const root = 'pkg:npm/chalk';
  const links = [
    link(root, 'account:npm/sindresorhus', 'maintains', 1),
    link(root, 'account:npm/qix', 'publishes', 0.95),
    link(root, 'org:github/chalk', 'owns', 0.9),
    link('account:npm/sindresorhus', 'org:github/chalk', 'member_of', 0.6),
    link('org:github/chalk', 'funder:opencollective/chalk', 'funds', 0.4, false),
  ];

  it('names entities by host and type', () => {
    expect(entityLabel('account:npm/qix')).toBe('npm · qix');
    expect(entityLabel('org:github/chalk')).toBe('GitHub · chalk (org)');
    expect(entityLabel('funder:opencollective/chalk')).toBe('Open Collective · chalk');
    expect(entityLabel('pkg:npm/%40scope/pkg')).toBe('@scope/pkg');
    expect(entityKind('funder:opencollective/x')).toBe('funder');
    expect([confidenceWord(0.9), confidenceWord(0.6), confidenceWord(0.3)]).toEqual(['High', 'Medium', 'Low']);
    expect(isUnreviewed(links[4]!)).toBe(true);
  });

  it('opens one hop deep with "+N" on nodes that hide links, unreviewed hidden', () => {
    const l = layoutChain(root, links, { showUnreviewed: false, expanded: new Set([root]) });
    expect(l.nodes.map((n) => n.id)).toEqual([root, 'account:npm/sindresorhus', 'account:npm/qix', 'org:github/chalk']);
    expect(l.unreviewedHidden).toBe(1);
    expect(l.linksHidden).toBe(0);
    const all = layoutChain(root, links, { showUnreviewed: true, expanded: new Set([root]) });
    expect(all.nodes.find((n) => n.id === 'org:github/chalk')!.hidden).toBe(1);
    expect(all.linksHidden).toBe(1);
    const open = layoutChain(root, links, { showUnreviewed: true, expanded: new Set([root, 'org:github/chalk']) });
    expect(open.nodes.at(-1)).toMatchObject({ id: 'funder:opencollective/chalk', depth: 2 });
  });

  it('never draws more than 50 nodes', () => {
    const wide = Array.from({ length: 200 }, (_, i) => link(i < 10 ? root : `account:npm/a${i % 10}`, `account:npm/a${i}`, 'maintains', 1));
    const ids = new Set([root, ...wide.map((l) => l.entityId)]);
    const l = layoutChain(root, wide, { showUnreviewed: true, expanded: ids });
    expect(l.nodes.length).toBeLessThanOrEqual(MAX_NODES);
    expect(l.nodes[0]!.hidden).toBeGreaterThan(0);
  });
});

describe('exposure matrix model', () => {
  const cols = Array.from({ length: 45 }, (_, i) => ({ findingId: `f${i}`, projectId: 'p1', purl: `pkg:npm/c${i}@1.0.0`, name: i === 0 ? '=cmd' : `c${i}`, version: '1.0.0', level: 'high' as const, score: 70, reach: 1 }));
  const m: ExposureMatrixResponse = {
    axis: 'project',
    rows: [
      { key: 'p1', label: 'web', projectId: 'p1', environment: null, criticality: null, blastScore: 1, production: false },
      { key: 'p2', label: 'api', projectId: 'p2', environment: null, criticality: null, blastScore: 2, production: true },
    ],
    columns: cols,
    cells: [
      ...cols.map((_, col) => ({ row: 0, col, exposure: 1, pathCount: 1, findingId: `w${col}`, level: 'high' as const, production: false })),
      { row: 1, col: 3, exposure: 1, pathCount: 1, findingId: 'a3', level: 'critical' as const, production: true },
    ],
    truncated: false,
  };

  it('puts production rows first, most-shared columns left, top 40 unless asked', () => {
    const model = buildMatrix(m);
    expect(model.rows.map((r) => r.name)).toEqual(['api', 'web']);
    expect(model.columns[0]!.name).toBe('c3');
    expect(model.columns).toHaveLength(COLUMN_CAP);
    expect(model.hiddenColumns).toBe(5);
    expect(buildMatrix(m, { showAll: true }).columns).toHaveLength(45);
    expect(model.rows[0]!.cells.get(3)).toEqual({ level: 'critical', findingId: 'a3', production: true });
    expect(buildMatrix(m, { env: 'prod' }).rows.map((r) => r.name)).toEqual(['api']);
  });

  it('exports CSV with formula-looking names neutralised', () => {
    const csv = matrixCsv(buildMatrix(m, { showAll: true }), 'https://br.test');
    expect(csv.split('\n')[0]).toBe('project,environment,package,version,severity,finding');
    expect(csv).toContain('"api","Production","c3","1.0.0","critical","https://br.test/projects/p2/findings/a3"');
    expect(csv).toContain(`"'=cmd"`);
  });
});
