"""Measure real lockfile diffs: how many new or changed package versions each lockfile commit adds.

Usage: python3 -I lockfile_diffs.py <owner/repo> <commits.txt> <cache dir>

commits.txt: "<sha> <date>" lines, newest first (git log --format='%H %cI' -- package-lock.json).
Fetches each package-lock.json from raw.githubusercontent.com and prints, per consecutive pair,
the number of registry name@version entries present in the newer file but not the older one:
the versions a lockfile-diff scan would hand to GuardDog.
"""
import json
import os
import sys
import urllib.request


def versions(lock):
    out = set()
    for path, meta in (lock.get("packages") or {}).items():
        if "node_modules/" in path and (meta.get("resolved") or "").startswith("https://registry.npmjs.org/"):
            out.add((meta.get("name") or path.rsplit("node_modules/", 1)[1], meta.get("version")))
    return out


def main():
    repo, commits_path, cache = sys.argv[1:4]
    os.makedirs(cache, exist_ok=True)
    shas = [line.split()[0] for line in open(commits_path) if line.strip()]
    sets = []
    for sha in shas:
        dest = os.path.join(cache, f"{repo.replace('/', '_')}-{sha}.json")
        if not os.path.exists(dest):
            with urllib.request.urlopen(f"https://raw.githubusercontent.com/{repo}/{sha}/package-lock.json", timeout=60) as r:
                open(dest, "wb").write(r.read())
        sets.append(versions(json.load(open(dest))))
    added = [len(sets[i] - sets[i + 1]) for i in range(len(sets) - 1)]
    print(json.dumps({"repo": repo, "commits": len(added), "added_per_commit": added,
                      "sorted": sorted(added)}))


if __name__ == "__main__":
    main()
