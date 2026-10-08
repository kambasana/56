"""Run GuardDog (static only) over a target list and write one JSON line per target.

Usage:
  python3 -I scan.py --guarddog <venv>/bin/guarddog --targets targets.json --out results.jsonl \
      --cache <dir for downloaded tarballs> --tmp <scratch dir for GuardDog extraction> [--jobs 4]
      [--exclude rule,rule] [--only ids.json]

targets.json rows: {"id", "name", "version", "kind": "tgz"|"zip", "url" (tgz) or "path" (zip)}.

Safety: nothing is installed, imported or executed. Tarballs are downloaded to --cache and
handed to `guarddog npm scan`, which extracts them itself (inside its kernel sandbox) under
--tmp. Dataset zips are encrypted with the public password "infected" and are likewise
extracted only by GuardDog under --tmp. Results keep rule names, severities and file paths,
never matched code. Resumable: ids already in --out are skipped.
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import threading
import time
import urllib.request

LOCK = threading.Lock()


def download(url, cache):
    name = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("registry.npmjs.org/", 1)[-1])
    dest = os.path.join(cache, name)
    if not os.path.exists(dest):
        part = dest + ".part"
        for delay in (0, 2, 4, 8):
            time.sleep(delay)
            try:
                with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
                    f.write(r.read())
                os.replace(part, dest)
                break
            except Exception as e:  # noqa: BLE001 - retried, then recorded
                err = e
        else:
            raise RuntimeError(f"download failed: {err}")
    return dest


def scan_one(t, args):
    row = {k: t[k] for k in ("id", "name", "version", "kind")}
    try:
        cmd = [args.guarddog, "npm", "scan"]
        if t["kind"] == "tgz":
            target = download(t["url"], args.cache)
        else:
            target = t["path"]
            cmd += ["--zip-password", "infected"]
        for rule in args.exclude:
            cmd += ["-x", rule]
        cmd += [target, "--output-format", "json"]
        env = dict(os.environ, TMPDIR=args.tmp)
        start = time.monotonic()
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env, cwd=args.tmp)
        row["scan_seconds"] = round(time.monotonic() - start, 3)
        row["bytes"] = os.path.getsize(target)
        out = json.loads(p.stdout)
        rs = out.get("risk_score") or {}
        row["label"] = rs.get("label")
        row["score"] = rs.get("score")
        row["rules_matched"] = {k: len(v) for k, v in (out.get("results") or {}).items() if v}
        row["risks"] = [
            {"threat_rule": r.get("threat_rule"), "capability_rule": r.get("capability_rule"),
             "severity": r.get("severity"), "category": r.get("category"),
             "file": re.sub(r"^tmp/tmp[^/]+/", "", r.get("file_path") or "")}
            for r in out.get("risks") or []
        ]
        row["errors"] = out.get("errors") or {}
    except Exception as e:  # noqa: BLE001 - recorded per target
        row["error"] = str(e)[:300]
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--guarddog", required=True)
    ap.add_argument("--targets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--tmp", required=True)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--exclude", default="", help="comma-separated GuardDog rules to exclude")
    ap.add_argument("--only", help="JSON list of ids to scan (subset of --targets)")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.tmp, exist_ok=True)
    args.exclude = [r for r in args.exclude.split(",") if r]
    targets = json.load(open(args.targets))
    if args.only:
        only = set(json.load(open(args.only)))
        targets = [t for t in targets if t["id"] in only]
    done = set()
    if os.path.exists(args.out):
        for line in open(args.out):
            r = json.loads(line)
            if "error" not in r:
                done.add(r["id"])
    todo = [t for t in targets if t["id"] not in done]
    print(f"{len(targets)} targets, {len(done)} done, {len(todo)} to scan", flush=True)
    n = 0
    with open(args.out, "a") as out, cf.ThreadPoolExecutor(args.jobs) as ex:
        for row in ex.map(lambda t: scan_one(t, args), todo):
            with LOCK:
                out.write(json.dumps(row) + "\n")
                out.flush()
            n += 1
            if n % 100 == 0:
                print(f"{n}/{len(todo)}", flush=True)


if __name__ == "__main__":
    main()
