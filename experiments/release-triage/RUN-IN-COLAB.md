# Running the Laya release-triage notebook in Google Colab

The notebook runs the experiment fixed in [PREREGISTRATION.md](PREREGISTRATION.md): it fine-tunes Laya and
compares it with the baselines. You need a Colab Pro account (for an A100 or L4 GPU) and a Google Drive. You do
not need any password or API key. A Hugging Face token is optional.

## Five steps

1. **Open the notebook in Colab.** Use this link:
   https://colab.research.google.com/github/kambasana/56/blob/research/laya-proper/experiments/release-triage/colab/laya_release_triage.ipynb
2. **Pick a GPU.**
   - Go to *Runtime → Change runtime type → Hardware accelerator: A100 GPU*, then *Save*.
   - L4 works but is slower.
   - Avoid T4: it has no bf16, which Laya's checkpoints use.
3. **Optional: add a Hugging Face token.** In the first code cell (Settings), paste a Hugging Face *read* token
   between the quotes of `HF_TOKEN = ""`. This only avoids download rate limits. Leave it empty if you don't
   have one.
4. **Run everything.**
   - Go to *Runtime → Run all*.
   - When asked, allow access to Google Drive. Progress, results and the chosen checkpoint are saved in
     `MyDrive/laya-release-triage/`.
   - The run fine-tunes eight models and takes several hours.
   - If Colab disconnects, reconnect, pick the same GPU and do *Run all* again. Finished runs are skipped.
5. **Send back the results.** The last cell prints a summary table and a `VERDICT` line. Download
   `MyDrive/laya-release-triage/results.zip` and send it back. Sending the `results` folder works too.
   - You do not need to send the checkpoint (`checkpoint_F-…`) or the ONNX export (`onnx_F-…`). They stay in
     your Drive for the shadow stage, if it passes.

## What is in `results/` (what to send back)

| File | What it holds |
|---|---|
| `env.json` | Dataset commit and manifest sha256, package versions, checkpoint revision and sha256, GPU |
| `validity.json` | Leakage-check result and number of test families with ≥ 5 positives |
| `tokens.json` | How many states each token budget truncates (512 vs 1024) |
| `dryrun_EN.json`, `dryrun_TD.json`, `epochs.json` | `laya-train --dry-run` output and the epoch budget it implies |
| `train_<run>.json`, `logs/train_<run>.log` | Laya's training report (calibration, before/after on calib) and the full log |
| `scores_<run>.csv.gz` | Per-release P(likely_malicious) on calib and test, canonical and reversed option order, noul answers |
| `metrics_<run>.json` | Pre-registered metrics per run (per family, macro, alerts, ECE, order check) |
| `evals_<run>.json` | Laya's own evaluation harness on test (accuracy, ECE, Brier, AURC, slices) |
| `verdict.json` | The pass rule applied: P0–P6 per seed, chosen base and seed, outcome |
| `latency.json`, `onnx_export.json` | GPU latency, CPU estimate, ONNX parity and size (if exported) |
| `summary.md` | The summary table and the verdict |

Nothing in `results/` contains a secret: the Hugging Face token is never written to disk by the notebook.
