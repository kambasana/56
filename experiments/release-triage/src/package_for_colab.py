"""Step 8: package what the Colab notebook needs, with a sha256 manifest.

Writes data/laya/{train,calib,test}.jsonl.gz (deterministic gzip of data/*.jsonl) and data/laya/MANIFEST.json, which
lists every file the notebook downloads with its sha256 and size:
  data/laya/*.jsonl.gz, data/questions.json, data/split.summary.json, results/leakage_check.json,
  results/baselines.json, results/baseline_scores.csv.gz, src/triage_metrics.py.
The notebook pins the sha256 of MANIFEST.json itself, so every downloaded byte is checked.

Usage: python -I src/package_for_colab.py
"""
from __future__ import annotations

import gzip
import hashlib
import json
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA, ROOT

FILES = ["data/laya/train.jsonl.gz", "data/laya/calib.jsonl.gz", "data/laya/test.jsonl.gz", "data/questions.json",
         "data/split.summary.json", "results/leakage_check.json", "results/baselines.json",
         "results/baseline_scores.csv.gz", "src/triage_metrics.py"]


def main() -> None:
    out = DATA / "laya"
    out.mkdir(exist_ok=True)
    counts = {}
    for sp in ("train", "calib", "test"):
        raw = (DATA / f"{sp}.jsonl").read_bytes()
        counts[sp] = raw.count(b"\n")
        with open(out / f"{sp}.jsonl.gz", "wb") as fh, gzip.GzipFile(fileobj=fh, mode="wb", mtime=0, filename="") as gz:
            gz.write(raw)
    files = {}
    for rel in FILES:
        b = (ROOT / rel).read_bytes()
        files[rel] = {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)}
    man = {"rows": counts, "files": files}
    p = out / "MANIFEST.json"
    p.write_text(json.dumps(man, indent=1, sort_keys=True) + "\n")
    print(json.dumps(man, indent=1))
    print("MANIFEST sha256", hashlib.sha256(p.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
