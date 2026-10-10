"""Tests for the remote-control channel (lrt_runner.ControlChannel and the orchestrator's safe points), with the
GitHub contents API mocked in memory (test_progress_push.FakeGitHub). No network, no real token, no GPU.

Approved by the project owner on 2026-10-10 with exactly this scope: the notebook polls
<run folder>/control.json and <run folder>/control/latest.json on branch results/laya-colab and applies only
pause / resume (between runs), stop_now, retry / skip / rescore <run>, ping and dump. Checks:
  * a command is applied once and acknowledged in control-ack.jsonl (branch and local file); re-polling the same
    file applies nothing again; a new session (same run folder, or only the branch's ack file) does not re-apply;
  * anything outside the allow-list is rejected and acknowledged as rejected (unknown command, extra field, missing
    id, missing run, run given where none is taken, a file that is not JSON);
  * pause holds between runs (the current run finishes first) until resume;
  * stop_now kills the training process (TEST-ONLY fake trainer), marks the run interrupted without using an
    attempt, holds; resume restarts it from scratch; an interrupted run also restarts when the cell is run again;
  * retry / skip / rescore (rescore re-runs scoring only, on the same checkpoint; rejected when the checkpoint is
    not kept, or for the run in progress, or for an unknown run); commands still waiting when training ends are
    rejected;
  * dump pushes ledger, env.json, the last 500 log lines and a GPU snapshot, redacted;
  * ALLOW_REMOTE_CONTROL off: nothing is polled and commands are ignored;
  * the token is only ever in the Authorization header; the panel shows the last command and its ack.

Run: python -I colab/test_remote_control.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lrt_runner as LR  # noqa: E402
import test_progress_push as T  # noqa: E402
import test_resume as R  # noqa: E402

BRANCH = "results/laya-colab"
PREFIX = "experiments/release-triage/colab-runs/tag1"


def setup(tmp, enabled=True, quiet=True):
    """(ns, gh, pusher, ctl, ledger, progress) for one simulated run folder."""
    with contextlib.redirect_stdout(io.StringIO()):
        ns = R.load_cells()
    gh = T.FakeGitHub(T.TOKEN, branches=("research/laya-proper", BRANCH))
    pusher = ns["GitHubPusher"](T.TOKEN, "kambasana/56", BRANCH, "research/laya-proper", PREFIX, opener=gh)
    run_dir = pathlib.Path(tmp)
    (run_dir / "results" / "logs").mkdir(parents=True, exist_ok=True)
    P = ns["Progress"](None)
    P.bind(run_dir / "results", "tag1")
    ns.update(PROGRESS=P, RUN_DIR=run_dir, RESULTS=run_dir / "results")
    ctl = LR.ControlChannel(pusher, run_dir / LR.CONTROL_ACK, ns, enabled=enabled, poll_s=60)
    ns["ORCH_CONTROL"] = ns["LRT_CONTROL"] = ctl
    L = ns["Ledger"](run_dir / "state.json", run_dir, {"t": 1})
    return ns, gh, pusher, ctl, L, P


def put_control(gh, doc, rel="control.json"):
    raw = doc if isinstance(doc, bytes) else json.dumps(doc).encode()
    gh.files[(BRANCH, f"{PREFIX}/{rel}")] = ("sha-" + str(time.time_ns()), raw)


def acks(gh):
    f = gh.files.get((BRANCH, f"{PREFIX}/control-ack.jsonl"))
    return [json.loads(l) for l in f[1].decode().splitlines()] if f else []


def by_id(gh):
    return {a["id"]: a for a in acks(gh)}


def no_token_leak(gh, *texts):
    for method, path, auth in gh.calls:
        assert auth == f"Bearer {T.TOKEN}" and T.TOKEN not in path
    for (b, p), (_, data) in gh.files.items():
        assert T.TOKEN.encode() not in data, p
    for t in texts:
        assert T.TOKEN not in t


def orch(ns, L, P, run_dir, sleep=None, poll_s=0.05):
    return ns["Orchestrator"](run_dir, L, P, poll_s=poll_s, stall_s=60, backoff_s=0.01, sleep=sleep or (lambda s: None),
                              quiet=True, gpu="fake-cpu")


def quick_stage(name, log, fail_first=None, ckpt_dir=None):
    """An in-process stage (TEST ONLY) that records its calls; train stages write a fake checkpoint."""
    def fn(o, rid):
        log.append((rid, name))
        if fail_first is not None and fail_first.get(rid):
            fail_first[rid] -= 1
            raise ValueError(f"fake failure for {rid} (test)")
        p = pathlib.Path(o.root) / "results" / f"{name}_{rid}.json"
        p.write_text(json.dumps({"rid": rid, "n": len(log)}))
        out = {"files": [p]}
        if name == "train":
            d = pathlib.Path(o.root) / "checkpoints" / rid
            d.mkdir(parents=True, exist_ok=True)
            (d / "model.safetensors").write_bytes(b"weights " + rid.encode())
            out["checkpoint"] = d
        return out
    return LR_Stage(name, fn)


LR_Stage = None   # set in main() from the executed cell (ns["Stage"])


# ------------------------------------------------------------------------------------------------------- tests
def test_applied_once_and_ack(tmp):
    ns, gh, pusher, ctl, L, P = setup(tmp / "once")
    assert ctl.poll(force=True) == 0 and not acks(gh), "no control file: nothing happens"
    put_control(gh, {"id": "p-1", "cmd": "ping"})
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        assert ctl.poll(force=True) == 1
    a = by_id(gh)
    assert list(a) == ["p-1"] and a["p-1"]["result"] == "applied" and a["p-1"]["error"] is None
    assert a["p-1"]["note"].startswith("pong") and set(a["p-1"]) == {"id", "t", "cmd", "run", "result", "error", "note"}
    local = [json.loads(l) for l in (tmp / "once" / LR.CONTROL_ACK).read_text().splitlines()]
    assert [x["id"] for x in local] == ["p-1"], "ack also in the run folder (synced to Drive)"
    puts = sum(c[0] == "PUT" for c in gh.calls)
    for _ in range(3):   # the same file again (both control files polled every time): nothing re-applied
        assert ctl.poll(force=True) == 0
    assert sum(c[0] == "PUT" for c in gh.calls) == puts and len(acks(gh)) == 1
    n_calls = len(gh.calls)
    assert ctl.poll() == 0 and len(gh.calls) == n_calls, "throttled to ~60 s without force"
    put_control(gh, {"commands": [{"id": "p-1", "cmd": "ping"}, {"id": "p-2", "cmd": "ping"}]}, "control/latest.json")
    assert ctl.poll(force=True) == 1 and set(by_id(gh)) == {"p-1", "p-2"}, "only the new id in control/latest.json"
    # a new session on the same run folder: acked ids are known from the local file
    ctl2 = LR.ControlChannel(pusher, tmp / "once" / LR.CONTROL_ACK, ns)
    assert ctl2.poll(force=True) == 0 and len(acks(gh)) == 2
    # a new VM without the local file: the branch's control-ack.jsonl is read first
    ctl3 = LR.ControlChannel(pusher, tmp / "once-other-vm" / LR.CONTROL_ACK, ns)
    assert ctl3.poll(force=True) == 0 and len(acks(gh)) == 2
    no_token_leak(gh, out.getvalue(), repr(ctl), (tmp / "once" / "results" / "progress.jsonl").read_text())
    ev = [json.loads(l) for l in (tmp / "once" / "results" / "progress.jsonl").read_text().splitlines()]
    assert [e["id"] for e in ev if e["event"] == "control_ack"] == ["p-1", "p-2"]
    print("ok applied once: ping acked (id, time, result, error) on the branch and locally; re-polls, a new "
          "session and a new VM do not re-apply; token only in the Authorization header")


def test_rejected(tmp):
    ns, gh, pusher, ctl, L, P = setup(tmp / "rej")
    put_control(gh, {"commands": [
        {"id": "x-1", "cmd": "shell", "run": "rm -rf /"},
        {"id": "x-2", "cmd": "ping", "code": "import os"},
        {"cmd": "ping"},
        {"id": "x-4", "cmd": "retry"},
        {"id": "x-5", "cmd": "pause", "run": "F-EN-s0"},
        {"id": "x 6; rm", "cmd": "ping"},
        {"id": "x-7", "cmd": "skip", "run": "../../etc"},
        {"id": "x-8", "cmd": "set", "key": "EPOCHS", "value": 1},
        "ping",
    ]})
    put_control(gh, b"{not json", "control/latest.json")
    assert ctl.poll(force=True) == 10
    a = acks(gh)
    assert len(a) == 10 and all(x["result"] == "rejected" and x["error"] for x in a), a
    d = by_id(gh)
    assert "not an allowed command" in d["x-1"]["error"] and "not allowed" in d["x-2"]["error"]
    assert "needs a run" in d["x-4"]["error"] and "takes no run" in d["x-5"]["error"]
    assert "needs a run" in d["x-7"]["error"] and "not allowed" in d["x-8"]["error"]
    inv = [x for x in a if x["id"].startswith("invalid-")]
    assert len(inv) == 4 and any("not valid JSON" in x["error"] for x in inv)
    assert not ctl.paused and not ctl.pending and ctl.stop_requested() is None, "nothing applied"
    assert ctl.poll(force=True) == 0 and len(acks(gh)) == 10, "rejected ids are not re-processed either"
    print("ok rejected: unknown command, extra field, missing/malformed id or run, run where none is taken, "
          "non-object, non-JSON file: each acked as rejected once, nothing applied")


def test_pause_resume(tmp):
    run_dir = tmp / "pause"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    calls, sleeps = [], []

    def stage_a(o, rid):   # while A runs, the owner's assistant sends pause
        calls.append(rid)
        if rid == "A":
            put_control(gh, {"id": "pz-1", "cmd": "pause"})
            ctl.poll(force=True)
            assert by_id(gh)["pz-1"]["result"] == "applied"
        return {}

    def sleep(s):
        sleeps.append(list(calls))
        if len(sleeps) == 3:
            put_control(gh, {"id": "rs-1", "cmd": "resume"})
            ctl.poll(force=True)
    O = orch(ns, L, P, run_dir, sleep=sleep)
    specs = [ns["RunSpec"](r, [ns["Stage"]("s", stage_a)]) for r in ("A", "B", "C")]
    rep = O.run_all(specs)
    assert [r["status"] for r in rep] == ["done"] * 3
    assert sleeps == [["A"], ["A"], ["A"]], "held after A (A itself finished), B started only after resume"
    assert calls == ["A", "B", "C"] and not ctl.paused
    d = by_id(gh)
    assert d["rs-1"]["result"] == "applied" and d["rs-1"]["note"] == "resumed"
    print("ok pause/resume: pause during run A lets A finish, holds before B, resume continues B and C")


def test_stop_now_and_resume(tmp):
    run_dir = tmp / "stop"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    work = tmp / "stop-work"
    state = {"sent": False, "sleeps": 0}

    def train(o, rid):
        out = work / "runs" / rid
        log = run_dir / "results" / "logs" / f"train_{rid}.log"
        cmd = [sys.executable, "-I", str(R.SELF), "--fake-trainer-TEST-ONLY", "--out", str(out), "--epochs", "3",
               "--micro", "8", "--accum", "8", "--n", "40", "--oom-above", "64", "--state", str(work / f"{rid}.tries"),
               "--step-s", "0.15"]

        def on_line(line):
            if rid == "B" and not state["sent"] and "epoch 1/3 step 2" in line:
                state["sent"] = True
                state["pid"] = o.current["job"].info["pid"]
                put_control(gh, {"id": "stop-1", "cmd": "stop_now"})
                ctl.poll(force=True)
        rc, tail, info = o.run_job(rid, cmd, log, marker=f"{rid}|{out}", prepare=lambda: shutil.rmtree(out, ignore_errors=True),
                                   on_line=on_line, micro=8, accum=8)
        assert rc == 0, tail
        dst = run_dir / "checkpoints" / rid
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(out, dst, ignore=shutil.ignore_patterns("checkpoint_latest"))
        (run_dir / "results" / f"train_{rid}.json").write_text("{}")
        return {"files": [run_dir / "results" / f"train_{rid}.json"], "checkpoint": dst}

    def sleep(s):
        time.sleep(min(s, 0.05))
        if ctl.paused:
            state["sleeps"] += 1
            if state["sleeps"] == 2:
                assert L.get("B")["status"] == "interrupted" and not R.alive(state["pid"]), "killed, marked interrupted"
                put_control(gh, {"id": "resume-1", "cmd": "resume"}, "control/latest.json")
                ctl.poll(force=True)
    O = orch(ns, L, P, run_dir, sleep=sleep)
    specs = [ns["RunSpec"](r, [ns["Stage"]("train", train)]) for r in ("A", "B", "C")]
    with contextlib.redirect_stdout(io.StringIO()):
        rep = O.run_all(specs)
    assert [r["status"] for r in rep] == ["done"] * 3, rep
    b = L.get("B")
    assert b["attempts"] == 1 and b["interruptions"] == 1, b
    d = by_id(gh)
    assert d["stop-1"]["result"] == "applied" and "B stopped and marked interrupted" in d["stop-1"]["note"]
    assert d["resume-1"]["result"] == "applied" and state["sleeps"] >= 2
    text = (run_dir / "results" / "logs" / "train_B.log").read_text()
    parts = text.split("===== B attempt 1 start")
    assert len(parts) == 3 and "fresh_out_dir=True" in parts[2] and "FAKE TRAINER done" in parts[2], \
        "B restarted from scratch after resume, same attempt number"
    assert "FAKE TRAINER done" not in parts[1], "the first B process was stopped before finishing"
    ev = [json.loads(l) for l in (run_dir / "results" / "progress.jsonl").read_text().splitlines()]
    names = [e["event"] for e in ev if e.get("run_id") == "B"]
    assert "run_stopped" in names and "run_restart_after_stop" in names
    assert not list((run_dir / "jobs").glob("*.job.json")), "job files cleared"

    # without a resume command: running the cell again restarts an interrupted run too
    run2 = tmp / "stop2"
    ns2, gh2, _, ctl2, L2, P2 = setup(run2, enabled=False)
    L2.update("X", status="interrupted", attempts=0, interruptions=1)
    seen = []
    O2 = orch(ns2, L2, P2, run2)
    rep2 = O2.run_all([ns2["RunSpec"]("X", [ns2["Stage"]("s", lambda o, rid: seen.append(rid) or {})])])
    assert rep2[0]["status"] == "done" and seen == ["X"] and L2.get("X")["attempts"] == 1
    print("ok stop_now: training process killed, run marked interrupted (no attempt used), held; resume restarted "
          "it from scratch and the remaining runs finished; Run all also restarts an interrupted run")


def test_retry_skip_rescore(tmp):
    run_dir = tmp / "rsr"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    log = []
    fail = {"A": 1}

    def trig(o, rid):   # during B's score stage: retry A, rescore B (applied once B is done), an unknown run
        log.append((rid, "score"))
        if rid == "B" and sum(1 for x in log if x == ("B", "score")) == 1:
            put_control(gh, {"commands": [{"id": "rt-1", "cmd": "retry", "run": "A"},
                                          {"id": "rs-early", "cmd": "rescore", "run": "B"},
                                          {"id": "rt-zz", "cmd": "retry", "run": "ZZ"}]})
            ctl.poll(force=True)
        p = run_dir / "results" / f"score_{rid}.json"
        p.write_text(json.dumps({"n": len(log)}))
        return {"files": [p]}

    def score_stage():
        return ns["Stage"]("score", trig)

    def train(rid):
        return quick_stage("train", log, fail_first=fail)
    put_control(gh, {"id": "sk-1", "cmd": "skip", "run": "C"}, "control/latest.json")
    ctl.poll(force=True)
    assert "sk-1" not in by_id(gh), "run-level commands wait for the orchestrator"
    O = orch(ns, L, P, run_dir)
    specs = [ns["RunSpec"](r, [train(r), score_stage()]) for r in ("A", "B", "C", "D")]

    # D: trained, then its checkpoint is removed (like a positive control): rescore must be rejected
    def d_done(rid):
        shutil.rmtree(run_dir / "checkpoints" / rid)
        put_control(gh, {"commands": [{"id": "rs-d", "cmd": "rescore", "run": "D"},
                                      {"id": "rs-a", "cmd": "rescore", "run": "A"}]}, "control.json")
        ctl.poll(force=True)
    specs[3].on_done = d_done
    with contextlib.redirect_stdout(io.StringIO()):
        rep = O.run_all(specs)
    st = {r["run"]: r["status"] for r in rep}
    assert st == {"A": "done", "B": "done", "C": "skipped", "D": "done"}, st
    d = by_id(gh)
    assert d["sk-1"]["result"] == "applied" and L.get("C")["skipped_by_command"] == "sk-1"
    assert d["rt-1"]["result"] == "applied" and "queued again" in d["rt-1"]["note"]
    assert d["rs-early"]["result"] == "applied", "applied between runs, once B had finished"
    assert d["rt-zz"]["result"] == "rejected" and "unknown run" in d["rt-zz"]["error"]
    assert d["rs-d"]["result"] == "rejected" and "not kept" in d["rs-d"]["error"]
    assert d["rs-a"]["result"] == "rejected" and "only a finished run" in d["rs-a"]["error"], "A was queued, not done"
    O.current = {"run_id": "B"}
    by = {s_.run_id: s_ for s_ in specs}
    ok, err = O.control_apply({"id": "x", "cmd": "rescore", "run": "B"}, [], by)
    assert not ok and "running now" in err
    ok, err = O.control_apply({"id": "x", "cmd": "skip", "run": "B"}, [], by)
    assert not ok and "running now" in err
    O.current = {}
    ok, err = O.control_apply({"id": "x", "cmd": "skip", "run": "B"}, [], by)
    assert not ok and "is done" in err
    trains = [x for x in log if x[1] == "train"]
    assert trains.count(("A", "train")) == 2 and trains.count(("B", "train")) == 1, "rescore did not retrain B"
    assert log.count(("B", "score")) == 2 and ("C", "train") not in log
    assert L.get("A")["attempts"] == 1 and L.get("A")["status"] == "done"
    # after training: waiting and new run-level commands are rejected; ping still works
    put_control(gh, {"commands": [{"id": "late-1", "cmd": "retry", "run": "C"}, {"id": "late-2", "cmd": "ping"}]})
    ctl.poll(force=True)
    d = by_id(gh)
    assert d["late-1"]["result"] == "rejected" and "finished" in d["late-1"]["error"] and d["late-2"]["result"] == "applied"
    print("ok retry/skip/rescore: C skipped, A retried after failing, B rescored on its checkpoint (no re-train), "
          "rescore rejected while running or without a kept checkpoint, unknown run rejected; after training only "
          "ping/dump apply")


def test_waiting_rejected_at_end(tmp):
    run_dir = tmp / "end"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    O = orch(ns, L, P, run_dir)

    def s(o, rid):
        put_control(gh, {"id": "st-late", "cmd": "stop_now"})
        ctl.poll(force=True)
        return {}
    # stop_now arriving during the only run's last stage: applied at the stage boundary? no further stage -> it
    # holds nothing (queue empty) and is acknowledged as "no run was in progress"
    O.run_all([ns["RunSpec"]("A", [ns["Stage"]("s", s)])])
    a = by_id(gh)["st-late"]
    assert a["result"] == "applied" and "no run was in progress" in a["note"] and not ctl.paused
    print("ok end of training: a stop_now after the last stage is acknowledged (nothing to stop); nothing held")


def test_dump(tmp):
    run_dir = tmp / "dump"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    (run_dir / "results" / "env.json").write_text(json.dumps({"gpu": "A100", "dir": str(run_dir)}))
    lines = [f"line {i}" for i in range(600)] + [f"leak {T.TOKEN} at /content/work/x", "Authorization: Bearer abcdefgh12345678"]
    (run_dir / "results" / "logs" / "console.log").write_text("\n".join(lines) + "\n")
    ns["gpu_stats"] = lambda: {"gpu_name": "fake", "gpu_util_pct": 97.0}
    ns["nvidia_smi_summary"] = lambda: {"driver_version": "550"}
    put_control(gh, {"id": "dump-1", "cmd": "dump"})
    ctl.poll(force=True)
    a = by_id(gh)["dump-1"]
    assert a["result"] == "applied" and "console-tail.log" in a["note"], a
    f = {p.split("/")[-1]: data.decode() for (b, p), (_, data) in gh.files.items() if "/dump/dump-1/" in p}
    assert set(f) == {"state.json", "env.json", "console-tail.log", "gpu.json"}, set(f)
    tail = f["console-tail.log"].splitlines()
    assert len(tail) == 500 and tail[0] == "line 102" and "[redacted]" in tail[-2] and "abcdefgh12345678" not in tail[-1]
    assert str(run_dir) not in "".join(f.values()) and "/content/" not in f["console-tail.log"]
    assert json.loads(f["gpu.json"])["gpu_stats"]["gpu_util_pct"] == 97.0
    assert json.loads(f["state.json"])["fingerprint"] == {"t": 1}
    no_token_leak(gh)
    print("ok dump: ledger, env.json, last 500 log lines and a GPU snapshot pushed to dump/<id>/, redacted")


def test_disabled(tmp):
    run_dir = tmp / "off"
    ns, gh, pusher, ctl, L, P = setup(run_dir, enabled=False)
    put_control(gh, {"commands": [{"id": "off-1", "cmd": "pause"}, {"id": "off-2", "cmd": "skip", "run": "B"},
                                  {"id": "off-3", "cmd": "ping"}]})
    assert ctl.poll(force=True) == 0
    assert not any("/contents/" in p for _, p, _ in gh.calls), "nothing is even read"
    seen = []
    O = orch(ns, L, P, run_dir)
    rep = O.run_all([ns["RunSpec"](r, [ns["Stage"]("s", lambda o, rid: seen.append(rid) or {})]) for r in ("A", "B")])
    assert seen == ["A", "B"] and [r["status"] for r in rep] == ["done", "done"] and not acks(gh)
    ctl.start()
    assert ctl._thread is None, "no polling thread when off"
    ns_off = dict(ns, ALLOW_REMOTE_CONTROL=False, PROGRESS=type("P", (), {"pusher": pusher})())
    c = LR.make_control(ns_off)
    assert not c.enabled and c.off_reason == "ALLOW_REMOTE_CONTROL is off in Settings"
    c = LR.make_control(dict(ns, ALLOW_REMOTE_CONTROL=True, PROGRESS=type("P", (), {"pusher": None})()))
    assert not c.enabled and "GH_TOKEN" in c.off_reason
    c = LR.make_control(dict(ns, PROGRESS=type("P", (), {"pusher": pusher})()))
    assert c.enabled, "on by default when a token is set"
    assert LR.control_indicator(LR.make_control(ns_off).status(), 0)[1] == "off (ALLOW_REMOTE_CONTROL is off in Settings)"
    print("ok disabled: ALLOW_REMOTE_CONTROL off (or no GH_TOKEN) reads nothing and ignores every command")


def test_panel(tmp):
    run_dir = tmp / "panel"
    ns, gh, pusher, ctl, L, P = setup(run_dir)
    dash = LR.Dashboard(ns, mode="text", tick_s=0, stream=io.StringIO())
    s = dash.state.snapshot()
    dash._gather()
    s = dash.state.snapshot()
    assert s["control"][0] == "ok" and "listening" in s["control"][1] and s["control_text"] == "Remote control: no command received yet."
    put_control(gh, {"id": "pz-9", "cmd": "pause"})
    ctl.poll(force=True)
    dash.state.begin(next(x for x in LR.STAGES if x.source == "TRAIN"))
    dash._gather()
    s = dash.state.snapshot()
    assert s["control"][0] == "warn" and "PAUSED" in s["control"][1]
    assert "last command pause (id pz-9" in s["control_text"] and "→ applied" in s["control_text"]
    assert s["now"].startswith("Paused by a remote-control command"), s["now"]
    h = dash.to_html()
    assert "Remote control</b>" in h and "pz-9" in h
    assert "remote control" in LR.text_status(s) and "pz-9" in LR.text_status(s)
    put_control(gh, {"id": "st-9", "cmd": "stop_now"})
    ctl.poll(force=True)
    dash._gather()
    assert "waiting to be applied" in dash.state.snapshot()["control_text"]
    dash.state.on_event({"event": "run_stopped", "run_id": "F-EN-s0", "command_id": "st-9"})
    dash.state.on_event({"event": "run_skipped_by_command", "run_id": "Z-TD"})
    rows = {r["run"]: r for r in dash.state.snapshot()["runs"]}
    assert rows["F-EN-s0"]["status"] == "interrupted" and rows["Z-TD"]["status"] == "skipped"
    assert "» skipped" in LR.html_runs(dash.state.snapshot())
    print("ok panel: Remote control indicator, last command and its ack, paused line, stopped/skipped runs")


def main():
    global LR_Stage
    os.environ.pop("GH_TOKEN", None)
    with contextlib.redirect_stdout(io.StringIO()):
        LR_Stage = R.load_cells()["Stage"]
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        test_applied_once_and_ack(tmp)
        test_rejected(tmp)
        test_pause_resume(tmp)
        test_stop_now_and_resume(tmp)
        test_retry_skip_rescore(tmp)
        test_waiting_rejected_at_end(tmp)
        test_dump(tmp)
        test_disabled(tmp)
        test_panel(tmp)
    print("OK: remote control")


if __name__ == "__main__":
    main()
