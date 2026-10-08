"""Build the noise set: every exact npm package version in each control repo's lockfile.

Usage: python3 -I noise_set.py <out.json> <repo>=<package-lock.json>[:<package.json>] ...

Reads lockfile v1 (nested "dependencies") and v2/v3 ("packages"). Skips the root, workspace
links, bundled entries and anything not resolved from registry.npmjs.org. Marks direct
dependencies (top-level entries named in the root package.json). Output rows:
{"repo", "name", "version", "direct", "resolved"}.
"""
import json
import sys


def from_packages(lock):
    for path, meta in lock.get("packages", {}).items():
        if not path or meta.get("link") or meta.get("inBundle") or meta.get("bundled"):
            continue
        if "node_modules/" not in path:
            continue  # workspace package source, not a registry dependency
        name = meta.get("name") or path.rsplit("node_modules/", 1)[1]
        top = path.count("node_modules/") == 1
        yield name, meta.get("version"), meta.get("resolved"), top


def from_dependencies(deps, depth=0):
    for name, meta in (deps or {}).items():
        if not meta.get("bundled"):
            yield name, meta.get("version"), meta.get("resolved"), depth == 0
        yield from from_dependencies(meta.get("dependencies"), depth + 1)


def main():
    out = sys.argv[1]
    rows = []
    for spec in sys.argv[2:]:
        repo, paths = spec.split("=", 1)
        lock_path, _, pkg_path = paths.partition(":")
        lock = json.load(open(lock_path))
        root = lock.get("packages", {}).get("", {})
        if pkg_path:
            root = json.load(open(pkg_path))
        direct = set()
        for key in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            direct |= set((root.get(key) or {}).keys())
        entries = from_packages(lock) if lock.get("packages") else from_dependencies(lock.get("dependencies"))
        seen = set()
        for name, version, resolved, top in entries:
            if not version or not resolved or not resolved.startswith("https://registry.npmjs.org/"):
                continue
            key = (name, version)
            if key in seen:
                continue
            seen.add(key)
            rows.append({"repo": repo, "name": name, "version": version,
                         "direct": bool(top and name in direct), "resolved": resolved})
    json.dump(rows, open(out, "w"), indent=1)
    by_repo = {}
    for r in rows:
        by_repo.setdefault(r["repo"], [0, 0])
        by_repo[r["repo"]][0] += 1
        by_repo[r["repo"]][1] += r["direct"]
    for repo, (n, d) in by_repo.items():
        print(f"{repo}: {n} versions, {d} direct")
    print("unique name@version:", len({(r["name"], r["version"]) for r in rows}))


if __name__ == "__main__":
    main()
