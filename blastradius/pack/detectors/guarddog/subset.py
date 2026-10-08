"""Pick a candidate GuardDog rule subset on the DEV split only (PREREGISTRATION.md, holdout).

Usage: python3 -I subset.py <catch-results.jsonl> <catch-targets.json> <noise-results.jsonl> <noise.json>

Dev = compromised samples whose split is "dev" + the TypeScript and mocha lockfiles. Holdout
(the other half of the samples, the 6 replay org repos) is not read here.

Approximation used only for choosing: a package stays medium+ under a subset if it was medium+
with all rules and still has a risk from a kept rule. The chosen subset is then measured exactly
by rescanning with GuardDog's own -x exclusions (scan.py --exclude).

Greedy: while a dev control repo has more than 1 medium+ package, drop the rule whose removal
clears the most dev-control flags per dev sample lost (when no single rule clears a flag, the
cheapest rule of an over-limit repo's packages). Prints the excluded rules.
"""
import collections
import json
import sys

DEV_REPOS = ("microsoft/TypeScript@de61e6962143", "mochajs/mocha@a9fc52968316")


def last_rows(path):
    rows = {}
    for line in open(path):
        r = json.loads(line)
        rows[r["id"]] = r
    return rows


def rules_of(r):
    return {x["threat_rule"] for x in r.get("risks") or []}


def main():
    catch, targets, noise, noise_set = (last_rows(sys.argv[1]), json.load(open(sys.argv[2])),
                                        last_rows(sys.argv[3]), json.load(open(sys.argv[4])))
    medium = lambda r: r.get("label") in ("suspicious", "high_risk")
    dev_catch = [rules_of(catch[t["id"]]) for t in targets
                 if t["set"] == "compromised_lib" and t["split"] == "dev" and t["id"] in catch and medium(catch[t["id"]])]
    repo_pkgs = collections.defaultdict(list)
    for row in noise_set:
        if row["repo"] in DEV_REPOS:
            r = noise.get(f"{row['name']}@{row['version']}")
            if r and medium(r):
                repo_pkgs[row["repo"]].append(rules_of(r))
    excluded = set()
    flagged = lambda sets: sum(bool(s - excluded) for s in sets)
    while any(flagged(p) > 1 for p in repo_pkgs.values()):
        best = None
        for rule in {x for p in repo_pkgs.values() for s in p for x in s} - excluded:
            excluded.add(rule)
            gain = sum(max(0, flagged(p) - 1) for p in repo_pkgs.values())
            loss = len(dev_catch) - flagged(dev_catch)
            excluded.discard(rule)
            before = sum(max(0, flagged(p) - 1) for p in repo_pkgs.values())
            key = ((before - gain) / (1 + loss - (len(dev_catch) - flagged(dev_catch))), -loss)
            if before - gain > 0 and (best is None or key > best[0]):
                best = (key, rule)
        if best is None:
            # No single rule clears a flag (a package has several rules): drop the remaining rule
            # of the over-limit repos' packages that costs the least dev catch.
            cands = {x for p in repo_pkgs.values() if flagged(p) > 1 for st in p for x in st - excluded}
            def loss_if(rule):
                excluded.add(rule)
                v = len(dev_catch) - flagged(dev_catch)
                excluded.discard(rule)
                return v
            best = (None, min(sorted(cands), key=loss_if))
        excluded.add(best[1])
        print(f"exclude {best[1]}: dev catch now {flagged(dev_catch)}/{len(dev_catch)} of dev medium+; "
              f"dev repos {[flagged(p) for p in repo_pkgs.values()]}")
    print("EXCLUDE=" + ",".join(sorted(excluded)))


if __name__ == "__main__":
    main()
