# Pre-registration: account-level blast radius and early warning

Written and committed **before** any account-level metric was computed (2026-10-08). The
methods, thresholds and pass/fail rules below are fixed. Anything changed afterwards is listed in
the report under "Deviations from pre-registration", with the reason.

What had been looked at before writing this: the existing replay proof (docs/PROOF.md), the list of
packages qix and the control accounts can publish **today** (`registry.npmjs.org/-/user/<u>/package`:
qix 79, no longer including chalk), and the count and publish dates of OSV records whose text
names "Shai-Hulud" (2,115 npm entries; waves on 2025-09-15..18, 2025-11-24..26 and later in 2026).
No burst, exposure or concentration number had been computed.

## Data rules

- Everything comes from recorded public data: npm packuments (`time`, `versions[*]._npmUser`,
  `versions[*].maintainers`), npm version documents, OSV records (with their `published` time),
  and lockfiles of public GitHub repos at pinned commits. Every file carries its source URL and
  fetch time in a manifest.
- **Nothing missing is reconstructed silently.** When npm deleted a malicious version its manifest
  (and `_npmUser`) is gone; the publish time usually survives in `time`. A bad version's publisher is
  then attributed only when the previous version's `maintainers` has exactly one account
  (`attribution: "sole-maintainer"`); otherwise it is `"ambiguous"` and excluded from per-account
  analysis, and counted as such.
- **Account index as of T**: account A *can publish* package P at time T when A is in the
  `maintainers` of the latest version of P published at or before T. (npm records maintainers per
  published version; an owner added without a later publish is invisible. This is a stated
  limitation.) Candidate packages: every package in the stored inventories plus the account's
  current package list plus the incident's advisory-named packages.

## Incidents and their accounts

- **chalk/debug, Sept 2025, account `qix`.** Bad set = npm OSV records (MAL/GHSA) whose affected
  package qix can publish as of 2025-09-08T12:00Z and that list an explicit affected version whose
  npm publish time is on 2025-09-08 (UTC).
- **Shai-Hulud 2025.** OSV npm records whose text matches /shai[- _]?hulud/i. Wave 1 = records
  published 2025-09-14..2025-09-30 (primary); wave 2 = 2025-11-20..2025-12-05 (secondary, analysed
  the same way if the data volume allows; reported as "not analysed" otherwise). Each bad version's
  account comes from `_npmUser` when still present, else the sole-maintainer rule above.
- **event-stream 2018, account `right9ctrl`.** Expected to add nothing (single takeover).

T0(account) = the earliest OSV `published` time among the records naming any bad package of that
account.

## H1 Compromise response

At T0, the "account compromised" query names every (project, package) in the stored inventories
where the package can be published by the account as of T0 (package level, any locked version).

Metrics per incident/account:
1. `named_at_T0`: (project, package) exposures named by the account query at T0.
2. `advisory_at_T0`: exposures that per-package advisories existing at T0 would name at package
   level (packages with an OSV record published ≤ T0), and the number of such advisories.
3. For exposures whose package is later in the bad set, hours gained = max(0, first advisory naming
   that package − T0). Report the median over exposures (and over packages, without the org).
4. Precision of the account query: share of named exposures whose package was in the bad set;
   and the version-level hits (locked version is a bad version) and whether they were named at T0.
   Package-level names on old locked versions are "at risk on update", not "hit"; reported apart.

**H1 passes** for an incident if `named_at_T0` > `advisory_at_T0` for bad-set packages (more of the
truly affected exposures are named at T0 than the advisories existing at T0 name) **and** the
median hours gained > 0. Reported per incident; event-stream is expected to show 0 gain.

## H2 Burst early warning

Rule: account A raises an account-level warning at time t when, within (t − 6 h, t], A published
new versions of **≥ 5 distinct packages** (publisher = `_npmUser`, or the attribution above). The
warning time is the publish time of the release that makes the count reach 5. Warnings for the same
account less than 24 h apart are one episode.

- **Lead** = T0(account) − first warning time in the incident (positive = before the advisory).
- **Controls**: the 10 accounts that published the most locked packages across the hammer control
  repos (microsoft/TypeScript, mochajs/mocha at their pinned commits), plus sindresorhus, ljharb,
  isaacs and types, excluding incident accounts. Also qix itself outside 2025-09-08.
- **Control period**: 2025-06-01T00:00Z to 2025-12-31T23:59Z. Candidate packages per control
  account = its current package list (accounts that lost access to a package are missed, so false
  alarm counts are lower bounds). Accounts with more than 1,500 packages are recorded on a
  deterministic sample (first 1,500 names in sorted order; again a lower bound).
- **False-alarm rate** = episodes on control accounts per account-month, and the share of control
  accounts with at least one episode. Secondary (fixed now): the same excluding the automation
  account `types`; sensitivity N ∈ {3, 5, 10}, W ∈ {1 h, 6 h} (descriptive only).

**H2 passes** if (a) it warns before T0 for chalk/debug, (b) it warns before T0 for at least half of
the wave-1 Shai-Hulud accounts that have ≥ 5 bad packages, and (c) the primary false-alarm rate is
≤ 0.1 episodes per control account-month. If (c) fails the rule is reported as too noisy to use as
a standalone alert, whatever the lead times.

### Addendum (2026-10-08, still before any H2 number was computed)

Prompted by a report that the Shai-Hulud worm throttled itself to under about one publish per
token per hour, one more rule variant is registered and reported next to the primary rule:

- **H2-24h**: the same rule with W = 24 h (≥ 5 distinct packages within 24 h). Same lead,
  episode and false-alarm definitions; passes on the same (a)/(b)/(c) criteria. The primary rule
  stays W = 6 h; both are reported whatever they show.
- Extra control accounts for legitimate bursts: the `_npmUser` of the last `@babel/core` release
  and of the last `@aws-sdk/client-s3` release published in the control period (monorepo release
  accounts), added to the control set with the same sampling rule. Bot or trusted-publishing
  accounts among the controls are labelled as such in the report.

## H3 Concentration (descriptive, no pass/fail)

Per project (Acme replay org, the new 2025 exposure repos, and the two control repos): number of
npm components, number of distinct publishing accounts (`_npmUser` of the locked version), the top
account by "can publish" (in `maintainers` of the locked version) and its share of packages, and the
top publisher's share. Data: npm version documents for each locked name@version.

## Exposure org for 2025 (selection rule fixed now)

3–5 public GitHub repos whose `package-lock.json` at a commit dated 2025-08-01..2025-09-09 contains
chalk or debug, found by GitHub code search (preferring lockfiles that resolve a chalk/debug-family
version, so the version-level metric has cases) and taken in the order found, first ones that fetch
by SHA. Lockfiles are recorded with repo, commit and fetch time. Selection happens before any H1
number is computed.

## Outputs and gate

`test/replay/account/proof-account.ts` writes `out/account-proof.md` and `.json` offline from the
recorded data; `account-proof.test.ts` pins the numbers so they cannot drift silently. The gate
asserts the measured results (including failures), not that the hypotheses pass.
