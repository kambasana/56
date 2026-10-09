"""Leakage check: no field may be systematically missing (or read differently) for one class.

Checks (all on data/features.csv.gz and data/{train,calib,test}.jsonl, after splitting):
  1. Missingness per feature by class. Fields that are empty by design for first releases (no previous release to
     compare with) are compared within non-first releases. FAIL if the missing-rate gap exceeds MAX_GAP.
  2. Content-reading parity: positives' contents come from DataDog archives, negatives' from registry tarballs. The
     registry records its own file count (`dist.fileCount`) for most versions; the share of releases whose counted
     files equal it must not differ between the two sources by more than MAX_GAP. FAIL otherwise. "Equal" allows
     the registry's count to include the tarball's directory entries (with or without the root `package/`), which
     some packers write and the registry then counts; the plain file-only agreement is reported alongside.
  3. State fields: every top-level and second-level key of the Laya state is present (non-null) at similar rates
     in both classes, again within non-first releases for previous-release fields.
  4. No package or account names in states: the release's package name (>= 5 chars) never appears in its state.
  5. Single-feature AUC on train, reported; any feature with AUC > 0.97 is flagged for a human look (not a FAIL:
     a strong feature is not leakage by itself).
Writes results/leakage_check.json and exits 1 on any FAIL.
"""
from __future__ import annotations

import collections
import csv
import gzip
import json
import math
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA, RESULTS

MAX_GAP = 0.10
META = {"key", "name", "version", "label", "category", "family", "wave", "family_basis", "published", "publisher",
        "content_source", "packument_source", "neg_pool", "label_sources", "registry_dist_files",
        "registry_dist_bytes", "content_dir_entries", "split"}


def auc(pos: list[float], neg: list[float]) -> float:
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    ranks, i = {}, 0
    rsum = 0.0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        r = (i + j + 1) / 2
        rsum += r * sum(1 for k in range(i, j) if allv[k][1] == 1)
        i = j
    n1, n0 = len(pos), len(neg)
    return (rsum - n1 * (n1 + 1) / 2) / (n1 * n0) if n1 and n0 else math.nan


def main() -> int:
    with gzip.open(DATA / "features.csv.gz", "rt") as fh:
        rows = list(csv.DictReader(fh))
    feats = [k for k in rows[0] if k not in META]
    fails, flags = [], []
    out = {"rows": len(rows), "max_gap": MAX_GAP, "missingness": {}, "content_parity": {}, "state_fields": {},
           "names_in_state": {}, "single_feature_auc_train": {}}

    # 1. Missingness.
    for k in feats:
        res = {}
        for scope, sel in (("all", rows), ("non_first", [r for r in rows if r["is_first_release"] == "0"]),
                           ("first", [r for r in rows if r["is_first_release"] == "1"])):
            rate = {}
            for lab in ("1", "0"):
                rs = [r for r in sel if r["label"] == lab]
                rate[lab] = sum(1 for r in rs if r[k] == "") / len(rs) if rs else math.nan
            res[scope] = {"pos": round(rate["1"], 4), "neg": round(rate["0"], 4), "gap": round(abs(rate["1"] - rate["0"]), 4)}
        out["missingness"][k] = res
        bad = [s for s in ("non_first", "first") if not math.isnan(res[s]["gap"]) and res[s]["gap"] > MAX_GAP]
        if bad:
            fails.append(f"missingness gap > {MAX_GAP} for {k} in {bad}: {res}")

    # 2. Content parity vs the registry's own dist.fileCount.
    for src in ("datadog-archive", "registry-tarball"):
        for lab in ("1", "0"):
            rs = [r for r in rows if r["content_source"] == src and r["label"] == lab and r["registry_dist_files"] != ""]
            if not rs:
                continue
            eq = sum(1 for r in rs if int(float(r["files"])) == int(float(r["registry_dist_files"])))
            within = sum(1 for r in rs if abs(int(float(r["files"])) - int(float(r["registry_dist_files"]))) <= 1)
            # fileCount also counts directory entries (and the root `package/`) when the packer wrote them into the
            # tarball. Agreement under any of the three counting conventions means every file was read.
            def conv_eq(r):
                f, d = int(float(r["files"])), int(float(r["registry_dist_files"]))
                de = r.get("content_dir_entries", "")
                return f == d or (de != "" and d in (f + int(float(de)), f + int(float(de)) + 1))
            eqc = sum(1 for r in rs if conv_eq(r))
            out["content_parity"][f"{src}/label={lab}"] = {"n_with_dist_fileCount": len(rs), "files_equal": round(eq / len(rs), 4),
                                                          "files_within_1": round(within / len(rs), 4),
                                                          "files_equal_any_convention": round(eqc / len(rs), 4)}
    pos_c = out["content_parity"].get("datadog-archive/label=1")
    neg_c = out["content_parity"].get("registry-tarball/label=0")
    # Gate on the convention-aware agreement: a file-only count against a fileCount that includes directory entries
    # differs for packing reasons, not because a file was missed (the raw `files_equal` is still reported).
    if pos_c and neg_c and abs(pos_c["files_equal_any_convention"] - neg_c["files_equal_any_convention"]) > MAX_GAP:
        fails.append(f"content parity: file-count agreement differs by source: {pos_c} vs {neg_c}")
    cov = {}
    for lab in ("1", "0"):
        rs = [r for r in rows if r["label"] == lab]
        cov[lab] = sum(1 for r in rs if r["registry_dist_files"] != "") / len(rs)
    out["content_parity"]["dist_fileCount_coverage"] = {"pos": round(cov["1"], 4), "neg": round(cov["0"], 4)}

    # 3 + 4. State fields and names.
    cnt = collections.defaultdict(lambda: collections.Counter())
    tot = collections.Counter()
    names_hit = collections.Counter()
    meta_by_key = {r["key"]: r for r in rows}
    for sp in ("train", "calib", "test"):
        for line in open(DATA / f"{sp}.jsonl"):
            d = json.loads(line)
            r = meta_by_key[d["id"]]
            lab = r["label"]
            scope = "first" if r["is_first_release"] == "1" else "non_first"
            tot[(scope, lab)] += 1
            for g, sub in d["state"].items():
                if isinstance(sub, dict):
                    for k, v in sub.items():
                        if v not in (None, "", {}, []):
                            cnt[f"{g}.{k}"][(scope, lab)] += 1
            s = json.dumps(d["state"], ensure_ascii=False).lower()
            nm = r["name"].lower()
            short = nm.split("/")[-1]
            if len(nm) >= 5 and nm in s:
                names_hit[f"full_name/label={lab}"] += 1
            if len(short) >= 5 and short in s:
                names_hit[f"short_name/label={lab}"] += 1
    for k, c in sorted(cnt.items()):
        res = {}
        for scope in ("non_first", "first"):
            p = c[(scope, "1")] / tot[(scope, "1")] if tot[(scope, "1")] else math.nan
            n = c[(scope, "0")] / tot[(scope, "0")] if tot[(scope, "0")] else math.nan
            res[scope] = {"pos_present": round(p, 4), "neg_present": round(n, 4)}
        out["state_fields"][k] = res
        # Text fields legitimately differ in presence (a release has an install script or not); only structural
        # fields must be present at equal rates.
        if not k.startswith("text.") and k not in ("install_scripts.hooks", "install_scripts.previous_hooks"):
            for scope in ("non_first", "first"):
                p, n = res[scope]["pos_present"], res[scope]["neg_present"]
                if not (math.isnan(p) or math.isnan(n)) and abs(p - n) > MAX_GAP:
                    fails.append(f"state field {k} present at different rates ({scope}): pos {p} vs neg {n}")
    out["names_in_state"] = dict(names_hit)
    if names_hit.get("full_name/label=1", 0) + names_hit.get("full_name/label=0", 0) > 0:
        fails.append(f"package names found in states: {dict(names_hit)}")

    # 5. Single-feature AUC on train.
    tr = [r for r in rows if r["split"] == "train"]
    for k in feats:
        pos = [float(r[k]) for r in tr if r["label"] == "1" and r[k] != ""]
        neg = [float(r[k]) for r in tr if r["label"] == "0" and r[k] != ""]
        a = auc(pos, neg)
        out["single_feature_auc_train"][k] = round(a, 4) if not math.isnan(a) else None
        if not math.isnan(a) and max(a, 1 - a) > 0.97:
            flags.append(f"{k}: single-feature AUC {a:.3f} on train (strong; look at it)")
    out["fails"], out["flags"] = fails, flags
    out["result"] = "PASS" if not fails else "FAIL"
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "leakage_check.json").write_text(json.dumps(out, indent=1) + "\n")
    print(out["result"])
    for f in fails:
        print("FAIL:", f)
    for f in flags:
        print("FLAG:", f)
    print("content parity:", json.dumps(out["content_parity"]))
    print("names in state:", out["names_in_state"])
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
