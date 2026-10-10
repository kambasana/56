"""CPU test of the notebook's resume / retry plumbing (stage RUNNER_CELL of colab/lrt_runner.py). No GPU, no Laya.

TEST ONLY: training is a tiny fake command (`--fake-trainer-TEST-ONLY` mode of this file) that prints laya-train's
log lines, writes a fake checkpoint and can simulate CUDA OOM, a network error, any other error or a hang. The
notebook's kernel is simulated by `--driver` mode, which runs the cell's Orchestrator in its own process so the test
can kill it (a dropped kernel) and/or kill the training process group (a lost VM) and then run it again.

Checks:
  * OOM mapping: half micro-batch, double accumulation, same effective batch and optimizer-update count;
    error classification;
  * disconnect (VM lost): orchestrator and training process both killed mid-run; on re-run the finished run is
    skipped (files verified, not touched), the interrupted run restarts from scratch (laya 0.4.1 cannot resume)
    without using an attempt, and the remaining runs complete;
  * kernel restart only: the detached training process survives and is re-attached (same pid, one attempt);
  * retries: OOM -> 8x8, 4x16, 2x32; OOM at every size -> failed after 3 attempts, next run continues; other error
    -> failed at once with its traceback, next run continues; network error -> backoff then success; a stalled
    process -> killed by the watchdog and retried;
  * a "done" run whose result file changed is redone; heartbeat lines and heartbeat.json are written;
  * local disk -> Drive (Drive simulated by a temp dir): atomic copies (a failed copy leaves the old file and no
    temporary file), small sync on heartbeats vs. full sync after stages/runs, deletions, restore on a new VM and
    the whole disconnect scenario with the local disk wiped (ledger, results, logs, job files restored from "Drive");
  * finish(): runtime.unassign (mocked) only after a final sync, sha256 verification of everything on "Drive"
    including results.zip, a successful GitHub push and drive.flush_and_unmount; never after a failed sync, a
    corrupt file on Drive, a failed push or unmount, or with AUTO_RELEASE_RUNTIME off;
  * the Settings form: one top cell of #@param lines with the documented defaults; secrets are not passed to the
    training process.

Run: python -I colab/test_resume.py
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
SELF = pathlib.Path(__file__).resolve()


def cell(name: str) -> str:
    """A stage source from colab/lrt_runner.py (the Settings form and the Run cell: colab/make_notebook.py)."""
    for f in ("lrt_runner.py", "make_notebook.py"):
        tree = ast.parse((HERE / f).read_text())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
                return ast.literal_eval(node.value)
    raise SystemExit(f"{name} not found in lrt_runner.py or make_notebook.py")


def load_cells(extra=None):
    os.environ.pop("GH_TOKEN", None)   # never pick up a real token in a test
    import hashlib, urllib.request   # what the notebook's Settings cell imports before these cells
    ns = {"REPO": "kambasana/56", "SUBDIR": "experiments/release-triage", "SMOKE": True, "__name__": "cells",
          "time": time, "json": json, "hashlib": hashlib, "pathlib": pathlib, "urllib": urllib}
    ns.update(extra or {})
    exec(compile(cell("PROGRESS_CELL"), "progress_cell", "exec"), ns)
    exec(compile(cell("RUNNER_CELL"), "runner_cell", "exec"), ns)
    return ns


# ------------------------------------------------------------------------------------------- fake trainer (TEST ONLY)
def fake_trainer_TEST_ONLY(argv):
    import argparse
    import hashlib
    ap = argparse.ArgumentParser()
    for a in ("--out", "--fail", "--state"):
        ap.add_argument(a, default="")
    for a in ("--epochs", "--micro", "--accum", "--n", "--oom-above"):
        ap.add_argument(a, type=int, default=0)
    ap.add_argument("--step-s", type=float, default=0.05)
    a = ap.parse_args(argv)
    out = pathlib.Path(a.out)
    fresh = not out.exists()
    out.mkdir(parents=True, exist_ok=True)
    st = pathlib.Path(a.state)
    n_try = int(st.read_text()) + 1 if st.exists() else 1
    st.write_text(str(n_try))
    print(f"FAKE TRAINER (test only) start fresh_out_dir={fresh} try={n_try}", flush=True)
    print(f"train items {a.n}, calibration items 0, eval items 0, skipped {{}}, device cpu", flush=True)
    if a.fail == "other":
        raise ValueError("fake failure for the test")
    if a.fail == "network" and n_try == 1:
        print("requests.exceptions.ConnectionError: Max retries exceeded with url: /fake (test)", flush=True)
        sys.exit(1)
    if a.micro > a.oom_above:
        print("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB (fake, test only)", flush=True)
        sys.exit(1)
    spe = math.ceil(a.n / a.micro)
    for e in range(1, a.epochs + 1):
        for s in range(1, spe + 1):
            time.sleep(a.step_s)
            if s % 2 == 0:
                print(f"epoch {e}/{a.epochs} step {s} loss {1.0 / (e + s):.4f}", flush=True)
        print(f"epoch {e}/{a.epochs} mean loss {1.0 / e:.4f}", flush=True)
        (out / "checkpoint_latest").mkdir(exist_ok=True)
        (out / "checkpoint_latest" / "model.safetensors").write_bytes(b"epoch%d" % e)
        if a.fail == "hang-first" and n_try == 1:
            time.sleep(3600)   # no output, no CPU: the watchdog must kill this
    w = hashlib.sha256(f"{a.out}|{a.micro}x{a.accum}".encode()).digest() * 64
    (out / "model.safetensors").write_bytes(w)
    (out / "train_report.json").write_text(json.dumps({"fake": True, "micro": a.micro, "accum": a.accum}))
    print("FAKE TRAINER done", flush=True)


# ------------------------------------------------------------------------------------------- driver (simulated kernel)
def driver(run_dir, plan_path):
    import shutil
    plan = json.loads(pathlib.Path(plan_path).read_text())
    ns = load_cells()
    ns["PUSH_EVERY_S"] = plan.get("heartbeat_s", 0.5)   # the timer reads this global on every loop
    run_dir = pathlib.Path(run_dir)
    res = run_dir / "results"
    sync = None
    if plan.get("remote"):   # Drive mode: run_dir is the VM's local disk, plan["remote"] stands in for Drive
        sync = ns["DriveSync"](run_dir, plan["remote"])
        restored = sync.restore()
        ns["SYNC"] = sync
        print("RESTORED " + json.dumps(restored), flush=True)
    (res / "logs").mkdir(parents=True, exist_ok=True)
    P = ns["Progress"](None)
    ns["PROGRESS"] = P
    P.bind(res, "test-run")
    P.ctx["gpu"] = "fake-cpu"
    P.log("session_start", pid=os.getpid())
    L = ns["Ledger"](run_dir / "state.json", run_dir, {"test": 1})
    slept = []
    O = ns["Orchestrator"](run_dir, L, P, poll_s=0.1, stall_s=plan.get("stall_s", 60), backoff_s=0.01,
                           sleep=lambda s: (slept.append(s), time.sleep(min(s, 0.1))), quiet=True, gpu="fake-cpu",
                           sync=sync)
    ns["ORCH"] = O
    ns["RUN_DIR"] = run_dir
    P.heartbeat = ns["heartbeat"]
    P.start_timer()
    work = run_dir.parent / "work"
    n_items, epochs = plan.get("n", 40), plan.get("epochs", 4)

    def batch_for(rid):
        m, a = 8, 8
        for _ in range(L.get(rid)["oom_halvings"]):
            m, a = ns["oom_fallback"](m, a, n_items, epochs)
        return m, a

    def on_oom(orch, rid):
        m, a = batch_for(rid)
        nxt = ns["oom_fallback"](m, a, n_items, epochs)
        if nxt is None:
            return None
        L.update(rid, oom_halvings=L.get(rid)["oom_halvings"] + 1)
        return {"micro_batch": [m, nxt[0]], "grad_accum": [a, nxt[1]], "effective_batch": nxt[0] * nxt[1],
                "optimizer_updates": ns["optimizer_updates"](n_items, nxt[0], nxt[1], epochs)}

    def train_stage(rid, opts):
        def fn(orch, rid):
            m, a = batch_for(rid)
            out = work / "runs" / rid
            log = res / "logs" / f"train_{rid}.log"
            cmd = [sys.executable, "-I", str(SELF), "--fake-trainer-TEST-ONLY", "--out", str(out), "--epochs", str(epochs),
                   "--micro", str(m), "--accum", str(a), "--n", str(n_items), "--oom-above", str(opts.get("oom_above", 64)),
                   "--fail", opts.get("fail", ""), "--state", str(work / f"{rid}.tries"), "--step-s", str(plan.get("step_s", 0.05))]
            rc, tail, info = orch.run_job(rid, cmd, log, marker=f"{rid}|{out}|{m}x{a}",
                                          prepare=lambda: shutil.rmtree(out, ignore_errors=True),
                                          on_line=lambda l: ns["train_progress"](rid, l), micro=m, accum=a)
            if rc != 0:
                raise ns["RunError"](ns["classify_error"](tail), f"{rid}: fake trainer exited {rc}", tail)
            (res / f"train_{rid}.json").write_text(json.dumps({"micro": m, "accum": a, "pid": info["pid"]}))
            dst = run_dir / "checkpoints" / rid
            shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(out, dst, ignore=shutil.ignore_patterns("checkpoint_latest"))
            return {"files": [res / f"train_{rid}.json", log], "checkpoint": dst, "info": {"micro_batch": m, "grad_accum": a}}
        return ns["Stage"]("train", fn, on_oom=on_oom)

    def score_stage():
        def fn(orch, rid):
            p = res / f"metrics_{rid}.json"
            p.write_text(json.dumps({"model_sha256": ns["sha256_file"](run_dir / "checkpoints" / rid / "model.safetensors")}))
            return {"files": [p]}
        return ns["Stage"]("score", fn)

    specs = [ns["RunSpec"](r["id"], [train_stage(r["id"], r), score_stage()]) for r in plan["runs"]]
    report = O.run_all(specs)
    O.heartbeat()
    P.stop_timer()
    if sync is not None:
        assert not sync.sync(full=True)["errors"]
    print("REPORT " + json.dumps({"report": report, "slept": slept}), flush=True)


# ------------------------------------------------------------------------------------------- test helpers
def run_driver(run_dir, plan, wait=True):
    pathlib.Path(run_dir).mkdir(parents=True, exist_ok=True)
    pf = pathlib.Path(run_dir).parent / "plan.json"
    pf.write_text(json.dumps(plan))
    cmd = [sys.executable, "-I", str(SELF), "--driver", str(run_dir), str(pf)]
    if wait:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        assert p.returncode == 0, p.stdout[-3000:] + p.stderr[-3000:]
        line = [l for l in p.stdout.splitlines() if l.startswith("REPORT ")][-1]
        return json.loads(line[len("REPORT "):])
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def ledger(run_dir):
    p = pathlib.Path(run_dir) / "state.json"
    return json.loads(p.read_text()) if p.exists() else {"runs": {}}


def events(run_dir):
    p = pathlib.Path(run_dir) / "results" / "progress.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def wait_until(cond, timeout=60, what=""):
    t = time.time()
    while time.time() - t < timeout:
        if cond():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for " + what)


def alive(pid):
    try:
        st = pathlib.Path(f"/proc/{pid}/stat").read_text()
        return st[st.rindex(")") + 2] not in "ZX"
    except OSError:
        return False


# ------------------------------------------------------------------------------------------- tests
def test_mapping():
    ns = load_cells()
    fb, upd = ns["oom_fallback"], ns["optimizer_updates"]
    n, E = 6468, 6   # the v2.1 dataset: 6,468 items trained on, E = 6 (PREREGISTRATION.md)
    assert upd(n, 8, 8, 1) == upd(n, 4, 16, 1) == 102, "both pre-registered mappings give U = 102"
    chain, m, a = [(8, 8)], 8, 8
    while (nxt := fb(m, a, n, E)) is not None:
        chain.append(nxt)
        m, a = nxt
    assert chain == [(8, 8), (4, 16), (2, 32), (1, 64)], chain
    assert all(x * y == 64 and upd(n, x, y, E) == 612 for x, y in chain)
    assert fb(3, 8, n, E) is None and fb(1, 64, n, E) is None
    for nn in range(1, 300):   # the update count never changes under halving (nested-ceiling identity)
        for mm, aa in ((8, 8), (4, 16), (2, 32)):
            assert fb(mm, aa, nn, 3) is not None
    ce = ns["classify_error"]
    assert ce("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate") == "oom"
    assert ce("RuntimeError: CUDA error: out of memory") == "oom"
    assert ce("huggingface_hub.errors.HfHubHTTPError: 503 Server Error") == "network"
    assert ce("urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>") == "network"
    assert ce("ValueError: something else") == "other"
    print("ok mapping: 8x8 -> 4x16 -> 2x32 -> 1x64, effective batch 64, 612 updates each; error classes")


def test_disconnect(tmp):
    run_dir = tmp / "disc" / "run"
    plan = {"runs": [{"id": "A"}, {"id": "B"}, {"id": "C"}], "epochs": 4, "n": 40, "step_s": 0.08}
    drv = run_driver(run_dir, plan, wait=False)
    log_b = run_dir / "results" / "logs" / "train_B.log"
    wait_until(lambda: ledger(run_dir)["runs"].get("A", {}).get("status") == "done"
               and log_b.exists() and "epoch 2/4" in log_b.read_text(), what="A done and B in epoch 2")
    job = json.loads((run_dir / "jobs" / "B.job.json").read_text())
    a_files = {p: (p.stat().st_mtime_ns, p.read_bytes()) for p in (run_dir / "results").glob("*_A.json")}
    # Lose the VM: the kernel and the training process group both die, no exit code is written.
    os.killpg(drv.pid, signal.SIGKILL)
    os.killpg(job["pgid"], signal.SIGKILL)
    drv.wait()
    wait_until(lambda: not alive(job["pid"]), what="B's process gone")
    assert ledger(run_dir)["runs"]["B"]["status"] == "running"
    out = run_driver(run_dir, plan)
    L = ledger(run_dir)["runs"]
    assert [r["status"] for r in out["report"]] == ["done"] * 3, out
    assert L["A"]["attempts"] == 1 and L["A"]["interruptions"] == 0
    for p, (mt, b) in a_files.items():
        assert p.stat().st_mtime_ns == mt and p.read_bytes() == b, f"{p.name} was rewritten"
    ev = events(run_dir)
    assert any(e["event"] == "run_skipped_done" and e.get("run_id") == "A" for e in ev)
    assert L["B"]["attempts"] == 1 and L["B"]["interruptions"] == 1, L["B"]
    assert any(e["event"] == "run_interrupted" and e.get("run_id") == "B" for e in ev)
    text = log_b.read_text()
    second = text.split("===== B attempt 1 start")
    assert len(second) == 3, "B ran twice in the same attempt (restarted, not counted as a failure)"
    assert "fresh_out_dir=True" in second[2] and second[2].index("epoch 1/4") < second[2].index("epoch 2/4"), \
        "B restarted from scratch (laya 0.4.1 cannot resume from checkpoint_latest)"
    assert L["C"]["status"] == "done"
    assert not list((run_dir / "jobs").glob("*.job.json")), "job files cleared"
    hb = [e for e in ev if e["event"] == "heartbeat"]
    assert hb and any(h.get("run_id") for h in hb) and any("min_since_log_line" in h for h in hb), hb[:2]
    assert json.loads((run_dir / "heartbeat.json").read_text())["runs"] == {"done": 3}
    print("ok disconnect: A skipped (verified, untouched), B restarted from scratch without using an attempt, C done; heartbeats written")


def test_kernel_restart(tmp):
    run_dir = tmp / "kern" / "run"
    plan = {"runs": [{"id": "A"}, {"id": "B"}], "epochs": 4, "n": 40, "step_s": 0.08}
    drv = run_driver(run_dir, plan, wait=False)
    log_b = run_dir / "results" / "logs" / "train_B.log"
    wait_until(lambda: log_b.exists() and "epoch 1/4 step 2" in log_b.read_text(), what="B training")
    job = json.loads((run_dir / "jobs" / "B.job.json").read_text())
    os.killpg(drv.pid, signal.SIGKILL)   # only the kernel dies; the detached job keeps running
    drv.wait()
    time.sleep(0.3)
    assert alive(job["pid"]), "the detached training process survived the kernel"
    run_driver(run_dir, plan)
    L = ledger(run_dir)["runs"]
    assert L["B"]["status"] == "done" and L["B"]["attempts"] == 1 and L["B"]["interruptions"] == 0
    assert log_b.read_text().count("===== B attempt") == 1, "not relaunched"
    assert json.loads((run_dir / "results" / "train_B.json").read_text())["pid"] == job["pid"]
    assert any(e["event"] == "job_adopted" and e.get("run_id") == "B" for e in events(run_dir))
    print("ok kernel restart: the running job was re-attached (same pid, one attempt)")


def test_retries(tmp):
    run_dir = tmp / "retry" / "run"
    plan = {"runs": [{"id": "OOM2", "oom_above": 2}, {"id": "OOMALL", "oom_above": 0}, {"id": "OTHER", "fail": "other"},
                     {"id": "NET", "fail": "network"}, {"id": "STALL", "fail": "hang-first"}, {"id": "OK"}],
            "epochs": 2, "n": 16, "step_s": 0.02, "stall_s": 2}
    out = run_driver(run_dir, plan)
    st = {r["run"]: r for r in out["report"]}
    L = ledger(run_dir)["runs"]
    ev = events(run_dir)
    # OOM: 8x8 -> 4x16 -> 2x32 succeeds on the third attempt with the same effective batch.
    assert st["OOM2"]["status"] == "done" and L["OOM2"]["attempts"] == 3 and L["OOM2"]["oom_halvings"] == 2
    assert json.loads((run_dir / "results" / "train_OOM2.json").read_text()) == {"micro": 2, "accum": 32, "pid":
           json.loads((run_dir / "results" / "train_OOM2.json").read_text())["pid"]}
    oom = [e for e in ev if e["event"] == "oom_retry" and e["run_id"] == "OOM2"]
    assert [e["change"]["micro_batch"] for e in oom] == [[8, 4], [4, 2]] and all(e["change"]["effective_batch"] == 64 for e in oom)
    # OOM at every size: failed after 3 attempts; the next runs still ran.
    assert st["OOMALL"]["status"] == "failed" and L["OOMALL"]["attempts"] == 3
    assert [e["kind"] for e in L["OOMALL"]["errors"]] == ["oom"] * 3
    # Other error: failed at once, traceback and log tail recorded in the ledger and progress.jsonl.
    assert st["OTHER"]["status"] == "failed" and L["OTHER"]["attempts"] == 1
    err = L["OTHER"]["errors"][0]
    assert err["kind"] == "other" and "Traceback" in err["traceback"] and "fake failure for the test" in err["traceback"]
    assert any(e["event"] == "run_error" and e["run_id"] == "OTHER" and "Traceback" in e["traceback"] for e in ev)
    # Network: exponential backoff, then success.
    assert st["NET"]["status"] == "done" and L["NET"]["attempts"] == 2 and L["NET"]["errors"][0]["kind"] == "network"
    assert any(e["event"] == "backoff" and e["run_id"] == "NET" for e in ev) and 0.01 in out["slept"]
    # Stall: watchdog kill, retry.
    assert st["STALL"]["status"] == "done" and L["STALL"]["attempts"] == 2 and L["STALL"]["errors"][0]["kind"] == "stalled"
    assert st["OK"]["status"] == "done" and L["OK"]["attempts"] == 1
    # Re-run: done runs are skipped, failed runs are not retried (RETRY_FAILED off), a changed result is redone.
    m = run_dir / "results" / "metrics_OK.json"
    m.write_text('{"tampered": true}')
    out2 = run_driver(run_dir, plan)
    L2 = ledger(run_dir)["runs"]
    assert {r["run"]: r["status"] for r in out2["report"]} == {r["run"]: r["status"] for r in out["report"]}
    assert L2["OOM2"]["attempts"] == 3 and L2["OTHER"]["attempts"] == 1, "nothing finished or failed was redone"
    assert "tampered" not in m.read_text() and L2["OK"]["attempts"] == 1
    assert any(e["event"] == "run_verify_failed" and e["run_id"] == "OK" for e in events(run_dir))
    print("ok retries: OOM 8x8->4x16->2x32; OOM at every size fails after 3; other error fails once with traceback; "
          "network backs off; stall killed and retried; changed result redone; failed runs not retried")


def test_drive_resume(tmp):
    """Disconnect with the local disk wiped (a new Colab VM): everything comes back from the simulated Drive."""
    import shutil
    vm, drive = tmp / "dr" / "vm" / "run", tmp / "dr" / "drive" / "run"
    plan = {"runs": [{"id": "A"}, {"id": "B"}, {"id": "C"}], "epochs": 4, "n": 40, "step_s": 0.08,
            "remote": str(drive), "heartbeat_s": 0.3}
    drv = run_driver(vm, plan, wait=False)
    log_b = vm / "results" / "logs" / "train_B.log"
    wait_until(lambda: ledger(drive)["runs"].get("A", {}).get("status") == "done"
               and (drive / "jobs" / "B.job.json").exists() and log_b.exists() and "epoch 2/4" in log_b.read_text()
               and (drive / "results" / "logs" / "train_B.log").exists(), what="A done on Drive and B training")
    job = json.loads((vm / "jobs" / "B.job.json").read_text())
    a_remote = {p: p.read_bytes() for p in (drive / "results").glob("*_A.json")}
    assert a_remote and (drive / "checkpoints" / "A" / "model.safetensors").exists(), "A's results and weights on Drive"
    assert not (drive / "checkpoints" / "B").exists(), "B's checkpoint is not on Drive before its stage finished"
    os.killpg(drv.pid, signal.SIGKILL)
    os.killpg(job["pgid"], signal.SIGKILL)
    drv.wait()
    wait_until(lambda: not alive(job["pid"]), what="B's process gone")
    shutil.rmtree(vm.parent)   # the VM and its local disk are gone
    out = run_driver(vm, plan)
    L = ledger(vm)["runs"]
    assert [r["status"] for r in out["report"]] == ["done"] * 3, out
    assert L["A"]["attempts"] == 1 and L["B"]["interruptions"] == 1 and L["B"]["attempts"] == 1, L["B"]
    for p_, b in a_remote.items():
        assert p_.read_bytes() == b, f"{p_.name} changed on Drive"
        assert (vm / "results" / p_.name).read_bytes() == b, f"{p_.name} not restored"
    ev = events(drive)
    assert any(e["event"] == "run_skipped_done" and e.get("run_id") == "A" for e in ev), "A skipped after the restore"
    assert any(e["event"] == "run_interrupted" and e.get("run_id") == "B" for e in ev)
    assert any(e["event"] == "session_start" for e in ev) and len([e for e in ev if e["event"] == "session_start"]) == 2, \
        "progress.jsonl continued across sessions"
    assert json.loads((drive / "state.json").read_text()) == json.loads((vm / "state.json").read_text())
    for rid in ("B", "C"):
        h = json.loads((drive / "state.json").read_text())["runs"][rid]["stages"]["train"]["checkpoint"]["sha256"]
        assert hashlib.sha256((drive / "checkpoints" / rid / "model.safetensors").read_bytes()).hexdigest() == h
    assert "===== B attempt 1 start" in (drive / "results" / "logs" / "train_B.log").read_text()
    assert not list((drive / "jobs").glob("*.job.json")), "finished job files removed from Drive"
    junk = [p_ for p_ in drive.rglob("*") if p_.name.startswith(".") or ".tmp" in p_.name or p_.name.endswith(".exit")]
    assert not junk, junk
    print("ok drive resume: local disk wiped; ledger, results, logs and job files restored from Drive; A skipped, "
          "B restarted (interruption), C done; Drive matches the ledger sha256, no temporary files")


def test_sync_units(tmp):
    ns = load_cells()
    root = tmp / "sync"
    loc, rem = root / "local" / "run", root / "drive" / "run"
    # atomic copy: a failure at the rename leaves the old file intact and no temporary file behind
    src = root / "src.txt"
    root.mkdir(parents=True)
    src.write_text("new")
    dst = root / "d" / "f.txt"
    dst.parent.mkdir()
    dst.write_text("old")
    real_replace = os.replace
    ns_os = ns["os"]
    def boom(a, b):
        raise OSError(28, "No space left on device (simulated)")
    ns_os.replace = boom
    try:
        try:
            ns["atomic_copy"](src, dst)
            raise AssertionError("expected OSError")
        except OSError:
            pass
        try:
            ns["write_json_atomic"](root / "d" / "j.json", {"a": 1})
            raise AssertionError("expected OSError")
        except OSError:
            pass
    finally:
        ns_os.replace = real_replace
    assert dst.read_text() == "old" and [p.name for p in dst.parent.iterdir() if p.name != "j.json.tmp%d" % os.getpid()] == ["f.txt"], \
        list(dst.parent.iterdir())
    ns["atomic_copy"](src, dst)
    assert dst.read_text() == "new" and sorted(p.name for p in dst.parent.iterdir() if "tmp" not in p.name) == ["f.txt"]

    S = ns["DriveSync"]
    files = {"state.json": b"{}", "heartbeat.json": b"{}", "results/env.json": b"{}", "results/logs/train_A.log": b"x" * 100,
             "results/scores_A.csv.gz": b"z" * (S.SMALL_MAX + 1), "checkpoints/A/model.safetensors": b"w" * 1000,
             "jobs/A.job.json": b"{}", "jobs/A.attempt1.1.exit": b"0", "results/env.json.tmp123": b"partial",
             "checkpoints/B.partial/model.safetensors": b"p", "results.zip": b"PK"}
    for rel, b in files.items():
        (loc / rel).parent.mkdir(parents=True, exist_ok=True)
        (loc / rel).write_bytes(b)
    sy = S(loc, rem)
    r = sy.sync(full=False)
    assert sorted(r["copied"]) == ["heartbeat.json", "jobs/A.job.json", "results/env.json", "results/logs/train_A.log",
                                   "state.json"], r
    assert not r["errors"] and not (rem / "checkpoints").exists() and not (rem / "results.zip").exists()
    r = sy.sync(full=True)
    assert sorted(r["copied"]) == ["checkpoints/A/model.safetensors", "results.zip", "results/scores_A.csv.gz"], r
    assert sy.sync(full=True)["copied"] == [], "unchanged files are not copied again"
    time.sleep(0.01)
    (loc / "state.json").write_text('{"v": 2}')
    assert sy.sync(full=False)["copied"] == ["state.json"] and (rem / "state.json").read_text() == '{"v": 2}'
    assert not [p for p in rem.rglob("*") if "tmp" in p.name or p.name.endswith(".exit") or ".partial" in str(p)]
    assert sy.verify() == []
    (rem / "results" / "env.json").write_text('{"tampered": 1}')
    assert sy.verify() == ["results/env.json: sha256 differs on Drive"]
    (rem / "results" / "env.json").write_bytes(b"{}")
    (loc / "jobs" / "A.job.json").unlink()
    assert sy.sync()["deleted"] == ["jobs/A.job.json"] and not (rem / "jobs" / "A.job.json").exists()
    sy.delete("checkpoints/A")
    assert not (rem / "checkpoints" / "A").exists()
    sy.sync(full=True)
    assert (rem / "checkpoints" / "A").exists(), "re-copied: the local copy still exists"
    # restore on a new VM: ledger/results/logs/jobs only; checkpoints on demand
    (loc / "jobs" / "A.job.json").write_bytes(b"{}")
    sy.sync()
    new = root / "vm2" / "run"
    sy2 = S(new, rem)
    got = sy2.restore()
    assert sorted(got) == ["heartbeat.json", "jobs/A.job.json", "results/env.json", "results/logs/train_A.log",
                           "results/scores_A.csv.gz", "state.json"], got
    assert not (new / "checkpoints").exists() and not (new / "results.zip").exists()
    assert sy2.restore_tree("checkpoints/A") == ["checkpoints/A/model.safetensors"]
    assert (new / "checkpoints/A/model.safetensors").read_bytes() == files["checkpoints/A/model.safetensors"]
    assert sy2.sync(full=True)["copied"] == [], "restored files are known to be in sync"
    (new / "state.json").write_text('{"local": "newer"}')
    assert sy2.restore() == [] and (new / "state.json").read_text() == '{"local": "newer"}', "local copy wins"
    # a Drive error is reported, not raised
    sy3 = S(root / "local3", root / "drive" / "run" / "state.json" / "not-a-dir")
    (root / "local3" / "state.json").write_text("{}")
    r = sy3.sync()
    assert r["errors"] and sy3.errors_total == 1 and sy3.last_ok is None
    assert not S(loc, loc).enabled, "same folder: sync off"
    print("ok sync: atomic copies (failure keeps the old file, no temp left), small vs full sync, skip unchanged, "
          "temp/partial/exit files never copied, deletions, verify, restore (checkpoints on demand), errors reported")


class FakePusher:
    def __init__(self, ok=True):
        self.ok, self.enabled, self.errors, self.last_error, self.prefix, self.puts = ok, True, 0, None, "", []

    def put(self, rel, content, message):
        self.puts.append(rel)
        if not self.ok:
            self.errors += 1
            self.last_error = "write: HTTP 500 (fake)"
        return self.ok


def test_finish(tmp):
    import zipfile
    ns = load_cells()
    calls = []

    def setup(name, pusher=None):
        loc, rem = tmp / "fin" / name / "local", tmp / "fin" / name / "drive"
        (loc / "results" / "logs").mkdir(parents=True)
        (loc / "state.json").write_text('{"runs": {}}')
        (loc / "results" / "verdict.json").write_text('{"outcome": "x"}')
        (loc / "results" / "logs" / "train_A.log").write_text("epoch 1/1 mean loss 0.1\n")
        (loc / "checkpoints" / "A").mkdir(parents=True)
        (loc / "checkpoints" / "A" / "model.safetensors").write_bytes(b"w" * 4096)
        with zipfile.ZipFile(loc / "results.zip", "w") as z:
            z.write(loc / "results" / "verdict.json", "verdict.json")
        P = ns["Progress"](pusher)
        P.bind(loc / "results", "t-" + name)
        P.heartbeat = lambda: None
        ns["PUSH_EVERY_S"] = 0.05
        P.start_timer()
        return ns["DriveSync"](loc, rem), P

    def run(sync, P, auto=True, unmount_ok=True):
        def unmount():
            calls.append("unmount")
            if not unmount_ok:
                raise RuntimeError("flush timed out (fake)")
        return ns["finish"](sync, P, auto, unmount=unmount, unassign=lambda: calls.append("unassign"))

    # 1. everything fine: sync, verify, push, unmount, then unassign, in that order
    sy, P = setup("ok", FakePusher())
    r = run(sy, P)
    assert r["released"] and not r["problems"] and calls == ["unmount", "unassign"], (r, calls)
    assert (sy.remote / "results.zip").read_bytes() == (sy.local / "results.zip").read_bytes()
    assert r["pushed"] is True and "progress.jsonl" in P.pusher.puts and P._thread is None
    assert not sy.enabled, "no Drive writes after the unmount"
    # 2. a failed sync (Drive not writable): never released, never unmounted
    calls.clear()
    sy, P = setup("syncfail")
    real = ns["atomic_copy"]
    def flaky(a, b):
        if pathlib.Path(b).name == "results.zip":
            raise OSError(28, "No space left on device (simulated)")
        return real(a, b)
    ns["atomic_copy"] = flaky
    try:
        r = run(sy, P)
    finally:
        ns["atomic_copy"] = real
    assert not r["released"] and calls == [] and any("results.zip" in x for x in r["problems"]), r
    # 3. a file corrupted on Drive after the copy: verification fails
    calls.clear()
    sy, P = setup("corrupt")
    sy.sync(full=True)
    (sy.remote / "results.zip").write_bytes(b"not a zip")
    st = (sy.local / "results.zip").stat()
    sy._seen["results.zip"] = (st.st_size, st.st_mtime_ns)   # the sync believes it is up to date
    r = run(sy, P)
    assert not r["released"] and calls == [] and any("results.zip" in x for x in r["problems"]), r
    # 4. the final GitHub push fails
    calls.clear()
    sy, P = setup("push", FakePusher(ok=False))
    r = run(sy, P)
    assert not r["released"] and calls == [] and any("GitHub" in x for x in r["problems"]), r
    # 5. flush_and_unmount fails
    calls.clear()
    sy, P = setup("unmount")
    r = run(sy, P, unmount_ok=False)
    assert not r["released"] and calls == ["unmount"] and any("flush_and_unmount" in x for x in r["problems"]), r
    # 6. AUTO_RELEASE_RUNTIME off: synced, verified and unmounted, but not released
    calls.clear()
    sy, P = setup("noauto")
    r = run(sy, P, auto=False)
    assert not r["released"] and calls == ["unmount"] and not r["problems"], r
    # 7. results.zip missing (Summary did not finish) / no Drive at all
    calls.clear()
    sy, P = setup("nozip")
    (sy.local / "results.zip").unlink()
    r = run(sy, P)
    assert not r["released"] and calls == [], r
    sy, P = setup("nodrive")
    sy.enabled = False
    r = run(sy, P)
    assert not r["released"] and calls == [] and any("Drive" in x for x in r["problems"]), r
    print("ok finish: unassign only after sync + sha256 verify + zip check + push + flush_and_unmount; not after a "
          "failed sync, corrupt Drive file, failed push, failed unmount, missing zip or no Drive, or with auto-release off")


def test_forms_and_env(tmp):
    import re
    src = cell("FORM")
    lines = src.splitlines()
    assert lines[0].startswith("#@title Settings") and 'display-mode: "form"' in lines[0]
    params = {}
    for l in lines:
        if l.startswith("#"):
            assert l.startswith("#@"), f"only form lines in the Settings cell: {l}"
            continue
        m = re.fullmatch(r'(\w+) = (.+?)  #@param \{type:"(string|boolean|integer)"\}', l)
        assert m, f"not a Colab form line: {l}"
        v = ast.literal_eval(m.group(2))
        assert {"string": str, "boolean": bool, "integer": int}[m.group(3)] is type(v), l
        params[m.group(1)] = v
    want = {"RUN_TAG": "", "RETRY_FAILED": False, "AUTO_RELEASE_RUNTIME": True, "PUSH_PROGRESS": True, "SMOKE": False}
    assert {k: params[k] for k in want} == want, params
    assert list(params)[:5] == list(want), "the five main options come first"
    nb_src = (HERE / "make_notebook.py").read_text()
    assert "new_markdown_cell(INTRO),\n        new_code_cell(FORM)," in nb_src, "the form is the first code cell"
    for name in params:   # no later cell re-assigns a form option at top level (except normalising SMOKE/RUN_TAG)
        for other in ("CONFIG", "PROGRESS_CELL", "RUNNER_CELL", "GPU", "PIP", "DATA", "TRAIN", "FINISH"):
            for l in cell(other).splitlines():
                if re.match(rf"{name}\s*=", l):
                    assert name in ("SMOKE", "RUN_TAG", "STALL_MINUTES"), f"{other} overrides {name}: {l}"
    # secrets are not passed to the training process
    ns = load_cells()
    os.environ["HF_TOKEN"], os.environ["GH_TOKEN"] = "hf_TEST_ONLY_secret", "github_pat_TEST_ONLY_secret"
    try:
        out = tmp / "envjob"
        job = ns["Job"].launch("E", 1, [sys.executable, "-I", "-c",
                                        "import os; print('HF', os.environ.get('HF_TOKEN'), 'GH', os.environ.get('GH_TOKEN'))"],
                               out / "log.txt", out / "jobs", "m")
        wait_until(lambda: job.status()[0] == "exited", what="env job")
    finally:
        os.environ.pop("HF_TOKEN"), os.environ.pop("GH_TOKEN")
    log = (out / "log.txt").read_text()
    assert "HF None GH None" in log and "TEST_ONLY" not in log, log
    print("ok forms: one Settings cell of #@param lines, defaults RUN_TAG='' RETRY_FAILED=False "
          "AUTO_RELEASE_RUNTIME=True PUSH_PROGRESS=True SMOKE=False; secrets not passed to training")


def test_status_view(tmp):
    ns = load_cells()
    run_dir = tmp / "status"
    (run_dir / "results").mkdir(parents=True)
    P = ns["Progress"](None)
    P.bind(run_dir / "results", "t")
    L = ns["Ledger"](run_dir / "state.json", run_dir, {"t": 1})
    L.update("F-TD-s0", status="done", attempts=1)
    L.get("F-TD-s0")["stages"]["train"] = {"info": {"wall_seconds": 1800}}
    L.update("F-EN-s0", status="running", attempts=1)
    O = ns["Orchestrator"](run_dir, L, P, gpu="fake-gpu", sync=ns["DriveSync"](run_dir, tmp / "status-drive"))
    O.plan = ["F-TD-s0", "F-EN-s0", "F-TD-s1", "Z-EN"]
    O.current = {"run_id": "F-EN-s0", "attempt": 1, "phase": "train", "epoch": 2, "epochs": 6, "pct": 30.0, "eta_min": 21.0}
    O._last_line = "epoch 2/6 step 40 loss 0.31 <b>"
    rows, eta = O.status_rows()
    assert [r["status"] for r in rows] == ["done", "running", "pending", "pending"] and rows[1]["epoch"] == "2/6"
    assert eta == 21 + 30, eta   # current run + one pending fine-tune at the measured 30 min (zero-shot not counted)
    h, plain = O.render(idle_min=0.5)
    assert "<table" in h and "F-EN-s0" in h and "&lt;b&gt;" in h
    assert "ETA all runs" in h and "Drive sync" in h and "F-EN-s0 train epoch 2/6 30% ETA 21.0 min" in plain, plain
    printed = []
    O.view = ns["StatusView"]()   # not under IPython: plain line, at most once a minute
    import contextlib, io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        O.show()
        O.show()
    assert buf.getvalue().count("runs {") == 1, buf.getvalue()
    print("ok status view: one table (runs, status, epoch, progress, ETA, GPU, Drive sync), HTML-escaped log line")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--fake-trainer-TEST-ONLY":
        return fake_trainer_TEST_ONLY(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--driver":
        return driver(sys.argv[2], sys.argv[3])
    test_mapping()
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        test_forms_and_env(tmp)
        test_status_view(tmp)
        test_sync_units(tmp)
        test_finish(tmp)
        test_drive_resume(tmp)
        test_disconnect(tmp)
        test_kernel_restart(tmp)
        test_retries(tmp)
    print("OK: resume/retry plumbing")


if __name__ == "__main__":
    main()
