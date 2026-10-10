"""Laya release triage: the notebook's stages and its control panel (execution and presentation plumbing only).

The Colab notebook (colab/laya_release_triage.ipynb) has two code cells: the Settings form and a "Run" cell. The Run
cell downloads this file at a pinned commit, checks its sha256 and calls run(globals(), ...), which executes the
stages below one after another in the notebook's own namespace (so every variable is still there afterwards, as with
the former one-cell-per-stage notebook) while a single panel shows what is happening.

The stage sources (CONFIG ... FINISH) are the former notebook cells, moved here verbatim. Only PROGRESS_CELL and
RUNNER_CELL (plumbing: hooks for the panel) changed; no experiment rule, data, threshold, run order, metric or pass
condition lives in the panel code at the end of this file (test_dashboard.py checks the rule-bearing stage sources
byte for byte).

Panel: core ipywidgets only (they work natively in Colab); without ipywidgets, a compact text status instead. The
state model (DashState) does not import ipywidgets and is unit-tested on its own.
"""
from __future__ import annotations

CONFIG = '''# Pinned inputs (fixed by PREREGISTRATION.md; do not edit) and runtime detection. Options are in the Settings form.
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
LOCAL_CHECK = os.environ.get("LRT_SMOKE") == "1"   # the author's local CPU check only (no installs, no Drive)
SMOKE = bool(SMOKE) or LOCAL_CHECK
try:   # Colab (hosted or Colab-managed runtime) vs. any other Jupyter (custom VM, local)
    IN_COLAB = importlib.util.find_spec("google.colab") is not None
except (ImportError, ValueError):
    IN_COLAB = False
CONTENT = pathlib.Path(os.environ.get("LRT_CONTENT") or "/content")   # Colab's /content (LRT_CONTENT: tests only)
# Fast local disk: dataset copy, base checkpoints, training output, results; copied to Drive as they are finished.
WORK = pathlib.Path(os.environ.get("LRT_WORK") or (CONTENT / "work" if IN_COLAB and CONTENT.is_dir()
                                                   else pathlib.Path.home() / "lrt-work"))
WORK.mkdir(parents=True, exist_ok=True)
print("runtime", "Colab" if IN_COLAB else "non-Colab Jupyter", "| local work dir", WORK, "| SMOKE (not the experiment)" if SMOKE else "")
if IN_COLAB:
    print("Pro+ background execution lets you close the tab once runs have started; if your runtime-type dialog "
          "shows a Background execution toggle, enable it.")
print("settings:", {"RUN_TAG": RUN_TAG or "(continue / new)", "RETRY_FAILED": RETRY_FAILED,
                    "AUTO_RELEASE_RUNTIME": AUTO_RELEASE_RUNTIME, "PUSH_PROGRESS": PUSH_PROGRESS, "SMOKE": SMOKE})'''

PROGRESS_CELL = r'''# Secrets and live progress. Secrets are read with google.colab.userdata (key icon in the left bar; each secret
# needs "Notebook access" on); on a runtime without google.colab, from environment variables of the same names.
# Values are kept in memory only and never printed, logged or written to disk.
#   GH_TOKEN (optional, used only if PUSH_PROGRESS): progress and the small results/*.json files are pushed to branch
#     RESULTS_BRANCH of REPO every ~2 minutes and at the end of every stage, through the GitHub contents REST API
#     (the token goes only in the Authorization header to api.github.com; no git credentials are created).
#   HF_TOKEN (optional): set as the HF_TOKEN environment variable for huggingface_hub (download rate limits only).
#     It is removed from the environment of the training processes.
# Without them the run is the same and saves to Drive only. Every ~2 minutes the timer also writes a heartbeat
# (time, run, epoch/step, GPU, minutes since the last log line) to progress.jsonl and syncs small files to Drive.
import os, base64, datetime, re, threading, traceback, uuid, urllib.error, urllib.parse
RESULTS_BRANCH = "results/laya-colab"
PUSH_EVERY_S = globals().get("PUSH_EVERY_S", 120)
SMALL_FILE_BYTES = 512 * 1024


def read_secret(name):
    """(value or None, note). The note explains a missing value; the value itself is never shown."""
    try:
        from google.colab import userdata
    except ImportError:   # not Colab (custom VM, local Jupyter): an environment variable instead
        t = os.environ.get(name)
        return (t.strip(), "environment variable") if isinstance(t, str) and t.strip() else (None, f"no {name} environment variable")
    not_found = getattr(userdata, "SecretNotFoundError", ())
    no_access = getattr(userdata, "NotebookAccessError", ())
    try:
        t = userdata.get(name)
    except not_found:
        return None, (f"no Colab secret named {name} (key icon in the left bar -> Add new secret, name {name}, "
                      "then turn on Notebook access)")
    except no_access:
        return None, (f"the Colab secret {name} exists but this notebook has no access to it: key icon in the left "
                      f"bar -> turn on Notebook access for {name} (or click Grant access when asked), then Run all again")
    except Exception as e:   # e.g. the access dialog timed out
        return None, f"could not read the Colab secret {name} ({type(e).__name__})"
    if isinstance(t, str) and t.strip():
        return t.strip(), "Colab secret"
    return None, f"the Colab secret {name} is empty"


def _read_gh_token():
    return read_secret("GH_TOKEN")[0]


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
        self._stop = threading.Event()
        self.heartbeat = None     # set later: called every PUSH_EVERY_S, before the push
        self.after_stage = None   # set later: called at the end of every stage (sync to Drive)
        self.listener = globals().get("PROGRESS_LISTENER")   # the control panel: sees every event (display only)
        self.last_push_ok = None
        self.snapshot_files = None   # set by the control panel: callable -> {name: bytes} (dashboard.html), pushed too
        self._snap_prev = {}

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
        if self.listener is not None:
            try:
                self.listener(rec)
            except Exception:
                pass

    def begin(self, stage):
        self.stage = stage
        self.log("stage_start")

    def end(self, stage):
        self.stage = stage
        self.log("stage_end")
        if self.after_stage is not None:
            try:
                self.after_stage()
            except Exception as e:
                print("sync after stage failed:", type(e).__name__, e)
        self.push()

    def error(self, exc):
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        self.log("error", error=f"{type(exc).__name__}: {exc}"[:2000], traceback=tb[-20000:])
        self.push()

    def push(self):
        """Push progress.jsonl and any new or changed small results file. Safe to call from any thread.
        Returns None when pushing is off, else True if everything outstanding was pushed."""
        if self.pusher is None or not self.pusher.enabled or self.run_tag is None:
            return None
        ok = True
        with self._lock:
            if self._dirty:
                if self.pusher.put("progress.jsonl", "".join(l + "\n" for l in self.lines).encode(),
                                   f"colab progress {self.run_tag}: {self.stage}"):
                    self._dirty = False
                else:
                    ok = False
            for p in sorted(list(self.results.glob("*.json")) + list(self.results.glob("summary.md"))):
                try:
                    if p.stat().st_size > SMALL_FILE_BYTES:
                        continue
                    b = p.read_bytes()
                except OSError:
                    continue
                h = hashlib.sha256(b).hexdigest()
                if self._pushed.get(p.name) != h:
                    if self.pusher.put(f"results/{p.name}", b, f"colab results {self.run_tag}: {p.name}"):
                        self._pushed[p.name] = h
                    else:
                        ok = False
            snap = None
            if self.snapshot_files is not None:
                try:
                    snap = self.snapshot_files()
                except Exception:
                    snap = None
            for name, b in (snap or {}).items():   # the panel as static HTML; the previous one kept as <name>.prev
                h = hashlib.sha256(b).hexdigest()
                if self._pushed.get(name) == h:
                    continue
                prev = self._snap_prev.get(name)
                if prev is not None:
                    stem, _, ext = name.rpartition(".")
                    self.pusher.put(f"{stem}.prev.{ext}", prev, f"colab panel {self.run_tag}: previous")
                if self.pusher.put(name, b, f"colab panel {self.run_tag}: {self.stage}"):
                    self._pushed[name], self._snap_prev[name] = h, b
                else:
                    ok = False
        if ok and self.pusher.enabled:
            self.last_push_ok = time.time()
        return ok and self.pusher.enabled

    def start_timer(self):
        if self._thread is not None:
            return
        self._stop.clear()
        def loop():
            while not self._stop.wait(PUSH_EVERY_S):
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

    def stop_timer(self):
        """Stop the heartbeat/push timer (before the final sync), waiting for a heartbeat in progress."""
        t, self._thread = self._thread, None
        self._stop.set()
        if t is not None and t is not threading.current_thread():
            t.join(timeout=300)


_hf, _note = (None, "local check") if globals().get("LOCAL_CHECK") else read_secret("HF_TOKEN")
if _hf:
    os.environ["HF_TOKEN"] = _hf   # read by huggingface_hub only; never printed
print("HF_TOKEN:", "set from the " + _note + " (value not shown)" if _hf else "not set (optional): " + _note)
if globals().get("LOCAL_CHECK"):
    _tok, _note = None, "local check"
elif not globals().get("PUSH_PROGRESS", True):
    _tok, _note = None, "PUSH_PROGRESS is off in Settings"
else:
    _tok, _note = read_secret("GH_TOKEN")
PROGRESS = Progress(GitHubPusher(_tok, REPO, RESULTS_BRANCH, "research/laya-proper", "") if _tok else None)
del _tok, _hf
print("live progress to GitHub:", f"on (branch {RESULTS_BRANCH} of {REPO})" if PROGRESS.pusher else f"off ({_note}); Drive only")

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
#   * Storage: everything is written on the VM's fast local disk; DriveSync copies it to Google Drive (temporary file +
#     fsync + rename, so a Drive file is never half-written): small files on every heartbeat, everything after every
#     stage and run. On a new VM the ledger, results, logs and job files are restored from Drive first.
#   * Status: shown by the control panel (lrt_runner.Dashboard, through the on_status/on_line hooks), else one table
#     updated in place (runs, status, epoch, ETA, GPU use, last Drive sync); logs stay in files.
#   * finish(): final sync, sha256 verification on Drive, last GitHub push, Drive flush + unmount, and only then
#     (if AUTO_RELEASE_RUNTIME) runtime.unassign(). Nothing is released if any of these failed.
# laya 0.4.1 cannot resume a run from checkpoint_latest/ (weights only, no optimizer/scheduler/RNG state, and no
# resume option in laya-train), so an interrupted run restarts from its base checkpoint; finished runs are kept.
import os, re, sys, json, time, math, html, shutil, signal, socket, hashlib, pathlib, datetime, threading, traceback, subprocess, zipfile
MAX_ATTEMPTS = globals().get("MAX_ATTEMPTS", 3)
MAX_INTERRUPTIONS = globals().get("MAX_INTERRUPTIONS", 5)   # disconnects that restart a run without using an attempt
STALL_MINUTES = globals().get("STALL_MINUTES", 30)
POLL_S = globals().get("POLL_S", 5)
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


def atomic_copy(src, dst):
    """Copy src to dst through a temporary file in dst's folder, fsync, then rename: dst is always either the old or
    the new complete file, never a partial one (also on the Google Drive mount). Raises OSError on failure."""
    src, dst = pathlib.Path(src), pathlib.Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.tmp{os.getpid()}-{threading.get_ident()}")
    try:
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            shutil.copyfileobj(fi, fo, 1 << 22)
            fo.flush()
            os.fsync(fo.fileno())
        os.replace(tmp, dst)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


TMP_NAME = re.compile(r"\.tmp[0-9-]*$|\.partial$")


class DriveSync:
    """Mirrors the local run folder (fast disk) to its durable copy (Google Drive). Never raises from sync().
    small sync (heartbeat): state.json, heartbeat.json, results/ files up to SMALL_MAX, jobs/*.job.json.
    full sync (end of every stage and run, and finish()): every file, checkpoints and results.zip included.
    Temporary files, *.partial folders and job exit codes are never copied. Unchanged files are skipped (local size
    and mtime against the last copy). restore() brings back the ledger, results, logs and job files on a new VM;
    checkpoints are restored on demand (restore_tree)."""
    SMALL_MAX = 8 << 20

    def __init__(self, local, remote, enabled=True):
        self.local = pathlib.Path(local)
        self.remote = pathlib.Path(remote) if remote else None
        self.local.mkdir(parents=True, exist_ok=True)
        same = self.remote is not None and self.remote.resolve() == self.local.resolve()
        self.enabled = bool(enabled and self.remote is not None and not same)
        self._seen = {}
        self._lock = threading.RLock()
        self.last_ok, self.last_error, self.errors_total, self.copied_total = None, None, 0, 0
        self.last_error_t = None

    @staticmethod
    def skip(rel):
        parts = rel.split("/")
        return (any(x.startswith(".") or TMP_NAME.search(x) for x in parts)
                or (parts[0] == "jobs" and not parts[-1].endswith(".job.json")))

    def small(self, rel, size):
        top = rel.split("/")[0]
        if "/" not in rel:
            return rel != "results.zip" and size <= self.SMALL_MAX
        return top == "jobs" or (top == "results" and size <= self.SMALL_MAX)

    @staticmethod
    def _files(root):
        root = pathlib.Path(root)
        if not root.is_dir():
            return []
        out = []
        for d, dirs, files in os.walk(root):
            dirs[:] = sorted(x for x in dirs if not x.startswith(".") and not x.endswith(".partial"))
            for f in sorted(files):
                out.append(str((pathlib.Path(d) / f).relative_to(root)).replace(os.sep, "/"))
        return out

    def rels(self):
        return [r for r in self._files(self.local) if not self.skip(r)]

    def sync(self, full=False):
        res = {"copied": [], "deleted": [], "errors": []}
        if not self.enabled:
            return res
        with self._lock:
            for rel in self.rels():
                src = self.local / rel
                try:
                    st = src.stat()
                except OSError:
                    continue   # removed meanwhile
                if not full and not self.small(rel, st.st_size):
                    continue
                key = (st.st_size, st.st_mtime_ns)
                if self._seen.get(rel) == key and (self.remote / rel).exists():
                    continue
                try:
                    atomic_copy(src, self.remote / rel)
                    self._seen[rel] = key
                    res["copied"].append(rel)
                except OSError as e:
                    res["errors"].append(f"{rel}: {type(e).__name__}: {e}"[:300])
            rj = self.remote / "jobs"
            if rj.is_dir():   # finished jobs: their bookkeeping files go from Drive too
                for p in rj.iterdir():
                    if p.name.endswith(".job.json") and not (self.local / "jobs" / p.name).exists():
                        try:
                            p.unlink()
                            res["deleted"].append(f"jobs/{p.name}")
                        except OSError as e:
                            res["errors"].append(f"jobs/{p.name}: {type(e).__name__}")
            self.copied_total += len(res["copied"])
            if res["errors"]:
                self.errors_total += len(res["errors"])
                self.last_error = res["errors"][0]
                self.last_error_t = time.time()
            else:
                self.last_ok = time.time()
        return res

    def delete(self, rel):
        """Remove a file or folder from the durable copy (e.g. a positive control's checkpoint once scored)."""
        if not self.enabled:
            return
        with self._lock:
            p = self.remote / rel
            try:
                shutil.rmtree(p) if p.is_dir() else p.unlink()
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"could not delete {p} on Drive: {type(e).__name__}")
            for k in [k for k in self._seen if k == rel or k.startswith(rel.rstrip("/") + "/")]:
                self._seen.pop(k, None)

    def _restore(self, rels):
        done = []
        for rel in rels:
            dst = self.local / rel
            if self.skip(rel) or dst.exists():
                continue   # the local copy (same VM, kernel restart) is the newer one
            atomic_copy(self.remote / rel, dst)
            st = dst.stat()
            self._seen[rel] = (st.st_size, st.st_mtime_ns)
            done.append(rel)
        return done

    def restore(self):
        """New VM: copy the ledger, heartbeat, results (with logs) and job files back from Drive."""
        if not self.enabled:
            return []
        with self._lock:
            rels = [r for r in self._files(self.remote)
                    if ("/" not in r and r != "results.zip") or r.split("/")[0] in ("results", "jobs")]
            return self._restore(rels)

    def restore_tree(self, rel_dir):
        """Copy one folder (e.g. checkpoints/<run>) back from Drive if it is missing locally."""
        if not self.enabled or not (self.remote / rel_dir).is_dir():
            return []
        with self._lock:
            return self._restore([rel_dir.rstrip("/") + "/" + r for r in self._files(self.remote / rel_dir)])

    def verify(self, rels=None, deep=lambda rel: not rel.startswith(("checkpoints/", "onnx_"))):
        """Problems (empty list = fine): every file exists on Drive with the local sha256 (size only where deep()
        is False: large checkpoints, whose model sha256 the ledger already records)."""
        if not self.enabled:
            return ["no durable copy configured"]
        out = []
        for rel in (self.rels() if rels is None else rels):
            a, b = self.local / rel, self.remote / rel
            if not b.exists():
                out.append(f"{rel}: missing on Drive")
            elif not a.exists():
                out.append(f"{rel}: missing locally")
            elif deep(rel) and sha256_file(a) != sha256_file(b):
                out.append(f"{rel}: sha256 differs on Drive")
            elif a.stat().st_size != b.stat().st_size:
                out.append(f"{rel}: size differs on Drive")
        return out


def finish(sync, progress, auto_release, unmount=None, unassign=None, zip_rel="results.zip"):
    """End of the notebook: final sync to Drive, sha256 verification (results.zip also opened and checked), a last
    GitHub push, Drive flush + unmount, then runtime.unassign() if auto_release. Nothing is released if any step
    failed; the reasons are printed and returned."""
    out = {"problems": [], "synced": 0, "verified": 0, "pushed": None, "unmounted": False, "released": False}
    P = out["problems"]
    progress.stop_timer()
    progress.log("finish_start", auto_release=bool(auto_release))
    if not (sync.local / zip_rel).exists():
        P.append(f"{zip_rel} missing locally (did the Summary cell finish?)")
    if not sync.enabled:
        P.append("no durable copy configured (Google Drive not mounted)")
    else:
        r = sync.sync(full=True)
        out["synced"] = len(r["copied"])
        P += ["sync failed: " + e for e in r["errors"]]
        rels = sync.rels()
        P += sync.verify(rels)
        out["verified"] = len(rels)
        rz = sync.remote / zip_rel
        if rz.exists():
            try:
                with zipfile.ZipFile(rz) as z:
                    bad = z.testzip()
                if bad is not None:
                    P.append(f"{zip_rel} on Drive: corrupt member {bad}")
            except (OSError, zipfile.BadZipFile) as e:
                P.append(f"{zip_rel} on Drive cannot be read: {type(e).__name__}")
    pusher = progress.pusher
    if pusher is not None and pusher.enabled:
        out["pushed"] = progress.push()
        if not out["pushed"]:
            P.append(f"final GitHub push failed ({pusher.last_error})")
    if not P and unmount is not None:
        try:
            unmount()   # google.colab.drive.flush_and_unmount: waits until Drive has every write
            out["unmounted"] = True
            sync.enabled = False
        except Exception as e:
            P.append(f"Drive flush_and_unmount failed: {type(e).__name__}: {e}")
    where = sync.remote if sync.remote is not None else sync.local
    if P:
        print("NOT releasing the runtime, because:")
        for x in P:
            print("  -", x)
        print("Fix the cause (e.g. Drive full or not mounted), then run this cell again. The runtime keeps running "
              "(and spending compute units) until you release it: Runtime -> Disconnect and delete runtime.")
    elif not auto_release:
        print(f"Everything is synced to {where} and verified. AUTO_RELEASE_RUNTIME is off: release the runtime "
              "yourself when done (Runtime -> Disconnect and delete runtime).")
    elif unassign is None:
        print(f"Everything is synced to {where} and verified. Not on Colab: no runtime to release.")
    else:
        print(f"Everything is synced to {where}, verified (sha256) and Drive is flushed. Releasing the runtime now "
              "(runtime.unassign) so no more compute units are spent; this disconnects the notebook.")
        out["released"] = True
        unassign()
    return out


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
        env = {k: v for k, v in (os.environ if env is None else env).items() if k not in ("GH_TOKEN", "HF_TOKEN")}
        env["PYTHONUNBUFFERED"] = "1"   # secrets are not passed to the training process
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


# ---- status view -----------------------------------------------------------------------------------------------
class StatusView:
    """One status table, updated in place (IPython display with a display_id; Colab renders it as HTML). Off
    IPython: one plain line at most once a minute. Full logs stay in results/logs/."""

    def __init__(self, quiet=False):
        self.quiet, self.handle, self._last_print = quiet, None, 0.0
        if quiet:
            return
        try:
            get_ipython()  # noqa: F821
            from IPython.display import display, HTML
            self._HTML = HTML
            self.handle = display(HTML("<i>starting...</i>"), display_id=True)
        except Exception:
            self.handle = None

    def show(self, html_text, plain):
        if self.quiet:
            return
        if self.handle is not None:
            self.handle.update(self._HTML(html_text))
        elif time.time() - self._last_print > 60:
            self._last_print = time.time()
            print(plain, flush=True)


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
                 backoff_s=None, sleep=time.sleep, quiet=False, gpu=None, sync=None):
        self.root, self.ledger, self.progress = pathlib.Path(root), ledger, progress
        self.jobs_dir = pathlib.Path(jobs_dir or self.root / "jobs")
        self.max_attempts = max_attempts or MAX_ATTEMPTS
        self.stall_s = stall_s if stall_s is not None else STALL_MINUTES * 60
        self.poll_s = poll_s if poll_s is not None else POLL_S
        self.backoff_s = backoff_s if backoff_s is not None else BACKOFF_S
        self.sleep, self.quiet, self.gpu = sleep, quiet, gpu
        self.current = {}
        self._jobs_to_clear = []
        self.sync = sync
        self.plan = []
        self.view = None
        self._gpu_cache = (0.0, {})
        self._last_line = ""
        self.on_status = globals().get("ORCH_STATUS_HOOK")   # control panel (display only): on_status(orch, idle_min)
        self.on_line = globals().get("ORCH_LINE_HOOK")       # control panel (display only): on_line(run_id, line)

    # -- Drive sync and the status table
    def _sync(self, full=True):
        if self.sync is None:
            return
        r = self.sync.sync(full=full)
        if r["errors"]:
            self.progress.log("sync_error", errors=r["errors"][:5])
            print("Drive sync problem (will retry at the next sync):", r["errors"][0])

    def _gpu(self):
        t, g = self._gpu_cache
        if time.time() - t > 30:
            g = gpu_stats()
            self._gpu_cache = (time.time(), g)
        return g

    def status_rows(self):
        c = self.current
        trained = [((r["stages"].get("train") or {}).get("info") or {}).get("wall_seconds")
                   for r in self.ledger.data["runs"].values()]
        trained = [x for x in trained if x]
        mean_train = sum(trained) / len(trained) if trained else None
        rows, todo = [], 0
        for rid in self.plan:
            r = self.ledger.data["runs"].get(rid) or {}
            row = {"run": rid, "status": r.get("status", "pending"), "attempt": r.get("attempts", 0) or "",
                   "phase": "", "epoch": "", "progress": "", "eta_min": ""}
            if c.get("run_id") == rid:
                row.update(status="running", phase=c.get("phase") or "", attempt=c.get("attempt") or "",
                           epoch=f"{c.get('epoch') or '-'}/{c.get('epochs') or '-'}" if c.get("epochs") else "",
                           progress=f"{c.get('pct'):.0f}%" if c.get("pct") is not None else "",
                           eta_min=c.get("eta_min") if c.get("eta_min") is not None else "")
            elif row["status"] in ("pending", "running") and not rid.startswith("Z-"):
                todo += 1
            rows.append(row)
        eta_all = None
        if mean_train is not None:
            eta_all = round((c.get("eta_min") or 0) + todo * mean_train / 60)
        return rows, eta_all

    def render(self, idle_min=None):
        rows, eta_all = self.status_rows()
        g = self._gpu()
        s = self.sync
        sync_txt = ("off" if s is None or not s.enabled else
                    (f"last OK {time.strftime('%H:%M:%S', time.localtime(s.last_ok))}" if s.last_ok else "pending")
                    + (f", {s.errors_total} error(s): {s.last_error}" if s.errors_total else ""))
        p = self.progress.pusher
        gh = "off" if p is None else ("on" if p.enabled and not p.errors else f"{'on' if p.enabled else 'off'}, {p.errors} error(s)")
        head = {"GPU": f"{g.get('gpu_name', self.gpu or '-')} {g.get('gpu_util_pct', '-')}% util, "
                       f"{g.get('gpu_mem_used_mb', 0) / 1024:.1f}/{g.get('gpu_mem_total_mb', 0) / 1024:.1f} GB" if g else (self.gpu or "-"),
                "Drive sync": sync_txt, "GitHub": gh, "runs": self.ledger.counts(),
                "ETA all runs": f"~{eta_all} min (rough)" if eta_all is not None else "after the first run",
                "last log output": f"{idle_min:.1f} min ago" if idle_min is not None else "-"}
        cols = ["run", "status", "attempt", "phase", "epoch", "progress", "eta_min"]
        esc = lambda v: html.escape(str(v))
        colour = {"done": "#1e8e3e", "failed": "#d93025", "running": "#1a73e8"}
        t = ["<div style='font-family:monospace;font-size:13px'>",
             " | ".join(f"<b>{esc(k)}</b>: {esc(v)}" for k, v in head.items()),
             "<table style='border-collapse:collapse;margin-top:4px'><tr>"
             + "".join(f"<th style='text-align:left;padding:2px 10px'>{esc(c)}</th>" for c in cols) + "</tr>"]
        for r in rows:
            t.append("<tr>" + "".join(
                f"<td style='padding:2px 10px;color:{colour.get(r['status'], 'inherit') if c == 'status' else 'inherit'}'>"
                f"{esc(r[c])}</td>" for c in cols) + "</tr>")
        t.append("</table>")
        if self._last_line:
            t.append(f"<div style='color:#777'>last log line: {esc(self._last_line[-160:])}</div>")
        t.append("<div style='color:#777'>full logs: results/logs/ (local disk, synced to Drive)</div></div>")
        cur = next((r for r in rows if r["status"] == "running"), None)
        plain = (f"{time.strftime('%H:%M:%S')} runs {self.ledger.counts()} | "
                 + (f"{cur['run']} {cur['phase']} epoch {cur['epoch']} {cur['progress']} ETA {cur['eta_min']} min | " if cur else "")
                 + f"GPU {g.get('gpu_util_pct', '-')}% | Drive sync {sync_txt}")
        return "".join(t), plain

    def show(self, idle_min=None):
        if self.on_status is not None:
            try:
                self.on_status(self, idle_min)
            except Exception:
                pass
            return
        if self.quiet:
            return
        if self.view is None:
            self.view = StatusView(self.quiet)
        self.view.show(*self.render(idle_min))

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
                    if line.strip():
                        self._last_line = line.strip()
                    if self.on_line is not None:
                        try:
                            self.on_line(job.info["run_id"], line)
                        except Exception:
                            pass
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
            self.show(idle / 60)
            self.sleep(self.poll_s)

    def _clear_jobs(self):
        for j in self._jobs_to_clear:
            j.clear()
        self._jobs_to_clear = []

    # -- runs
    def run_all(self, specs, retry_failed=False):
        self.plan = [s.run_id for s in specs]
        self.show()
        for spec in specs:
            self.run_one(spec, retry_failed=retry_failed)
            self.show()
        return self.report([s.run_id for s in specs])

    def run_one(self, spec, retry_failed=False):
        try:
            return self._run_one(spec, retry_failed)
        finally:   # the run's files (and the ledger) are on Drive before the next run starts
            self._sync(full=True)

    def _run_one(self, spec, retry_failed=False):
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
                    self._sync(full=True)   # the stage's files (and checkpoint) are on Drive before the next stage
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


def nvidia_smi_summary():
    """GPU name, driver version, the CUDA version the driver supports, and memory, from nvidia-smi ({} if absent)."""
    if not shutil.which("nvidia-smi"):
        return {}
    try:
        q = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=20).stdout.splitlines()[0]
        name, drv, mem = [x.strip() for x in q.split(",")]
        head = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=20).stdout
        m = re.search(r"CUDA Version:\s*([0-9.]+)", head)
        return {"gpu_name": name, "driver_version": drv, "cuda_driver_version": m.group(1) if m else None,
                "gpu_mem_total_mb": float(mem)}
    except Exception:
        return {}


def heartbeat():
    """Called every ~2 minutes by the progress timer (see the live-progress cell); also syncs small files to Drive."""
    orch = globals().get("ORCH")
    if orch is not None:
        orch.heartbeat()
    elif globals().get("RUN_DIR") is not None:
        rec = {"t": _utc(), "stage": PROGRESS.stage, **gpu_stats()}
        write_json_atomic(pathlib.Path(RUN_DIR) / "heartbeat.json", rec)
        PROGRESS.log("heartbeat", **{k: v for k, v in rec.items() if k not in ("t", "stage")})
    sync = globals().get("SYNC")
    if sync is not None:
        r = sync.sync(full=False)
        if r["errors"]:
            PROGRESS.log("sync_error", errors=r["errors"][:5])'''

GPU = r'''# GPU and RAM. The runs are refused on CPU; a T4 gets a loud warning; High-RAM is recommended when RAM is small.
import subprocess, torch
SMI = nvidia_smi_summary()
print("nvidia-smi:", ", ".join(f"{k} {v}" for k, v in SMI.items()) if SMI else "not available")
try:
    import psutil
    RAM_GB = psutil.virtual_memory().total / 1e9
except Exception:
    RAM_GB = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
HIGH_RAM = RAM_GB >= 24   # standard Colab VMs have about 13 GB; High-RAM ones several times more
print(f"system RAM {RAM_GB:.1f} GB" + ("" if HIGH_RAM else
      " -- recommended: Runtime -> Change runtime type -> turn on High-RAM if it is offered, then Run all"))
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
               "inference_precision_expected": INFER_PRECISION_EXPECTED,
               "driver_version": SMI.get("driver_version"), "cuda_driver_version": SMI.get("cuda_driver_version"),
               "torch": getattr(torch, "__version__", None), "torch_cuda": getattr(getattr(torch, "version", None), "cuda", None),
               "ram_gb": round(RAM_GB, 1), "high_ram": HIGH_RAM}
try:
    GPU_PROFILE["cudnn"] = torch.backends.cudnn.version()
except Exception:
    GPU_PROFILE["cudnn"] = None
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

PIP = '''# Pinned versions, installed with %pip using a wheel/download cache on Drive (MyDrive/laya-release-triage/cache/pip),
# so a later session reuses the downloads. pip checks each download against the index's hash; afterwards every
# installed version is checked against its pin. torch stays Colab's own CUDA build (recorded in env.json).
PKGS = ["laya==0.4.1", "transformers==4.57.1", "huggingface_hub==0.36.2", "tokenizers==0.22.2",
        "safetensors==0.8.0", "scikit-learn==1.7.2"]
if EXPORT_ONNX:
    PKGS += ["onnx==1.22.0", "onnxruntime==1.29.0", "onnxscript==0.7.1"]
PINS = dict(p.split("==") for p in PKGS)
PIP_ARGS = " ".join(PKGS)
if not LOCAL_CHECK:
    PIP_CACHE.mkdir(parents=True, exist_ok=True)
    %pip install -q --cache-dir "{PIP_CACHE}" {PIP_ARGS}
import importlib.metadata as md
VERSIONS = {}
for p in ["laya", "torch", "transformers", "huggingface_hub", "tokenizers", "safetensors", "scikit-learn", "numpy",
          "pandas", *(["onnx", "onnxruntime", "onnxscript"] if EXPORT_ONNX else [])]:
    try:
        VERSIONS[p] = md.version(p)
    except md.PackageNotFoundError:
        VERSIONS[p] = None
print(VERSIONS)
PIN_MISMATCH = {p: {"pinned": v, "installed": VERSIONS.get(p)} for p, v in PINS.items() if VERSIONS.get(p) != v}
if PIN_MISMATCH and not LOCAL_CHECK:
    raise SystemExit(f"installed versions differ from the pins: {PIN_MISMATCH}. Runtime -> Restart session, then Run all.")
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
print("training precision:", TRAIN_PRECISION)'''

DRIVE = r'''# Storage. Work happens on the VM's fast local disk (RUN_DIR under /content/work); finished artifacts are copied to
# durable storage: Google Drive on Colab (MyDrive/laya-release-triage/<run tag>/), else OUTPUT_DIR or $LRT_OUT. Copies
# are atomic (temporary file + rename). On a new VM the ledger, results, logs and job files are restored first.
OUT_ROOT, DURABLE, DRIVE_MOUNTED = None, False, False
if os.environ.get("LRT_OUT"):
    OUT_ROOT, DURABLE = pathlib.Path(os.environ["LRT_OUT"]), True
elif USE_DRIVE and IN_COLAB and not LOCAL_CHECK:
    try:
        from google.colab import drive
        drive.mount(str(CONTENT / "drive"), force_remount=True)
        OUT_ROOT, DURABLE, DRIVE_MOUNTED = CONTENT / "drive" / "MyDrive" / "laya-release-triage", True, True
    except Exception as e:  # declined, or a Colab-connected runtime without Drive support
        print("Google Drive not mounted:", type(e).__name__, e)
if OUT_ROOT is None:
    OUT_ROOT = pathlib.Path(OUTPUT_DIR).expanduser() if OUTPUT_DIR else (WORK / "durable" if LOCAL_CHECK else pathlib.Path.home() / "laya-release-triage")
    DURABLE = not IN_COLAB   # on a custom VM the disk persists; on a Colab VM it does not
    if IN_COLAB and not LOCAL_CHECK:
        print("!" * 100 + "\nWARNING: saving to the Colab VM's own disk, which is deleted with the runtime. "
              "Mount Google Drive (USE_DRIVE on) so a disconnect loses nothing finished.\n" + "!" * 100)
OUT_ROOT.mkdir(parents=True, exist_ok=True)

# Caches on durable storage, reused by later sessions: Hugging Face (HF_HOME; the verified base-checkpoint snapshot
# is kept under HF_HOME/laya-snapshots/) and pip downloads. Set before huggingface_hub is first imported.
CACHE = OUT_ROOT / "cache"
HF_CACHE, PIP_CACHE = CACHE / "hf", CACHE / "pip"
if "huggingface_hub" in sys.modules:
    print("note: huggingface_hub was imported before this cell; HF_HOME takes effect after Runtime -> Restart session")
os.environ["HF_HOME"] = str(HF_CACHE)
os.environ.setdefault("HF_XET_CACHE", str(WORK / "xet-cache"))   # chunk cache: many small files, keep it local

# One run tag per output folder, kept across reconnects (run_tag.txt). Settings: RUN_TAG picks one explicitly;
# SMOKE uses its own smoke-<time> tag. To start a fresh run, rename or delete run_tag.txt (or set RUN_TAG).
_tag_file = OUT_ROOT / "run_tag.txt"
_now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
if str(RUN_TAG).strip():
    RUN_TAG = str(RUN_TAG).strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", RUN_TAG) or RUN_TAG in (".", ".."):
        raise SystemExit("RUN_TAG may only use letters, digits, '.', '_' and '-'")
elif SMOKE:
    RUN_TAG = "smoke-" + _now
elif _tag_file.exists():
    RUN_TAG = _tag_file.read_text().strip()
else:
    RUN_TAG = _now + "-" + uuid.uuid4().hex[:6]
    _tag_file.write_text(RUN_TAG + "\n")
REMOTE_RUN = OUT_ROOT / RUN_TAG       # durable copy: state.json, heartbeat.json, jobs/, checkpoints/, results/
RUN_DIR = WORK / "out" / RUN_TAG      # where everything is written first (fast local disk)
OUT = RUN_DIR
RESULTS = RUN_DIR / "results"
SYNC = DriveSync(RUN_DIR, REMOTE_RUN)
_restored = SYNC.restore()
(RESULTS / "logs").mkdir(parents=True, exist_ok=True)
print("local work ->", RUN_DIR)
print("durable copy ->", REMOTE_RUN, "" if DURABLE else "(NOT durable)",
      f"| restored {len(_restored)} files from it (ledger, results, logs)" if _restored else "")
PROGRESS.bind(RESULTS, RUN_TAG)
PROGRESS.after_stage = lambda: SYNC.sync(full=True)
PROGRESS.log("session_start", dataset_commit=DATA_REF, manifest_sha256=MANIFEST_SHA256, runtime="colab" if IN_COLAB else "other",
             out_dir=str(REMOTE_RUN), local_dir=str(RUN_DIR), durable=DURABLE, restored_files=len(_restored),
             **{k: v for k, v in GPU_PROFILE.items() if k != "gpu"})
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

CKPT = '''# Base checkpoints at the pinned revision (English = repo root, typed-decisions = subfolder). A verified copy is
# cached on Drive (HF_HOME/laya-snapshots/<repo>@<revision>/ with a sha256 manifest); a later session copies it to
# the local disk and re-verifies every file instead of downloading. The model files are also checked against the
# sha256 the Hub reports for the pinned revision whenever the Hub can be reached.
from huggingface_hub import snapshot_download
HUB = pathlib.Path(os.environ.get("LRT_HUB") or WORK / "hub")   # LRT_HUB: local copy, author's CPU check only
pats = [p + f for p in ("", "typed-decisions/") for f in
        ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")]
HUB_MANIFEST = ".lrt-manifest.json"
HUB_CACHE = (pathlib.Path(os.environ["HF_HOME"]) / "laya-snapshots" / (HF_REPO.replace("/", "--") + "@" + HF_REVISION)
             if os.environ.get("HF_HOME") else None)

def file_sha(p, n=1 << 22):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(n), b""):
            h.update(b)
    return h.hexdigest()

def tree_files(root):
    root = pathlib.Path(root)
    return sorted(str(q.relative_to(root)) for q in root.rglob("*")
                  if q.is_file() and not any(x.startswith(".") for x in q.relative_to(root).parts))

def tree_sha(root):
    return {rel: file_sha(pathlib.Path(root) / rel) for rel in tree_files(root)}

def hub_lfs_sha():
    """sha256 of the model files at the pinned revision, from the Hub's own metadata ({} if unreachable)."""
    try:
        from huggingface_hub import HfApi
        infos = HfApi().get_paths_info(HF_REPO, ["model.safetensors", "typed-decisions/model.safetensors"],
                                       revision=HF_REVISION, token=os.environ.get("HF_TOKEN") or None)
        out = {}
        for i in infos:
            lfs = getattr(i, "lfs", None)
            h = getattr(lfs, "sha256", None) or (lfs.get("sha256") if isinstance(lfs, dict) else None)
            if h:
                out[i.path] = h
        return out
    except Exception as e:
        print("could not read the Hub's sha256 for the pinned revision (", type(e).__name__, "); using the cache manifest")
        return {}

def snapshot_ok(root, man, lfs):
    if not man or man.get("repo") != HF_REPO or man.get("revision") != HF_REVISION:
        return False, "another repository or revision"
    got = tree_sha(root)
    if got != man.get("files"):
        return False, "files differ from the manifest (sha256)"
    bad = [k for k, h in lfs.items() if got.get(k) != h]
    return (not bad), (f"differs from the Hub's sha256: {bad}" if bad else "")

def read_manifest(path):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return None

HUB_SOURCE = None
if os.environ.get("LRT_HUB"):
    HUB_SOURCE = "local copy (LRT_HUB)"
else:
    LFS_SHA = hub_lfs_sha()
    if snapshot_ok(HUB, read_manifest(HUB / HUB_MANIFEST), LFS_SHA)[0]:
        HUB_SOURCE = "local disk (verified sha256)"
    elif HUB_CACHE is not None and (HUB_CACHE / HUB_MANIFEST).exists():
        shutil.rmtree(HUB, ignore_errors=True)
        try:
            for rel in tree_files(HUB_CACHE):
                atomic_copy(HUB_CACHE / rel, HUB / rel)
            man = read_manifest(HUB_CACHE / HUB_MANIFEST)
            ok, why = snapshot_ok(HUB, man, LFS_SHA)
        except OSError as e:
            ok, why = False, f"copy failed ({type(e).__name__})"
        if ok:
            write_json_atomic(HUB / HUB_MANIFEST, man)
            HUB_SOURCE = "Drive cache (verified sha256)"
        else:
            print("Drive cache of the checkpoints not used:", why)
            shutil.rmtree(HUB, ignore_errors=True)
    if HUB_SOURCE is None:
        snapshot_download(HF_REPO, revision=HF_REVISION, local_dir=str(HUB), allow_patterns=pats,
                          token=os.environ.get("HF_TOKEN") or None)
        files = tree_sha(HUB)
        bad = [k for k, h in LFS_SHA.items() if files.get(k) != h]
        if bad:
            raise SystemExit(f"downloaded checkpoints differ from the Hub's sha256 for {HF_REVISION}: {bad}")
        man = {"repo": HF_REPO, "revision": HF_REVISION, "files": files, "hub_lfs_sha256": LFS_SHA,
               "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        write_json_atomic(HUB / HUB_MANIFEST, man)
        HUB_SOURCE = "downloaded from the Hub"
        if HUB_CACHE is not None:   # files first, the manifest last: a cache without a manifest is never used
            try:
                for rel in files:
                    atomic_copy(HUB / rel, HUB_CACHE / rel)
                write_json_atomic(HUB_CACHE / HUB_MANIFEST, man)
                HUB_SOURCE += " (cached on Drive for later sessions)"
            except OSError as e:
                print("could not cache the checkpoints on Drive:", type(e).__name__, "(the run continues)")
print("base checkpoints:", HUB_SOURCE)
BASES = {"EN": str(HUB), "TD": str(HUB / "typed-decisions")}
CKPT_SHA = {k: file_sha(pathlib.Path(v) / "model.safetensors") if (pathlib.Path(v) / "model.safetensors").exists() else None
            for k, v in BASES.items()}
for k, v in BASES.items():
    cfg = json.loads((pathlib.Path(v) / "rl_agent_config.json").read_text())
    print(k, v, "max_len", cfg["max_len"], "head_max_len", cfg["head_max_len"], "sha256", (CKPT_SHA[k] or "-")[:16])
ENV = {"dataset_repo": REPO, "dataset_commit": DATA_REF, "manifest_sha256": MANIFEST_SHA256,
       "hf_repo": HF_REPO, "hf_revision": HF_REVISION, "checkpoint_sha256": CKPT_SHA, "versions": VERSIONS,
       "device": DEVICE, "gpu": GPU_NAME, "gpu_gb": round(GPU_GB, 1), "bf16": BF16, "micro_batch": MICRO,
       "grad_accum": ACCUM, "cpu_count": os.cpu_count(), "python": sys.version.split()[0], "smoke": SMOKE,
       "gpu_profile": GPU_PROFILE, "runtime": "colab" if IN_COLAB else "other", "durable_output": DURABLE,
       "base_checkpoints_source": HUB_SOURCE, "system": {"ram_gb": round(RAM_GB, 1), "high_ram": HIGH_RAM,
       "driver_version": SMI.get("driver_version"), "cuda_driver_version": SMI.get("cuda_driver_version"),
       "torch": VERSIONS.get("torch"), "torch_cuda": GPU_PROFILE.get("torch_cuda"), "cudnn": GPU_PROFILE.get("cudnn")}}
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
CKPTS = RUN_DIR / "checkpoints"  # each trained run's weights (local; synced to Drive after the stage; controls' copies
                                 # are deleted, also on Drive, once scored)
N_TRAIN = DRY["EN"]["train_items"]
BASE_MICRO, BASE_ACCUM = MICRO, ACCUM
FINGERPRINT = {"dataset_commit": DATA_REF, "manifest_sha256": MANIFEST_SHA256, "hf_revision": HF_REVISION,
               "laya": VERSIONS["laya"], "epochs": EPOCHS, "effective_batch": EFFECTIVE_BATCH, "seeds": SEEDS,
               "smoke": SMOKE}
LEDGER = Ledger(RUN_DIR / "state.json", RUN_DIR, FINGERPRINT)
ORCH = Orchestrator(RUN_DIR, LEDGER, PROGRESS, gpu=GPU_NAME, sync=SYNC)
# A run that was trained but not yet scored when the VM was lost needs its checkpoint back from Drive.
for _rid, _r in LEDGER.data["runs"].items():
    _ck = (_r["stages"].get("train") or {}).get("checkpoint")
    if _r["status"] != "done" and _ck and not (RUN_DIR / _ck["path"] / "model.safetensors").exists():
        _got = SYNC.restore_tree(_ck["path"])
        print(f"{_rid}: restored {len(_got)} checkpoint files from Drive")
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
    PROGRESS.log("train_command", run_id=run_id, cmd=" ".join(map(str, cmd)))   # in progress.jsonl, not printed
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
    shutil.rmtree(RUNS / run_id, ignore_errors=True)   # the copy in CKPTS (and on Drive) stays
    if not keep_durable:
        shutil.rmtree(CKPTS / run_id, ignore_errors=True)
        SYNC.delete(f"checkpoints/{run_id}")
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
print("run order:", [s.run_id for s in SPECS], "| live status below; full logs in results/logs/")
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
    print("Later cells use the runs that finished. Tick RETRY_FAILED in the Settings form and Run all to retry them.")'''

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
if SHIP is not None and not (SHIP / "model.safetensors").exists():   # new VM: bring the shipped weights back from Drive
    SYNC.restore_tree(f"checkpoints/{SHIP_ID}")
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

SAVE = '''# The shipped checkpoint (chosen on calib only) is already synced to durable storage: <run dir>/checkpoints/<run>.
if SHIP is not None:
    print("shipped checkpoint:", REMOTE_RUN / SHIP.relative_to(RUN_DIR), "| sha256", file_sha(SHIP / "model.safetensors")[:16])
    save_json("shipped_checkpoint.json", {"run": SHIP_ID, "path": str(REMOTE_RUN / SHIP.relative_to(RUN_DIR)),
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
print("\\nSend back:", REMOTE_RUN / "results.zip", "(or the folder", REMOTE_RUN / "results", ") once the Finish cell has synced it")'''

FINISH = r'''# Finish: stop the timer, final sync to Drive, sha256 verification (results.zip included), last GitHub push,
# drive.flush_and_unmount(), then, if AUTO_RELEASE_RUNTIME, runtime.unassign() so no more compute units are spent.
# Nothing is released if any step failed (the reasons are printed); then fix the cause and run this cell again.
PROGRESS.begin("finish")
_unmount = _unassign = None
if DRIVE_MOUNTED:
    from google.colab import drive
    _unmount = drive.flush_and_unmount
if IN_COLAB and not LOCAL_CHECK:
    try:
        from google.colab import runtime
        _unassign = runtime.unassign
    except ImportError:
        print("google.colab.runtime is not available here: the runtime is not released automatically")
if FAILED_RUNS:
    print(f"{len(FAILED_RUNS)} run(s) did not finish (see the summary); their state is saved. To retry them later: "
          "tick RETRY_FAILED in Settings and Run all on a new runtime.")
FINISH_RESULT = finish(SYNC, PROGRESS, AUTO_RELEASE_RUNTIME, unmount=_unmount, unassign=_unassign)'''


# =====================================================================================================================
# Control panel and runner. Presentation and execution plumbing only: everything below reads the stages' state and
# shows it; nothing here decides what is trained, scored, or how the verdict is reached.
# =====================================================================================================================
import collections
import contextlib
import datetime
import html
import io
import json
import linecache
import os
import pathlib
import re
import shlex
import subprocess
import sys
import threading
import time
import traceback

# The stepper: ten steps, each made of one or more stages (the former notebook cells), executed in this order.
STEPS = [("setup", "Setup"), ("gpu", "GPU"), ("storage", "Storage"), ("install", "Install"), ("data", "Data"),
         ("checks", "Checks"), ("models", "Models"), ("training", "Training runs"), ("verdict", "Verdict"),
         ("finish", "Finish")]
STEP_LABEL = dict(STEPS)
# Share of the overall progress bar per step (training dominates the wall time).
STEP_WEIGHT = {"setup": 2, "gpu": 1, "storage": 2, "install": 4, "data": 3, "checks": 1, "models": 7, "training": 75,
               "verdict": 4, "finish": 1}


class StageDef:
    """source: name of the stage source above; progress: the stage name written to progress.jsonl (None: the source
    logs its own, or none); what: the plain-language line shown while it runs."""

    def __init__(self, source, step, progress, what, magic=False):
        self.source, self.step, self.progress, self.what, self.magic = source, step, progress, what, magic


STAGES = [
    StageDef("CONFIG", "setup", None, "Reading the settings and detecting the runtime"),
    StageDef("PROGRESS_CELL", "setup", None, "Reading the optional secrets and setting up live progress"),
    StageDef("RUNNER_CELL", "setup", None, "Loading the resume, retry and Drive-sync plumbing"),
    StageDef("GPU", "gpu", "gpu", "Checking the GPU and the RAM"),
    StageDef("DRIVE", "storage", "drive", "Mounting Google Drive and restoring earlier work from it"),
    StageDef("PIP", "install", "install", "Installing the pinned packages (download cache on Drive)", magic=True),
    StageDef("DATA", "data", "data", "Downloading the dataset and checking every file's sha256"),
    StageDef("VALIDITY", "checks", "validity", "Running the validity checks (leakage, test families)"),
    StageDef("CKPT", "models", "checkpoints", "Getting the base checkpoints at the pinned revision (verified)"),
    StageDef("TOKENS", "models", "tokens", "Measuring the token budget and truncation"),
    StageDef("DRYRUN", "models", "dryrun", "Running laya-train --dry-run and working out the epoch budget"),
    StageDef("SCORE", "models", "score_defs", "Loading the scoring code"),
    StageDef("METRICS", "models", "metric_defs", "Loading the metric code"),
    StageDef("TRAIN", "training", "train", "Training and scoring the runs"),
    StageDef("VERDICT", "verdict", "verdict", "Applying the pre-registered pass rule"),
    StageDef("LATENCY", "verdict", "latency", "Measuring latency of the chosen checkpoint"),
    StageDef("SAVE", "verdict", "save_checkpoint", "Recording the chosen checkpoint"),
    StageDef("ONNX", "verdict", "onnx", "Exporting the chosen checkpoint to ONNX (optional)"),
    StageDef("SUMMARY", "verdict", "summary", "Writing the summary table and results.zip"),
    StageDef("FINISH", "finish", None, "Final sync to Drive, verification, then releasing the runtime"),
]

LEVEL_COLOUR = {"ok": "#1e8e3e", "warn": "#e37400", "error": "#d93025", "off": "#80868b", "active": "#1a73e8"}
LEVEL_WORD = {"ok": "OK", "warn": "attention", "error": "problem", "off": "off", "active": "working"}
STEP_ICON = {"done": "✓", "active": "▶", "pending": "○", "failed": "✗", "stopped": "■"}
STEP_LEVEL = {"done": "ok", "active": "active", "pending": "off", "failed": "error", "stopped": "warn"}
RUN_ICON = {"done": "✓", "running": "▶", "pending": "○", "failed": "✗", "retrying": "↻", "interrupted": "■"}
RUN_LEVEL = {"done": "ok", "running": "active", "pending": "off", "failed": "error", "retrying": "warn",
             "interrupted": "warn"}
NOTICE_PAT = re.compile(r"WARNING|UNDERPOWERED|NOT releasing|Drive sync problem|GitHub push disabled|"
                        r"recommended: Runtime|Google Drive not mounted|NOT durable", re.I)


def esc(v):
    return html.escape("" if v is None else str(v))


def fmt_minutes(m):
    """Minutes as '45 min' / '2 h 05 min' (None -> None)."""
    if m is None:
        return None
    m = max(0.0, float(m))
    if m < 1:
        return "<1 min"
    if m < 60:
        return f"{m:.0f} min"
    h, mm = divmod(int(round(m)), 60)
    return f"{h} h {mm:02d} min"


def hhmm(t):
    return time.strftime("%H:%M:%S", time.localtime(t)) if t else None


def describe_run(rid):
    """Plain-language name of a run id (PC-EN, F-TD-s0, Z-EN, ...)."""
    base = {"EN": "English", "TD": "typed-decisions"}
    m = re.fullmatch(r"(PC|F|Z)-(EN|TD)(?:-s(\d+))?(-retrain)?", rid or "")
    if not m:
        return rid or ""
    kind, b, seed, retrain = m.groups()
    if kind == "PC":
        return f"positive control, {base[b]}"
    if kind == "Z":
        return f"zero-shot reference, {base[b]}"
    return f"fine-tune, {base[b]}, seed {seed}" + (" (re-train of the chosen checkpoint)" if retrain else "")


def expected_plan(ns):
    """The run order the Training stage will use (from the Settings switches), shown before it starts. The Training
    stage's own plan replaces it as soon as it is known (the smoke test checks they agree)."""
    plan = []
    if ns.get("RUN_POSITIVE_CONTROL", True):
        plan += ["PC-EN", "PC-TD"]
    if ns.get("RUN_FINETUNE", True):
        for s in ns.get("SEEDS", [0, 1, 2]):
            plan += [f"F-TD-s{s}", f"F-EN-s{s}"]
    if ns.get("RUN_ZERO_SHOT", True):
        plan += ["Z-EN", "Z-TD"]
    return plan


def verdict_label(outcome):
    for lab in ("PASS", "FAIL", "INCONCLUSIVE", "NOT ADOPTED"):
        if str(outcome).startswith(lab):
            return lab
    return str(outcome).split(":")[0][:40]


def short_gh_note(note):
    """The reason live progress is off, in a few words (the setup log has the full instructions)."""
    n = (note or "").lower()
    if "push_progress" in n:
        return "PUSH_PROGRESS is off in Settings"
    if "exists but" in n or "no access" in n:
        return "GH_TOKEN secret has no notebook access"
    if "empty" in n:
        return "GH_TOKEN secret is empty"
    if "local check" in n:
        return "local check"
    if "could not read" in n:
        return "GH_TOKEN secret could not be read"
    return "no GH_TOKEN secret"


# ---- indicators (pure functions: (level, text)) ----------------------------------------------------------------
def drive_indicator(info, now):
    """info: None before the Storage step, else {enabled, mounted, durable, last_ok, last_error, last_error_t,
    errors_total, unmounted}."""
    if info is None:
        return "off", "not mounted yet"
    if info.get("unmounted"):
        return "ok", "synced, verified, flushed and unmounted"
    if not info.get("enabled"):
        return ("error", "NOT durable: saving to the VM's own disk only") if not info.get("durable") else \
               ("ok", "the output folder is the durable copy")
    ok_t, err_t = info.get("last_ok"), info.get("last_error_t")
    if err_t and (not ok_t or err_t >= ok_t):
        return "error", f"sync error at {hhmm(err_t)}: {str(info.get('last_error') or '')[:120]} (retried at the next sync)"
    if not ok_t:
        return "warn", "mounted, first sync pending"
    return "ok", f"last sync {hhmm(ok_t)}"


def github_indicator(info, now):
    """info: None before setup, else {configured, note, enabled, errors, last_error, last_push_ok}."""
    if info is None:
        return "off", "not set up yet"
    if not info.get("configured"):
        return "off", f"off ({info.get('note') or 'no GH_TOKEN'}); Drive only"
    if not info.get("enabled"):
        return "error", f"disabled: {info.get('last_error') or 'rejected'}; Drive only"
    if info.get("errors"):
        return "warn", f"{info['errors']} push error(s), last: {str(info.get('last_error') or '')[:100]}" + \
               (f"; last OK {hhmm(info['last_push_ok'])}" if info.get("last_push_ok") else "")
    if info.get("last_push_ok"):
        return "ok", f"last push {hhmm(info['last_push_ok'])}"
    return "warn", "on, first push pending"


def heartbeat_indicator(last_hb, every_s, now, running):
    """Green while heartbeats arrive on time, amber when one is late, red when they stopped."""
    if not running and last_hb is None:
        return "off", f"starts after the Storage step (every ~{every_s / 60:.0f} min)"
    if last_hb is None:
        return "warn", f"waiting for the first one (every ~{every_s / 60:.0f} min)"
    age = now - last_hb
    if age <= 2.5 * every_s:
        return "ok", f"last {hhmm(last_hb)}"
    if age <= 5 * every_s:
        return "warn", f"late: last {hhmm(last_hb)} ({age / 60:.0f} min ago)"
    return "error", f"stopped: last {hhmm(last_hb)} ({age / 60:.0f} min ago)"


# ---- state model -----------------------------------------------------------------------------------------------
class DashState:
    """Everything the panel shows, without ipywidgets. Thread-safe: events arrive from the main thread and from the
    heartbeat timer. snapshot() returns a plain dict that the renderers draw."""

    RUN_FIELDS = ("run_id", "attempt", "phase", "epoch", "epochs", "step", "steps_per_epoch", "pct", "eta_min")

    def __init__(self, clock=time.time, stages=STAGES):
        self.clock = clock
        self.t0 = clock()
        self.lock = threading.RLock()
        self.status = {k: "pending" for k, _ in STEPS}
        self.sub_total = {k: 0 for k, _ in STEPS}
        for s in stages:
            self.sub_total[s.step] += 1
        self.sub_done = {k: 0 for k, _ in STEPS}
        self.step_times = {}
        self.active = None
        self.now = "Starting"
        self.header = {}
        self.indicators = {"drive": None, "github": None}
        self.heartbeat_every = 120
        self.heartbeat_running = False
        self.last_heartbeat = None
        self.plan, self.plan_source = [], None
        self.runs = collections.OrderedDict()
        self.current = {}
        self.loss = None
        self.idle_min = None
        self.eta_all_min = None
        self.gpu_live = {}
        self.errors, self.notices = [], []
        self._err_keys, self._notice_keys = set(), set()
        self.log = collections.deque(maxlen=200)
        self.log_total = 0
        self.results = None
        self.closed_note = None
        self.version = 0

    def _touch(self):
        self.version += 1

    # -- steps
    def begin(self, stage):
        with self.lock:
            if self.status[stage.step] in ("pending", "stopped", "failed"):
                self.status[stage.step] = "active"
                self.step_times[stage.step] = [self.clock(), None]
            self.active = stage.step
            self.now = stage.what
            self._touch()

    def end(self, stage):
        with self.lock:
            self.sub_done[stage.step] = min(self.sub_total[stage.step], self.sub_done[stage.step] + 1)
            if self.sub_done[stage.step] >= self.sub_total[stage.step]:
                self.status[stage.step] = "done"
                self.step_times.setdefault(stage.step, [self.clock(), None])[1] = self.clock()
                if self.active == stage.step:
                    self.active = None
            self._touch()

    def fail(self, step, message, where):
        with self.lock:
            self.status[step] = "failed"
            self.add_error(f"step:{step}", f"{STEP_LABEL[step]} step failed", message, where)
            self.now = f"Stopped: the {STEP_LABEL[step]} step failed (see Errors below)."
            if self.current.get("run_id") and self.runs.get(self.current["run_id"], {}).get("status") == "running":
                self.runs[self.current["run_id"]]["status"] = "interrupted"
            self._touch()

    def stop(self, step):
        with self.lock:
            if step is not None and self.status.get(step) == "active":
                self.status[step] = "stopped"
            rid = self.current.get("run_id")
            if rid and self.runs.get(rid, {}).get("status") == "running":
                self.runs[rid]["status"] = "interrupted"
            self.now = ("Stopped by you. A training process that had already started keeps running in the "
                        "background; run this cell again to re-attach (finished work is kept).")
            self._touch()

    # -- runs
    def set_plan(self, plan, source):
        with self.lock:
            self.plan, self.plan_source = list(plan), source
            for rid in plan:
                self.runs.setdefault(rid, {"status": "pending", "attempt": 0, "epoch": None, "epochs": None,
                                           "metric": None})
            self._touch()

    def _run(self, rid):
        if rid not in self.runs:
            self.runs[rid] = {"status": "pending", "attempt": 0, "epoch": None, "epochs": None, "metric": None}
            if rid not in self.plan:
                self.plan.append(rid)
        return self.runs[rid]

    def load_ledger(self, data):
        """Redraw the run table from a ledger (state.json): after a reconnect, before the Training step starts."""
        with self.lock:
            for rid, r in (data or {}).get("runs", {}).items():
                row = self._run(rid)
                st = r.get("status", "pending")
                row["status"] = "interrupted" if st == "running" else st
                row["attempt"] = r.get("attempts", 0)
                if st == "failed" and r.get("last_error"):
                    self.add_error(f"run:{rid}", f"Run {rid} failed", r["last_error"], where_run(rid))
            self._touch()

    def on_orch(self, rows, current, eta_all, idle_min=None, gpu_live=None):
        with self.lock:
            for r in rows:
                row = self._run(r["run"])
                st = r["status"]
                if st == "running" and current.get("run_id") == r["run"] and (current.get("attempt") or 1) > 1:
                    st = "retrying" if not current.get("epoch") else "running"
                row["status"] = st
                row["attempt"] = r.get("attempt") or row.get("attempt") or 0
            self.current = {k: current.get(k) for k in self.RUN_FIELDS if k in current}
            rid = self.current.get("run_id")
            if rid:
                row = self._run(rid)
                row["epoch"], row["epochs"] = self.current.get("epoch"), self.current.get("epochs")
                self.now = now_line_for(self.current, self.loss)
            self.eta_all_min = eta_all
            self.idle_min = idle_min
            if gpu_live is not None:
                self.gpu_live = dict(gpu_live)
            self._touch()

    def set_metric(self, rid, text):
        with self.lock:
            if self._run(rid).get("metric") != text:
                self._run(rid)["metric"] = text
                self._touch()

    # -- events from progress.jsonl (Progress.log)
    def on_event(self, rec):
        ev, rid = rec.get("event"), rec.get("run_id")
        with self.lock:
            if ev == "heartbeat":
                self.last_heartbeat = self.clock()
            elif ev == "run_start" and rid:
                row = self._run(rid)
                row.update(status="running" if (rec.get("attempt") or 1) == 1 else "retrying",
                           attempt=rec.get("attempt"))
                self.current = {"run_id": rid, "attempt": rec.get("attempt"), "phase": None}
                self.loss = None
                self.now = f"Starting {rid} ({describe_run(rid)}), attempt {rec.get('attempt')}"
            elif ev == "job_adopted" and rid:
                self.add_notice(f"adopt:{rid}:{rec.get('pid')}", f"{rid}: re-attached to its training process "
                                f"(pid {rec.get('pid')}) that kept running while the notebook was away.")
            elif ev == "run_interrupted" and rid:
                self.add_notice(f"intr:{rid}:{rec.get('interruptions')}", f"{rid}: its training process was gone "
                                "(disconnect or restart); the run restarts from its base checkpoint (no attempt used).")
            elif ev in ("train_step", "epoch_end") and rid:
                if self.current.get("run_id") in (None, rid):
                    self.loss = rec.get("loss")
                    self.current.update(run_id=rid, epoch=rec.get("epoch"), epochs=rec.get("epochs"))
                    if rec.get("step"):
                        self.current["step"] = rec.get("step")
            elif ev == "run_scored" and rid:
                pass   # the metric is read from metrics_<run>.json by the panel
            elif ev in ("run_done", "run_skipped_done") and rid:
                row = self._run(rid)
                row["status"] = "done"
                if ev == "run_skipped_done":
                    row["note"] = "done earlier (verified)"
                if self.current.get("run_id") == rid:
                    self.current = {}
                self._err_keys.discard(f"run:{rid}")
                self.errors = [e for e in self.errors if e["key"] != f"run:{rid}"]
            elif ev == "run_error" and rid:
                self.add_notice(f"err:{rid}:{rec.get('attempt')}", f"{rid}: attempt {rec.get('attempt')} failed "
                                f"({rec.get('kind')}): {str(rec.get('error') or '')[:200]}")
            elif ev == "oom_retry" and rid:
                ch = rec.get("change") or {}
                mb, ga = ch.get("micro_batch"), ch.get("grad_accum")
                txt = (f"{rid}: out of GPU memory, retrying with micro-batch {mb[1]} x accumulation {ga[1]} (same "
                       "effective batch and update count)") if mb and ga else f"{rid}: out of GPU memory, retrying smaller"
                self.add_notice(f"oom:{rid}:{json.dumps(ch, sort_keys=True, default=str)}", txt)
                self.now = txt
            elif ev == "backoff" and rid:
                self.now = f"{rid}: network error, waiting {rec.get('seconds')} s before retrying"
            elif ev in ("run_failed", "run_skipped_failed") and rid:
                row = self._run(rid)
                row["status"] = "failed"
                if self.current.get("run_id") == rid:
                    self.current = {}
                note = "" if ev == "run_failed" else " (earlier; tick RETRY_FAILED in Settings to retry)"
                self.add_error(f"run:{rid}", f"Run {rid} failed{note}", rec.get("last_error") or "", where_run(rid))
            elif ev == "sync_error":
                errs = rec.get("errors") or []
                self.add_notice("sync_error", f"Drive sync problem (retried at the next sync): {errs[0] if errs else ''}"[:240])
            elif ev == "finish_start":
                self.now = ("Final sync to Drive and sha256 verification" + (", then releasing the runtime (the notebook "
                            "will disconnect; that is expected)" if rec.get("auto_release") else ""))
            else:
                return
            self._touch()

    def add_error(self, key, what, message, where):
        with self.lock:
            msg = " ".join(str(message).split())[:400]
            if key in self._err_keys:
                for e in self.errors:
                    if e["key"] == key:
                        e.update(what=what, message=msg, where=where)
            else:
                self._err_keys.add(key)
                self.errors.append({"key": key, "what": what, "message": msg, "where": where})
            self._touch()

    def add_notice(self, key, text):
        with self.lock:
            if key in self._notice_keys:
                return
            self._notice_keys.add(key)
            self.notices = (self.notices + [{"key": key, "text": " ".join(str(text).split())[:300]}])[-12:]
            self._touch()

    def add_log(self, line):
        with self.lock:
            self.log.append(line)
            self.log_total += 1
            if NOTICE_PAT.search(line):
                self.add_notice("log:" + line.strip()[:120], line.strip())
            self._touch()

    def set_results(self, results):
        with self.lock:
            self.results = dict(results)
            self._touch()

    # -- progress and ETA
    def run_fraction(self, rid):
        r = self.runs.get(rid) or {}
        if r.get("status") in ("done", "failed"):
            return 1.0
        if self.current.get("run_id") != rid:
            return 0.0
        phase = self.current.get("phase") or ""
        if rid.startswith("Z-"):
            return 0.5
        if phase.startswith("train") and phase != "train (setup)":
            return 0.85 * min(1.0, (self.current.get("pct") or 0) / 100)
        if phase in ("score", "harness", "calibration and report"):
            return 0.9
        return 0.0

    @staticmethod
    def run_weight(rid):
        return 0.1 if rid.startswith("Z-") else 1.0

    def training_fraction(self):
        plan = self.plan or list(self.runs)
        tot = sum(self.run_weight(r) for r in plan)
        return sum(self.run_weight(r) * self.run_fraction(r) for r in plan) / tot if tot else 0.0

    def step_fraction(self, step):
        st = self.status[step]
        if st == "done":
            return 1.0
        if st == "pending":
            return 0.0
        if step == "training":
            return self.training_fraction()
        n = self.sub_total[step] or 1
        return self.sub_done[step] / n

    def overall_fraction(self):
        tot = sum(STEP_WEIGHT.values())
        return sum(STEP_WEIGHT[k] * self.step_fraction(k) for k, _ in STEPS) / tot

    def overall_eta_min(self):
        """Rough minutes left for all runs: measured from finished runs (mean training wall time), else from the
        current run's own speed. None before training has a measurement, and after training."""
        if self.status["training"] in ("pending", "done"):
            return None
        if self.eta_all_min is not None:
            return float(self.eta_all_min)
        c = self.current
        if c.get("eta_min") is not None and c.get("pct"):
            per_run = float(c["eta_min"]) / max(0.01, 1 - float(c["pct"]) / 100)
            todo = sum(1 for r in (self.plan or self.runs) if not r.startswith("Z-") and r != c.get("run_id")
                       and (self.runs.get(r) or {}).get("status") in ("pending", "interrupted", None))
            return float(c["eta_min"]) + todo * per_run
        return None

    def snapshot(self):
        with self.lock:
            now = self.clock()
            counts = collections.Counter(r["status"] for r in self.runs.values())
            hb = heartbeat_indicator(self.last_heartbeat, self.heartbeat_every, now, self.heartbeat_running)
            return {
                "t": now, "elapsed_s": now - self.t0, "header": dict(self.header),
                "drive": drive_indicator(self.indicators["drive"], now),
                "github": github_indicator(self.indicators["github"], now), "heartbeat": hb,
                "overall_pct": round(100 * self.overall_fraction(), 1), "eta_min": self.overall_eta_min(),
                "training_status": self.status["training"],
                "steps": [{"key": k, "label": lab, "status": self.status[k]} for k, lab in STEPS],
                "active": self.active, "now": self.now,
                "current": dict(self.current), "loss": self.loss, "idle_min": self.idle_min,
                "runs": [{"run": rid, "what": describe_run(rid), **{k: v for k, v in r.items()}}
                         for rid, r in self.runs.items()],
                "counts": dict(counts), "errors": [dict(e) for e in self.errors],
                "notices": [dict(n) for n in self.notices], "log": list(self.log), "log_total": self.log_total,
                "results": dict(self.results) if self.results else None, "closed_note": self.closed_note,
                "gpu_live": dict(self.gpu_live), "version": self.version}


def where_run(rid):
    return (f"traceback: state.json (runs → {rid} → errors) and results/progress.jsonl (event run_error); "
            f"training log: results/logs/train_{rid}.log")


def now_line_for(c, loss=None):
    rid = c.get("run_id")
    if not rid:
        return "Between runs"
    phase = c.get("phase") or ""
    what = describe_run(rid)
    att = f", attempt {c['attempt']}" if (c.get("attempt") or 1) > 1 else ""
    if phase == "train (setup)":
        return f"Starting the training process for {rid} ({what}{att}): loading data and the base checkpoint"
    if phase == "train":
        s = f"Training {rid} ({what}{att}): epoch {c.get('epoch') or '?'} of {c.get('epochs') or '?'}"
        if c.get("step") and c.get("steps_per_epoch"):
            s += f", step {c['step']} of {c['steps_per_epoch']}"
        return s + (f", loss {loss:.4f}" if isinstance(loss, (int, float)) else "")
    if phase == "calibration and report":
        return f"{rid}: training done, laya is calibrating and writing its report"
    if phase == "score":
        return f"Scoring {rid} ({what}) on calib and test, both option orders"
    if phase == "harness":
        return f"Running Laya's own evaluation harness for {rid}"
    return f"{rid} ({what}{att})"


# ---- HTML fragments (shared by the widgets and the static preview) ------------------------------------------------
def dot(level):
    return (f"<span aria-hidden='true' style='display:inline-block;width:10px;height:10px;border-radius:50%;"
            f"background:{LEVEL_COLOUR[level]};margin-right:5px;vertical-align:middle'></span>")


def badge(level, text):
    c = LEVEL_COLOUR[level]
    return (f"<span style='display:inline-block;border:1px solid {c};color:{c};border-radius:10px;padding:0 7px;"
            f"font-size:12px;font-weight:600;white-space:nowrap'>{esc(text)}</span>")


def html_header(s):
    h = s["header"]
    tag = h.get("run_tag") or "(set at the Storage step)"
    gpu = h.get("gpu") or "(checked at the GPU step)"
    g = s.get("gpu_live") or {}
    if g.get("gpu_util_pct") is not None:
        gpu += f" · {g['gpu_util_pct']:.0f}% busy · {g.get('gpu_mem_used_mb', 0) / 1024:.1f}/{g.get('gpu_mem_total_mb', 0) / 1024:.1f} GB used"
    prec = h.get("precision") or "(recorded at the Install step)"
    smoke = (" " + badge("warn", "SMOKE: quick check, not the experiment")) if h.get("smoke") else ""
    ind = []
    for key, name in (("drive", h.get("storage_name") or "Drive"), ("github", "GitHub"), ("heartbeat", "Heartbeat")):
        level, text = s[key]
        ind.append(f"<span style='margin-right:18px;white-space:nowrap'>{dot(level)}<b>{esc(name)}</b>: "
                   f"{esc(LEVEL_WORD[level])}, {esc(text)}</span>")
    return ("<div style='font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;line-height:1.5'>"
            "<div style='font-size:16px;font-weight:600'>Laya release triage: control panel" + smoke + "</div>"
            f"<div><b>Run tag</b>: <code>{esc(tag)}</code> &nbsp;·&nbsp; <b>GPU</b>: {esc(gpu)} &nbsp;·&nbsp; "
            f"<b>Precision</b>: {esc(prec)}</div>"
            f"<div style='margin-top:2px'>{''.join(ind)}</div></div>")


def overall_text(s):
    eta = fmt_minutes(s["eta_min"])
    if s["training_status"] == "pending":
        eta_txt = "ETA: measured once training starts (rough budget 3-6 h on an A100)"
    elif s["training_status"] == "done":
        eta_txt = "training finished"
    else:
        eta_txt = f"ETA ~{eta} (rough, from the measured training speed)" if eta else "ETA: measuring"
    return f"{s['overall_pct']:.0f}% · {eta_txt} · elapsed {fmt_minutes(s['elapsed_s'] / 60)}"


def html_overall_label(s):
    return f"<span style='font-size:13px'>{esc(overall_text(s))}</span>"


def html_stepper(s):
    chips = []
    for i, st in enumerate(s["steps"], 1):
        level = STEP_LEVEL[st["status"]]
        c = LEVEL_COLOUR[level]
        bold = "font-weight:700;" if st["status"] == "active" else ""
        chips.append(f"<span style='display:inline-block;border:1px solid {c};border-radius:12px;padding:1px 8px;"
                     f"margin:2px 3px 2px 0;color:{c};{bold}white-space:nowrap' "
                     f"title='{esc(st['label'])}: {esc(st['status'])}'>{STEP_ICON[st['status']]} {i}. {esc(st['label'])}"
                     f" <span style='font-size:11px'>({esc(st['status'])})</span></span>")
    return "<div style='font-size:12.5px;line-height:1.9'>" + "".join(chips) + "</div>"


def html_now(s):
    note = f"<div style='color:{LEVEL_COLOUR['warn']}'>{esc(s['closed_note'])}</div>" if s.get("closed_note") else ""
    return (f"<div style='font-size:14px;margin:4px 0'><b>What's happening now:</b> {esc(s['now'])}</div>" + note)


def current_text(s):
    c = s["current"]
    if not c.get("run_id"):
        if s["training_status"] == "pending":
            return "Current run: none yet (training starts at step 8)"
        if s["training_status"] == "done":
            return "Current run: none (all runs processed)"
        return "Current run: none"
    parts = [f"Current run: {c['run_id']}"]
    if c.get("epochs"):
        parts.append(f"epoch {c.get('epoch') or 0}/{c['epochs']}")
    if c.get("step") and c.get("steps_per_epoch"):
        parts.append(f"step {c['step']}/{c['steps_per_epoch']}")
    if isinstance(s.get("loss"), (int, float)):
        parts.append(f"loss {s['loss']:.4f}")
    if c.get("eta_min") is not None:
        parts.append(f"ETA ~{fmt_minutes(c['eta_min'])}")
    if c.get("phase") and c.get("phase") != "train":
        parts.append(f"phase: {c['phase']}")
    if s.get("idle_min") is not None and s["idle_min"] >= 2:
        parts.append(f"no new log output for {s['idle_min']:.0f} min")
    return " · ".join(parts)


def current_pct(s):
    c = s["current"]
    if not c.get("run_id"):
        return 100.0 if s["training_status"] == "done" else 0.0
    if (c.get("phase") or "") in ("score", "harness", "calibration and report"):
        return 100.0
    return float(c.get("pct") or 0.0)


def html_current_info(s):
    return f"<span style='font-size:13px'>{esc(current_text(s))}</span>"


def html_runs(s):
    head = ("<tr>" + "".join(f"<th style='text-align:left;padding:2px 10px 2px 0;border-bottom:1px solid #8886'>{h}</th>"
                             for h in ("Run", "What", "Status", "Attempt", "Epoch", "Result")) + "</tr>")
    rows = []
    for r in s["runs"]:
        st = r.get("status") or "pending"
        level = RUN_LEVEL.get(st, "off")
        status = f"<span style='color:{LEVEL_COLOUR[level]};font-weight:600'>{RUN_ICON.get(st, '·')} {esc(st)}</span>"
        if r.get("note"):
            status += f" <span style='font-size:11px'>({esc(r['note'])})</span>"
        ep = f"{r['epoch'] or 0}/{r['epochs']}" if r.get("epochs") else ""
        rows.append("<tr>" + "".join(f"<td style='padding:1px 10px 1px 0'>{v}</td>" for v in (
            f"<code>{esc(r['run'])}</code>", esc(r.get("what")), status, esc(r.get("attempt") or ""), esc(ep),
            esc(r.get("metric") or ""))) + "</tr>")
    c = s["counts"]
    summary = ", ".join(f"{c.get(k, 0)} {k}" for k in ("done", "running", "failed", "pending") if c.get(k) or k == "done")
    return (f"<div style='font-size:12.5px'><b>Runs</b> ({esc(summary)}; most decision-relevant first)"
            f"<table style='border-collapse:collapse;margin-top:2px'>{head}{''.join(rows)}</table></div>")


def html_errors(s):
    if not s["errors"] and not s["notices"]:
        return ""
    out = ["<div style='font-size:12.5px;margin-top:4px'>"]
    if s["errors"]:
        out.append(f"<div style='border-left:4px solid {LEVEL_COLOUR['error']};padding:2px 8px;margin:3px 0'>"
                   f"<b style='color:{LEVEL_COLOUR['error']}'>✗ Errors ({len(s['errors'])})</b>")
        for e in s["errors"]:
            out.append(f"<div style='margin:2px 0'><b>{esc(e['what'])}</b>: {esc(e['message'])}"
                       f"<br><span style='font-size:11.5px'>Where: {esc(e['where'])}</span></div>")
        out.append("</div>")
    if s["notices"]:
        out.append(f"<div style='border-left:4px solid {LEVEL_COLOUR['warn']};padding:2px 8px;margin:3px 0'>"
                   f"<b style='color:{LEVEL_COLOUR['warn']}'>! Notices ({len(s['notices'])})</b>")
        for n in s["notices"]:
            out.append(f"<div style='margin:1px 0'>{esc(n['text'])}</div>")
        out.append("</div>")
    out.append("</div>")
    return "".join(out)


def html_results(s):
    r = s.get("results")
    if not r:
        return ""
    lab = verdict_label(r.get("outcome", ""))
    level = {"PASS": "ok", "FAIL": "error"}.get(lab, "warn")
    c = LEVEL_COLOUR[level]
    out = [f"<div style='font-size:13px;border:1px solid {c};border-radius:6px;padding:6px 10px;margin-top:6px'>",
           f"<div style='font-size:15px'><b>Verdict</b> (pre-registered rule): {badge(level, lab)} {esc(r.get('outcome'))}</div>"]
    det = [f"{k}: {esc(v)}" for k, v in (("best baseline", r.get("best_baseline")), ("chosen base", r.get("chosen_base")),
                                          ("shipped seed", r.get("shipped_seed")),
                                          ("seeds passing P1-P6", r.get("seeds_passing"))) if v is not None]
    if det:
        out.append("<div>" + " · ".join(det) + "</div>")
    if r.get("table_html"):
        out.append("<div style='margin-top:4px'><b>Summary</b> (test split, same budget and code; full table in "
                   "results/summary.md)</div><div style='overflow-x:auto;font-size:11.5px'>" + r["table_html"] + "</div>")
    paths = r.get("paths") or []
    if paths:
        out.append("<div style='margin-top:4px'><b>Results</b>:<ul style='margin:2px 0 2px 18px;padding:0'>"
                   + "".join(f"<li>{esc(lbl)}: {('<a href=' + chr(39) + esc(p) + chr(39) + ' target=_blank>' + esc(p) + '</a>') if str(p).startswith('https://') else '<code>' + esc(p) + '</code>'}</li>"
                             for lbl, p in paths) + "</ul></div>")
    if r.get("finish"):
        fl, ft = r["finish"]
        out.append(f"<div>{dot(fl)}<b>Finish</b>: {esc(LEVEL_WORD[fl])}, {esc(ft)}</div>")
    out.append("</div>")
    return "".join(out)


def log_title(s):
    return f"Log (last {len(s['log'])} of {s['log_total']} lines; full logs in results/logs/)"


def text_status(s):
    """The compact one-to-three-line status used without ipywidgets."""
    act = next((st for st in s["steps"] if st["status"] in ("active", "failed", "stopped")), None)
    idx = [st["key"] for st in s["steps"]].index(act["key"]) + 1 if act else None
    step = f"step {idx}/10 {act['label']} ({act['status']})" if act else (
        "all steps done" if all(st["status"] == "done" for st in s["steps"]) else "starting")
    c = s["counts"]
    ind = " | ".join(f"{n} {LEVEL_WORD[s[k][0]]}: {s[k][1]}" for k, n in (("drive", "Drive"), ("github", "GitHub"),
                                                                           ("heartbeat", "heartbeat")))
    lines = [f"[{time.strftime('%H:%M:%S', time.localtime(s['t']))}] {overall_text(s)} | {step} | runs "
             f"{c.get('done', 0)} done, {c.get('failed', 0)} failed, {len(s['runs']) - c.get('done', 0) - c.get('failed', 0)} to go",
             f"  now: {s['now']}" + (f" | {current_text(s)}" if s["current"].get("run_id") else ""),
             f"  {ind}"]
    for e in s["errors"]:
        lines.append(f"  ERROR {e['what']}: {e['message']} ({e['where']})")
    if s.get("results"):
        lines.append(f"  VERDICT: {s['results'].get('outcome')}")
    return "\n".join(lines)


def to_html(s, banner=None, log_lines=None, title="Control panel preview", open_log=False):
    """A static HTML page with the same structure as the widget panel (for previews and reports)."""
    def bar(pct, level):
        return (f"<div role='progressbar' aria-valuemin='0' aria-valuemax='100' aria-valuenow='{pct:.0f}' "
                f"style='flex:1;height:14px;background:#8883;border-radius:3px;overflow:hidden'>"
                f"<div style='width:{max(0, min(100, pct)):.1f}%;height:100%;background:{LEVEL_COLOUR[level]}'></div></div>")
    lvl = "error" if any(st["status"] == "failed" for st in s["steps"]) else (
        "ok" if s["overall_pct"] >= 100 else "active")
    lines = s["log"][-log_lines:] if log_lines else s["log"]
    log = esc("\n".join(lines))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{esc(title)}</title>
<style>
:root {{ --bg:#ffffff; --fg:#202124; --muted:#5f6368; --card:#f8f9fa; --line:#dadce0; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#1f1f1f; --fg:#e8eaed; --muted:#9aa0a6; --card:#2a2a2a; --line:#3c4043; }} }}
:root[data-theme="dark"] {{ --bg:#1f1f1f; --fg:#e8eaed; --muted:#9aa0a6; --card:#2a2a2a; --line:#3c4043; }}
body {{ background:var(--bg); color:var(--fg); margin:0; padding:16px; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }}
.panel {{ max-width:1100px; margin:0 auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; }}
.row {{ display:flex; align-items:center; gap:10px; margin:4px 0; flex-wrap:wrap; }}
.row > b {{ min-width:90px; font-size:13px; }}
.banner {{ max-width:1100px; margin:0 auto 10px; font-size:13px; color:var(--muted); }}
details summary {{ cursor:pointer; font-size:13px; padding:4px 0; }}
pre {{ font-size:11.5px; max-height:260px; overflow:auto; background:var(--bg); border:1px solid var(--line); padding:6px; white-space:pre-wrap; }}
table.dataframe {{ border-collapse:collapse; }} table.dataframe td, table.dataframe th {{ padding:1px 6px; border:1px solid var(--line); }}
code {{ font-size:12px; }}
</style></head><body>
{f'<div class="banner">{esc(banner)}</div>' if banner else ''}
<div class="panel">
{html_header(s)}
<div class="row"><b>Overall</b>{bar(s['overall_pct'], lvl)}{html_overall_label(s)}</div>
{html_stepper(s)}
{html_now(s)}
<div class="row"><b>Current run</b>{bar(current_pct(s), 'active')}{html_current_info(s)}</div>
{html_runs(s)}
{html_errors(s)}
{html_results(s)}
<details{' open' if open_log else ''}><summary>{esc(log_title(s))}</summary><pre>{log}</pre></details>
</div></body></html>"""


# ---- renderers -------------------------------------------------------------------------------------------------
class WidgetView:
    """The panel as core ipywidgets (VBox of HTML, FloatProgress, Accordion + Output), updated in place."""

    def __init__(self, widgets, display):
        W = widgets
        self.W = W
        full = W.Layout(width="100%")
        self.header = W.HTML(layout=full)
        self.overall_bar = W.FloatProgress(value=0, min=0, max=100, bar_style="info", layout=W.Layout(width="45%"))
        self.overall_txt = W.HTML()
        self.stepper = W.HTML(layout=full)
        self.now = W.HTML(layout=full)
        self.cur_bar = W.FloatProgress(value=0, min=0, max=100, bar_style="info", layout=W.Layout(width="45%"))
        self.cur_txt = W.HTML()
        self.runs = W.HTML(layout=full)
        self.errors = W.HTML(layout=W.Layout(width="100%", display="none"))
        self.results = W.HTML(layout=W.Layout(width="100%", display="none"))
        self.log_out = W.Output(layout=W.Layout(max_height="320px", overflow="auto"))
        self.log_acc = W.Accordion(children=[self.log_out])
        self.log_acc.set_title(0, "Log")
        self.log_acc.selected_index = None
        lbl = lambda t: W.HTML(f"<b style='font-size:13px'>{t}</b>", layout=W.Layout(width="95px"))
        self.root = W.VBox([self.header, W.HBox([lbl("Overall"), self.overall_bar, self.overall_txt]), self.stepper,
                            self.now, W.HBox([lbl("Current run"), self.cur_bar, self.cur_txt]), self.runs, self.errors,
                            self.results, self.log_acc],
                           layout=W.Layout(border="1px solid #8885", padding="6px 10px", width="100%"))
        self._log_seen = None
        self.updates = 0
        display(self.root)

    @staticmethod
    def _set(w, attr, v):
        if getattr(w, attr) != v:
            setattr(w, attr, v)
            return 1
        return 0

    def update(self, s, force=False):
        n = 0
        failed = any(st["status"] == "failed" for st in s["steps"])
        stopped = any(st["status"] == "stopped" for st in s["steps"])
        n += self._set(self.header, "value", html_header(s))
        n += self._set(self.overall_bar, "value", float(s["overall_pct"]))
        n += self._set(self.overall_bar, "bar_style", "danger" if failed else "warning" if stopped else
                       "success" if s["overall_pct"] >= 100 else "info")
        n += self._set(self.overall_txt, "value", html_overall_label(s))
        n += self._set(self.stepper, "value", html_stepper(s))
        n += self._set(self.now, "value", html_now(s))
        n += self._set(self.cur_bar, "value", current_pct(s))
        n += self._set(self.cur_txt, "value", html_current_info(s))
        n += self._set(self.runs, "value", html_runs(s))
        e = html_errors(s)
        n += self._set(self.errors, "value", e)
        n += self._set(self.errors.layout, "display", None if e else "none")
        r = html_results(s)
        n += self._set(self.results, "value", r)
        n += self._set(self.results.layout, "display", None if r else "none")
        key = (s["log_total"], len(s["log"]))
        if key != self._log_seen:
            self._log_seen = key
            self.log_out.outputs = ({"output_type": "stream", "name": "stdout", "text": "\n".join(s["log"]) + "\n"},)
            self.log_acc.set_title(0, log_title(s))
            n += 1
        self.updates += n
        return n


class TextView:
    """Fallback without ipywidgets: a compact status, printed at most once a minute, and at once when a step or a
    run changes state, or an error appears."""

    def __init__(self, stream=None, every_s=60, clock=time.time):
        self.stream = stream or sys.__stdout__
        self.every_s, self.clock = every_s, clock
        self._last, self._key = 0.0, None
        self.printed = 0

    def update(self, s, force=False):
        key = (tuple(st["status"] for st in s["steps"]), tuple((r["run"], r.get("status")) for r in s["runs"]),
               len(s["errors"]), bool(s.get("results")))
        if force or key != self._key or self.clock() - self._last >= self.every_s:
            self._key, self._last = key, self.clock()
            print(text_status(s), file=self.stream, flush=True)
            self.printed += 1
            return 1
        return 0


def make_view(mode="auto", stream=None):
    """'widgets' | 'text' | 'auto' (widgets when ipywidgets and an IPython display are available)."""
    if mode != "text":
        try:
            import ipywidgets
            from IPython import get_ipython
            from IPython.display import display
            if get_ipython() is None:
                raise ImportError("not under IPython")
            return WidgetView(ipywidgets, display)
        except Exception as e:   # ImportError, or no widget support in this front end
            if mode == "widgets":
                raise
            print(f"(control panel: ipywidgets not available ({type(e).__name__}); compact text status instead)",
                  file=stream or sys.__stdout__)
    return TextView(stream)


# ---- console capture -------------------------------------------------------------------------------------------
class Console:
    """Captures what the stages print: last ~200 lines in the panel's log, every line in results/logs/console.log
    (once the Storage step knows where that is; earlier lines are kept and written then)."""

    def __init__(self, on_line):
        self.on_line = on_line
        self._buf, self._lock = "", threading.RLock()
        self._pending, self._f, self.path = [], None, None

    # file-like
    encoding = "utf-8"
    errors = "replace"

    def isatty(self):
        return False

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            s = s.decode("utf-8", "replace") if isinstance(s, bytes) else str(s)
        with self._lock:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                self._emit(line.rsplit("\r", 1)[-1])   # progress bars: keep the last state of the line
            if "\r" in self._buf:
                self._buf = self._buf.rsplit("\r", 1)[-1]
        return len(s)

    def flush(self):
        with self._lock:
            if self._f is not None:
                try:
                    self._f.flush()
                except (OSError, ValueError):
                    pass

    def _emit(self, line):
        stamped = time.strftime("%H:%M:%S ") + line
        if self._f is not None:
            try:
                self._f.write(stamped + "\n")
            except (OSError, ValueError):
                pass
        else:
            self._pending = (self._pending + [stamped])[-20000:]
        try:
            self.on_line(line)
        except Exception:
            pass

    def line(self, text):
        """A line from the runner itself (not a stage)."""
        with self._lock:
            for l in str(text).splitlines() or [""]:
                self._emit(l)

    def open_file(self, path):
        with self._lock:
            if self._f is not None:
                return
            path = pathlib.Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._f = open(path, "a", encoding="utf-8")
            self.path = path
            self._f.write(f"===== Run cell started {datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')} =====\n")
            for l in self._pending:
                self._f.write(l + "\n")
            self._pending = []
            self._f.flush()

    def close_file(self):
        """Before the Finish step: console.log must not change between the final sync and its verification."""
        with self._lock:
            if self._buf:
                self._emit(self._buf)
                self._buf = ""
            if self._f is not None:
                try:
                    self._f.close()
                except OSError:
                    pass
                self._f = None

    @contextlib.contextmanager
    def capture(self):
        old = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = self
        try:
            yield
        finally:
            sys.stdout, sys.stderr = old
            with self._lock:
                if self._buf:
                    self._emit(self._buf)
                    self._buf = ""
            self.flush()


# ---- the panel controller --------------------------------------------------------------------------------------
class Dashboard:
    """Connects the stages to DashState and the view. Hooks: Progress.listener (every progress.jsonl event),
    Orchestrator.on_status (every poll of a training process) and Orchestrator.on_line (every training log line).
    A ticker thread redraws at most once a second, so the panel keeps moving during long stages."""

    def __init__(self, ns, mode="auto", clock=time.time, tick_s=1.0, stream=None):
        self.ns = ns
        self.state = DashState(clock)
        self.view = make_view(mode, stream)
        self.gh_note = None
        self._stale_orch = ns.get("ORCH")   # left from an earlier run of the cell in this kernel: never shown
        self._render_lock = threading.RLock()
        self._rendered = -1
        self._metric_cache = {}
        self._stop = threading.Event()
        self.tick_s = tick_s
        self._thread = None
        self.renders = 0
        if tick_s:
            self._thread = threading.Thread(target=self._tick, daemon=True, name="lrt-panel")
            self._thread.start()

    # -- hooks
    def on_event(self, rec):
        self.state.on_event(rec)

    def on_orch(self, orch, idle_min=None):
        if orch is self._stale_orch:
            return
        rows, eta_all = orch.status_rows()
        try:
            g = orch._gpu()
        except Exception:
            g = None
        self.state.on_orch(rows, orch.current, eta_all, idle_min, g)
        for rid in list(orch.plan):
            self._metric(rid)
        self.refresh()

    def on_line(self, rid, line):
        if line.strip():
            self.state.add_log(f"[{rid}] {line.rstrip()}")

    def on_console(self, line):
        self.state.add_log(line)

    # -- reading the stages' namespace (presentation only)
    def _metric(self, rid):
        res = self.ns.get("RESULTS")
        if res is None:
            return
        p = pathlib.Path(res) / f"metrics_{rid}.json"
        try:
            mt = p.stat().st_mtime_ns
        except OSError:
            return
        if self._metric_cache.get(rid) == mt:
            return
        self._metric_cache[rid] = mt
        try:
            m = json.loads(p.read_text())
            if rid.startswith("PC-"):
                txt = f"calib accuracy {m['calib']['triage_accuracy']:.3f}"
            elif rid.startswith("Z-"):
                txt = f"test macro recall {m['macro_recall']:.3f}"
            else:
                txt = f"calib macro recall {m['calib']['macro_recall_at_budget']:.3f}"
                if m.get("collapsed"):
                    txt += " (collapsed)"
        except Exception:
            return
        self.state.set_metric(rid, txt)

    def _gather(self):
        ns, st = self.ns, self.state
        storage_done = st.status["storage"] == "done"
        h = {"smoke": bool(ns.get("SMOKE"))}
        tag = ns.get("RUN_TAG")
        h["run_tag"] = tag if storage_done else (f"{tag} (requested)" if tag else "continue the recorded run, or a new one")
        if ns.get("GPU_NAME"):
            gb = ns.get("GPU_GB") or 0
            h["gpu"] = ns["GPU_NAME"] + (f", {gb:.0f} GB" if gb else "")
        tp = ns.get("TRAIN_PRECISION")
        ip = ns.get("INFER_PRECISION_EXPECTED")
        if tp or ip:
            h["precision"] = " · ".join(x for x in (f"training {str(tp).split(' (')[0]}" if tp else None,
                                                    f"scoring {ip}" if ip else None) if x)
        h["storage_name"] = "Drive" if ns.get("DRIVE_MOUNTED") or not storage_done else "Durable copy"
        with st.lock:
            st.header = h
            sync = ns.get("SYNC") if storage_done or st.status["storage"] == "active" else None
            fin = ns.get("FINISH_RESULT") or {}
            if sync is not None and hasattr(sync, "enabled"):
                st.indicators["drive"] = {"enabled": sync.enabled, "durable": ns.get("DURABLE"),
                                          "last_ok": sync.last_ok, "last_error": sync.last_error,
                                          "last_error_t": getattr(sync, "last_error_t", None),
                                          "unmounted": bool(fin.get("unmounted"))}
            P = ns.get("PROGRESS")
            if P is not None and hasattr(P, "pusher"):
                p = P.pusher
                st.indicators["github"] = {"configured": p is not None, "note": short_gh_note(self.gh_note),
                                           "enabled": bool(p and p.enabled), "errors": getattr(p, "errors", 0),
                                           "last_error": getattr(p, "last_error", None),
                                           "last_push_ok": getattr(P, "last_push_ok", None)}
                st.heartbeat_running = getattr(P, "_thread", None) is not None
            st.heartbeat_every = ns.get("PUSH_EVERY_S", 120)

    def refresh(self, force=False):
        with self._render_lock:
            try:
                self._gather()
            except Exception:
                pass
            s = self.state.snapshot()
            if not force and s["version"] == self._rendered and not isinstance(self.view, WidgetView):
                return s
            self._rendered = s["version"]
            try:
                self.view.update(s, force=force)
            except Exception:
                pass
            self.renders += 1
            return s

    def _tick(self):
        """Redraw about once a second. While the Training step runs, also read the orchestrator's current run (its
        phase changes to scoring without a poll of the training process)."""
        while not self._stop.wait(self.tick_s):
            try:
                orch = self.ns.get("ORCH")
                if self.state.status["training"] == "active" and orch is not None and orch is not self._stale_orch:
                    self.on_orch(orch, self.state.idle_min)
                else:
                    self.refresh()
            except Exception:
                pass

    def close(self, note=None):
        self._stop.set()
        if note:
            self.state.closed_note = note
            self.state._touch()
            self.refresh(force=True)

    def results_from_ns(self, finish=None):
        ns = self.ns
        V = ns.get("VERDICT") if isinstance(ns.get("VERDICT"), dict) else None
        r = {"outcome": V.get("outcome") if V else "(no verdict: the Verdict step did not run)"}
        if V:
            r.update(best_baseline=V.get("best_baseline"), chosen_base=V.get("chosen_base"),
                     shipped_seed=V.get("shipped_seed"), seeds_passing=V.get("seeds_passing_P1_to_P6"))
        fmt = ns.get("fmt")
        if fmt is not None and hasattr(fmt, "to_html"):
            try:
                r["table_html"] = fmt.round(3).to_html(index=False, na_rep="", border=0)
            except Exception:
                pass
        rr = ns.get("REMOTE_RUN")
        paths = []
        if rr is not None:
            rr = pathlib.Path(rr)
            paths.append(("results.zip (send this back)", str(rr / "results.zip")))
            paths.append(("results folder", str(rr / "results")))
            if ns.get("DRIVE_MOUNTED"):
                paths.append(("in Google Drive", f"MyDrive/laya-release-triage/{ns.get('RUN_TAG')}/results.zip"))
        P = ns.get("PROGRESS")
        if P is not None and getattr(P, "pusher", None) is not None and ns.get("REPO"):
            paths.append(("live progress on GitHub", f"https://github.com/{ns['REPO']}/tree/{ns.get('RESULTS_BRANCH')}/"
                                                     f"{ns.get('SUBDIR')}/colab-runs/{ns.get('RUN_TAG')}"))
        r["paths"] = paths
        if finish is not None:
            if finish.get("released"):
                r["finish"] = ("ok", "everything synced and verified on Drive; the runtime was released")
            elif finish.get("problems"):
                r["finish"] = ("error", "runtime NOT released: " + "; ".join(finish["problems"])[:400])
            else:
                r["finish"] = ("ok", "everything synced and verified; release the runtime yourself when done"
                               if ns.get("IN_COLAB") else "everything synced and verified")
        self.state.set_results(r)

    def to_html(self, banner=None):
        self._gather()
        return to_html(self.state.snapshot(), banner)

    def public_html(self):
        """dashboard.html for GitHub: exactly what the panel shows now (last 100 log lines), with known secret values
        and token-like strings removed and absolute paths reduced to the run folder."""
        self._gather()
        s = self.state.snapshot()
        t = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(s["t"]))
        page = to_html(s, banner=f"Snapshot of the notebook's control panel at {t} (static; refreshed with every "
                                  "heartbeat and stage change).", log_lines=100, title="Laya run: control panel",
                       open_log=True)
        return public_text(page, self.ns)


TOKEN_PAT = re.compile(r"github_pat_[A-Za-z0-9_]{8,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bhf_[A-Za-z0-9]{12,}|"
                       r"(?i:bearer)\s+[A-Za-z0-9._~+/=-]{8,}")
ABS_PATH_PAT = re.compile(r"(?<![\w<])/(?:content|home|root|tmp|mnt|var|opt|usr|srv)/[^\s<>'\"]*")


def public_text(text, ns):
    """Remove secrets and reduce absolute paths (for anything published outside the VM and Drive)."""
    secrets = []
    P = ns.get("PROGRESS")
    tok = getattr(getattr(P, "pusher", None), "_token", None)
    for v in (tok, os.environ.get("HF_TOKEN"), os.environ.get("GH_TOKEN")):
        if isinstance(v, str) and len(v) >= 6:
            secrets.append(v)
    for v in secrets:
        text = text.replace(v, "[redacted]").replace(html.escape(v), "[redacted]")
    text = TOKEN_PAT.sub("[redacted]", text)
    tag = ns.get("RUN_TAG")
    subs = []
    if ns.get("REMOTE_RUN") is not None:
        subs.append((str(ns["REMOTE_RUN"]), f"MyDrive/laya-release-triage/{tag}" if ns.get("DRIVE_MOUNTED") else "[run folder]"))
    for key, label in (("RUN_DIR", "[local run folder]"), ("OUT_ROOT", "[output folder]"), ("WORK", "[work dir]"),
                       ("CONTENT", "[content]")):
        if ns.get(key) is not None:
            subs.append((str(ns[key]), label))
    for a, b in sorted(subs, key=lambda x: -len(x[0])):
        if len(a) > 1:
            text = text.replace(a, b)
    return ABS_PATH_PAT.sub("[path]", text)


# ---- runner ----------------------------------------------------------------------------------------------------
def stage_source(stage, data_ref, manifest_sha256):
    src = globals()[stage.source]
    if stage.source == "CONFIG":
        src = src.replace("__DATA_REF__", data_ref).replace("__MANIFEST_SHA256__", manifest_sha256)
    return src


PIP_LINE = re.compile(r"^(\s*)%pip (.*)$", re.M)


def compile_stage(stage, src, shell):
    """IPython magics (only `%pip` in the Install stage) go through the shell's own transform, as in a cell."""
    if stage.magic:
        if shell is not None:
            src = shell.transform_cell(src)
        else:   # plain Python: the same pip call, without IPython
            src = PIP_LINE.sub(lambda m: f"{m.group(1)}_lrt_pip(f'''{m.group(2)}''')", src)
    fname = f"<lrt_runner {stage.source}>"
    linecache.cache[fname] = (len(src), None, src.splitlines(True), fname)
    return compile(src, fname, "exec")


def _lrt_pip(args):
    subprocess.check_call([sys.executable, "-m", "pip", *shlex.split(args)])


def _shell():
    try:
        from IPython import get_ipython
        return get_ipython()
    except ImportError:
        return None


def run(ns, data_ref, manifest_sha256, mode=None):
    """Run every stage in order in the notebook namespace `ns`, under the control panel. Re-running resumes."""
    if not re.fullmatch(r"[0-9a-f]{40}", data_ref or "") or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256 or ""):
        raise SystemExit("DATA_REF / MANIFEST_SHA256 are not pinned (40 / 64 hex characters)")
    old = ns.get("LRT_DASHBOARD")
    if old is not None and hasattr(old, "close"):
        old.close("This panel is no longer updated: the Run cell was started again (see the newer panel).")
    oldp = ns.get("PROGRESS")
    if oldp is not None and hasattr(oldp, "stop_timer"):
        oldp.stop_timer()   # one heartbeat timer at a time; the new session starts its own
    hooks = ns.get("_LRT_TEST_HOOKS") or {}   # TEST-ONLY (colab/test_notebook_smoke.py); never set in the notebook
    dash = Dashboard(ns, mode=mode or os.environ.get("LRT_PANEL") or "auto", tick_s=hooks.get("tick_s", 1.0))
    ns["LRT_DASHBOARD"] = dash
    ns["_lrt_pip"] = _lrt_pip
    ns["PROGRESS_LISTENER"], ns["ORCH_STATUS_HOOK"], ns["ORCH_LINE_HOOK"] = dash.on_event, dash.on_orch, dash.on_line
    if hooks.get("on_dashboard"):
        hooks["on_dashboard"](dash)
    dash.state.set_plan(expected_plan(ns), "settings")
    console = Console(dash.on_console)
    shell = _shell()
    stage = None
    dash.refresh(force=True)
    try:
        for stage in STAGES:
            dash.state.begin(stage)
            dash.refresh(force=True)
            P = ns.get("PROGRESS")
            if P is not None and getattr(P, "pusher", None) is not None and stage.source != "FINISH":
                threading.Thread(target=P.push, daemon=True, name="lrt-panel-push").start()   # stage change
            if stage.source == "FINISH":
                console.close_file()
                dash.results_from_ns()
            code = compile_stage(stage, stage_source(stage, data_ref, manifest_sha256), shell)
            with console.capture():
                if stage.progress:
                    ns["PROGRESS"].begin(stage.progress)
                exec(code, ns)
                if stage.progress:
                    ns["PROGRESS"].end(stage.progress)
            if stage.source == "PROGRESS_CELL":
                dash.gh_note = ns.get("_note")
                ns["PROGRESS"].snapshot_files = lambda: {"dashboard.html": dash.public_html().encode("utf-8")}
            elif stage.source == "DRIVE":
                console.open_file(pathlib.Path(ns["RESULTS"]) / "logs" / "console.log")
                led = pathlib.Path(ns["RUN_DIR"]) / "state.json"
                if led.exists():
                    try:
                        dash.state.load_ledger(json.loads(led.read_text()))
                    except (OSError, ValueError):
                        pass
                    for rid in list(dash.state.runs):
                        dash._metric(rid)
            elif stage.source == "TRAIN" and ns.get("ORCH") is not None:
                dash.state.set_plan(ns["ORCH"].plan, "training")
                for rid in ns["ORCH"].plan:
                    dash._metric(rid)
            elif stage.source == "SUMMARY":
                dash.results_from_ns()
            elif stage.source == "FINISH":
                dash.results_from_ns(finish=ns.get("FINISH_RESULT"))
            dash.state.end(stage)
            dash.refresh(force=True)
        dash.state.now = "Done. " + ("The runtime was released." if (ns.get("FINISH_RESULT") or {}).get("released")
                                     else "See the results below.")
        dash.state._touch()
    except KeyboardInterrupt:
        dash.state.stop(stage.step if stage else None)
        console.line("Stopped by the user (KeyboardInterrupt).")
        raise
    except BaseException as e:
        msg = f"{type(e).__name__}: {e}"
        console.line("".join(traceback.format_exception(type(e), e, e.__traceback__)))
        where = ("full traceback: the cell output below this panel" +
                 (f", {console.path}" if console.path else "") +
                 (", and results/progress.jsonl (event \"error\")" if ns.get("RESULTS") else ""))
        dash.state.fail(stage.step if stage else "setup", msg, where)
        raise
    finally:
        console.close_file()
        dash.close()
        dash.refresh(force=True)
    return dash
