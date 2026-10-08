"""Turn GuardDog scan results into the gate tables (pre-registered measures, PREREGISTRATION.md).

Usage:
  python3 -I analyze.py --catch catch-results.jsonl --catch-targets catch-targets.json \
      --engine engine.json --noise noise-results.jsonl --noise-set noise.json --out <results dir> \
      [--tag name]

Writes CSVs to --out and prints markdown tables. For a rule-subset check, point --catch and
--noise at results of a rescan run with scan.py --exclude, and name it with --tag.
"""
import argparse
import collections
import csv
import json
import os
import statistics

LEVEL = {"no_risks_detected": 0, "low": 1, "suspicious": 2, "high_risk": 3}
OURS = {None: 0, "info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def last_rows(path):
    rows = {}
    for line in open(path):
        r = json.loads(line)
        if "error" in r and r["id"] in rows:
            continue
        rows[r["id"]] = r
    return rows


def lvl(r):
    return LEVEL.get(r.get("label"), -1)


def pct(a, b):
    return f"{a}/{b} ({100 * a / b:.1f}%)" if b else "0/0"


def risk_rules(r, min_level=0):
    return sorted({x["threat_rule"] for x in r.get("risks") or []})


def quantiles(xs):
    xs = sorted(xs)
    if not xs:
        return {}
    q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))]
    return {"n": len(xs), "median": round(statistics.median(xs), 2), "p90": round(q(0.9), 2),
            "p95": round(q(0.95), 2), "max": round(xs[-1], 2), "sum": round(sum(xs), 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catch", required=True)
    ap.add_argument("--catch-targets", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--noise", required=True)
    ap.add_argument("--noise-set", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="full")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    targets = {t["id"]: t for t in json.load(open(args.catch_targets))}
    catch = last_rows(args.catch)
    engine = {r["id"]: r for r in json.load(open(args.engine))}
    noise = last_rows(args.noise)
    noise_set = json.load(open(args.noise_set))
    tag = args.tag
    p = print

    # ---------------- catch ----------------
    comp = [dict(catch[i], **targets[i]) for i in targets if targets[i]["set"] == "compromised_lib" and i in catch]
    errs = [r for r in comp if lvl(r) < 0]
    comp_ok = [r for r in comp if lvl(r) >= 0]
    mal = [dict(catch[i], **targets[i]) for i in targets if targets[i]["set"] == "malicious_intent" and i in catch]
    mal_ok = [r for r in mal if lvl(r) >= 0]
    p(f"## Catch [{tag}]\n")
    p(f"compromised scanned {len(comp)}/{sum(t['set']=='compromised_lib' for t in targets.values())}, scan errors {len(errs)}")
    p("\n| Set | n | M3 any risk (low+) | M1 medium+ (suspicious+) | M2 high (high_risk) |\n|---|---|---|---|---|")
    for name, rows in [("compromised: all", comp_ok),
                       ("compromised: dev half", [r for r in comp_ok if r["split"] == "dev"]),
                       ("compromised: holdout half", [r for r in comp_ok if r["split"] == "holdout"]),
                       ("malicious_intent (1/16 sample, not gating)", mal_ok)]:
        n = len(rows)
        p(f"| {name} | {n} | {pct(sum(lvl(r)>=1 for r in rows), n)} | {pct(sum(lvl(r)>=2 for r in rows), n)} | {pct(sum(lvl(r)>=3 for r in rows), n)} |")

    # by discovery month (campaign waves)
    p("\n| Discovery month | n | GuardDog medium+ | ours any (proof def.) | ours medium+ | union (GD medium+ or ours any) |\n|---|---|---|---|---|---|")
    by_month = collections.defaultdict(list)
    for r in comp_ok:
        by_month[r["date"][:7]].append(r)
    for m in sorted(by_month):
        rows = by_month[m]
        e = [engine.get(r["id"], {}) for r in rows]
        p(f"| {m} | {len(rows)} | {sum(lvl(r)>=2 for r in rows)} | {sum(OURS[x.get('findingLevel')]>=1 for x in e)} | {sum(OURS[x.get('findingLevel')]>=2 for x in e)} | {sum(lvl(r)>=2 or OURS[engine.get(r['id'],{}).get('findingLevel')]>=1 for r in rows)} |")

    # head-to-head on samples our engine could score
    scored = [r for r in comp_ok if engine.get(r["id"], {}).get("status") == "scored"]
    n = len(scored)
    ours_any = {r["id"] for r in scored if OURS[engine[r["id"]].get("findingLevel")] >= 1}
    ours_med = {r["id"] for r in scored if OURS[engine[r["id"]].get("findingLevel")] >= 2}
    gd_med = {r["id"] for r in scored if lvl(r) >= 2}
    gd_high = {r["id"] for r in scored if lvl(r) >= 3}
    p(f"\n### Head to head on the {n} compromised samples both can score\n")
    p("| Detector | Flagged |\n|---|---|")
    for name, s in [("Ours, any finding at release + 1 h (proof definition)", ours_any),
                     ("Ours, medium or above", ours_med), ("GuardDog M1 (medium+)", gd_med), ("GuardDog M2 (high)", gd_high),
                     ("Union: ours any or GuardDog M1", ours_any | gd_med), ("Union: ours medium+ or GuardDog M1", ours_med | gd_med),
                     ("GuardDog M1 only (ours silent)", gd_med - ours_any), ("Ours only (GuardDog below M1)", ours_any - gd_med),
                     ("Neither", {r['id'] for r in scored} - ours_any - gd_med)]:
        p(f"| {name} | {pct(len(s), n)} |")

    # replay incidents with a sample
    p("\n### Replay incidents with a Datadog sample\n")
    p("| Bad release | GuardDog label (score) | GuardDog risk rules | Ours at release + 1 h |\n|---|---|---|---|")
    for r in comp:
        if r.get("replay"):
            e = engine.get(r["id"], {})
            p(f"| {r['name']}@{r['version']} | {r.get('label')} ({r.get('score')}) | {', '.join(risk_rules(r)) or '-'} | {e.get('findingLevel') or 'no finding'}: {', '.join(e.get('signals') or []) or '-'} |")

    # per-rule on compromised
    p("\n### Rules forming risks on compromised samples (count of samples)\n")
    rc = collections.Counter(rule for r in comp_ok for rule in risk_rules(r))
    rc_med = collections.Counter(rule for r in comp_ok if lvl(r) >= 2 for rule in risk_rules(r))
    p("| Rule | samples with a risk from it | of which package is medium+ |\n|---|---|---|")
    for rule, c in rc.most_common():
        p(f"| {rule} | {c} | {rc_med[rule]} |")
    with open(os.path.join(args.out, f"compromised-{tag}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "version", "discovered", "split", "replay", "guarddog_label", "guarddog_score", "guarddog_risk_rules", "scan_seconds", "ours_level", "ours_signals"])
        for r in sorted(comp, key=lambda r: r["id"]):
            e = engine.get(r["id"], {})
            w.writerow([r["name"], r["version"], r["date"], r["split"], r["replay"], r.get("label") or "error", r.get("score"),
                        " ".join(risk_rules(r)), r.get("scan_seconds"), e.get("findingLevel") or "", " ".join(e.get("signals") or [])])
    with open(os.path.join(args.out, f"malicious-intent-{tag}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "version", "discovered", "guarddog_label", "guarddog_score", "guarddog_risk_rules", "scan_seconds"])
        for r in sorted(mal, key=lambda r: r["id"]):
            w.writerow([r["name"], r["version"], r["date"], r.get("label") or "error", r.get("score"), " ".join(risk_rules(r)), r.get("scan_seconds")])

    # ---------------- noise ----------------
    p(f"\n## Noise [{tag}]\n")
    repos = collections.OrderedDict()
    for row in noise_set:
        repos.setdefault(row["repo"], []).append(row)
    missing = set()
    p("| Control repo | versions scanned | scan errors | low+ | **medium+ (M1)** | high (M2) | medium+ among direct deps |\n|---|---|---|---|---|---|---|")
    flagged_rows = []
    for repo, rows in repos.items():
        rs = []
        for row in rows:
            r = noise.get(f"{row['name']}@{row['version']}")
            if r is None:
                missing.add(f"{row['name']}@{row['version']}")
                continue
            rs.append((row, r))
        ok = [(row, r) for row, r in rs if lvl(r) >= 0]
        p(f"| {repo} | {len(ok)} | {len(rs) - len(ok)} | {sum(lvl(r)>=1 for _, r in ok)} | **{sum(lvl(r)>=2 for _, r in ok)}** | {sum(lvl(r)>=3 for _, r in ok)} | {sum(lvl(r)>=2 and row['direct'] for row, r in ok)} |")
        for row, r in ok:
            if lvl(r) >= 1:
                flagged_rows.append((repo, row, r))
    p(f"\n(known-bad excluded or not scanned: {len(missing)})")
    uniq = {}
    for repo, row, r in flagged_rows:
        uniq.setdefault(r["id"], (r, set()))[1].add(repo.split("@")[0])
    p("\n### Rules behind benign packages at medium+ (distinct package versions)\n")
    rule_med = collections.Counter(rule for r, _ in uniq.values() if lvl(r) >= 2 for rule in risk_rules(r))
    rule_low = collections.Counter(rule for r, _ in uniq.values() if lvl(r) >= 1 for rule in risk_rules(r))
    p("| Rule | benign versions at medium+ with a risk from it | benign versions at low+ |\n|---|---|---|")
    for rule in sorted(set(rule_low) | set(rule_med), key=lambda x: (-rule_med[x], -rule_low[x])):
        p(f"| {rule} | {rule_med[rule]} | {rule_low[rule]} |")
    p("\n### Benign package versions at medium+\n")
    p("| Package | label (score) | risk rules | in repos |\n|---|---|---|---|")
    for r, rs in sorted(uniq.values(), key=lambda x: (-lvl(x[0]), x[0]["id"])):
        if lvl(r) >= 2:
            p(f"| {r['id']} | {r['label']} ({r['score']}) | {', '.join(risk_rules(r))} | {', '.join(sorted(rs))} |")
    with open(os.path.join(args.out, f"noise-flagged-{tag}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["package", "guarddog_label", "guarddog_score", "guarddog_risk_rules", "repos"])
        for r, rs in sorted(uniq.values(), key=lambda x: x[0]["id"]):
            w.writerow([r["id"], r["label"], r["score"], " ".join(risk_rules(r)), " ".join(sorted(rs))])

    # ---------------- cost ----------------
    p(f"\n## Cost [{tag}] (wall seconds per package, includes GuardDog start-up and extraction)\n")
    p("| Set | n | median | p90 | p95 | max | total |\n|---|---|---|---|---|---|---|")
    for name, xs in [("benign lockfile tarballs", [r["scan_seconds"] for r in noise.values() if "scan_seconds" in r]),
                     ("compromised samples", [r["scan_seconds"] for r in comp_ok]),
                     ("malicious_intent samples", [r["scan_seconds"] for r in mal_ok])]:
        q = quantiles(xs)
        if q:
            p(f"| {name} | {q['n']} | {q['median']} | {q['p90']} | {q['p95']} | {q['max']} | {q['sum']} |")


if __name__ == "__main__":
    main()
