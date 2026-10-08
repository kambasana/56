# Pre-registration: Laya triage of account bursts

Written and committed **before** any model was downloaded or run, and before any triage metric
(for Laya or for the plain-rules baseline) was computed (2026-10-08). The state fields, questions,
threshold rule, split and pass rule below are fixed. Anything changed afterwards is listed in the
report (docs/LAYA-TRIAGE.md) under "Deviations from the pre-registration", with the reason.

## Question

The account-level proof (docs/ACCOUNT-PROOF.md, PREREGISTRATION.md in this folder) found that the
burst rule (one account publishes new versions of ≥ 5 distinct packages within 6 h) warns before the
first advisory for qix (1.1 h) and for all 25 attributable Shai-Hulud accounts with ≥ 5 bad packages
(0.2–45 h), but raises 2.1 false alarms per control account-month against a 0.1 limit.

Can a zero-shot Laya triage step (convaiinnovations/laya via the `@receptron/laya` ONNX runtime),
run on each burst, cut false alarms to ≤ 0.1 per control account-month while keeping the early
warnings? And does it beat a plain-rules baseline on the same facts, so that it is worth a 1.7 GB
dependency?

## What had been looked at before writing this

- The published account-proof report (numbers quoted above), the recorded data format
  (`data/timelines.json`: per version publish time, `_npmUser`, maintainers, deleted flag) and the
  code of `burstWarnings`.
- The number of raw burst firings (every publish that keeps the rule firing) per control account in
  2025-06-01..2025-12-31 and how many remain at the hourly triage cadence below
  (e.g. microsoft1es 36,250 firings / 2,601 triage points, aws-sdk-bot 33,240 / 125,
  GitHub Actions 4,106 / 452). This was needed to size the compute; no triage decision, model
  output or baseline outcome was computed.
- The `@receptron/laya` 0.1.2 README and type definitions, and the file list of the Hugging Face
  repo `receptron/laya-onnx` (no file downloaded).

## Data and burst points

- Same recorded data and same event stream as the account proof: publish events 2025-06-01T00:00Z
  ..2025-12-31T23:59:59Z, publisher = `_npmUser`, or the sole maintainer of the previous version for
  deleted versions (the proof's attribution rule).
- **Burst firing**: the rule N ≥ 5 distinct packages, W = 6 h, every firing (`episodeGapMs: 0`).
- **Triage cadence (compute limit)**: per account, a firing is triaged when it is the account's first
  firing or at least 1 h after the account's previous *triaged* firing. Other firings are not
  triaged. The same cadence applies to the baseline and to Laya, and to "no triage".
- **Alerts and episodes**: a triaged firing that passes triage raises an alert; alerts of one
  account less than 24 h apart are one episode (the proof's episode rule). Sanity check (reported):
  with "no triage" (every triaged firing passes), the episode count per control must equal the
  account proof's count; any difference is reported.
- **False alarms** = episodes on control accounts per control account-month, account-months =
  accounts × (2025-06-01..2025-12-31 in months of 30.4375 days), as in the proof.
- **Incident warning**: an incident account counts as warned when an alert is raised at a triaged
  firing whose 6 h window contains the publish of one of its bad versions, before T0 (the proof's
  definition of bad versions and T0). Lead = T0 − time of the first such alert.
- Incident accounts: qix (chalk/debug 2025) and the 25 Shai-Hulud accounts with ≥ 5 attributable bad
  packages (8 wave-1, 17 wave-2), exactly those of the proof's H2 table. event-stream (right9ctrl)
  never fired and is not part of this test.

## State given to the model (and to the baseline): facts knowable at the triaged firing time t

Window = (t − 6 h, t]. "History" = recorded events of the same account before the window start,
looking back 14 days (the recording starts 2025-05-15, so 14 days are always covered for t ≥
2025-06-01). One JSON object:

- `event`: fixed text "npm account published new versions of N distinct packages within 6 hours".
- `account`: the publisher name.
- `window`: `distinct_packages`, `publishes`, `span_minutes` (first to last publish in the window),
  `utc_hour` of t.
- `account_history_14d`: `publishes`, `distinct_packages`, `burst_firings` (raw rule firings),
  `share_of_publishes_within_2h_of_this_utc_hour` (null when no history publishes),
  `days_since_first_recorded_publish` (capped by the recording start; labelled as such).
- `aggregates` over all packages in the window:
  `publisher_new_to_package` (count of packages where the account is not the `_npmUser` of any
  earlier recorded version), `dormant_over_90d` (previous release more than 90 days before this
  publish), `first_release` (no earlier version recorded), `published_by_account_in_prior_14d`
  (count), `bump` counts (major / minor / patch / prerelease / other), `account_sole_maintainer`
  (count where the maintainers before this publish are exactly [account]), `median_days_since_previous_release`.
- `packages`: up to 8 packages (sorted by name; "and K more" noted), each with `name`, `version`,
  `previous_version`, `bump`, `days_since_previous_release`, `previous_publishers` (distinct
  `_npmUser` of earlier recorded versions, up to 3, plus total count), `publisher_new_to_package`,
  `maintainers_before` (count).

"Earlier" and "before" always mean strictly before this publish; "maintainers before" are those of
the latest earlier version that has a maintainer list.

**Not in the state, on purpose:**
- Provenance (present before / now), install scripts added or changed, tarball contents. They are not
  in the recorded data, and they cannot be recorded symmetrically: npm deleted the malicious
  versions, so their manifests (and `scripts`, `dist.attestations`) are gone. Recording them now would
  give "unknown" for incident bursts and real values for control bursts, which is a hindsight leak.
  This is a real limitation of the test: a live watcher would see these fields; the experiment
  cannot. Account creation date, 2FA status and e-mail changes are not available at all.
- The deleted flag, the attribution method (`sole-maintainer` exists only because the version was
  deleted), any advisory, anything after t, and the account's role in this study.

The prompt state is truncated by the model at 512 tokens; the per-package list is capped at 8 so the
aggregates always fit (checked by token count; any truncated state is reported).

## Laya: model, questions and decision score

- Runtime `@receptron/laya` (exact version pinned in `experiments/laya-triage/package-lock.json`),
  ONNX bundle `receptron/laya-onnx` pinned to a commit hash (revision recorded with the sha256 of
  `laya.onnx` and `laya.onnx.data`). Zero-shot: no fine-tuning, no prompt iteration after seeing
  outputs. CPU execution provider, default session options.
- One `systemOne` call per triaged firing with exactly these questions:
  1. `takeover` (noul): instructions "This state describes a burst of npm releases: one npm account
     published new versions of at least 5 different packages within 6 hours. Using only these facts,
     is this burst likely an unauthorized publish by an attacker with a stolen account or token (for
     example a self-spreading worm), rather than a routine release by the legitimate maintainer or
     their release automation?"; criteria true "unauthorized publish / account takeover", false
     "routine release by the maintainer or automation".
  2. `kind` (choice): `release_automation` "a release bot or monorepo publishing related packages
     together", `maintainer_sweep` "a maintainer updating many of their own packages, such as
     dependency or tooling bumps", `account_takeover` "an attacker or worm publishing with a stolen
     token".
  3. `risk` (score): ["no concern", "minor concern", "suspicious", "almost certainly malicious"].
- **Decision score = P(true) of `takeover`.** `kind` and `risk` are recorded and reported
  descriptively only; they make no decision.

## Split and threshold rule

- Controls are the proof's 11 control accounts. Split by sha256(account name) in hex, ascending:
  the first 5 are **calibration**, the other 6 are **test** (at least half held out). That gives
  calibration = cwmma, ljharb, isaacs, types, aws-sdk-bot; test = oss-bot, sindresorhus, wooorm,
  microsoft1es, xtuc, GitHub Actions.
- All 26 incident accounts are test only; no incident outcome is used to choose anything.
- **Threshold**: an alert passes triage when score ≥ τ. τ is the smallest value among the
  calibration triaged firings' scores (plus 1.0, plus +∞ meaning "never") for which the calibration
  false-alarm rate is ≤ 0.1 per account-month. Chosen once, on calibration controls only.

## Plain-rules baseline (same state, no threshold, no tuning)

Pass triage when **either**: at least one package in the window has `publisher_new_to_package`
(the account never published an earlier recorded version of it), **or** at least half of the
packages in the window are `dormant_over_90d`. (This stands in for "new publisher OR provenance
dropped OR install script added", using only the fields that exist symmetrically; see above.)

## Pass rule (held-out data)

For each triage method (Laya, baseline), on the 6 test controls and all incident accounts:

- (a) false alarms ≤ 0.1 per test-control account-month, **and**
- (b) qix still warned before T0 (lead > 0), **and**
- (c) ≥ 80 % of the 25 Shai-Hulud accounts still warned before T0 (≥ 20 of 25).

**The experiment passes** only if Laya meets (a), (b) and (c). Laya is **worth the dependency**
only if it passes **and** the baseline either fails or has a higher test false-alarm rate with no
more incident warnings than Laya. Both are reported whatever they show.

## Also reported (descriptive, no decision)

- No-triage numbers on the same split (calibration / test) at the triage cadence.
- Laya and baseline false alarms on the calibration controls; per-control episodes.
- Score distributions for control vs incident triage points; ROC AUC of the Laya score over
  triaged firings (controls vs qualifying incident firings).
- qix firings outside 2025-09-08 (as in the proof) under each method.
- Latency per `systemOne` call (median, p95, wall clock, after a warm-up call), model load time,
  RSS after load and peak RSS, CPU model and core count, disk size of the bundle.

## Outputs

`experiments/laya-triage/` (own package.json, not imported by product code):
`build-states.ts` builds the states, `run-laya.ts` runs the model and writes per-firing scores to
`results/laya-scores.csv` (committed), `evaluate.ts` applies the threshold rule, baseline and pass
rule offline from that file and writes `results/report.json`/`.md`. If the model cannot be
downloaded or does not fit the machine, the experiment stops and reports exactly that.
