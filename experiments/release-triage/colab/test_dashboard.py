"""Unit tests for the control panel in colab/lrt_runner.py, without a notebook and (for the state model) without
ipywidgets: step transitions, progress and ETA math, error surfacing, indicators, redraw from the ledger, the text
fallback, the widget view (if ipywidgets is installed), the dashboard.html snapshot pushed to GitHub (no secrets, no
absolute paths), and that every rule-bearing stage source is byte-identical to the notebook before the panel
(5b95fb9): the panel is presentation only.

Run: python -I colab/test_dashboard.py
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lrt_runner as L  # noqa: E402

# sha256 of each stage source as committed in colab/make_notebook.py at 5b95fb9 (the notebook before the panel).
# PROGRESS_CELL and RUNNER_CELL (plumbing) gained display hooks and are tested by test_resume / test_progress_push.
UNCHANGED_SHA256 = {
    "CONFIG": "78fe0b28c0220fd9d75ac5e399dd7658ce7ab94e4f919796e49457d8bb40aa24",
    "GPU": "2208be51e47d049047bfe32b1e38098fef98275bd7bd7a5fac879eba9cce1fd2",
    "PIP": "a46d3d4b998cf8083ae465936a5ae86a8e7d771d5ec337f20ca77ba50c5c951d",
    "DRIVE": "b8ef1251207fce22e376bed7467abfb23cc6581e76fa157dc18ffeb203b955ae",
    "DATA": "29cf9be8940e093bcdf505ec3ba107104606be235a67dff80dc6455320b84127",
    "VALIDITY": "07e4d29b9903a7e8e5af4dd72203868aed24cb31ad11868f5799a19f9e2c8262",
    "CKPT": "27d14687259aed6f920be274c683748212f75ba36319c078e3cdb89569350c0e",
    "TOKENS": "3685b219f31294c01de49d15b9052b81a15a3c7755adcc75105a94a12d5071da",
    "DRYRUN": "f74217290b70c59c3000015e3581e206ec5067cb4a62091db84ae0fe22181c9d",
    "SCORE": "523259378abe6271b4c0d4ac56d1a12cc37cb55dc04977e44b98a3aa85ec0c06",
    "METRICS": "1ed06e43ec86ac0f3cd28affc18c0954e10c9080e33c97b4aa9a3188f98bd1ea",
    "TRAIN": "7cb94dca7f1154828e2a3ed274f3990426b7ee8fa02bbc9255682af6caa826bc",
    "VERDICT": "21a326398e6e896e5ff335ac240d8edfcf699c8d00c977ee94ad3882d18edbf4",
    "LATENCY": "e609e039c9a4437c18c6361989bf1c97d3ab0b777ab27c1546671e2303f40d9c",
    "SAVE": "b906d731e8f543f61e7783328b105154ea973175a209a9bc6deec505942dbc13",
    "ONNX": "07176be5e2f6b88c2682209564b845cca20beb22112320a5fb05e3ff639db365",
    "SUMMARY": "091c2993b5c0983d4c0d0e3862838ec42bd0e0937aa313c366e4ffd32cbb305d",
    "FINISH": "5712bf2f5dbb1e72f11b96bc6b89bcf4765ee344751930765d14df9fbce27ce7",
}
PLAN = ["PC-EN", "PC-TD", "F-TD-s0", "F-EN-s0", "F-TD-s1", "F-EN-s1", "F-TD-s2", "F-EN-s2", "Z-EN", "Z-TD"]


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def stage(src):
    return next(s for s in L.STAGES if s.source == src)


def test_presentation_only():
    for name, h in UNCHANGED_SHA256.items():
        assert hashlib.sha256(getattr(L, name).encode()).hexdigest() == h, f"{name} changed: rule-bearing code must not"
    assert [s.source for s in L.STAGES] == ["CONFIG", "PROGRESS_CELL", "RUNNER_CELL",
        "GPU", "DRIVE", "PIP", "DATA", "VALIDITY", "CKPT", "TOKENS", "DRYRUN", "SCORE", "METRICS", "TRAIN", "VERDICT",
        "LATENCY", "SAVE", "ONNX", "SUMMARY", "FINISH"], "the former cell order"
    assert [s.progress for s in L.STAGES if s.progress] == [
        "gpu", "drive", "install", "data", "validity", "checkpoints", "tokens", "dryrun", "score_defs", "metric_defs",
        "train", "verdict", "latency", "save_checkpoint", "onnx", "summary"], "the same progress.jsonl stage names"
    assert [k for k, _ in L.STEPS] == ["setup", "gpu", "storage", "install", "data", "checks", "models", "training",
                                       "verdict", "finish"]
    assert L.expected_plan({}) == PLAN
    assert L.expected_plan({"RUN_POSITIVE_CONTROL": False, "RUN_ZERO_SHOT": False, "SEEDS": [0]}) == ["F-TD-s0", "F-EN-s0"]
    print("ok presentation only: 18 stage sources byte-identical to 5b95fb9, same order and stage names, plan order")


def test_steps_and_progress():
    clk = Clock()
    st = L.DashState(clk)
    st.set_plan(PLAN, "settings")
    assert st.overall_fraction() == 0 and st.snapshot()["steps"][0]["status"] == "pending"
    st.begin(stage("CONFIG"))
    assert st.status["setup"] == "active" and st.now == stage("CONFIG").what
    st.end(stage("CONFIG"))
    assert st.status["setup"] == "active", "setup has three stages"
    st.end(stage("PROGRESS_CELL"))
    st.end(stage("RUNNER_CELL"))
    assert st.status["setup"] == "done"
    w = L.STEP_WEIGHT
    tot = sum(w.values())
    assert abs(st.overall_fraction() - w["setup"] / tot) < 1e-9
    for src in ("GPU", "DRIVE", "PIP", "DATA", "VALIDITY", "CKPT", "TOKENS"):
        st.begin(stage(src))
        st.end(stage(src))
    st.begin(stage("DRYRUN"))   # models: 2 of 5 stages done
    assert st.status["models"] == "active"
    exp = (w["setup"] + w["gpu"] + w["storage"] + w["install"] + w["data"] + w["checks"] + w["models"] * 2 / 5) / tot
    assert abs(st.overall_fraction() - exp) < 1e-9, (st.overall_fraction(), exp)
    for src in ("DRYRUN", "SCORE", "METRICS"):
        st.end(stage(src))
    st.begin(stage("TRAIN"))
    assert st.overall_eta_min() is None, "no measurement yet"
    # two runs done, one 50 % through training
    st.on_event({"event": "run_done", "run_id": "PC-EN"})
    st.on_event({"event": "run_done", "run_id": "PC-TD"})
    st.on_event({"event": "run_start", "run_id": "F-TD-s0", "attempt": 1})
    st.on_orch([{"run": r, "status": ("done" if r.startswith("PC") else "running" if r == "F-TD-s0" else "pending"),
                 "attempt": 1 if r.startswith(("PC", "F-TD-s0")) else ""} for r in PLAN],
               {"run_id": "F-TD-s0", "attempt": 1, "phase": "train", "epoch": 3, "epochs": 6, "pct": 50.0,
                "eta_min": 20.0, "step": 40, "steps_per_epoch": 102}, None, idle_min=0.2)
    weights = {r: (0.1 if r.startswith("Z-") else 1.0) for r in PLAN}
    exp_train = (2 + 0.85 * 0.5) / sum(weights.values())
    assert abs(st.training_fraction() - exp_train) < 1e-9
    # ETA from the current run's own speed: 20 min left at 50 % -> 40 min a run; 5 fine-tunes still pending
    assert st.overall_eta_min() == 20 + 5 * 40, st.overall_eta_min()
    # once finished runs give a mean, the orchestrator's figure is used
    st.on_orch([], {"run_id": "F-TD-s0", "phase": "train", "pct": 60.0, "eta_min": 15.0}, 140)
    assert st.overall_eta_min() == 140
    s = st.snapshot()
    assert "ETA ~2 h 20 min" in L.overall_text(s), L.overall_text(s)
    assert L.current_pct(s) == 60.0
    st.on_orch([], {"run_id": "F-TD-s0", "phase": "score"}, 140)
    assert L.current_pct(st.snapshot()) == 100.0 and "Scoring F-TD-s0" in st.now
    assert L.fmt_minutes(0.5) == "<1 min" and L.fmt_minutes(59) == "59 min" and L.fmt_minutes(125) == "2 h 05 min"
    print("ok steps and progress: transitions, weighted overall %, training fraction, ETA (own speed, then measured)")


def test_errors_and_events():
    st = L.DashState(Clock())
    st.set_plan(PLAN, "settings")
    st.begin(stage("TRAIN"))
    st.on_event({"event": "run_start", "run_id": "F-EN-s1", "attempt": 1})
    st.on_event({"event": "run_error", "run_id": "F-EN-s1", "attempt": 1, "kind": "oom", "error": "CUDA out of memory"})
    st.on_event({"event": "oom_retry", "run_id": "F-EN-s1",
                 "change": {"micro_batch": [8, 4], "grad_accum": [8, 16], "effective_batch": 64}})
    assert "micro-batch 4 x accumulation 16" in st.now and len(st.notices) == 2 and not st.errors
    st.on_event({"event": "run_start", "run_id": "F-EN-s1", "attempt": 2})
    assert st.runs["F-EN-s1"]["status"] == "retrying"
    st.on_event({"event": "run_failed", "run_id": "F-EN-s1", "last_error": "other: ValueError: boom"})
    assert st.runs["F-EN-s1"]["status"] == "failed" and st.errors[0]["what"] == "Run F-EN-s1 failed"
    assert "state.json" in st.errors[0]["where"] and "train_F-EN-s1.log" in st.errors[0]["where"]
    st.on_event({"event": "run_failed", "run_id": "F-EN-s1", "last_error": "again"})
    assert len(st.errors) == 1, "one entry per run"
    st.on_event({"event": "run_done", "run_id": "F-EN-s1"})   # retried later and done: no longer an error
    assert not st.errors
    st.add_log("WARNING: saving to the Colab VM's own disk")
    st.add_log("WARNING: saving to the Colab VM's own disk")
    assert sum("own disk" in n["text"] for n in st.notices) == 1
    for i in range(250):
        st.add_log(f"line {i}")
    assert len(st.log) == 200 and st.log_total == 252 and st.log[-1] == "line 249"
    st.fail("training", "SystemExit: laya-train --dry-run failed for EN", "cell output below")
    s = st.snapshot()
    assert s["steps"][7]["status"] == "failed" and s["errors"][-1]["what"] == "Training runs step failed"
    h = L.html_errors(s)
    assert "✗ Errors" in h and "dry-run failed" in h and "Where: cell output below" in h
    assert "(failed)" in L.html_stepper(s), "a word next to every colour"
    st2 = L.DashState(Clock())
    st2.begin(stage("TRAIN"))
    st2.on_event({"event": "run_start", "run_id": "F-TD-s0", "attempt": 1})
    st2.stop("training")
    assert st2.status["training"] == "stopped" and st2.runs["F-TD-s0"]["status"] == "interrupted"
    assert "run this cell again to re-attach" in st2.now
    print("ok errors: retries as notices, final failures with where the traceback is, cleared when redone, "
          "deduplicated notices, 200-line log, stage failure and stop")


def test_ledger_redraw():
    st = L.DashState(Clock())
    st.set_plan(PLAN, "settings")
    st.load_ledger({"runs": {"PC-EN": {"status": "done", "attempts": 1}, "PC-TD": {"status": "done", "attempts": 2},
                             "F-TD-s0": {"status": "running", "attempts": 1},
                             "F-EN-s0": {"status": "failed", "attempts": 3, "last_error": "oom: CUDA out of memory"}}})
    rows = {r["run"]: r for r in st.snapshot()["runs"]}
    assert [r["run"] for r in st.snapshot()["runs"]] == PLAN, "plan order kept"
    assert rows["PC-TD"]["status"] == "done" and rows["PC-TD"]["attempt"] == 2
    assert rows["F-TD-s0"]["status"] == "interrupted", "a run that was running when the session ended"
    assert rows["F-EN-s0"]["status"] == "failed" and st.errors[0]["key"] == "run:F-EN-s0"
    h = L.html_runs(st.snapshot())
    assert h.count("<tr>") == 11 and "✓ done" in h and "✗ failed" in h and "■ interrupted" in h
    print("ok ledger redraw: run table rebuilt from state.json (done, interrupted, failed with its error)")


def test_indicators():
    now = 10_000.0
    assert L.drive_indicator(None, now)[0] == "off"
    assert L.drive_indicator({"enabled": False, "durable": False}, now)[0] == "error"
    assert L.drive_indicator({"enabled": True, "last_ok": None}, now)[0] == "warn"
    assert L.drive_indicator({"enabled": True, "last_ok": now - 5}, now)[0] == "ok"
    lv, txt = L.drive_indicator({"enabled": True, "last_ok": now - 50, "last_error_t": now - 5, "last_error": "No space"}, now)
    assert lv == "error" and "No space" in txt
    assert L.drive_indicator({"enabled": True, "last_ok": now, "last_error_t": now - 5}, now)[0] == "ok", "recovered"
    assert L.drive_indicator({"enabled": False, "unmounted": True}, now)[0] == "ok"
    assert L.github_indicator({"configured": False, "note": "no GH_TOKEN secret"}, now) == ("off", "off (no GH_TOKEN secret); Drive only")
    assert L.github_indicator({"configured": True, "enabled": False, "last_error": "HTTP 401"}, now)[0] == "error"
    assert L.github_indicator({"configured": True, "enabled": True, "errors": 2, "last_error": "HTTP 500"}, now)[0] == "warn"
    assert L.github_indicator({"configured": True, "enabled": True, "errors": 0, "last_push_ok": now}, now)[0] == "ok"
    assert L.short_gh_note("the Colab secret GH_TOKEN exists but this notebook has no access to it") == \
        "GH_TOKEN secret has no notebook access"
    assert L.short_gh_note("no Colab secret named GH_TOKEN (key icon ...)") == "no GH_TOKEN secret"
    assert L.heartbeat_indicator(None, 120, now, False)[0] == "off"
    assert L.heartbeat_indicator(None, 120, now, True)[0] == "warn"
    assert L.heartbeat_indicator(now - 100, 120, now, True)[0] == "ok"
    assert L.heartbeat_indicator(now - 400, 120, now, True)[0] == "warn"
    assert L.heartbeat_indicator(now - 900, 120, now, True)[0] == "error"
    s = L.DashState(Clock(now)).snapshot()
    h = L.html_header(s)
    for word in ("Drive</b>: off", "GitHub</b>: off", "Heartbeat</b>: off"):
        assert word in h, "text label next to every colour dot"
    print("ok indicators: Drive / GitHub / heartbeat levels with text (OK, attention, problem, off)")


def test_text_view():
    clk = Clock()
    st = L.DashState(clk)
    st.set_plan(PLAN, "settings")
    buf = io.StringIO()
    tv = L.TextView(buf, every_s=60, clock=clk)
    assert tv.update(st.snapshot()) == 1
    assert tv.update(st.snapshot()) == 0, "nothing changed, under a minute: quiet"
    st.begin(stage("GPU"))
    assert tv.update(st.snapshot()) == 1, "a step changed"
    st.add_log("x")
    assert tv.update(st.snapshot()) == 0
    clk.t += 61
    assert tv.update(st.snapshot()) == 1, "once a minute"
    st.fail("gpu", "SystemExit: No GPU", "cell output")
    assert tv.update(st.snapshot()) == 1
    out = buf.getvalue()
    assert "step 2/10 GPU (failed)" in out and "ERROR GPU step failed: SystemExit: No GPU" in out, out
    assert tv.printed == 4 and len(out.splitlines()) <= 4 * 5
    print("ok text fallback: compact status, printed on change or once a minute")


def test_widget_view():
    try:
        import ipywidgets  # noqa: F401
    except ImportError:
        print("skip widget view: ipywidgets not installed")
        return
    shown = []
    v = L.WidgetView(ipywidgets, shown.append)
    assert shown == [v.root] and isinstance(v.log_acc, ipywidgets.Accordion) and v.log_acc.selected_index is None
    st = L.DashState(Clock())
    st.set_plan(PLAN, "settings")
    st.begin(stage("TRAIN"))
    st.on_orch([], {"run_id": "F-TD-s0", "phase": "train", "epoch": 2, "epochs": 6, "pct": 30.0, "eta_min": 25.0}, None)
    for i in range(300):
        st.add_log(f"log {i}")
    n1 = v.update(st.snapshot())
    assert n1 > 5 and v.cur_bar.value == 30.0 and "epoch 2/6" in v.cur_txt.value and v.errors.layout.display == "none"
    assert v.log_out.outputs[0]["text"].count("\n") == 200 and "200 of 300" in v.log_acc.get_title(0)
    assert v.update(st.snapshot()) == 0, "unchanged state: no widget traffic"
    st.fail("training", "boom", "here")
    v.update(st.snapshot())
    assert v.overall_bar.bar_style == "danger" and v.errors.layout.display is None and "boom" in v.errors.value
    st.set_results({"outcome": "FAIL: Laya is not adopted", "table_html": "<table></table>",
                    "paths": [("results.zip", "/x/results.zip")]})
    v.update(st.snapshot())
    assert v.results.layout.display is None and "FAIL</span>" in v.results.value
    print("ok widget view: in-place updates only when something changed, 200-line log, errors and results shown")


def test_public_snapshot():
    """dashboard.html (pushed to GitHub): renders from a mid-run state; no token-like strings, no absolute paths."""
    tok = "github_pat_TEST_ONLY_0123456789abcdefghij"
    hf = "hf_TESTONLYabcdefghijklmnop"
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        run_dir, remote = d / "content/work/out/tag1", d / "content/drive/MyDrive/laya-release-triage/tag1"

        class P:
            pusher = type("Pu", (), {"_token": tok, "enabled": True, "errors": 0, "last_error": None})()
            last_push_ok = None
            _thread = object()
        ns = {"RUN_TAG": "tag1", "RUN_DIR": run_dir, "REMOTE_RUN": remote, "DRIVE_MOUNTED": True, "PROGRESS": P(),
              "WORK": d / "content/work", "CONTENT": d / "content", "GPU_NAME": "A100", "GPU_GB": 40.0}
        dash = L.Dashboard(ns, mode="text", tick_s=0, stream=io.StringIO())
        st = dash.state
        st.set_plan(PLAN, "settings")
        for src in ("CONFIG", "PROGRESS_CELL", "RUNNER_CELL", "GPU", "DRIVE"):
            st.begin(stage(src))
            st.end(stage(src))
        st.begin(stage("TRAIN"))
        st.on_orch([], {"run_id": "F-EN-s0", "phase": "train", "epoch": 3, "epochs": 6, "pct": 45.0, "eta_min": 18.0}, None)
        for i in range(150):
            st.add_log(f"step line {i}")
        st.add_log(f"local work -> {run_dir}")
        st.add_log(f"durable copy -> {remote}")
        st.add_log(f"oops Authorization: Bearer {tok} and {hf} /root/.cache/x and /tmp/abc")
        st.add_error("run:F-TD-s0", "Run F-TD-s0 failed", f"see {run_dir}/results/logs/train_F-TD-s0.log", L.where_run("F-TD-s0"))
        page = dash.public_html()
    for bad in (tok, hf, str(d), "/root/", "/tmp/", "/content/"):   # "Bearer" itself may stay; the token after it not
        assert bad not in page, bad
    import re
    assert not re.search(r"github_pat_|gh[pousr]_[A-Za-z0-9]{12,}|hf_[A-Za-z0-9]{12,}", page)
    assert "MyDrive/laya-release-triage/tag1" in page and "[local run folder]" in page
    assert "F-EN-s0" in page and "epoch 3/6" in page and "What's happening now" in page and "Errors (1)" in page
    assert "step line 149" in page and "step line 52 " not in page and "step line 53" in page, "last 100 log lines"
    assert page.startswith("<!doctype html>") and "<script" not in page, "self-contained static HTML"
    print("ok dashboard.html: mid-run snapshot, last 100 log lines, secrets and token-like strings redacted, "
          "paths reduced to the run folder, no scripts")


def test_snapshot_push():
    """Progress.push sends dashboard.html when it changed, keeping the previous one as dashboard.prev.html."""
    import test_progress_push as T
    import time
    import urllib.request
    ns = {"REPO": "kambasana/56", "SUBDIR": "experiments/release-triage", "SMOKE": False, "time": time, "json": json,
          "hashlib": hashlib, "pathlib": pathlib, "urllib": urllib}   # what the CONFIG stage imports before it
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(T.cell_source(), "progress_cell", "exec"), ns)
    gh = T.FakeGitHub(T.TOKEN)
    pusher = ns["GitHubPusher"](T.TOKEN, "kambasana/56", "results/laya-colab", "research/laya-proper", "", opener=gh)
    prog = ns["Progress"](pusher)
    pages = iter([b"<html>one</html>", b"<html>one</html>", b"<html>two</html>"])
    prog.snapshot_files = lambda: {"dashboard.html": next(pages)}
    with tempfile.TemporaryDirectory() as d:
        (pathlib.Path(d) / "results").mkdir()
        prog.bind(pathlib.Path(d) / "results", "tag1")
        base = f"{pusher.prefix}"
        br = "results/laya-colab"
        prog.log("x")
        assert prog.push()
        assert gh.files[(br, f"{base}/dashboard.html")][1] == b"<html>one</html>"
        assert (br, f"{base}/dashboard.prev.html") not in gh.files
        n = len([c for c in gh.calls if c[0] == "PUT"])
        prog.push()
        assert len([c for c in gh.calls if c[0] == "PUT"]) == n, "unchanged: not pushed again"
        prog.push()
        assert gh.files[(br, f"{base}/dashboard.html")][1] == b"<html>two</html>"
        assert gh.files[(br, f"{base}/dashboard.prev.html")][1] == b"<html>one</html>"
    print("ok snapshot push: dashboard.html overwritten in place when it changes, previous kept as dashboard.prev.html")


def main():
    test_presentation_only()
    test_steps_and_progress()
    test_errors_and_events()
    test_ledger_redraw()
    test_indicators()
    test_text_view()
    test_widget_view()
    test_public_snapshot()
    test_snapshot_push()
    print("OK: control panel")


if __name__ == "__main__":
    main()
