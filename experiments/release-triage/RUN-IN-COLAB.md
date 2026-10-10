# Running the Laya release-triage notebook in Google Colab (Pro+)

The notebook runs the experiment fixed in [PREREGISTRATION.md](PREREGISTRATION.md): it fine-tunes Laya and
compares it with the baselines. You need Colab Pro+ (Pro works too, without background execution) and a Google
Drive with room for six fine-tuned checkpoints. No password or API key is required. Two Colab secrets are
optional: `GH_TOKEN` (live progress on GitHub) and `HF_TOKEN` (Hugging Face download rate limits).

## Steps (Colab Pro+)

1. **Open the notebook in Colab:**
   https://colab.research.google.com/github/kambasana/56/blob/research/laya-proper/experiments/release-triage/colab/laya_release_triage.ipynb
2. **Runtime type.** *Runtime → Change runtime type*:
   - *Hardware accelerator*: **A100 GPU** (L4 works but is slower; avoid T4, see *Choosing a runtime*).
   - **High-RAM**, if that option is offered.
   - If the dialog shows a **Background execution** toggle, turn it on. (The notebook cannot check this setting;
     it prints a reminder.)
   - *Save*.
3. **Optional secrets.** Key icon (*Secrets*) in the left bar: add `GH_TOKEN` and/or `HF_TOKEN` (see the sections
   below) and turn on **Notebook access** for each. Without them the run is the same and saves to Drive only.
4. **Settings form.** The notebook has two code cells: the **Settings** form and the **▶ Run** cell. Normally nothing
   in the form needs changing:
   - `RUN_TAG`: empty continues the run recorded on Drive (or starts one); a tag continues or starts that run.
   - `RETRY_FAILED` (off): retry runs recorded as failed.
   - `AUTO_RELEASE_RUNTIME` (on): release the GPU at the end, once everything is saved and verified on Drive.
   - `PUSH_PROGRESS` (on): live progress to GitHub, if `GH_TOKEN` exists.
   - `SMOKE` (off): a quick end-to-end check on a tiny slice under its own `smoke-...` tag; not the experiment.
   - `ALLOW_REMOTE_CONTROL` (on): lets the assistant pause, stop or retry runs through GitHub (see *Remote control by
     the assistant*). It needs `GH_TOKEN`; untick it to switch it off.
5. **Run all.** *Runtime → Run all* (or ▶ on Settings, then ▶ on Run). Allow Google Drive access when asked (and
   *Grant access* to a secret if Colab asks). The Run cell downloads the notebook's code (`colab/lrt_runner.py`) at
   a pinned commit and checks its sha256 before running it; if the check fails, nothing runs.
6. **Close the tab if you like.** Once the control panel under the Run cell shows the first run *training*, you may
   close the tab: with Pro+ background execution the session keeps running. Training runs in a detached process on
   the VM, independent of the browser. Without background execution, keep the tab open and the computer awake.
7. **The end.** The Finish step syncs everything to Drive, verifies it (sha256, and `results.zip` is opened and
   checked), pushes a last progress update to GitHub, flushes and unmounts Drive and then **releases the runtime**
   (`AUTO_RELEASE_RUNTIME`), so no more compute units are spent. The notebook then shows as disconnected; that is
   expected. If any sync or check failed, the runtime is **not** released and the panel says why: fix it (e.g. free
   Drive space) and run the Run cell again (finished work is kept), or release it yourself (*Runtime → Disconnect and
   delete runtime*). If a step stops with an error before the end, the runtime is not released either: release it
   yourself.
8. **Send back** `MyDrive/laya-release-triage/<run tag>/results.zip` (or the `results` folder).

The run fine-tunes eight models and scores two zero-shot references, in this order: the two positive controls,
fine-tuned typed-decisions and English at seed 0, then seeds 1 and 2, and last the two zero-shot references. Each
fine-tune trains for 6 epochs over 6,468 training items (from `laya-train --dry-run` on this dataset: 6,868 items,
400 kept aside for laya's calibration). Laya's docs report about 4–5 hours for about 120,000 item-passes on two T4s;
an A100 is faster, so expect very roughly 3–6 hours for the ~310,000 item-passes here. This is an estimate, not a
measurement; the control panel shows a measured ETA once training starts. A run that fails is retried up to 3 times
(out of GPU memory: smaller micro-batch, same effective batch; network error: wait and retry; stalled for 30
minutes: killed and restarted); any other error is recorded with its traceback and the next run starts.

## What you'll see

One **control panel** under the Run cell, updated in place (about once a second); nothing else scrolls by. From top
to bottom:

- **Header:** the run tag, the GPU (with live utilisation and memory once training runs) and the precision, and four
  indicators, each a coloured dot *and* a word (OK, attention, problem, off): **Drive** (last sync, or the sync
  error), **GitHub** (last push, or why it is off), **Heartbeat** (green while the ~2-minute heartbeats arrive,
  amber when one is late, red when they stopped) and **Remote control** (listening, paused, or off and why).
- **Overall** progress bar with a rough ETA for all runs (measured from the training speed once training starts)
  and the elapsed time.
- **Stepper:** Setup → GPU → Storage → Install → Data → Checks → Models → Training runs → Verdict → Finish, each
  marked done ✓, working ▶, waiting ○, failed ✗ or stopped ■.
- **What's happening now**, in plain words (for example "Training F-EN-s1 (fine-tune, English, seed 1): epoch 3
  of 6, step 40 of 102, loss 0.3121"), and below it the last remote-control command and its acknowledgement.
- **Current run** progress bar: epoch, step, loss, ETA of this run, and a warning when the training log has been
  quiet for a few minutes.
- **Runs table:** the ten runs in their order, each with a plain description, status (pending, running, retrying,
  done, failed, interrupted, skipped), attempt, epoch and, once scored, its headline number.
- **Errors and notices:** only when there is something to show. Each error says what failed and where the full
  traceback is (`state.json`, `results/progress.jsonl`, `results/logs/`). Retries (out of memory, network) appear
  as notices.
- **Log** (collapsed): the last 200 lines the steps printed; every line is also in `results/logs/console.log`.
- **Results** at the end: the verdict, the summary table and where `results.zip` is.

Without ipywidgets (it is built into Colab, so only on other Jupyter front ends) the panel falls back to a compact
text status printed at most once a minute and whenever a step or run changes. With `GH_TOKEN`, a static copy of
the panel (`dashboard.html`, secrets removed, paths shortened) is pushed with every heartbeat, next to
`progress.jsonl`.

If the panel stops moving after the browser reconnected, press ■ on the Run cell and then ▶ again: training keeps
running in the background and the panel is redrawn from the ledger.

## Where things are written

- **Local disk** (`/content/work`, fast): the dataset copy, the base checkpoints, laya-train's output, and the run
  folder (`/content/work/out/<run tag>/`: ledger, results, logs, checkpoints). Everything is written here first.
- **Google Drive** (`MyDrive/laya-release-triage/<run tag>/`, durable): a copy of the run folder. Each file is
  written to a temporary name and then renamed, so a file on Drive is never half-written. Small files (ledger,
  heartbeat, results, logs) are synced every ~2 minutes; everything, checkpoints included, after every stage and
  every run, and once more at the end. Drive is mounted with `force_remount=True` and flushed and unmounted
  (`drive.flush_and_unmount()`) at the end so every write reaches Drive.
- **Caches on Drive** (`MyDrive/laya-release-triage/cache/`): `HF_HOME` (the base checkpoints at the pinned
  revision, kept as a snapshot with a sha256 manifest; a later session copies and re-verifies it instead of
  downloading, and also checks the model files against the sha256 the Hub reports for that revision when the Hub
  is reachable) and the pip download cache used by `%pip install --cache-dir` (exact version pins; every installed
  version is checked against its pin).

## If Colab disconnects: resume

1. *Runtime → Reconnect* (or *Runtime → Restart session* if Colab asks for it). If you get to choose, pick the same
   GPU type as before.
2. *Runtime → Run all*. Allow Google Drive access again when asked. Leave `RUN_TAG` empty (or set it to the same tag).

Nothing finished is redone. On a new VM the notebook first restores the ledger (`state.json`), results, logs and
job files from Drive; on *Run all* each done run's files are checked (sha256) and the run is skipped. What a
disconnect can cost:

- **If the whole runtime was lost** (idle timeout, maximum lifetime, *Disconnect and delete runtime*): the run that
  was training restarts from its base checkpoint. laya 0.4.1 cannot resume a run mid-way (see below), so at most
  that one run's partial training is lost, about one eighth of the training time. A run that had finished
  training but not scoring gets its checkpoint back from Drive. Every finished run is kept, including its trained
  weights (`checkpoints/` on Drive).
- **If only the notebook's kernel restarted, or the browser lost its connection**: training runs in a separate
  background process, which keeps going. *Run all* re-attaches to it; nothing is lost.

Do not use the "keep-alive" auto-clicker scripts posted online: they work around Colab's usage policies, and the
notebook does not need them. Stopping the Run cell does not stop a training process that has already started (that is
what makes it survive a dropped connection). *Runtime → Disconnect and delete runtime* stops everything.

To start a completely new run instead of resuming, type a new `RUN_TAG` in the Settings form, or rename or delete
`MyDrive/laya-release-triage/run_tag.txt`.

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
  The notebook cannot detect whether it is on; it prints a reminder at the start.
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

*Runtime → Change runtime type → Hardware accelerator.* Availability is not guaranteed; take what is offered. Turn on
**High-RAM** too if the dialog offers it: the GPU cell prints the system RAM and recommends High-RAM below about 24 GB.
The GPU, driver, CUDA, torch and RAM are recorded in `env.json`.

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

On a runtime without Google Drive, set `OUTPUT_DIR` in the Settings form to a folder on that VM's persistent disk
(the default is `~/laya-release-triage`), or set the environment variable `LRT_OUT`. The same ledger, resume and
retry logic applies. `GH_TOKEN` is then read from an environment variable of that name instead of a Colab secret.
Copy `results.zip` off the VM when the run is over (it is not released automatically: that only exists on Colab). This document gives no prices: see Google Cloud's own pricing
pages for the machine and GPU you pick.

## Optional: follow the run live on GitHub (GH_TOKEN)

If you add a GitHub token as a Colab secret named `GH_TOKEN` (and `PUSH_PROGRESS` is ticked in the Settings form, the
default), the notebook pushes its progress every ~2 minutes and
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

If the secret is missing, or exists without notebook access, the notebook says which of the two it is and runs with
live progress off.

Revoke the token on GitHub when the run is over (or let it expire after 7 days). The branch and its files stay.

### Optional: a Hugging Face token (HF_TOKEN)

Only useful against anonymous download rate limits. Add a Colab secret named `HF_TOKEN` with a Hugging Face *read*
token, with **Notebook access** on. The notebook sets it as the `HF_TOKEN` environment variable for
`huggingface_hub`, never prints it, and does not pass it to the training processes. Nothing needs editing in the
notebook.

## Remote control by the assistant

Approved by the project owner on 2026-10-10. When `GH_TOKEN` is set and `ALLOW_REMOTE_CONTROL` is ticked (the
default), the notebook checks two files on branch `results/laya-colab`, in the run's folder
`experiments/release-triage/colab-runs/<run tag>/`, about once a minute: `control.json` and `control/latest.json`.
The assistant (or you) can put a command there, for example `{"id": "c-0007", "cmd": "pause"}` or
`{"id": "c-0008", "cmd": "retry", "run": "F-EN-s1"}`; a file can also hold `{"commands": [...]}`.

**What it can do** (nothing else is accepted):

| Command | Effect |
|---|---|
| `pause` / `resume` | Hold before the next run starts (the current run finishes first) / continue. |
| `stop_now` | Stop the current training process at once, mark that run *interrupted* (no attempt used, nothing recorded as failed) and hold. After `resume` (or *Run all*) that run restarts from its base checkpoint. |
| `retry` *run* | Run a failed, interrupted or skipped run again, with fresh attempts. |
| `skip` *run* | Do not run a pending, failed or interrupted run (recorded as *skipped* in `state.json`; `retry` undoes it). |
| `rescore` *run* | Score a finished run again on its kept checkpoint (no re-training; rejected if the checkpoint is not kept). |
| `ping` | Acknowledge with the current step, run and epoch. |
| `dump` | Push the ledger, `env.json`, the last 500 log lines and a GPU snapshot to `dump/<id>/` in the run's folder, with secrets removed and paths shortened. |

Run-level commands take effect only between runs or at a stage boundary (`stop_now` also within a training process),
and only while the Training step runs; after it, only `ping` and `dump` apply.

**What it cannot do:** run code or shell commands, fetch or load any code (the runner stays the pinned, sha256-
checked file), change any setting, rule, threshold, metric, run order, dataset or checkpoint, or read anything other
than these two files. A command with another name, an unexpected field, a malformed id or run, or a file that is not
JSON is **rejected**. Every command, applied or rejected, is acknowledged once in `control-ack.jsonl` next to it
(id, time, result, error), and in the run folder on Drive; an acknowledged id is never applied again, also after a
reconnect. The panel shows the last command and its acknowledgement, and every acknowledgement is in
`progress.jsonl`. The token is used exactly as for live progress: only in the `Authorization` header, never printed
or written.

**How to switch it off:** untick `ALLOW_REMOTE_CONTROL` in the Settings form before *Run all* (or remove the
`GH_TOKEN` secret, or untick `PUSH_PROGRESS`). Nothing is then read from GitHub, and commands are ignored. Pressing ■
on the Run cell stops it too; *Run all* starts it again with the form's setting.

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

Next to `results/`, the run folder on Drive holds `state.json` (the ledger), `heartbeat.json` (the latest heartbeat),
`checkpoints/` (fine-tuned weights), `jobs/` (bookkeeping for a training process in progress),
`control-ack.jsonl` (remote-control acknowledgements, if any) and `results.zip`.
`MyDrive/laya-release-triage/cache/` holds the pip download cache and the verified base-checkpoint snapshot
(`cache/hf/laya-snapshots/`); it can be deleted at any time and is rebuilt when needed.

Nothing in `results/` contains a secret: neither the Hugging Face token nor `GH_TOKEN` is ever written to disk by the
notebook.
