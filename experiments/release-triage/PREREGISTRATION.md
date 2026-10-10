# Pre-registration: fine-tuned Laya for npm release triage, against tabular and text baselines

Written and committed **before any Laya model has been run on this dataset**, and before any baseline
metric on it exists (2026-10-09). At the time of writing the negative releases were still being
fetched, so no split, no baseline score and no Laya output existed. The checkpoints, runs, threshold
rule, metrics and pass rule below are fixed. Anything changed afterwards goes in the report under
"Deviations from the pre-registration", with the reason.

Background: [docs/LAYA-USAGE.md](../../docs/LAYA-USAGE.md) covers how Laya's authors say it should be
used, an audit of the earlier zero-shot burst experiment, and the design this test follows. The
earlier experiment ([docs/LAYA-TRIAGE.md](../../docs/LAYA-TRIAGE.md)) failed. But it ran Laya
zero-shot on 512-token-truncated burst counts, uncalibrated, with a recall gate built on one incident
family. This test runs Laya the way its documentation prescribes.

**Shai-Hulud is one incident family among many.** No gate, headline or metric here names or depends on
any single family. Every recall figure is a macro average over families, and the pass rule includes a
check that no single family drives the result.

## Question

On first malicious releases from many incident families, and on real benign releases from the same
months, does **fine-tuned** Laya (`laya-train`, the authors' recipe) find more malicious releases than
the best cheap baseline at the same alert budget? The baselines are the product's rule scorer, logistic
regression, gradient-boosted trees, and TF-IDF on the same text Laya reads. The win must be large
enough, and spread across enough families, to justify a 1.7 GB model dependency.

## What had been looked at before writing this

- Laya's documentation, source (`laya` 0.4.1 on PyPI, identical to github.com/NandhaKishorM/laya @
  `1adc59f7` for `train.py`, `train_cli.py`, `evals.py`, `evals_cli.py`, `common.py` and `agent.py`)
  and the Kaggle fine-tuning notebook. Also receptron/laya @ `6478649e` (`export/export_onnx.py`) and
  the file list and `rl_agent_config.json` of `convaiinnovations/laya` @ `7b928d82`: English
  `max_len` 512 / `head_max_len` 192; typed-decisions 1024 / 256.
- The dataset code in `src/` and the positive candidates: 1,431 packages, of which 1,173 have a usable
  record (by category: hijack 498, new_malicious 515, spam 159, sabotage 1). Their per-family counts
  are in `data/positive_candidates.summary.json`.
- Nothing else. No negative record, split, feature table, leakage check, token count or baseline
  score existed for this dataset, and no Laya checkpoint had been loaded or run on any of its states.

## Data (fixed by `src/`, run by `rebuild.sh`)

*The dataset was rebuilt before any Laya run (v2, 2026-10-10): more real positives and negatives, a ratio floor in
the splits, and a hindsight fix in the dependency-age feature. The rules below still hold; every change is listed,
with its reason, in the log at the end.*

- **Unit:** one npm release (package@version) as it stood at publish time.
- **Positives:** the first malicious release per package in the DataDog dataset and OSV `MAL-*` /
  CWE-506 records, with the published files from DataDog's archive and the registry document DataDog
  captured. One release per package, so a worm's later releases do not dominate.
- **Negatives:** real releases of packages not listed as malicious anywhere we know, drawn by month to
  follow the positives (5 per positive, at least 40 per month, 40 % first releases). Files come from
  the registry tarball.
- **Same treatment for both classes:** facts as of publish time; same fields from the same kinds of
  source; release dropped if its previous release is no longer served.
- **State:** the JSON object built by `src/build.py`:
  - release cadence and version facts;
  - publisher and maintainer changes;
  - provenance;
  - install-hook commands, current and previous;
  - dependency changes and young dependencies;
  - contents and size changes;
  - repository and metadata changes;
  - bounded text: install-script file heads, new file paths, description, README head.

  Package and account names are replaced by `<name>`.
- **Splits (`src/split.py`):** by time, with train before 2025-10-01, calib from 2025-10-01 to before
  2026-03-01, and test from 2026-03-01. Packages and accounts are grouped into connected components, so
  none appears in two splits. In every split no family exceeds 25 % of the positives.
- **Questions (`data/questions.json`):**
  - `triage`: a choice between `routine`, `review` and `likely_malicious`. The expected answer is
    `likely_malicious` for positives and `routine` for negatives. `review` has no labels yet, since it
    needs human adjudication (LAYA-USAGE 3.1).
  - `script_intent`: a noul with labels `A`/`B`. It is asked only where install-script text is shown
    and the label is clear.
- **Validity checks, run before any Laya run:**
  - `src/leakage_check.py` must pass.
  - The test split must hold at least **6 families with ≥ 5 positives** each. Otherwise per-family
    results are too thin, the comparison is reported as underpowered, and Laya is not adopted.

## Methods

Every method gets the same splits, the same calibration and threshold rule, and the same metrics
code (`src/triage_metrics.py`). No method gets hyperparameter tuning beyond what is written here.

### Baselines (`src/baselines.py`, trained on train only)

| Id | Method |
|---|---|
| B0 | Rule scorer: blastradius `packumentFacts` + `scoreIntrinsic`, default weights, no known-bad lists |
| B1 | Logistic regression on the tabular features (median impute + missing flags, standardised, C=1, class-balanced) |
| B2 | HistGradientBoosting on the tabular features (lr 0.05, 400 iterations, 31 leaves, min leaf 20, L2 1.0, class-balanced) |
| B3 | TF-IDF (word 1–2-grams, min_df 2, ≤ 200k features, sublinear tf) + logistic regression (C=1, class-balanced) on `json.dumps(state)`, the exact text Laya reads |

**Best baseline** means the one of B0–B3 with the highest test macro recall. Picking it on test favours
the baselines, so the rule is conservative toward Laya.

### Laya runs (`colab/laya_release_triage.ipynb`, one GPU)

Package versions: `laya==0.4.1`, plus the versions pinned in the notebook. The checkpoints are
downloaded from `convaiinnovations/laya` at revision `7b928d828b7b0e022f929d9bd2e44165aa270148`: the
repo root is the English checkpoint, `typed-decisions/` the typed-decisions one.

| Id | Checkpoint | Training | max_len / head_max_len | Seeds |
|---|---|---|---|---|
| Z-EN | English, zero-shot (reference only) | none | 512 / 192 (as shipped) | n/a |
| Z-TD | typed-decisions, zero-shot (reference only) | none | 1024 / 256 (as shipped) | n/a |
| F-EN | fine-tuned from English | `laya-train --loss soft-ce --shuffle-options --max-len 1024 --head-max-len 256` | 1024 / 256 | 0, 1, 2 |
| F-TD | fine-tuned from typed-decisions | same | 1024 / 256 | 0, 1, 2 |
| PC-EN, PC-TD | positive controls | same flags, seed 0, on a copy of the data where each state becomes the string `label=<expected triage answer>; ` + `json.dumps(state)` | 1024 / 256 | 0 |

Fixed training settings:

- **Training data:** `data/train.jsonl`, with `--eval data/calib.jsonl` so the training report has a
  held-out before/after.
- **Defaults kept:** loss and learning rates; laya-train's own 10 % (at most 400 items) calibration
  slice, drawn from train, for its temperatures.
- **Batch:** effective batch 64. That is micro-batch 8 × accumulation 8, or 4 × 16 on GPUs with less
  than 30 GB.
- **Epochs:** `E = min(16, max(4, ceil(600 / U)))`, where U is the number of optimizer updates per
  epoch. U is read from `laya-train --dry-run --epochs 1` on the train file before any training. This
  follows the fine-tuning guide: a small dataset needs more epochs to reach a similar update count.
- **Dry-run gate:** `laya-train --dry-run` must report **zero** `options_beyond_max_len`.
- **Truncation:** counted per checkpoint configuration with laya's own `build_sequence` truncation
  statistics on the `triage` question. Reported for every run, not gated.

Laya's decision score for a release is P(`likely_malicious`) from `triage` with the options in
canonical order. One forward pass is what a deployment would run.

### Calibration and threshold (all methods, calib split only)

- **Calibration:** Platt scaling of the method's score, fitted on calib. For Laya, ECE is also reported
  with laya-train's own temperatures (uncalibrated by us).
- **Threshold:** the lowest threshold whose alert rate on calib negatives is at most **10 alerts per
  1,000 benign releases** (`threshold_for_budget`). The test split is scored once with that threshold.
- **Choosing the shipped checkpoint, on calib only:**
  - The base (F-EN or F-TD) is the one with the higher mean calib macro recall over its non-collapsed
    seeds.
  - Within that base, the checkpoint saved to Drive and exported is the seed with the highest calib
    macro recall.
  - A seed counts as **collapsed** if laya-train warns that calibration collapsed to the class prior,
    or if its calib ROC AUC is below 0.60.

## Metrics (test split, per family and macro)

Computed by `src/triage_metrics.py:evaluate` for every method, from per-row scores:

- **Recall per family**, and **macro recall**: the mean over families, each family counting once. This
  is the primary metric.
- Macro recall without the largest test family, plus a family-bootstrap 95 % interval (2,000
  resamples, seed 20261009).
- Micro recall, precision, and alerts per 1,000 benign releases.
- False alarms per busy-account-month: benign releases alerted, divided by account-months, over
  publishers with ≥ 5 benign test releases.
- ROC AUC, average precision, and ECE (10 bins) and Brier after Platt calibration.
- Laya's own harness, `laya.evals.evaluate` (the code behind `laya-evals run`), on `test.jsonl` with
  `tag` and `qid` slices: `choice_accuracy`, `noul_accuracy`, `ece`, `brier`, `aurc`.
- **Option-order check:** every test release is re-asked `triage` with the options reversed
  (`option_order` [2, 1, 0]). Reported:
  - the share of test releases whose argmax answer changes;
  - mean |ΔP(likely_malicious)|;
  - the **alert flip rate**: among releases alerted under either order, the share alerted under only
    one, using the same calib threshold.
- **Noul label check (secondary):** `script_intent` re-asked with the default `false`/`true` labels
  instead of `A`/`B`. Reported: the answer agreement rate, and noul accuracy under both label sets.
- **Latency:**
  - GPU ms per release at batch 32 after warm-up, and checkpoint load time.
  - A CPU estimate: ms per release at batch 1 on the Colab VM's CPU, with all its cores, over 32 test
    states, recording the CPU count.
  - If exported, the same CPU figure for the ONNX fp32 graph.

  The product machine has 4 CPUs. The CPU figure is an estimate, not a measurement there.
- **Paired comparison** with the best baseline: the macro recall difference over families, a paired
  family bootstrap 95 % interval, and the difference recomputed with each family left out in turn
  (`paired_family_bootstrap`).

## Pass rule (decided before any run; evaluated on test once)

Fine-tuned Laya is **adopted (moves to shadow mode)** only if the positive control works and at least
**2 of the 3 seeds** of the chosen base meet every condition P1–P6:

- **P0, setup valid (the result is uninterpretable otherwise):**
  - the positive control of the chosen base reaches calib `triage` accuracy ≥ 0.95 and calib ROC AUC
    ≥ 0.95. Accuracy alone is not enough, because about 91 % of calib is negatives (2,931 of 3,231 releases in
    the v2 dataset; corrected 2026-10-10, see the log);
  - at least 2 of the 3 seeds are not collapsed.

  If P0 fails, the outcome is **INCONCLUSIVE**: fix the setup, and do not read the real runs as
  evidence either way.
- **P1, margin:** Laya's test macro recall ≥ best baseline's test macro recall **+ 0.05**, at the same
  10-per-1,000 calib budget.
- **P2, not luck:** the paired family-bootstrap 95 % interval of (Laya − best baseline) macro recall
  has a lower bound **> 0**.
- **P3, no single family drives it:** with any one family removed, the macro recall difference stays
  **≥ 0.025**.
- **P1–P3 co-primary (added 2026-10-10, before any Laya run; see the log):** P1, P2 and P3 must also hold on the
  macro recall over only the test families with **≥ 5 positives** (`macro_recall_min5`), against the baseline that
  is best on that macro (again picked on test). The paired bootstrap and the leave-one-family-out check use the
  same families (`paired_family_bootstrap(..., min_n=5)`). A seed meets P1–P6 only if both versions of P1–P3 hold.
- **P4, family floor:** for every test family with ≥ 5 positives, Laya's recall is no more than
  **0.15 below** the best baseline's recall on that family.
  - An absolute floor is not used: some families (for example heuristic dependency-confusion
    releases) may be missed by every method, for reasons that say nothing about Laya.
- **P5, same noise:**
  - Laya's test alerts per 1,000 benign ≤ **15**: the budget, plus room for calib-to-test drift.
  - Laya's false alarms per busy-account-month are no more than the best baseline's **+ 0.02**.
- **P6, order and calibration:**
  - the option-order alert flip rate is ≤ **0.10**;
  - Laya's Platt-calibrated test ECE is ≤ **0.10**.

If P0 holds and P1–P6 are not met by 2 of the 3 seeds, the outcome is **FAIL: Laya is not adopted**.
The tabular or text baseline that won is what to build on. The zero-shot runs Z-EN and Z-TD are
reported for reference only and cannot pass, because the authors say not to rely on zero-shot.

Out of scope here (not run, not gated):

- the stacked model (GBDT plus Laya's score) from LAYA-USAGE 3.4, which needs cross-fitted Laya scores
  on train;
- the three-way `review` accuracy, which needs a human-labelled sample;
- a facts-only arm.

If Laya fails P1 but shows signal (test ROC AUC above the best baseline's), stacking is the next test.
It would need its own pre-registration.

## If it passes: shadow-mode adoption rule (from LAYA-USAGE 3.6)

1. **Export and parity.** Export the shipped checkpoint with receptron/laya's `export/export_onnx.py`.
   Torch-vs-ONNX max |Δlogit| must be ≤ 1e-3. The calibration file travels with the graph. Re-score the
   test split through the ONNX graph: macro recall at the calib threshold must be within 0.01 of the
   torch result. Otherwise do not ship that export.
2. **Shadow only.** Run Laya behind a flag next to the rule scorer, on every scanned release that has a
   previous release, for at least **4 weeks and at least 5,000 releases**. Its output goes to the
   findings log, never to a finding the user sees. Log:
   - question-schema version, checkpoint hash and calibration hash;
   - per-option probabilities and `answer_confidence`;
   - latency and errors;
   - the incumbent's score, and the later outcome (advisory or not).
3. **Compare.** Report per family and per signal type: disagreements with the rule scorer and with the
   best baseline, with an explicit unknown bucket, and a hand-review sample of at least 50
   disagreements.
4. **Bounded promotion**, only if shadow alerts per 1,000 benign releases stay ≤ 15 and nothing in step
   3 contradicts the offline result:
   - Laya may add a capped "review" hint, at most 5 per scan, on releases whose install scripts or
     metadata text changed.
   - It never produces "critical" on its own.
   - **Rollback:** turn the hint off if its weekly alerts per 1,000 benign releases exceed 15 for two
     consecutive weeks, or if a confirmed malicious release in a family it previously caught is missed.
   - Re-evaluate on any new checkpoint, any question change, or any new incident family.

## Outputs

The notebook writes `results/` (send this folder back). Every file records the dataset commit, the
manifest sha256, package versions, the checkpoint revision and the device:

- `env.json`
- `dryrun_*.json`
- `tokens.json`
- `train_*/train_report.json`
- `scores_*.csv.gz`: per-row probabilities on calib and test, canonical and reversed order
- `evals_*.json`: laya's harness
- `metrics_*.json`: `triage_metrics.evaluate`
- `order_check.json`
- `noul_label_check.json`
- `latency.json`
- `verdict.json`
- `summary.md`

The verdict is computed by the notebook from these rules. A human then writes the report.

## Log of changes after this file was committed (fb3e3f9)

None of the changes below alters a checkpoint, run, threshold, metric or pass condition above.

- **2026-10-09: code checks on a partial dataset.** Negatives were still being fetched. The pipeline and
  the notebook's cells were run end to end on CPU as a code check, using a throwaway split with different
  dates and 16 rows per split, with the English base checkpoint standing in for fine-tuned ones. Nothing
  from those runs is a result: the numbers were discarded and none was committed.
- **2026-10-09: leakage check, content parity.** The check compared a file-only count with the
  registry's `dist.fileCount`. That count also includes directory entries when the packer wrote them into
  the tarball. This made the check FAIL for reasons that had nothing to do with reading the files.
  - Evidence: on the records fetched so far, 223 DataDog positives and 45 negatives match exactly as
    files + directories + root.
  - Positive archives that mismatch drop files of the previous release less often (6 %) than archives
    that match (20 %) or negatives (16 %).
  - Fix: the gate now accepts agreement under any of the three counting conventions. The raw file-only
    agreement is still reported, and `MAX_GAP` is unchanged.

## Deviations logged 2026-10-10 (dataset v2), before any Laya run

No Laya model had been run on this dataset, in any form, when these were made. The baseline numbers of v1 had been
seen (they were committed with v1); none of the changes below was chosen to move a baseline, and the time windows,
the 25 % family cap, the questions, the methods, the threshold rule and P0–P6 are unchanged except where stated.
The user's bars for the dataset were: only real rows, each traceable to an OSV/GHSA id, a DataDog archive (sha256)
or an npm registry record; ≥ 5,000 training examples after laya-train's calibration slice; ≥ 1,000 malicious
releases across ≥ 5 families; ≥ 5 benign per malicious release; ≥ 50 test positives per family where the sources
allow; no family above 25 % of the positives of any split; and only facts knowable at publish time, with the same
fields for both classes.

1. **Hindsight leak in `young_deps_added` fixed** (`src/build.py` `young_dependencies`, and the rule-scorer harness
   `src/rule_scorer.ts`). A dependency's first-publish date comes from today's registry. v1 counted a dependency
   that today's registry cannot resolve as *young*, in both the feature and the rule scorer's `dependency_added`
   fact (`markYoungDependencies` was given `null`). Malicious dependencies are exactly the ones npm removes later,
   so this leaked the future into a positive-leaning signal. Now a dependency whose first-publish date is unknown
   today, or later than the scoring time (release + 1 hour, the time the rule-scorer harness scores at; npm's
   `0.0.1-security` placeholders and re-registered names fall here), counts as **unknown**: neither young nor old,
   and not counted at all (an "unknown" count would carry the same hindsight). Dependencies beyond the first 20
   added (not looked up) are unknown too. On v2, 88 of 2,589 positives (3.4 %) and 103 of 14,464 negatives (0.7 %)
   have such a dependency (`results/leakage_check.json`, `dependency_age_unknown`). The leakage check now fails if
   any unknown dependency is counted as young; it passes.
2. **More positives, all real.**
   - The per-family download quota in `src/collect_positives.py` went from 160 to 3,000 packages (seeded sample,
     a superset of v1's). Only the five families above 160 change: dependency-confusion (1,711, all), tea.xyz
     (2,437, all), unattributed (3,000 of 8,094), Shai-Hulud (527, all) and TeamPCP (240, all).
   - **OSV-only releases** for the thin families (typosquat, crypto-theft, data-exfiltration, beacon, Discord token
     stealer, backdoor, starjacking): npm packages listed by an OSV `MAL-*`/CWE-506 record that DataDog has no
     archive for, kept only if today's registry still serves the earliest listed affected version (the first known
     bad release). Their contents come from the registry tarball and their history from today's packument, the
     same path as every negative. 346 packages qualified (data-exfiltration 258, typosquat 38, crypto-theft 33,
     beacon 12, Discord 4, backdoor 1); the family comes from the same OSV text markers as before. Each row keeps
     its OSV ids in `label_sources`.
   - The OSV export is now the 802734dd… download for both classes (v1 positives used 5a721776…). Re-running v1's
     positive list with it gives the same family for every v1 row.
   - After fetching (same rules: the previous release must still be served) and grouping, 2,589 positives remain.
3. **More negatives, same way** (`collect_negatives.py --extend`). v1's 7,400 candidates are kept unchanged (batch
   v1). Batch v2 (15,758 releases) is drawn by the same code path and rules from packages v1 did not use (2,191
   remaining established names and 16,000 more npm-search names, same exclusion list), with the per-month target
   `max(40, round(V2_TOTAL[window] × positives(month) / positives(window)))`, V2_TOTAL = train 4,000, calib 5,000,
   test 6,500. The month mix still follows the positives; calib got a larger total because grouping keeps only
   part of its candidates (v1: 1 in 4, v2: about 1 in 2; a calib-window package often also releases in train or
   test), and calib has to
   end with ≥ 2,000 benign releases so the 10-per-1,000 threshold rests on ≥ 20 benign alerts. The "40 % first
   releases" rule is applied as before, but v2's search pool had fewer first releases in the busy months, so 23 %
   of v2 picks are first releases (v1: 12 %). This departs from "5 per positive, at least 40 per
   month" in the Data section.
4. **Ratio floor in `src/split.py`:** every split keeps at least 5 benign releases per malicious one; while it does
   not, the largest family gives up one release (the cap's seeded order), then the 25 % cap is re-checked. In v2 it
   removed 324 train positives (dependency-confusion 107, tea.xyz 108, unattributed 109); calib and test were
   already above 5.
5. **Same time windows.** No cutoff moved: train < 2025-10-01 ≤ calib < 2026-03-01 ≤ test.
6. **Archive limits for both classes** (`src/common.py`): archives above 150 MB compressed or 50,000 entries are
   refused, after a fetch worker ran out of memory. One candidate was refused (a benign `@openai/codex` release whose
   tarball is above 150 MB; counted under `neg:tarball_unavailable` in `data/build.summary.json`); no positive came
   near either limit.
7. **Token check uses laya's own sequence builder** (`src/check_tokens.py`): the v1 script counted `json.dumps`
   tokens with an estimated head, which the gate review found approximate. It now runs the notebook's method
   (`laya.common.build_sequence(..., return_truncation_stats=True)` with the checkpoint tokenizer).
8. **Co-primary pass conditions**: P1–P3 must also hold on the macro over test families with ≥ 5 positives (see the
   Pass rule). Reason: with 26 test families, 15 of which have fewer than 5 positives, single releases can swing
   the all-family macro by several points; the co-primary keeps the primary rule and adds the comparison that
   rests on families with enough releases. `src/triage_metrics.py` reports `macro_recall_min5` for every method.
9. **"85 % negatives" corrected** in P0: calib is 91 % negatives in v2.
10. **Notebook live progress** (no protocol change): if a Colab secret `GH_TOKEN` exists, the notebook pushes
    `progress.jsonl` and small result files to branch `results/laya-colab` (RUN-IN-COLAB.md). It does not change
    any run, metric or rule.

**v2 dataset** (`data/split.summary.json`, `results/leakage_check.json`, `results/tokens.json`):

| Split | Releases | Malicious | Benign | Benign per malicious | Families | Families ≥ 5 | Families ≥ 50 | Largest family share |
|---|---|---|---|---|---|---|---|---|
| train | 6,175 | 1,029 | 5,146 | 5.0 | 19 | 12 | 5 | 22.4 % |
| calib | 3,231 | 300 | 2,931 | 9.8 | 8 | 5 | 4 | 25.0 % |
| test | 7,647 | 1,260 | 6,387 | 5.1 | 26 | 11 | 7 | 20.4 % |

- 17,053 releases, 2,589 malicious; no package and no account in two splits; leakage check PASS.
- `laya-train --dry-run` on train: 6,867 items (6,175 `triage` + 692 `script_intent`), 400 held for laya's
  calibration slice, 6,467 trained on; 102 updates per epoch, so E = 6.
- Truncation (laya's builder, 1024/256): `triage` 114 of 17,053 states (0.7 %), `script_intent` 72 of 1,783
  (4.0 %); at the English bundle's 512/192 every state is cut (median 545 state tokens).
- Test families with ≥ 50 positives: dependency-confusion 257, data-exfiltration 255, unattributed 237, TeamPCP
  175, Mastra 119, typosquat 68, crypto-theft 58. Short of 50 because the real sources run out: Miasma 38 (all 50
  DataDog packages fetched; 12 had no previous release still served), beacon 16, 2026-07-24 8, IronWorm 6, and 15
  families with 1–4 releases.


## Gate review 2026-10-10 (dataset v2.1), before any Laya run

An independent gate review re-ran the pipeline from the cache (build and split reproduce v2 byte for byte in content;
rule scores, leakage check and baselines reproduce exactly apart from run times) and spot-checked rows against live
sources. No Laya model had been run on this dataset, in any form, when the changes below were made. The time windows,
the 25 % family cap, the ratio floor, the questions, the methods, the threshold rule and P0–P6 are unchanged.

1. **Positives labelled only by withdrawn OSV records removed (label correction).** 71 OSV-only candidates had no
   OSV `MAL-*`/CWE-506 record left that was not withdrawn: OSV withdrew a batch of amazon-inspector imports on
   2026-05-26 (e.g. MAL-2026-4628), and a withdrawn record is not evidence of malice. 69 of them were in v2
   (test 67: data-exfiltration 55, typosquat 6, crypto-theft 5, beacon 1; train 2: crypto-theft 1, data-exfiltration
   1); every one of the 69 is withdrawn in the 802734dd… export, and 68 also return no active record from the live
   OSV API. `src/collect_positives.py` now drops OSV-only packages whose every record is withdrawn, *after* the
   seeded per-family sample, so no other candidate changes (`positive_candidates.jsonl` loses exactly those 71 lines;
   `osv_only_dropped_withdrawn_per_family` in its summary). Negatives are not redrawn. In train the ratio floor then
   kept two more releases (dependency-confusion and tea.xyz one each), so train is still 1,029 malicious; calib is
   unchanged.
2. **Leakage check: one gate scope corrected, disclosed because it was changed after the check failed.** With the 69
   rows gone, the missing-rate gap of `median_gap_days_prior` (and the state field
   `release.median_days_between_releases`) among non-first releases became 0.1016 (v2: 0.0958; limit 0.10). The
   field is empty by design when a release has only one prior release (no gap to take a median of): on v2.1 it is
   empty for 167 of 167 benign and 94 of 94 malicious non-first releases with one prior release, and for 0 of all
   others in either class. So the gap measures how often malicious releases are second releases (already in
   `prior_releases`), not a field read differently per class. The check now gates this one field within releases
   with ≥ 2 prior releases (gap 0.0) and still reports the non-first rates. `MAX_GAP` and every other check are
   unchanged; the check passes.
   *Approved 2026-10-10 by the project owner, before any Laya run, after being told the scope was changed only
   after the check had failed.*
3. **Reporting-only metrics (not part of P0–P6; no threshold, selection or verdict uses them).**
   `src/triage_metrics.py` adds `reporting_only` to every method's metrics (baselines in `results/baselines.json`;
   every Laya run in `metrics_*.json` and in the notebook's summary table):
   - Macro recall without the dependency-confusion family (all families, and families with ≥ 5 positives). That
     family's label is partly assigned by a "major ≥ 50" version heuristic that is also a model input.
   - The same alerts (calib threshold, unchanged) split into first releases and later releases. In v2.1, 22–27 % of
     benign but 58–78 % of malicious releases are first releases, a mix a model can exploit. Within each
     stratum: recall per family, macro recall (all, ≥ 5, without dependency-confusion), alerts per 1,000 benign and
     ROC AUC.
   `results/baseline_scores.csv.gz` gains the `is_first_release` column for this.
4. **Baselines recomputed on v2.1** (`results/baselines.json`). The v2 baseline numbers had been seen; nothing above
   was chosen to move them (item 1 corrects labels, item 2 changes no feature or row, item 3 only adds reports).

**v2.1 dataset** (`data/split.summary.json`):

| Split | Releases | Malicious | Benign | Benign per malicious | Families | Families ≥ 5 | Families ≥ 50 | Largest family share |
|---|---|---|---|---|---|---|---|---|
| train | 6,175 | 1,029 | 5,146 | 5.0 | 19 | 12 | 5 | 22.4 % |
| calib | 3,231 | 300 | 2,931 | 9.8 | 8 | 5 | 4 | 25.0 % |
| test | 7,580 | 1,193 | 6,387 | 5.4 | 26 | 11 | 7 | 21.5 % |

- 16,986 releases, 2,522 malicious; no package and no account in two splits; leakage check PASS. Dependencies of
  unknown age: 88 of 2,522 positives, 103 of 14,464 negatives.
- `laya-train --dry-run` on train (both bases): 6,868 items (6,175 `triage` + 693 `script_intent`), 400 held for
  laya's calibration slice, 6,468 trained on, zero skipped; 102 updates per epoch, so E = 6.
- Truncation at 1024/256: `triage` 108 of 16,986 (0.6 %), `script_intent` 72 of 1,781 (4.0 %).
- Test families with ≥ 50 positives: dependency-confusion 257, unattributed 237, data-exfiltration 200, TeamPCP 175,
  Mastra 119, typosquat 62, crypto-theft 53.

## Execution plumbing 2026-10-10 (no rule changed), before any Laya run

The notebook gained resume, retry and keep-going plumbing so a Colab disconnect does not lose finished work. None of
it changes a checkpoint, run, dataset, threshold, metric, selection step or pass condition (P0–P6):

- A ledger (`state.json`) on Drive records each run's status, attempts and errors, and the sha256 of its result
  files; a finished run is skipped after its files verify. Training runs in a detached process with a watchdog.
- Runs execute in a fixed priority order (positive controls, then seed 0 of both bases, then seeds 1–2, then the
  zero-shot references). Each run is the same pre-registered run; only the order changed.
- laya-train 0.4.1 cannot resume from `checkpoint_latest/` (weights only; no optimizer, scheduler or RNG state), so
  an interrupted run restarts from its base checkpoint with the same seed and flags.
- On CUDA out-of-memory a run is retried with half the micro-batch and double the accumulation, so the effective
  batch stays 64 and the optimizer-update count is unchanged (checked, and logged in `train_<run>.json`). This
  extends "8 × 8, or 4 × 16" above with 2 × 32 and 1 × 64, used only after an OOM.
- Precision is laya's own and is recorded per run: fp16 autocast with a gradient scaler for training on any CUDA
  GPU; bf16 (compute capability ≥ 8) or fp16 autocast for scoring.
- A run that still fails after 3 attempts is reported as not finished. The verdict code is unchanged and treats a
  missing run as it did before.

## Execution plumbing 2026-10-10, Colab features (execution only; no rule changed), before any Laya run

The notebook now uses Colab's own features for running it, and nothing else changed. No checkpoint, run, run order,
dataset, threshold, metric, selection step or pass condition (P0–P6) changed, and no training or scoring setting
changed:

- A Colab form holds the options (`RUN_TAG`, `RETRY_FAILED`, `AUTO_RELEASE_RUNTIME`, `PUSH_PROGRESS`, `SMOKE` and the
  existing switches). `SMOKE` is a tiny end-to-end check under its own `smoke-...` run tag, and it is never the
  experiment.
- Secrets come from `google.colab.userdata`: `GH_TOKEN` (live progress) and optionally `HF_TOKEN` (download rate
  limits only). Neither is passed to training.
- Everything is written on the VM's local disk first and then copied to Google Drive atomically (temporary file,
  then rename). A new VM restores the ledger, results and logs from Drive. The verified base-checkpoint snapshot
  (pinned revision, sha256 manifest) and the pip download cache are kept on Drive. Package versions stay pinned
  exactly.
- GPU, driver, CUDA, torch and RAM are recorded in `env.json`. A status table replaces the log output. At the end
  the notebook syncs and verifies everything on Drive, then flushes and unmounts Drive. Only if all of that
  succeeded, and `AUTO_RELEASE_RUNTIME` is on, does it release the runtime.
