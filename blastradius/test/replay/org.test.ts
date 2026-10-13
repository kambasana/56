import { beforeAll, describe, expect, it } from 'vitest';
import { matchAdvisories, searchExposure, type StoredInventory } from '../../src/watch/match.js';
import { INCIDENTS, advisory, orgInventories } from './org.js';

let inv: StoredInventory[];
beforeAll(async () => {
  inv = await orgInventories();
}, 120_000);

const hitsFor = (id: string) => {
  const inc = INCIDENTS.find((i) => i.id === id)!;
  return matchAdvisories(inv, inc.advisories.map((a) => advisory(a) as never));
};
const summary = (id: string) => [...new Set(hitsFor(id).map((h) => `${h.projectName} ${h.name}@${h.version}`))];

describe('org-wide incident mode on the recorded Acme org (stored inventories, no re-scan)', () => {
  it('event-stream: two projects, production vs dev, and who brings it in', () => {
    expect(summary('event-stream-2018')).toEqual([
      'davglass/registry-static event-stream@3.3.6',
      'davglass/registry-static flatmap-stream@0.1.1',
      'Esri/a11y-map event-stream@3.3.6',
      'Esri/a11y-map flatmap-stream@0.1.1',
    ]);
    const hits = hitsFor('event-stream-2018');
    expect(hits.find((h) => h.projectName === 'davglass/registry-static' && h.name === 'event-stream')).toMatchObject({ production: true, reachText: expect.stringMatching(/^Direct dependency/) });
    expect(hits.find((h) => h.projectName === 'Esri/a11y-map' && h.name === 'event-stream')?.reachText).toMatch(/Brought in by npm-run-all .*dev\/test dependencies only/);
  });

  it('ua-parser-js and chalk/debug hit exactly the projects that pinned the bad versions', () => {
    expect(summary('ua-parser-js-2021')).toEqual(['Esger/Pentominos2 ua-parser-js@0.7.29']);
    expect(summary('chalk-debug-2025')).toEqual(['FinnLeh/vs-code-obsidian chalk@5.6.1', 'FinnLeh/vs-code-obsidian debug@4.4.2']);
  });

  it('no false alarms: incidents whose packages no project pins hit nothing', () => {
    for (const id of ['coa-rc-2021', 'eslint-config-prettier-2025', 'nx-2025']) expect(summary(id), id).toEqual([]);
  });

  it('honest miss: node-ipc 9.2.2 (peacenotwar) is not named by GHSA-97m3-w2cp-4xx6, so advisories alone miss project-qwerty', () => {
    expect(summary('node-ipc-2022')).toEqual([]);
    // ... but "is node-ipc anywhere?" finds it at once.
    expect(searchExposure(inv, { name: 'node-ipc' }).map((h) => `${h.projectName} ${h.version}`)).toEqual(['project-qwerty/project-qwerty 9.2.2']);
  });

  it('answers in milliseconds', () => {
    const t = performance.now();
    for (const inc of INCIDENTS) matchAdvisories(inv, inc.advisories.map((a) => advisory(a) as never));
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
