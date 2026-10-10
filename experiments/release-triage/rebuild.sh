#!/usr/bin/env bash
# Rebuild the release-triage dataset and baselines from scratch (network needed for steps 1-3).
# Inputs (paths are arguments so nothing is read from inside downloaded data):
#   DD_CLONE   blobless clone of DataDog/malicious-software-packages-dataset (commit pinned in src/common.py):
#              GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --no-checkout \
#                https://github.com/DataDog/malicious-software-packages-dataset "$DD_CLONE"
#   OSV_ZIP    https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip (sha256 recorded in
#              data/positive_candidates.summary.json; positives used 5a7217769c65205b…, negatives were
#              collected with a later download, 802734dd469fb0c5…, which only adds names to the exclusion list)
#   LABELS     git show 305fad812dc1bdee3fb478ee8d40f1494ea5c3bf:blastradius/pack/model/manifest/labels.jsonl
#   UNIVERSE   dir with universe-negatives.txt and universe-hammer.txt from the same commit
#   TOKENIZER  convaiinnovations/laya @ 7b928d82…: tokenizer/tokenizer.json (and a dir with the `tokenizers` package)
# Every Python step runs with -I. Downloaded archives are only read in memory; nothing is extracted or executed.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}
: "${DD_CLONE:?}" "${OSV_ZIP:?}" "${LABELS:?}" "${UNIVERSE:?}"
export RT_CACHE=${RT_CACHE:-/home/user/rtwork/cache}
$PY -I src/collect_positives.py --dd-clone "$DD_CLONE" --osv-zip "$OSV_ZIP" --labels "$LABELS"
$PY -I src/collect_negatives.py --labels "$LABELS" --universe-dir "$UNIVERSE" --osv-zip "$OSV_ZIP"
$PY -I src/fetch.py --candidates data/positive_candidates.jsonl
$PY -I src/fetch.py --candidates data/negative_candidates.jsonl
$PY -I src/build.py
$PY -I src/split.py
npx tsx src/rule_scorer.ts
$PY -I src/leakage_check.py
$PY -I src/baselines.py
$PY -I src/package_for_colab.py   # data/laya/*.jsonl.gz + MANIFEST.json for colab/laya_release_triage.ipynb
if [ -n "${TOKENIZER:-}" ]; then $PY -I src/check_tokens.py --tokenizer "$TOKENIZER" ${PYLIB:+--pylib "$PYLIB"}; fi
