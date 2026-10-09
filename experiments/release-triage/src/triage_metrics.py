"""Metrics and threshold policy shared by every method in the release-triage experiment.

One file, imported by src/baselines.py (rule scorer, logistic regression, gradient-boosted trees, TF-IDF) and
downloaded by colab/laya_release_triage.ipynb (Laya), so that every method is calibrated, thresholded and scored
by the same code. It needs only numpy, pandas and scikit-learn; nothing here reads the network or the cache.

The rules are fixed in PREREGISTRATION.md:
  * calibration: Platt scaling of the method's score, fitted on the calib split only;
  * threshold: the lowest threshold whose alert rate on calib negatives is at most BUDGET_PER_1000 per 1,000
    benign releases (fitted on calib only; the test split is touched once);
  * macro recall: the mean of per-family recall on test positives, each family counting once;
  * uncertainty: a bootstrap over families (resample families, not rows).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

SEED = 20261009
BUDGET_PER_1000 = 10.0
BUSY_ACCOUNT = 5
N_BOOT = 2000


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
    lr.fit(np.asarray(s_cal, dtype=float).reshape(-1, 1), y_cal)
    return lambda s: lr.predict_proba(np.asarray(s, dtype=float).reshape(-1, 1))[:, 1]


def threshold_for_budget(s_neg: np.ndarray, budget_per_1000: float = BUDGET_PER_1000) -> float:
    """Lowest threshold t (alert when score >= t) with alert rate on negatives <= budget."""
    allowed = int(np.floor(len(s_neg) * budget_per_1000 / 1000.0))
    s = np.sort(np.asarray(s_neg, dtype=float))[::-1]
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


def evaluate(name: str, s_cal, s_test, cal: pd.DataFrame, test: pd.DataFrame, fit_s: float, pred_s: float,
             budget_per_1000: float = BUDGET_PER_1000) -> dict:
    """All pre-registered test metrics for one method. `cal`/`test` need label, family, published, publisher."""
    s_cal, s_test = np.asarray(s_cal, dtype=float), np.asarray(s_test, dtype=float)
    y_cal, y_test = cal["label"].values, test["label"].values
    cal_p = platt(s_cal, y_cal)
    t = threshold_for_budget(s_cal[y_cal == 0], budget_per_1000)
    alert = s_test >= t
    test = test.reset_index(drop=True)
    mr, per = macro_recall(test, alert)
    fams = sorted(per, key=lambda f: -per[f]["n"])
    largest = fams[0] if fams else None
    mr_wo = float(np.mean([per[f]["recall"] for f in fams[1:]])) if len(fams) > 1 else float("nan")
    rng = np.random.default_rng(SEED)
    boots = []
    for _ in range(N_BOOT):
        pick = rng.choice(fams, size=len(fams), replace=True)
        boots.append(np.mean([per[f]["recall"] for f in pick]))
    neg = y_test == 0
    tp, fp = int((alert & ~neg).sum()), int((alert & neg).sum())
    # False alarms per account-month on busy accounts (>= BUSY_ACCOUNT benign releases in test).
    tn = test[neg].copy()
    tn["alert"] = alert[neg]
    tn["month"] = tn["published"].astype(str).str[:7]
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


def alerts(s_cal, y_cal, s, budget_per_1000: float = BUDGET_PER_1000) -> np.ndarray:
    """Boolean alerts on `s` at the threshold fitted on calib negatives (same rule as `evaluate`)."""
    s_cal, y_cal = np.asarray(s_cal, dtype=float), np.asarray(y_cal)
    return np.asarray(s, dtype=float) >= threshold_for_budget(s_cal[y_cal == 0], budget_per_1000)


def paired_family_bootstrap(per_a: dict, per_b: dict, n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    """Macro-recall difference A - B over the families both report, with a family-bootstrap 95% interval.

    `per_a` / `per_b` are the `per_family` dicts of `evaluate` on the same test rows. Families are resampled with
    replacement and the same resample is applied to both methods (a paired bootstrap).
    """
    fams = sorted(set(per_a) & set(per_b))
    d = np.array([per_a[f]["recall"] - per_b[f]["recall"] for f in fams])
    rng = np.random.default_rng(seed)
    boots = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(n_boot)] if len(d) else [float("nan")]
    loo = {f: float(np.delete(d, i).mean()) if len(d) > 1 else float("nan") for i, f in enumerate(fams)}
    return {"families": len(fams), "diff": float(d.mean()) if len(d) else float("nan"),
            "ci95": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
            "leave_one_family_out_diff": loo,
            "min_leave_one_family_out_diff": float(min(loo.values())) if loo else float("nan")}
