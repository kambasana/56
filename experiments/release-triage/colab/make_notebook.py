"""Writes colab/laya_release_triage.ipynb from the cell sources below (run: python -I colab/make_notebook.py).

The notebook is generated so its cells stay reviewable as plain Python in one file. Edit here, re-run, commit both.
DATA_REF and MANIFEST_SHA256 are filled in from data/laya/MANIFEST.json and the commit that holds it:
    python -I colab/make_notebook.py --data-ref <commit sha> --manifest-sha256 <sha256 of MANIFEST.json>
"""
from __future__ import annotations

import argparse
import pathlib

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

HERE = pathlib.Path(__file__).resolve().parent

INTRO = """# Laya release triage: fine-tuned Laya vs. tabular and text baselines

> **Resume after a disconnect or sleep.** Colab ends idle sessions (roughly 90 minutes without interaction in the
> browser) and every session after a maximum lifetime (about 24 h on Pro); the VM and its files go with it.
> Everything this notebook produces is saved on Google Drive as it goes, so:
> 1. *Runtime → Reconnect* (or *Restart session* if Colab asks), pick the same GPU type if offered;
> 2. *Runtime → Run all*.
>
> Finished runs are verified (sha256) and skipped; nothing finished is redone. A run that was mid-training restarts
> from its base checkpoint (laya 0.4.1 cannot resume a run mid-way), so a disconnect loses at most that one run's
> partial training. If only the kernel restarted, the training process is still running and is re-attached.
> Keep this tab open and in front while it runs: closing it or letting the computer sleep starts the idle clock.
> (Colab Pro+ background execution lets a session keep running with the tab closed.)

This notebook runs the experiment fixed in
[PREREGISTRATION.md](https://github.com/kambasana/56/blob/research/laya-proper/experiments/release-triage/PREREGISTRATION.md).
Run it **top to bottom** on a Colab GPU runtime: *Runtime → Change runtime type → A100 GPU* (L4 also works, but
more slowly).

What it does:

1. Checks the GPU and installs pinned packages.
2. Downloads the dataset from GitHub and verifies every file's sha256.
3. Downloads the Laya checkpoints at a pinned revision.
4. Runs `laya-train --dry-run`, then, most decision-relevant first: the two label-encoding positive controls,
   fine-tuned typed-decisions and English at seed 0, the same at seeds 1 and 2, and last the two zero-shot
   references.
5. Scores calib and test, including the reversed-option-order check, and runs Laya's own eval harness.
6. Applies the pre-registered pass rule against the baselines.
7. Measures GPU latency and estimates CPU latency.
8. Saves the chosen checkpoint to your Google Drive, and optionally exports it to ONNX with receptron/laya's
   script.

No secret is required. Two are optional:

- a Hugging Face read token, pasted in the next cell, only to avoid download rate limits;
- a Colab secret named `GH_TOKEN` (key icon in the left bar; see RUN-IN-COLAB.md). If it exists and this notebook
  has access to it, progress (stage, run, epoch, step, loss, elapsed time, GPU, errors with tracebacks) and the
  small `results/*.json` files are pushed every ~2 minutes and at the end of every stage to branch
  `results/laya-colab` of the dataset repository, so the run can be followed live. The token is never printed or
  written to disk.

Durable state lives in `MyDrive/laya-release-triage/<run tag>/` (or `OUTPUT_DIR` on a runtime without Google
Drive): `state.json` (the ledger: status, attempts and errors of every run, sha256 of every result file),
`results/`, `checkpoints/`, `heartbeat.json` and the training logs. Training runs in a detached background process
with a watchdog; each run gets up to 3 attempts (CUDA out-of-memory: half the micro-batch and double the
accumulation, so the effective batch and update count are unchanged; network errors: backoff). This is execution
plumbing only: no experiment rule, data, threshold or pass condition depends on it.

**Send back:** the `results` folder (or `results.zip`) from `MyDrive/laya-release-triage/<run tag>/`.

Shai-Hulud is one incident family among many here. Every recall figure is a macro average over families, and
no gate names a family."""

CONFIG = '''# ---- Settings (normally nothing to change) ---------------------------------------------------------------
HF_TOKEN = ""            # optional: paste a Hugging Face read token to avoid anonymous rate limits
USE_DRIVE = True         # save progress, results and the chosen checkpoint to Google Drive
EXPORT_ONNX = True       # export the chosen checkpoint with receptron/laya's export/export_onnx.py
RUN_ZERO_SHOT = True     # reference runs Z-EN (512) and Z-TD (1024)
RUN_POSITIVE_CONTROL = True
RUN_FINETUNE = True
RETRY_FAILED = False     # True: give runs recorded as failed in state.json another 3 attempts on this Run all
OUTPUT_DIR = ""          # durable output folder when Google Drive is not available (custom GCE VM, local Jupyter);
                         # empty = ~/laya-release-triage. Environment variable LRT_OUT overrides both.
STALL_MINUTES = 30       # watchdog: kill and retry a training process with no log output and no CPU use this long

# ---- Pinned inputs (fixed by PREREGISTRATION.md; do not edit) ------------------------------------------------
REPO = "kambasana/56"
SUBDIR = "experiments/release-triage"
DATA_REF = "__DATA_REF__"                # commit holding data/laya/MANIFEST.json
MANIFEST_SHA256 = "__MANIFEST_SHA256__"
HF_REPO = "convaiinnovations/laya"
HF_REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148"
RECEPTRON_COMMIT = "6478649e723122ca24bbf5fb69ed1010023c9750"
SEEDS = [0, 1, 2]
MAX_LEN, HEAD_MAX_LEN = 1024, 256
TARGET_UPDATES, MIN_EPOCHS, MAX_EPOCHS = 600, 4, 16
EFFECTIVE_BATCH = 64
SCORE_BATCH = 32

import os, sys, json, time, math, glob, gzip, shutil, hashlib, pathlib, subprocess, urllib.request, importlib.util
SMOKE = os.environ.get("LRT_SMOKE") == "1"   # used only by the author's local CPU check; leave unset
try:   # Colab (hosted or Colab-managed runtime) vs. any other Jupyter (custom VM, local)
    IN_COLAB = importlib.util.find_spec("google.colab") is not None
except (ImportError, ValueError):
    IN_COLAB = False
# Fast local scratch (dataset copy, base checkpoints, a run's training output before it is copied to durable storage).
WORK = pathlib.Path(os.environ.get("LRT_WORK") or ("/content/lrt" if IN_COLAB and os.path.isdir("/content")
                                                   else pathlib.Path.home() / "lrt-work"))
WORK.mkdir(parents=True, exist_ok=True)
print("runtime", "Colab" if IN_COLAB else "non-Colab Jupyter", "| work dir", WORK, "| smoke" if SMOKE else "")'''

PROGRESS_CELL = r'''# Live progress (optional). If a Colab secret named GH_TOKEN exists and this notebook has access to it, progress
# and the small results/*.json files are pushed to branch RESULTS_BRANCH of REPO every ~2 minutes and at the end of
# every stage, through the GitHub contents REST API over HTTPS. The token is read with google.colab.userdata (on a
# runtime without google.colab: the GH_TOKEN environment variable), kept in memory only, sent only in the
# Authorization header to api.github.com, and never printed, logged or written to disk (no git credentials are
# created). Without GH_TOKEN the run is the same and saves to durable storage only. Every ~2 minutes the timer also
# writes a heartbeat (time, run, epoch/step, GPU, minutes since the last log line) to progress.jsonl.
import os, base64, datetime, re, threading, traceback, uuid, urllib.error, urllib.parse
RESULTS_BRANCH = "results/laya-colab"
PUSH_EVERY_S = 120
SMALL_FILE_BYTES = 512 * 1024

def _read_gh_token():
    try:
        from google.colab import userdata
    except Exception:   # not Colab (custom VM, local Jupyter): an environment variable instead
        t = os.environ.get("GH_TOKEN")
        return t.strip() if isinstance(t, str) and t.strip() else None
    try:
        t = userdata.get("GH_TOKEN")
    except Exception:   # secret missing, or notebook access to it not enabled
        return None
    return t.strip() if isinstance(t, str) and t.strip() else None


class GitHubPusher:
    """Creates/updates files on one branch with the contents API. Never raises; never reveals the token."""
    API = "https://api.github.com"

    def __init__(self, token, repo, branch, base_branch, prefix, opener=None):
        self._token = token
        self.repo, self.branch, self.base_branch, self.prefix = repo, branch, base_branch, prefix.strip("/")
        self._open = opener or urllib.request.urlopen
        self._shas = {}
        self.enabled = bool(token)
        self.errors = 0
        self.last_error = None
        self._branch_ok = False

    def __repr__(self):  # never show the token
        return f"GitHubPusher({self.repo}@{self.branch}/{self.prefix}, enabled={self.enabled})"

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.API + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self._token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "laya-release-triage-colab",
            **({"Content-Type": "application/json"} if data is not None else {})})
        try:
            with self._open(req, timeout=30) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            try:
                raw = e.read()
                return e.code, (json.loads(raw) if raw else None)
            except Exception:
                return e.code, None
        except Exception as e:  # network error: report the type only
            return 0, {"message": type(e).__name__}

    def _fail(self, what, status, body):
        self.errors += 1
        msg = (body or {}).get("message", "") if isinstance(body, dict) else ""
        self.last_error = f"{what}: HTTP {status} {msg}"[:200]
        if status in (401, 403, 404) and not self._branch_ok:
            self.enabled = False
            print(f"GitHub push disabled ({self.last_error}). Check the GH_TOKEN secret: repo {self.repo} only, "
                  "Contents read/write. The run continues and saves to Drive.")
        return False

    def ensure_branch(self):
        if self._branch_ok:
            return True
        st, body = self._req("GET", f"/repos/{self.repo}/git/ref/heads/{self.branch}")
        if st == 200:
            self._branch_ok = True
            return True
        if st != 404:
            return self._fail("read branch", st, body)
        st, body = self._req("GET", f"/repos/{self.repo}/git/ref/heads/{self.base_branch}")
        if st != 200:
            return self._fail("read base branch", st, body)
        st, body = self._req("POST", f"/repos/{self.repo}/git/refs",
                             {"ref": f"refs/heads/{self.branch}", "sha": body["object"]["sha"]})
        if st in (201, 422):   # 422: created meanwhile
            self._branch_ok = True
            return True
        return self._fail("create branch", st, body)

    def put(self, rel, content, message):
        """Create or update <prefix>/<rel> on the branch with `content` (bytes)."""
        if not self.enabled or not self.ensure_branch():
            return False
        path = f"{self.prefix}/{rel}".lstrip("/")
        qpath = urllib.parse.quote(path)
        for attempt in range(2):
            sha = self._shas.get(path)
            if sha is None:
                st, body = self._req("GET", f"/repos/{self.repo}/contents/{qpath}?ref={urllib.parse.quote(self.branch)}")
                if st == 200 and isinstance(body, dict):
                    sha = body.get("sha")
                elif st != 404:
                    return self._fail(f"read {rel}", st, body)
            req = {"message": message, "content": base64.b64encode(content).decode(), "branch": self.branch}
            if sha:
                req["sha"] = sha
            st, body = self._req("PUT", f"/repos/{self.repo}/contents/{qpath}", req)
            if st in (200, 201):
                self._shas[path] = body["content"]["sha"]
                return True
            if st in (409, 422) and attempt == 0:   # stale sha: re-read once
                self._shas.pop(path, None)
                continue
            return self._fail(f"write {rel}", st, body)
        return False


class Progress:
    """Appends JSON lines to progress.jsonl (Drive) and mirrors them, with small results files, to GitHub."""

    def __init__(self, pusher):
        self.pusher = pusher
        self.run_tag = None
        self.t0 = time.time()
        self.lines, self.path, self.results = [], None, None
        self.stage = None
        self.ctx = {"gpu": None}
        self._pushed = {}
        self._dirty = False
        self._lock = threading.RLock()
        self._thread = None
        self.heartbeat = None   # set later: called every PUSH_EVERY_S, before the push

    def bind(self, results_dir, run_tag):
        """Called once RESULTS is known: keep earlier sessions' lines and write from now on."""
        with self._lock:
            self.results, self.run_tag = pathlib.Path(results_dir), run_tag
            self.path = self.results / "progress.jsonl"
            old = self.path.read_text().splitlines() if self.path.exists() else []
            self.lines = old + self.lines
            self.path.write_text("".join(l + "\n" for l in self.lines))
            if self.pusher is not None:
                self.pusher.prefix = f"{SUBDIR}/colab-runs/{run_tag}"

    def log(self, event, **kw):
        rec = {"t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               "elapsed_s": round(time.time() - self.t0, 1), "run_tag": self.run_tag, "stage": self.stage,
               "event": event, "gpu": self.ctx.get("gpu"), **kw}
        line = json.dumps(rec, default=str)
        with self._lock:
            self.lines.append(line)
            self._dirty = True
            if self.path is not None:
                with open(self.path, "a") as f:
                    f.write(line + "\n")

    def begin(self, stage):
        self.stage = stage
        self.log("stage_start")

    def end(self, stage):
        self.stage = stage
        self.log("stage_end")
        self.push()

    def error(self, exc):
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        self.log("error", error=f"{type(exc).__name__}: {exc}"[:2000], traceback=tb[-20000:])
        self.push()

    def push(self):
        """Push progress.jsonl and any new or changed small results file. Safe to call from any thread."""
        if self.pusher is None or not self.pusher.enabled or self.run_tag is None:
            return
        with self._lock:
            if self._dirty:
                if self.pusher.put("progress.jsonl", "".join(l + "\n" for l in self.lines).encode(),
                                   f"colab progress {self.run_tag}: {self.stage}"):
                    self._dirty = False
            for p in sorted(list(self.results.glob("*.json")) + list(self.results.glob("summary.md"))):
                try:
                    if p.stat().st_size > SMALL_FILE_BYTES:
                        continue
                    b = p.read_bytes()
                except OSError:
                    continue
                h = hashlib.sha256(b).hexdigest()
                if self._pushed.get(p.name) != h and self.pusher.put(f"results/{p.name}", b, f"colab results {self.run_tag}: {p.name}"):
                    self._pushed[p.name] = h

    def start_timer(self):
        if self._thread is not None:
            return
        def loop():
            while True:
                time.sleep(PUSH_EVERY_S)
                try:
                    if self.heartbeat is not None:
                        self.heartbeat()
                except Exception as e:
                    print("heartbeat failed:", type(e).__name__)
                try:
                    self.push()
                except Exception as e:   # never let the timer die or leak details
                    print("progress push failed:", type(e).__name__)
        self._thread = threading.Thread(target=loop, daemon=True, name="progress-push")
        self._thread.start()


_tok = None if SMOKE else _read_gh_token()
PROGRESS = Progress(GitHubPusher(_tok, REPO, RESULTS_BRANCH, "research/laya-proper", "") if _tok else None)
del _tok
print("live progress to GitHub:", f"on (branch {RESULTS_BRANCH} of {REPO})" if PROGRESS.pusher else "off (no GH_TOKEN secret); durable storage only")

def _post_run_cell(result):
    err = getattr(result, "error_in_exec", None) or getattr(result, "error_before_exec", None)
    if err is not None:
        PROGRESS.error(err)

try:
    _ip = get_ipython()
    for _cb in list(_ip.events.callbacks.get("post_run_cell", [])):
        if getattr(_cb, "__name__", "") == "_post_run_cell":
            _ip.events.unregister("post_run_cell", _cb)
    _ip.events.register("post_run_cell", _post_run_cell)
except NameError:   # not under IPython
    pass

TRAIN_LINE = re.compile(r"epoch (\d+)/(\d+) (?:step (\d+) loss ([0-9.eE+-]+|nan)|mean loss ([0-9.eE+-]+|nan))")
def train_progress(run_id, line):
    """Record laya-train's own loss lines ("epoch e/E step s loss x", "epoch e/E mean loss x")."""
    m = TRAIN_LINE.search(line)
    if m:
        e, E, step, loss, mean = m.groups()
        PROGRESS.log("train_step" if step else "epoch_end", run_id=run_id, epoch=int(e), epochs=int(E),
                     step=int(step) if step else None, loss=float(loss if step else mean))
    return bool(m)'''

RUNNER_CELL = r'''# Execution plumbing only: no experiment rule, threshold, metric or training setting lives here.
#   * Ledger: <run dir>/state.json on durable storage (Drive, or OUTPUT_DIR off Colab). One entry per run: status
#     pending/running/done/failed, attempts, interruptions, every error with its traceback, and the sha256 of each
#     stage's output files. A done run is skipped on re-run only after its files verify against those sha256.
#   * Job: laya-train runs in a detached process (own session, like setsid/nohup) whose stdout+stderr go to a log on
#     durable storage, so a dropped browser connection, a stopped cell or a restarted kernel does not kill it; a
#     later "Run all" re-attaches to it. Its exit code is written to a file, so a new kernel can read it.
#   * Watchdog: no new log output AND no CPU time for STALL_MINUTES -> the job is killed and the run retried.
#   * Retries: up to MAX_ATTEMPTS per run. CUDA OOM -> half the micro-batch, double grad-accum (same effective batch
#     and the same optimizer-update count, checked); network/HF errors -> exponential backoff; any other error ->
#     traceback recorded, next run, reported at the end.
#   * Heartbeat every ~2 minutes (progress.jsonl + heartbeat.json, and GitHub if GH_TOKEN is set).
# laya 0.4.1 cannot resume a run from checkpoint_latest/ (weights only, no optimizer/scheduler/RNG state, and no
# resume option in laya-train), so an interrupted run restarts from its base checkpoint; finished runs are kept.
import os, re, sys, json, time, math, shutil, signal, socket, hashlib, pathlib, datetime, threading, traceback, subprocess
MAX_ATTEMPTS = globals().get("MAX_ATTEMPTS", 3)
MAX_INTERRUPTIONS = globals().get("MAX_INTERRUPTIONS", 5)   # disconnects that restart a run without using an attempt
STALL_MINUTES = globals().get("STALL_MINUTES", 30)
POLL_S = globals().get("POLL_S", 15)
BACKOFF_S = globals().get("BACKOFF_S", 30)
TAIL_LINES = 12


def _utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def sha256_file(p, n=1 << 22):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(n), b""):
            h.update(b)
    return h.hexdigest()


def boot_id():
    try:
        return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return "host-" + socket.gethostname()


def write_json_atomic(path, obj):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    with open(tmp, "w") as f:
        f.write(json.dumps(obj, indent=1, default=str) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---- retry policy ----------------------------------------------------------------------------------------------
def optimizer_updates(n_items, micro, accum, epochs):
    """Same count as laya.train.optimizer_updates (0.4.1): one step per full accumulation window, plus one for the
    last, partial window of each epoch."""
    return math.ceil(math.ceil(n_items / micro) / accum) * epochs


def oom_fallback(micro, accum, n_items, epochs):
    """Next (micro, accum) after a CUDA OOM: half the micro-batch, double the accumulation. Returned only if the
    effective batch AND the optimizer-update count stay exactly the same; else None (the run then fails)."""
    if micro <= 1 or micro % 2:
        return None
    m2, a2 = micro // 2, accum * 2
    if m2 * a2 != micro * accum:
        return None
    if optimizer_updates(n_items, m2, a2, epochs) != optimizer_updates(n_items, micro, accum, epochs):
        return None
    return m2, a2


OOM_PAT = re.compile(r"CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|CUDA error: out of memory", re.I)
NET_PAT = re.compile(r"ConnectionError|ConnectTimeout|ReadTimeout|Temporary failure in name resolution|"
                     r"Max retries exceeded|HfHubHTTPError|LocalEntryNotFoundError|HTTP Error (?:429|5\d\d)|"
                     r"urlopen error|RemoteDisconnected|IncompleteRead|Connection reset by peer", re.I)


def classify_error(text):
    """'oom' | 'network' | 'other' from an error message or a log tail."""
    if OOM_PAT.search(text or ""):
        return "oom"
    if NET_PAT.search(text or ""):
        return "network"
    return "other"


class RunError(Exception):
    """kind: oom | network | stalled | killed | other."""
    def __init__(self, kind, message, detail=""):
        super().__init__(message)
        self.kind, self.detail = kind, detail


# ---- ledger ----------------------------------------------------------------------------------------------------
class Ledger:
    """state.json: per-run status, attempts, errors and the sha256 of every stage output (paths relative to root)."""

    def __init__(self, path, root, fingerprint=None):
        self.path, self.root = pathlib.Path(path), pathlib.Path(root)
        self._lock = threading.RLock()
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
        else:
            self.data = {"version": 1, "created": _utc(), "fingerprint": fingerprint, "runs": {}}
        old = self.data.get("fingerprint")
        if fingerprint is not None and old is not None and old != fingerprint:
            diff = {k: (old.get(k), fingerprint.get(k)) for k in set(old) | set(fingerprint) if old.get(k) != fingerprint.get(k)}
            raise SystemExit(f"{self.path} belongs to a run with different pinned inputs {diff}. Rename or delete "
                             "run_tag.txt in the output folder to start a new run; nothing was changed.")
        self.data["fingerprint"] = fingerprint or old
        self.save()

    def save(self):
        with self._lock:
            write_json_atomic(self.path, self.data)

    def get(self, rid):
        with self._lock:
            return self.data["runs"].setdefault(rid, {
                "status": "pending", "attempts": 0, "interruptions": 0, "oom_halvings": 0, "score_halvings": 0,
                "last_error": None, "errors": [], "stages": {}, "started": None, "finished": None})

    def update(self, rid, **kw):
        with self._lock:
            self.get(rid).update(kw)
            self.save()
            return self.get(rid)

    def add_error(self, rid, kind, message, tb, attempt):
        with self._lock:
            r = self.get(rid)
            err = {"t": _utc(), "attempt": attempt, "kind": kind, "error": message[:2000], "traceback": tb[-8000:]}
            r["errors"].append(err)
            r["last_error"] = f"{kind}: {message}"[:500]
            self.save()

    def _rel(self, p):
        p = pathlib.Path(p)
        try:
            return str(p.resolve().relative_to(self.root.resolve()))
        except ValueError:
            return str(p)

    def _abs(self, rel):
        p = pathlib.Path(rel)
        return p if p.is_absolute() else self.root / p

    def record_stage(self, rid, stage, files=(), checkpoint=None, info=None):
        rec = {"t": _utc(), "files": {self._rel(f): sha256_file(f) for f in files}, "info": info or {}}
        if checkpoint is not None:
            ck = pathlib.Path(checkpoint)
            rec["checkpoint"] = {"path": self._rel(ck), "sha256": sha256_file(ck / "model.safetensors")}
        with self._lock:
            self.get(rid)["stages"][stage] = rec
            self.save()

    def stage_ok(self, rid, stage, need_checkpoint=True):
        """(ok, problem): every recorded file exists with its recorded sha256 (and the checkpoint, if asked)."""
        rec = self.get(rid)["stages"].get(stage)
        if rec is None:
            return False, "not run"
        for rel, h in rec["files"].items():
            p = self._abs(rel)
            if not p.exists():
                return False, f"{rel} missing"
            if sha256_file(p) != h:
                return False, f"{rel} sha256 mismatch"
        ck = rec.get("checkpoint")
        if need_checkpoint and ck:
            m = self._abs(ck["path"]) / "model.safetensors"
            if not m.exists() or sha256_file(m) != ck["sha256"]:
                return False, f"checkpoint {ck['path']} missing or changed"
        return True, ""

    def drop_stage(self, rid, stage):
        with self._lock:
            self.get(rid)["stages"].pop(stage, None)
            self.save()

    def counts(self):
        with self._lock:   # also called from the heartbeat thread
            out = {}
            for r in list(self.data["runs"].values()):
                out[r["status"]] = out.get(r["status"], 0) + 1
            return out


# ---- detached jobs ---------------------------------------------------------------------------------------------
def _proc_stat(pid):
    try:
        s = pathlib.Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    f = s[s.rindex(")") + 2:].split()
    return {"state": f[0], "pgrp": int(f[2]), "cpu_ticks": sum(int(x) for x in f[11:15])}


class Job:
    """One laya-train process, detached from the kernel (start_new_session=True: its own session and process group,
    as with setsid; no controlling terminal, so no SIGHUP). stdout+stderr are appended to `log_path`; a tiny sh
    wrapper writes the exit code to `exit_path`. The job file lets a later kernel find, adopt or clean it up."""
    WRAP = 'out="$1"; shift; "$@"; rc=$?; echo "$rc" > "$out.tmp"; mv -f "$out.tmp" "$out"; exit "$rc"'

    def __init__(self, info, job_file):
        self.info, self.job_file, self._popen = info, pathlib.Path(job_file), None

    @classmethod
    def launch(cls, run_id, attempt, cmd, log_path, jobs_dir, marker, env=None):
        jobs_dir, log_path = pathlib.Path(jobs_dir), pathlib.Path(log_path)
        jobs_dir.mkdir(parents=True, exist_ok=True)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        exit_path = jobs_dir / f"{run_id}.attempt{attempt}.{int(time.time())}.exit"
        env = dict(os.environ if env is None else env, PYTHONUNBUFFERED="1")
        with open(log_path, "ab") as lf:
            lf.write(f"\n===== {run_id} attempt {attempt} start {_utc()} =====\n".encode())
            lf.flush()
            offset = lf.tell()
            p = subprocess.Popen(["sh", "-c", cls.WRAP, "sh", str(exit_path), *map(str, cmd)], stdout=lf,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
                                 close_fds=True, env=env)
        info = {"run_id": run_id, "attempt": attempt, "pid": p.pid, "pgid": p.pid, "boot_id": boot_id(),
                "started": _utc(), "started_ts": time.time(), "exit_path": str(exit_path), "log_path": str(log_path),
                "log_offset": offset, "marker": marker, "cmd": [str(c) for c in cmd]}
        job = cls(info, jobs_dir / f"{run_id}.job.json")
        write_json_atomic(job.job_file, info)
        job._popen = p
        return job

    @classmethod
    def load(cls, run_id, jobs_dir):
        jf = pathlib.Path(jobs_dir) / f"{run_id}.job.json"
        if not jf.exists():
            return None
        try:
            return cls(json.loads(jf.read_text()), jf)
        except (OSError, ValueError):
            return None

    def status(self):
        """('exited', rc) | ('running', None) | ('lost', None): lost = gone without an exit code (VM restarted,
        process group killed)."""
        ep = pathlib.Path(self.info["exit_path"])
        if self._popen is not None:
            self._popen.poll()   # reap our own child so it does not linger as a zombie
        if ep.exists():
            try:
                return "exited", int(ep.read_text().strip())
            except ValueError:
                return "exited", -1
        if self.info.get("boot_id") != boot_id():
            return "lost", None
        st = _proc_stat(self.info["pid"])
        if st is None or st["state"] in ("Z", "X"):
            if ep.exists():   # finished between the two checks
                return self.status()
            return "lost", None
        return "running", None

    def cpu_seconds(self):
        """CPU time of every process in the job's process group (laya-train launching GPU kernels counts)."""
        tot = 0
        for d in pathlib.Path("/proc").iterdir():
            if d.name.isdigit():
                st = _proc_stat(d.name)
                if st and st["pgrp"] == self.info["pgid"]:
                    tot += st["cpu_ticks"]
        return tot / os.sysconf("SC_CLK_TCK")

    def kill(self, grace_s=10):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.info["pgid"], sig)
            except (ProcessLookupError, PermissionError):
                return
            t = time.time()
            while time.time() - t < grace_s:
                if self._popen is not None:
                    self._popen.poll()
                st = _proc_stat(self.info["pid"])
                if st is None or st["state"] in ("Z", "X"):
                    return
                time.sleep(0.2)

    def clear(self):
        for p in (self.job_file, pathlib.Path(self.info["exit_path"])):
            try:
                p.unlink()
            except OSError:
                pass


# ---- live view -------------------------------------------------------------------------------------------------
class LiveView:
    """A progress bar and the log tail, updated in place under IPython; plain prints (at most once a minute) elsewhere."""

    def __init__(self, quiet=False):
        self.quiet, self.handle, self._last_print = quiet, None, 0.0
        try:
            get_ipython()  # noqa: F821
            from IPython.display import display, Pretty
            self._Pretty = Pretty
            self.handle = display(Pretty(""), display_id=True)
        except Exception:
            self.handle = None

    def show(self, text):
        if self.quiet:
            return
        if self.handle is not None:
            self.handle.update(self._Pretty(text))
        elif time.time() - self._last_print > 60:
            self._last_print = time.time()
            print(text.splitlines()[0] if text else "", flush=True)


TRAIN_ITEMS = re.compile(r"train items (\d+)")
STEP_LINE = re.compile(r"epoch (\d+)/(\d+) (?:step (\d+)|mean loss)")


# ---- orchestrator ----------------------------------------------------------------------------------------------
class Stage:
    """One idempotent step of a run. fn(orch, run_id) -> {"files": [...], "checkpoint": dir or None, "info": {...}}.
    on_oom(orch, run_id) -> description of the smaller setting, or None if there is none."""
    def __init__(self, name, fn, on_oom=None):
        self.name, self.fn, self.on_oom = name, fn, on_oom


class RunSpec:
    def __init__(self, run_id, stages, on_done=None, on_skip=None):
        self.run_id, self.stages, self.on_done, self.on_skip = run_id, stages, on_done, on_skip


class Orchestrator:
    def __init__(self, root, ledger, progress, jobs_dir=None, max_attempts=None, stall_s=None, poll_s=None,
                 backoff_s=None, sleep=time.sleep, quiet=False, gpu=None):
        self.root, self.ledger, self.progress = pathlib.Path(root), ledger, progress
        self.jobs_dir = pathlib.Path(jobs_dir or self.root / "jobs")
        self.max_attempts = max_attempts or MAX_ATTEMPTS
        self.stall_s = stall_s if stall_s is not None else STALL_MINUTES * 60
        self.poll_s = poll_s if poll_s is not None else POLL_S
        self.backoff_s = backoff_s if backoff_s is not None else BACKOFF_S
        self.sleep, self.quiet, self.gpu = sleep, quiet, gpu
        self.current = {}
        self._jobs_to_clear = []
        self.run_seconds = []   # wall time of runs that trained in this session, for the ETA

    # -- heartbeat
    def heartbeat(self):
        c = dict(self.current)
        rec = {"t": _utc(), "run_id": c.get("run_id"), "attempt": c.get("attempt"), "phase": c.get("phase"),
               "epoch": c.get("epoch"), "epochs": c.get("epochs"), "step": c.get("step"),
               "steps_per_epoch": c.get("steps_per_epoch"), "pct_run": c.get("pct"), "eta_run_min": c.get("eta_min"),
               "micro_batch": c.get("micro"), "grad_accum": c.get("accum"), "gpu": self.gpu, "runs": self.ledger.counts()}
        lp = c.get("log_path")
        if lp and os.path.exists(lp):
            rec["min_since_log_line"] = round((time.time() - os.path.getmtime(lp)) / 60, 1)
        job = c.get("job")
        if job is not None:
            rec["job_status"] = job.status()[0]
        rec.update(gpu_stats())
        write_json_atomic(self.root / "heartbeat.json", rec)
        self.progress.log("heartbeat", **{k: v for k, v in rec.items() if k not in ("t", "gpu")})

    # -- detached training job with adopt / watchdog
    def run_job(self, run_id, cmd, log_path, marker, prepare=None, on_line=None, micro=None, accum=None):
        """Run `cmd` detached (or re-attach to the job a previous kernel started) and wait for it. Returns
        (rc, log tail of this attempt, job info)."""
        r = self.ledger.get(run_id)
        job = Job.load(run_id, self.jobs_dir)
        if job is not None:
            st, rc = job.status()
            if st == "running" and job.info.get("marker") == marker:
                self.progress.log("job_adopted", run_id=run_id, pid=job.info["pid"], attempt=job.info["attempt"])
                print(f"{run_id}: re-attached to the training process started {job.info['started']} (pid {job.info['pid']})")
            elif st == "exited" and job.info.get("marker") == marker:
                self.progress.log("job_finished_while_away", run_id=run_id, returncode=rc)
            else:
                if st == "running":   # a job for other settings: stop it before starting this one
                    job.kill()
                n = r["interruptions"] + 1
                self.ledger.update(run_id, interruptions=n)
                self.progress.log("run_interrupted", run_id=run_id, attempt=job.info.get("attempt"), interruptions=n,
                                  lost="the in-progress run (laya-train cannot resume; it restarts from its base checkpoint)")
                print(f"{run_id}: the previous training process is gone (disconnect or restart): restarting this run "
                      "from its base checkpoint (laya 0.4.1 cannot resume mid-run); finished runs are kept")
                job.clear()
                job = None
                if n > MAX_INTERRUPTIONS:
                    raise RunError("killed", f"interrupted {n} times; counting this as a failed attempt")
        if job is None:
            if prepare is not None:
                prepare()
            job = Job.launch(run_id, r["attempts"], cmd, log_path, self.jobs_dir, marker)
            self.progress.log("job_launched", run_id=run_id, pid=job.info["pid"], attempt=r["attempts"],
                              micro_batch=micro, grad_accum=accum)
        self.current.update(job=job, log_path=str(log_path), micro=micro, accum=accum, epoch=None, step=None,
                            pct=None, eta_min=None, phase="train (setup)")
        rc, tail = self._watch(job, on_line, micro)
        self._jobs_to_clear.append(job)
        return rc, tail, job.info

    def _watch(self, job, on_line, micro):
        view = LiveView(self.quiet)
        log = pathlib.Path(job.info["log_path"])
        off, buf, tail = job.info.get("log_offset", 0), "", []
        last_change, last_cpu = time.time(), job.cpu_seconds()
        first_step_ts = first_done = None
        c = self.current
        while True:
            try:
                with open(log, "rb") as f:
                    f.seek(off)
                    new = f.read()
            except OSError:
                new = b""
            if new:
                off += len(new)
                last_change = time.time()
                lines = (buf + new.decode("utf-8", "replace")).split("\n")
                buf = lines.pop()
                for line in lines:
                    tail = (tail + [line])[-200:]
                    if on_line is not None:
                        try:
                            on_line(line)
                        except Exception:
                            pass
                    m = TRAIN_ITEMS.search(line)
                    if m and micro:
                        c["steps_per_epoch"] = math.ceil(int(m.group(1)) / micro)
                    m = STEP_LINE.search(line)
                    if m:
                        e, E, s = int(m.group(1)), int(m.group(2)), m.group(3)
                        spe = c.get("steps_per_epoch")
                        c.update(epoch=e, epochs=E, phase="train")
                        c["step"] = int(s) if s else spe
                        if first_step_ts is None:
                            first_step_ts = time.time()
                        if spe:
                            done = ((e - 1) * spe + (c["step"] or 0)) / (E * spe)
                            c["pct"] = round(100 * done, 1)
                            if first_done is None:
                                first_done = done
                            elif done > first_done:
                                rate = (done - first_done) / (time.time() - first_step_ts)
                                c["eta_min"] = round((1 - done) / rate / 60, 1)
                            if e == E and not s:
                                c["phase"] = "calibration and report"
            st, rc = job.status()
            if st == "exited":
                return rc, "\n".join(tail + ([buf] if buf else []))
            if st == "lost":
                raise RunError("killed", "the training process disappeared without an exit code", "\n".join(tail[-40:]))
            cpu = job.cpu_seconds()
            if cpu > last_cpu + 1.0:
                last_cpu, last_change = cpu, time.time()
            idle = time.time() - last_change
            if idle > self.stall_s:
                job.kill()
                raise RunError("stalled", f"no log output and no CPU progress for {idle / 60:.1f} min; process killed",
                               "\n".join(tail[-40:]))
            pct = c.get("pct") or 0.0
            bar = "#" * int(pct / 100 * 30) + "." * (30 - int(pct / 100 * 30))
            head = (f"[{bar}] {c.get('run_id')} attempt {c.get('attempt')} | {c.get('phase')} | epoch "
                    f"{c.get('epoch') or '-'}/{c.get('epochs') or '-'} step {c.get('step') or '-'}/"
                    f"{c.get('steps_per_epoch') or '-'} | {pct:.1f}% | ETA {c.get('eta_min') or '?'} min | "
                    f"last output {idle / 60:.1f} min ago | runs {self.ledger.counts()}")
            view.show(head + "\n" + "\n".join(tail[-TAIL_LINES:]))
            self.sleep(self.poll_s)

    def _clear_jobs(self):
        for j in self._jobs_to_clear:
            j.clear()
        self._jobs_to_clear = []

    # -- runs
    def run_all(self, specs, retry_failed=False):
        for spec in specs:
            self.run_one(spec, retry_failed=retry_failed)
        return self.report([s.run_id for s in specs])

    def run_one(self, spec, retry_failed=False):
        L, P, rid = self.ledger, self.progress, spec.run_id
        r = L.get(rid)
        if r["status"] == "done":
            bad = [(s.name, why) for s in spec.stages for ok, why in [L.stage_ok(rid, s.name, need_checkpoint=False)] if not ok]
            if not bad:
                P.log("run_skipped_done", run_id=rid)
                print(f"{rid}: done earlier (result files verified by sha256), skipped")
                if spec.on_skip:
                    spec.on_skip(rid)
                return "done"
            P.log("run_verify_failed", run_id=rid, problems=bad)
            print(f"{rid}: recorded as done but {bad}; redoing the affected stages")
            for name, _ in bad:
                L.drop_stage(rid, name)
            L.update(rid, status="pending", attempts=0)
        elif r["status"] == "failed":
            if not retry_failed:
                P.log("run_skipped_failed", run_id=rid, last_error=r["last_error"])
                print(f"{rid}: failed earlier ({r['last_error']}); skipped (set RETRY_FAILED = True to retry it)")
                return "failed"
            L.update(rid, status="pending", attempts=0)
        resumed = L.get(rid)["status"] == "running"
        while True:
            r = L.get(rid)
            if resumed:   # the attempt in progress when the session ended continues: no attempt is used
                resumed = False
                P.log("run_resume", run_id=rid, attempt=r["attempts"])
            else:
                if r["attempts"] >= self.max_attempts:
                    L.update(rid, status="failed")
                    P.log("run_failed", run_id=rid, attempts=r["attempts"], last_error=r["last_error"])
                    P.push()
                    return "failed"
                r = L.update(rid, attempts=r["attempts"] + 1, status="running", started=_utc())
            attempt = r["attempts"]
            self.current = {"run_id": rid, "attempt": attempt, "phase": None}
            P.log("run_start", run_id=rid, attempt=attempt)
            t0 = time.time()
            stage = None
            try:
                for stage in spec.stages:
                    if L.stage_ok(rid, stage.name, need_checkpoint=True)[0]:
                        continue
                    self.current["phase"] = stage.name
                    out = stage.fn(self, rid) or {}
                    L.record_stage(rid, stage.name, out.get("files", ()), out.get("checkpoint"), out.get("info"))
                    self._clear_jobs()
                    P.log("stage_done", run_id=rid, run_stage=stage.name)
                L.update(rid, status="done", finished=_utc(), wall_seconds_last_attempt=round(time.time() - t0, 1))
                self.current = {}
                P.log("run_done", run_id=rid, attempt=attempt, wall_seconds=round(time.time() - t0, 1))
                if spec.on_done:
                    spec.on_done(rid)
                P.push()
                return "done"
            except KeyboardInterrupt:
                P.log("cell_interrupted", run_id=rid, note="a detached training process keeps running; Run all re-attaches")
                raise
            except (Exception, SystemExit) as e:
                tb = traceback.format_exc()
                msg = f"{type(e).__name__}: {e}"
                detail = getattr(e, "detail", "") or ""
                kind = e.kind if isinstance(e, RunError) else classify_error(msg + "\n" + tb)
                if kind == "other" and isinstance(e, RunError):
                    kind = classify_error(detail) if classify_error(detail) != "other" else kind
                L.add_error(rid, kind, msg, (tb + "\n--- log tail ---\n" + detail)[-8000:], attempt)
                P.log("run_error", run_id=rid, attempt=attempt, kind=kind, run_stage=getattr(stage, "name", None),
                      error=msg[:2000], traceback=(tb + "\n--- log tail ---\n" + detail)[-8000:])
                P.push()
                print(f"{rid}: attempt {attempt} failed ({kind}): {msg[:300]}")
                self._clear_jobs()
                if kind == "oom":
                    change = stage.on_oom(self, rid) if (stage is not None and stage.on_oom) else None
                    if change is None:
                        L.update(rid, status="failed")
                        P.log("run_failed", run_id=rid, attempts=attempt, last_error=msg[:500], note="no smaller setting")
                        return "failed"
                    P.log("oom_retry", run_id=rid, change=change)
                    print(f"{rid}: CUDA OOM -> retry with {change}")
                elif kind == "network":
                    delay = self.backoff_s * 2 ** (attempt - 1)
                    P.log("backoff", run_id=rid, seconds=delay)
                    print(f"{rid}: network error -> retry in {delay} s")
                    self.sleep(delay)
                elif kind in ("stalled", "killed"):
                    pass
                else:
                    L.update(rid, status="failed")
                    P.log("run_failed", run_id=rid, attempts=attempt, last_error=msg[:500])
                    P.push()
                    return "failed"

    def report(self, run_ids):
        rows = []
        for rid in run_ids:
            r = self.ledger.get(rid)
            rows.append({"run": rid, "status": r["status"], "attempts": r["attempts"], "interruptions": r["interruptions"],
                         "oom_halvings": r["oom_halvings"], "last_error": r["last_error"]})
        return rows


def gpu_stats():
    if not shutil.which("nvidia-smi"):
        return {}
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        name, util, used, total = [x.strip() for x in out.splitlines()[0].split(",")]
        return {"gpu_name": name, "gpu_util_pct": float(util), "gpu_mem_used_mb": float(used), "gpu_mem_total_mb": float(total)}
    except Exception:
        return {}


def heartbeat():
    """Called every ~2 minutes by the progress timer (see the live-progress cell)."""
    orch = globals().get("ORCH")
    if orch is not None:
        orch.heartbeat()
    elif globals().get("RUN_DIR") is not None:
        rec = {"t": _utc(), "stage": PROGRESS.stage, **gpu_stats()}
        write_json_atomic(pathlib.Path(RUN_DIR) / "heartbeat.json", rec)
        PROGRESS.log("heartbeat", **{k: v for k, v in rec.items() if k not in ("t", "stage")})'''

GPU = r'''import subprocess, torch
print(subprocess.run(["nvidia-smi"], capture_output=True, text=True).stdout if shutil.which("nvidia-smi") else "no nvidia-smi")
if not torch.cuda.is_available() and not SMOKE:
    raise SystemExit("No GPU: the full runs are refused on CPU (they would take days). Runtime -> Change runtime type "
                     "-> A100 GPU (or L4), then Runtime -> Run all.")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cuda":
    props = torch.cuda.get_device_properties(0)
    GPU_NAME, GPU_GB, GPU_CC = props.name, props.total_memory / 1e9, f"{props.major}.{props.minor}"
    BF16 = torch.cuda.is_bf16_supported()
else:
    GPU_NAME, GPU_GB, GPU_CC, BF16 = "cpu", 0.0, None, False
# Effective batch 64 either way (PREREGISTRATION.md): 8 x 8 on >= 30 GB (A100), else 4 x 16 (L4, T4). If a run
# still runs out of memory, the retry policy halves the micro-batch and doubles the accumulation (same effective
# batch and update count, checked before the retry).
MICRO, ACCUM = (8, 8) if GPU_GB >= 30 else (4, 16)
SCORE_BATCH = 32 if GPU_GB >= 30 or DEVICE == "cpu" else 16   # scoring only; latency is measured at batch 32
# Precision is laya's own choice, recorded, never overridden here: laya-train 0.4.1 trains with fp16 autocast and a
# GradScaler on every CUDA GPU (it has no bf16 or precision option); laya.load scores with bf16 autocast on compute
# capability >= 8 (A100, L4: the checkpoint's amp_dtype) and fp16 below (T4). Confirmed from the installed source
# in the next cell and from each loaded agent's dtype (load_<run>.json).
INFER_PRECISION_EXPECTED = ("bf16 autocast" if GPU_CC and int(GPU_CC.split(".")[0]) >= 8 else "fp16 autocast") if DEVICE == "cuda" else "fp32"
GPU_PROFILE = {"gpu": GPU_NAME, "vram_gb": round(GPU_GB, 1), "compute_capability": GPU_CC, "bf16_supported": BF16,
               "micro_batch": MICRO, "grad_accum": ACCUM, "effective_batch": MICRO * ACCUM, "score_batch": SCORE_BATCH,
               "inference_precision_expected": INFER_PRECISION_EXPECTED}
print(json.dumps(GPU_PROFILE, indent=1))
PROGRESS.ctx["gpu"] = GPU_NAME
PROGRESS.log("gpu_profile", **GPU_PROFILE)
SLOW_GPU = DEVICE == "cuda" and ("T4" in GPU_NAME or (GPU_CC and int(GPU_CC.split(".")[0]) < 8))
if SLOW_GPU:
    print("!" * 100)
    print(f"WARNING: {GPU_NAME} (compute capability {GPU_CC}) is an older, much slower GPU. The runs will work (fp16)\n"
          "but take several times longer than on an A100 and may need more than one session; finished runs are kept.\n"
          "Prefer Runtime -> Change runtime type -> A100 GPU (or L4). A measured ETA is shown once training starts.")
    print("!" * 100)
elif DEVICE == "cuda":
    print("Rough budget (an estimate, not a measurement): 3-6 h on an A100, longer on an L4. "
          "A measured ETA is shown once training starts.")'''

PIP = '''# Pinned versions. torch stays Colab's own CUDA build (recorded in env.json).
PKGS = ["laya==0.4.1", "transformers==4.57.1", "huggingface_hub==0.36.2", "tokenizers==0.22.2",
        "safetensors==0.8.0", "scikit-learn==1.7.2"]
if EXPORT_ONNX:
    PKGS += ["onnx==1.22.0", "onnxruntime==1.29.0", "onnxscript==0.7.1"]
if not SMOKE:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *PKGS], check=True)
import importlib.metadata as md
VERSIONS = {p: md.version(p) for p in ["laya", "torch", "transformers", "huggingface_hub", "tokenizers",
                                       "safetensors", "scikit-learn", "numpy", "pandas"]}
if EXPORT_ONNX:
    for p in ("onnx", "onnxruntime", "onnxscript"):
        try:
            VERSIONS[p] = md.version(p)
        except md.PackageNotFoundError:
            VERSIONS[p] = None
print(VERSIONS)
assert VERSIONS["laya"] == "0.4.1", "laya 0.4.1 is the pre-registered version"
# Training precision, read from the installed laya source rather than assumed.
import inspect, laya.train as _lt
_src = inspect.getsource(_lt._forward) + inspect.getsource(_lt.train_model)
if DEVICE != "cuda":
    TRAIN_PRECISION = "fp32 (CPU)"
elif "dtype=torch.float16" in _src and "GradScaler" in _src:
    TRAIN_PRECISION = "fp16 autocast + GradScaler (laya 0.4.1 default on CUDA; laya-train has no precision option)"
else:
    TRAIN_PRECISION = "laya default (not confirmed from source)"
GPU_PROFILE["train_precision"] = TRAIN_PRECISION
print("training precision:", TRAIN_PRECISION)'''''

DRIVE = r'''# Durable storage: Google Drive on Colab; otherwise OUTPUT_DIR (or $LRT_OUT). The same ledger works either way.
OUT_ROOT, DURABLE = None, False
if os.environ.get("LRT_OUT"):
    OUT_ROOT, DURABLE = pathlib.Path(os.environ["LRT_OUT"]), True
elif USE_DRIVE and IN_COLAB and not SMOKE:
    try:
        from google.colab import drive
        drive.mount("/content/drive")
        OUT_ROOT, DURABLE = pathlib.Path("/content/drive/MyDrive/laya-release-triage"), True
    except Exception as e:  # declined, or a Colab-connected runtime without Drive support
        print("Google Drive not mounted:", e)
if OUT_ROOT is None:
    OUT_ROOT = pathlib.Path(OUTPUT_DIR).expanduser() if OUTPUT_DIR else (WORK / "out" if SMOKE else pathlib.Path.home() / "laya-release-triage")
    DURABLE = not IN_COLAB   # on a custom VM the disk persists; on a Colab VM it does not
    if IN_COLAB and not SMOKE:
        print("!" * 100 + "\nWARNING: saving to the Colab VM's own disk, which is deleted with the runtime. "
              "Mount Google Drive (USE_DRIVE = True) so a disconnect loses nothing finished.\n" + "!" * 100)
OUT_ROOT.mkdir(parents=True, exist_ok=True)
# One run tag per output folder, kept across reconnects: the ledger, results and live progress continue in place.
# To start a fresh run, rename or delete run_tag.txt.
_tag_file = OUT_ROOT / "run_tag.txt"
if _tag_file.exists():
    RUN_TAG = _tag_file.read_text().strip()
else:
    RUN_TAG = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    _tag_file.write_text(RUN_TAG + "\n")
RUN_DIR = OUT_ROOT / RUN_TAG          # state.json, heartbeat.json, jobs/, checkpoints/, results/
OUT = RUN_DIR
RESULTS = RUN_DIR / "results"
(RESULTS / "logs").mkdir(parents=True, exist_ok=True)
print("durable output ->", RUN_DIR, "" if DURABLE else "(NOT durable)")
PROGRESS.bind(RESULTS, RUN_TAG)
PROGRESS.log("session_start", dataset_commit=DATA_REF, manifest_sha256=MANIFEST_SHA256, runtime="colab" if IN_COLAB else "other",
             out_dir=str(RUN_DIR), durable=DURABLE, **{k: v for k, v in GPU_PROFILE.items() if k != "gpu"})
PROGRESS.heartbeat = heartbeat
PROGRESS.start_timer()
if PROGRESS.pusher:
    print(f"live progress: https://github.com/{REPO}/tree/{RESULTS_BRANCH}/{SUBDIR}/colab-runs/{RUN_TAG}")

def save_json(name, obj):
    p = RESULTS / name
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=str) + "\n")
    tmp.replace(p)
    return p'''

DATA = '''# Dataset: files listed in data/laya/MANIFEST.json at the pinned commit, each checked against its sha256.
RAW = os.environ.get("LRT_RAW") or f"https://raw.githubusercontent.com/{REPO}/{DATA_REF}/{SUBDIR}/"
DATA_DIR = WORK / "data"

def fetch(rel):
    for i in range(4):
        try:
            with urllib.request.urlopen(RAW + rel, timeout=120) as r:
                return r.read()
        except Exception as e:
            if i == 3:
                raise
            print("retry", rel, e); time.sleep(3 * (i + 1))

def sha256(b):
    return hashlib.sha256(b).hexdigest()

man_bytes = fetch("data/laya/MANIFEST.json")
assert sha256(man_bytes) == MANIFEST_SHA256, "MANIFEST.json does not match the pinned sha256"
MANIFEST = json.loads(man_bytes)
for rel, meta in MANIFEST["files"].items():
    dst = WORK / rel
    if dst.exists() and sha256(dst.read_bytes()) == meta["sha256"]:
        continue
    b = fetch(rel)
    if sha256(b) != meta["sha256"]:
        raise SystemExit(f"sha256 mismatch for {rel}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b)
for sp in ("train", "calib", "test"):
    with gzip.open(WORK / f"data/laya/{sp}.jsonl.gz", "rb") as fi, open(DATA_DIR / f"{sp}.jsonl", "wb") as fo:
        shutil.copyfileobj(fi, fo)
print(f"{len(MANIFEST['files'])} files verified (sha256) from {REPO}@{DATA_REF[:12]}")

sys.path.insert(0, str(WORK / "src"))
import numpy as np, pandas as pd
import triage_metrics as TM

def read_jsonl(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]

ROWS = {sp: read_jsonl(DATA_DIR / f"{sp}.jsonl") for sp in ("train", "calib", "test")}
QUESTIONS = json.loads((WORK / "data/questions.json").read_text())
META = pd.read_csv(WORK / "results/baseline_scores.csv.gz", keep_default_na=False)
BASELINES = json.loads((WORK / "results/baselines.json").read_text())
if SMOKE:  # a small slice for the local CPU check only
    for sp in ROWS:
        keep = [r for r in ROWS[sp] if r["expected"]["triage"] == "likely_malicious"][:6] + \\
               [r for r in ROWS[sp] if r["expected"]["triage"] == "routine"][:10]
        ROWS[sp] = keep
        with open(DATA_DIR / f"{sp}.jsonl", "w", encoding="utf-8") as f:
            for r in keep:
                f.write(json.dumps(r, ensure_ascii=False) + "\\n")
for sp, rs in ROWS.items():
    print(sp, len(rs), "releases,", sum(r["expected"]["triage"] == "likely_malicious" for r in rs), "malicious")'''

VALIDITY = '''# Validity checks fixed before any Laya run (PREREGISTRATION.md, "Data").
leak = json.loads((WORK / "results/leakage_check.json").read_text())
split_summary = json.loads((WORK / "data/split.summary.json").read_text())
test_fams = split_summary["splits"]["test"]["positives_per_family"]
fams5 = sorted(f for f, n in test_fams.items() if n >= 5)
VALIDITY = {"leakage_check": leak.get("result"), "test_families_with_5_positives": len(fams5),
            "families": fams5, "underpowered": len(fams5) < 6}
save_json("validity.json", VALIDITY)
print(json.dumps(VALIDITY, indent=1))
if leak.get("result") != "PASS" and not SMOKE:
    raise SystemExit("leakage check did not pass; the dataset must be fixed before any Laya run")
if VALIDITY["underpowered"]:
    print("UNDERPOWERED: fewer than 6 test families with >= 5 positives. Runs continue, but Laya cannot be adopted.")'''

CKPT = '''# Base checkpoints at the pinned revision (English = repo root, typed-decisions = subfolder).
from huggingface_hub import snapshot_download
HUB = pathlib.Path(os.environ.get("LRT_HUB") or WORK / "hub")   # LRT_HUB: local copy, author's CPU check only
pats = [p + f for p in ("", "typed-decisions/") for f in
        ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")]
if not os.environ.get("LRT_HUB"):
    snapshot_download(HF_REPO, revision=HF_REVISION, local_dir=str(HUB), allow_patterns=pats, token=HF_TOKEN or None)
BASES = {"EN": str(HUB), "TD": str(HUB / "typed-decisions")}
def file_sha(p, n=1 << 22):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(n), b""):
            h.update(b)
    return h.hexdigest()
CKPT_SHA = {k: file_sha(pathlib.Path(v) / "model.safetensors") if (pathlib.Path(v) / "model.safetensors").exists() else None
            for k, v in BASES.items()}
for k, v in BASES.items():
    cfg = json.loads((pathlib.Path(v) / "rl_agent_config.json").read_text())
    print(k, v, "max_len", cfg["max_len"], "head_max_len", cfg["head_max_len"], "sha256", (CKPT_SHA[k] or "-")[:16])
ENV = {"dataset_repo": REPO, "dataset_commit": DATA_REF, "manifest_sha256": MANIFEST_SHA256,
       "hf_repo": HF_REPO, "hf_revision": HF_REVISION, "checkpoint_sha256": CKPT_SHA, "versions": VERSIONS,
       "device": DEVICE, "gpu": GPU_NAME, "gpu_gb": round(GPU_GB, 1), "bf16": BF16, "micro_batch": MICRO,
       "grad_accum": ACCUM, "cpu_count": os.cpu_count(), "python": sys.version.split()[0], "smoke": SMOKE,
       "gpu_profile": GPU_PROFILE, "runtime": "colab" if IN_COLAB else "other", "durable_output": DURABLE}
# A later session may get another GPU: each session's profile is kept, and each run records its own (train_<run>.json).
_envp = RESULTS / "env.json"
if _envp.exists():
    _prev = json.loads(_envp.read_text())
    ENV["sessions"] = _prev.get("sessions", []) + [GPU_PROFILE]
else:
    ENV["sessions"] = [GPU_PROFILE]
save_json("env.json", ENV)'''

TOKENS = '''# Truncation with laya's own sequence builder: how much of each state survives each budget.
from transformers import AutoTokenizer
from laya.agent import _fix_tokenizer_config
from laya.common import build_sequence
from laya.train import to_internal

def truncation(base_dir, max_len, head_max_len):
    _fix_tokenizer_config(base_dir)
    tok = AutoTokenizer.from_pretrained(os.path.join(base_dir, "tokenizer"))
    out = {}
    for qid, q in QUESTIONS.items():
        qi = to_internal(qid, q)
        n = trunc = 0
        used, total = [], []
        for sp, rs in ROWS.items():
            for r in rs:
                if qid not in r["questions"]:
                    continue
                _, _, st = build_sequence(tok, r["state"], qi, max_len, head_max_len, return_truncation_stats=True)
                n += 1; trunc += st["truncated"]; total.append(st["state_tokens"])
        total.sort()
        out[qid] = {"items": n, "truncated": trunc, "share_truncated": round(trunc / max(1, n), 4),
                    "state_tokens_median": total[len(total) // 2] if total else None,
                    "state_tokens_p95": total[int(len(total) * 0.95)] if total else None,
                    "state_tokens_max": total[-1] if total else None}
    return out

TOKENS = {"EN@512/192 (Z-EN)": truncation(BASES["EN"], 512, 192),
          "EN@1024/256 (F-EN)": truncation(BASES["EN"], MAX_LEN, HEAD_MAX_LEN),
          "TD@1024/256 (Z-TD, F-TD)": truncation(BASES["TD"], MAX_LEN, HEAD_MAX_LEN)}
save_json("tokens.json", TOKENS)
for k, v in TOKENS.items():
    print(k, {q: (x["truncated"], x["share_truncated"]) for q, x in v.items()})'''

DRYRUN = '''# laya-train --dry-run on the real training file (tokenizer + config only). Gate: zero options_beyond_max_len.
from laya.train import TrainConfig, dry_run
LAYA_TRAIN = [shutil.which("laya-train")] if shutil.which("laya-train") else [sys.executable, "-m", "laya.train_cli"]

def train_flags(base, data, seed, epochs, out=None, eval_data=None, micro=None, accum=None):
    micro, accum = micro or MICRO, accum or ACCUM
    assert micro * accum == EFFECTIVE_BATCH, "effective batch is fixed at 64 (PREREGISTRATION.md)"
    f = ["--data", str(data), "--base", base, "--max-len", str(MAX_LEN), "--head-max-len", str(HEAD_MAX_LEN),
         "--loss", "soft-ce", "--shuffle-options", "--seed", str(seed), "--epochs", str(epochs),
         "--micro-batch", str(micro), "--grad-accum", str(accum)]
    if eval_data:
        f += ["--eval", str(eval_data)]
    if out:
        f += ["--out", str(out), "--device", DEVICE]
    return f

DRY = {}
for b in ("EN", "TD"):
    cli = subprocess.run([*LAYA_TRAIN, *train_flags(BASES[b], DATA_DIR / "train.jsonl", 0, 1,
                                                     eval_data=DATA_DIR / "calib.jsonl"), "--dry-run"],
                         capture_output=True, text=True)
    print(cli.stdout[-2000:], cli.stderr[-2000:])
    if cli.returncode != 0:
        raise SystemExit(f"laya-train --dry-run failed for {b}")
    cfg = TrainConfig(epochs=1, micro_batch=MICRO, grad_accum=ACCUM, loss="soft-ce", shuffle_options=("choice",),
                      max_len=MAX_LEN, head_max_len=HEAD_MAX_LEN, eval_data=str(DATA_DIR / "calib.jsonl"))
    s = dry_run(str(DATA_DIR / "train.jsonl"), BASES[b], cfg)
    s["cli_stdout"] = cli.stdout
    DRY[b] = s
    save_json(f"dryrun_{b}.json", s)
    bad = s["skipped"].get("options_beyond_max_len", 0) + s.get("eval_skipped", {}).get("options_beyond_max_len", 0)
    if bad:
        raise SystemExit(f"{b}: {bad} questions have options beyond max_len; the pre-registration requires zero")
U = max(DRY["EN"]["optimizer_updates"], 1)
EPOCHS = min(MAX_EPOCHS, max(MIN_EPOCHS, math.ceil(TARGET_UPDATES / U)))
if SMOKE:
    EPOCHS = 1
save_json("epochs.json", {"updates_per_epoch": U, "epochs": EPOCHS, "rule": "min(16, max(4, ceil(600 / U)))"})
print(f"train items {DRY['EN']['train_items']}, laya calibration items {DRY['EN']['calibration_items']}, "
      f"{U} updates/epoch -> {EPOCHS} epochs")'''

SCORE = '''# Scoring: P(likely_malicious) with canonical and reversed option order in one forward pass, plus the noul label check.
import laya, torch
TRIAGE = QUESTIONS["triage"]
SI = QUESTIONS.get("script_intent")
Q_SCORE = {"triage": TRIAGE, "triage_rev": dict(TRIAGE, option_order=[2, 1, 0])}
SI_DEFAULT = {k: v for k, v in SI.items() if k != "labels"} if SI else None

def score_run(run_id, ckpt, splits=("calib", "test"), rows=None, batch=None):
    """Always recomputes (the ledger decides whether a run's scores are already done) and writes atomically."""
    path = RESULTS / f"scores_{run_id}.csv.gz"
    batch = batch or SCORE_BATCH
    t0 = time.time()
    agent = laya.load(str(ckpt), device=DEVICE)
    load_s = time.time() - t0
    recs = []
    for sp in splits:
        rs = (rows or ROWS)[sp]
        t1 = time.time()
        out = agent.predict_batch([r["state"] for r in rs], Q_SCORE, batch_size=batch, sort_by_length=True)
        dt = time.time() - t1
        si_idx = [i for i, r in enumerate(rs) if "script_intent" in r["questions"]]
        si_ab, si_tf = {}, {}
        if SI and si_idx:
            o2 = agent.predict_batch([rs[i]["state"] for i in si_idx], {"si_ab": SI, "si_tf": SI_DEFAULT},
                                     batch_size=batch, sort_by_length=True)
            for i, o in zip(si_idx, o2):
                si_ab[i], si_tf[i] = o["answers"]["si_ab"]["noul"], o["answers"]["si_tf"]["noul"]
        for i, (r, o) in enumerate(zip(rs, out)):
            a, b = o["answers"]["triage"], o["answers"]["triage_rev"]
            recs.append({"key": r["id"], "split": sp, "expected": r["expected"]["triage"],
                         "p_mal": a["probabilities"]["likely_malicious"], "p_review": a["probabilities"]["review"],
                         "p_routine": a["probabilities"]["routine"], "choice": a["choice"],
                         "answer_confidence": a["answer_confidence"],
                         "p_mal_rev": b["probabilities"]["likely_malicious"], "choice_rev": b["choice"],
                         "si_expected": r["expected"].get("script_intent", ""),
                         "si_ab": si_ab.get(i, ""), "si_tf": si_tf.get(i, ""),
                         "truncated": bool(o.get("usage", {}).get("truncated")),
                         "ms_per_release_batch": 1000 * dt / max(1, len(rs))})
    df = pd.DataFrame(recs)
    tmp = path.with_name(path.name + ".tmp")
    df.to_csv(tmp, index=False, compression="gzip")
    tmp.replace(path)
    save_json(f"load_{run_id}.json", {"load_seconds": load_s, "checkpoint": str(ckpt), "score_batch": batch,
                                      "inference_precision": str(getattr(agent, "dtype", None)),
                                      "autocast": bool(getattr(agent, "amp_enabled", False)), "gpu": GPU_NAME})
    del agent; gc_collect()
    return df

def gc_collect():
    import gc; gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

class AgentRunner:
    """laya.evals runner for one loaded checkpoint (the harness behind `laya-evals run`)."""
    def __init__(self, agent): self.agent = agent
    def predict(self, state, questions, model=None, min_confidence=None):
        return self.agent.predict_batch([state], questions)[0]
    def predict_batch(self, states, questions, model=None, batch_size=None, sort_by_length=False, min_confidence=None):
        return self.agent.predict_batch(list(states), questions, batch_size=batch_size, sort_by_length=sort_by_length)

def harness(run_id, ckpt, batch=None):
    path = RESULTS / f"evals_{run_id}.json"
    from laya import evals
    agent = laya.load(str(ckpt), device=DEVICE)
    rep = evals.evaluate(AgentRunner(agent), evals.Dataset.from_jsonl(str(DATA_DIR / "test.jsonl")),
                         batch_size=batch or SCORE_BATCH, config={"run": run_id, "checkpoint": str(ckpt), "device": DEVICE})
    j = rep.to_json()
    j.pop("cases", None)
    save_json(path.name, j)
    del agent; gc_collect()
    return j'''

METRICS = '''# Pre-registered metrics (same code as the baselines: src/triage_metrics.py).
def metrics(run_id, sc):
    path = RESULTS / f"metrics_{run_id}.json"
    m = META[["split", "key", "label", "family", "category", "published", "publisher", "is_first_release"]]
    d = sc.merge(m, on=["split", "key"], how="inner")
    if len(d) != len(sc):
        raise SystemExit(f"{run_id}: {len(sc) - len(d)} scored rows missing from baseline_scores.csv.gz")
    cal, test = d[d.split == "calib"].reset_index(drop=True), d[d.split == "test"].reset_index(drop=True)
    ev = TM.evaluate(run_id, cal["p_mal"].values, test["p_mal"].values, cal, test, 0.0, 0.0)
    a = TM.alerts(cal["p_mal"].values, cal["label"].values, test["p_mal"].values)
    b = TM.alerts(cal["p_mal"].values, cal["label"].values, test["p_mal_rev"].values)
    either = a | b
    ev["order_check"] = {"argmax_changed_share": float((test["choice"] != test["choice_rev"]).mean()),
                         "mean_abs_delta_p_mal": float((test["p_mal"] - test["p_mal_rev"]).abs().mean()),
                         "alerted_either_order": int(either.sum()),
                         "alert_flip_rate": float((a ^ b).sum() / either.sum()) if either.any() else 0.0}
    yc = cal["label"].values
    ev["calib"] = {"roc_auc": float(TM.roc_auc_score(yc, cal["p_mal"])) if 0 < yc.sum() < len(yc) else None,
                   "triage_accuracy": float((cal["choice"] == cal["expected"]).mean())}
    cm, _ = TM.macro_recall(cal, TM.alerts(cal["p_mal"].values, yc, cal["p_mal"].values))
    ev["calib"]["macro_recall_at_budget"] = cm
    ev["ece_laya_temperatures"] = TM.ece(test["p_mal"].values, test["label"].values)
    si = test[test["si_expected"] != ""]
    if len(si):
        y = (si["si_expected"] == "true").values
        ab, tf = si["si_ab"].astype(float).values >= 0.5, si["si_tf"].astype(float).values >= 0.5
        ev["noul_label_check"] = {"items": int(len(si)), "accuracy_AB": float((ab == y).mean()),
                                  "accuracy_false_true": float((tf == y).mean()), "agreement": float((ab == tf).mean())}
    ev["test_states_truncated_share"] = float(test["truncated"].astype(str).isin(["True", "true", "1"]).mean()) if "truncated" in test else None
    ev["ms_per_release_gpu_batch"] = float(test["ms_per_release_batch"].iloc[0]) if len(test) else None
    save_json(path.name, ev)
    return ev

RESULTS_BY_RUN = {}'''


TRAIN = r'''# All Laya runs, in priority order, through the ledger (state.json): positive controls (P0) first, then fine-tuned
# typed-decisions and English at seed 0, then seeds 1 and 2, then the zero-shot references. Re-running this cell (or
# Run all after a disconnect) skips every run whose result files verify, re-attaches to a training process that is
# still alive, and restarts an interrupted run from its base checkpoint. The order changes no rule: every run is
# the pre-registered one, and the verdict reads the same files.
RUNS = WORK / "runs"             # local disk: laya-train's --out (it writes checkpoint_latest/ after every epoch)
CKPTS = RUN_DIR / "checkpoints"  # durable copy of each trained run's weights (controls' copies are deleted once scored)
N_TRAIN = DRY["EN"]["train_items"]
BASE_MICRO, BASE_ACCUM = MICRO, ACCUM
FINGERPRINT = {"dataset_commit": DATA_REF, "manifest_sha256": MANIFEST_SHA256, "hf_revision": HF_REVISION,
               "laya": VERSIONS["laya"], "epochs": EPOCHS, "effective_batch": EFFECTIVE_BATCH, "seeds": SEEDS,
               "smoke": SMOKE}
LEDGER = Ledger(RUN_DIR / "state.json", RUN_DIR, FINGERPRINT)
ORCH = Orchestrator(RUN_DIR, LEDGER, PROGRESS, gpu=GPU_NAME)
assert MICRO * ACCUM == EFFECTIVE_BATCH

def batch_for(run_id):
    m, a = BASE_MICRO, BASE_ACCUM
    for _ in range(LEDGER.get(run_id)["oom_halvings"]):
        m, a = oom_fallback(m, a, N_TRAIN, EPOCHS)
    return m, a

def train_on_oom(orch, run_id):
    m, a = batch_for(run_id)
    nxt = oom_fallback(m, a, N_TRAIN, EPOCHS)
    if nxt is None:
        return None
    LEDGER.update(run_id, oom_halvings=LEDGER.get(run_id)["oom_halvings"] + 1)
    gc_collect()
    return {"micro_batch": [m, nxt[0]], "grad_accum": [a, nxt[1]], "effective_batch": nxt[0] * nxt[1],
            "optimizer_updates": optimizer_updates(N_TRAIN, nxt[0], nxt[1], EPOCHS),
            "note": "same effective batch and optimizer-update count: the optimisation budget is unchanged"}

def score_batch_for(run_id):
    return max(1, SCORE_BATCH >> LEDGER.get(run_id)["score_halvings"])

def score_on_oom(orch, run_id):
    b = score_batch_for(run_id)
    if b <= 1:
        return None
    LEDGER.update(run_id, score_halvings=LEDGER.get(run_id)["score_halvings"] + 1)
    gc_collect()
    return {"score_batch": [b, score_batch_for(run_id)]}

def copy_checkpoint(src, dst):
    """Copy a finished laya-train output (without checkpoint_latest/) to durable storage, atomically by rename."""
    part = dst.with_name(dst.name + ".partial")
    shutil.rmtree(part, ignore_errors=True)
    shutil.copytree(src, part, ignore=shutil.ignore_patterns("checkpoint_latest"))
    shutil.rmtree(dst, ignore_errors=True)
    part.rename(dst)
    return dst

def train_job(run_id, base, data, eval_data, seed):
    """laya-train in a detached process; returns (out dir, micro, accum, log path, this attempt's log, job info)."""
    m, a = batch_for(run_id)
    out = RUNS / run_id
    log = RESULTS / "logs" / f"train_{run_id}.log"
    cmd = [*LAYA_TRAIN, *train_flags(base, data, seed, EPOCHS, out=out, eval_data=eval_data, micro=m, accum=a)]
    print(" ".join(map(str, cmd)))
    def prepare():   # laya-train cannot resume: a (re)started run always begins from its base checkpoint
        shutil.rmtree(out, ignore_errors=True)
    rc, tail, info = ORCH.run_job(run_id, cmd, log, marker=f"{run_id}|{out}|{m}x{a}", prepare=prepare,
                                  on_line=lambda l: train_progress(run_id, l), micro=m, accum=a)
    if rc != 0:
        kind = classify_error(tail)
        if kind == "other" and rc in (137, -9, 143, -15):
            kind = "killed"
        raise RunError(kind, f"{run_id}: laya-train exited {rc}; see {log}", tail[-6000:])
    return out, m, a, log, tail, info

def train_stage(base, data_fn, seed):
    def fn(orch, run_id):
        tr, ca = data_fn()
        out, m, a, log, text, info = train_job(run_id, BASES[base], tr, ca, seed)
        rep = json.loads((out / "train_report.json").read_text())
        rep.update({"wall_seconds": time.time() - info["started_ts"], "collapse_warning": "collapsed to the class prior" in text,
                    "gpu": GPU_NAME, "gpu_gb": round(GPU_GB, 1), "compute_capability": GPU_CC,
                    "train_precision": TRAIN_PRECISION, "micro_batch": m, "grad_accum": a, "effective_batch": m * a,
                    "optimizer_updates": optimizer_updates(N_TRAIN, m, a, EPOCHS),
                    "attempt": LEDGER.get(run_id)["attempts"], "interruptions": LEDGER.get(run_id)["interruptions"]})
        save_json(f"train_{run_id}.json", rep)
        dst = copy_checkpoint(out, CKPTS / run_id)
        PROGRESS.log("run_trained", run_id=run_id, wall_seconds=round(rep["wall_seconds"], 1), micro_batch=m, grad_accum=a,
                     gpu=GPU_NAME, train_precision=TRAIN_PRECISION)
        PROGRESS.push()
        return {"files": [RESULTS / f"train_{run_id}.json", log], "checkpoint": dst,
                "info": {"gpu": GPU_NAME, "micro_batch": m, "grad_accum": a, "wall_seconds": round(rep["wall_seconds"], 1)}}
    return Stage("train", fn, on_oom=train_on_oom)

def ckpt_of(run_id):
    loc = RUNS / run_id
    return loc if (loc / "model.safetensors").exists() and (loc / "train_report.json").exists() else CKPTS / run_id

def label_copy(sp):
    """Positive control: state -> 'label=<expected triage>; ' + json.dumps(state) (fine-tuning guide)."""
    p = DATA_DIR / f"{sp}_pc.jsonl"
    with open(p, "w", encoding="utf-8") as f:
        for r in ROWS[sp]:
            r2 = dict(r, state="label=%s; " % r["expected"]["triage"] + json.dumps(r["state"], ensure_ascii=False))
            f.write(json.dumps(r2, ensure_ascii=False) + "\n")
    return p

def score_stage(ckpt_fn, rows_fn=None, trained=True):
    def fn(orch, run_id):
        ck = ckpt_fn(run_id)
        sc = score_run(run_id, ck, rows=rows_fn() if rows_fn else None, batch=score_batch_for(run_id))
        ev = metrics(run_id, sc)
        if trained:
            tr = json.loads((RESULTS / f"train_{run_id}.json").read_text())
            ev["collapsed"] = bool(tr.get("collapse_warning")) or (ev["calib"]["roc_auc"] is not None and ev["calib"]["roc_auc"] < 0.60)
            save_json(f"metrics_{run_id}.json", ev)
            PROGRESS.log("run_scored", run_id=run_id, calib_macro_recall=ev["calib"]["macro_recall_at_budget"],
                         calib_auc=ev["calib"]["roc_auc"], collapsed=ev["collapsed"])
            print(run_id, "calib macro recall", round(ev["calib"]["macro_recall_at_budget"], 3), "calib AUC", ev["calib"]["roc_auc"],
                  "collapsed", ev["collapsed"], "| test macro recall", round(ev["macro_recall"], 3))
        else:
            PROGRESS.log("run_scored", run_id=run_id, test_macro_recall=ev["macro_recall"], test_auc=ev["roc_auc"])
            print(run_id, "macro recall", round(ev["macro_recall"], 3), "AUC", round(ev["roc_auc"], 3),
                  "flip", round(ev["order_check"]["alert_flip_rate"], 3))
        PROGRESS.push()
        return {"files": [RESULTS / f"scores_{run_id}.csv.gz", RESULTS / f"load_{run_id}.json", RESULTS / f"metrics_{run_id}.json"]}
    return Stage("score", fn, on_oom=score_on_oom)

def harness_stage(ckpt_fn):
    def fn(orch, run_id):
        harness(run_id, ckpt_fn(run_id), batch=score_batch_for(run_id))
        return {"files": [RESULTS / f"evals_{run_id}.json"]}
    return Stage("harness", fn, on_oom=score_on_oom)

def load_metrics(run_id):
    p = RESULTS / f"metrics_{run_id}.json"
    if p.exists():
        RESULTS_BY_RUN[run_id] = json.loads(p.read_text())

def cleanup_local(run_id, keep_durable=True):
    shutil.rmtree(RUNS / run_id, ignore_errors=True)   # the durable copy stays in CKPTS
    if not keep_durable:
        shutil.rmtree(CKPTS / run_id, ignore_errors=True)
    load_metrics(run_id)

pc_data = lambda: (label_copy("train"), label_copy("calib"))
pc_rows = lambda: {"calib": read_jsonl(label_copy("calib")), "test": read_jsonl(label_copy("test"))}
real_data = lambda: (DATA_DIR / "train.jsonl", DATA_DIR / "calib.jsonl")

SPECS = []
if RUN_POSITIVE_CONTROL:
    for b in ("EN", "TD"):
        SPECS.append(RunSpec(f"PC-{b}", [train_stage(b, pc_data, 0), score_stage(ckpt_of, pc_rows)],
                             on_done=lambda r: cleanup_local(r, keep_durable=False), on_skip=load_metrics))
if RUN_FINETUNE:
    for s in SEEDS:
        for b in ("TD", "EN"):
            SPECS.append(RunSpec(f"F-{b}-s{s}", [train_stage(b, real_data, s), score_stage(ckpt_of), harness_stage(ckpt_of)],
                                 on_done=cleanup_local, on_skip=load_metrics))
if RUN_ZERO_SHOT:
    for run_id, b in (("Z-EN", "EN"), ("Z-TD", "TD")):
        zck = (lambda b: lambda run_id: BASES[b])(b)
        SPECS.append(RunSpec(run_id, [score_stage(zck, trained=False), harness_stage(zck)], on_skip=load_metrics,
                             on_done=load_metrics))
print("run order:", [s.run_id for s in SPECS])
print("batch mapping:", {"gpu": GPU_NAME, "micro_batch": MICRO, "grad_accum": ACCUM, "effective_batch": MICRO * ACCUM,
                         "optimizer_updates_per_run": optimizer_updates(N_TRAIN, MICRO, ACCUM, EPOCHS),
                         "train_precision": TRAIN_PRECISION})
PROGRESS.log("run_plan", order=[s.run_id for s in SPECS], ledger=LEDGER.counts())
REPORT = ORCH.run_all(SPECS, retry_failed=RETRY_FAILED)
save_json("run_ledger.json", LEDGER.data)
print(pd.DataFrame(REPORT).to_string(index=False))
FAILED_RUNS = [r for r in REPORT if r["status"] != "done"]
if FAILED_RUNS:
    print("\nRuns that did not finish (details and tracebacks in state.json and progress.jsonl):")
    for r in FAILED_RUNS:
        print(" ", r["run"], r["status"], "-", r["last_error"])
    print("Later cells use the runs that finished. Set RETRY_FAILED = True in Settings and Run all to retry them.")'''

VERDICT = '''# Selection on calib only, then the pre-registered pass rule on test (PREREGISTRATION.md, "Pass rule").
def load_m(run_id):
    p = RESULTS / f"metrics_{run_id}.json"
    return json.loads(p.read_text()) if p.exists() else None

B = {r["method"]: r for r in BASELINES["results"]}
best_name = max(B, key=lambda k: B[k]["macro_recall"])
best = B[best_name]
# Co-primary (2026-10-10 deviation): P1-P3 also on the macro over families with >= 5 test positives, against the
# baseline that is best on that macro (picked on test, so again conservative toward Laya).
best5_name = max(B, key=lambda k: B[k]["macro_recall_min5"])
best5 = B[best5_name]
seeds = {b: {s: load_m(f"F-{b}-s{s}") for s in SEEDS} for b in ("EN", "TD")}
def ok_seeds(b):
    return {s: m for s, m in seeds[b].items() if m and not m["collapsed"]}
mean_cal = {b: (np.mean([m["calib"]["macro_recall_at_budget"] for m in ok_seeds(b).values()]) if ok_seeds(b) else -1)
            for b in ("EN", "TD")}
chosen = max(mean_cal, key=mean_cal.get)
ship_seed = max(ok_seeds(chosen), key=lambda s: ok_seeds(chosen)[s]["calib"]["macro_recall_at_budget"]) if ok_seeds(chosen) else None
pc = load_m(f"PC-{chosen}")
p0 = {"positive_control_calib_accuracy": pc["calib"]["triage_accuracy"] if pc else None,
      "positive_control_calib_auc": pc["calib"]["roc_auc"] if pc else None,
      "non_collapsed_seeds": len(ok_seeds(chosen))}
p0["pass"] = bool(pc and pc["calib"]["triage_accuracy"] >= 0.95 and (pc["calib"]["roc_auc"] or 0) >= 0.95
                  and p0["non_collapsed_seeds"] >= 2)

def conditions(m):
    pb = TM.paired_family_bootstrap(m["per_family"], best["per_family"])
    fam_floor = {f: {"laya": m["per_family"][f]["recall"], "best_baseline": best["per_family"][f]["recall"]}
                 for f in m["per_family"] if m["per_family"][f]["n"] >= 5 and f in best["per_family"]}
    fa_l, fa_b = m["false_alarms_per_busy_account_month"], best["false_alarms_per_busy_account_month"]
    pb5 = TM.paired_family_bootstrap(m["per_family"], best5["per_family"], min_n=TM.MIN_FAMILY_N)
    c = {"P1_margin": m["macro_recall"] >= best["macro_recall"] + 0.05,
         "P2_bootstrap_lower_gt_0": pb["ci95"][0] > 0,
         "P3_leave_one_family_out_ge_0.025": pb["min_leave_one_family_out_diff"] >= 0.025,
         "P1_margin_min5": m["macro_recall_min5"] >= best5["macro_recall_min5"] + 0.05,
         "P2_bootstrap_lower_gt_0_min5": pb5["ci95"][0] > 0,
         "P3_leave_one_family_out_ge_0.025_min5": pb5["min_leave_one_family_out_diff"] >= 0.025,
         "P4_family_floor": all(v["laya"] >= v["best_baseline"] - 0.15 for v in fam_floor.values()),
         "P5_alerts_le_15": m["alerts_per_1000_benign"] <= 15,
         "P5_busy_account_fa": (fa_l is None) or (fa_b is not None and fa_l <= fa_b + 0.02),
         "P6_order_flip_le_0.10": m["order_check"]["alert_flip_rate"] <= 0.10,
         "P6_ece_le_0.10": m["ece_calibrated"] <= 0.10}
    return {"conditions": c, "all": all(c.values()), "paired_bootstrap": pb, "paired_bootstrap_min5": pb5,
            "family_floor": fam_floor}

per_seed = {s: conditions(m) for s, m in seeds[chosen].items() if m}
n_pass = sum(v["all"] for v in per_seed.values())
if not p0["pass"]:
    outcome = "INCONCLUSIVE (P0 setup check failed: fix the setup; the real runs are not evidence either way)"
elif VALIDITY["underpowered"]:
    outcome = "NOT ADOPTED (underpowered test split: fewer than 6 families with >= 5 positives)"
elif n_pass >= 2:
    outcome = "PASS: move fine-tuned Laya to shadow mode (PREREGISTRATION.md adoption rule)"
else:
    outcome = "FAIL: Laya is not adopted"
VERDICT = {"outcome": outcome, "best_baseline": best_name, "best_baseline_macro_recall": best["macro_recall"],
           "best_baseline_min5": best5_name, "best_baseline_macro_recall_min5": best5["macro_recall_min5"],
           "chosen_base": chosen, "calib_mean_macro_recall_by_base": mean_cal, "shipped_seed": ship_seed,
           "P0": p0, "seeds_passing_P1_to_P6": n_pass, "per_seed": per_seed}
save_json("verdict.json", VERDICT)
print(outcome)
print(json.dumps({s: v["conditions"] for s, v in per_seed.items()}, indent=1))'''

LATENCY = '''# Latency: GPU (batch 32, after warm-up) and a CPU estimate (batch 1, all VM cores) for the shipped checkpoint.
SHIP_ID = f"F-{chosen}-s{ship_seed}" if ship_seed is not None else None
SHIP = CKPTS / SHIP_ID if SHIP_ID else None
if SHIP is not None and not (SHIP / "model.safetensors").exists():
    # Only if its durable copy was deleted: re-train with the same seed, recorded as its own run.
    print("the shipped checkpoint's durable copy is missing: re-training it with the same seed as", SHIP_ID + "-retrain")
    ORCH.run_one(RunSpec(SHIP_ID + "-retrain", [train_stage(chosen, real_data, ship_seed)]))
    SHIP = CKPTS / (SHIP_ID + "-retrain")
    if not (SHIP / "model.safetensors").exists():
        SHIP = None
LAT = {"cpu_count": os.cpu_count(), "note": "CPU figure is an estimate on the Colab VM, not the 4-CPU product machine"}
if SHIP is not None:
    states = [r["state"] for r in ROWS["test"]][:256]
    q = {"triage": TRIAGE}
    t0 = time.time(); ag = laya.load(str(SHIP), device=DEVICE); LAT["gpu_load_seconds"] = time.time() - t0
    ag.predict_batch(states[:32], q, batch_size=32)
    if DEVICE == "cuda": torch.cuda.synchronize()
    t0 = time.time(); ag.predict_batch(states, q, batch_size=32)
    if DEVICE == "cuda": torch.cuda.synchronize()
    LAT["gpu_ms_per_release_batch32"] = 1000 * (time.time() - t0) / len(states)
    del ag; gc_collect()
    torch.set_num_threads(os.cpu_count())
    t0 = time.time(); ag = laya.load(str(SHIP), device="cpu"); LAT["cpu_load_seconds"] = time.time() - t0
    ag.predict_batch(states[:1], q)
    ts = []
    for s in states[:4 if SMOKE else 32]:
        t1 = time.time(); ag.predict_batch([s], q); ts.append(1000 * (time.time() - t1))
    LAT["cpu_ms_per_release_batch1_median"] = float(np.median(ts)); LAT["cpu_samples"] = len(ts)
    del ag; gc_collect()
save_json("latency.json", LAT)
print(LAT)'''

SAVE = '''# The shipped checkpoint (chosen on calib only) is already on durable storage: <run dir>/checkpoints/<run>.
if SHIP is not None:
    print("shipped checkpoint:", SHIP, "| sha256", file_sha(SHIP / "model.safetensors")[:16])
    save_json("shipped_checkpoint.json", {"run": SHIP_ID, "path": str(SHIP),
                                         "model_sha256": file_sha(SHIP / "model.safetensors")})'''

ONNX = '''# Optional: ONNX export with receptron/laya's export/export_onnx.py (the Node runtime's format), parity and CPU latency.
if EXPORT_ONNX and SHIP is not None:
    script = WORK / "export_onnx.py"
    url = f"https://raw.githubusercontent.com/receptron/laya/{RECEPTRON_COMMIT}/export/export_onnx.py"
    with urllib.request.urlopen(url, timeout=60) as r:
        script.write_bytes(r.read())
    # The script imports `rl_common.build_model` from the checkpoint directory (the original Hub layout);
    # laya.common.build_model is the same builder, so a one-line shim in a copy of the checkpoint serves it.
    exp_in = WORK / "export_in"
    shutil.copytree(SHIP, exp_in, dirs_exist_ok=True)
    (exp_in / "rl_common.py").write_text("from laya.common import build_model  # noqa: F401\\n")
    onnx_dir = OUT / f"onnx_{SHIP_ID}"
    pr = subprocess.run([sys.executable, str(script), str(exp_in), str(onnx_dir)], capture_output=True, text=True)
    (RESULTS / "logs" / "export_onnx.log").write_text(pr.stdout + pr.stderr)
    print(pr.stdout[-1500:], pr.stderr[-1500:])
    ONNX_RES = {"returncode": pr.returncode, "script_sha256": sha256(script.read_bytes()), "out_dir": str(onnx_dir)}
    if pr.returncode == 0:
        import onnxruntime as ort
        from laya.common import build_sequence, temp_bucket, QTYPES
        from laya.train import to_internal
        ag = laya.load(str(SHIP), device="cpu")
        lcfg = json.loads((onnx_dir / "laya_config.json").read_text())
        qi = to_internal("triage", TRIAGE)
        tscale = lcfg.get("temperature_by_options", {}).get(temp_bucket(QTYPES["choice"], 3), lcfg["temperature"][0])
        sess = ort.InferenceSession(str(onnx_dir / "laya.onnx"), providers=["CPUExecutionProvider"])
        rows = ROWS["test"][:8 if SMOKE else 64]
        ref = ag.predict_batch([r["state"] for r in rows], {"triage": TRIAGE}, batch_size=8)
        dp, ms = [], []
        for r, o in zip(rows, ref):
            ids, mk = build_sequence(ag.tok, r["state"], qi, lcfg["max_len"], lcfg["head_max_len"])
            feed = {"input_ids": np.array([ids], dtype=np.int64), "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
                    "marker_pos": np.array([mk], dtype=np.int64), "marker_mask": np.ones((1, len(mk)), dtype=bool),
                    "qtype": np.array([QTYPES["choice"]], dtype=np.int64)}
            t1 = time.time(); logits = sess.run(None, feed)[0][0]; ms.append(1000 * (time.time() - t1))
            z = logits / tscale; p = np.exp(z - z.max()); p /= p.sum()
            dp.append(abs(float(p[list(TRIAGE["criteria"]).index("likely_malicious")]) - o["answers"]["triage"]["probabilities"]["likely_malicious"]))
        ONNX_RES.update({"parity_rows": len(rows), "max_abs_delta_p_mal": max(dp), "mean_abs_delta_p_mal": float(np.mean(dp)),
                         "onnx_cpu_ms_per_release_median": float(np.median(ms)),
                         "bytes": sum(f.stat().st_size for f in onnx_dir.glob("laya.onnx*"))})
        del ag; gc_collect()
    save_json("onnx_export.json", ONNX_RES)
    print({k: v for k, v in ONNX_RES.items() if k != "script_sha256"})'''

SUMMARY = '''# One summary table: baselines and every Laya run, test split, same budget and code.
cols = ["macro_recall", "macro_recall_ci95_family_bootstrap", "macro_recall_min5", "macro_recall_without_largest_family", "micro_recall",
        "precision", "alerts_per_1000_benign", "false_alarms_per_busy_account_month", "roc_auc", "average_precision",
        "ece_calibrated"]
# Reporting only (gate review 2026-10-10; not in the pass rule): macro recall without dependency-confusion, and
# macro recall / alerts per 1,000 benign / ROC AUC within first releases (1st) and later releases (later) separately.
def reporting_cols(r):
    ro = r.get("reporting_only") or {}
    out = {"macroR_noDC": ro.get("macro_recall_excl_dependency_confusion"),
           "macroR5_noDC": ro.get("macro_recall_min5_excl_dependency_confusion")}
    for nm, short in (("first_release", "1st"), ("non_first_release", "later")):
        st = (ro.get("by_first_release") or {}).get(nm) or {}
        out.update({f"{short}_macroR": st.get("macro_recall"), f"{short}_macroR5": st.get("macro_recall_min5"),
                    f"{short}_macroR_noDC": st.get("macro_recall_excl_dependency_confusion"),
                    f"{short}_alerts_1k": st.get("alerts_per_1000_benign"), f"{short}_auc": st.get("roc_auc")})
    return out

rows_out, rows_rep = [], []
for r in BASELINES["results"]:
    rows_out.append({"method": r["method"], **{c: r.get(c) for c in cols}, "order_flip": None, "collapsed": None})
    rows_rep.append({"method": r["method"], **reporting_cols(r)})
for run_id in sorted(p.stem.replace("metrics_", "") for p in RESULTS.glob("metrics_*.json")):
    m = load_m(run_id)
    rows_out.append({"method": "laya " + run_id, **{c: m.get(c) for c in cols},
                     "order_flip": m["order_check"]["alert_flip_rate"], "collapsed": m.get("collapsed")})
    rows_rep.append({"method": "laya " + run_id, **reporting_cols(m)})
T = pd.DataFrame(rows_out)
TR = pd.DataFrame(rows_rep)
fmt = T.copy()
fmt["macro_recall_ci95_family_bootstrap"] = fmt["macro_recall_ci95_family_bootstrap"].map(
    lambda v: f"[{v[0]:.3f}, {v[1]:.3f}]" if isinstance(v, list) else "")
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print(fmt.round(3).to_string(index=False))
print()
print("Reporting only (not in the pass rule): without dependency-confusion; first releases (1st) vs later releases")
print(TR.round(3).to_string(index=False))
print()
print("VERDICT:", VERDICT["outcome"])
print("best baseline:", VERDICT["best_baseline"], "| chosen base:", VERDICT["chosen_base"], "| shipped seed:", VERDICT["shipped_seed"])
def _md(t):
    try:
        return t.round(3).to_markdown(index=False)
    except ImportError:  # tabulate missing
        return "```\\n" + t.round(3).to_string(index=False) + "\\n```"
table = _md(fmt) + ("\\n\\n## Reporting only (not in the pass rule)\\n\\nMacro recall without dependency-confusion (noDC), "
                    "and metrics within first releases (1st) and later releases (later), at the same calib threshold.\\n\\n"
                    + _md(TR))
RUNS_T = pd.DataFrame([{"run": rid, "status": r["status"], "attempts": r["attempts"], "interruptions": r["interruptions"],
                        "gpu": (r["stages"].get("train", {}).get("info", {}) or {}).get("gpu"),
                        "micro_x_accum": "%sx%s" % ((r["stages"].get("train", {}).get("info", {}) or {}).get("micro_batch"),
                                                    (r["stages"].get("train", {}).get("info", {}) or {}).get("grad_accum")),
                        "train_wall_min": round(((r["stages"].get("train", {}).get("info", {}) or {}).get("wall_seconds") or 0) / 60, 1),
                        "last_error": r["last_error"]} for rid, r in LEDGER.data["runs"].items()])
print()
print("Execution (state.json):")
print(RUNS_T.to_string(index=False))
save_json("run_ledger.json", LEDGER.data)
(RESULTS / "summary.md").write_text("# Laya release triage: summary\\n\\n" + table
                                    + f"\\n\\n**Verdict:** {VERDICT['outcome']}\\n"
                                    + "\\n## Execution (not part of any rule)\\n\\n" + _md(RUNS_T) + "\\n")
shutil.make_archive(str(OUT / "results"), "zip", RESULTS)
print("\\nSend back:", OUT / "results.zip", "(or the folder", RESULTS, ")")'''


def build(data_ref: str, manifest_sha: str) -> nbformat.NotebookNode:
    nb = new_notebook()
    nb.metadata = {"accelerator": "GPU", "colab": {"gpuType": "A100", "provenance": []},
                   "kernelspec": {"display_name": "Python 3", "name": "python3"},
                   "language_info": {"name": "python"}}
    def staged(name, src):
        """Mark the start and end of a stage in progress.jsonl (and push at the end)."""
        return new_code_cell(f'PROGRESS.begin("{name}")\n' + src + f'\nPROGRESS.end("{name}")')

    cells = [
        new_markdown_cell(INTRO),
        new_markdown_cell("## 1. Settings"), new_code_cell(CONFIG.replace("__DATA_REF__", data_ref).replace("__MANIFEST_SHA256__", manifest_sha)),
        new_markdown_cell("## 1b. Live progress to GitHub (only if a `GH_TOKEN` Colab secret exists)"), new_code_cell(PROGRESS_CELL),
        new_markdown_cell("## 1c. Resume, retry and keep-going plumbing (definitions only)\n\n"
                          "A ledger (`state.json`) on durable storage, training in a detached background process with "
                          "a watchdog, the retry policy and the heartbeat. Execution only: no experiment rule lives here."),
        new_code_cell(RUNNER_CELL),
        new_markdown_cell("## 2. GPU check"), staged("gpu", GPU),
        new_markdown_cell("## 3. Install pinned packages"), staged("install", PIP),
        new_markdown_cell("## 4. Durable storage (Google Drive, or `OUTPUT_DIR` off Colab)"), staged("drive", DRIVE),
        new_markdown_cell("## 5. Dataset (sha256-verified)"), staged("data", DATA),
        new_markdown_cell("## 6. Validity checks (before any Laya run)"), staged("validity", VALIDITY),
        new_markdown_cell("## 7. Base checkpoints at the pinned revision"), staged("checkpoints", CKPT),
        new_markdown_cell("## 8. Token budget and truncation"), staged("tokens", TOKENS),
        new_markdown_cell("## 9. `laya-train --dry-run` and the epoch budget"), staged("dryrun", DRYRUN),
        new_markdown_cell("## 10. Scoring, order check and Laya's eval harness (definitions)"), staged("score_defs", SCORE),
        new_markdown_cell("## 11. Metrics (definitions)"), staged("metric_defs", METRICS),
        new_markdown_cell("## 12. All runs, most decision-relevant first (the long part: several hours on an A100)\n\n"
                          "Positive controls, fine-tunes at seed 0 (typed-decisions, then English), seeds 1 and 2, then "
                          "the zero-shot references. Re-running this cell skips finished runs and re-attaches to a "
                          "training process that is still alive. Stopping the cell does not stop a training process "
                          "already started; *Runtime → Disconnect and delete runtime* does."), staged("train", TRAIN),
        new_markdown_cell("## 13. Verdict (pre-registered rule)"), staged("verdict", VERDICT),
        new_markdown_cell("## 14. Latency"), staged("latency", LATENCY),
        new_markdown_cell("## 15. Record the chosen checkpoint (already on durable storage)"), staged("save_checkpoint", SAVE),
        new_markdown_cell("## 16. Optional ONNX export (receptron/laya script)"), staged("onnx", ONNX),
        new_markdown_cell("## 17. Summary"), staged("summary", SUMMARY),
    ]
    nb.cells = cells
    return nb


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-ref", required=True)
    ap.add_argument("--manifest-sha256", required=True)
    ap.add_argument("--out", default=str(HERE / "laya_release_triage.ipynb"))
    a = ap.parse_args()
    nb = build(a.data_ref, a.manifest_sha256)
    nbformat.validate(nb)
    nbformat.write(nb, a.out)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
