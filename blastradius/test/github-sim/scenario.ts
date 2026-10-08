/**
 * The default simulated world: org "acme-sim" holds forks of the replay org's six real repos
 * (test/replay/data/org) and of mochajs/mocha, each at its pinned, recorded commit; "other-org"
 * (another admin) holds a private repo, for cross-org and install-tampering checks.
 */
import type { GitHubSim } from './sim.js';

export const SIM_ORG = 'acme-sim';
export const OTHER_ORG = 'other-org';
export const OTHER_ADMIN = 'other-admin';

/** fork name in acme-sim → recorded real repo. */
export const FORKS: Readonly<Record<string, string>> = {
  'a11y-map': 'Esri/a11y-map',
  'registry-static': 'davglass/registry-static',
  Pentominos2: 'Esger/Pentominos2',
  'project-qwerty': 'project-qwerty/project-qwerty',
  'vs-code-obsidian': 'FinnLeh/vs-code-obsidian',
  logops: 'telefonicaid/logops',
  mocha: 'mochajs/mocha',
};

export async function seedScenario(sim: GitHubSim): Promise<void> {
  sim.addOrg(SIM_ORG);
  for (const [name, from] of Object.entries(FORKS)) await sim.createRepo(SIM_ORG, name, { from });
  sim.addOrg(OTHER_ORG, [OTHER_ADMIN]);
  await sim.createRepo(OTHER_ORG, 'secret', { from: 'telefonicaid/logops', private: true });
}
