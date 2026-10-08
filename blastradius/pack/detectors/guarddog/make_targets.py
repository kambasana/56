"""Build scan target lists for the GuardDog gate.

Usage:
  python3 -I make_targets.py noise <noise.json> <incidents.config.json> <dd manifest.json> <out.json>
  python3 -I make_targets.py catch <dataset root> <file list> <incidents.config.json> <out.json>

noise: unique name@version from the control lockfiles, minus known-bad versions (replay
incidents and Datadog manifest compromised versions).
catch: every samples/npm/compromised_lib zip, plus malicious_intent zips whose
sha256("name@version") starts with "0" (pre-registered ~1/16 sample). Each row gets
split = dev|holdout (first hex digit of sha256("name@version") even|odd) and replay = true
when name@version is a replay incident bad release.
"""
import hashlib
import json
import os
import sys


def h(key):
    return hashlib.sha256(key.encode()).hexdigest()


def replay_bad(config_path):
    cfg = json.load(open(config_path))
    return {(b["name"], b["version"]) for i in cfg["incidents"] for b in i["bad"]}


def noise(noise_path, config_path, manifest_path, out_path):
    rows = json.load(open(noise_path))
    bad = replay_bad(config_path)
    manifest = json.load(open(manifest_path))
    targets, excluded = {}, set()
    for r in rows:
        key = (r["name"], r["version"])
        listed = manifest.get(r["name"], "absent")
        if key in bad or listed is None or (isinstance(listed, list) and r["version"] in listed):
            excluded.add(key)
            continue
        targets[key] = {"id": f"{r['name']}@{r['version']}", "name": r["name"],
                        "version": r["version"], "kind": "tgz", "url": r["resolved"]}
    json.dump(sorted(targets.values(), key=lambda t: t["id"]), open(out_path, "w"), indent=1)
    print(f"noise targets {len(targets)}; excluded known-bad {sorted('@'.join(k) for k in excluded)}")


def catch(root, list_path, config_path, out_path):
    bad = replay_bad(config_path)
    targets = []
    for line in open(list_path):
        path = line.strip()
        parts = path.split("/")
        if len(parts) != 6 or not path.endswith(".zip") or parts[1] != "npm":
            continue
        _, _, kind, encoded, version, _ = parts
        name = encoded
        if encoded.startswith("@") and "@" in encoded[1:]:
            scope, rest = encoded[1:].split("@", 1)
            name = f"@{scope}/{rest}"
        key = f"{name}@{version}"
        digest = h(key)
        if kind == "malicious_intent" and not digest.startswith("0"):
            continue
        targets.append({"id": f"{kind}:{key}:{parts[5]}", "name": name, "version": version,
                        "kind": "zip", "set": kind, "path": os.path.join(root, path),
                        "date": parts[5][:10], "split": "dev" if int(digest[0], 16) % 2 == 0 else "holdout",
                        "replay": (name, version) in bad})
    json.dump(targets, open(out_path, "w"), indent=1)
    by = {}
    for t in targets:
        by[(t["set"], t["split"])] = by.get((t["set"], t["split"]), 0) + 1
    print(f"catch targets {len(targets)}: {by}; replay matches {[t['id'] for t in targets if t['replay']]}")


if __name__ == "__main__":
    if sys.argv[1] == "noise":
        noise(*sys.argv[2:6])
    else:
        catch(*sys.argv[2:6])
