"""Train the "likely next compromise" model (docs/DATA-ML.md §2.6) and export it for TypeScript.

    python pack/model/train.py --root . --dataset out/dataset --out out/model

* Small-depth LightGBM, class weights for the imbalance, deterministic (one thread, fixed seed).
* History-only by default: the manifest features (report.json `manifestFeatures`) are masked to
  NaN on every row, because npm unpublished 98% of the positives' manifests and "manifest missing"
  would otherwise be the label (docs/DATA-ML.md, dataset warnings). `manifest`/`origin` are never
  inputs. Masked columns are constant, so the trees never split on them.
* Weighting (`--weighting year`, default): positives and negatives get equal total weight within
  each calendar year, and years without a training positive get no negative weight, so release
  year (and features that proxy it, such as package age) cannot separate the classes.
* Folds: GroupKFold over `group` (campaign for positives, package for negatives), so a campaign is
  never in the fold that is scored on it. The split hint already keeps each campaign wholly on
  one side of the time cutoff.
* Variant choice (`--variants`): each candidate feature set / weighting is scored on the
  out-of-fold predictions only (average precision); the best one is trained and exported. The
  test split never chooses anything; its metrics for every variant are reported for information.
* Threshold: the calibrated value that maximises F2 on those out-of-fold predictions (recall
  counts more than precision). Chosen on training data only; the test split never tunes anything.
* Export: model.json (bundle: LightGBM dump_model trees + calibration + threshold + feature
  schema), metrics.json, and a parity check: the TS evaluator (src/model/cli.ts) must reproduce
  LightGBM's raw scores and probabilities to 1e-6 on every test row plus synthetic rows with
  missing values. The run fails if parity fails.
"""
from __future__ import annotations

import argparse
import gzip
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
    path = os.path.join(dataset_dir, "dataset.jsonl.gz")
    fh = gzip.open(path, "rt") if os.path.exists(path) else open(os.path.join(dataset_dir, "dataset.jsonl"))
    rows = [json.loads(l) for l in fh if l.strip()]
    report = json.load(open(os.path.join(dataset_dir, "report.json")))
    names = report["featureNames"]
    X = np.array([[np.nan if v is None else float(v) for v in r["features"]] for r in rows], dtype=np.float64)
    meta = pd.DataFrame([{"name": r["name"], "version": r["version"], "releasedAt": r["releasedAt"], "label": r["label"], "incident": r.get("campaign") or r.get("incident"), "group": r["group"], "split": r["split"], "manifest": bool(r.get("manifest"))} for r in rows])
    return X, meta, names, report


def weights(y: np.ndarray, years: np.ndarray, mode: str) -> np.ndarray | None:
    """Sample weights. "global": class weight only (as scale_pos_weight). "year": per calendar
    year, negatives share the weight of that year's positives; years without positives get 0."""
    if mode == "global":
        return None
    w = np.ones(len(y), dtype=np.float64)
    for yr in np.unique(years):
        m = years == yr
        p = int((y[m] == 1).sum())
        n = int((y[m] == 0).sum())
        w[m & (y == 0)] = (p / n) if (p and n) else 0.0
    return w


def fit(X, y, names, monotone=False, w=None):
    pos = max(1, int(y.sum()))
    params = dict(PARAMS) if w is not None else dict(PARAMS, scale_pos_weight=float((len(y) - pos) / pos))
    if monotone:
        params["monotone_constraints"] = [MONOTONE.get(n, 0) for n in names]
        params["monotone_constraints_method"] = "advanced"
    ds = lgb.Dataset(X, label=y, weight=w, feature_name=names, free_raw_data=False)
    return lgb.train(params, ds, num_boost_round=ROUNDS)


# Candidate variants for --variants. Chosen on out-of-fold average precision (training split only).
VARIANTS = {
    "history+downloads/year": {"drop": [], "weighting": "year"},
    "history/year": {"drop": ["downloads_weekly_log10", "downloads_trend"], "weighting": "year"},
    "history+downloads/global": {"drop": [], "weighting": "global"},
}


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


def oof_predict(X, y, groups, names, w, monotone):
    n_pos_groups = len(set(groups[y == 1]))
    folds = GroupKFold(n_splits=min(5, n_pos_groups))
    oof = np.zeros(len(y))
    for fit_idx, val_idx in folds.split(X, y, groups):
        if y[fit_idx].sum() == 0:
            continue
        oof[val_idx] = fit(X[fit_idx], y[fit_idx], names, monotone, None if w is None else w[fit_idx]).predict(X[val_idx])
    return oof


def per_campaign(p_cal: np.ndarray, y: np.ndarray, thr: float, meta: pd.DataFrame) -> list[dict]:
    out = []
    pos = meta[y == 1]
    flagged = p_cal[y == 1] >= thr
    for camp in sorted(set(pos["incident"]), key=lambda c: -int((pos["incident"] == c).sum())):
        m = (pos["incident"] == camp).to_numpy()
        out.append({"campaign": camp, "positives": int(m.sum()), "flagged": int(flagged[m].sum())})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--monotone", action="store_true", help="apply MONOTONE constraints")
    ap.add_argument("--keep-manifest", action="store_true", help="do not mask the manifest features (not recommended)")
    ap.add_argument("--variants", action="store_true", help="choose among VARIANTS by out-of-fold average precision")
    ap.add_argument("--variant", default="history+downloads/year", choices=sorted(VARIANTS))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    X, meta, names, report = load(a.dataset)
    masked = [] if a.keep_manifest else list(report.get("manifestFeatures", []))
    y = meta["label"].to_numpy(dtype=np.int64)
    tr = (meta["split"] == "train").to_numpy()
    te = ~tr
    if y[tr].sum() < 2:
        print("fewer than two training positives: nothing to learn", file=sys.stderr)
        return 1
    years = meta["releasedAt"].str.slice(0, 4).to_numpy()
    groups = meta["group"].to_numpy()

    def design(variant: str) -> np.ndarray:
        Xv = X.copy()
        for n in masked + VARIANTS[variant]["drop"]:
            Xv[:, names.index(n)] = np.nan
        return Xv

    candidates = sorted(VARIANTS) if a.variants else [a.variant]
    trials: dict = {}
    for v in candidates:
        Xv = design(v)
        w = weights(y[tr], years[tr], VARIANTS[v]["weighting"])
        oof = oof_predict(Xv[tr], y[tr], groups[tr], names, w, a.monotone)
        trials[v] = {"oof": oof, "averagePrecision": float(average_precision_score(y[tr], oof)), "rocAuc": float(roc_auc_score(y[tr], oof))}
        print(f"variant {v}: out-of-fold AP {trials[v]['averagePrecision']:.4f}, ROC AUC {trials[v]['rocAuc']:.4f}", file=sys.stderr)
    chosen = max(candidates, key=lambda v: (trials[v]["averagePrecision"], v))
    Xc = design(chosen)
    w_tr = weights(y[tr], years[tr], VARIANTS[chosen]["weighting"])
    oof = trials[chosen]["oof"]
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0, increasing=True).fit(oof, y[tr])
    oof_cal = iso.predict(oof)
    threshold = f_beta_threshold(oof_cal, y[tr])

    booster = fit(Xc[tr], y[tr], names, a.monotone, w_tr)
    p_tr = booster.predict(Xc[tr])
    p_te = booster.predict(Xc[te]) if te.any() else np.array([])
    cal_tr = iso.predict(p_tr)
    cal_te = iso.predict(p_te) if te.any() else np.array([])

    # Every variant's test metrics, for information only (never used to choose).
    others = {}
    for v in candidates:
        if v == chosen:
            continue
        Xv = design(v)
        wv = weights(y[tr], years[tr], VARIANTS[v]["weighting"])
        iso_v = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0, increasing=True).fit(trials[v]["oof"], y[tr])
        thr_v = f_beta_threshold(iso_v.predict(trials[v]["oof"]), y[tr])
        b = fit(Xv[tr], y[tr], names, a.monotone, wv)
        pt = b.predict(Xv[te])
        mt = split_metrics(iso_v.predict(pt), pt, y[te], thr_v, meta[te].reset_index(drop=True))
        mt.pop("positiveScores")
        others[v] = {"threshold": thr_v, "test": mt}

    dump = booster.dump_model()
    gain = booster.feature_importance(importance_type="gain")
    splits = booster.feature_importance(importance_type="split")
    te_meta = meta[te].reset_index(drop=True)
    within = None
    if te.any():
        # Within-package check: test positives against the same packages' clean releases.
        pos_pkgs = set(te_meta[y[te] == 1]["name"])
        m = te_meta["name"].isin(pos_pkgs).to_numpy()
        if 0 < y[te][m].sum() < m.sum():
            within = {"rows": int(m.sum()), "positives": int(y[te][m].sum()), "rocAuc": float(roc_auc_score(y[te][m], p_te[m]))}
    metrics = {
        "featureSchema": report["featureSchema"],
        "cutoff": report["cutoff"],
        "params": dict(PARAMS, rounds=ROUNDS, monotone=MONOTONE if a.monotone else None),
        "maskedFeatures": masked,
        "variant": {"chosen": chosen, **VARIANTS[chosen]},
        "variants": {v: {"outOfFold": {"averagePrecision": t["averagePrecision"], "rocAuc": t["rocAuc"]}, **({"test": others[v]["test"], "threshold": others[v]["threshold"]} if v in others else {})} for v, t in trials.items()},
        "threshold": threshold,
        "calibrationPoints": int(len(iso.X_thresholds_)),
        "outOfFold": split_metrics(oof_cal, oof, y[tr], threshold, meta[tr].reset_index(drop=True)),
        "train": split_metrics(cal_tr, p_tr, y[tr], threshold, meta[tr].reset_index(drop=True)),
        "test": split_metrics(cal_te, p_te, y[te], threshold, te_meta) if te.any() else None,
        "testWithinPositivePackages": within,
        "testPerCampaign": per_campaign(cal_te, y[te], threshold, te_meta) if te.any() else None,
        "outOfFoldPerCampaign": per_campaign(oof_cal, y[tr], threshold, meta[tr].reset_index(drop=True)),
        "importance": sorted(({"feature": n, "gain": float(g), "splits": int(s)} for n, g, s in zip(names, gain, splits) if g > 0), key=lambda d: -d["gain"]),
    }
    bundle = {
        "schema": "blastradius-model/v1",
        "featureSchema": report["featureSchema"],
        "featureNames": names,
        "lightgbm": dump,
        "calibration": {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]},
        "threshold": threshold,
        "meta": {"cutoff": report["cutoff"], "rows": report["rows"], "lightgbm": lgb.__version__, "variant": chosen, "maskedFeatures": masked},
    }
    with open(os.path.join(a.out, "model.json"), "w") as f:
        json.dump(bundle, f)
    with open(os.path.join(a.out, "lightgbm.json"), "w") as f:
        json.dump(dump, f)
    X = Xc  # parity on the inputs the model was trained with, plus synthetic rows

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
