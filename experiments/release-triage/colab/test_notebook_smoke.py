"""Smoke run of the committed notebook's non-GPU cells on CPU, with google.colab mocked. No GPU, no Laya training.

Runs colab/laya_release_triage.ipynb in a real IPython shell (so %pip, display_id updates and the post-run hook
behave as in Colab), with:
  * google.colab.userdata / drive / runtime replaced by in-memory mocks (Drive = a temp folder; no real secret);
  * torch replaced by a TEST-ONLY stub that reports a fake A100, and the pinned packages by TEST-ONLY dist-info
    stubs (only their version numbers are read by the cells under test); %pip is recorded, not run;
  * the dataset fetched for real from raw.githubusercontent.com at the pinned commit (DATA_REF in the notebook)
    and checked against MANIFEST_SHA256.
Cells run: Settings form, pinned inputs, secrets/progress, plumbing, GPU/RAM, storage (Drive mount, caches,
restore), install, dataset, validity, then the Finish cell (final sync, verification, flush_and_unmount, unassign).
A second session on a fresh "VM" (empty local disk, same "Drive") checks the restore; a third checks the CPU refusal.
Also: the notebook is valid nbformat and equals what make_notebook.py generates.

Needs: nbformat, ipython, numpy, pandas, scikit-learn, psutil and network access to raw.githubusercontent.com.
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
STUB_PINS = {"laya": "0.4.1", "transformers": "4.57.1", "huggingface_hub": "0.36.2", "tokenizers": "0.22.2",
             "safetensors": "0.8.0", "scikit-learn": "1.7.2", "onnx": "1.22.0", "onnxruntime": "1.29.0",
             "onnxscript": "0.7.1", "torch": "2.8.0+cu126"}


def code_cells():
    import nbformat
    nb = nbformat.read(str(NB), 4)
    nbformat.validate(nb)
    return [c.source for c in nb.cells if c.cell_type == "code"]


def pick(cells):
    def by(marker):
        found = [c for c in cells if marker in c]
        assert len(found) == 1, (marker, len(found))
        return found[0]
    return {"form": cells[0], "config": by("# Pinned inputs (fixed by PREREGISTRATION.md"),
            "progress": by("class GitHubPusher"), "runner": by("class DriveSync"),
            "gpu": by('PROGRESS.begin("gpu")'), "drive": by('PROGRESS.begin("drive")'),
            "install": by('PROGRESS.begin("install")'), "data": by('PROGRESS.begin("data")'),
            "validity": by('PROGRESS.begin("validity")'), "finish": by('PROGRESS.begin("finish")')}


# ------------------------------------------------------------------------------------------- one session (subprocess)
def make_stubs(site, cuda=True):
    """TEST-ONLY: dist-info version stubs, a stub laya.train (source text only) and a stub torch."""
    site.mkdir(parents=True, exist_ok=True)
    for name, ver in STUB_PINS.items():
        d = site / f"{name.replace('-', '_')}-{ver}.dist-info"
        d.mkdir(exist_ok=True)
        (d / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: {ver}\n")
    (site / "laya").mkdir(exist_ok=True)
    (site / "laya" / "__init__.py").write_text("# TEST-ONLY stub\n")
    (site / "laya" / "train.py").write_text(
        "# TEST-ONLY stub: the install cell only reads this source text\n"
        "def _forward(x):\n    return 'autocast(dtype=torch.float16)'\n"
        "def train_model(x):\n    return 'GradScaler'\n")
    t = types.ModuleType("torch")
    t.__version__ = STUB_PINS["torch"]
    t.Tensor = type("Tensor", (), {})   # other libraries probe sys.modules["torch"].Tensor
    props = types.SimpleNamespace(name="NVIDIA A100-SXM4-40GB (TEST-ONLY stub)", total_memory=40e9, major=8, minor=0)
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda, get_device_properties=lambda i: props,
                                   is_bf16_supported=lambda: True, empty_cache=lambda: None)
    t.version = types.SimpleNamespace(cuda="12.6")
    t.backends = types.SimpleNamespace(cudnn=types.SimpleNamespace(version=lambda: 91002))
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


def session(tmp, which):
    tmp = pathlib.Path(tmp)
    cells = pick(code_cells())
    sys.path.insert(0, str(tmp / "site"))
    sys.modules["torch"] = make_stubs(tmp / "site", cuda=(which != "cpu"))
    calls = []
    install_colab_mock(calls)
    from IPython.core.interactiveshell import InteractiveShell
    sh = InteractiveShell.instance()
    pip_calls = []
    sh.register_magic_function(lambda line: pip_calls.append(line), "line", "pip")

    def run(name):
        r = sh.run_cell(cells[name], store_history=False)
        return r

    for name in ("form", "config", "progress", "runner"):
        assert run(name).success, name
    ns = sh.user_ns
    assert ns["IN_COLAB"] and not ns["SMOKE"] and ns["AUTO_RELEASE_RUNTIME"] and ns["PUSH_PROGRESS"]
    assert ns["PROGRESS"].pusher is None and ("userdata.get", "GH_TOKEN") in calls
    if which == "cpu":
        r = run("gpu")
        assert isinstance(r.error_in_exec, SystemExit) and "refused on CPU" in str(r.error_in_exec), r.error_in_exec
        print("SESSION " + json.dumps({"cpu_refused": True}))
        return
    for name in ("gpu", "drive", "install", "data", "validity"):
        r = run(name)
        assert r.success, (name, r.error_in_exec)
    out = {"calls": calls, "pip": pip_calls, "run_tag": ns["RUN_TAG"], "remote": str(ns["REMOTE_RUN"]),
           "local": str(ns["RUN_DIR"]), "gpu_profile": ns["GPU_PROFILE"], "hf_home": os.environ.get("HF_HOME"),
           "pip_cache": str(ns["PIP_CACHE"]), "restored": ns["_restored"], "rows": {k: len(v) for k, v in ns["ROWS"].items()},
           "validity": ns["VALIDITY"]}
    if which == "first":
        import shutil
        ns["FAILED_RUNS"] = []
        shutil.make_archive(str(ns["OUT"] / "results"), "zip", ns["RESULTS"])
        r = run("finish")
        assert r.success, r.error_in_exec
        out["finish"] = ns["FINISH_RESULT"]
        out["calls"] = calls
    print("SESSION " + json.dumps(out, default=str))


def run_session(tmp, which, work):
    env = dict(os.environ, LRT_CONTENT=str(tmp / "content"), LRT_WORK=str(work))
    for k in ("GH_TOKEN", "HF_TOKEN", "LRT_SMOKE", "LRT_OUT", "LRT_RAW", "LRT_HUB"):
        env.pop(k, None)
    if os.path.exists("/root/.ccr/ca-bundle.crt") and "SSL_CERT_FILE" not in env:
        env["SSL_CERT_FILE"] = "/root/.ccr/ca-bundle.crt"   # the sandbox's HTTPS proxy CA (not needed elsewhere)
    p = subprocess.run([sys.executable, "-I", str(pathlib.Path(__file__).resolve()), "--session", str(tmp), which],
                       capture_output=True, text=True, timeout=900, env=env)
    assert p.returncode == 0, p.stdout[-4000:] + p.stderr[-4000:]
    line = [l for l in p.stdout.splitlines() if l.startswith("SESSION ")][-1]
    return json.loads(line[len("SESSION "):]), p.stdout


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--session":
        return session(sys.argv[2], sys.argv[3])
    # The committed notebook is exactly what make_notebook.py generates from its pinned refs.
    import nbformat
    sys.path.insert(0, str(HERE))
    import make_notebook
    nb = nbformat.read(str(NB), 4)
    src = "\n".join(c.source for c in nb.cells if c.cell_type == "code")
    ref = re.search(r'DATA_REF = "([0-9a-f]{40})"', src).group(1)
    man = re.search(r'MANIFEST_SHA256 = "([0-9a-f]{64})"', src).group(1)
    gen = make_notebook.build(ref, man)
    nbformat.validate(gen)
    assert [c.source for c in gen.cells] == [c.source for c in nb.cells], "notebook differs from make_notebook.py output"
    assert nb.cells[1].cell_type == "code" and nb.cells[1].source.startswith("#@title Settings")
    print(f"ok nbformat: {len(nb.cells)} cells valid, equal to make_notebook.py output; Settings form first (data {ref[:7]})")

    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        s1, log1 = run_session(tmp, "first", tmp / "vm1")
        assert ("drive.mount", str(tmp / "content" / "drive"), True) in [tuple(c) for c in s1["calls"]], s1["calls"]
        assert s1["remote"].startswith(str(tmp / "content" / "drive" / "MyDrive" / "laya-release-triage"))
        assert s1["local"].startswith(str(tmp / "vm1")), "work happens on the local disk"
        assert s1["hf_home"] == str(tmp / "content/drive/MyDrive/laya-release-triage/cache/hf")
        assert len(s1["pip"]) == 1 and f'--cache-dir "{s1["pip_cache"]}"' in s1["pip"][0] and "laya==0.4.1" in s1["pip"][0], s1["pip"]
        gp = s1["gpu_profile"]
        assert gp["torch"] == STUB_PINS["torch"] and gp["torch_cuda"] == "12.6" and gp["ram_gb"] > 0 and "high_ram" in gp
        assert s1["validity"]["leakage_check"] == "PASS" and s1["rows"]["test"] > 1000, s1["rows"]
        assert "Pro+ background execution lets you close the tab" in log1
        f = s1["finish"]
        assert f["released"] and not f["problems"] and f["verified"] >= 3, f
        names = [c[0] for c in s1["calls"]]
        assert names.index("drive.flush_and_unmount") < names.index("runtime.unassign") and names.count("runtime.unassign") == 1
        remote = pathlib.Path(s1["remote"])
        local = pathlib.Path(s1["local"])
        for rel in ("results.zip", "results/validity.json", "results/progress.jsonl", "state.json" if (local / "state.json").exists() else "results.zip"):
            assert hashlib.sha256((remote / rel).read_bytes()).hexdigest() == hashlib.sha256((local / rel).read_bytes()).hexdigest(), rel
        assert not [p for p in remote.rglob("*") if p.name.startswith(".") or ".tmp" in p.name]
        print(f"ok session 1: Drive mounted (force_remount), work on local disk, HF_HOME + pip cache on Drive, %pip pinned, "
              f"dataset {s1['rows']} verified from GitHub, validity PASS, finish synced+verified {f['verified']} files, "
              "flush_and_unmount then unassign")

        s2, _ = run_session(tmp, "second", tmp / "vm2")
        assert s2["run_tag"] == s1["run_tag"], "same run continued"
        assert "results/validity.json" in s2["restored"] and "results/progress.jsonl" in s2["restored"], s2["restored"]
        ev = [json.loads(l) for l in (tmp / "vm2" / "out" / s2["run_tag"] / "results" / "progress.jsonl").read_text().splitlines()]
        assert len([e for e in ev if e["event"] == "session_start"]) == 2
        print(f"ok session 2 (new VM, empty local disk): run tag kept, {len(s2['restored'])} files restored from Drive")

        s3, _ = run_session(tmp, "cpu", tmp / "vm3")
        assert s3["cpu_refused"]
        print("ok session 3: CPU-only runtime refused")
    print("OK: notebook smoke run (non-GPU cells, google.colab mocked, real dataset at the pinned commit)")


if __name__ == "__main__":
    main()
