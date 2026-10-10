#!/usr/bin/env bash
# Rebuild the release-triage dataset and baselines from scratch (network needed for steps 1-3).
# Inputs (paths are arguments so nothing is read from inside downloaded data):
#   DD_CLONE   optional: blobless clone of DataDog/malicious-software-packages-dataset (commit pinned in src/common.py):
#              GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --no-checkout \
#                https://github.com/DataDog/malicious-software-packages-dataset "$DD_CLONE"
#              Without it, collect_positives.py reads the saved `git ls-tree` listing in data/dd_*_list.txt.gz.
#   OSV_ZIP    https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip (sha256 recorded in
#              data/positive_candidates.summary.json). v1 positives used 5a7217769c65205b…; the v2 dataset
#              (2026-10-10) uses 802734dd469fb0c5… for positives and negatives. Re-running v1's positive list with
#              802734dd… gives the same families for every v1 row.
#   LABELS     git show 305fad812dc1bdee3fb478ee8d40f1494ea5c3bf:blastradius/pack/model/manifest/labels.jsonl
#   UNIVERSE   dir with universe-negatives.txt and universe-hammer.txt from the same commit
#   LAYA_BASE  convaiinnovations/laya @ 7b928d82… without weights: rl_agent_config.json, tokenizer/*, encoder/config.json
#              and the same under typed-decisions/ (needs `laya` 0.4.1 + `transformers` in $PY for check_tokens.py)
# Every Python step runs with -I. Downloaded archives are only read in memory; nothing is extracted or executed.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}
: "${OSV_ZIP:?}" "${LABELS:?}" "${UNIVERSE:?}"
export RT_CACHE=${RT_CACHE:-/home/user/rtwork/cache}
$PY -I src/collect_positives.py ${DD_CLONE:+--dd-clone "$DD_CLONE"} --osv-zip "$OSV_ZIP" --labels "$LABELS"
# Negatives: batch v1 is the committed data/negative_candidates.jsonl (rows with neg_batch v1); --extend keeps it and
# adds batch v2 by the same rules (run the plain command first only when rebuilding v1 from nothing).
$PY -I src/collect_negatives.py --extend --labels "$LABELS" --universe-dir "$UNIVERSE" --osv-zip "$OSV_ZIP"
$PY -I src/fetch.py --candidates data/positive_candidates.jsonl
$PY -I src/fetch.py --candidates data/negative_candidates.jsonl
$PY -I src/build.py
$PY -I src/split.py
npx tsx src/rule_scorer.ts   # needs blastradius/node_modules (npm ci in blastradius/)
$PY -I src/leakage_check.py
$PY -I src/baselines.py
$PY -I src/package_for_colab.py   # data/laya/*.jsonl.gz + MANIFEST.json for colab/laya_release_triage.ipynb
if [ -n "${LAYA_BASE:-}" ]; then $PY -I src/check_tokens.py --base "$LAYA_BASE"; fi
