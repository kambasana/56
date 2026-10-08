"""Build the training set: one row per release, features from the shared TS module.

    python pack/model/build_dataset.py --root . --cache .cache/packuments --downloads .cache/downloads \
        --labels out/labels --negatives out/universe/negatives.txt --negatives out/universe/hammer.txt \
        --controls out/universe/controls.txt --out out/dataset [--cutoff 2025-09-01]

* Features come only from `tsx src/features/cli.ts rows --allow-missing-manifest --downloads ...`
  (the code scan time uses), as of each release + 1 hour. Vectors do not change later (no hindsight).
* Positives: labels.jsonl from labels.py (compromised releases of established packages, with
  campaign). Most were unpublished by npm, so they have a `time` entry but no manifest: the CLI
  describes them from the history before them and leaves the manifest features NaN (row
  `manifest: false`). The replay overlay supplies the 16 manifests rebuilt from advisories.
* Negatives: every other release, in the positives' time range, of (a) the negative package lists
  (--negatives: the dependency walk from the Acme lockfiles and the hammer control repos' lockfiles)
  and (b) the positive packages themselves, minus every version any source lists as bad
  (known_bad.json) and minus whole-package malware. The Acme lockfile packages (--controls) are the
  gate's noise set and are never trained on, except positive packages.
* External features: downloads are historical (api.npmjs.org range API, window before the release).
  Scorecard, deps.dev dependents and typosquat distance have no as-of history here, so they are not
  supplied and stay NaN for every row (never today's value on a past release).
* Split hint (`split`): by time and campaign. A campaign goes wholly to the side of its first
  release, so one wave cannot be on both sides; training may regroup by `campaign`.

Writes dataset.jsonl.gz, requests.jsonl.gz and report.json. Nothing here touches the network.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import os
import subprocess
import sys

OFFSET_MS = 3_600_000


def load_packument(cache: str, name: str):
    f = os.path.join(cache, name.replace("/", "__", 1) + ".json")
    if not os.path.exists(f):
        return None
    try:
        return json.load(open(f))
    except ValueError:
        return None


def parse_t(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="the blastradius/ directory")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--downloads")
    ap.add_argument("--labels", required=True, help="output dir of labels.py")
    ap.add_argument("--negatives", action="append", default=[], help="file of package names (repeatable)")
    ap.add_argument("--controls", help="Acme lockfile packages: never trained on")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cutoff", default="2026-01-01T00:00:00Z")
    ap.add_argument("--max-per-package-year", type=int, default=12, help="negatives sampled per package and calendar year (deterministic, by hash)")
    ap.add_argument("--requests-only", action="store_true", help="write requests.jsonl (for fetch_downloads.py) and stop")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    root = os.path.abspath(a.root)
    overlay = os.path.join(root, "test", "replay", "data", "registry")

    positives = [json.loads(l) for l in open(os.path.join(a.labels, "labels.jsonl")) if l.strip()]
    kb = json.load(open(os.path.join(a.labels, "known_bad.json")))
    known_bad = {n: set(vs) for n, vs in kb["bad"].items()}
    whole = set(kb["wholePackage"])
    pos_key = {(r["name"], r["version"]): r for r in positives}
    t_lo = min(parse_t(r["publishedAt"]) for r in positives)
    t_hi = max(parse_t(r["publishedAt"]) for r in positives)

    read = lambda f: [l.strip() for l in open(f) if l.strip()]
    controls = set(read(a.controls)) if a.controls else set()
    pos_pkgs = sorted({r["name"] for r in positives})
    neg_lists = {os.path.basename(f): read(f) for f in a.negatives}
    neg_pkgs = sorted({n for ns in neg_lists.values() for n in ns} - controls - whole - set(pos_pkgs))
    dropped_pkgs: dict[str, str] = {}

    requests = []
    for name in sorted(set(pos_pkgs) | set(neg_pkgs)):
        p = load_packument(a.cache, name)
        if p is None and os.path.exists(os.path.join(overlay, name.replace("/", "__", 1) + ".json")):
            p = load_packument(overlay, name)
        if p is None:
            dropped_pkgs[name] = "no packument (404 or fetch failed)"
            continue
        versions = p.get("versions") or {}
        for v, t in (p.get("time") or {}).items():
            if v in ("created", "modified", "unpublished") or not isinstance(t, str):
                continue
            ts = parse_t(t)
            if ts is None:
                continue
            if (name, v) in pos_key:
                continue  # added below with its label
            if v in known_bad.get(name, ()):
                continue
            if not (t_lo <= ts <= t_hi):
                continue
            has_manifest = isinstance(versions.get(v), dict)
            requests.append({"name": name, "version": v, "releasedAt": t, "label": 0, "campaign": None, "source": "negative" if name in neg_pkgs else "positive-package", "manifest": has_manifest})
    # Sample negatives: at most N per package and year, chosen by a hash of name@version, so the
    # same inputs give the same rows and fast-releasing packages do not dominate.
    cells = collections.defaultdict(list)
    for r in requests:
        cells[(r["name"], r["releasedAt"][:4])].append(r)
    before_sampling = len(requests)
    requests = [r for rs in cells.values() for r in sorted(rs, key=lambda r: hashlib.sha256(f"{r['name']}@{r['version']}".encode()).hexdigest())[: a.max_per_package_year]]
    unpublished_neg = sum(1 for r in requests if not r["manifest"])
    for r in positives:
        requests.append({"name": r["name"], "version": r["version"], "releasedAt": r["publishedAt"], "manifest": r["manifest"], "label": 1, "campaign": r["campaign"], "source": "+".join(sorted({s.split(":")[0] for s in r["sources"]}))})
    for r in requests:
        r["asOf"] = (parse_t(r["releasedAt"]) + dt.timedelta(milliseconds=OFFSET_MS)).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    requests.sort(key=lambda r: (r["name"], r["releasedAt"], r["version"]))
    req_path = os.path.join(a.out, "requests.jsonl")
    with open(req_path, "w") as f:
        for r in requests:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")

    if a.requests_only:
        print(json.dumps({"requests": len(requests), "positive": sum(r["label"] for r in requests), "packages": len({r["name"] for r in requests}), "negativeWithoutManifest": unpublished_neg, "droppedPackages": len(dropped_pkgs), "negativesBeforeSampling": before_sampling}))
        return 0
    schema = json.loads(subprocess.run(["npx", "tsx", "src/features/cli.ts", "schema"], cwd=root, check=True, capture_output=True, text=True).stdout)
    cmd = ["npx", "tsx", "src/features/cli.ts", "rows", "--cache", os.path.abspath(a.cache), "--overlay", overlay, "--allow-missing-manifest", "--requests", os.path.abspath(req_path)]
    if a.downloads:
        cmd += ["--downloads", os.path.abspath(a.downloads)]
    cutoff = parse_t(a.cutoff)
    first_of = collections.defaultdict(lambda: None)
    for r in positives:
        t = parse_t(r["publishedAt"])
        if first_of[r["campaign"]] is None or t < first_of[r["campaign"]]:
            first_of[r["campaign"]] = t

    counts = collections.Counter()
    dropped_rows = collections.Counter()
    dropped_pos = []
    feat_known = collections.Counter()
    pos_by_campaign = collections.Counter()
    by_year = collections.defaultdict(collections.Counter)
    names = schema["names"]
    out_path = os.path.join(a.out, "dataset.jsonl.gz")
    with subprocess.Popen(cmd, cwd=root, stdout=subprocess.PIPE, text=True) as proc, gzip.open(out_path + ".tmp", "wt", compresslevel=6) as out:
        for line in proc.stdout:
            r = json.loads(line)
            if r.get("features") is None:
                dropped_rows[r.get("dropped", "unknown")] += 1
                if r["label"] == 1:
                    dropped_pos.append({"name": r["name"], "version": r["version"], "reason": r.get("dropped")})
                continue
            t = parse_t(r["releasedAt"])
            side_t = first_of[r["campaign"]] if r["label"] == 1 else t
            r["split"] = "train" if side_t < cutoff else "test"
            r["group"] = f"campaign:{r['campaign']}" if r["label"] == 1 else f"pkg:{r['name']}"
            counts[(r["split"], r["label"], r["manifest"])] += 1
            by_year[r["releasedAt"][:4]][r["label"]] += 1
            if r["label"] == 1:
                pos_by_campaign[r["campaign"]] += 1
            for i, x in enumerate(r["features"]):
                if x is not None:
                    feat_known[(names[i], r["label"])] += 1
            out.write(json.dumps(r, separators=(",", ":")) + "\n")
        if proc.wait() != 0:
            print("features CLI failed", file=sys.stderr)
            return 1
    os.replace(out_path + ".tmp", out_path)
    with open(req_path, "rb") as f, gzip.open(req_path + ".gz", "wb") as g:
        g.write(f.read())
    os.remove(req_path)

    n_pos = sum(v for (s, l, m), v in counts.items() if l == 1)
    n_neg = sum(v for (s, l, m), v in counts.items() if l == 0)
    report = {
        "featureSchema": schema["schema"],
        "featureNames": names,
        "manifestFeatures": schema["manifestFeatures"],
        "asOfOffsetMs": OFFSET_MS,
        "timeRange": [t_lo.isoformat(), t_hi.isoformat()],
        "cutoff": a.cutoff,
        "packages": {"positive": len(pos_pkgs), "negativeLists": {k: len(v) for k, v in neg_lists.items()}, "negative": len(neg_pkgs), "controlsExcluded": len(controls), "dropped": dropped_pkgs},
        "sampling": {"maxPerPackageYear": a.max_per_package_year, "negativeCandidates": before_sampling, "negativeRequests": sum(1 for r in requests if r["label"] == 0)},
        "rows": {"positive": n_pos, "negative": n_neg, "negativeWithoutManifest": sum(v for (s, l, m), v in counts.items() if l == 0 and not m), "positiveWithoutManifest": sum(v for (s, l, m), v in counts.items() if l == 1 and not m)},
        "split": {f"{s}/{'pos' if l else 'neg'}/{'manifest' if m else 'no-manifest'}": v for (s, l, m), v in sorted(counts.items())},
        "byYear": {y: {"neg": c[0], "pos": c[1]} for y, c in sorted(by_year.items())},
        "positivesByCampaign": dict(pos_by_campaign.most_common()),
        "campaignSplit": {c: ("train" if t < cutoff else "test") for c, t in sorted(first_of.items())},
        "featureCoverage": {n: {"pos": round(feat_known[(n, 1)] / max(n_pos, 1), 4), "neg": round(feat_known[(n, 0)] / max(n_neg, 1), 4)} for n in names},
        "droppedRows": dict(dropped_rows),
        "droppedPositives": dropped_pos,
    }
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: report[k] for k in ("rows", "split", "droppedRows")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
