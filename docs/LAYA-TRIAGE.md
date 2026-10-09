<!-- Written by hand from experiments/laya-triage/results/report.json and laya-run.json, which evaluate.ts and run-laya.ts generate. Every number below comes from those files. -->
# Laya burst triage: does a zero-shot decision model fix the burst rule's false alarms?

**Question.** The account-level burst rule (≥ 5 distinct packages from one npm account within 6 h,
[ACCOUNT-PROOF.md](ACCOUNT-PROOF.md)) warns early for qix and every attributable Shai-Hulud account,
but raises about 2.1 false alarms per control account-month against a 0.1 limit. Can a zero-shot
[Laya](https://huggingface.co/convaiinnovations/laya) triage step (via `@receptron/laya`, ONNX on
CPU) on each burst cut false alarms to ≤ 0.1 while keeping the early warnings? The method, split,
threshold rule, baseline and pass rule were committed before any model run in
[LAYA-PREREGISTRATION.md](../blastradius/test/replay/account/LAYA-PREREGISTRATION.md) (commit b0c9544).

## Verdict: FAIL

> **Read with [LAYA-USAGE.md](LAYA-USAGE.md).** This run used Laya zero-shot, with truncated states, an uncalibrated noul and a recall gate built on one incident family. Laya's own docs advise against all of these. The FAIL applies to that configuration only. LAYA-USAGE.md audits the run and sets out a fine-tuned design, evaluated per family against tabular baselines.

| Method (held-out test) | False alarms / test-control account-month (≤ 0.1) | qix warned before T0 | Shai-Hulud accounts warned before T0 (≥ 20/25) | Pass |
|---|---|---|---|---|
| No triage (burst rule alone) | 1.873 (79 episodes / 42.18 account-months) | yes, 1.1 h | 25/25 | no |
| Plain-rules baseline | 1.707 (72) | yes, 1.1 h | 18/25 | no |
| **Laya, P(takeover) ≥ τ = 0.7154** | **0.427 (18)** | yes, 1.1 h | **13/25** | **no** |

Laya fails two of the three pre-registered conditions. It cuts false alarms by 77 % (1.873 → 0.427),
still 4× the limit, and it drops 12 of the 25 Shai-Hulud early warnings, so it fails both the
noise and the recall condition. The plain-rules baseline fails too (1.707, 18/25). Laya beats the
baseline on noise but not on recall, so by the pre-registered rule it is **not worth the 1.7 GB
dependency**. The burst rule stays what ACCOUNT-PROOF.md concluded: not a standalone alert.

What the scores show (descriptive): Laya's score does separate the classes somewhat. ROC AUC is 0.859
for P(takeover) and 0.914 for the `kind = account_takeover` probability, over 3,266 control triage
points versus the 32 qualifying incident points. But the scores are compressed: the control median is
0.574 and the 95th percentile 0.664, while the incident median is 0.744 and the minimum 0.526. On
microsoft1es's thousands of bursts the tail reaches past any threshold that keeps the worm. One test
account, microsoft1es, gives 16 of the 18 test false alarms. That is not a reason to drop it: it is
exactly the kind of release automation the triage must handle.

## Setup (as pre-registered)

- **Data**: the account proof's recorded events (`blastradius/test/replay/account/data`), period
  2025-06-01..2025-12-31, the same burst rule and attribution. Bursts are triaged at most hourly per
  account. That gives 3,354 triaged firings: 157 calibration control, 3,109 test control, and 88 on
  incident accounts, of which 32 *qualify* (the window holds a bad-version publish, before T0).
- **State per burst** (JSON, facts knowable at the firing time only): the window, 14-day account
  history, aggregates (publisher new to package, dormant > 90 d, first releases, bump types,
  sole-maintainer count…) and up to 8 packages with previous version, previous publishers and
  maintainer count. No provenance, install-script or tarball fields. They are not in the recorded
  data, and npm deleted the malicious manifests, so they could only be recorded for the controls,
  which would be a hindsight leak.
- **Model**: `@receptron/laya` 0.1.2 (onnxruntime-node 1.30.0, CPU). ONNX bundle
  `receptron/laya-onnx` at revision `68f27dfe5a27a54fb2b1fefc432f43f972e90868`, an export of
  convaiinnovations/laya (English checkpoint, 421M parameters). sha256 `laya.onnx`
  `a874eb25…dba1e`, `laya.onnx.data` `48774636…3aba` (full hashes in `questions.ts`; they match the
  Hugging Face LFS ids and are checked at load). Zero-shot, three questions in one call (`takeover`
  noul = decision score; `kind` choice and `risk` score are descriptive only), worded exactly as
  pre-registered.
- **Split**: controls sorted by sha256(name). Calibration: cwmma, ljharb, isaacs, types,
  aws-sdk-bot. Test: oss-bot, sindresorhus, wooorm, microsoft1es, xtuc, GitHub Actions. All 26
  incident accounts are test only.
- **Threshold**: the smallest calibration score with calibration false alarms ≤ 0.1 per
  account-month gives τ = 0.7154 (calibration 3 episodes / 35.15 account-months = 0.085).
- **Baseline**: pass when any package has a publisher new to it, or ≥ half the packages were dormant
  > 90 days.

## Per account

| Control | Split | Proof episodes | No triage | Baseline | Laya |
|---|---|---|---|---|---|
| cwmma | calibration | 0 | 0 | 0 | 0 |
| ljharb | calibration | 0 | 0 | 0 | 0 |
| isaacs | calibration | 8 | 8 | 4 | 0 |
| types | calibration | 13 | 13 | 10 | 0 |
| aws-sdk-bot | calibration | 63 | 82 | 13 | 3 |
| oss-bot | test | 0 | 0 | 0 | 0 |
| sindresorhus | test | 11 | 11 | 10 | 0 |
| wooorm | test | 1 | 1 | 1 | 1 |
| microsoft1es | test | 34 | 34 | 24 | 16 |
| xtuc | test | 0 | 0 | 0 | 0 |
| GitHub Actions | test | 32 | 33 | 37 | 1 |

Incident leads (hours before T0, "no" = not warned before T0):

| Account | Incident | No triage | Baseline | Laya |
|---|---|---|---|---|
| qix | chalk-debug-2025 | 1.1 | 1.1 | 1.1 |
| aqz23678 | shai-hulud-1 | 44.3 | no | 44.3 |
| art-ws | shai-hulud-1 | 32.4 | no | no |
| mohit_ahirwal | shai-hulud-1 | 32.7 | 32.7 | no |
| scttcper | shai-hulud-1 | 3.8 | no | 3.8 |
| shaneholloman | shai-hulud-1 | 34.4 | no | no |
| teselagen-admin | shai-hulud-1 | 31.1 | 31.1 | no |
| thangved02 | shai-hulud-1 | 44.6 | no | 44.6 |
| vamsi3293 | shai-hulud-1 | 36.2 | 36.2 | 36.2 |
| alexadark | shai-hulud-2 | 7 | 7 | no |
| barbarosso | shai-hulud-2 | 5.6 | 5.6 | 5.6 |
| baroned1707 | shai-hulud-2 | 8.9 | 8.9 | 8.9 |
| dustintownsend | shai-hulud-2 | 4.9 | 4.9 | no |
| linux_china | shai-hulud-2 | 7.8 | 7.8 | no |
| osmanekrem | shai-hulud-2 | 12.3 | no | no |
| productdevbook | shai-hulud-2 | 6.1 | 6.1 | no |
| prosenjit-itobuz | shai-hulud-2 | 12.4 | 12.4 | 12.4 |
| pruthvi21 | shai-hulud-2 | 10.4 | 10.4 | 10.4 |
| sameepsi | shai-hulud-2 | 6.2 | 6.2 | 6.2 |
| scgscorp | shai-hulud-2 | 8.3 | 8.3 | no |
| tiaanduplessis | shai-hulud-2 | 5.9 | 5.9 | 5.9 |
| trigo-admin | shai-hulud-2 | 4.9 | 4.9 | no |
| vasudev_arya | shai-hulud-2 | 11 | 11 | no |
| victoriaxaoquyet | shai-hulud-2 | 6.8 | 6.8 | 6.8 |
| xiaojiannpm | shai-hulud-2 | 8.2 | no | 8.2 |
| zeallat | shai-hulud-2 | 0.2 | 0.2 | 0.2 |

qix episodes outside 2025-09-08: no triage 2, baseline 1, Laya 2.

## Cost

- **Latency per decision** (one `systemOne` call, 3 questions, 3 × 512-token sequences): median
  3.0 s, p95 8.6 s, max 20.7 s over all 3,354 decisions (3.84 h of compute). The fastest decile is
  about 2.8 s. The machine is a 4-core Xeon VM shared with other jobs, so the tail is contention.
  This is about 20× the README's ~140 ms figure (Apple silicon, short states). Every state here fills
  the 512-token limit.
- **Memory**: RSS 1,606 MiB after load, peak 2,145 MiB (second run segment). Load time 13.1 s.
- **Disk**: 1.69 GB bundle (`laya.onnx.data` 1,685,258,240 bytes), plus 302 MB of node_modules for
  the experiment package (onnxruntime-node binaries).

## Deviations from the pre-registration and other notes

1. **Cadence sanity check failed for two controls; sensitivity analysis added.** The preregistration
   required "no triage" at the hourly cadence to reproduce the proof's episodes. It does not for
   aws-sdk-bot (82 vs 63) and GitHub Actions (33 vs 32). It also gives art-ws a 32.4 h lead instead
   of 35.7 h. The cause: episodes merge only over *triaged* firings, so a firing skipped by the
   cadence no longer bridges a gap shorter than 24 h. For the same reason, a filter can *raise* the
   episode count (the baseline gives GitHub Actions 37). The primary numbers above follow the
   preregistration as written. A sensitivity analysis that was **not pre-registered** carries each
   triage decision forward to every raw firing until the next triaged one. It reproduces the proof
   exactly for all 11 controls (no triage 84 + 78 episodes). It leaves the verdict unchanged:
   Laya 0.427 / 1.1 h / 13 of 25; baseline 1.707 / 1.1 h / 18 of 25; no triage 1.849 / 25 of 25.
2. **Truncation.** The cap of 8 listed packages was meant to keep the aggregates inside the model's
   512 tokens, and it does: up to `aggregates` the state fits in all 3,354 states (max 256 tokens,
   with 414 available for the noul question). But no state fits whole, because the package list is
   always cut after about 2–4 packages (`results/tokens.json`, `check-tokens.ts`). The `input_tokens`
   column is the sum over the three question sequences (1,536 = 3 × 512). The `atMaxLen` field in
   `laya-run.json` compares that sum with 512 and is therefore always true, so ignore it.
3. **Per-package facts** are taken at each package's *first* publish inside the window (the
   preregistration said "this publish"; a package can be published twice in a window).
   `publisher_new_to_package` is true for a first release, because there is no earlier publisher.
   That follows the definition as written, and it applies to the baseline as well.
4. **Run mechanics** (no effect on scores, which are deterministic per state). The scoring ran in two
   segments, because the first was stopped by a 2 h job limit after 1,974 decisions. The resumed
   segment scored the remaining incident states first. Only the second segment wrote
   `laya-run.json`, so memory and load time come from it, while latency comes from the CSV for all
   decisions. During the first segment the questions were moved verbatim from `run-laya.ts` to
   `questions.ts`.
5. **Install.** `onnxruntime-node`'s postinstall tries to download optional CUDA binaries from
   api.nuget.org, which the sandbox's proxy dropped. It was installed with
   `ONNXRUNTIME_NODE_INSTALL=skip`. The CPU binaries ship in the npm package. The bundle was fetched
   with curl from the pinned revision URL, verified by sha256 and loaded with `modelDir` (the same
   files that `Laya.load({ revision })` would fetch).

## Reproduce

```sh
cd blastradius && npm ci                     # product deps (the states reuse the account proof code)
cd ../experiments/laya-triage
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npx tsx build-states.ts                      # results/states.jsonl, sha256 must equal results/states.sha256
# model: either LAYA_MODEL_DIR=<dir with the pinned bundle>, or let Laya download revision 68f27dfe…
LAYA_MODEL_DIR=… npx tsx run-laya.ts         # ~3-4 h on 4 CPU cores; resumable; writes results/laya-scores.csv
npx tsx evaluate.ts                          # offline: results/report.json and report.md from the CSV
```

`evaluate.ts` needs only the committed `laya-scores.csv` and the regenerated states. The pass/fail
numbers can be checked without the model. Nothing in `blastradius/` imports `experiments/`.
