# Running the Laya release-triage notebook in Google Colab

The notebook runs the experiment fixed in [PREREGISTRATION.md](PREREGISTRATION.md): it fine-tunes Laya and
compares it with the baselines. You need a Colab Pro account (for an A100 or L4 GPU) and a Google Drive. You do
not need any password or API key. Two tokens are optional: a Hugging Face token (download rate limits) and a GitHub
token (live progress, see below).

## If Colab disconnects or goes to sleep: resume

1. *Runtime → Reconnect* (or *Runtime → Restart session* if Colab asks for it). If you get to choose, pick the same
   GPU type as before (*Runtime → Change runtime type*).
2. *Runtime → Run all*. Allow Google Drive access again when asked.

Nothing finished is redone. Every result is saved to `MyDrive/laya-release-triage/<run tag>/` as it is produced, and
`state.json` there records which runs are done; on *Run all* each done run's files are checked (sha256) and the run
is skipped. What a disconnect can cost:

- **If the whole runtime was lost** (idle timeout, maximum lifetime, *Disconnect and delete runtime*): the run that
  was training restarts from its base checkpoint. laya 0.4.1 cannot resume a run mid-way (see below), so at most
  that one run's partial training is lost, about one eighth of the training time. Every finished run is kept,
  including its trained weights (`checkpoints/`).
- **If only the notebook's kernel restarted, or the browser lost its connection**: training runs in a separate
  background process, which keeps going. *Run all* re-attaches to it; nothing is lost.

To avoid disconnects: **keep the Colab tab open and in front, and keep the computer awake** while it runs. Colab
treats a session without browser interaction as idle and ends it. Colab Pro+ offers background execution, which
keeps a session running with the tab closed. Do not use the "keep-alive" auto-clicker scripts posted online: they
work around Colab's usage policies, and the notebook does not need them.

Stopping a cell does not stop a training process that has already started (that is what makes it survive a
dropped connection). *Runtime → Disconnect and delete runtime* stops everything.

To start a completely new run instead of resuming, rename or delete `MyDrive/laya-release-triage/run_tag.txt`.

### What Colab does, and what others do about it

- **Idle timeout and lifetime.** Colab ends a session after a period without interaction in the browser, and every
  session after a maximum lifetime. Google's FAQ does not give fixed numbers for paid plans: it says Pro notebooks
  can stay connected for up to 24 hours, that idle timeouts are "relatively lenient", and that durations are not
  guaranteed and idle timeouts may vary. A figure of about 90 minutes of no browser interaction is widely reported
  but is approximate. When the session ends, the VM, its disk and every variable are gone.
  Sources: [Colab FAQ](https://research.google.com/colaboratory/faq.html) (also its *Resource limits* and
  *disallowed activities* sections), the older FAQ text quoted on the
  [fast.ai forum](https://forums.fast.ai/t/colab-now-has-a-paid-subscription-option/63043), and a third-party
  guide that reports the ~90-minute figure as approximate
  ([Apatero](https://apatero.com/blog/keep-google-colab-disconnecting-training-guide-2025)).
- **Background execution** (closing the tab) is a Colab Pro+ feature ([Colab plans](https://colab.research.google.com/signup)).
- **The standard practice** for long training on Colab is: save checkpoints and results to Google Drive often, and
  make every job restartable and idempotent, so that re-running the notebook continues instead of starting over.
  This notebook does that: a ledger on Drive, every stage skipped when its verified outputs exist, and a run that
  was cut off restarted.
- **Auto-clicker "keep-alive" JavaScript** is often posted as a fix. It works around Colab's policies on idle
  sessions (the FAQ lists bypassing its policies among disallowed activities), so it is not used here.

### Why an interrupted run restarts instead of resuming

laya-train 0.4.1 writes `checkpoint_latest/` after every epoch, but only the weights, saved in fp16
(`laya/train.py`: `save_checkpoint` writes `model.safetensors` with `.half()`, plus the config and tokenizer). It
saves no optimizer (AdamW) state, no learning-rate scheduler position, no GradScaler state and no data-order RNG
state, and `laya-train` has no resume option (its flags are listed by `laya/train_cli.py`; none resumes). Starting
again from `checkpoint_latest/` would therefore change the training: a fresh AdamW, a new cosine schedule over the
remaining epochs and a different shuffle order. That would no longer be the pre-registered run, so the notebook
restarts the interrupted run from its base checkpoint instead. Finished runs are never redone.

## Choosing a runtime

*Runtime → Change runtime type → Hardware accelerator.* Availability is not guaranteed; take what is offered:

- **A100**: fastest. Micro-batch 8 × accumulation 8.
- **L4**: works, slower. Micro-batch 4 × accumulation 16.
- **T4**: avoid. It works (Laya trains in fp16 on every GPU), but it is several times slower and may need several
  sessions. The notebook prints a loud warning on it. Micro-batch 4 × accumulation 16.
- **No GPU**: the notebook refuses to start the runs.

The effective batch is 64 and the number of optimizer updates is the same on every GPU (PREREGISTRATION.md). If a
run still runs out of GPU memory, it is retried with half the micro-batch and double the accumulation, so the
effective batch and the update count stay the same. The notebook checks this and logs it.

Precision is laya's own choice and is recorded, not changed: laya-train 0.4.1 trains with fp16 autocast and a
gradient scaler on every CUDA GPU; it has no bf16 or precision option. Scoring uses bf16 autocast on A100 and L4
and fp16 on T4 (laya's `laya.load`). The GPU, its memory, the batch split, the precision and the wall time are
recorded for every run (`train_<run>.json`, `load_<run>.json`, `env.json`) and in the heartbeat.

The notebook prints a measured ETA once training starts. A rough budget, which is an estimate and not a measurement,
is 3–6 hours on an A100 for all runs. Expect longer on an L4, and much longer on a T4.

### Optional: a hosted runtime (no idle timeout from the browser)

Instead of Colab's own VMs you can run the same notebook on a VM in your own Google Cloud project. It keeps
running without an open browser tab, so the idle-timeout problem goes away, but **it is billed to your Google Cloud
account**, outside Colab Pro. You choose:

- **Colab Enterprise** (in the Google Cloud console). Runtimes there shut down after 180 minutes idle by default.
  You can change that time, or turn it off, when you create the runtime template; it cannot be changed afterwards
  ([idle shutdown](https://cloud.google.com/colab/docs/idle-shutdown),
  [runtimes and templates](https://cloud.google.com/colab/docs/runtimes)).
- **A custom GCE VM through Colab's *Connect* menu**: Google deprecated new deployments of this option on
  21 March 2025; existing VMs can still connect. Such a VM cannot mount Google Drive, and you must stop the VM
  yourself when finished ([Colab marketplace VMs](https://research.google.com/colaboratory/marketplace.html)).

On a runtime without Google Drive, set `OUTPUT_DIR` in the Settings cell to a folder on that VM's persistent disk
(the default is `~/laya-release-triage`), or set the environment variable `LRT_OUT`. The same ledger, resume and
retry logic applies. `GH_TOKEN` is then read from an environment variable of that name instead of a Colab secret.
Copy `results.zip` off the VM when the run is over. This document gives no prices: see Google Cloud's own pricing
pages for the machine and GPU you pick.

## Optional: follow the run live on GitHub (GH_TOKEN)

If you add a GitHub token as a Colab secret named `GH_TOKEN`, the notebook pushes its progress every ~2 minutes and
at the end of every stage to branch `results/laya-colab` of `kambasana/56`, under
`experiments/release-triage/colab-runs/<run tag>/`:

- `progress.jsonl`: one line per event: stage start and end, run start, every training loss line laya-train prints
  (run id, epoch, step, loss), elapsed time, GPU name, retries and any error with its full traceback;
- a `heartbeat` line every ~2 minutes: time, current run and attempt, epoch and step, percent done and ETA of the
  run, GPU name, utilisation and memory, minutes since laya-train last wrote to its log, and how many runs are
  done/failed/pending. **If the heartbeats stop, the Colab session has ended or the kernel died**: resume as above.
  (If only the kernel died, the training process may still be running; *Run all* re-attaches to it.)
- `results/*.json` (and `summary.md`): the small result files, as they appear.

The cell prints the link to that folder. Without the secret, nothing changes: the notebook runs and saves to Drive
only, and the heartbeat is still written to `heartbeat.json` and `progress.jsonl` on Drive. The token is read with `google.colab.userdata`, kept in memory, sent only in the `Authorization` header to
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
   - Avoid T4: several times slower (see *Choosing a runtime*).
3. **Optional: add a Hugging Face token.** In the first code cell (Settings), paste a Hugging Face *read* token
   between the quotes of `HF_TOKEN = ""`. This only avoids download rate limits. Leave it empty if you don't
   have one.
4. **Run everything.**
   - Go to *Runtime → Run all*.
   - When asked, allow access to Google Drive. Progress, results and checkpoints are saved in
     `MyDrive/laya-release-triage/<run tag>/`.
   - Keep the tab open and in front, and the computer awake (see *If Colab disconnects* above).
   - The run fine-tunes eight models and scores two zero-shot references, in this order: the two positive
     controls, fine-tuned typed-decisions and English at seed 0, then seeds 1 and 2, and last the two zero-shot
     references. Each fine-tune trains for 6 epochs
     over 6,468 training items (from `laya-train --dry-run` on this dataset: 6,868 items, 400 kept aside for
     laya's calibration), which is about 38,800 item-passes per run and 310,000 in total.
   - Laya's docs report about 4–5 hours for about 120,000 item-passes on two T4s. An A100 is faster, so expect
     very roughly 3–6 hours. This is an estimate, not a measurement, and an L4 takes longer.
   - The run uses Colab compute units for that whole time.
   - If Colab disconnects, reconnect and do *Run all* again (see above). Finished runs are skipped.
   - A run that fails is retried up to 3 times (out of GPU memory: smaller micro-batch, same effective batch;
     network error: wait and retry; stalled for 30 minutes: killed and restarted). Any other error is recorded
     with its traceback, and the notebook moves on to the next run. The summary lists runs that did not finish;
     set `RETRY_FAILED = True` in Settings and *Run all* to retry them.
5. **Send back the results.** The last cell prints a summary table and a `VERDICT` line. Download
   `MyDrive/laya-release-triage/<run tag>/results.zip` and send it back. Sending the `results` folder works too.
   - You do not need to send `checkpoints/` (the fine-tuned weights) or the ONNX export (`onnx_F-…`). They stay
     in your Drive for the shadow stage, if it passes. Six fine-tuned checkpoints are kept; check that your Drive
     has room for them.

## What is in `results/` (what to send back)

| File | What it holds |
|---|---|
| `env.json` | Dataset commit and manifest sha256, package versions, checkpoint revision and sha256, GPU, batch split and precision of every session |
| `validity.json` | Leakage-check result and number of test families with ≥ 5 positives |
| `tokens.json` | How many states each token budget truncates (512 vs 1024) |
| `dryrun_EN.json`, `dryrun_TD.json`, `epochs.json` | `laya-train --dry-run` output and the epoch budget it implies |
| `train_<run>.json`, `logs/train_<run>.log` | Laya's training report (calibration, before/after on calib), plus GPU, precision, micro-batch × accumulation, wall time and attempt; the full log of every attempt |
| `load_<run>.json` | Checkpoint load time, scoring batch, and the precision laya used for scoring |
| `scores_<run>.csv.gz` | Per-release P(likely_malicious) on calib and test, canonical and reversed option order, noul answers |
| `metrics_<run>.json` | Pre-registered metrics per run (per family, macro, alerts, ECE, order check) |
| `evals_<run>.json` | Laya's own evaluation harness on test (accuracy, ECE, Brier, AURC, slices) |
| `verdict.json` | The pass rule applied: P0–P6 per seed, chosen base and seed, outcome |
| `latency.json`, `onnx_export.json` | GPU latency, CPU estimate, ONNX parity and size (if exported) |
| `summary.md` | The summary table, the verdict and an execution table (status, attempts, GPU, batch split, wall time per run) |
| `shipped_checkpoint.json` | Which checkpoint was chosen on calib, its path in `checkpoints/` and its sha256 |
| `progress.jsonl` | Live progress log with heartbeats, retries and errors (also pushed to GitHub when `GH_TOKEN` is set) |
| `run_ledger.json` | A copy of `state.json`: status, attempts, interruptions and errors (with tracebacks) of every run |

Next to `results/`, the run folder holds `state.json` (the ledger), `heartbeat.json` (the latest heartbeat),
`checkpoints/` (fine-tuned weights), `jobs/` (bookkeeping for a training process in progress) and `results.zip`.

Nothing in `results/` contains a secret: neither the Hugging Face token nor `GH_TOKEN` is ever written to disk by the
notebook.
