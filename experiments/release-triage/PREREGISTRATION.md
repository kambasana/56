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
    ≥ 0.95. Accuracy alone is not enough, because about 85 % of calib is negatives;
  - at least 2 of the 3 seeds are not collapsed.

  If P0 fails, the outcome is **INCONCLUSIVE**: fix the setup, and do not read the real runs as
  evidence either way.
- **P1, margin:** Laya's test macro recall ≥ best baseline's test macro recall **+ 0.05**, at the same
  10-per-1,000 calib budget.
- **P2, not luck:** the paired family-bootstrap 95 % interval of (Laya − best baseline) macro recall
  has a lower bound **> 0**.
- **P3, no single family drives it:** with any one family removed, the macro recall difference stays
  **≥ 0.025**.
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
