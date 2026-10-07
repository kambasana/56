"""Fetch npm packuments into a local cache, slimmed to what src/features reads.

    python pack/model/fetch_packuments.py --names names.txt --cache .cache/packuments [--workers 16]

Only registry.npmjs.org is contacted. Each file keeps `name`, `time`, `dist-tags` and, per
version: `_npmUser` (name, trustedPublisher), `maintainers` (names only, no e-mails), install
hooks from `scripts`, `gypfile`, `dependencies`, `optionalDependencies` and
`dist.attestations`. Existing cache files are kept (delete them to refresh). Failures are
listed in <cache>/_failures.json and never fatal.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

REGISTRY = "https://registry.npmjs.org/"
HOOKS = ("preinstall", "install", "postinstall")
# Same politeness as the engine's HttpClient (src/core/http.ts DEFAULT_HOST_INTERVALS).
MIN_INTERVAL_S = 0.020
_gate = threading.Lock()
_next = [0.0]


def _wait_turn() -> None:
    with _gate:
        now = time.monotonic()
        at = max(now, _next[0])
        _next[0] = at + MIN_INTERVAL_S
    if at > now:
        time.sleep(at - now)


def cache_file(cache: str, name: str) -> str:
    return os.path.join(cache, name.replace("/", "__", 1) + ".json")


def slim(p: dict) -> dict:
    versions = {}
    for v, m in (p.get("versions") or {}).items():
        if not isinstance(m, dict):
            continue
        out: dict = {"name": m.get("name"), "version": v}
        user = m.get("_npmUser")
        if isinstance(user, dict):
            u = {"name": user.get("name")}
            if user.get("trustedPublisher") is not None:
                u["trustedPublisher"] = True
            out["_npmUser"] = u
        maint = m.get("maintainers")
        if isinstance(maint, list):
            names = []
            for x in maint:
                if isinstance(x, dict) and isinstance(x.get("name"), str):
                    names.append({"name": x["name"]})
                elif isinstance(x, str):
                    names.append(x.split("<")[0].strip())
            out["maintainers"] = names
        scripts = m.get("scripts")
        if isinstance(scripts, dict):
            hooks = {k: scripts[k] for k in HOOKS if isinstance(scripts.get(k), str)}
            if hooks:
                out["scripts"] = hooks
        if m.get("gypfile") is True:
            out["gypfile"] = True
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            if isinstance(m.get(field), dict):
                out[field] = m[field]
        dist = m.get("dist")
        if isinstance(dist, dict) and isinstance(dist.get("attestations"), dict):
            out["dist"] = {"attestations": dist["attestations"]}
        versions[v] = out
    return {"name": p.get("name"), "dist-tags": p.get("dist-tags") or {}, "time": p.get("time") or {}, "versions": versions}


def fetch(name: str, cache: str, retries: int = 4) -> str | None:
    """Returns None on success, else an error string."""
    path = cache_file(cache, name)
    if os.path.exists(path):
        return None
    url = REGISTRY + urllib.parse.quote(name, safe="@")
    delay = 2.0
    for attempt in range(retries):
        try:
            _wait_turn()
            req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "blastradius-bootstrap"})
            with urllib.request.urlopen(req, timeout=120) as r:
                p = json.load(r)
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(slim(p), f, separators=(",", ":"))
            os.replace(tmp, path)
            return None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "404"
            err = f"HTTP {e.code}"
        except Exception as e:  # network errors: retry with backoff
            err = type(e).__name__
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    return err


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--names", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    names = sorted({l.strip() for l in open(a.names) if l.strip()})
    failures: dict[str, str] = {}
    done = 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(fetch, n, a.cache): n for n in names}
        for fut in cf.as_completed(futs):
            err = fut.result()
            if err:
                failures[futs[fut]] = err
            done += 1
            if done % 200 == 0:
                print(f"{done}/{len(names)}", file=sys.stderr)
    fail_path = os.path.join(a.cache, "_failures.json")
    old = json.load(open(fail_path)) if os.path.exists(fail_path) else {}
    old.update(failures)
    for n in names:
        if n not in failures:
            old.pop(n, None)
    with open(fail_path, "w") as f:
        json.dump(old, f, indent=1, sort_keys=True)
    print(json.dumps({"requested": len(names), "failed": len(failures)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
