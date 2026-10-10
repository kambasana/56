"""Unit test for the notebook's live-progress push (cell "1b" of colab/make_notebook.py), with a mocked HTTP layer.

No network and no real token: a fake GitHub contents API in memory stands in for api.github.com. Checks that
  * the branch is created from the base branch when missing, and files are created, then updated with their sha;
  * a stale sha (409) is re-read once; a rejected token (401) disables pushing without raising;
  * the token is sent only in the Authorization header and never appears in output, repr, progress.jsonl or
    pushed content;
  * Progress pushes progress.jsonl and new or changed small results/*.json files, and records errors with
    tracebacks, and laya-train's loss lines.

Run: python -I colab/test_progress_push.py
"""
from __future__ import annotations

import ast
import base64
import contextlib
import hashlib
import io
import json
import pathlib
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
TOKEN = "github_pat_TEST_ONLY_not_a_real_token_0123456789"


def cell_source() -> str:
    tree = ast.parse((HERE / "make_notebook.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "PROGRESS_CELL" for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("PROGRESS_CELL not found in make_notebook.py")


class Resp:
    def __init__(self, status, body):
        self.status, self._b = status, json.dumps(body).encode() if body is not None else b""

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeGitHub:
    """Just enough of the REST API: git refs and repository contents on branches."""

    def __init__(self, token, branches=("research/laya-proper",)):
        self.token = token
        self.refs = {b: hashlib.sha1(b.encode()).hexdigest() for b in branches}
        self.files = {}  # (branch, path) -> (sha, bytes)
        self.calls = []
        self.fail_next_put_with = None

    def __call__(self, req: urllib.request.Request, timeout=None):
        url = urllib.parse.urlsplit(req.full_url)
        assert url.scheme == "https" and url.netloc == "api.github.com", req.full_url
        hdrs = {k.lower(): v for k, v in req.header_items()}
        self.calls.append((req.get_method(), url.path, hdrs.get("authorization")))
        if hdrs.get("authorization") != f"Bearer {self.token}":
            raise urllib.error.HTTPError(req.full_url, 401, "Bad credentials", {}, io.BytesIO(b'{"message": "Bad credentials"}'))
        assert TOKEN not in req.full_url
        body = json.loads(req.data) if req.data else None
        if body is not None:
            assert TOKEN not in json.dumps(body)
        path, m = url.path, req.get_method()
        pre = "/repos/kambasana/56/"
        assert path.startswith(pre), path
        rest = path[len(pre):]

        def err(code, msg):
            return urllib.error.HTTPError(req.full_url, code, msg, {}, io.BytesIO(json.dumps({"message": msg}).encode()))

        if rest.startswith("git/ref/heads/") and m == "GET":
            b = rest[len("git/ref/heads/"):]
            if b not in self.refs:
                raise err(404, "Not Found")
            return Resp(200, {"ref": f"refs/heads/{b}", "object": {"sha": self.refs[b]}})
        if rest == "git/refs" and m == "POST":
            b = body["ref"][len("refs/heads/"):]
            if b in self.refs:
                raise err(422, "Reference already exists")
            self.refs[b] = body["sha"]
            return Resp(201, {"ref": body["ref"]})
        if rest.startswith("contents/"):
            p = urllib.parse.unquote(rest[len("contents/"):])
            if m == "GET":
                b = urllib.parse.parse_qs(url.query)["ref"][0]
                if (b, p) not in self.files:
                    raise err(404, "Not Found")
                return Resp(200, {"sha": self.files[(b, p)][0], "path": p})
            if m == "PUT":
                b = body["branch"]
                assert b in self.refs, "branch must exist before writing"
                if self.fail_next_put_with:
                    code, self.fail_next_put_with = self.fail_next_put_with, None
                    raise err(code, "sha does not match")
                cur = self.files.get((b, p))
                if cur and body.get("sha") != cur[0]:
                    raise err(409, "sha does not match")
                if not cur and body.get("sha"):
                    raise err(422, "sha given for a new file")
                data = base64.b64decode(body["content"])
                sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
                self.files[(b, p)] = (sha, data)
                return Resp(201 if not cur else 200, {"content": {"sha": sha, "path": p}})
        raise err(404, f"unhandled {m} {path}")


def load_cell():
    ns = {"REPO": "kambasana/56", "SUBDIR": "experiments/release-triage", "SMOKE": False, "time": time, "json": json,
          "hashlib": hashlib, "pathlib": pathlib, "urllib": urllib}
    exec(compile(cell_source(), "progress_cell", "exec"), ns)  # no google.colab here: GH_TOKEN reads as absent
    assert ns["PROGRESS"].pusher is None, "without google.colab the cell must run with pushing off"
    return ns


def main() -> None:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        ns = load_cell()
        gh = FakeGitHub(TOKEN)
        pusher = ns["GitHubPusher"](TOKEN, "kambasana/56", "results/laya-colab", "research/laya-proper", "", opener=gh)
        assert TOKEN not in repr(pusher)
        prog = ns["Progress"](pusher)
        ns["PROGRESS"] = prog  # the cell's helpers (train_progress, the post-run hook) use this global
        prog.begin("gpu")  # before bind: buffered, nothing pushed
        assert not gh.calls
        with tempfile.TemporaryDirectory() as d:
            res = pathlib.Path(d) / "results"
            res.mkdir()
            prog.bind(res, "20261010T000000Z-abc123")
            assert pusher.prefix == "experiments/release-triage/colab-runs/20261010T000000Z-abc123"
            prog.ctx["gpu"] = "NVIDIA A100-SXM4-40GB"
            (res / "env.json").write_text('{"gpu": "A100"}\n')
            (res / "big.json").write_text("x" * (ns["SMALL_FILE_BYTES"] + 1))
            prog.end("gpu")  # stage end pushes
            br = "results/laya-colab"
            assert br in gh.refs and gh.refs[br] == gh.refs["research/laya-proper"], "branch created from base"
            base = pusher.prefix
            assert (br, f"{base}/progress.jsonl") in gh.files
            assert (br, f"{base}/results/env.json") in gh.files
            assert (br, f"{base}/results/big.json") not in gh.files, "large files are not pushed"
            n_calls = len(gh.calls)
            prog.push()  # nothing changed: no writes
            assert not [c for c in gh.calls[n_calls:] if c[0] == "PUT"]

            # Training lines, an update of an existing file, and a stale sha that must be re-read once.
            assert ns["train_progress"]("F-EN-s0", "epoch 2/13 step 300 loss 0.4123\n")
            assert ns["train_progress"]("F-EN-s0", "epoch 2/13 mean loss 0.3999\n")
            assert not ns["train_progress"]("F-EN-s0", "train items 5400, calibration items 400\n")
            (res / "env.json").write_text('{"gpu": "A100", "v": 2}\n')
            pusher._shas[f"{base}/results/env.json"] = "0" * 40  # stale
            prog.push()
            assert gh.files[(br, f"{base}/results/env.json")][1] == b'{"gpu": "A100", "v": 2}\n'
            lines = [json.loads(l) for l in gh.files[(br, f"{base}/progress.jsonl")][1].decode().splitlines()]
            steps = [l for l in lines if l["event"] == "train_step"]
            assert steps and steps[0]["epoch"] == 2 and steps[0]["step"] == 300 and abs(steps[0]["loss"] - 0.4123) < 1e-9
            assert steps[0]["gpu"] == "NVIDIA A100-SXM4-40GB" and steps[0]["run_tag"] == "20261010T000000Z-abc123"
            assert any(l["event"] == "epoch_end" and abs(l["loss"] - 0.3999) < 1e-9 for l in lines)
            assert lines[0]["event"] == "stage_start" and lines[0]["stage"] == "gpu", "pre-bind lines kept"

            # A 422 on PUT is retried once with a fresh sha.
            gh.fail_next_put_with = 422
            (res / "metrics_F-EN-s0.json").write_text('{"macro_recall": 0.5}\n')
            prog.push()
            assert (br, f"{base}/results/metrics_F-EN-s0.json") in gh.files

            # Errors carry the traceback and are pushed at once.
            try:
                raise SystemExit("F-EN-s0: laya-train exited 1")
            except SystemExit as e:
                prog.error(e)
            lines = [json.loads(l) for l in gh.files[(br, f"{base}/progress.jsonl")][1].decode().splitlines()]
            last = lines[-1]
            assert last["event"] == "error" and "laya-train exited 1" in last["error"] and "Traceback" in last["traceback"]

            # progress.jsonl on Drive matches what was pushed; the token appears nowhere.
            local = (res / "progress.jsonl").read_text()
            assert local == gh.files[(br, f"{base}/progress.jsonl")][1].decode()
            for (_, _), (_, data) in gh.files.items():
                assert TOKEN.encode() not in data
            assert TOKEN not in local
            assert all(c[2] == f"Bearer {TOKEN}" for c in gh.calls), "token only in the Authorization header"

            # A rejected token disables pushing without raising; the run goes on.
            bad = ns["GitHubPusher"]("wrong-token", "kambasana/56", "results/laya-colab", "research/laya-proper", "x", opener=gh)
            assert bad.put("a.json", b"{}", "m") is False and bad.enabled is False
            assert bad.put("a.json", b"{}", "m") is False
            # A network error is reported by type only and does not raise.
            def boom(req, timeout=None):
                raise OSError("connection reset; " + req.get_header("Authorization"))
            net = ns["GitHubPusher"](TOKEN, "kambasana/56", "results/laya-colab", "research/laya-proper", "x", opener=boom)
            assert net.put("a.json", b"{}", "m") is False and TOKEN not in (net.last_error or "")
    printed = out.getvalue()
    assert TOKEN not in printed, "token printed"
    print(printed, end="")
    print(f"OK: {len(gh.calls)} mocked API calls, {len(gh.files)} files on the fake branch; token never printed or pushed")


if __name__ == "__main__":
    main()
