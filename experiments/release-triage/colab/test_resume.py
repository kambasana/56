"""CPU test of the notebook's resume / retry plumbing (cell "1c" of colab/make_notebook.py). No GPU, no Laya.

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
  * a "done" run whose result file changed is redone; heartbeat lines and heartbeat.json are written.

Run: python -I colab/test_resume.py
"""
from __future__ import annotations

import ast
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
    tree = ast.parse((HERE / "make_notebook.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit(f"{name} not found in make_notebook.py")


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
    (res / "logs").mkdir(parents=True, exist_ok=True)
    P = ns["Progress"](None)
    ns["PROGRESS"] = P
    P.bind(res, "test-run")
    P.ctx["gpu"] = "fake-cpu"
    P.log("session_start", pid=os.getpid())
    L = ns["Ledger"](run_dir / "state.json", run_dir, {"test": 1})
    slept = []
    O = ns["Orchestrator"](run_dir, L, P, poll_s=0.1, stall_s=plan.get("stall_s", 60), backoff_s=0.01,
                           sleep=lambda s: (slept.append(s), time.sleep(min(s, 0.1))), quiet=True, gpu="fake-cpu")
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


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--fake-trainer-TEST-ONLY":
        return fake_trainer_TEST_ONLY(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--driver":
        return driver(sys.argv[2], sys.argv[3])
    test_mapping()
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        test_disconnect(tmp)
        test_kernel_restart(tmp)
        test_retries(tmp)
    print("OK: resume/retry plumbing")


if __name__ == "__main__":
    main()
