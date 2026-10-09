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

### 3.1 Account compromise to estate (proven on one incident type)

Source: `docs/ACCOUNT-PROOF.md` [proof/account-level], pre-registered in
`blastradius/test/replay/account/PREREGISTRATION.md` [proof/account-level].

- **chalk/debug 2025 (account qix): pass.** At the first advisory, 1 advisory existed. "qix is
  compromised" named all 19 bad packages at once.
- It named them a median of 2.7 h, and up to 6.4 h, before their own advisories.
- Across the recorded orgs it named 204 package-level exposures, against 21 from advisories.
  Precision was 1.
- It named all 21 locked bad versions. Advisories at that time covered 1.
- **event-stream 2018: fail.** 2 vs 2 packages, 0 h gained. A one-package takeover gains nothing.
- **Shai-Hulud wave 1: fail.** 37 packages named early, median gain 0 h, precision 0.568.
- **Shai-Hulud wave 2: pass.** 245 packages named early, median gain 1.3 h, precision 0.369.
  No recorded project used a Shai-Hulud package, so this is package-level only.

**What this means.** The account query earns its place for multi-package takeovers. It does not help
for single-package ones. For worms, precision is low, because an account's other packages are not
all bad.

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
| Account burst rule as an alert | warns qix 1.1 h early and 25 of 25 qualifying Shai-Hulud accounts, but 2.095 false alarms per control account-month against a limit of 0.1 | `docs/ACCOUNT-PROOF.md` [proof/account-level], H2 | **not proven** |
| Laya zero-shot triage of bursts | 0.427 false alarms per account-month (limit 0.1); 13 of 25 Shai-Hulud warnings (need 20). Plain-rules baseline: 1.707 and 18 of 25. | `docs/LAYA-TRIAGE.md` [proof/laya-triage] | **not proven** |

What it means:

- **We do not predict the next compromise.** Two model runs lost to plain rules. npm deletes the
  code of bad releases, so metadata alone was not enough (FEEDS-AND-DETECTORS.md).
- **Detection that reads code is a crowded field.** GuardDog catches a lot, but it is too noisy on
  normal lockfiles to show as findings. We keep it out of findings.
- **A burst of releases is not a takeover signal on its own.** Monorepos and prolific maintainers
  look the same as a worm. A 1.7 GB model on top did not fix it. The burst stays context on the
  Account page, not an alert.
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

1. **Prove the account answer on a second multi-package takeover**, not just chalk/debug. One pass
   is one data point.
2. **Record publishers live.** A watcher sees `_npmUser` before npm deletes it. That closes the
   "no publisher, no Critical" gap (§3.2) and the unattributed Shai-Hulud versions (§3.1).
3. **Concentration as of a date**, compared with the H3 table, and tested on whether it changes a
   decision. Until then it stays descriptive.
4. **Feeds sync** as in FEEDS-AND-DETECTORS.md §5: incremental OSV, the pack with `listing.json`,
   and freshness measured end to end.
5. **A sourced comparison with Socket.**

Not on the list: our own prediction model, GuardDog findings, and burst alerts. Each one failed
its gate (§4). They come back only with a new pre-registered gate.
