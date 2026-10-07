/**
 * The exported "likely next compromise" model (docs/DATA-ML.md §2.6/§3): LightGBM trees, the
 * isotonic calibration table and the decision threshold, in one JSON file written by
 * pack/model/train.py. The bundle names the feature schema it was trained on; a mismatch with
 * src/features is refused, so a model can never be fed features in the wrong order.
 */
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES, FEATURE_SCHEMA, featureArray, type FeatureVector } from '../features/asof.js';
import { calibrate, GbdtModel, type CalibrationTable, type LgbModelJson } from './gbdt.js';

export const MODEL_BUNDLE_SCHEMA = 'blastradius-model/v1';

export interface ModelBundleJson {
  schema: string;
  featureSchema: string;
  featureNames: string[];
  lightgbm: LgbModelJson;
  calibration: CalibrationTable;
  /** Calibrated probability at or above which a release becomes a finding. */
  threshold: number;
  /** Training/backtest metadata (free-form, for reports). */
  meta?: Record<string, unknown>;
}

export class LikelyCompromiseModel {
  readonly trees: GbdtModel;
  readonly threshold: number;
  private readonly table: CalibrationTable;

  constructor(readonly bundle: ModelBundleJson) {
    if (bundle.schema !== MODEL_BUNDLE_SCHEMA) throw new Error(`model bundle schema ${bundle.schema}, expected ${MODEL_BUNDLE_SCHEMA}`);
    if (bundle.featureSchema !== FEATURE_SCHEMA) throw new Error(`model trained on ${bundle.featureSchema}, this build computes ${FEATURE_SCHEMA}`);
    if (bundle.featureNames.length !== FEATURE_NAMES.length || bundle.featureNames.some((n, i) => n !== FEATURE_NAMES[i])) {
      throw new Error('model feature names do not match src/features (order or names differ)');
    }
    if (!(bundle.threshold >= 0 && bundle.threshold <= 1)) throw new Error('model threshold must be in [0, 1]');
    this.trees = new GbdtModel(bundle.lightgbm);
    if (this.trees.sigmoid === undefined) throw new Error('model must be a binary classifier');
    this.table = bundle.calibration;
    calibrate(this.table, 0.5); // validates the table
    this.threshold = bundle.threshold;
  }

  static load(file: string): LikelyCompromiseModel {
    return new LikelyCompromiseModel(JSON.parse(readFileSync(file, 'utf8')) as ModelBundleJson);
  }

  /** Calibrated probability that this release is a compromised one. */
  score(f: FeatureVector): { raw: number; probability: number; calibrated: number; flagged: boolean } {
    const x = featureArray(f);
    const raw = this.trees.raw(x);
    const probability = this.trees.predict(x);
    const calibrated = calibrate(this.table, probability);
    return { raw, probability, calibrated, flagged: calibrated >= this.threshold };
  }
}
