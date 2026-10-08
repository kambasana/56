"""Pull only the registry metadata (package_info-*.json) out of Datadog sample zips.

Usage: python3 -I extract_meta.py <catch-targets.json> <out dir>

Writes <out dir>/<sha256(id)>.json for each zip that carries a package_info file. Reads the
zip in memory with the dataset's public password; no package code is written to disk.
"""
import hashlib
import json
import os
import sys
import zipfile


def main():
    targets = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    found = 0
    for t in targets:
        if t.get("set") != "compromised_lib":
            continue
        try:
            with zipfile.ZipFile(t["path"]) as z:
                infos = [i for i in z.infolist() if os.path.basename(i.filename).startswith("package_info") and i.filename.endswith(".json")]
                if not infos:
                    continue
                data = z.read(infos[0], pwd=b"infected")
        except Exception as e:  # noqa: BLE001
            print("skip", t["id"], e)
            continue
        name = hashlib.sha256(t["id"].encode()).hexdigest() + ".json"
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        found += 1
    print("metadata files:", found)


if __name__ == "__main__":
    main()
