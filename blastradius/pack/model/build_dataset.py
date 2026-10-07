"""Build the training set: one row per release, features from the shared TS module.

    python pack/model/build_dataset.py --root . --cache .cache/packuments \
        --universe out/universe --out out/dataset [--cutoff 2023-01-01] [--known-bad bad.json]

* Features come only from `tsx src/features/cli.ts releases` (the same code scan time uses), as of
  each release + 1 hour. The vector does not change later (no hindsight; see src/features).
* Packages: incidents.txt + negatives.txt from universe.py. controls.txt (the Acme org lockfiles)
  is never trained on: it is the noise set of the backtest gate.
* Labels: a release is positive when a recorded incident (test/replay/incidents.config.json) names
  it. npm unpublished those releases; their manifests come from the replay overlay, which cites
  the advisory each was rebuilt from. Every other release is negative, except versions listed in
  --known-bad (OSV MAL-* / CWE-506 versions, e.g. from the pack), which are dropped because they are
  bad but have no incident record of their own.
* Split (docs/DATA-ML.md base-rate warning): by time and campaign. Releases before --cutoff train,
  the rest test. An incident must fall wholly on one side, so one campaign cannot leak across.
* Labels or packuments that cannot be obtained are dropped and listed in report.json.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="the blastradius/ directory")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--universe", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cutoff", default="2023-01-01T00:00:00Z")
    ap.add_argument("--known-bad", help='JSON {"name": ["version", ...]} of other known-bad releases to drop')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    root = os.path.abspath(a.root)
    replay = os.path.join(root, "test", "replay")
    cfg = json.load(open(os.path.join(replay, "incidents.config.json")))
    bad: dict[tuple[str, str], str] = {}
    for inc in cfg["incidents"]:
        for b in inc["bad"]:
            bad[(b["name"], b["version"])] = inc["id"]
    known_bad: dict[str, set[str]] = {}
    if a.known_bad:
        known_bad = {k: set(v) for k, v in json.load(open(a.known_bad)).items()}

    read = lambda f: [l.strip() for l in open(os.path.join(a.universe, f)) if l.strip()]
    controls = set(read("controls.txt"))
    incidents = read("incidents.txt")
    negatives = [n for n in read("negatives.txt") if n not in controls]
    names = sorted(set(incidents) | set(negatives))
    names_file = os.path.join(a.out, "names.txt")
    with open(names_file, "w") as f:
        f.write("".join(n + "\n" for n in names))

    schema = json.loads(subprocess.run(["npx", "tsx", "src/features/cli.ts", "schema"], cwd=root, check=True, capture_output=True, text=True).stdout)
    proc = subprocess.run(
        ["npx", "tsx", "src/features/cli.ts", "releases", "--cache", os.path.abspath(a.cache), "--overlay", os.path.join(replay, "data", "registry"), "--names", os.path.abspath(names_file), "--offset-ms", "3600000"],
        cwd=root, check=True, capture_output=True, text=True,
    )
    rows = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    have_pkg = {r["name"] for r in rows}

    out_rows = []
    dropped_known_bad = 0
    for r in rows:
        key = (r["name"], r["version"])
        if key in bad:
            r["label"], r["incident"] = 1, bad[key]
        elif r["version"] in known_bad.get(r["name"], ()):
            dropped_known_bad += 1
            continue
        else:
            r["label"], r["incident"] = 0, None
        r["group"] = r["incident"] or f"pkg:{r['name']}"
        r["split"] = "train" if r["releasedAt"] < a.cutoff else "test"
        out_rows.append(r)

    # Campaign integrity: an incident must not straddle the cutoff.
    sides: dict[str, set[str]] = {}
    for r in out_rows:
        if r["incident"]:
            sides.setdefault(r["incident"], set()).add(r["split"])
    straddle = sorted(i for i, s in sides.items() if len(s) > 1)
    if straddle:
        print(f"incidents straddle the cutoff: {straddle}", file=sys.stderr)
        return 1

    found = {(r["name"], r["version"]) for r in out_rows if r["label"] == 1}
    dropped_labels = [{"name": n, "version": v, "incident": i, "reason": "no packument" if n not in have_pkg else "no manifest (not recorded or reconstructed)"} for (n, v), i in sorted(bad.items()) if (n, v) not in found]
    missing_packuments = sorted(set(names) - have_pkg)

    with open(os.path.join(a.out, "dataset.jsonl"), "w") as f:
        for r in out_rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    report = {
        "featureSchema": schema["schema"],
        "featureNames": schema["names"],
        "cutoff": a.cutoff,
        "packages": {"requested": len(names), "withPackument": len(have_pkg), "missing": missing_packuments, "controlsExcluded": len(controls)},
        "rows": {
            split: {"total": sum(1 for r in out_rows if r["split"] == split), "positive": sum(1 for r in out_rows if r["split"] == split and r["label"] == 1)}
            for split in ("train", "test")
        },
        "positivesByIncident": {i: sorted(f"{r['name']}@{r['version']}" for r in out_rows if r["incident"] == i) for i in sorted(sides)},
        "incidentSplit": {i: sorted(s)[0] for i, s in sorted(sides.items())},
        "droppedLabels": dropped_labels,
        "droppedKnownBadNegatives": dropped_known_bad,
    }
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: report[k] for k in ("rows", "incidentSplit")}, indent=1))
    print(json.dumps({"droppedLabels": len(dropped_labels), "missingPackuments": len(missing_packuments)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
