/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, phase P3): every threshold in one place, like
 * HISTORY_RULES (src/history/aggregate.ts) and the scoring weights.
 *
 * Methods this builds on (cited in the plan, §10 P3):
 *   - S3 maintenance status: OpenSSF Scorecard's Maintained check (archived = lowest score, activity
 *     counted over 90 days; https://github.com/ossf/scorecard/blob/main/docs/checks.md and
 *     checks/evaluation/maintained.go, reason "project is archived"); npm's deprecation semantics
 *     (`npm deprecate` marks versions or ranges, https://docs.npmjs.com/cli/v10/commands/npm-deprecate),
 *     so only the latest version's deprecation says the package as a whole is deprecated;
 *     the plan's 6- and 18-month lines.
 *   - S4 release regularity: CHAOSS Release Frequency (https://chaoss.community/kb/metric-release-frequency/)
 *     measured as the median gap and the coefficient of variation of the gaps between the last 10 releases.
 *   - S2 input: CHAOSS Contributor Absence Factor (https://chaoss.community/?p=3944), computed in P2.
 *   - S5a release continuity: the 180-day line of the plan, computed from git history (P2) and the npm
 *     publisher of each release (`_npmUser`).
 *   - Finished / low-surface (P3 refinement, plan §10): a small, settled package. Abdalkareem et al.,
 *     "Why Do Developers Use Trivial Packages? An Empirical Case Study on npm" (ESEC/FSE 2017,
 *     doi:10.1145/3106237.3106267) found 16.8 % of npm packages trivial (≤ 35 lines of code, McCabe
 *     complexity ≤ 10) and the developers' main concern with them was the dependency overhead, not
 *     upkeep; a trivial package has little that can need changing. Size is read from npm's own
 *     `dist.unpackedSize` / `dist.fileCount` (computed by npm publish from the tarball, npm/cli
 *     lib/utils/tar.js), or the same numbers from the tarball for versions published before npm
 *     recorded them. Lines of code are not in the registry, so the bound is on bytes: 32 KiB holds
 *     a few hundred lines with the README, licence and package.json, well above the 35-line
 *     trivial line (a deliberate margin, not a fit). Open advisories: OSV through the scan's
 *     vulnerability facts (OpenSSF Scorecard's Vulnerabilities check uses the same source for "open,
 *     unfixed vulnerabilities"). Release churn: CHAOSS Release Frequency, counted as the stable
 *     releases in the final year of the history.
 */
export const STABILITY_RULES = {
  /** S3 `inactive`: no commit and no release for this many months (the owner's example, plan S3). */
  inactiveMonths: 18,
  /** S3 `quiet`: no commit for this many months (but a commit or a release within inactiveMonths). */
  quietCommitMonths: 6,
  /** S2: the CAF window (P2 headline) and the fewest commits a CAF is used with. */
  cafMonths: 24,
  cafMinCommits: 5,
  /** S4: releases looked at (the last N stable releases), the fewest needed, and the irregular test. */
  cadenceReleases: 10,
  cadenceMinReleases: 4,
  irregularCv: 1.5,
  irregularGapFactor: 3,
  /** S5a / C1 / C2 / L2: observations count for a label when dated within this many months. */
  recentMonths: 12,
  /** S5a: release by an account first seen in the repository fewer than this many days earlier. */
  newReleaserDays: 180,
  /** F2/F3 (funding): concentrated at or above this top-funder share. Funding is P4: not yet assessed. */
  fundingConcentrated: 0.5,
  /** Finished / low-surface: every version in use at most this many bytes unpacked and this many files. */
  finishedMaxUnpackedBytes: 32 * 1024,
  finishedMaxFiles: 10,
  /** ... with at most this many runtime (and optional) dependencies of its own. */
  finishedMaxDependencies: 2,
  /** ... first released at least this many months before the scan (twice the inactive line). */
  finishedMinAgeMonths: 36,
  /** ... with at most this many stable releases in the final 12 months of its history (no churn). */
  finishedMaxReleasesInFinalYear: 3,
} as const;

/** Label rules, as named on screen and in reports. Each label lists the rules that fired. */
export const LABEL_RULES = {
  fragile_single_contributor_inactive: 'Fragile: CAF = 1 and S3 inactive',
  fragile_single_contributor_funding_stopped: 'Fragile: CAF = 1 and F3 funding stopped',
  fragile_ended_production: 'Fragile: S3 ended (high confidence) while a production dependency',
  fragile_unfixed_advisory_inactive: 'Fragile: open advisory with no fixed release, and S3 inactive or ended',
  watch_finished_single_contributor_inactive: 'Watch: small, finished package: single maintainer, no recent activity',
  watch_single_contributor: 'Watch: CAF = 1',
  watch_quiet: 'Watch: S3 quiet',
  watch_inactive: 'Watch: S3 inactive (CAF not 1, or unknown)',
  watch_ended: 'Watch: S3 ended, not in production or declared only',
  watch_funding_concentrated_declining: 'Watch: F2 concentrated and F3 declining',
  watch_release_continuity: 'Watch: S5a release continuity',
  watch_license_category_change: 'Watch: L2 licence category change',
  watch_signed_share_fell: 'Watch: C2 signed share fell',
  watch_contributor_base_changed_with_other: 'Watch: C1 contributor base changed together with another signal',
} as const;

export type LabelRuleId = keyof typeof LABEL_RULES;

/** Rules that need funding data (P4). They are listed as not assessed, never guessed. */
export const FUNDING_RULES: readonly LabelRuleId[] = ['fragile_single_contributor_funding_stopped', 'watch_funding_concentrated_declining'];

export const FUNDING_NOT_ASSESSED = 'Funding not yet assessed (plan phase P4): the funding rules are not applied.';
