"""Step 6: baselines on the test split.

  1. rule scorer: blastradius scoreIntrinsic on the same releases (results/rule_scores.csv from rule_scorer.ts);
  2. logistic regression (median imputation + missing indicators, standardised, class-balanced);
  3. gradient-boosted trees (scikit-learn HistGradientBoostingClassifier, native NaN handling, class-balanced).
Models 2-3 are trained on train only. For every method, a Platt calibrator and the alert threshold are fitted on
calib only; the test split is touched once.

Threshold policy (fixed before looking at test): the lowest threshold whose alert rate on calib negatives is at
most BUDGET_PER_1000 per 1,000 benign releases.

Reported on test: per-family recall, macro recall (mean over families; each family counts once), macro recall
without the largest test family, a family bootstrap 95% interval for macro recall, precision, alerts per 1,000
benign releases, false alarms per account-month for accounts with >= BUSY_ACCOUNT releases in test, ROC AUC,
average precision, ECE (10 equal-width bins, calibrated probability), Brier, run time.

Usage: python -I src/baselines.py
"""
from __future__ import annotations

import json
import sys
import pathlib
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import DATA, RESULTS

SEED = 20261009
BUDGET_PER_1000 = 10.0
BUSY_ACCOUNT = 5
META = {"key", "name", "version", "label", "category", "family", "wave", "family_basis", "published", "publisher",
        "content_source", "packument_source", "neg_pool", "label_sources", "registry_dist_files",
        "registry_dist_bytes", "split"}


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    idx = np.minimum((p * bins).astype(int), bins - 1)
    tot = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            tot += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(tot)


def platt(s_cal: np.ndarray, y_cal: np.ndarray):
    lr = LogisticRegression(C=1e6, max_iter=1000)
    lr.fit(s_cal.reshape(-1, 1), y_cal)
    return lambda s: lr.predict_proba(np.asarray(s).reshape(-1, 1))[:, 1]


def threshold_for_budget(s_neg: np.ndarray, budget_per_1000: float) -> float:
    """Lowest threshold t (alert when score >= t) with alert rate on negatives <= budget."""
    allowed = int(np.floor(len(s_neg) * budget_per_1000 / 1000.0))
    s = np.sort(s_neg)[::-1]
    if allowed >= len(s):
        return float(s[-1])
    # Alerts are scores >= t; choose t just above the (allowed+1)-th highest negative score.
    return float(np.nextafter(s[allowed], np.inf))


def macro_recall(df: pd.DataFrame, alert: np.ndarray) -> tuple[float, dict]:
    pos = df["label"].values == 1
    per = {}
    for fam, g in df[pos].groupby("family"):
        per[fam] = {"n": int(len(g)), "recall": float(alert[g.index].mean())}
    return (float(np.mean([v["recall"] for v in per.values()])) if per else float("nan")), per


def evaluate(name: str, s_cal, s_test, cal: pd.DataFrame, test: pd.DataFrame, fit_s: float, pred_s: float) -> dict:
    y_cal, y_test = cal["label"].values, test["label"].values
    cal_p = platt(s_cal, y_cal)
    t = threshold_for_budget(s_cal[y_cal == 0], BUDGET_PER_1000)
    alert = s_test >= t
    test = test.reset_index(drop=True)
    mr, per = macro_recall(test, alert)
    fams = sorted(per, key=lambda f: -per[f]["n"])
    largest = fams[0] if fams else None
    mr_wo = float(np.mean([per[f]["recall"] for f in fams[1:]])) if len(fams) > 1 else float("nan")
    rng = np.random.default_rng(SEED)
    boots = []
    for _ in range(2000):
        pick = rng.choice(fams, size=len(fams), replace=True)
        boots.append(np.mean([per[f]["recall"] for f in pick]))
    neg = y_test == 0
    tp, fp = int((alert & ~neg).sum()), int((alert & neg).sum())
    # False alarms per account-month on busy accounts (>= BUSY_ACCOUNT benign releases in test).
    tn = test[neg].copy()
    tn["alert"] = alert[neg]
    tn["month"] = tn["published"].str[:7]
    busy = tn.groupby("publisher").size()
    busy = busy[(busy >= BUSY_ACCOUNT) & (busy.index != "")].index
    tb = tn[tn["publisher"].isin(busy)]
    acct_months = tb.groupby(["publisher", "month"]).size().shape[0]
    p_test = cal_p(s_test)
    return {
        "method": name,
        "threshold": t,
        "calib_alerts_per_1000_benign": float(1000 * (s_cal[y_cal == 0] >= t).mean()),
        "test_positives": int((~neg).sum()), "test_negatives": int(neg.sum()),
        "macro_recall": mr, "macro_recall_ci95_family_bootstrap": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
        "macro_recall_without_largest_family": mr_wo, "largest_family": largest,
        "micro_recall": float(tp / max(1, (~neg).sum())),
        "precision": float(tp / max(1, tp + fp)) if tp + fp else None,
        "alerts_per_1000_benign": float(1000 * fp / max(1, neg.sum())),
        "busy_accounts": int(len(busy)), "busy_account_months": int(acct_months),
        "false_alarms_per_busy_account_month": float(tb["alert"].sum() / acct_months) if acct_months else None,
        "roc_auc": float(roc_auc_score(y_test, s_test)), "average_precision": float(average_precision_score(y_test, s_test)),
        "ece_calibrated": ece(p_test, y_test), "brier_calibrated": float(brier_score_loss(y_test, p_test)),
        "fit_seconds": fit_s, "predict_ms_per_1000": 1000 * pred_s / max(1, len(test)) * 1000,
        "per_family": per,
    }


def main() -> None:
    df = pd.read_csv(DATA / "features.csv.gz", keep_default_na=True, low_memory=False)
    df["label"] = df["label"].astype(int)
    rules = pd.read_csv(RESULTS / "rule_scores.csv")
    df = df.merge(rules[["key", "intrinsic"]], on="key", how="left")
    missing_rule = int(df["intrinsic"].isna().sum())
    feats = [c for c in df.columns if c not in META and c != "intrinsic"]
    X = df[feats].astype(float)
    tr, ca, te = (df["split"] == s for s in ("train", "calib", "test"))
    out = {"budget_alerts_per_1000_benign": BUDGET_PER_1000, "busy_account_min_releases": BUSY_ACCOUNT,
           "features": feats, "rule_scores_missing": missing_rule,
           "sizes": {s: {"rows": int((df["split"] == s).sum()), "positives": int(df.loc[df["split"] == s, "label"].sum())}
                     for s in ("train", "calib", "test")},
           "results": []}
    cal, test = df[ca].reset_index(drop=True), df[te].reset_index(drop=True)

    # 1. Rule scorer (no training).
    t0 = time.time()
    s_cal, s_test = df.loc[ca, "intrinsic"].fillna(0).values, df.loc[te, "intrinsic"].fillna(0).values
    out["results"].append(evaluate("rule_scorer (blastradius scoreIntrinsic)", s_cal, s_test, cal, test, 0.0, time.time() - t0))

    # 2. Logistic regression.
    lr = make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                       LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000, random_state=SEED))
    t0 = time.time(); lr.fit(X[tr], df.loc[tr, "label"]); fit = time.time() - t0
    t0 = time.time(); s_test = lr.predict_proba(X[te])[:, 1]; pred = time.time() - t0
    s_cal = lr.predict_proba(X[ca])[:, 1]
    out["results"].append(evaluate("logistic_regression", s_cal, s_test, cal, test, fit, pred))

    # 3. Gradient-boosted trees.
    gb = HistGradientBoostingClassifier(learning_rate=0.05, max_iter=400, max_leaf_nodes=31, min_samples_leaf=20,
                                        l2_regularization=1.0, class_weight="balanced", random_state=SEED)
    t0 = time.time(); gb.fit(X[tr], df.loc[tr, "label"]); fit = time.time() - t0
    t0 = time.time(); s_test = gb.predict_proba(X[te])[:, 1]; pred = time.time() - t0
    s_cal = gb.predict_proba(X[ca])[:, 1]
    out["results"].append(evaluate("hist_gradient_boosting", s_cal, s_test, cal, test, fit, pred))

    # Logistic-regression coefficients (standardised), for reading what the linear model uses.
    coefs = lr[-1].coef_[0]
    names = list(lr[0].get_feature_names_out(feats)) if hasattr(lr[0], "get_feature_names_out") else feats
    out["lr_top_coefficients"] = sorted(([n, float(c)] for n, c in zip(names, coefs)), key=lambda x: -abs(x[1]))[:20]
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "baselines.json").write_text(json.dumps(out, indent=1) + "\n")
    for r in out["results"]:
        print(f"{r['method']:45s} macroR {r['macro_recall']:.3f} [{r['macro_recall_ci95_family_bootstrap'][0]:.3f},{r['macro_recall_ci95_family_bootstrap'][1]:.3f}] "
              f"w/o-largest {r['macro_recall_without_largest_family']:.3f} microR {r['micro_recall']:.3f} prec {r['precision']} "
              f"alerts/1k {r['alerts_per_1000_benign']:.1f} FA/acct-mo {r['false_alarms_per_busy_account_month']} "
              f"AUC {r['roc_auc']:.3f} AP {r['average_precision']:.3f} ECE {r['ece_calibrated']:.3f}")


if __name__ == "__main__":
    main()
