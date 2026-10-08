import { describe, expect, it } from 'vitest';
import type { AlertItem } from '@server/api-types';
import { groupIncidents, purlParts } from './Incidents';

const alert = (id: string, projectId: string, projectName: string, purl: string, production: boolean, createdAt = '2026-10-01T00:00:00Z'): AlertItem => ({
  id,
  projectId,
  projectName,
  purl,
  advisoryId: 'GHSA-1',
  advisoryPublished: null,
  production,
  reachText: '',
  createdAt,
});

describe('incidents', () => {
  it('splits a purl into name and version', () => {
    expect(purlParts('pkg:npm/%40scope/name@1.0.0')).toEqual({ name: '@scope/name', version: '1.0.0' });
    expect(purlParts('pkg:npm/lodash@4.17.20')).toEqual({ name: 'lodash', version: '4.17.20' });
    expect(purlParts('pkg:npm/lodash')).toEqual({ name: 'lodash', version: null });
  });

  it('groups alerts per advisory and package, production first', () => {
    const rows = groupIncidents([
      alert('a1', 'p1', 'web', 'pkg:npm/a@1', false),
      alert('a2', 'p2', 'api', 'pkg:npm/b@2', true, '2026-09-01T00:00:00Z'),
      alert('a3', 'p3', 'cli', 'pkg:npm/b@2', false),
      alert('a4', 'p2', 'api', 'pkg:npm/b@2', true),
    ]);
    expect(rows.map((r) => [r.name, r.projects, r.production])).toEqual([
      ['b', ['api', 'cli'], 1],
      ['a', ['web'], 0],
    ]);
    expect(rows[0]!.firstSeen).toBe('2026-09-01T00:00:00Z');
  });
});
