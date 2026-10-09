"""Step 6: baselines on the test split.

  1. rule scorer: blastradius scoreIntrinsic on the same releases (results/rule_scores.csv from rule_scorer.ts);
  2. logistic regression (median imputation + missing indicators, standardised, class-balanced);
  3. gradient-boosted trees (scikit-learn HistGradientBoostingClassifier, native NaN handling, class-balanced);
  4. TF-IDF + logistic regression on the serialised Laya state (the exact text Laya reads: facts and bounded text),
     class-balanced. A cheap text model on the same input, so a Laya win cannot come from the input alone.
Models 2-4 are trained on train only, with the fixed hyperparameters below (no tuning for any method). For every method, a Platt calibrator and the alert threshold are fitted on
calib only; the test split is touched once.

Threshold policy (fixed before looking at test): the lowest threshold whose alert rate on calib negatives is at
most BUDGET_PER_1000 per 1,000 benign releases.

Reported on test: per-family recall, macro recall (mean over families; each family counts once), macro recall
without the largest test family, a family bootstrap 95% interval for macro recall, precision, alerts per 1,000
benign releases, false alarms per account-month for accounts with >= BUSY_ACCOUNT releases in test, ROC AUC,
average precision, ECE (10 equal-width bins, calibrated probability), Brier, run time.

Metrics, calibration and the threshold rule live in src/triage_metrics.py, which the Colab notebook uses for Laya.
Writes results/baselines.json and results/baseline_scores.csv.gz (per-row scores on calib and test, for the
notebook's paired family bootstrap).

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
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import DATA, RESULTS
from triage_metrics import BUDGET_PER_1000, BUSY_ACCOUNT, SEED, evaluate

META = {"key", "name", "version", "label", "category", "family", "wave", "family_basis", "published", "publisher",
        "content_source", "packument_source", "neg_pool", "label_sources", "registry_dist_files",
        "registry_dist_bytes", "content_dir_entries", "split"}


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
    scores = {"rule_scorer": (s_cal, s_test)}

    # 2. Logistic regression.
    lr = make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                       LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000, random_state=SEED))
    t0 = time.time(); lr.fit(X[tr], df.loc[tr, "label"]); fit = time.time() - t0
    t0 = time.time(); s_test = lr.predict_proba(X[te])[:, 1]; pred = time.time() - t0
    s_cal = lr.predict_proba(X[ca])[:, 1]
    out["results"].append(evaluate("logistic_regression", s_cal, s_test, cal, test, fit, pred))
    scores["logistic_regression"] = (s_cal, s_test)

    # 3. Gradient-boosted trees.
    gb = HistGradientBoostingClassifier(learning_rate=0.05, max_iter=400, max_leaf_nodes=31, min_samples_leaf=20,
                                        l2_regularization=1.0, class_weight="balanced", random_state=SEED)
    t0 = time.time(); gb.fit(X[tr], df.loc[tr, "label"]); fit = time.time() - t0
    t0 = time.time(); s_test = gb.predict_proba(X[te])[:, 1]; pred = time.time() - t0
    s_cal = gb.predict_proba(X[ca])[:, 1]
    out["results"].append(evaluate("hist_gradient_boosting", s_cal, s_test, cal, test, fit, pred))
    scores["hist_gradient_boosting"] = (s_cal, s_test)

    # 4. TF-IDF + logistic regression on the serialised state (json.dumps(state, ensure_ascii=False) is what
    #    laya's serialize_state feeds the tokenizer).
    text = {}
    for sp in ("train", "calib", "test"):
        with open(DATA / f"{sp}.jsonl", encoding="utf-8") as fh:
            for line in fh:
                d = json.loads(line)
                text[d["id"]] = json.dumps(d["state"], ensure_ascii=False)
    missing_text = int((~df["key"].isin(text.keys())).sum())
    if missing_text:
        raise SystemExit(f"{missing_text} feature rows have no state in data/*.jsonl")
    docs = df["key"].map(text)
    tf = make_pipeline(TfidfVectorizer(token_pattern=r"[A-Za-z_][A-Za-z0-9_.\-]{1,40}|\d+", ngram_range=(1, 2),
                                       min_df=2, max_features=200_000, sublinear_tf=True),
                       LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000, random_state=SEED))
    t0 = time.time(); tf.fit(docs[tr], df.loc[tr, "label"]); fit = time.time() - t0
    t0 = time.time(); s_test = tf.predict_proba(docs[te])[:, 1]; pred = time.time() - t0
    s_cal = tf.predict_proba(docs[ca])[:, 1]
    out["results"].append(evaluate("tfidf_logistic_regression (serialised state)", s_cal, s_test, cal, test, fit, pred))
    scores["tfidf_logistic_regression"] = (s_cal, s_test)

    # Per-row scores on calib and test, so the notebook can compute Laya's paired family bootstrap against each.
    rows = []
    for sp, part in (("calib", cal), ("test", test)):
        base = part[["key", "label", "family", "category", "published", "publisher"]].copy()
        base.insert(0, "split", sp)
        for m, (sc, st) in scores.items():
            base[m] = sc if sp == "calib" else st
        rows.append(base)
    RESULTS.mkdir(exist_ok=True)
    pd.concat(rows).to_csv(RESULTS / "baseline_scores.csv.gz", index=False, compression="gzip")

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
