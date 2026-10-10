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

This notebook runs the experiment fixed in
[PREREGISTRATION.md](https://github.com/kambasana/56/blob/research/laya-proper/experiments/release-triage/PREREGISTRATION.md).
Run it **top to bottom** on a Colab GPU runtime: *Runtime → Change runtime type → A100 GPU* (L4 also works, but
more slowly).

What it does:

1. Checks the GPU and installs pinned packages.
2. Downloads the dataset from GitHub and verifies every file's sha256.
3. Downloads the Laya checkpoints at a pinned revision.
4. Runs `laya-train --dry-run`, then two zero-shot references, two label-encoding positive controls, and six
   fine-tunes (English and typed-decisions bases, seeds 0, 1 and 2).
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

Progress is saved to Drive after every run, so if Colab disconnects, run all cells again: finished runs are
skipped.

**Send back:** the `results` folder (or `results.zip`) from `MyDrive/laya-release-triage/`.

Shai-Hulud is one incident family among many here. Every recall figure is a macro average over families, and
no gate names a family."""

CONFIG = '''# ---- Settings (normally nothing to change) ---------------------------------------------------------------
HF_TOKEN = ""            # optional: paste a Hugging Face read token to avoid anonymous rate limits
USE_DRIVE = True         # save progress, results and the chosen checkpoint to Google Drive
EXPORT_ONNX = True       # export the chosen checkpoint with receptron/laya's export/export_onnx.py
RUN_ZERO_SHOT = True     # reference runs Z-EN (512) and Z-TD (1024)
RUN_POSITIVE_CONTROL = True
RUN_FINETUNE = True

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

import os, sys, json, time, math, glob, gzip, shutil, hashlib, pathlib, subprocess, urllib.request
SMOKE = os.environ.get("LRT_SMOKE") == "1"   # used only by the author's local CPU check; leave unset
WORK = pathlib.Path(os.environ.get("LRT_WORK", "/content/lrt"))
WORK.mkdir(parents=True, exist_ok=True)
print("work dir", WORK, "| smoke" if SMOKE else "")'''

PROGRESS_CELL = r'''# Live progress (optional). If a Colab secret named GH_TOKEN exists and this notebook has access to it, progress
# and the small results/*.json files are pushed to branch RESULTS_BRANCH of REPO every ~2 minutes and at the end of
# every stage, through the GitHub contents REST API over HTTPS. The token is read with google.colab.userdata, kept
# in memory only, sent only in the Authorization header to api.github.com, and never printed, logged or written to
# disk (no git credentials are created). Without GH_TOKEN the run is the same and saves to Drive only.
import base64, datetime, re, threading, traceback, uuid, urllib.error, urllib.parse
RESULTS_BRANCH = "results/laya-colab"
PUSH_EVERY_S = 120
SMALL_FILE_BYTES = 512 * 1024

def _read_gh_token():
    try:
        from google.colab import userdata
    except Exception:
        return None
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
        if self._thread is not None or self.pusher is None:
            return
        def loop():
            while True:
                time.sleep(PUSH_EVERY_S)
                try:
                    self.push()
                except Exception as e:   # never let the timer die or leak details
                    print("progress push failed:", type(e).__name__)
        self._thread = threading.Thread(target=loop, daemon=True, name="progress-push")
        self._thread.start()


_tok = None if SMOKE else _read_gh_token()
PROGRESS = Progress(GitHubPusher(_tok, REPO, RESULTS_BRANCH, "research/laya-proper", "") if _tok else None)
del _tok
print("live progress to GitHub:", f"on (branch {RESULTS_BRANCH} of {REPO})" if PROGRESS.pusher else "off (no GH_TOKEN secret); Drive only")

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

GPU = '''import subprocess, torch
print(subprocess.run(["nvidia-smi"], capture_output=True, text=True).stdout if shutil.which("nvidia-smi") else "no nvidia-smi")
if not torch.cuda.is_available() and not SMOKE:
    raise SystemExit("No GPU. Runtime -> Change runtime type -> A100 GPU (or L4), then Runtime -> Run all.")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cuda":
    props = torch.cuda.get_device_properties(0)
    GPU_NAME, GPU_GB = props.name, props.total_memory / 1e9
    BF16 = torch.cuda.is_bf16_supported()
else:
    GPU_NAME, GPU_GB, BF16 = "cpu", 0.0, False
# Effective batch 64 either way (PREREGISTRATION.md): 8 x 8 on >= 30 GB, else 4 x 16.
MICRO, ACCUM = (8, 8) if GPU_GB >= 30 else (4, 16)
SCORE_BATCH = 32 if GPU_GB >= 30 or DEVICE == "cpu" else 16   # scoring only; latency is measured at batch 32
print(f"device {DEVICE} {GPU_NAME} {GPU_GB:.1f} GB bf16={BF16} micro-batch {MICRO} x accum {ACCUM}")
PROGRESS.ctx["gpu"] = GPU_NAME
if DEVICE == "cuda" and not BF16:
    print("WARNING: this GPU has no bf16 (e.g. T4). Laya's checkpoints use bf16 autocast; prefer an A100 or L4.")'''

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
assert VERSIONS["laya"] == "0.4.1", "laya 0.4.1 is the pre-registered version"'''

DRIVE = '''OUT = WORK
if USE_DRIVE and not SMOKE:
    try:
        from google.colab import drive
        drive.mount("/content/drive")
        OUT = pathlib.Path("/content/drive/MyDrive/laya-release-triage")
    except Exception as e:  # not on Colab, or the user declined
        print("Drive not mounted, saving under", WORK, "-", e)
RESULTS = OUT / "results"
(RESULTS / "logs").mkdir(parents=True, exist_ok=True)
print("results ->", RESULTS)
# One run tag per Drive folder, kept across reconnects, so live progress continues in the same place.
_tag_file = OUT / "run_tag.txt"
if _tag_file.exists():
    RUN_TAG = _tag_file.read_text().strip()
else:
    RUN_TAG = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    _tag_file.write_text(RUN_TAG + "\\n")
PROGRESS.bind(RESULTS, RUN_TAG)
PROGRESS.log("session_start", dataset_commit=DATA_REF, manifest_sha256=MANIFEST_SHA256)
PROGRESS.start_timer()
if PROGRESS.pusher:
    print(f"live progress: https://github.com/{REPO}/tree/{RESULTS_BRANCH}/{SUBDIR}/colab-runs/{RUN_TAG}")

def save_json(name, obj):
    p = RESULTS / name
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=str) + "\\n")
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
       "grad_accum": ACCUM, "cpu_count": os.cpu_count(), "python": sys.version.split()[0], "smoke": SMOKE}
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

def train_flags(base, data, seed, epochs, out=None, eval_data=None):
    f = ["--data", str(data), "--base", base, "--max-len", str(MAX_LEN), "--head-max-len", str(HEAD_MAX_LEN),
         "--loss", "soft-ce", "--shuffle-options", "--seed", str(seed), "--epochs", str(epochs),
         "--micro-batch", str(MICRO), "--grad-accum", str(ACCUM)]
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

def score_run(run_id, ckpt, splits=("calib", "test"), rows=None):
    path = RESULTS / f"scores_{run_id}.csv.gz"
    if path.exists():
        return pd.read_csv(path, keep_default_na=False)
    t0 = time.time()
    agent = laya.load(str(ckpt), device=DEVICE)
    load_s = time.time() - t0
    recs = []
    for sp in splits:
        rs = (rows or ROWS)[sp]
        t1 = time.time()
        out = agent.predict_batch([r["state"] for r in rs], Q_SCORE, batch_size=SCORE_BATCH, sort_by_length=True)
        dt = time.time() - t1
        si_idx = [i for i, r in enumerate(rs) if "script_intent" in r["questions"]]
        si_ab, si_tf = {}, {}
        if SI and si_idx:
            o2 = agent.predict_batch([rs[i]["state"] for i in si_idx], {"si_ab": SI, "si_tf": SI_DEFAULT},
                                     batch_size=SCORE_BATCH, sort_by_length=True)
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
    df.to_csv(path, index=False, compression="gzip")
    save_json(f"load_{run_id}.json", {"load_seconds": load_s, "checkpoint": str(ckpt)})
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

def harness(run_id, ckpt):
    path = RESULTS / f"evals_{run_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    from laya import evals
    agent = laya.load(str(ckpt), device=DEVICE)
    rep = evals.evaluate(AgentRunner(agent), evals.Dataset.from_jsonl(str(DATA_DIR / "test.jsonl")),
                         batch_size=SCORE_BATCH, config={"run": run_id, "checkpoint": str(ckpt), "device": DEVICE})
    j = rep.to_json()
    j.pop("cases", None)
    save_json(path.name, j)
    del agent; gc_collect()
    return j'''

METRICS = '''# Pre-registered metrics (same code as the baselines: src/triage_metrics.py).
def metrics(run_id, sc):
    path = RESULTS / f"metrics_{run_id}.json"
    m = META[["split", "key", "label", "family", "category", "published", "publisher"]]
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

ZERO = '''# Zero-shot references (reported only; cannot pass): English as shipped (512/192), typed-decisions (1024/256).
if RUN_ZERO_SHOT:
    for run_id, b in (("Z-EN", "EN"), ("Z-TD", "TD")):
        sc = score_run(run_id, BASES[b])
        RESULTS_BY_RUN[run_id] = metrics(run_id, sc)
        harness(run_id, BASES[b])
        r = RESULTS_BY_RUN[run_id]
        PROGRESS.log("run_scored", run_id=run_id, test_macro_recall=r["macro_recall"], test_auc=r["roc_auc"])
        PROGRESS.push()
        print(run_id, "macro recall", round(r["macro_recall"], 3), "AUC", round(r["roc_auc"], 3),
              "flip", round(r["order_check"]["alert_flip_rate"], 3))'''

TRAIN = '''# Fine-tuning: one function for every run; finished runs (scores on Drive) are skipped after a reconnect.
RUNS = WORK / "runs"

def run_train(run_id, base, data, eval_data, seed):
    out = RUNS / run_id
    log = RESULTS / "logs" / f"train_{run_id}.log"
    if (out / "model.safetensors").exists() and (out / "train_report.json").exists():
        return out, (log.read_text() if log.exists() else "")
    if out.exists():
        shutil.rmtree(out)
    cmd = [*LAYA_TRAIN, *train_flags(base, data, seed, EPOCHS, out=out, eval_data=eval_data)]
    print(" ".join(cmd))
    t0 = time.time()
    PROGRESS.log("run_start", run_id=run_id, epochs=EPOCHS, seed=seed)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = []
    for line in p.stdout:
        lines.append(line); print(line, end="")
        train_progress(run_id, line)
    p.wait()
    text = "".join(lines)
    log.write_text(text)
    if p.returncode != 0:
        PROGRESS.log("run_failed", run_id=run_id, returncode=p.returncode, log_tail=text[-4000:])
        PROGRESS.push()
        raise SystemExit(f"{run_id}: laya-train exited {p.returncode}; see {log}")
    shutil.rmtree(out / "checkpoint_latest", ignore_errors=True)
    rep = json.loads((out / "train_report.json").read_text())
    rep["wall_seconds"] = time.time() - t0
    rep["collapse_warning"] = "collapsed to the class prior" in text
    save_json(f"train_{run_id}.json", rep)
    PROGRESS.log("run_trained", run_id=run_id, wall_seconds=round(rep["wall_seconds"], 1))
    PROGRESS.push()
    return out, text

def label_copy(sp):
    """Positive control: state -> 'label=<expected triage>; ' + json.dumps(state) (fine-tuning guide)."""
    p = DATA_DIR / f"{sp}_pc.jsonl"
    with open(p, "w", encoding="utf-8") as f:
        for r in ROWS[sp]:
            r2 = dict(r, state="label=%s; " % r["expected"]["triage"] + json.dumps(r["state"], ensure_ascii=False))
            f.write(json.dumps(r2, ensure_ascii=False) + "\\n")
    return p

def done(run_id):
    return (RESULTS / f"metrics_{run_id}.json").exists() and (RESULTS / f"train_{run_id}.json").exists()

def finish(run_id, ckpt, rows=None):
    sc = score_run(run_id, ckpt, rows=rows)
    ev = metrics(run_id, sc)
    tr = json.loads((RESULTS / f"train_{run_id}.json").read_text())
    ev["collapsed"] = bool(tr.get("collapse_warning")) or (ev["calib"]["roc_auc"] is not None and ev["calib"]["roc_auc"] < 0.60)
    save_json(f"metrics_{run_id}.json", ev)
    RESULTS_BY_RUN[run_id] = ev
    PROGRESS.log("run_scored", run_id=run_id, calib_macro_recall=ev["calib"]["macro_recall_at_budget"],
                 calib_auc=ev["calib"]["roc_auc"], collapsed=ev["collapsed"])
    PROGRESS.push()
    print(run_id, "calib macro recall", round(ev["calib"]["macro_recall_at_budget"], 3), "calib AUC", ev["calib"]["roc_auc"],
          "collapsed", ev["collapsed"], "| test macro recall", round(ev["macro_recall"], 3))
    return ev

if RUN_POSITIVE_CONTROL:
    pc_rows = None
    for b in ("EN", "TD"):
        run_id = f"PC-{b}"
        if done(run_id):
            RESULTS_BY_RUN[run_id] = json.loads((RESULTS / f"metrics_{run_id}.json").read_text()); continue
        tr, ca = label_copy("train"), label_copy("calib")
        ckpt, _ = run_train(run_id, BASES[b], tr, ca, 0)
        pc_rows = {"calib": read_jsonl(ca), "test": read_jsonl(label_copy("test"))}
        finish(run_id, ckpt, rows=pc_rows)
        shutil.rmtree(ckpt, ignore_errors=True)   # the control's weights are not needed afterwards

if RUN_FINETUNE:
    for b in ("EN", "TD"):
        for s in SEEDS:
            run_id = f"F-{b}-s{s}"
            if done(run_id):
                RESULTS_BY_RUN[run_id] = json.loads((RESULTS / f"metrics_{run_id}.json").read_text()); continue
            ckpt, _ = run_train(run_id, BASES[b], DATA_DIR / "train.jsonl", DATA_DIR / "calib.jsonl", s)
            finish(run_id, ckpt)
            harness(run_id, ckpt)'''

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
SHIP = RUNS / SHIP_ID if SHIP_ID else None
if SHIP is not None and not (SHIP / "model.safetensors").exists():
    print("re-training the shipped checkpoint (lost after a disconnect) with the same seed")
    SHIP, _ = run_train(SHIP_ID, BASES[chosen], DATA_DIR / "train.jsonl", DATA_DIR / "calib.jsonl", ship_seed)
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

SAVE = '''# Save the shipped checkpoint (chosen on calib only) to Google Drive.
if SHIP is not None:
    dst = OUT / f"checkpoint_{SHIP_ID}"
    if not (dst / "model.safetensors").exists():
        shutil.copytree(SHIP, dst, dirs_exist_ok=True)
    print("checkpoint saved to", dst, "| sha256", file_sha(dst / "model.safetensors")[:16])
    save_json("shipped_checkpoint.json", {"run": SHIP_ID, "path": str(dst),
                                         "model_sha256": file_sha(dst / "model.safetensors")})'''

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
rows_out = []
for r in BASELINES["results"]:
    rows_out.append({"method": r["method"], **{c: r.get(c) for c in cols}, "order_flip": None, "collapsed": None})
for run_id in sorted(p.stem.replace("metrics_", "") for p in RESULTS.glob("metrics_*.json")):
    m = load_m(run_id)
    rows_out.append({"method": "laya " + run_id, **{c: m.get(c) for c in cols},
                     "order_flip": m["order_check"]["alert_flip_rate"], "collapsed": m.get("collapsed")})
T = pd.DataFrame(rows_out)
fmt = T.copy()
fmt["macro_recall_ci95_family_bootstrap"] = fmt["macro_recall_ci95_family_bootstrap"].map(
    lambda v: f"[{v[0]:.3f}, {v[1]:.3f}]" if isinstance(v, list) else "")
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print(fmt.round(3).to_string(index=False))
print()
print("VERDICT:", VERDICT["outcome"])
print("best baseline:", VERDICT["best_baseline"], "| chosen base:", VERDICT["chosen_base"], "| shipped seed:", VERDICT["shipped_seed"])
try:
    table = fmt.round(3).to_markdown(index=False)
except ImportError:  # tabulate missing
    table = "```\\n" + fmt.round(3).to_string(index=False) + "\\n```"
(RESULTS / "summary.md").write_text("# Laya release triage: summary\\n\\n" + table
                                    + f"\\n\\n**Verdict:** {VERDICT['outcome']}\\n")
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
        new_markdown_cell("## 2. GPU check"), staged("gpu", GPU),
        new_markdown_cell("## 3. Install pinned packages"), staged("install", PIP),
        new_markdown_cell("## 4. Google Drive (progress, results, checkpoint)"), staged("drive", DRIVE),
        new_markdown_cell("## 5. Dataset (sha256-verified)"), staged("data", DATA),
        new_markdown_cell("## 6. Validity checks (before any Laya run)"), staged("validity", VALIDITY),
        new_markdown_cell("## 7. Base checkpoints at the pinned revision"), staged("checkpoints", CKPT),
        new_markdown_cell("## 8. Token budget and truncation"), staged("tokens", TOKENS),
        new_markdown_cell("## 9. `laya-train --dry-run` and the epoch budget"), staged("dryrun", DRYRUN),
        new_markdown_cell("## 10. Scoring, order check and Laya's eval harness (definitions)"), staged("score_defs", SCORE),
        new_markdown_cell("## 11. Metrics (definitions)"), staged("metric_defs", METRICS),
        new_markdown_cell("## 12. Zero-shot references"), staged("zero_shot", ZERO),
        new_markdown_cell("## 13. Positive controls and fine-tunes (the long part: several hours on an A100)"), staged("train", TRAIN),
        new_markdown_cell("## 14. Verdict (pre-registered rule)"), staged("verdict", VERDICT),
        new_markdown_cell("## 15. Latency"), staged("latency", LATENCY),
        new_markdown_cell("## 16. Save the chosen checkpoint to Drive"), staged("save_checkpoint", SAVE),
        new_markdown_cell("## 17. Optional ONNX export (receptron/laya script)"), staged("onnx", ONNX),
        new_markdown_cell("## 18. Summary"), staged("summary", SUMMARY),
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
