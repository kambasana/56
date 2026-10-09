"""Step 3: fetch one record per candidate release (positives and negatives through the same code).

For each release we keep:
  * the registry packument trimmed to versions published at or before the release (`as_of`). Positives with a
    DataDog archive use the packument DataDog captured at detection (package_info-*.json in the zip); every other
    row uses today's registry packument. Both are the npm registry's own document; `deprecated` (added after the
    fact) and e-mails are dropped.
  * the published contents of the release: the DataDog archive for DataDog positives, the registry tarball for
    everything else. Only a summary is kept (file list and sizes, package.json, install-script files, README head).
  * the contents of the previous release (registry tarball). If the previous release is no longer served, the
    row is dropped for both classes alike (`prev_unavailable`): for a positive it usually means an earlier bad
    release existed, so this one is not the first bad release.
  * first-publish time of each runtime dependency added since the previous release (registry), for the
    rule scorer's dependency_added signal.

Usage: python -I src/fetch.py --candidates data/positive_candidates.jsonl [--workers 8]
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import sys
import pathlib
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import (DD_COMMIT, DD_REPO, as_of, cache_path, contents_from_dd_zip, http_get, read_json_gz,
                    registry_contents, registry_packument, write_json_gz)

lock = threading.Lock()


def dd_url(path: str) -> str:
    from urllib.parse import quote
    return f"https://raw.githubusercontent.com/{DD_REPO}/{DD_COMMIT}/{quote(path)}"


def _loose(v: str) -> list[int]:
    out = []
    for x in v.split("-")[0].split("+")[0].split("."):
        try:
            out.append(int(x))
        except ValueError:
            out.append(0)
    return out


def _cmp(a: str, b: str) -> int:
    pa, pb = _loose(a), _loose(b)
    n = max(len(pa), len(pb))
    pa, pb = pa + [0] * (n - len(pa)), pb + [0] * (n - len(pb))
    return (pa > pb) - (pa < pb)


def prev_release(asof: dict, version: str) -> str | None:
    """Same rule as the product (blastradius/src/enrich/npm/packument.ts previousRelease): the newest version
    published before this one that is lower in semver order. When no earlier version is lower (a backport line
    started after a higher one), fall back to the newest earlier-published version."""
    t = asof["time"]
    me = t.get(version)
    earlier = sorted(((ts, v) for v, ts in t.items() if v != version and ts < me), reverse=True)
    for _, v in earlier:
        if _cmp(v, version) < 0:
            return v
    return earlier[0][1] if earlier else None


def dep_first_published(name: str) -> str | None:
    p = registry_packument(name)
    if not p:
        return None
    ts = [v for k, v in (p.get("time") or {}).items() if k not in ("created", "modified")]
    return min(ts) if ts else (p.get("time") or {}).get("created")


def build(c: dict) -> dict:
    key = f"{c['label']}:{c['name']}@{c['version']}"
    out = {k: c[k] for k in c}
    out["key"] = key
    if c["content_source"] == "datadog-archive":
        raw = http_get(dd_url(c["dd_path"]), timeout=300)
        if raw is None:
            return {**out, "drop": "archive_missing"}
        out["archive_sha256"] = hashlib.sha256(raw).hexdigest()
        contents, pack = contents_from_dd_zip(raw)
        del raw
        contents["source"] = "datadog-archive"
        out["packument_source"] = "datadog-captured"
    else:
        pack = registry_packument(c["name"])
        out["packument_source"] = "registry"
        contents = None
    if not pack or c["version"] not in pack["versions"] or c["version"] not in pack["time"]:
        return {**out, "drop": "no_registry_manifest_for_release"}
    published = pack["time"][c["version"]]
    asof = as_of(pack, published)
    out["published"] = published
    doc = asof["versions"][c["version"]]
    if contents is None:
        contents = registry_contents(c["name"], c["version"], (doc.get("dist") or {}).get("tarball"))
        if contents is None or "error" in contents:
            return {**out, "drop": "tarball_unavailable"}
    if not contents.get("package_json"):
        return {**out, "drop": "no_package_json_in_contents"}
    out["contents"] = contents
    out["asof"] = asof
    return with_prev(out)


def with_prev(out: dict) -> dict:
    """Previous-release part of a record (re-runnable on a cached record)."""
    out = {k: v for k, v in out.items() if k not in ("prev_contents", "prev_version", "added_deps_first_published", "drop")}
    c, asof = out, out["asof"]
    doc = asof["versions"][c["version"]]
    pv = prev_release(asof, c["version"])
    out["prev_version"] = pv
    if pv is not None:
        pdoc = asof["versions"].get(pv)
        if pdoc is None:
            return {**out, "drop": "prev_unavailable"}
        live = registry_packument(c["name"])
        if not live or pv not in live["versions"]:
            return {**out, "drop": "prev_unavailable"}
        pc = registry_contents(c["name"], pv, (pdoc.get("dist") or {}).get("tarball"))
        if pc is None or "error" in pc or not pc.get("package_json"):
            return {**out, "drop": "prev_unavailable"}
        out["prev_contents"] = pc
        added = sorted(set((doc.get("dependencies") or {})) - set((pdoc.get("dependencies") or {})))
    else:
        added = sorted((doc.get("dependencies") or {}))
    out["added_deps_first_published"] = {d: dep_first_published(d) for d in added[:20]}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    cands = [json.loads(l) for l in open(a.candidates)]
    todo = []
    for c in cands:
        cp = cache_path("records", f"{c['label']}:{c['name']}@{c['version']}")
        if not cp.exists():
            todo.append((c, cp))
            continue
        r = read_json_gz(cp)  # cached: redo only the previous-release part if the rule changed
        if "asof" in r and "contents" in r and r.get("prev_version", "-") != prev_release(r["asof"], r["version"]):
            todo.append((r, cp))
    print(f"{len(cands)} candidates, {len(todo)} to fetch", flush=True)
    stats = collections.Counter()
    done = 0
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(with_prev if "asof" in c else build, c): (c, cp) for c, cp in todo}
        for f in as_completed(futs):
            c, cp = futs[f]
            try:
                rec = f.result()
            except Exception as e:
                stats["error"] += 1
                print("ERR", c["name"], c["version"], str(e)[:200], flush=True)
                continue
            write_json_gz(cp, rec)
            stats[rec.get("drop", "ok")] += 1
            done += 1
            if done % 50 == 0:
                print(done, dict(stats), flush=True)
    print("done", dict(stats))


if __name__ == "__main__":
    main()
