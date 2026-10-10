"""Token budget check for the Laya states with laya's own sequence builder (no model weights, no model run).

Same method as the notebook's "Token budget and truncation" cell: the checkpoint's tokenizer (AutoTokenizer from
<base>/tokenizer, after laya.agent._fix_tokenizer_config), each question converted with laya.train.to_internal, and
laya.common.build_sequence(..., return_truncation_stats=True), which builds [CLS] head [SEP] state [SEP] exactly as
training and inference do and reports whether the state was cut. Counted per question for the three budgets the
runs use: EN 512/192 (Z-EN), EN 1024/256 (F-EN), TD 1024/256 (Z-TD, F-TD).

(The earlier version of this script counted tokens of json.dumps(state) with the raw `tokenizers` file and an
estimated head; it was approximate and is replaced by this one.)

Needs `laya` (0.4.1) and `transformers` importable, and the checkpoint directories without weights:
<base>/rl_agent_config.json, <base>/tokenizer/*, <base>/typed-decisions/{rl_agent_config.json,tokenizer/*}.

Usage: python -I src/check_tokens.py --base DIR
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA, RESULTS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="English checkpoint dir (repo root of convaiinnovations/laya)")
    a = ap.parse_args()
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_sequence
    from laya.train import to_internal

    questions = json.loads((DATA / "questions.json").read_text())
    rows = {sp: [json.loads(l) for l in open(DATA / f"{sp}.jsonl", encoding="utf-8") if l.strip()]
            for sp in ("train", "calib", "test")}

    def truncation(base_dir: str, max_len: int, head_max_len: int) -> dict:
        _fix_tokenizer_config(base_dir)
        tok = AutoTokenizer.from_pretrained(os.path.join(base_dir, "tokenizer"))
        out = {}
        for qid, q in questions.items():
            qi = to_internal(qid, q)
            res = {"items": 0, "truncated": 0}
            per_split, total = {}, []
            for sp, rs in rows.items():
                n = t = 0
                for r in rs:
                    if qid not in r["questions"]:
                        continue
                    _, _, st = build_sequence(tok, r["state"], qi, max_len, head_max_len, return_truncation_stats=True)
                    n += 1
                    t += int(bool(st["truncated"]))
                    total.append(st["state_tokens"])
                per_split[sp] = {"items": n, "truncated": t, "share_truncated": round(t / max(1, n), 4)}
                res["items"] += n
                res["truncated"] += t
            total.sort()
            res.update({"share_truncated": round(res["truncated"] / max(1, res["items"]), 4), "per_split": per_split,
                        "state_tokens_median": total[len(total) // 2] if total else None,
                        "state_tokens_p95": total[int(len(total) * 0.95)] if total else None,
                        "state_tokens_max": total[-1] if total else None})
            out[qid] = res
        return out

    base = a.base
    td = os.path.join(base, "typed-decisions")
    out = {"method": "laya.common.build_sequence truncation stats (same as the notebook)",
           "checkpoint": "convaiinnovations/laya @ 7b928d828b7b0e022f929d9bd2e44165aa270148 (tokenizer and config only)",
           "EN@512/192 (Z-EN)": truncation(base, 512, 192),
           "EN@1024/256 (F-EN)": truncation(base, 1024, 256),
           "TD@1024/256 (Z-TD, F-TD)": truncation(td, 1024, 256)}
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "tokens.json").write_text(json.dumps(out, indent=1) + "\n")
    for k, v in out.items():
        if isinstance(v, dict):
            print(k, {q: (x["truncated"], x["items"], x["share_truncated"], x["state_tokens_p95"]) for q, x in v.items()})


if __name__ == "__main__":
    main()
