"""Writes colab/laya_release_triage.ipynb (run: python -I colab/make_notebook.py --data-ref ... --manifest-sha256 ...
--runner-ref ...).

The notebook has two code cells: the Settings form and the Run cell. Every stage lives in colab/lrt_runner.py, which
the Run cell downloads from GitHub at RUNNER_REF (a commit) and checks against RUNNER_SHA256 before importing it.
DATA_REF and MANIFEST_SHA256 come from data/laya/MANIFEST.json and the commit that holds it; RUNNER_REF is a commit
that holds colab/lrt_runner.py exactly as it is in this working tree (checked with git when available):
    python -I colab/make_notebook.py --data-ref <commit> --manifest-sha256 <sha256 of MANIFEST.json> --runner-ref <commit>
Edit the stages in lrt_runner.py, commit, then regenerate with that commit as --runner-ref and commit the notebook.
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import subprocess

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

HERE = pathlib.Path(__file__).resolve().parent
RUNNER = HERE / "lrt_runner.py"
RUNNER_REPO_PATH = "experiments/release-triage/colab/lrt_runner.py"

INTRO = """# Laya release triage: fine-tuned Laya vs. tabular and text baselines

This notebook runs the experiment fixed in
[PREREGISTRATION.md](https://github.com/kambasana/56/blob/research/laya-proper/experiments/release-triage/PREREGISTRATION.md).
Step by step instructions: [RUN-IN-COLAB.md](https://github.com/kambasana/56/blob/research/laya-proper/experiments/release-triage/RUN-IN-COLAB.md).

**Before you run it** (Colab Pro+):

1. *Runtime → Change runtime type*: **A100 GPU**, and **High-RAM** if that option is offered. If the dialog shows a
   *Background execution* toggle, turn it on.
2. Optional secrets (key icon in the left bar, each with **Notebook access** on): `GH_TOKEN` (live progress on
   GitHub), `HF_TOKEN` (Hugging Face read token, only against download rate limits).
3. Options are in the **Settings** form below (no code edits needed).
4. *Runtime → Run all* (or press ▶ on Settings, then on **Run**), and allow Google Drive access.

**What you see:** one control panel under the Run cell: an overall progress bar with an ETA, the ten steps (Setup →
GPU → Storage → Install → Data → Checks → Models → Training runs → Verdict → Finish), the current run's progress, a
table of the ten runs, a plain-language line saying what is happening now, Drive / GitHub / heartbeat indicators,
any errors (with where the full traceback is), a collapsible log, and at the end the verdict and the summary table.

Once the panel shows the first run training, you may close the tab (with Pro+ background execution). Training runs
in a detached process on the VM, independent of the browser. Everything is written to the VM's fast local disk
(`/content/work`) and copied to `MyDrive/laya-release-triage/<run tag>/` (write to a temporary file, then rename)
after every stage and run, and small files every ~2 minutes. At the end the notebook syncs and verifies everything
on Drive (sha256, including `results.zip`), pushes a last progress update to GitHub, flushes and unmounts Drive and
then, if `AUTO_RELEASE_RUNTIME` is on, **releases the runtime so no more compute units are spent**. If anything failed
to sync or verify, the runtime is kept and the panel says why.

**Resume after a disconnect:** *Runtime → Reconnect* (same GPU type if offered), then *Runtime → Run all* (or ▶ on
Run). Finished runs are verified (sha256) and skipped; a training process that is still alive is re-attached and the
panel is redrawn from the ledger. If the panel stopped moving after the browser reconnected, press ■ on the Run cell
and then ▶ again: training keeps running in the background. A run that was mid-training when the VM was lost
restarts from its base checkpoint (laya 0.4.1 cannot resume a run mid-way).

The code of every stage is in [`colab/lrt_runner.py`](https://github.com/kambasana/56/blob/research/laya-proper/experiments/release-triage/colab/lrt_runner.py),
downloaded at a pinned commit and checked by sha256 before it runs. This is execution and presentation plumbing
only: no experiment rule, data, threshold or pass condition depends on it.

**Remote control by the assistant** (owner-approved; switch off with `ALLOW_REMOTE_CONTROL` in Settings): with
`GH_TOKEN` set, the notebook checks `control.json` in its run folder on branch `results/laya-colab` about once a
minute and accepts only pause / resume (between runs), stop_now, retry / skip / rescore one run, ping and a
diagnostic dump. It cannot run code or change any rule, data or setting; every command is acknowledged in
`control-ack.jsonl` and shown in the panel. Details: RUN-IN-COLAB.md, "Remote control by the assistant".

**Send back:** `results.zip` (or the `results` folder) from `MyDrive/laya-release-triage/<run tag>/`.

Shai-Hulud is one incident family among many here. Every recall figure is a macro average over families, and
no gate names a family."""

FORM = """#@title Settings { display-mode: "form" }
#@markdown Set the options here, then *Runtime → Run all*. Nothing else needs editing.
#@markdown
#@markdown **RUN_TAG**: leave empty to continue the run recorded in `MyDrive/laya-release-triage/run_tag.txt` (a new one is started the first time). A tag continues or starts that run.
RUN_TAG = ""  #@param {type:"string"}
#@markdown **RETRY_FAILED**: give runs recorded as failed another 3 attempts.
RETRY_FAILED = False  #@param {type:"boolean"}
#@markdown **AUTO_RELEASE_RUNTIME**: at the very end, once everything is synced to Drive and verified, release the GPU runtime so no more compute units are spent.
AUTO_RELEASE_RUNTIME = True  #@param {type:"boolean"}
#@markdown **PUSH_PROGRESS**: push live progress to GitHub (only if the `GH_TOKEN` secret exists and has notebook access).
PUSH_PROGRESS = True  #@param {type:"boolean"}
#@markdown **SMOKE**: quick end-to-end check on a tiny slice (1 epoch) under its own `smoke-...` run tag. Not the experiment.
SMOKE = False  #@param {type:"boolean"}
#@markdown **ALLOW_REMOTE_CONTROL**: let the assistant send a few fixed commands through the results branch on GitHub (pause/resume between runs, stop now, retry/skip/rescore one run, ping, diagnostic dump). No code, no shell, no change to any rule, data or setting; every command is acknowledged on GitHub. Needs `GH_TOKEN`. Untick to switch it off.
ALLOW_REMOTE_CONTROL = True  #@param {type:"boolean"}
#@markdown ---
#@markdown Normally left as they are:
EXPORT_ONNX = True  #@param {type:"boolean"}
RUN_POSITIVE_CONTROL = True  #@param {type:"boolean"}
RUN_FINETUNE = True  #@param {type:"boolean"}
RUN_ZERO_SHOT = True  #@param {type:"boolean"}
USE_DRIVE = True  #@param {type:"boolean"}
STALL_MINUTES = 30  #@param {type:"integer"}
OUTPUT_DIR = ""  #@param {type:"string"}"""

RUN = '''#@title ▶ Run { display-mode: "form" }
#@markdown Runs every step in order under one control panel (progress, current run, runs table, errors, log and, at
#@markdown the end, the verdict). Running this cell again resumes: finished work is verified and kept, and a training
#@markdown process that is still running is re-attached. If the panel stops moving after a reconnect: ■ then ▶.
# Pinned inputs (PREREGISTRATION.md): the dataset commit and the sha256 of its MANIFEST.json, and the runner module
# colab/lrt_runner.py (every stage's code) at a fixed commit, checked against its sha256 before it is imported.
DATA_REF = "__DATA_REF__"
MANIFEST_SHA256 = "__MANIFEST_SHA256__"
RUNNER_REF = "__RUNNER_REF__"
RUNNER_SHA256 = "__RUNNER_SHA256__"
import hashlib, os, pathlib, sys, tempfile, time, types, urllib.request


def _lrt_runner():
    """colab/lrt_runner.py at RUNNER_REF: a verified local copy if there is one, else downloaded; sha256-checked."""
    local = pathlib.Path(tempfile.gettempdir()) / f"lrt_runner-{RUNNER_SHA256[:16]}.py"
    src = os.environ.get("LRT_RUNNER_FILE")   # tests only: a local copy, held to the same sha256
    data = pathlib.Path(src or local).read_bytes() if (src or local.exists()) else b""
    if hashlib.sha256(data).hexdigest() != RUNNER_SHA256 and not src:
        url = f"https://raw.githubusercontent.com/kambasana/56/{RUNNER_REF}/experiments/release-triage/colab/lrt_runner.py"
        for i in range(4):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = r.read()
                break
            except Exception as e:
                if i == 3:
                    raise SystemExit(f"could not download the runner ({type(e).__name__}); check the connection and "
                                     "run this cell again")
                time.sleep(3 * (i + 1))
    if hashlib.sha256(data).hexdigest() != RUNNER_SHA256:
        raise SystemExit("colab/lrt_runner.py does not match its pinned sha256: nothing was run")
    local.write_bytes(data)
    mod = types.ModuleType("lrt_runner")
    mod.__file__ = str(local)
    sys.modules["lrt_runner"] = mod
    exec(compile(data, str(local), "exec"), mod.__dict__)   # exactly the bytes that were verified
    return mod


_lrt_runner().run(globals(), data_ref=DATA_REF, manifest_sha256=MANIFEST_SHA256)'''


def runner_sha256() -> str:
    return hashlib.sha256(RUNNER.read_bytes()).hexdigest()


def build(data_ref: str, manifest_sha: str, runner_ref: str, runner_sha: str) -> nbformat.NotebookNode:
    for name, v, n in (("data ref", data_ref, 40), ("manifest sha256", manifest_sha, 64), ("runner ref", runner_ref, 40),
                       ("runner sha256", runner_sha, 64)):
        if not re.fullmatch(rf"[0-9a-f]{{{n}}}", v):
            raise SystemExit(f"{name} must be {n} lowercase hex characters: {v!r}")
    nb = new_notebook()
    nb.metadata = {"accelerator": "GPU", "colab": {"gpuType": "A100", "machine_shape": "hm", "provenance": []},
                   "kernelspec": {"display_name": "Python 3", "name": "python3"},
                   "language_info": {"name": "python"}}
    run = (RUN.replace("__DATA_REF__", data_ref).replace("__MANIFEST_SHA256__", manifest_sha)
           .replace("__RUNNER_REF__", runner_ref).replace("__RUNNER_SHA256__", runner_sha))
    nb.cells = [
        new_markdown_cell(INTRO),
        new_code_cell(FORM),
        new_code_cell(run),
    ]
    return nb


def git_blob_sha256(ref: str) -> str | None:
    """sha256 of colab/lrt_runner.py at `ref` (None if git or the commit is not available)."""
    try:
        b = subprocess.run(["git", "show", f"{ref}:{RUNNER_REPO_PATH}"], cwd=HERE, capture_output=True, timeout=30,
                           check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return hashlib.sha256(b).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-ref", required=True)
    ap.add_argument("--manifest-sha256", required=True)
    ap.add_argument("--runner-ref", required=True, help="a commit holding colab/lrt_runner.py as it is here")
    ap.add_argument("--out", default=str(HERE / "laya_release_triage.ipynb"))
    a = ap.parse_args()
    sha = runner_sha256()
    at_ref = git_blob_sha256(a.runner_ref)
    if at_ref is not None and at_ref != sha:
        raise SystemExit(f"colab/lrt_runner.py at {a.runner_ref} differs from the working tree: commit it first")
    if at_ref is None:
        print(f"note: could not check lrt_runner.py at {a.runner_ref} with git; make sure that commit holds this file")
    nb = build(a.data_ref, a.manifest_sha256, a.runner_ref, sha)
    nbformat.validate(nb)
    nbformat.write(nb, a.out)
    print("wrote", a.out, "| runner", a.runner_ref[:12], sha[:12])


if __name__ == "__main__":
    main()
