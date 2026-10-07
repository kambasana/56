"""Train the "likely next compromise" model (docs/DATA-ML.md §2.6) and export it for TypeScript.

    python pack/model/train.py --root . --dataset out/dataset --out out/model

* Small-depth LightGBM, class weights for the imbalance, deterministic (one thread, fixed seed).
* Calibration: isotonic on out-of-fold predictions from the training split, folds grouped by
  incident (positives) and package (negatives), so no campaign is calibrated on itself.
* Threshold: the calibrated value that maximises F2 on those out-of-fold predictions (recall
  counts more than precision). Chosen on training data only; the test split never tunes anything.
* Export: model.json (bundle: LightGBM dump_model trees + calibration + threshold + feature
  schema), metrics.json, and a parity check: the TS evaluator (src/model/cli.ts) must reproduce
  LightGBM's raw scores and probabilities to 1e-6 on every test row plus synthetic rows with
  missing values. The run fails if parity fails.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold

PARAMS = {
    "objective": "binary",
    "learning_rate": 0.05,
    "num_leaves": 7,
    "max_depth": 3,
    "min_data_in_leaf": 3,
    "min_sum_hessian_in_leaf": 1e-3,
    "feature_fraction": 0.8,
    "lambda_l2": 1.0,
    "deterministic": True,
    "num_threads": 1,
    "seed": 7,
    "verbose": -1,
    "feature_pre_filter": False,
}
ROUNDS = 150

# Optional prior knowledge (--monotone): the direction in which a feature may move the score.
# These encode the same beliefs as the hand-set signals (a new publisher, a new install hook or a
# dropped provenance never makes a release safer); the trees still learn the size of each effect.
MONOTONE = {
    "publisher_first_release": 1,
    "publisher_differs_prev": 1,
    "publisher_prior_releases": -1,
    "publisher_tenure_days": -1,
    "days_since_new_publisher": -1,
    "new_install_hooks": 1,
    "install_flags_risky": 1,
    "young_deps_added": 1,
    "maintainers_added_vs_prev": 1,
    "days_since_maintainer_change": -1,
    "has_provenance": -1,
    "prev_has_provenance": 1,
    "trusted_publisher": -1,
    "prev_trusted_publisher": 1,
}


def load(dataset_dir: str):
    rows = [json.loads(l) for l in open(os.path.join(dataset_dir, "dataset.jsonl")) if l.strip()]
    report = json.load(open(os.path.join(dataset_dir, "report.json")))
    names = report["featureNames"]
    X = np.array([[np.nan if v is None else float(v) for v in r["features"]] for r in rows], dtype=np.float64)
    meta = pd.DataFrame([{k: r[k] for k in ("name", "version", "releasedAt", "label", "incident", "group", "split")} for r in rows])
    return X, meta, names, report


def fit(X, y, names, monotone=False):
    pos = max(1, int(y.sum()))
    params = dict(PARAMS, scale_pos_weight=float((len(y) - pos) / pos))
    if monotone:
        params["monotone_constraints"] = [MONOTONE.get(n, 0) for n in names]
        params["monotone_constraints_method"] = "advanced"
    ds = lgb.Dataset(X, label=y, feature_name=names, free_raw_data=False)
    return lgb.train(params, ds, num_boost_round=ROUNDS)


def f_beta_threshold(p: np.ndarray, y: np.ndarray, beta: float = 2.0) -> float:
    best_t, best = 1.0, -1.0
    for t in sorted(set(np.round(p, 12))):
        pred = p >= t
        tp = float((pred & (y == 1)).sum())
        fp = float((pred & (y == 0)).sum())
        fn = float((~pred & (y == 1)).sum())
        if tp == 0:
            continue
        f = (1 + beta**2) * tp / ((1 + beta**2) * tp + beta**2 * fn + fp)
        if f > best or (f == best and t > best_t):
            best, best_t = f, t
    return float(best_t)


def precision_at(scores: np.ndarray, y: np.ndarray, k: int) -> float | None:
    if len(scores) == 0:
        return None
    idx = np.argsort(-scores, kind="stable")[:k]
    return float(y[idx].mean())


def split_metrics(p_cal: np.ndarray, p_raw: np.ndarray, y: np.ndarray, thr: float, meta: pd.DataFrame) -> dict:
    out: dict = {"rows": int(len(y)), "positives": int(y.sum())}
    if 0 < y.sum() < len(y):
        out["averagePrecision"] = float(average_precision_score(y, p_raw))
        out["rocAuc"] = float(roc_auc_score(y, p_raw))
    for k in (10, 50, 100):
        out[f"precisionAt{k}"] = precision_at(p_raw, y, k)
    flagged = p_cal >= thr
    out["recallAtThreshold"] = float((flagged & (y == 1)).sum() / max(1, y.sum()))
    out["flaggedNegatives"] = int((flagged & (y == 0)).sum())
    out["flaggedNegativeRate"] = float((flagged & (y == 0)).sum() / max(1, (y == 0).sum()))
    out["positiveScores"] = [
        {"release": f"{m.name}@{m.version}", "incident": m.incident, "calibrated": float(c), "probability": float(r), "flagged": bool(c >= thr)}
        for m, c, r in zip(meta[y == 1].itertuples(), p_cal[y == 1], p_raw[y == 1])
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--monotone", action="store_true", help="apply MONOTONE constraints")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    X, meta, names, report = load(a.dataset)
    y = meta["label"].to_numpy(dtype=np.int64)
    tr = (meta["split"] == "train").to_numpy()
    te = ~tr
    if y[tr].sum() < 2:
        print("fewer than two training positives: nothing to learn", file=sys.stderr)
        return 1

    # Out-of-fold predictions on the training split, grouped by incident / package.
    groups = meta["group"].to_numpy()[tr]
    n_pos_groups = len(set(meta[tr & (y == 1)]["group"]))
    folds = GroupKFold(n_splits=min(5, n_pos_groups))
    oof = np.zeros(int(tr.sum()))
    for fit_idx, val_idx in folds.split(X[tr], y[tr], groups):
        if y[tr][fit_idx].sum() == 0:
            oof[val_idx] = 0.0
            continue
        oof[val_idx] = fit(X[tr][fit_idx], y[tr][fit_idx], names, a.monotone).predict(X[tr][val_idx])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0, increasing=True).fit(oof, y[tr])
    oof_cal = iso.predict(oof)
    threshold = f_beta_threshold(oof_cal, y[tr])

    booster = fit(X[tr], y[tr], names, a.monotone)
    p_tr = booster.predict(X[tr])
    p_te = booster.predict(X[te]) if te.any() else np.array([])
    cal_tr = iso.predict(p_tr)
    cal_te = iso.predict(p_te) if te.any() else np.array([])

    dump = booster.dump_model()
    gain = booster.feature_importance(importance_type="gain")
    metrics = {
        "featureSchema": report["featureSchema"],
        "cutoff": report["cutoff"],
        "params": dict(PARAMS, rounds=ROUNDS, monotone=MONOTONE if a.monotone else None),
        "threshold": threshold,
        "calibrationPoints": int(len(iso.X_thresholds_)),
        "outOfFold": split_metrics(oof_cal, oof, y[tr], threshold, meta[tr].reset_index(drop=True)),
        "train": split_metrics(cal_tr, p_tr, y[tr], threshold, meta[tr].reset_index(drop=True)),
        "test": split_metrics(cal_te, p_te, y[te], threshold, meta[te].reset_index(drop=True)) if te.any() else None,
        "topFeatures": sorted(({"feature": n, "gain": float(g)} for n, g in zip(names, gain) if g > 0), key=lambda d: -d["gain"])[:15],
    }
    bundle = {
        "schema": "blastradius-model/v1",
        "featureSchema": report["featureSchema"],
        "featureNames": names,
        "lightgbm": dump,
        "calibration": {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]},
        "threshold": threshold,
        "meta": {"cutoff": report["cutoff"], "rows": report["rows"], "lightgbm": lgb.__version__},
    }
    with open(os.path.join(a.out, "model.json"), "w") as f:
        json.dump(bundle, f)
    with open(os.path.join(a.out, "lightgbm.json"), "w") as f:
        json.dump(dump, f)

    # Parity: TS evaluator vs LightGBM on test rows + training sample + synthetic rows with NaNs.
    rng = np.random.default_rng(7)
    synth = X[rng.integers(0, len(X), 300)].copy()
    synth[rng.random(synth.shape) < 0.3] = np.nan
    synth[rng.random(synth.shape) < 0.1] = 0.0
    sample = np.vstack([X[te], X[tr][rng.integers(0, int(tr.sum()), min(2000, int(tr.sum())))], synth])
    raw = booster.predict(sample, raw_score=True)
    prob = booster.predict(sample)
    parity_file = os.path.join(a.out, "parity.jsonl")
    with open(parity_file, "w") as f:
        for x, r, p in zip(sample, raw, prob):
            f.write(json.dumps({"features": [None if np.isnan(v) else float(v) for v in x], "raw": float(r), "prob": float(p)}) + "\n")
    res = subprocess.run(["npx", "tsx", "src/model/cli.ts", "parity", "--model", os.path.abspath(os.path.join(a.out, "lightgbm.json")), "--rows", os.path.abspath(parity_file), "--tol", "1e-6"], cwd=os.path.abspath(a.root), capture_output=True, text=True)
    metrics["parity"] = json.loads(res.stdout.strip() or "{}") if res.stdout.strip().startswith("{") else {"error": res.stderr[-500:]}
    with open(os.path.join(a.out, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)
    summary = {k: metrics[k] for k in ("threshold", "parity")}
    for s in ("outOfFold", "train", "test"):
        if metrics[s]:
            summary[s] = {k: v for k, v in metrics[s].items() if k != "positiveScores"}
    print(json.dumps(summary, indent=1))
    if res.returncode != 0:
        print("PARITY FAILED: the TS evaluator does not match LightGBM", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
