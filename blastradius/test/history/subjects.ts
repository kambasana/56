/**
 * Validation subjects for git history (docs/WHO-BEHIND-PLAN.md §8 and the P2 gate). Each is a real
 * public repository; record.ts reads it once into test/fixtures/history/recorded/ and
 * history.test.ts replays the fixtures offline.
 */
export interface HistorySubject {
  slug: string;
  repo: string;
  /** Package that declares the repository (fact subject in the enricher test). */
  purl: string;
  role: 'plan-row' | 'hand-count' | 'control';
  /** Dates (ISO) the §8 expectations are evaluated at, besides the recording date. */
  asOf?: string[];
  note: string;
}

export const HISTORY_SUBJECTS: readonly HistorySubject[] = [
  { slug: 'xz', repo: 'https://github.com/tukaani-project/xz', purl: 'pkg:generic/xz-utils', role: 'plan-row', asOf: ['2021-12-31', '2024-02-01', '2024-03-28'], note: '§8 row 2: CAF 1–2 over 2019–2021; a contributor first seen ~2021 becomes top committer and tags releases by 2024 (CVE-2024-3094)' },
  { slug: 'event-stream', repo: 'https://github.com/dominictarr/event-stream', purl: 'pkg:npm/event-stream', role: 'plan-row', asOf: ['2018-11-26'], note: '§8 row 1: handed to a new maintainer in 2018; 3.3.6 released by an account first seen days before (issue #116)' },
  { slug: 'express', repo: 'https://github.com/expressjs/express', purl: 'pkg:npm/express', role: 'hand-count', note: '§8 row 12 control: OpenJS Foundation project, CAF ≥ 2 expected; hand-count repo 1' },
  { slug: 'core-js', repo: 'https://github.com/zloirock/core-js', purl: 'pkg:npm/core-js', role: 'hand-count', note: '§8 row 5: CAF = 1 expected; hand-count repo 2' },
  { slug: 'webpack', repo: 'https://github.com/webpack/webpack', purl: 'pkg:npm/webpack', role: 'control', note: '§8 row 11 control: CAF ≥ 2 expected' },
  { slug: 'left-pad', repo: 'https://github.com/stevemao/left-pad', purl: 'pkg:npm/left-pad', role: 'plan-row', note: '§8 row 4: CAF = 1 expected (all history; no recent commits)' },
];
