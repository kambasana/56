# Running the Laya release-triage notebook in Google Colab

The notebook runs the experiment fixed in [PREREGISTRATION.md](PREREGISTRATION.md): it fine-tunes Laya and
compares it with the baselines. You need a Colab Pro account (for an A100 or L4 GPU) and a Google Drive. You do
not need any password or API key. Two tokens are optional: a Hugging Face token (download rate limits) and a GitHub
token (live progress, see the next section).

## Optional: follow the run live on GitHub (GH_TOKEN)

If you add a GitHub token as a Colab secret named `GH_TOKEN`, the notebook pushes its progress every ~2 minutes and
at the end of every stage to branch `results/laya-colab` of `kambasana/56`, under
`experiments/release-triage/colab-runs/<run tag>/`:

- `progress.jsonl`: one line per event: stage start and end, run start, every training loss line laya-train prints
  (run id, epoch, step, loss), elapsed time, GPU name, and any error with its full traceback;
- `results/*.json` (and `summary.md`): the small result files, as they appear.

The cell prints the link to that folder. Without the secret, nothing changes: the notebook runs and saves to Drive
only. The token is read with `google.colab.userdata`, kept in memory, sent only in the `Authorization` header to
`api.github.com` over HTTPS, and never printed, logged or written to disk; no git credentials are created.

**1. Create a fine-grained token (about 2 minutes).**

1. On GitHub, open *Settings → Developer settings → Personal access tokens → Fine-grained tokens*, then
   *Generate new token* (direct link: https://github.com/settings/personal-access-tokens/new).
2. *Token name*: `laya-colab-progress`. *Expiration*: *7 days*.
3. *Resource owner*: `kambasana`. *Repository access*: *Only select repositories* → `kambasana/56`.
4. *Permissions → Repository permissions → Contents*: **Read and write**. Leave every other permission at
   *No access* (*Metadata: Read-only* is added automatically and is required).
5. *Generate token* and copy it (it starts with `github_pat_`). You will not see it again.

**2. Add it to Colab as a secret.**

1. In the open notebook, click the **key icon** (*Secrets*) in the left sidebar.
2. *Add new secret*. *Name*: `GH_TOKEN` (exactly). *Value*: paste the token.
3. Turn on **Notebook access** for that secret (the toggle next to it). Without it the notebook cannot read the
   secret and runs with live progress off.
4. If Colab asks *"Grant access to GH_TOKEN?"* when the notebook starts, click *Grant access*.

Revoke the token on GitHub when the run is over (or let it expire after 7 days). The branch and its files stay.

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
   - The run fine-tunes eight models: two positive controls and six real runs. Each one trains for 6 epochs
     over 6,467 training items (from `laya-train --dry-run` on this dataset: 6,867 items, 400 kept aside for
     laya's calibration), which is about 38,800 item-passes per run and 310,000 in total.
   - Laya's docs report about 4–5 hours for about 120,000 item-passes on two T4s. An A100 is faster, so expect
     very roughly 3–6 hours. This is an estimate, not a measurement, and an L4 takes longer.
   - The run uses Colab compute units for that whole time.
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

| `progress.jsonl` | Live progress log (also pushed to GitHub when `GH_TOKEN` is set) |

Nothing in `results/` contains a secret: neither the Hugging Face token nor `GH_TOKEN` is ever written to disk by the
notebook.
