"""Package universe for the bootstrap (docs/DATA-ML.md §1), as plain name lists.

    python pack/model/universe.py --replay test/replay --cache .cache/packuments --out out/universe

Writes:
  incidents.txt  packages named by the recorded incidents (positives and their history)
  controls.txt   every package in the Acme org lockfiles (the noise set; never trained on,
                 except packages that are also incident packages)
  negatives.txt  training negatives: packages the controls' latest releases depend on that are not
                 themselves controls, ranked by how many control packages use them (a stand-in for
                 "top packages by dependents" until deps.dev is reachable), capped at --max-negatives

negatives.txt is built from the packuments already in the cache: fetch controls.txt first, then
alternate universe.py and fetch_packuments.py on negatives.txt; each round walks one hop further.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os


def lockfile_packages(path: str) -> set[tuple[str, str]]:
    d = json.load(open(path))
    out: set[tuple[str, str]] = set()
    pk = d.get("packages") or {}
    for k, v in pk.items():
        if k and isinstance(v, dict) and "node_modules/" in k and isinstance(v.get("version"), str) and not v.get("link"):
            out.add((k.split("node_modules/")[-1], v["version"]))
    if not pk:
        def walk(deps):
            for n, v in (deps or {}).items():
                if isinstance(v, dict) and isinstance(v.get("version"), str):
                    out.add((n, v["version"]))
                    walk(v.get("dependencies"))
        walk(d.get("dependencies"))
    return out


def incident_names(replay: str) -> list[str]:
    cfg = json.load(open(os.path.join(replay, "incidents.config.json")))
    names: set[str] = set()
    for inc in cfg["incidents"]:
        names.update(b["name"] for b in inc["bad"])
        names.update(inc.get("packages", []))
    return sorted(names)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay", required=True, help="blastradius/test/replay")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-negatives", type=int, default=1500)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    incidents = incident_names(a.replay)
    controls: set[str] = set()
    for lock in sorted(glob.glob(os.path.join(a.replay, "data", "org", "*", "package-lock.json"))):
        controls.update(n for n, _ in lockfile_packages(lock))
    counts: collections.Counter[str] = collections.Counter()
    # Every cached packument votes (controls first, then negatives fetched in earlier rounds), so
    # re-running after each fetch walks one more hop out from the controls.
    for fname in sorted(os.listdir(a.cache)) if os.path.isdir(a.cache) else []:
        if not fname.endswith(".json") or fname.startswith("_"):
            continue
        p = json.load(open(os.path.join(a.cache, fname)))
        latest = (p.get("dist-tags") or {}).get("latest")
        m = (p.get("versions") or {}).get(latest) or {}
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            for dep in (m.get(field) or {}):
                counts[dep] += 1
    excluded = controls | set(incidents)
    ranked = sorted((n for n in counts if n not in excluded), key=lambda n: (-counts[n], n))
    negatives = ranked[: a.max_negatives]
    for fname, names in (("incidents.txt", incidents), ("controls.txt", sorted(controls)), ("negatives.txt", negatives)):
        with open(os.path.join(a.out, fname), "w") as f:
            f.write("".join(n + "\n" for n in names))
    print(json.dumps({"incidents": len(incidents), "controls": len(controls), "negatives": len(negatives), "negative_candidates": len(ranked)}))


if __name__ == "__main__":
    main()
