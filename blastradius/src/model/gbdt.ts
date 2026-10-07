/**
 * Evaluator for LightGBM `Booster.dump_model()` JSON (docs/DATA-ML.md §2.6). No Python at scan time.
 *
 * Supported: numerical splits (decision_type "<="), missing values (missing_type None / Zero / NaN
 * with default_left), binary objective with sigmoid, regression-style raw output. Categorical
 * splits and multiclass models are rejected at load time rather than silently mis-scored.
 *
 * Semantics follow LightGBM's Tree::NumericalDecision:
 *   if value is NaN and missing_type != NaN → value = 0
 *   if (missing_type == Zero and |value| <= 1e-35) or (missing_type == NaN and value is NaN)
 *     → go to default_left ? left : right
 *   else value <= threshold ? left : right
 */

export interface LgbLeaf {
  leaf_value: number;
  leaf_index?: number;
}

export interface LgbSplit {
  split_feature: number;
  threshold: number;
  decision_type: string;
  default_left: boolean;
  missing_type: 'None' | 'Zero' | 'NaN';
  left_child: LgbNode;
  right_child: LgbNode;
}

export type LgbNode = LgbLeaf | LgbSplit;

export interface LgbModelJson {
  version?: string;
  num_class?: number;
  num_tree_per_iteration?: number;
  objective?: string;
  average_output?: boolean;
  max_feature_idx?: number;
  feature_names?: string[];
  tree_info: { tree_index?: number; shrinkage?: number; tree_structure: LgbNode }[];
}

const ZERO_THRESHOLD = 1e-35;
const MAX_DEPTH = 64;

function isSplit(n: LgbNode): n is LgbSplit {
  return typeof (n as LgbSplit).split_feature === 'number';
}

export class GbdtModel {
  readonly featureNames: readonly string[];
  readonly sigmoid: number | undefined;
  private readonly trees: LgbNode[];
  private readonly average: boolean;

  constructor(json: LgbModelJson) {
    if (!json || !Array.isArray(json.tree_info)) throw new Error('not a LightGBM dump_model JSON (no tree_info)');
    if ((json.num_class ?? 1) !== 1 || (json.num_tree_per_iteration ?? 1) !== 1) throw new Error('multiclass models are not supported');
    const obj = json.objective ?? '';
    const m = /^binary(?:\s+sigmoid:([0-9.eE+-]+))?/.exec(obj);
    if (m) this.sigmoid = m[1] ? Number(m[1]) : 1;
    else if (obj !== '' && !/^(regression|none|custom)\b/.test(obj)) throw new Error(`unsupported objective "${obj}"`);
    this.featureNames = json.feature_names ?? [];
    this.average = json.average_output === true;
    const nFeatures = (json.max_feature_idx ?? -1) + 1;
    this.trees = json.tree_info.map((t, i) => {
      validate(t.tree_structure, nFeatures, 0, `tree ${i}`);
      return t.tree_structure;
    });
  }

  get treeCount(): number {
    return this.trees.length;
  }

  /** Sum of leaf values (LightGBM `predict(raw_score=True)`). */
  raw(x: readonly number[]): number {
    let sum = 0;
    for (const t of this.trees) sum += leafValue(t, x);
    return this.average && this.trees.length > 0 ? sum / this.trees.length : sum;
  }

  /** LightGBM `predict()`: sigmoid for binary objectives, raw otherwise. */
  predict(x: readonly number[]): number {
    const r = this.raw(x);
    return this.sigmoid === undefined ? r : 1 / (1 + Math.exp(-this.sigmoid * r));
  }
}

function validate(n: LgbNode, nFeatures: number, depth: number, where: string): void {
  if (depth > MAX_DEPTH) throw new Error(`${where}: deeper than ${MAX_DEPTH}`);
  if (!isSplit(n)) {
    if (typeof n.leaf_value !== 'number' || !Number.isFinite(n.leaf_value)) throw new Error(`${where}: leaf without a finite leaf_value`);
    return;
  }
  if (n.decision_type !== '<=') throw new Error(`${where}: unsupported decision_type "${n.decision_type}" (categorical splits are not supported)`);
  if (!['None', 'Zero', 'NaN'].includes(n.missing_type)) throw new Error(`${where}: unknown missing_type "${n.missing_type}"`);
  if (!Number.isInteger(n.split_feature) || n.split_feature < 0 || (nFeatures > 0 && n.split_feature >= nFeatures)) {
    throw new Error(`${where}: split_feature ${n.split_feature} out of range`);
  }
  if (typeof n.threshold !== 'number') throw new Error(`${where}: threshold is not a number`);
  validate(n.left_child, nFeatures, depth + 1, where);
  validate(n.right_child, nFeatures, depth + 1, where);
}

function leafValue(root: LgbNode, x: readonly number[]): number {
  let n = root;
  while (isSplit(n)) {
    let v = x[n.split_feature];
    if (v === undefined || v === null) v = NaN;
    if (Number.isNaN(v) && n.missing_type !== 'NaN') v = 0;
    if ((n.missing_type === 'Zero' && Math.abs(v) <= ZERO_THRESHOLD) || (n.missing_type === 'NaN' && Number.isNaN(v))) {
      n = n.default_left ? n.left_child : n.right_child;
    } else {
      n = v <= n.threshold ? n.left_child : n.right_child;
    }
  }
  return n.leaf_value;
}

/**
 * Isotonic calibration table (sklearn IsotonicRegression with out_of_bounds="clip"): linear
 * interpolation between the fitted (x, y) thresholds, clipped to the end values.
 */
export interface CalibrationTable {
  x: number[];
  y: number[];
}

export function calibrate(table: CalibrationTable, p: number): number {
  const { x, y } = table;
  if (x.length === 0 || x.length !== y.length) throw new Error('calibration table needs matching, non-empty x and y');
  if (Number.isNaN(p)) return NaN;
  if (p <= x[0]!) return y[0]!;
  if (p >= x[x.length - 1]!) return y[y.length - 1]!;
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid]! <= p) lo = mid;
    else hi = mid;
  }
  const x0 = x[lo]!;
  const x1 = x[hi]!;
  if (x1 === x0) return y[hi]!;
  return y[lo]! + ((p - x0) / (x1 - x0)) * (y[hi]! - y[lo]!);
}
