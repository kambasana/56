"""Known-bad npm releases from an unzipped OSV npm export, as {"name": ["version", ...]}.

    python pack/model/known_bad.py --osv-dir DIR --out known-bad.json

Same rule as the pack (src/pack/build.ts): MAL-* records and GitHub advisories tagged CWE-506.
Only explicitly listed versions are used. build_dataset.py drops these releases from the negatives
(they are bad, but without an incident record and usually without a manifest to learn from).
"""
from __future__ import annotations

import argparse
import json
import os


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--osv-dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    bad: dict[str, set[str]] = {}
    for f in sorted(os.listdir(a.osv_dir)):
        if not f.endswith(".json") or not (f.startswith("MAL-") or f.startswith("GHSA-")):
            continue
        try:
            rec = json.load(open(os.path.join(a.osv_dir, f)))
        except (OSError, ValueError):
            continue
        cwes = (rec.get("database_specific") or {}).get("cwe_ids") or []
        if rec.get("withdrawn") or not (f.startswith("MAL-") or "CWE-506" in cwes):
            continue
        for aff in rec.get("affected") or []:
            pkg = aff.get("package") or {}
            if pkg.get("ecosystem") != "npm" or not isinstance(pkg.get("name"), str):
                continue
            vs = [v for v in aff.get("versions") or [] if isinstance(v, str)]
            if vs:
                bad.setdefault(pkg["name"], set()).update(vs)
    with open(a.out, "w") as f:
        json.dump({k: sorted(v) for k, v in sorted(bad.items())}, f)
    print(json.dumps({"packages": len(bad), "releases": sum(len(v) for v in bad.values())}))


if __name__ == "__main__":
    main()
