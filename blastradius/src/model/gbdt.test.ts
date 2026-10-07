import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES, FEATURE_SCHEMA } from '../features/asof.js';
import { LikelyCompromiseModel, MODEL_BUNDLE_SCHEMA } from './bundle.js';
import { parity } from './cli.js';
import { calibrate, GbdtModel, type LgbModelJson } from './gbdt.js';

/**
 * Hand-written model in LightGBM dump_model shape:
 *   tree 0: f0 <= 1.5 (NaN goes left)  → 0.5
 *           else f1 <= 0 (zero/NaN goes right) → -0.25 | 1.0
 *   tree 1: f1 <= 10 (missing_type None: NaN is treated as 0) → 0.1 | -0.3
 */
const tiny: LgbModelJson = {
  version: 'v4',
  num_class: 1,
  num_tree_per_iteration: 1,
  objective: 'binary sigmoid:1',
  max_feature_idx: 1,
  feature_names: ['f0', 'f1'],
  tree_info: [
    {
      tree_index: 0,
      tree_structure: {
        split_feature: 0,
        threshold: 1.5,
        decision_type: '<=',
        default_left: true,
        missing_type: 'NaN',
        left_child: { leaf_index: 0, leaf_value: 0.5 },
        right_child: {
          split_feature: 1,
          threshold: 0,
          decision_type: '<=',
          default_left: false,
          missing_type: 'Zero',
          left_child: { leaf_index: 1, leaf_value: -0.25 },
          right_child: { leaf_index: 2, leaf_value: 1.0 },
        },
      },
    },
    {
      tree_index: 1,
      tree_structure: {
        split_feature: 1,
        threshold: 10,
        decision_type: '<=',
        default_left: true,
        missing_type: 'None',
        left_child: { leaf_index: 0, leaf_value: 0.1 },
        right_child: { leaf_index: 1, leaf_value: -0.3 },
      },
    },
  ],
};

describe('GbdtModel (LightGBM dump_model evaluator)', () => {
  const m = new GbdtModel(tiny);
  // Expected values computed by hand: raw = sum of leaves, p = 1 / (1 + e^-raw).
  const cases: [number[], number, number][] = [
    [[1, 5], 0.6, 0.6456563062257954],
    [[NaN, 5], 0.6, 0.6456563062257954], // NaN split with default_left → left
    [[2, 0], 1.1, 0.7502601055951177], // zero with missing_type Zero → default (right)
    [[2, NaN], 1.1, 0.7502601055951177], // NaN under missing_type Zero is zero → right; tree 1 treats it as 0 → left
    [[2, -1], -0.15, 0.46257015465625045],
    [[2, 11], 0.7, 0.6681877721681662],
    [[1.5, 11], 0.2, 1 / (1 + Math.exp(-0.2))], // threshold is inclusive (<=)
  ];
  it.each(cases)('x=%j → raw %d', (x, raw, p) => {
    expect(m.raw(x)).toBeCloseTo(raw, 12);
    expect(m.predict(x)).toBeCloseTo(p, 12);
  });

  it('reads the sigmoid parameter', () => {
    const m2 = new GbdtModel({ ...tiny, objective: 'binary sigmoid:2' });
    expect(m2.predict([1, 5])).toBeCloseTo(0.7685247834990175, 12);
  });

  it('a single-leaf tree contributes its value', () => {
    const m3 = new GbdtModel({ ...tiny, tree_info: [...tiny.tree_info, { tree_structure: { leaf_value: -0.6 } }] });
    expect(m3.raw([1, 5])).toBeCloseTo(0, 12);
  });

  it('rejects what it cannot evaluate', () => {
    const cat = structuredClone(tiny);
    (cat.tree_info[0]!.tree_structure as any).decision_type = '==';
    expect(() => new GbdtModel(cat)).toThrow(/categorical/);
    expect(() => new GbdtModel({ ...tiny, num_class: 3 })).toThrow(/multiclass/);
    expect(() => new GbdtModel({ ...tiny, objective: 'lambdarank' })).toThrow(/objective/);
    expect(() => new GbdtModel({ ...tiny, max_feature_idx: 0 })).toThrow(/out of range/);
  });
});

describe('isotonic calibration table', () => {
  const t = { x: [0.1, 0.4, 0.8], y: [0, 0.2, 0.9] };
  it('interpolates linearly and clips at the ends (sklearn out_of_bounds="clip")', () => {
    expect(calibrate(t, 0)).toBe(0);
    expect(calibrate(t, 0.1)).toBe(0);
    expect(calibrate(t, 0.25)).toBeCloseTo(0.1, 12);
    expect(calibrate(t, 0.4)).toBeCloseTo(0.2, 12);
    expect(calibrate(t, 0.6)).toBeCloseTo(0.55, 12);
    expect(calibrate(t, 1)).toBe(0.9);
    expect(calibrate({ x: [0.5], y: [0.3] }, 0.9)).toBe(0.3);
  });
});

describe('model bundle and parity helper', () => {
  const lgb: LgbModelJson = { ...tiny, max_feature_idx: FEATURE_NAMES.length - 1, feature_names: [...FEATURE_NAMES] };
  const bundle = { schema: MODEL_BUNDLE_SCHEMA, featureSchema: FEATURE_SCHEMA, featureNames: [...FEATURE_NAMES], lightgbm: lgb, calibration: { x: [0.5, 0.8], y: [0.1, 0.9] }, threshold: 0.5 };

  it('scores a feature vector: trees, sigmoid, calibration, threshold', () => {
    const m = new LikelyCompromiseModel(bundle);
    const f = Object.fromEntries(FEATURE_NAMES.map((n) => [n, NaN])) as Record<string, number>;
    f[FEATURE_NAMES[0]] = 2;
    f[FEATURE_NAMES[1]] = 11; // raw 0.7 → p 0.66819 → calibrated 0.1 + (0.16819 / 0.3) · 0.8
    const s = m.score(f as never);
    expect(s.raw).toBeCloseTo(0.7, 12);
    expect(s.calibrated).toBeCloseTo(0.1 + ((0.6681877721681662 - 0.5) / 0.3) * 0.8, 12);
    expect(s.flagged).toBe(true);
  });

  it('refuses a bundle trained on other features', () => {
    expect(() => new LikelyCompromiseModel({ ...bundle, featureSchema: 'x' })).toThrow(/trained on/);
    expect(() => new LikelyCompromiseModel({ ...bundle, featureNames: [...FEATURE_NAMES].reverse() })).toThrow(/feature names/);
  });

  it('parity passes within tolerance and fails outside it', () => {
    const m = new GbdtModel(tiny);
    expect(parity(m, [{ features: [2, null], raw: 1.1, prob: 0.7502601055951177 }], 1e-6).ok).toBe(true);
    expect(parity(m, [{ features: [2, null], raw: 1.1 + 1e-5, prob: 0.7502601055951177 }], 1e-6)).toMatchObject({ ok: false, failures: 1 });
  });
});
