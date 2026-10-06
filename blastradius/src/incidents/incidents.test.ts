import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeFact, npmPurl, type Fact, type Incident } from '../core/types.js';
import {
  findJudgementWord,
  incidentAffects,
  incidentsFromMalwareFacts,
  loadIncidents,
  malwareFactsFromIncidents,
  parseIncident,
  parseIncidentYaml,
  validateKbDir,
} from './index.js';

const KB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../kb/incidents');

const valid = {
  id: 'INC-2020-0001',
  title: 'example-pkg 1.2.3 published from a compromised account',
  type: 'account_takeover',
  status: 'confirmed',
  date: '2020-05-01',
  severity: 'high',
  affected: [{ purl: 'pkg:npm/example-pkg', versions: ['1.2.3'] }],
  entities: [{ ref: 'account:npm/example', role: 'compromised_account', confidence: 0.9 }],
  evidence: ['https://example.org/advisory/1'],
};

function errorsOf(v: unknown): string[] {
  const r = parseIncident(v);
  return r.ok ? [] : r.errors;
}

describe('incident schema', () => {
  it('accepts a valid incident and defaults entities', () => {
    const r = parseIncident({ ...valid, entities: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.incident.entities).toEqual([]);
  });

  it('rejects bad ids, dates and unknown fields', () => {
    expect(errorsOf({ ...valid, id: 'INC-20-1' }).join()).toMatch(/INC-YYYY-NNNN/);
    expect(errorsOf({ ...valid, date: '2020-02-30' }).join()).toMatch(/ISO date/);
    expect(errorsOf({ ...valid, date: '2021-01-01' }).join()).toMatch(/does not match date/);
    expect(errorsOf({ ...valid, extra: 1 }).length).toBeGreaterThan(0);
  });

  it('requires evidence for confirmed incidents, https only', () => {
    expect(errorsOf({ ...valid, evidence: [] }).join()).toMatch(/confirmed incident needs at least one/);
    expect(errorsOf({ ...valid, evidence: ['http://insecure.example'] }).join()).toMatch(/https/);
    expect(errorsOf({ ...valid, evidence: ['javascript:alert(1)'] }).length).toBeGreaterThan(0);
  });

  it('checks entity confidence range and ref format', () => {
    expect(errorsOf({ ...valid, entities: [{ ref: 'account:npm/x', role: 'maintainer', confidence: 1.5 }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid, entities: [{ ref: 'account:npm/x', role: 'maintainer', confidence: -0.1 }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid, entities: [{ ref: 'someone', role: 'maintainer', confidence: 0.5 }] }).join()).toMatch(/entity id/);
  });

  it('rejects judgement words in titles', () => {
    expect(findJudgementWord('A Malicious package')).toBe('malicious');
    expect(findJudgementWord('published by a bad  actor')).toBe('bad  actor');
    expect(findJudgementWord('version published from a compromised account')).toBeUndefined();
    expect(errorsOf({ ...valid, title: 'Evil maintainer ships update' }).join()).toMatch(/judgement word "evil"/);
  });

  it('requires canonical unversioned purls', () => {
    expect(errorsOf({ ...valid, affected: [{ purl: 'pkg:npm/x@1.0.0', versions: ['1.0.0'] }] }).join()).toMatch(/unversioned/);
    expect(errorsOf({ ...valid, affected: [{ purl: 'not-a-purl', versions: ['1'] }] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...valid, affected: [{ purl: 'pkg:npm/x', versions: ['*', '1'] }] }).join()).toMatch(/only entry/);
  });

  it('requires official sources for sanctions', () => {
    const s = { ...valid, type: 'sanctions' };
    expect(errorsOf(s).join()).toMatch(/official sanctions list/);
    expect(errorsOf({ ...s, evidence: ['https://ofac.treasury.gov/recent-actions/x'] })).toEqual([]);
  });
});

describe('YAML loader', () => {
  it('parses a list of incidents and reports YAML errors', () => {
    const r = parseIncidentYaml(`- id: INC-2020-0001\n  title: x`, 'a.yaml');
    expect(r.incidents).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(parseIncidentYaml('a: [', 'b.yaml').errors[0]!.message).toMatch(/YAML parse error/);
    expect(parseIncidentYaml('', 'c.yaml').errors[0]!.message).toBe('empty file');
  });

  it('keeps dates as strings (core schema)', () => {
    const yaml = `id: INC-2020-0001
title: example-pkg 1.2.3 published from a compromised account
type: account_takeover
status: confirmed
date: 2020-05-01
severity: high
affected:
  - purl: pkg:npm/example-pkg
    versions: ["1.2.3"]
evidence:
  - https://example.org/a
`;
    const r = parseIncidentYaml(yaml);
    expect(r.errors).toEqual([]);
    expect(r.incidents[0]!.date).toBe('2020-05-01');
  });

  it('detects duplicate ids across files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-'));
    const text = JSON.stringify(valid); // JSON is valid YAML
    await writeFile(path.join(dir, 'a.yaml'), text);
    await writeFile(path.join(dir, 'b.yaml'), text);
    const res = await validateKbDir(dir);
    expect(res.ok).toBe(false);
    expect(res.files).toBe(2);
    expect(res.errors[0]!.message).toMatch(/duplicate id/);
  });

  it('reports an empty or missing directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-'));
    expect((await validateKbDir(dir)).ok).toBe(false);
    expect((await validateKbDir(path.join(dir, 'nope'))).errors[0]!.message).toMatch(/cannot read directory/);
  });

  it('the seed KB validates', async () => {
    const res = await loadIncidents(KB_DIR);
    expect(res.errors).toEqual([]);
    expect(res.files).toBeGreaterThanOrEqual(7);
    const ids = res.incidents.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const es = res.incidents.find((i) => i.affected.some((a) => a.purl === 'pkg:npm/event-stream'));
    expect(es?.type).toBe('malicious_handover');
    expect(es?.evidence).toContain('https://github.com/dominictarr/event-stream/issues/116');
    expect((await validateKbDir(KB_DIR)).ok).toBe(true);
  });

  // Regression: PLAN §3.4 seeds (chalk/debug 2025) and no "*" on npm compromised-release records.
  it('includes the 2025 chalk/debug takeover with exact versions and no npm wildcard entries', async () => {
    const res = await loadIncidents(KB_DIR);
    expect(res.files).toBeGreaterThanOrEqual(14);
    const chalk = res.incidents.find((i) => i.id === 'INC-2025-0002')!;
    expect(chalk.affected).toContainEqual({ purl: 'pkg:npm/chalk', versions: ['5.6.1'] });
    expect(chalk.affected).toContainEqual({ purl: 'pkg:npm/debug', versions: ['4.4.2'] });
    expect(chalk.evidence).toContain('https://github.com/advisories/GHSA-2v46-p5h4-248w');
    for (const inc of res.incidents) {
      for (const a of inc.affected) if (a.purl.startsWith('pkg:npm/')) expect(a.versions, `${inc.id} ${a.purl}`).not.toContain('*');
    }
    const tj = res.incidents.find((i) => i.id === 'INC-2025-0001')!;
    expect(tj.affected[0]!.versions).not.toContain('*');
  });
});

describe('OSV import and matching', () => {
  const now = '2026-01-02T03:04:05.000Z';
  const facts: Fact[] = [
    makeFact('malware', npmPurl('some-pkg', '1.0.0'), { id: 'MAL-2025-1234', origin: 'osv' }, { source: 'osv', fetchedAt: now }),
    makeFact('malware', npmPurl('some-pkg', '1.0.1'), { id: 'MAL-2025-1234', origin: 'osv', url: 'https://osv.dev/vulnerability/MAL-2025-1234' }, { source: 'osv', fetchedAt: now }),
    makeFact('malware', npmPurl('@sc/other', '2.0.0'), { id: 'GHSA-xxxx-yyyy-zzzz', origin: 'osv' }, { source: 'osv', fetchedAt: now }),
  ];

  it('turns MAL-* facts into malware_publish incidents', () => {
    const incs = incidentsFromMalwareFacts(facts);
    expect(incs).toHaveLength(1);
    const inc = incs[0]!;
    expect(inc).toMatchObject({
      id: 'MAL-2025-1234',
      type: 'malware_publish',
      status: 'confirmed',
      date: '2026-01-02',
      affected: [{ purl: 'pkg:npm/some-pkg', versions: ['1.0.0', '1.0.1'] }],
    });
    expect(inc.evidence).toEqual(['https://osv.dev/vulnerability/MAL-2025-1234']);
    expect(findJudgementWord(inc.title)).toBeUndefined();
  });

  it('matches versions and wildcards', () => {
    const inc: Incident = {
      id: 'INC-2020-0001', title: 't', type: 'ci_compromise', status: 'confirmed', date: '2020-01-01', severity: 'high',
      affected: [{ purl: 'pkg:npm/a', versions: ['1.0.0'] }, { purl: 'pkg:npm/b', versions: ['*'] }],
      entities: [], evidence: ['https://e.example'],
    };
    expect(incidentAffects(inc, 'pkg:npm/a@1.0.0')).toBe(true);
    expect(incidentAffects(inc, 'pkg:npm/a@1.0.1')).toBe(false);
    expect(incidentAffects(inc, 'pkg:npm/a')).toBe(true);
    expect(incidentAffects(inc, 'pkg:npm/b@9')).toBe(true);
    expect(incidentAffects(inc, 'pkg:npm/b@9', { wildcard: false })).toBe(false);
    expect(incidentAffects(inc, 'garbage')).toBe(false);

    const out = malwareFactsFromIncidents(
      [inc, { ...inc, id: 'INC-2020-0002', status: 'disputed' }],
      [{ purl: 'pkg:npm/a@1.0.0' }, { purl: 'pkg:npm/b@9' }, { purl: 'pkg:npm/a@2.0.0' }],
      { fetchedAt: now },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: 'pkg:npm/a@1.0.0', kind: 'malware', source: 'kb', value: { id: 'INC-2020-0001', origin: 'incident' } });
  });
});
