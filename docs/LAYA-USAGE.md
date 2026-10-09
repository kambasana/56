# Using Laya properly: what its authors prescribe, what our burst experiment got wrong, and a corrected design

Status: research and design note (2026-10-09). **No new model run and no new numbers here.** Every figure is
either quoted from Laya's own documentation (with the URL) or taken from files already committed in this
repository (named). The previous experiment is [LAYA-TRIAGE.md](LAYA-TRIAGE.md) on branch
`proof/laya-triage`. Its verdict was FAIL. This note explains why that verdict says little about Laya as
designed, and how a fair test would look.

**Scope correction first.** Shai-Hulud is one incident family among many. In the labelled dataset on
`data-ml/model` (`blastradius/pack/model/reports/2026-10-08-dataset.md`), the 5,136 compromised releases
fall into 55 campaigns: teampcp-2026 has 2,945, sha1-hulud-second-coming-2025-11 has 891,
shai-hulud-2025-09 has 498, miasma-2026 has 372, and there is a long tail (mastra, npm phishing waves,
ironworm, nx-build, gluestack-ui, rspack, …), plus the replay incidents (event-stream, ua-parser-js,
coa/rc, node-ipc, chalk/debug, eslint-config-prettier, nx). The previous experiment's incident set was
25 Shai-Hulud accounts plus qix, and its recall gate was "≥ 20 of 25 Shai-Hulud accounts". Nothing in the
corrected design below hinges on one family: every metric is a macro average over families, and no gate
names a family.

Sources read for this note (fetched 2026-10-09):

| Short name | URL |
|---|---|
| Docs home | https://nandhakishorm.github.io/laya/ |
| Fine-tuning guide | https://nandhakishorm.github.io/laya/finetune/ |
| Benchmarks and known limits | https://nandhakishorm.github.io/laya/benchmarks/ |
| Staged adoption | https://nandhakishorm.github.io/laya/staged-adoption/ |
| Evaluation harness (`laya-evals`) | https://nandhakishorm.github.io/laya/evals/ |
| Fine-tuning API reference | https://nandhakishorm.github.io/laya/reference/train/ |
| TypeScript SDK design | https://nandhakishorm.github.io/laya/typescript-sdk/ |
| Repo README | https://github.com/NandhaKishorM/laya (README.md) |
| Repo BENCHMARKS.md | https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md |
| `laya-ts` README | https://github.com/NandhaKishorM/laya/tree/main/laya-ts |
| Model card | https://huggingface.co/convaiinnovations/laya |
| Node runtime we used | https://github.com/receptron/laya (README.md); bundle https://huggingface.co/receptron/laya-onnx |

---

## 1. How Laya is meant to be used

### 1.1 It is a base to fine-tune, not a zero-shot classifier

- README, *Honest limits*: "The base checkpoints are near chance on typed-decisions zero-shot -- 0.362
  and 0.352 against a 0.318 random baseline and a 0.461 majority-class baseline. … **Laya is a fast base
  to specialise, not a zero-shot decision engine.**"
- Fine-tuning guide: "the base checkpoints score near chance zero-shot — 0.36 and 0.35 against a 0.318
  random baseline — while the fine-tuned checkpoint reaches 0.766 on the same 2,000 decisions … Fine-tuning
  is where most of the value is."
- Benchmarks page: "both base checkpoints score below its 0.461 majority-class baseline. That result
  supports fine-tuning for a similar task; it does not establish 0.766 accuracy for an untrained
  checkpoint or a new domain."
- The fine-tuning guide's option table, typed-decisions, one T4 per run: base checkpoint accuracy 0.362;
  `--loss rlcd` 0.7715; `--loss soft-ce` 0.790; `--loss soft-ce --shuffle-options` 0.7875.

How to fine-tune (fine-tuning guide):

- `laya-train` "builds the training items, fine-tunes, fits calibration temperatures on a slice held out
  before training, and saves a checkpoint laya.load opens." `laya.train.finetune` does the same from
  Python.
- Data is JSONL, one case per line, with `state`, `questions` and `expected` ("expected holds one answer
  per question, the format laya-evals reads, so the same file can train a checkpoint and evaluate it").
- Options that matter for us: `--base` ("a built-in name (english, multilingual, typed-decisions) or a Hub
  repo id"), `--loss soft-ce`, `--shuffle-options` ("re-encodes choice questions with a random option
  order every epoch"), `--max-len, --head-max-len` ("the notebook uses 1024 and 256"), `--seed`.
  `--freeze-encoder` "fits a small GPU or a CPU, but gains much less than a full fine-tune".
- `--dry-run` "builds the training items with the tokenizer and config of --base, without loading its
  weights", and reports skipped questions, including `options_beyond_max_len`.
- A run that stays at chance: use "a label-encoding positive control" (prepend `label=<answer>;` to every
  text) to tell a broken budget from a hard task. And "Takeoff near the ln K plateau is also
  seed-dependent, so one run is not evidence either way. #963 saw 9 of 15 runs leave the plateau and 6
  never do within 32 epochs … Repeat the run with different seeds."
- Budget: "updates = epochs * ceil(ceil(train_items / micro_batch) / grad_accum)". Defaults are 4 epochs
  at effective batch 64; "A small dataset therefore needs more epochs to reach a similar update count."
- Hardware: the notebook runs on Kaggle's free 2xT4 GPUs, "about 4–6 minutes for the demo's 6,000
  decisions, and roughly 4–5 hours for four epochs over ~30k questions". Our machine has 4 CPUs and no
  GPU, so a full fine-tune needs a GPU (for example that Kaggle notebook) or a smaller base.

### 1.2 Calibrate on held-out data from your own workflow before any confidence gate

- Fine-tuning guide, *Calibration is part of the run*: "This is the step most likely to be dropped when
  copying the loop, and it is load-bearing the moment anyone gates on confidence. … The checkpoints as
  shipped are over-confident, so fit before relying on any threshold, and evaluate the result on held-out
  data before claiming an improvement."
- Same page: "The calibration slice is small on purpose. Up to 400 items or 10% — enough for three
  per-type scalars, not enough to validate against. Hold out your own evaluation data." And a run that
  prints "not fitted: … fewer than 10" means "don't gate on min_confidence with it".
- Benchmarks page: "Fit and evaluate temperatures on separate, held-out examples from your workflow before
  using a confidence gate." "Even a lower ECE on one suite does not set a safe threshold for another task
  or option count."
- README, *Calibration*: "Both checkpoints are over-confident as shipped. Refitting one temperature per
  (question type, option count) on held-out data moves mean ECE 0.466 -> 0.081 (`laya`)".
- README: gate on `answer_confidence` (max p), "never the entropy `confidence`"; "fit and validate any
  cutoff on held-out data at the option counts your workload uses (#394)".
- Staged adoption: "A confidence threshold is an application policy, not a property supplied by Laya. …
  There is no universal number that transfers across checkpoints, question types, languages or action
  risks."

### 1.3 Question design: few options, and check order and wording

- Benchmarks page, *Wording and order*: "Option order can change a choice answer. Boolean-word choice
  labels and negated requests have also failed in documented examples; noul can follow its option labels
  instead of the state. Check alternate option orders and wording, especially when a wrong decision is
  costly."
- README, *Option order*: "where an option sits changes the answer"; on five identical options the English
  checkpoint's per-slot logits centre at "[+1.68, +1.47, +0.11, -1.35, -1.91], a spread decided by
  position alone". `option_order` rotations average this out ("the k rotations go in as k questions, so
  they share one forward pass").
- README, *Honest limits*: "`noul` can follow its option labels instead of the state, most strongly on
  `laya` (English). `noul` renders its two options as `false:` / `true:` by default, and on the English
  checkpoint that label pair can dominate the answer, returning a confident "no" for clearly positive
  input (#156)." The workaround is a `labels` override (for example `A`/`B`) "validate[d] … on your own
  data".
- README: "Ordinal `score` questions are the weakest primitive (SST-5 0.372)." Benchmarks page: "ordinal
  score is the weakest primitive in the reported English suites."
- Benchmarks page: "Keep a single choice question to roughly 20 options". Fine-tuning guide, *What to
  watch*: "Your labels must fit the three primitives."

### 1.4 Token budgets: size the state to the checkpoint

- README checkpoint table: `laya` (English, ModernBERT-large, 421M) context **512**;
  `laya-multilingual` (mmBERT-base, 322M) **1024 (up to 8,192)**; `laya-typed-decisions` (421M) **1024**.
- README: "`predict`/`system_one` truncate a state that exceeds `max_len` to a single window …
  silently dropping the rest." Size a state to "`max_len - head_len - 1` for the question you are
  actually asking".
- `predict_long` windows long text, but "The returned probability is the deciding window's, not a
  calibrated number for the whole document — a `noul` max drifts up with the window count even with no
  signal."
- receptron/laya README, *Limits*: "The state is truncated to `max_len` (512 tokens for the English
  checkpoint) after the question header."

### 1.5 Evaluate like a model, against a baseline

- Benchmarks page: "keep a held-out set with the same states, questions and expected answers for every
  checkpoint you compare. Record the checkpoint revision, Laya and library versions, device, question
  count, option count and token budget with each run. **Include a simple baseline for accuracy** and report
  latency after warm-up as well as first-use load time."
- Evaluation harness: `laya-evals run data.jsonl --model … --json report.json` reports
  `choice_accuracy`, `noul_accuracy`, `ece`, `brier`, `aurc`, `selective_accuracy@50/@80`, latency, and
  slices (`--slice`, `tags`). `laya-evals compare report.json --baseline baseline.json` gates a
  candidate. `run --onnx PATH` evaluates an ONNX export with "the same thresholds and baselines as the
  torch path", and `--calibration PATH` loads a fitted calibration map onto it.
- BENCHMARKS.md, application workflows: held-out moderation is "0.530 with macro-F1 0.400 — barely above
  chance on a balanced split … hand-picked examples work, real traffic does not." Task transfer to a new
  domain is not assumed.

### 1.6 Adopt in stages; Laya returns a decision, not permission

Staged adoption page: "Laya returns a typed decision, not permission to execute it."

1. **Shadow**: "Run Laya on representative real traffic, but keep the incumbent action authoritative."
   Record the question schema, answer, per-option probabilities, confidence, checkpoint, run_id, the
   incumbent action and the eventual outcome.
2. **Compare**: "disagreement is a signal, not a verdict … keep an explicit unknown or review bucket".
3. **Policy from held-out evidence**: thresholds are fitted on representative held-out data; "Record the
   checkpoint and question-schema version, calibration method, threshold, evaluation set and owner".
4. **Promote a bounded slice**: "a measured, reversible change rather than a global on/off switch", with a
   canary, a traffic cap and "a named rollback condition".

### 1.7 Running a fine-tuned checkpoint from Node

- receptron/laya (what we used): "The ONNX weights (about 1.7 GB, fp32)". The Hugging Face repo
  `receptron/laya-onnx` holds one bundle (`laya.onnx` 3,807,291 bytes, `laya.onnx.data` 1,685,258,240
  bytes, `laya_config.json`, tokenizer): the English checkpoint. To use another checkpoint,
  "`export/export_onnx.py` turns the Hugging Face checkpoint … into one ONNX graph and copies the tokenizer
  and calibration values next to it", then `Laya.load({ modelDir })`.
- Upstream `laya-ts` (README): "python laya-ts/scripts/export_onnx.py --model-dir <ckpt> --out-dir ./model
  … verifies torch vs ONNX match within 1e-4". It takes any checkpoint directory.
- TypeScript SDK design page: `laya-client` calls a self-hosted Python `laya-serve` over HTTP instead.
- Evaluation harness: "`python scripts/export_onnx.py --model convaiinnovations/laya --output laya.onnx
  --quantize`" makes an INT8 copy. Measured on its 12-row fixture, INT8 "moves score_mae by 0.009 and ece
  by 0.006". The size and accuracy of an INT8 export of *our* checkpoint would have to be measured.
- Whatever path is chosen, the calibration must travel with the weights: "Ship the config, not just the
  weights" (fine-tuning guide).

---

## 2. Audit: proof/laya-triage against that guidance

Facts about our run are from [LAYA-TRIAGE.md](LAYA-TRIAGE.md),
`blastradius/test/replay/account/LAYA-PREREGISTRATION.md`, `experiments/laya-triage/questions.ts` and
`experiments/laya-triage/results/tokens.json` (all on `proof/laya-triage`).

| # | Aspect | Laya guidance (§1) | What our experiment did | Effect on the verdict |
|---|---|---|---|---|
| 1 | Zero-shot vs fine-tuned | Base checkpoints are near chance zero-shot on new typed-decision tasks, below the majority baseline; value comes from fine-tuning (§1.1). | Zero-shot. No training data was used. | **Largest flaw.** We measured the configuration the authors say not to rely on. The FAIL is consistent with their own benchmark and says nothing about a fine-tuned Laya. |
| 2 | Checkpoint | English (`laya`) has a 512 context; multilingual and typed-decisions have 1024 (§1.4). | English checkpoint via `receptron/laya-onnx` revision `68f27dfe…`, the only bundle that runtime ships. | Forced the 512 budget (row 3). A fine-tuned run would start from `--base english` with `--max-len 1024 --head-max-len 256` as the notebook does, or from `multilingual`, and be exported ourselves. |
| 3 | max_len / truncation | Size the state to `max_len - head_len - 1`; overflow is silently dropped (§1.4). | Every state hit 512 tokens. The aggregates fit (max 256 tokens), but the per-package list was always cut after about 2–4 of up to 8 packages (`tokens.json`; LAYA-TRIAGE deviation 2). | The model never saw most per-package facts (previous publishers, bump, days since release). Biased against Laya. It also made each call 3 × 512 tokens, hence the 3.0 s median. |
| 4 | Calibration | Shipped checkpoints are over-confident; fit temperatures on held-out workflow data before any confidence gate (§1.2). | Uncalibrated raw P(true). The threshold τ = 0.7154 was picked on 5 calibration control accounts (157 points). The calibration split held no incident points, so a temperature could not have been fitted. | The threshold was a noise-quantile on uncalibrated scores, not a calibrated policy. The compressed score range (control median 0.574, p95 0.664; incident minimum 0.526) is typical of an uncalibrated head. A threshold transfers badly from 5 accounts to microsoft1es (16 of 18 test false alarms). |
| 5 | Question type for the decision | `noul` "can follow its option labels instead of the state, most strongly on `laya` (English)" (#156). `score` is the weakest primitive (§1.3). | The deciding score was a `noul` (`takeover`) on the English checkpoint with the default `false`/`true` labels. `risk` was a `score` (descriptive only). | The decision rested on the primitive the README flags as least reliable on that checkpoint, with no `labels` override and no check that it read the state. Unknown direction of bias; untested. |
| 6 | Option-order / wording checks | Check alternate orders and wording; average over `option_order` rotations; train with `--shuffle-options` (§1.3). | None. The `kind` choice had 3 options in one fixed order. The `takeover` wording named "a self-spreading worm" as the example attack. | Order effects were not measured, so their size is unknown. The worm wording frames the question around one family (row 9). |
| 7 | State format | JSON states are fine; important facts must fit, and the state should hold what decides the case. | A JSON burst summary: window counts, 14-day history, aggregates, up to 8 packages. **No provenance, no install-script, no tarball or metadata fields** (absent from the recorded data). The account name was included. | Laya's strength is reading text (§3.4). The state was almost entirely counts, which a tabular model handles better, and the one free-text field, the account name, invites memorisation rather than reasoning. |
| 8 | Single-signal scope | — (a scoping choice on our side) | Only the account-burst signal: a ≥ 5-packages-in-6-h burst was the unit, and every other release signal was out of scope. | The triage question ("is this burst a takeover?") is a narrow slice of release triage. Most compromises are single releases, which never fire a burst (event-stream right9ctrl never fired: LAYA-PREREGISTRATION.md). |
| 9 | Gate centred on one family | Evaluate per slice; don't promote from an easy subset (staged adoption: "A high agreement rate on an easy subset does not justify promotion for a different … question shape"). | Recall gate: ≥ 20 of 25 Shai-Hulud accounts. 25 of the 26 incident accounts were Shai-Hulud; the only other was qix. | The recall half of the verdict measured how one worm family looks, not triage quality. A family-weighted gate could rank the methods differently. |
| 10 | Baseline | "Include a simple baseline" (§1.5). | A two-condition plain rule (publisher new to a package, or ≥ half dormant > 90 d). No trained tabular model. | Even if Laya had passed, it would not have shown that a 1.7 GB model beats a logistic regression or GBDT on the same counts, which is the comparison that justifies the dependency. |
| 11 | Seeds / repeat runs | Fine-tune takeoff is seed-dependent; repeat runs (§1.1). | Not applicable to zero-shot (deterministic per state). | Applies to the corrected design. |
| 12 | Adoption path | Shadow → compare → held-out threshold → bounded promotion (§1.6). | A one-shot pass/fail on a replay. | Fine as an offline proof, but a pass would not have licensed shipping. A fail does not rule out a shadow trial of a fine-tuned model. |

**What the verdict still means.** The FAIL stands for what was tested: *zero-shot English Laya, truncated
burst-count states, an uncalibrated noul, a Shai-centred recall gate.* It should be cited as "zero-shot
Laya does not triage account bursts", not as "Laya cannot help release triage". Flaws 1, 3, 4 and 5 bias
against Laya. Flaw 9 makes the recall number family-specific. Flaws 7, 8 and 10 mean the experiment could
not have shown the thing that matters: whether Laya adds anything over a cheap tabular model on our facts.

---

## 3. Corrected design: release triage across all our signals

### 3.1 Task and unit

- **Unit: one npm release** (package@version at publish time), not an account burst. Account bursts become
  one input feature among many.
- **Decision: one choice question** with three options, plus **at most one noul**:

```json
{
  "triage": {
    "type": "choice",
    "instructions": "An npm package just published this release. Using only the facts in the state, how should a security reviewer treat it?",
    "criteria": {
      "routine": "an ordinary release by the usual maintainers; nothing needs a look",
      "review": "legitimate-looking, but a change in the facts deserves a human look before adoption",
      "likely_malicious": "the facts point to a compromised or attacker-controlled release"
    }
  },
  "script_intent": {
    "type": "noul",
    "instructions": "Does the install-time script shown in the state do something other than build, compile or set up this package (for example download, exfiltrate, run obfuscated code or touch credentials)?",
    "criteria": {"false": "it only builds or sets up the package", "true": "it does something unrelated to building the package"},
    "labels": {"false": "B", "true": "A"}
  }
}
```

  - Semantic choice keys, not boolean words (README). Three options, well under ~20.
  - The noul is asked **only when the state contains install-script text**. It has explicit criteria and
    an opaque `labels` override because of #156, and that override is validated on our data
    (step 5 in 3.5), not assumed to work.
  - No `score` question (weakest primitive). No wording that names a campaign.

- **Labels.**
  - `likely_malicious`: a release labelled compromised in the `data-ml/model` dataset (OSV `MAL-*`,
    CWE-506 GitHub advisories, supplychain-attack-data, the incident KB, replay incidents). Its labelling
    rules are in `2026-10-08-dataset.md`.
  - `routine` and `review`: clean releases. `review` cannot be computed from our own signals without
    making Laya imitate the rule scorer. So it comes from human adjudication of a sample: clean releases
    that a reviewer marks as warranting a look, with the reviewer and the reason recorded. Until that
    sample exists, the primary metric collapses the output to malicious vs not (P(likely_malicious)),
    which is the only ground truth we have. The three-way accuracy is reported as secondary.

### 3.2 State: all our signals, facts known at publish time only

One JSON object per release. Numeric and categorical facts first, so they are never truncated. Then
bounded text with explicit truncation markers.

| Group | Fields (as of publish time; source in repo) |
|---|---|
| Publisher / maintainers | publisher (`_npmUser`) differs from the previous release's; publisher new to this package; maintainer added/removed since previous release; maintainer count; sole maintainer; days since publisher's first publish of this package (`src/scoring/intrinsic.ts` ownership change; `src/enrich/npm/`) |
| Install scripts | install hook (preinstall/install/postinstall) added, changed or removed vs previous release; static flags from `src/enrich/npm/scripts.ts` (network, …); **script text, both old and new, bounded** |
| Dependencies | runtime dependencies added in this release, each with its first-publish age and weekly downloads (`dependency_added`, `ESTABLISHED_WEEKLY_DOWNLOADS` in `src/scoring/weights.ts`) |
| Provenance | attestation present on previous release and missing now (`provenance_dropped`), trusted publishing vs token |
| Release cadence and version | bump type; version jump oddities (major jump far above any earlier major, prerelease out of line); days since previous release; dormant > 90 d; releases in past year |
| Account activity | the burst rule's facts from ACCOUNT-PROOF (distinct packages from this publisher in the last 6 h / 24 h), as counts |
| Repository / metadata | repository URL changed; homepage/bugs changed; `bin` added; files list grew; **README/description diff, bounded** |
| External text | advisory or issue text **only if it was published before the release time** (normally none; never post-incident text) |

Rules for the state:

- **Measure tokens with the checkpoint's own tokenizer** (`laya-train --dry-run`, and a token count per
  state). Report how many states are truncated. Target zero by bounding text fields (for example the
  first N characters of each script with a `…[truncated K chars]` marker), not by dropping facts. Budget
  `--max-len 1024 --head-max-len 256` as the notebook does.
- **No account or package names** in the state. They invite memorisation of known-bad names and leak
  across a split.
- **Equal availability of text across classes.** In the `data-ml/model` dataset, 5,021 of 5,136
  positives have no manifest because npm unpublished them (`2026-10-08-dataset.md`). A naive state would
  carry script text for nearly every negative and almost no positive, so "has text" would predict the
  label. Two arms, both reported:
  - **Facts arm**: every row, text fields removed for all rows.
  - **Text arm**: only rows where the manifest text exists for that release, positives and negatives
    alike. Positives come from manifests npm still serves, Datadog's npm *compromised* samples (unpacked
    only inside the job, never executed, per FEEDS-AND-DETECTORS.md), and replay incidents whose script
    text is recorded from the advisory (`test/replay/incidents.config.json`). The number of positive
    releases and families in this arm must be counted before any training. If it is too small to
    evaluate per family, the text arm is reported as not yet testable, not run on a handful.
- **First bad release per package** as the primary positive set, so a worm's later releases do not
  dominate. This is a lesson from the `data-ml/model` gate report, where recall fell from 49.9 % to 35.5 %
  on first releases.

### 3.3 Splits and metrics: per incident family, macro-averaged

- **Grouped by family.** Use the dataset's 55 campaigns as families and replay incidents as their own
  families. Leave-family-out cross-validation (GroupKFold by family, as the `data-ml/model` trainer
  already does), plus the existing time split (cutoff 2026-01-01, a family wholly on one side). Negatives
  are matched to the positives' popularity and year.
- **Three disjoint pieces per fold**: train; a calibration slice for temperatures (laya-train's own
  held-out slice, plus our family-held-out calibration set for the threshold); test.
- **Metrics, all macro over families** (each family weighs the same, whatever its size):
  - recall of P(likely_malicious) at a fixed noise budget, the main one;
  - average precision;
  - noise: findings per clean control repo and per control account-month at that threshold. The hammer
    controls and Acme lockfile packages are never trained on.
  - ECE, Brier, AURC via `laya-evals` (with `tags` = family, `--slice`);
  - three-way accuracy on the adjudicated sample (secondary).
- **Family-dominance check**: report every metric also with the largest family left out, and the
  per-family table. If a conclusion changes when one family is removed, it is not a conclusion.
- **Uncertainty**: a bootstrap over families (resample families, not rows) for each difference between
  methods.

### 3.4 Baselines, and where Laya is and is not the right tool

Every method sees the same facts, split and threshold rule:

1. **Current rule scorer**: the noisy-OR in `src/scoring/intrinsic.ts` with `DEFAULT_WEIGHTS`.
2. **Logistic regression** on the facts arm (standardised numerics, one-hot categoricals).
3. **Gradient-boosted trees** (LightGBM, small depth, class weights, isotonic calibration), the pipeline
   that already exists on `data-ml/model`.
4. **A cheap text baseline** for the text arm: TF-IDF of script and README-diff text plus logistic
   regression, alone and concatenated with the facts.
5. **Laya, fine-tuned** (3.5), alone.
6. **Stacked**: GBDT on facts plus Laya's calibrated text probability (P(likely_malicious) from the text
   arm, and the `script_intent` noul) as extra features.

**Where Laya is a poor fit, honestly.** Purely numeric and categorical facts (counts, ages, bumps, flags)
are what GBDT and logistic regression do well, cheaply and explainably. A 421M-parameter encoder reading
those numbers as tokens is unlikely to beat them, and the authors make no claim that it would. Laya's
plausible edge is **text**: install-script bodies, README or description diffs, and advisory or issue
prose. There, bag-of-words misses intent (an obfuscated `node -e` downloader vs a `node-gyp rebuild`).
So the expected best use is **method 6** (or a cascade where Laya reads only the releases that carry
changed text), not method 5. The test must be able to show either outcome.

**Justifying the dependency.** Laya is adopted only if, with the bootstrap interval excluding zero,
method 5 or 6 beats the **best of methods 2–4** on macro recall at the noise budget, without worse noise.
Beating only the rule scorer is not enough, because a tabular model with no 1.7 GB download would do that
too. Cost is reported next to it: model size, peak RSS, warm and cold latency on our 4-CPU machine, and
how many releases per scan reach Laya. The previous run's 3.0 s median per 3 × 512-token call is the
reference.

### 3.5 Fine-tuning protocol (Laya's own recipe)

1. Write `train.jsonl` / `calib.jsonl` / `test.jsonl` per fold in the shape laya-train and laya-evals
   both read (`state`, `questions`, `expected`, plus `tags: [family]`).
2. `laya-train --data train.jsonl --base english --max-len 1024 --head-max-len 256 --loss soft-ce
   --shuffle-options --dry-run`. Require zero `options_beyond_max_len` and zero truncated states, and
   record the optimizer-update budget. Repeat with `--base multilingual` (smaller, 1024 native) as a
   second arm.
3. **Positive control**: the same run on a copy with `label=<answer>;` prepended. If it does not reach
   near 1.0, the budget or setup is wrong, and the real run's result is not interpreted.
4. Real runs: at least 3 seeds per arm, raising epochs to compensate for a small dataset (fine-tuning
   guide). Read the calibration report and collapse warnings. On a GPU (the Kaggle 2xT4 notebook), not on
   our CPU-only machine; `--freeze-encoder` on CPU is a documented weaker fallback and is labelled as such
   if used.
5. **Order and wording checks** on the test set: answer `triage` under all 3 `option_order` rotations and
   report the flip rate. Report the rotation-averaged probabilities as the decision. For `script_intent`,
   compare the `A`/`B` labels with the default `false`/`true` and with a reworded instruction. Report
   disagreement.
6. `laya-evals run test.jsonl --model ./ckpt --slice … --json report.json` for accuracy, ECE, Brier and
   AURC. Then export to ONNX (`laya-ts/scripts/export_onnx.py` or receptron's `export/export_onnx.py`) and
   re-run with `laya-evals run --onnx … --calibration …` so the Node runtime's numbers are the ones gated.
7. Pre-register steps 1–6, the metrics in 3.3 and the adoption rule in 3.4, and commit them before any
   model sees test data, as the previous experiment did.

### 3.6 Staged adoption (shadow until the gates pass)

1. **Shadow.** Wire Laya beside the rule scorer, behind a flag. It logs to the findings store, never to a
   finding the user sees. Log the question-schema version, checkpoint hash, calibration file hash, per-option
   probabilities, `answer_confidence`, latency, errors, the incumbent's score, and later the outcome
   (advisory or not).
2. **Compare.** Report disagreements per family and per signal type, with an explicit "unknown" bucket.
   Review a sample by hand.
3. **Threshold.** Set from held-out evidence at a noise budget. Record the owner and what re-triggers
   evaluation: a new checkpoint, a question change or a new family.
4. **Bounded promotion**, only after 3.4's rule passes. Laya may *add a "review" hint* on releases that
   carry changed text, capped per scan. It never produces "critical" on its own (FEEDS-AND-DETECTORS:
   "Never 'critical' without a known-bad match"). Name the rollback condition (for example, noise per
   control repo above budget over a week). Keep sampling promoted decisions.

### 3.7 What would make us stop early

- The text arm has too few positive families to evaluate. Then Laya cannot be tested fairly yet. The
  blocker is data (manifests of unpublished releases, as the `data-ml/model` report already says), not the
  model.
- The positive control fails, or seeds disagree on takeoff. Fix the setup before reading results.
- GBDT on facts matches stacked GBDT + Laya within the bootstrap interval. Ship nothing new from this line.
  The tabular model answers the numeric question, and Laya's 1.7 GB is not justified.
