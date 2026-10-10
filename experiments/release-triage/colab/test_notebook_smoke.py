"""Smoke run of the committed two-cell notebook (Settings form + Run cell) on CPU, with google.colab mocked.

Executes the notebook's own cells in a real IPython shell (so %pip, the post-run hook and the panel behave as in
Colab). The Run cell loads colab/lrt_runner.py through its own sha256 check (LRT_RUNNER_FILE points it at this
working tree's copy, which must match the RUNNER_SHA256 pinned in the notebook) and runs every stage, Setup to
Finish, under the control panel. Settings as a user would set them in the form: SMOKE on (16 releases per split,
1 epoch) and RUN_TAG "smoke-test". Stand-ins, all TEST ONLY:
  * google.colab.userdata / drive / runtime: in-memory mocks (Drive = a temp folder; no secret, so live progress
    and remote control are off);
  * torch: a stub reporting a fake A100; the pinned packages: dist-info version stubs; %pip is recorded, not run;
  * laya, transformers, huggingface_hub: stub modules with just the calls the stages make (fixed probabilities,
    a fake snapshot); laya-train (`python -m laya.train_cli`) runs the fake trainer of colab/test_resume.py;
  * the dataset is the real one, fetched from raw.githubusercontent.com at the pinned commit (DATA_REF, afcb46d)
    and checked against MANIFEST_SHA256.
Session 1 runs everything (ten runs trained/scored by the stubs, verdict, summary, finish: final sync, sha256
verification, flush_and_unmount, then unassign). Session 2, on a fresh "VM" with the same "Drive", resumes: every run
is verified and skipped. Session 3 (no GPU) is refused at the GPU step and the panel shows the failure.
Also: the notebook is valid nbformat, equals make_notebook.py's output, and pins this lrt_runner.py by sha256.

Needs: nbformat, ipython, numpy, pandas, scikit-learn and network access to raw.githubusercontent.com.
Run: python -I colab/test_notebook_smoke.py
"""
from __future__ import annotations

import hashlib
import importlib.machinery
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import types

HERE = pathlib.Path(__file__).resolve().parent
NB = HERE / "laya_release_triage.ipynb"
RUNNER = HERE / "lrt_runner.py"
DATASET_COMMIT = "afcb46d"
STUB_PINS = {"laya": "0.4.1", "transformers": "4.57.1", "huggingface_hub": "0.36.2", "tokenizers": "0.22.2",
             "safetensors": "0.8.0", "scikit-learn": "1.7.2", "onnx": "1.22.0", "onnxruntime": "1.29.0",
             "onnxscript": "0.7.1", "torch": "2.8.0+cu126"}
PLAN = ["PC-EN", "PC-TD", "F-TD-s0", "F-EN-s0", "F-TD-s1", "F-EN-s1", "F-TD-s2", "F-EN-s2", "Z-EN", "Z-TD"]


def code_cells():
    import nbformat
    nb = nbformat.read(str(NB), 4)
    nbformat.validate(nb)
    return [c.source for c in nb.cells if c.cell_type == "code"]


# ------------------------------------------------------------------------------------------- TEST-ONLY stubs
STUB_LAYA = {
    "__init__.py": '''# TEST-ONLY stub of laya 0.4.1: just the calls the notebook's stages make. Fixed probabilities: a positive-control
# state ("label=<expected>; ...") is answered with its label, anything else with the same low-information answer.
import json

class _Agent:
    dtype, amp_enabled, tok = "float32 (TEST-ONLY stub)", False, None

    def __init__(self, path, device):
        self.path, self.device = path, device

    def _answer(self, state, name, q):
        if name.startswith("si"):
            return {"noul": 0.3}
        crit = list(q.get("criteria") or ["likely_malicious", "review", "routine"])
        s = state if isinstance(state, str) else json.dumps(state)
        if s.startswith("label="):
            lab = s[len("label="):].split(";", 1)[0]
            p = {c: (0.98 if c == lab else 0.01) for c in crit}
        else:
            p = {c: v for c, v in zip(crit, (0.2, 0.3, 0.5))}
        choice = max(p, key=p.get)
        return {"probabilities": p, "choice": choice, "answer_confidence": p[choice], "noul": 0.3}

    def predict_batch(self, states, questions, batch_size=None, sort_by_length=False, **kw):
        return [{"answers": {n: self._answer(s, n, q) for n, q in questions.items()}, "usage": {"truncated": False}}
                for s in states]

def load(path, device="cpu"):
    return _Agent(path, device)
''',
    "evals.py": '''# TEST-ONLY stub of laya.evals
class Dataset:
    def __init__(self, path):
        self.path = path

    @classmethod
    def from_jsonl(cls, path):
        return cls(path)

class _Report:
    def __init__(self, config):
        self.config = config

    def to_json(self):
        return {"stub": "TEST-ONLY", "config": self.config, "cases": []}

def evaluate(runner, dataset, batch_size=None, config=None):
    return _Report(config)
''',
    "agent.py": "# TEST-ONLY stub\ndef _fix_tokenizer_config(base_dir):\n    return None\n",
    "common.py": '''# TEST-ONLY stub of laya.common
import json

def build_sequence(tok, state, qi, max_len, head_max_len, return_truncation_stats=False):
    n = len(json.dumps(state)) // 4
    ids, mk = list(range(min(n, max_len))), [0]
    st = {"truncated": n > max_len - head_max_len, "state_tokens": n}
    return (ids, mk, st) if return_truncation_stats else (ids, mk)
''',
    "train.py": '''# TEST-ONLY stub of laya.train (the Install stage reads the source of _forward and train_model)
import math

def _forward(x):
    return "autocast(dtype=torch.float16)"

def train_model(x):
    return "GradScaler"

def to_internal(qid, q):
    return q

class TrainConfig:
    def __init__(self, **kw):
        self.__dict__.update(kw)

def dry_run(data, base, cfg):
    with open(data, encoding="utf-8") as f:
        n = sum(1 for l in f if l.strip())
    return {"train_items": n, "calibration_items": 0, "optimizer_updates": max(1, math.ceil(n / 64)),
            "skipped": {}, "eval_skipped": {}, "stub": "TEST-ONLY"}
''',
    "train_cli.py": '''# TEST-ONLY stub of laya-train: --dry-run prints a summary; training runs colab/test_resume.py's fake trainer.
import argparse, pathlib, sys
sys.path.insert(0, __TEST_DIR__)
ap = argparse.ArgumentParser()
for a in ("--data", "--base", "--loss", "--eval", "--out", "--device"):
    ap.add_argument(a, default="")
for a in ("--max-len", "--head-max-len", "--seed", "--epochs", "--micro-batch", "--grad-accum"):
    ap.add_argument(a, type=int, default=0)
ap.add_argument("--shuffle-options", action="store_true")
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()
n = sum(1 for l in open(a.data, encoding="utf-8") if l.strip())
if a.dry_run:
    print(f"DRY RUN (TEST-ONLY stub): train items {n}, options_beyond_max_len 0")
    sys.exit(0)
import test_resume
out = pathlib.Path(a.out)
test_resume.fake_trainer_TEST_ONLY(["--out", str(out), "--epochs", str(a.epochs), "--micro", str(a.micro_batch),
                                    "--accum", str(a.grad_accum), "--n", str(n), "--oom-above", "64",
                                    "--state", str(out.parent / (out.name + ".tries")), "--step-s", "0.01"])
''',
}
STUB_TRANSFORMERS = '''# TEST-ONLY stub of transformers
class AutoTokenizer:
    @staticmethod
    def from_pretrained(path):
        return object()
'''
STUB_HUB = '''# TEST-ONLY stub of huggingface_hub: a fake snapshot of the two base checkpoints
import json, pathlib

def snapshot_download(repo, revision=None, local_dir=None, allow_patterns=None, token=None):
    root = pathlib.Path(local_dir)
    for sub in ("", "typed-decisions/"):
        d = root / sub
        (d / "tokenizer").mkdir(parents=True, exist_ok=True)
        (d / "encoder").mkdir(parents=True, exist_ok=True)
        (d / "rl_agent_config.json").write_text(json.dumps({"max_len": 1024, "head_max_len": 256}))
        (d / "model.safetensors").write_bytes(b"TEST-ONLY weights " + sub.encode())
        (d / "tokenizer" / "tokenizer.json").write_text("{}")
        (d / "encoder" / "config.json").write_text("{}")
    return str(root)

class HfApi:
    def get_paths_info(self, repo, paths, revision=None, token=None):
        return []
'''


def make_stubs(site, cuda=True):
    """TEST-ONLY: dist-info version stubs, stub laya / transformers / huggingface_hub packages, and a stub torch."""
    site.mkdir(parents=True, exist_ok=True)
    for name, ver in STUB_PINS.items():
        d = site / f"{name.replace('-', '_')}-{ver}.dist-info"
        d.mkdir(exist_ok=True)
        (d / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: {ver}\n")
    (site / "laya").mkdir(exist_ok=True)
    for f, src in STUB_LAYA.items():
        (site / "laya" / f).write_text(src.replace("__TEST_DIR__", repr(str(HERE))))
    (site / "transformers").mkdir(exist_ok=True)
    (site / "transformers" / "__init__.py").write_text(STUB_TRANSFORMERS)
    (site / "huggingface_hub").mkdir(exist_ok=True)
    (site / "huggingface_hub" / "__init__.py").write_text(STUB_HUB)
    t = types.ModuleType("torch")
    t.__version__ = STUB_PINS["torch"]
    t.Tensor = type("Tensor", (), {})   # other libraries probe sys.modules["torch"].Tensor
    props = types.SimpleNamespace(name="NVIDIA A100-SXM4-40GB (TEST-ONLY stub)", total_memory=40e9, major=8, minor=0)
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda, get_device_properties=lambda i: props,
                                   is_bf16_supported=lambda: True, empty_cache=lambda: None, synchronize=lambda: None)
    t.version = types.SimpleNamespace(cuda="12.6")
    t.backends = types.SimpleNamespace(cudnn=types.SimpleNamespace(version=lambda: 91002))
    t.set_num_threads = lambda n: None
    return t


def install_colab_mock(calls):
    def mod(name, **attrs):
        m = types.ModuleType(name)
        m.__spec__ = importlib.machinery.ModuleSpec(name, None, is_package=True)
        m.__path__ = []
        m.__dict__.update(attrs)
        sys.modules[name] = m
        return m

    class SecretNotFoundError(Exception):
        pass

    class NotebookAccessError(Exception):
        pass

    def get(name):
        calls.append(("userdata.get", name))
        raise SecretNotFoundError(name)

    def mount(path, force_remount=False, **kw):
        calls.append(("drive.mount", path, force_remount))
        pathlib.Path(path, "MyDrive").mkdir(parents=True, exist_ok=True)

    g = mod("google")
    gc = mod("google.colab")
    g.colab = gc
    gc.userdata = mod("google.colab.userdata", get=get, SecretNotFoundError=SecretNotFoundError,
                      NotebookAccessError=NotebookAccessError)
    gc.drive = mod("google.colab.drive", mount=mount, flush_and_unmount=lambda: calls.append(("drive.flush_and_unmount",)))
    gc.runtime = mod("google.colab.runtime", unassign=lambda: calls.append(("runtime.unassign",)))


# ------------------------------------------------------------------------------------------- one session (subprocess)
def session(tmp, which):
    tmp = pathlib.Path(tmp)
    form, run_cell = code_cells()
    site = tmp / "site"
    sys.path.insert(0, str(site))
    sys.modules["torch"] = make_stubs(site, cuda=(which != "cpu"))
    os.environ["PYTHONPATH"] = str(site)   # the training subprocess (laya-train stub) imports the stubs too
    calls = []
    install_colab_mock(calls)
    from IPython.core.interactiveshell import InteractiveShell
    sh = InteractiveShell.instance()
    pip_calls = []
    sh.register_magic_function(lambda line: pip_calls.append(line), "line", "pip")
    # The form as a user would set it: SMOKE ticked, a fixed run tag (so session 2 continues the same run).
    # Session 3 keeps SMOKE off: the full runs must be refused on a CPU-only runtime.
    form2 = form.replace('SMOKE = False  #@param', f'SMOKE = {which != "cpu"}  #@param').replace(
        'RUN_TAG = ""  #@param', 'RUN_TAG = "smoke-test"  #@param')
    assert form2.count("#@param") == form.count("#@param") and 'RUN_TAG = "smoke-test"' in form2
    r = sh.run_cell(form2, store_history=False)
    assert r.success, r.error_in_exec
    ns = sh.user_ns
    panels = []
    # TEST-ONLY knobs: shorter polling, and a handle on the panel; never set by the notebook itself.
    ns.update(POLL_S=0.2, PUSH_EVERY_S=5, _LRT_TEST_HOOKS={"tick_s": 0.2, "on_dashboard": panels.append})
    r = sh.run_cell(run_cell, store_history=False)
    dash = panels[-1]
    snap = dash.state.snapshot()
    from lrt_runner import text_status   # the module the Run cell loaded (sys.modules["lrt_runner"])
    out = {"which": which, "success": r.success, "error": repr(r.error_in_exec) if r.error_in_exec else None,
           "calls": calls, "pip": pip_calls, "steps": {s["key"]: s["status"] for s in snap["steps"]},
           "errors": snap["errors"], "panel_text": text_status(snap), "panel_html": dash.to_html(),
           "control": snap["control"], "runner_file": sys.modules["lrt_runner"].__file__}
    if which == "cpu":
        print("SESSION " + json.dumps(out, default=str))
        return
    assert r.success, (r.error_in_exec, text_status(snap))
    out.update(run_tag=ns["RUN_TAG"], remote=str(ns["REMOTE_RUN"]), local=str(ns["RUN_DIR"]),
               gpu_profile=ns["GPU_PROFILE"], hf_home=os.environ.get("HF_HOME"), pip_cache=str(ns["PIP_CACHE"]),
               restored=ns["_restored"], rows={k: len(v) for k, v in ns["ROWS"].items()}, validity=ns["VALIDITY"],
               plan=ns["ORCH"].plan, expected_plan=__import__("lrt_runner").expected_plan(ns),
               report=ns["REPORT"], verdict=ns["VERDICT"]["outcome"], finish=ns["FINISH_RESULT"],
               runs={x["run"]: x["status"] for x in snap["runs"]}, overall=snap["overall_pct"],
               results=bool(snap["results"]), smoke=ns["SMOKE"], epochs=ns["EPOCHS"])
    print("SESSION " + json.dumps(out, default=str))


def run_session(tmp, which, work):
    env = dict(os.environ, LRT_CONTENT=str(tmp / "content"), LRT_WORK=str(work), LRT_RUNNER_FILE=str(RUNNER))
    for k in ("GH_TOKEN", "HF_TOKEN", "LRT_SMOKE", "LRT_OUT", "LRT_RAW", "LRT_HUB", "LRT_PANEL", "PYTHONPATH"):
        env.pop(k, None)
    if os.path.exists("/root/.ccr/ca-bundle.crt") and "SSL_CERT_FILE" not in env:
        env["SSL_CERT_FILE"] = "/root/.ccr/ca-bundle.crt"   # the sandbox's HTTPS proxy CA (not needed elsewhere)
    p = subprocess.run([sys.executable, "-I", str(pathlib.Path(__file__).resolve()), "--session", str(tmp), which],
                       capture_output=True, text=True, timeout=1200, env=env)
    assert p.returncode == 0, p.stdout[-6000:] + p.stderr[-6000:]
    line = [l for l in p.stdout.splitlines() if l.startswith("SESSION ")][-1]
    return json.loads(line[len("SESSION "):]), p.stdout


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--session":
        return session(sys.argv[2], sys.argv[3])
    # The committed notebook is exactly what make_notebook.py generates from its pinned refs, and pins this runner.
    import nbformat
    sys.path.insert(0, str(HERE))
    import make_notebook
    nb = nbformat.read(str(NB), 4)
    src = "\n".join(c.source for c in nb.cells if c.cell_type == "code")
    ref = re.search(r'DATA_REF = "([0-9a-f]{40})"', src).group(1)
    man = re.search(r'MANIFEST_SHA256 = "([0-9a-f]{64})"', src).group(1)
    rref = re.search(r'RUNNER_REF = "([0-9a-f]{40})"', src).group(1)
    rsha = re.search(r'RUNNER_SHA256 = "([0-9a-f]{64})"', src).group(1)
    assert ref.startswith(DATASET_COMMIT), ref
    assert rsha == hashlib.sha256(RUNNER.read_bytes()).hexdigest(), \
        "the notebook pins another lrt_runner.py: commit it, then regenerate with make_notebook.py --runner-ref"
    at_ref = make_notebook.git_blob_sha256(rref)
    assert at_ref in (None, rsha), f"RUNNER_REF {rref[:12]} holds another lrt_runner.py"
    gen = make_notebook.build(ref, man, rref, rsha)
    nbformat.validate(gen)
    assert [c.source for c in gen.cells] == [c.source for c in nb.cells], "notebook differs from make_notebook.py output"
    kinds = [c.cell_type for c in nb.cells]
    assert kinds == ["markdown", "code", "code"], kinds
    assert nb.cells[1].source.startswith("#@title Settings") and nb.cells[2].source.startswith("#@title ▶ Run")
    print(f"ok nbformat: {len(nb.cells)} cells valid, equal to make_notebook.py output; Settings + Run; data "
          f"{ref[:7]}, runner {rref[:7]} sha256 {rsha[:12]} = this lrt_runner.py"
          + ("" if at_ref else " (runner ref not checked: git unavailable)"))

    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        s1, log1 = run_session(tmp, "first", tmp / "vm1")
        assert s1["success"] and s1["smoke"] and s1["epochs"] == 1, s1["error"]
        assert s1["runner_file"].endswith(f"lrt_runner-{hashlib.sha256(RUNNER.read_bytes()).hexdigest()[:16]}.py")
        assert ("drive.mount", str(tmp / "content" / "drive"), True) in [tuple(c) for c in s1["calls"]], s1["calls"]
        assert ("userdata.get", "GH_TOKEN") in [tuple(c) for c in s1["calls"]]
        assert s1["remote"].startswith(str(tmp / "content" / "drive" / "MyDrive" / "laya-release-triage"))
        assert s1["local"].startswith(str(tmp / "vm1")), "work happens on the local disk"
        assert s1["hf_home"] == str(tmp / "content/drive/MyDrive/laya-release-triage/cache/hf")
        assert len(s1["pip"]) == 1 and f'--cache-dir "{s1["pip_cache"]}"' in s1["pip"][0] and "laya==0.4.1" in s1["pip"][0], s1["pip"]
        gp = s1["gpu_profile"]
        assert gp["torch"] == STUB_PINS["torch"] and gp["torch_cuda"] == "12.6" and "high_ram" in gp
        assert s1["validity"]["leakage_check"] == "PASS" and s1["rows"] == {"train": 16, "calib": 16, "test": 16}, s1["rows"]
        assert s1["plan"] == PLAN == s1["expected_plan"], "the panel's plan before training = the Training stage's plan"
        assert [r["status"] for r in s1["report"]] == ["done"] * 10, s1["report"]
        assert s1["runs"] == {r: "done" for r in PLAN} and set(s1["steps"].values()) == {"done"}, s1["steps"]
        assert s1["overall"] == 100.0 and s1["results"] and not s1["errors"], s1["errors"]
        assert s1["verdict"].startswith(("INCONCLUSIVE", "NOT ADOPTED", "FAIL", "PASS")), s1["verdict"]
        assert s1["control"] == ["off", "off (needs the GH_TOKEN secret and PUSH_PROGRESS on)"], s1["control"]
        f = s1["finish"]
        assert f["released"] and not f["problems"] and f["verified"] >= 20, f
        names = [c[0] for c in s1["calls"]]
        assert names.index("drive.flush_and_unmount") < names.index("runtime.unassign") and names.count("runtime.unassign") == 1
        remote, local = pathlib.Path(s1["remote"]), pathlib.Path(s1["local"])
        for rel in ("results.zip", "state.json", "results/verdict.json", "results/summary.md", "results/progress.jsonl",
                    "results/logs/console.log", "results/metrics_F-EN-s0.json", "checkpoints/F-EN-s0/model.safetensors"):
            assert hashlib.sha256((remote / rel).read_bytes()).hexdigest() == hashlib.sha256((local / rel).read_bytes()).hexdigest(), rel
        assert not (remote / "checkpoints" / "PC-EN").exists(), "positive controls' checkpoints deleted once scored"
        assert not [p for p in remote.rglob("*") if p.name.startswith(".") or ".tmp" in p.name]
        assert "FAKE TRAINER (test only)" in (local / "results/logs/train_F-EN-s0.log").read_text()
        con = (local / "results/logs/console.log").read_text()
        assert "remote control: off" in con and "VERDICT:" in con and "run order:" in con
        assert "What's happening now" in s1["panel_html"] and "Remote control</b>" in s1["panel_html"]
        print(f"ok session 1: Settings + Run cell, runner verified by sha256; Drive mounted, work on local disk, %pip "
              f"pinned with cache on Drive, real dataset {s1['rows']} verified, 10 runs (stub laya + fake trainer) done, "
              f"verdict '{s1['verdict'][:40]}', finish synced+verified {f['verified']} files, flush_and_unmount then "
              "unassign; panel at 100 % with every step done; remote control off without GH_TOKEN")

        s2, _ = run_session(tmp, "second", tmp / "vm2")
        assert s2["success"] and s2["run_tag"] == s1["run_tag"] == "smoke-test", "same run continued"
        assert "state.json" in s2["restored"] and "results/progress.jsonl" in s2["restored"], s2["restored"]
        ev = [json.loads(l) for l in (tmp / "vm2" / "out" / "smoke-test" / "results" / "progress.jsonl").read_text().splitlines()]
        assert len([e for e in ev if e["event"] == "session_start"]) == 2
        assert sorted(e["run_id"] for e in ev if e["event"] == "run_skipped_done") == sorted(PLAN)
        tries = list((tmp / "vm2" / "runs").glob("*.tries")) if (tmp / "vm2" / "runs").exists() else []
        assert not tries, "nothing was trained again"
        assert s2["verdict"] == s1["verdict"] and s2["finish"]["released"]
        print(f"ok session 2 (new VM, same Drive): run tag kept, {len(s2['restored'])} files restored, all 10 runs "
              "verified by sha256 and skipped, same verdict")

        s3, _ = run_session(tmp, "cpu", tmp / "vm3")
        assert not s3["success"] and "refused on CPU" in s3["error"], s3["error"]
        assert s3["steps"]["gpu"] == "failed" and s3["errors"] and "GPU step failed" in s3["errors"][0]["what"]
        print("ok session 3: CPU-only runtime refused at the GPU step; the panel shows the failed step and the error")
    print(f"OK: notebook smoke run (Settings + Run cells, google.colab mocked, TEST-ONLY laya/transformers/hub stubs, "
          f"fake trainer, real dataset at {DATASET_COMMIT})")


if __name__ == "__main__":
    main()
