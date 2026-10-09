"""Step 5: time-based AND grouped splits, family cap, and the Laya JSONL files.

  1. Time: train < CALIB_START <= calib < TEST_START <= test (publish time of the release).
  2. Groups: packages and publishing accounts are joined into connected components (union-find); a component
     goes wholly to one split (the split holding most of its positives, else most of its rows), and its rows
     published outside that split's window are dropped. So no package and no account is in two splits.
     Trusted-publishing releases (npm OIDC, `_npmUser.trustedPublisher`) are not linked through the shared
     "GitHub Actions" identity: their account key is the package itself.
  3. Family cap: in every split no single incident family is more than CAP of the positives; the largest family
     is subsampled (seeded) until this holds.
Then writes data/{train,calib,test}.jsonl (laya-train format), data/features.csv.gz with a `split` column,
data/questions.json and data/split.summary.json.

Usage: python -I src/split.py [--calib-start 2025-10-01] [--test-start 2026-03-01]
"""
from __future__ import annotations

import argparse
import collections
import csv
import gzip
import json
import random
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA

CAP = 0.25
SEED = 20261009

QUESTIONS = {
    "triage": {
        "type": "choice",
        "instructions": "An npm package just published this release. Using only the facts in the state, how should a security reviewer treat it?",
        "criteria": {
            "routine": "an ordinary release by the usual maintainers; nothing needs a look",
            "review": "legitimate-looking, but a change in the facts deserves a human look before adoption",
            "likely_malicious": "the facts point to a compromised or attacker-controlled release",
        },
    },
    "script_intent": {
        "type": "noul",
        "instructions": "Does the install-time script shown in the state do something other than build, compile or set up this package (for example download, exfiltrate, run obfuscated code or touch credentials)?",
        "criteria": {"false": "it only builds or sets up the package", "true": "it does something unrelated to building the package"},
        "labels": {"false": "B", "true": "A"},
    },
}


class UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calib-start", default="2025-10-01")
    ap.add_argument("--test-start", default="2026-03-01")
    a = ap.parse_args()
    rng = random.Random(SEED)

    with gzip.open(DATA / "all_rows.csv.gz", "rt") as fh:
        rows = list(csv.DictReader(fh))
    states = {}
    with gzip.open(DATA / "all_states.jsonl.gz", "rt") as fh:
        for l in fh:
            s = json.loads(l)
            states[s["meta"]["key"]] = s

    def window(r) -> str:
        p = r["published"]
        return "train" if p < a.calib_start else ("calib" if p < a.test_start else "test")

    uf = UF()
    for r in rows:
        acct = f"pkg:{r['name']}" if r["trusted_publisher"] == "1" or not r["publisher"] else f"acct:{r['publisher']}"
        uf.union(f"pkg:{r['name']}", acct)
    comp = collections.defaultdict(list)
    for r in rows:
        comp[uf.find(f"pkg:{r['name']}")].append(r)
    kept, dropped_group = [], collections.Counter()
    comp_sizes = []
    for root, rs in comp.items():
        pos = collections.Counter(window(r) for r in rs if r["label"] == "1")
        allc = collections.Counter(window(r) for r in rs)
        target = (pos or allc).most_common(1)[0][0]
        comp_sizes.append(len(rs))
        for r in rs:
            if window(r) == target:
                r["split"] = target
                kept.append(r)
            else:
                dropped_group[("pos" if r["label"] == "1" else "neg", window(r))] += 1

    # Family cap per split.
    final, dropped_cap = [], collections.Counter()
    for sp in ("train", "calib", "test"):
        rs = [r for r in kept if r["split"] == sp]
        pos = [r for r in rs if r["label"] == "1"]
        negs = [r for r in rs if r["label"] == "0"]
        by = collections.defaultdict(list)
        for r in sorted(pos, key=lambda r: r["key"]):
            by[r["family"]].append(r)
        for f in by:
            rng.shuffle(by[f])
        while True:
            tot = sum(len(v) for v in by.values())
            big = max(by, key=lambda f: (len(by[f]), f)) if by else None
            if big is None or len(by[big]) <= CAP * tot:
                break
            others = tot - len(by[big])
            keep = max(int(others * CAP / (1 - CAP)), 0)
            if keep == len(by[big]):
                keep -= 1
            dropped_cap[(sp, big)] += len(by[big]) - keep
            by[big] = by[big][:keep]
            if keep == 0:
                del by[big]
        final += negs + [r for v in by.values() for r in v]

    final.sort(key=lambda r: (r["split"], r["published"], r["key"]))
    # Outputs.
    fields = [k for k in rows[0] if k != "split"] + ["split"]  # rows[0] may already carry "split"
    with gzip.open(DATA / "features.csv.gz", "wt", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for r in final:
            w.writerow(r)
    (DATA / "questions.json").write_text(json.dumps(QUESTIONS, indent=1) + "\n")
    script_q = 0
    for sp in ("train", "calib", "test"):
        with open(DATA / f"{sp}.jsonl", "w") as fh:
            for r in final:
                if r["split"] != sp:
                    continue
                st = states[r["key"]]["state"]
                qs = {"triage": QUESTIONS["triage"]}
                exp = {"triage": "likely_malicious" if r["label"] == "1" else "routine"}
                hooks = st["install_scripts"]["hooks"]
                # script_intent only where the state shows install-script text, and only where the label is clear:
                # a negative's hook, or a positive whose hook is new in this release (or a first release with a hook).
                if hooks:
                    prev = st["install_scripts"]["previous_hooks"]
                    new_hook = prev is None or any(h not in (prev or {}) or prev.get(h) != hooks[h] for h in hooks)
                    if r["label"] == "0" or new_hook:
                        qs["script_intent"] = QUESTIONS["script_intent"]
                        exp["script_intent"] = "true" if r["label"] == "1" else "false"
                        script_q += 1
                fh.write(json.dumps({"id": r["key"], "state": st, "questions": qs, "expected": exp,
                                     "tags": [r["family"], r["category"], sp]}, ensure_ascii=False) + "\n")

    def counts(sel):
        c = collections.Counter()
        for r in sel:
            c[r["family"]] += 1
        return dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))

    summ = {"calib_start": a.calib_start, "test_start": a.test_start, "cap": CAP,
            "rows_in": len(rows), "rows_out": len(final),
            "dropped_for_grouping": {f"{k[0]}:{k[1]}": v for k, v in sorted(dropped_group.items())},
            "dropped_for_family_cap": {f"{k[0]}:{k[1]}": v for k, v in sorted(dropped_cap.items())},
            "largest_component_rows": max(comp_sizes), "components": len(comp_sizes),
            "script_intent_questions": script_q, "splits": {}}
    for sp in ("train", "calib", "test"):
        rs = [r for r in final if r["split"] == sp]
        pos = [r for r in rs if r["label"] == "1"]
        fam = counts(pos)
        summ["splits"][sp] = {
            "rows": len(rs), "positives": len(pos), "negatives": len(rs) - len(pos),
            "published_range": [min(r["published"] for r in rs)[:10], max(r["published"] for r in rs)[:10]] if rs else None,
            "families": len(fam), "max_family_share": round(max(fam.values()) / len(pos), 3) if pos else None,
            "positives_per_family": fam,
            "positives_per_category": dict(collections.Counter(r["category"] for r in pos)),
            "negatives_first_release": sum(1 for r in rs if r["label"] == "0" and r["is_first_release"] == "1"),
            "positives_first_release": sum(1 for r in pos if r["is_first_release"] == "1"),
        }
    # Grouping check: no package or account in two splits.
    seen_pkg, seen_acct = collections.defaultdict(set), collections.defaultdict(set)
    for r in final:
        seen_pkg[r["name"]].add(r["split"])
        if r["trusted_publisher"] != "1" and r["publisher"]:
            seen_acct[r["publisher"]].add(r["split"])
    summ["packages_in_two_splits"] = sum(1 for v in seen_pkg.values() if len(v) > 1)
    summ["accounts_in_two_splits"] = sum(1 for v in seen_acct.values() if len(v) > 1)
    (DATA / "split.summary.json").write_text(json.dumps(summ, indent=1) + "\n")
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
