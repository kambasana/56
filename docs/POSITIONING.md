# Positioning: what Blastradius is, and what is proven

**Written 2026-10-09.** This replaces the positioning in [PLAN.md](PLAN.md) §1 and the "overlap with
commercial tools" row in §9. Every number below comes from a report or test in this repository. The
file is cited next to it. Some files live on other branches; the branch is named in brackets.
Anything from a gate that failed is marked **not proven**.

## 1. What we are

Blastradius tells you three things about your repos:

1. **Who is behind** each dependency: the npm accounts that can publish it, the repo owner, and
   their orgs and funders.
2. **Any issues**: known-bad releases and pre-advisory signals, taken from feeds and detectors.
3. **Risk by your repo**: which projects are hit, production or dev, and who brought it in.

The unit we add is the **account**. Feeds and scanners speak in packages and versions. We answer
"this account is compromised: what of ours can it reach?" across the whole estate, without a re-scan.

## 2. What we reuse (inputs, not competitors)

Scanners and feeds feed us. We do not rebuild them.

| Input | What it gives us | Where it is described |
|---|---|---|
| OSV (incl. OpenSSF malicious-packages `MAL-*`, GitHub advisories with CWE-506) | known-bad releases and vulnerabilities | [FEEDS-AND-DETECTORS.md](FEEDS-AND-DETECTORS.md) §2.1 |
| Datadog malicious-software-packages-dataset (manifest) | extra known-bad labels | FEEDS-AND-DETECTORS.md §2.1 |
| Backstabber's Knife Collection (name list only) | extra known-bad names | FEEDS-AND-DETECTORS.md §2.1 |
| CISA KEV, FIRST EPSS | exploitability | FEEDS-AND-DETECTORS.md §2.1 |
| npm packuments | publishers, maintainers, publish times | [NEXT-LEVEL.md](NEXT-LEVEL.md), [DATA-ML.md](DATA-ML.md) §4 |
| Syft (optional, `--syft`) | extra SBOM components | `blastradius/src/ingest/README.md` |
| GuardDog, OpenSSF package-analysis | candidate pre-advisory detectors, behind a gate | FEEDS-AND-DETECTORS.md §3 |

Trivy-class scanners are inputs of the same kind. We use the same feed method as osv-scanner,
Grype and Trivy databases (FEEDS-AND-DETECTORS.md §2). Trivy itself is not adopted today, because
its own releases were compromised in March 2026 (DATA-ML.md §4, "Not adopted").

## 3. What is unique to us, and what is proven

### 3.1 Account compromise to estate (proven for multi-package takeovers)

Source: `docs/ACCOUNT-PROOF.md` [proof/account-level], pre-registered in
`blastradius/test/replay/account/PREREGISTRATION.md` [proof/account-level].

Four recorded incidents were replayed. Each is one row; no single incident family carries the
result.

| Incident | Bad packages named early | Median gain | Precision | Org exposures named (vs advisories) | Result |
|---|---|---|---|---|---|
| chalk/debug 2025 (account qix) | 19 vs 1 | 2.7 h (max 6.4 h) | 1 | 204 (vs 21) | pass |
| event-stream 2018 (account right9ctrl) | 2 vs 2 | 0 h | 1 | 2 (vs 2) | fail |
| Shai-Hulud wave 1, 2025-09 (13 accounts with ≥ 2 bad packages) | 37 | 0 h | 0.568 | 0 | fail |
| Shai-Hulud wave 2, 2025-11 (39 accounts with ≥ 2 bad packages) | 245 | 1.3 h | 0.369 | 0 | pass |

- **Macro view** (each incident counted once; arithmetic on the rows above, not a pre-registered
  metric): passes in 2 of 4 incidents; unweighted mean of the per-incident median gains 1.0 h;
  unweighted mean precision 0.734.
- Clearest case, chalk/debug: at the first advisory only 1 advisory existed, and "qix is
  compromised" named all 19 bad packages at once and all 21 locked bad versions (advisories then
  covered 1).
- No recorded project used a Shai-Hulud package, so the org-level evidence comes from chalk/debug
  and event-stream; the Shai-Hulud rows are package-level only.
- Four incidents is a small set, and two are waves of one family.

**What this means.** The account query earns its place for multi-package takeovers. It does not help
for single-package ones. For multi-account campaigns, precision is low, because an account's other
packages are not all bad.

**Caveats** (all from ACCOUNT-PROOF.md):

- npm deleted the bad versions and their publisher. A publisher is attributed only when the
  previous version had one maintainer. 389 of 589 wave-1 and 682 of 1,122 wave-2 bad versions
  have no publisher and are excluded.
- "Can publish at time T" uses the maintainers on the latest version at or before T. An owner added
  without a later publish is invisible.
- Account package lists are today's lists. For 21 of 103 accounts npm answered 429, so a registry
  search was used, which undercounts.
- The exposure repos were found by searching GitHub for `chalk-5.6.1.tgz` in a lockfile. That
  inflates version-level hits, not the package-level comparison.

### 3.2 The same answer in the product (proven, with one gap)

Source: `blastradius/test/replay/account/product-parity.test.ts` [feature/account-index] and the
"In the product" section of `docs/ACCOUNT-PROOF.md` [feature/account-index].

- The product's own index and API replay the chalk/debug data offline.
- They name the same 204 exposures (21 by advisories, precision 1.0).
- With qix's package list rebuilt for the incident time, they name all 19 bad packages.
- With qix's list as npm serves it today, they name 18 of 19. chalk-template changed owner after
  the incident. The test pins both results.
- The 19 of 19 result uses the proof's own rule to rebuild the list, so it is partly circular.

**Gap: no publisher means no Critical.** On this data, "Mark as compromised" with the attack day as
"published since" makes every alert High and none Critical. All 21 locked bad versions have no
recorded publisher (npm deleted them), and the product never guesses one. The test pins this.

### 3.3 Concentration (descriptive, not a claim of value yet)

Source: `docs/ACCOUNT-PROOF.md` [proof/account-level], H3.

- Each recorded project depends on 45 to 234 publishing accounts.
- The top account can publish 9% to 27% of a project's packages. Usually sindresorhus, ljharb or
  jonschlinkert.
- This is a description. No gate tested whether it changes a decision.
- The product's concentration view [feature/account-index] uses current maintainers only. It has
  not been compared with this table.

### 3.4 Known-bad to estate, fast (proven on replay)

Source: [PROOF.md](PROOF.md), enforced by `blastradius/test/replay/proof.test.ts`.

- 16 bad releases from 7 incidents were replayed.
- 15 of 15 are Critical once an advisory exists. node-ipc 9.2.2 has no advisory.
- 11 of 16 got an early finding before any advisory.
- Org exposure came from stored inventories, with no re-scan, in 10.6 ms or less per incident.

This part is **not unique**. Matching known-bad releases to repos is what GitHub and Snyk already
offer (see §5). It is table stakes. It is the base the account answer stands on.

## 4. What failed, and what it means

| Attempt | Result | Source | Status |
|---|---|---|---|
| Own model, local run (2026-10-07) | held-out recall 0% vs rules 66.7% | `blastradius/pack/model/reports/2026-10-07-local.md` [data-ml/model] | **not proven** |
| Own model, full gate (2026-10-08) | 16/100 vs rules 27/100 caught; 22.5 vs 11.0 findings per control repo on scan day | `blastradius/pack/model/reports/2026-10-08-gate.md` [data-ml/model] | **not proven** |
| GuardDog as a finding source | noise: 7 of 8 control repos over the limit of 1, mean 5.5 per repo. Catch passed only as a union (99.4% on 1,439 Datadog samples; 12 vs 11 of 16 on replay). | `blastradius/pack/detectors/reports/2026-10-08-guarddog-gate.md` [detectors/guarddog-proof-clean] | **not proven** |
| Account burst rule as an alert | warns before the first advisory in 3 of 4 incidents (26 of 27 incident accounts; qix 1.1 h early; event-stream never fires), but 2.095 false alarms per control account-month against a limit of 0.1. It fails on noise, not on any incident. | `docs/ACCOUNT-PROOF.md` [proof/account-level], H2 | **not proven** |
| Laya, zero-shot, on account bursts | 0.427 false alarms per account-month (limit 0.1); warned qix (1.1 h) and 13 of the 25 incident accounts other than qix (gate needed 20; all 25 were Shai-Hulud). Plain-rules baseline: 1.707 and 18 of 25. | `docs/LAYA-TRIAGE.md` [proof/laya-triage] | **not yet tested as designed** (see below) |

What it means:

- **We do not predict the next compromise.** Two model runs lost to plain rules. npm deletes the
  code of bad releases, so metadata alone was not enough (FEEDS-AND-DETECTORS.md).
- **Detection that reads code is a crowded field.** GuardDog catches a lot, but it is too noisy on
  normal lockfiles to show as findings. We keep it out of findings.
- **A burst of releases is not a takeover signal on its own.** Monorepos and prolific maintainers
  look the same as a takeover. The burst is one of many signals feeding triage (with advisories,
  malware feeds and the per-release signals in FEEDS-AND-DETECTORS.md). It stays context on the
  Account page, not an alert.
- **Laya: not yet tested as designed, so no final verdict.** The run above used the base English
  checkpoint zero-shot, with every state truncated at its 512-token limit, an uncalibrated score,
  only the burst signal, and a recall gate made of one incident family. Laya's own docs say base
  checkpoints are near chance zero-shot on new decision tasks and that the value comes from
  fine-tuning on your own labelled decisions, with temperatures calibrated on held-out data and
  adoption in stages (shadow first). The FAIL stands only for "zero-shot Laya does not triage
  account bursts". The redesign, fine-tuned on release triage across all our signals, scored per
  incident family and macro-averaged, against a tabular baseline, is in `docs/LAYA-USAGE.md`
  [research/laya-proper].
- **Our value is the answer after the first signal**, not the first signal itself.

## 5. How we differ from GitHub, Snyk and Socket

We only state what we could source on 2026-10-09.

| Tool | What we could source | Source |
|---|---|---|
| GitHub Dependabot | Since 2026-03-17 it alerts when a repo depends on npm packages with known malicious versions, matched against malware advisories in the GitHub Advisory Database. Opt-in, per repo, org or enterprise. | github.blog/changelog/2026-03-17-dependabot-now-detects-malware-in-npm-dependencies |
| Snyk | Its Security Research team monitors several sources daily to find and verify malicious packages, which Snyk then reports in projects. | docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/malicious-packages |
| Socket | Its data is proprietary (DATA-ML.md §4). We could not read its docs from this environment (socket.dev answered 403), so we make no claim about its features. | DATA-ML.md §4 |

What follows from this:

- **Known-bad matching is built into GitHub Dependabot** (opt-in, per the changelog above; the pages we
  read do not state its price). We do not charge for it on its own. It is an input we show.
- **Both GitHub and Snyk are package- and version-keyed** in the sources above. We have not found a
  source saying either answers "this account is compromised: what in our estate can it publish?".
  That is what we claim. We have not proven that no paid tool does it.
- **We are open and explainable.** Every alert names its source, and the proofs replay offline in CI.
- Before claiming more, we need a sourced check of Socket's account and maintainer features.

## 6. What is next

1. **Prove the account answer on more multi-package takeovers from other families**, not just
   chalk/debug and one Shai-Hulud wave. Report per incident and macro-averaged.
2. **Record publishers live.** A watcher sees `_npmUser` before npm deletes it. That closes the
   "no publisher, no Critical" gap (§3.2) and the unattributed versions in multi-account campaigns
   such as the Shai-Hulud waves (§3.1).
3. **Concentration as of a date**, compared with the H3 table, and tested on whether it changes a
   decision. Until then it stays descriptive.
4. **Feeds sync** as in FEEDS-AND-DETECTORS.md §5: incremental OSV, the pack with `listing.json`,
   and freshness measured end to end.
5. **A sourced comparison with Socket.**
6. **Laya as designed, in shadow only**: fine-tune, calibrate and compare against a tabular baseline
   as in `docs/LAYA-USAGE.md` [research/laya-proper]. It informs triage, never alerts, until its own
   pre-registered, family-macro gate passes.

Not on the list: our own prediction model, GuardDog findings, and burst alerts. Each one failed
its gate (§4). Laya is not in that group: it has not been tested as designed yet. They come back only with a new pre-registered gate.
