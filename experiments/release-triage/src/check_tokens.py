"""Token budget check for the Laya states, with the checkpoint's own tokenizer (no model run).

Laya builds [CLS] head [SEP] state [SEP] with the head (question instructions and options) capped at
head_max_len and the whole sequence at max_len; anything beyond is silently dropped (docs/LAYA-USAGE.md 1.4).
The state is serialised like Python's json.dumps (the runtime's pyJsonDumps). This counts, per question, the
state tokens that fit and how many states would be truncated at the notebook budget (--max-len 1024
--head-max-len 256) and at the English bundle's 512.

Usage: python -I src/check_tokens.py --tokenizer DIR/tokenizer.json [--pylib DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA, RESULTS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--pylib", default=None, help="directory holding the `tokenizers` package")
    a = ap.parse_args()
    if a.pylib:
        sys.path.insert(0, a.pylib)
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(a.tokenizer)
    enc = lambda s: len(tok.encode(s, add_special_tokens=False).ids)
    qs = json.loads((DATA / "questions.json").read_text())
    out = {"tokenizer": a.tokenizer, "budgets": {}}
    lens = []
    for sp in ("train", "calib", "test"):
        for line in open(DATA / f"{sp}.jsonl"):
            d = json.loads(line)
            lens.append(enc(json.dumps(d["state"])))
    lens.sort()
    out["state_tokens"] = {"n": len(lens), "median": lens[len(lens) // 2], "p95": lens[int(len(lens) * 0.95)], "max": lens[-1]}
    for qid, q in qs.items():
        head = q["instructions"] + " " + " ".join(f"{k}: {v}" for k, v in q["criteria"].items())
        for max_len, head_max in ((1024, 256), (512, 256)):
            h = min(enc(head), head_max)
            room = max_len - h - 3  # [CLS], [SEP], [SEP]
            trunc = sum(1 for n in lens if n > room)
            out["budgets"][f"{qid}@{max_len}"] = {"head_tokens": h, "state_room": room, "states_truncated": trunc,
                                                  "share_truncated": round(trunc / len(lens), 4)}
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "tokens.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
