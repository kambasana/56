/**
 * Validation subjects for the stability labels (docs/WHO-BEHIND-PLAN.md §8, P3 gate) and the
 * control set for the hand review. Real public packages; record.ts reads them once into
 * test/fixtures/stability/recorded/ and stability.test.ts replays them offline.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'replay', 'data', 'org');

export interface StabilitySubject {
  slug: string;
  /** npm package name. */
  name: string;
  /** Version used in the gate inventory (a production dependency). */
  version: string;
  /** Git history: reuse a P2 fixture, record it here (with npm publisher links), or none. */
  history: { p2: string } | { record: string } | null;
  /** Scan dates (YYYY-MM-DD) evaluated besides the recording time. */
  asOf?: string[];
  row: number;
  note: string;
}

export const STABILITY_SUBJECTS: readonly StabilitySubject[] = [
  { slug: 'request', name: 'request', version: '2.88.2', history: { record: 'https://github.com/request/request' }, row: 6, note: 'deprecated on npm in Feb 2020 (request/request#3142): S3 ended, Fragile in production' },
  { slug: 'moment', name: 'moment', version: '2.29.4', history: { record: 'https://github.com/moment/moment' }, row: 7, note: 'maintenance mode declared in 2020: S3 quiet/ended-declared, S4 irregular, Watch not Fragile' },
  { slug: 'left-pad', name: 'left-pad', version: '1.3.0', history: { p2: 'left-pad' }, row: 4, note: 'latest version deprecated: S3 ended; CAF 1' },
  { slug: 'colors', name: 'colors', version: '1.4.0', history: { record: 'https://github.com/Marak/colors.js' }, asOf: ['2021-12-31'], row: 3, note: 'before the January 2022 sabotage releases: S1 1, CAF 1, Watch' },
  { slug: 'faker', name: 'faker', version: '5.5.3', history: { record: 'https://github.com/Marak/faker.js' }, asOf: ['2021-12-31'], row: 3, note: 'before January 2022: Watch; later deprecated → S3 ended' },
  { slug: 'core-js', name: 'core-js', version: '3.50.0', history: { p2: 'core-js' }, row: 5, note: 'CAF 1' },
  { slug: 'event-stream', name: 'event-stream', version: '3.3.6', history: { record: 'https://github.com/dominictarr/event-stream' }, asOf: ['2018-11-26'], row: 1, note: 'S5a for 3.3.6: published by an account first seen < 180 days before; Watch before the event' },
  { slug: 'express', name: 'express', version: '5.1.0', history: { p2: 'express' }, row: 12, note: 'control: Steady or Watch with reasons' },
  { slug: 'webpack', name: 'webpack', version: '5.101.0', history: { p2: 'webpack' }, row: 11, note: 'control: Steady expected (P2 found CAF 1)' },
  { slug: 'babel-core', name: '@babel/core', version: '7.28.0', history: { record: 'https://github.com/babel/babel' }, row: 11, note: 'control: Steady expected; monorepo package (repository.directory packages/babel-core): repository-level history' },
];

/**
 * The control repositories (docs/NEXT-LEVEL.md "Acme" org, test/replay/data/org): real public
 * repositories at pinned commits. Their production dependencies are the population the hand review
 * samples from.
 */
export function controlRepos(): string[] {
  return readdirSync(ORG_DIR).sort();
}
