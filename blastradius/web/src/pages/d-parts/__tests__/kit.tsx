/** Test helpers for the Track D screens: a fake API transport and a router/auth harness. */
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';
import type { ChangeRow, FindingDetail, FindingRow, MeResponse, ProjectRow, Scan } from '@server/api-types';
import { setFetcher } from '@/api';
import { AuthProvider } from '@/auth';
import { ProjectProvider } from '@/project';

export type Handler = (url: URL, init: RequestInit | undefined) => { status?: number; body: unknown } | unknown;
export type RouteSpec = [method: string, path: RegExp, handler: Handler];

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/** Install a fake fetch that dispatches on method + pathname. Unmatched calls return 404. */
export function fakeApi(routes: RouteSpec[]) {
  const calls: FakeCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const hit = routes.find(([m, re]) => m === method && re.test(url.pathname));
    if (!hit) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 });
    const out = hit[2](url, init);
    const res = out && typeof out === 'object' && 'body' in (out as object) ? (out as { status?: number; body: unknown }) : { status: 200, body: out };
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  });
  setFetcher(fn as unknown as typeof fetch);
  return { calls, fn };
}

export function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

/** Render `element` at `path` matched by `pattern`, signed in as `me`. */
export function renderPage(element: ReactElement, { path, pattern, me }: { path: string; pattern: string; me: MeResponse }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialMe={me}>
        <ProjectProvider initialProjects={[{ id: 'p1', name: 'payments-platform' }]}>
          <Routes>
            <Route path={pattern} element={element} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
          <Where />
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const T0 = '2018-11-27T10:00:00.000Z';

export function findingRow(i: number, over: Partial<FindingRow> = {}): FindingRow {
  const levels = ['critical', 'high', 'medium', 'low'] as const;
  const level = over.level ?? levels[i % 4]!;
  return {
    id: `f${i}`,
    scanId: 's2',
    projectId: 'p1',
    purl: `pkg:npm/pkg-${i}@1.0.${i}`,
    name: `pkg-${i}`,
    version: `1.0.${i}`,
    ecosystem: 'npm',
    score: 100 - (i % 100),
    level,
    mainReason: { factor: 'maintainer_change', detail: `detail for pkg-${i}` },
    factors: ['maintainer_change', 'install_script'],
    reach: { assets: 3, prodAssets: 1, paths: 4 },
    blastScore: 120,
    behind: null,
    status: 'new',
    firstSeenAt: T0,
    ...over,
  };
}

export function findingDetail(row: FindingRow, over: Partial<FindingDetail> = {}): FindingDetail {
  return {
    ...row,
    reasons: [
      { factor: 'malware', value: 1, weight: 1, contribution: 0.95, detail: 'Flagged as malware by the registry', evidence: ['https://example.org/advisory/1', 'javascript:alert(1)'] },
      { factor: 'install_script', value: 1, weight: 0.3, contribution: 0.1, detail: 'Runs a postinstall script', evidence: [] },
    ],
    assets: [
      {
        assetId: 'repo:payments-api',
        assetName: 'payments-api',
        kind: 'repo',
        environment: 'prod',
        criticality: 5,
        exposure: 1,
        paths: [['repo:payments-api', 'pkg:npm/event-stream@3.3.6', row.purl]],
      },
    ],
    entityChain: [{ from: 'pkg:npm/event-stream', entityId: 'INC-2018-0001', relation: 'incident', confidence: 1, evidence: ['https://example.org/incident'], reviewed: true }],
    finding: {} as FindingDetail['finding'],
    history: [{ scanId: 's1', at: '2018-11-20T10:00:00.000Z', score: 40, level: 'medium' }],
    statusHistory: [],
    ...over,
  };
}

export function projectRow(id: string, name: string, over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id,
    orgId: 'org_1',
    name,
    tier: 'Standard',
    tierOverrides: {},
    target: `https://github.com/acme/${name}`,
    owner: 'Payments · A. Chen',
    createdAt: T0,
    updatedAt: T0,
    lastScan: { id: `s-${id}`, projectId: id, status: 'succeeded', createdAt: T0, finishedAt: T0 },
    assets: 4,
    components: 120,
    counts: { critical: 2, high: 1, medium: 0, low: 8 },
    trend: [1, 2, 3],
    toReview: 5,
    ...over,
  };
}

export function scan(id: string, over: Partial<Scan> = {}): Scan {
  return {
    id,
    projectId: 'p1',
    status: 'succeeded',
    createdAt: T0,
    finishedAt: '2018-11-27T10:01:30.000Z',
    target: 'https://github.com/acme/payments',
    commit: 'abcdef0123456789',
    offline: true,
    requestedBy: 'u1',
    startedAt: T0,
    error: null,
    summary: {
      inventory: { assets: 4, components: 120, edges: 300, directComponents: 20, byEcosystem: {}, byScope: {}, withInstallScripts: 3 },
      counts: { critical: 2, high: 0, medium: 0, low: 8 },
      findings: 10,
      outbound: 0,
      warnings: [],
    },
    schemaVersion: '1',
    ...over,
  };
}

export function change(type: ChangeRow['type'], name: string, over: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: `${type}:pkg:npm/${name}@1.0.0`,
    type,
    purl: `pkg:npm/${name}@1.0.0`,
    name,
    version: '1.0.0',
    from: type === 'new_finding' ? null : { score: 30, level: 'low' },
    to: type === 'resolved' ? null : { score: 95, level: 'critical' },
    addedFactors: type === 'new_reason' ? ['malware'] : [],
    detail: `${name} ${type}`,
    reach: { assets: 2, prodAssets: 1 },
    findingId: type === 'resolved' ? null : `f-${name}`,
    ...over,
  };
}
