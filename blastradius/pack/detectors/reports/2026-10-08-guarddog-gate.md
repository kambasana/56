# GuardDog adoption gate: FAIL (noise)

Step 3 of docs/FEEDS-AND-DETECTORS.md. Run 2026-10-08. GuardDog 3.2.0 (Apache-2.0, pip, kernel
sandbox on), all npm source-code rules, local tarball / zip scans. Nothing under test was installed,
imported or executed. Malware samples stayed in a /tmp scratch dir, which was deleted afterwards.

**Verdict: FAIL.** Catch passes through the union. Cost passes. Noise fails badly: 7 of 8 control
repos get more than 1 added finding at medium or above (limit: ≤ 1 per repo), with a mean of 5.5 per
repo. The rule subset chosen on the dev half also fails on the holdout controls (5 of 6 over the
limit). Do not wire GuardDog into findings. See "What next".

| Gate (§3) | Needed | Result | |
|---|---|---|---|
| 1. Catch | GuardDog flags more bad releases than our signals, or the union is higher | On 1,439 Datadog compromised samples: GuardDog medium+ 86.2% vs ours 94.3% (any finding) / 80.9% (medium+). Union **99.4%**. Replay set: union 12/16 vs 11/16. | pass (union only) |
| 2. Noise | ≤ 1 added medium+ finding per control repo | 1, 3, 4, 4, 6, 7, 9, 10 per repo (mean 5.5) | **FAIL** |
| 3. Cost | scans only new/changed versions within a per-scan budget | 0.55 s mean per version; real lockfile commits add a median of 1 to 5 versions | pass |

## Pre-registered mapping (committed before any malware was scanned)

The mapping is in `pack/detectors/guarddog/PREREGISTRATION.md`, commit 482a0bb, pushed before the
first catch scan. We used GuardDog's own package label and set no rule weights of our own:

| GuardDog label (its score 0–10) | Our severity |
|---|---|
| `high_risk` (≥ 7) | high (M2) |
| `suspicious` (5–6.9) | medium (M1, the gate level) |
| `low` (> 0, < 5) | low (M3; never shown, not counted as noise) |
| `no_risks_detected` | none |

Each GuardDog 3.2.0 rule has its own `severity` / `specificity` metadata (YARA `meta`). GuardDog
pairs each threat with a capability to form a "risk" and then scores the package. We did not change
any of this. The mapping was not tuned. The only tuning was the rule subset below, which was chosen
on the dev half and measured on the holdout.

Metadata rules (`provenance_regression`, `risky_new_dependency`, `typosquatting`, …) were **not**
run. They need registry metadata, which npm has deleted for removed bad versions, so the catch side
could not run them. To keep the two sides symmetric, both ran source-code rules only.

## Data

- **Catch, gating:** all 1,443 `samples/npm/compromised_lib` zips in
  DataDog/malicious-software-packages-dataset at commit `df32a361` (2026-10-08). 2 crashed GuardDog
  (no JSON output: `@redhat-cloud-services/hcc-feo-mcp@0.3.1`, `compare-obj@1.1.2`), which leaves
  1,441 scored. Split by sha256(name@version): dev 719, holdout 722.
- **Replay incidents with a sample:** only **2 of 16**, `debug@4.4.2` and
  `eslint-config-prettier@8.10.1`. The dataset has no samples for event-stream, flatmap-stream,
  ua-parser-js, coa, rc, node-ipc 9.2.2/10.1.x, chalk 5.6.1, eslint-config-prettier 10.1.6 or the
  nx releases (some names are in the manifest without a zip). GuardDog cannot be scored on the
  other 14.
- **Catch, reported only:** 1,457 `malicious_intent` samples, the deterministic 1/16 slice whose
  sha256(name@version) starts with `0`.
- **Backstabber's Knife Collection:** out of scope. Its samples need an access request from an
  institutional address, which we have not made.
- **Noise:** every registry version in the lockfiles of microsoft/TypeScript@de61e6962143,
  mochajs/mocha@a9fc52968316 and the 6 replay org repos (test/replay/data/org). That is 2,983 unique
  name@version. We **scanned all of them**, with no sampling. We excluded 10 known-bad versions found
  in those lockfiles (the replay incidents plus the qix wave: ansi-regex@6.2.1, ansi-styles@6.2.2,
  error-ex@1.3.3, strip-ansi@7.1.1, …). `colors@1.4.2` returned 404 from the registry (npm removed
  it), so 2,972 versions were scanned.
- **Our engine on the same samples:** `engine-score.ts` runs the replay proof's method: a probe
  project scanned at release + 1 h against the replay server, using only the packument Datadog stored
  with each sample (no code is read). 1,441 of 1,443 samples had metadata and all 1,441 were scored.

## 1. Catch

### Datadog npm compromised samples (gating)

| Set | n | any risk (low+) | **medium+ (M1)** | high (M2) |
|---|---|---|---|---|
| compromised: all | 1441 | 93.9% | **86.1%** (1241) | 77.4% |
| dev half | 719 | 93.6% | 87.1% | 78.9% |
| holdout half | 722 | 94.2% | 85.2% | 76.0% |
| malicious_intent 1/16 (not gating) | 1457 | 85.2% | 79.2% | 69.5% |

### Head to head on the 1,439 samples both can score

| Detector | Flagged |
|---|---|
| Ours, any finding at release + 1 h (the proof's definition of early warning) | 1357 (94.3%) |
| Ours, medium or above | 1164 (80.9%) |
| GuardDog M1 (medium+) | 1240 (86.2%) |
| GuardDog M2 (high) | 1115 (77.5%) |
| **Union: ours any or GuardDog M1** | **1430 (99.4%)** |
| Union: ours medium+ or GuardDog M1 | 1426 (99.1%) |
| GuardDog M1 only (ours silent) | 73 (5.1%): 40 in the 2026-06 wave, 28 in 2025-09, 5 in 2025-04 |
| Ours only (GuardDog below M1) | 190 (13.2%) |
| Neither | 9 (0.6%) |

By discovery month (the campaign waves dominate: 2025-09 and 2025-11, both Shai-Hulud, are 857 of 1,441):

| Month | n | GuardDog M1 | ours any | ours medium+ | union |
|---|---|---|---|---|---|
| 2024-12 | 11 | 11 | 11 | 11 | 11 |
| 2025-03 | 1 | 0 | 0 | 0 | 0 |
| 2025-04 | 5 | 5 | 0 | 0 | 5 |
| 2025-06 | 19 | 18 | 18 | 18 | 18 |
| 2025-07 | 21 | 17 | 21 | 19 | 21 |
| 2025-08 | 7 | 7 | 7 | 7 | 7 |
| 2025-09 | 410 | 410 | 382 | 234 | 410 |
| 2025-11 | 447 | 447 | 447 | 417 | 447 |
| 2025-12 / 2026-02 | 2 | 2 | 2 | 2 | 2 |
| 2026-03 | 88 | 86 | 87 | 82 | 87 |
| 2026-04 | 28 | 17 | 22 | 18 | 23 |
| 2026-05 | 224 | 157 | 222 | 218 | 222 |
| 2026-06 | 178 | 64 | 138 | 138 | 178 |

### Replay incidents (16 bad releases)

| Bad release | GuardDog | Ours at release + 1 h |
|---|---|---|
| debug@4.4.2 | **high_risk 7.2** (threat-runtime-obfuscation-js-mangling) | no finding |
| eslint-config-prettier@8.10.1 | suspicious 5.5 (threat-process-hooks) | medium: install_script |
| other 14 | no sample: cannot be scored | 10 of 14 flagged |

Replay early warning: ours 11/16; **union 12/16** (GuardDog adds debug@4.4.2). GuardDog alone could
reach at most 2/16, because the other 14 bad releases have no code left to scan anywhere.

### Caveats on catch (all of them make GuardDog look better)

- **Selection bias.** Datadog's README says the dataset "was mostly identified by a single ruleset
  (GuardDog)". GuardDog's catch rate on it is therefore an upper bound. The 73 GuardDog-only samples
  are the part most exposed to this bias.
- **Clustered.** Two worm waves are 59% of the samples, and their payloads are near-identical, so
  the effective sample count is far below 1,441.
- **Our engine's 94.3% counts low findings**, as the replay proof does. At medium+, ours is 80.9% and
  GuardDog is 86.2%. The packuments are as Datadog captured them at discovery. The replay server
  hides versions after the clock, but top-level `maintainers` is a snapshot, so
  `maintainer_change` may carry some hindsight.

Most-frequent rules forming risks on compromised samples: threat-process-hooks 992,
obfuscation-base64exec 859, process-download-exec 856, runtime-environment-read 820,
obfuscation-js-mangling 692, npm-preinstall-script 635, filesystem-read 619 (full table:
`results/compromised-full.csv` and `analyze.py` output).

## 2. Noise: FAIL

Added GuardDog findings per control repo, over the exact versions in each lockfile:

| Control repo | versions | low+ | **medium+ (gate)** | high | medium+ among direct deps |
|---|---|---|---|---|---|
| microsoft/TypeScript@de61e6962143 | 239 | 9 | **4** | 2 | 0 |
| mochajs/mocha@a9fc52968316 | 715 | 23 | **9** | 4 | 2 |
| Esger/Pentominos2 | 933 | 27 | **7** | 4 | 1 |
| Esri/a11y-map | 266 | 21 | **6** | 3 | 1 |
| FinnLeh/vs-code-obsidian | 383 | 4 | **1** | 0 | 1 |
| davglass/registry-static | 273 | 24 | **4** | 2 | 1 |
| project-qwerty/project-qwerty | 930 | 37 | **10** | 3 | 2 |
| telefonicaid/logops | 418 | 12 | **3** | 2 | 2 |

36 distinct benign versions reach medium+ (1.2% of the versions scanned), and 18 of them are
`high_risk`. Even at "high only" (M2), 6 of 8 repos exceed 1. Examples include terser, prettier,
typescript@4.5.4, rxjs@5.5.12, playwright-core, @azure/msal-browser, node-forge, jshint, requirejs,
esbuild, core-js, fsevents, psl and mocha@6.2.3 itself. The full list is in
`results/noise-flagged-full.csv`.

### Noisy rules (distinct benign versions at medium+ that carry a risk from the rule)

| Rule | benign medium+ | benign low+ | compromised samples with it |
|---|---|---|---|
| threat-runtime-obfuscation | 12 | 26 | 251 |
| threat-process-hooks | 10 | 10 | 992 |
| threat-runtime-obfuscation-base64exec | 6 | 6 | 859 |
| threat-runtime-obfuscation-log-suppress | 5 | 5 | 6 |
| threat-filesystem-read | 4 | 17 | 619 |
| threat-process-download-exec | 4 | 4 | 856 |
| threat-npm-http-dependency | 3 | 45 | 7 |
| threat-network-outbound-shady-links | 3 | 3 | 419 |
| threat-runtime-environment-read | 2 | 11 | 820 |
| threat-filesystem-autostart | 2 | 2 | 460 |
| threat-runtime-obfuscation-hidden-code | 2 | 2 | 19 |
| threat-runtime-enumeration | 2 | 2 | 16 |
| threat-runtime-obfuscation-steganography | 2 | 2 | 10 |
| obfuscation-unicode, system-info, spawn-silent, obfuscation-general, obfuscation-dynamic-eval, process-memory | 1 each | | |

The noisy rules overlap heavily with the rules that do the catching (hooks, base64exec,
download-exec). Any `postinstall` (esbuild, fsevents, core-js) or a minified bundle (terser,
prettier, playwright) is enough to reach medium+.

### Rule-subset check (dev → holdout), as pre-registered

`subset.py` chose the exclusions greedily, using only dev data (compromised dev half, TypeScript and
mocha). It excluded: filesystem-read, network-outbound-shady-links, npm-http-dependency,
process-download-exec, process-hooks, process-memory, runtime-obfuscation,
runtime-obfuscation-base64exec, runtime-obfuscation-steganography. We then rescanned exactly with
GuardDog `-x`:

| | Dev | **Holdout** |
|---|---|---|
| Compromised caught at M1 | 80.3% | 78.0% |
| Control repos at medium+ | TypeScript 1, mocha 1 (pass) | Pentominos2 **4**, a11y-map **2**, registry-static **2**, project-qwerty **3**, logops **2**, vs-code-obsidian 0 → **FAIL (5 of 6)** |

With the subset, the union with ours stays 99.4%. The remaining noise comes from
obfuscation-log-suppress (5 versions), obfuscation-hidden-code, filesystem-autostart (mocha@6.2.3),
runtime-enumeration and obfuscation-dynamic-eval. **No subset passes.** A narrower subset that also
drops those rules would be tuned on every control we have. It is only a hypothesis, and it would need
fresh control repos and fresh samples before anyone treats it as a pass. It would also give up the
debug@4.4.2 catch, whose only rule (js-mangling) did not fire on any control.

## 3. Cost: pass

| Measure | Value |
|---|---|
| Per benign tarball, sequential, 200 deterministic versions (download excluded) | mean 0.55 s, median 0.40 s, p95 1.17 s, max 6.2 s |
| Per benign tarball, 6 parallel scans on 4 cores, all 2,972 | median 0.73 s, p95 1.47 s, max 36.6 s |
| Per compromised sample (large worm bundles) | median 3.3 s, p95 9.9 s, max 82.5 s |
| New versions per lockfile commit, mocha (last 30 commits) | median 1, p90 27, max 49 → ≤ 30 s sequential |
| New versions per lockfile commit, TypeScript (last 30 commits) | median 5, p90 118, max 349 → ≈ 3.2 min sequential, < 1 min with 4 workers |
| Full first scan of one lockfile (mocha, 715 versions) | ≈ 6.5 min sequential |

A diff-only scan with a per-scan budget (say 60 s, overflow queued) is affordable. Noise also
scales with the diff: at 1.2% per version, mocha's last 30 lockfile commits (228 new versions) would
have produced about 3 medium+ findings, and TypeScript's (1,273 new versions) about 15, all of them
on benign code.

## What next

1. **Do not ship GuardDog as a finding source** (step 4 is blocked). It catches a real gap. The
   union rises from 94.3% to 99.4% on the samples, and debug@4.4.2 is caught when our signals saw
   nothing. But at medium+ it adds 1 to 10 false findings per repo, against a limit of 1.
2. A design to test next, as a new pre-registered gate rather than a rescue of this one: use
   GuardDog only as **evidence on a version that one of our signals already flags**, or only on
   **diff-new versions whose previous version scored clean**. Score the delta and not the package,
   so that esbuild's long-standing postinstall stops counting. This needs fresh controls.
3. Report the 2 GuardDog crashes upstream if we come back to it.

## Reproduce

Scripts are in `pack/detectors/guarddog/`. Run with `python3 -I` from a venv that has
`guarddog==3.2.0`.
`noise_set.py` → `make_targets.py` → `scan.py` (catch and noise) → `extract_meta.py` →
`npx tsx pack/detectors/guarddog/engine-score.ts` → `analyze.py` → `subset.py` → `scan.py --exclude`
→ `analyze.py --tag subset`; `lockfile_diffs.py` for the diff sizes. Committed tables are in
`pack/detectors/guarddog/results/`: rule names, labels and scores only, never matched code.
