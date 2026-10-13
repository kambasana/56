/**
 * SPDX licence expressions: read a declared licence string into a valid SPDX expression without
 * inventing one.
 *
 * - Parsing: spdx-expression-parse (the parser npm itself uses), SPDX License List ids from
 *   spdx-license-ids (CC0-1.0).
 * - Misspellings: spdx-correct, accepted only when it does not add a version the string did not
 *   state ("BSL-1.1" is not "BSL-1.0", "GPL" is not "GPL-3.0-or-later"), and always marked
 *   `corrected` so the original stays visible.
 * - npm's documented special values: "UNLICENSED" (no rights granted) and "SEE LICENSE IN <file>"
 *   (https://docs.npmjs.com/cli/v11/configuring-npm/package-json#license).
 * - SPDX "NOASSERTION" / "NONE" and deps.dev's "non-standard" stay unknown / non-standard.
 */
import { createRequire } from 'node:module';
import parse, { type SpdxLeaf, type SpdxNode } from 'spdx-expression-parse';
import correct from 'spdx-correct';
import type { LicenseStatus } from '../core/types.js';

const require = createRequire(import.meta.url);
const DEPRECATED_IDS: ReadonlySet<string> = new Set(require('spdx-license-ids/deprecated.json') as string[]);
const LICENSE_IDS: ReadonlySet<string> = new Set(require('spdx-license-ids') as string[]);

export interface NormalizedLicense {
  /** The string as given (trimmed, capped). */
  raw: string;
  /** Canonical SPDX expression, when there is one. */
  expression?: string;
  status: LicenseStatus;
  /** For `corrected`: spdx-correct's answer. */
  correctedFrom?: string;
}

const MAX_RAW = 200;

/** Status order, weakest last: a combination takes the weakest of its entries. */
const STATUS_RANK: Record<LicenseStatus, number> = { spdx: 0, corrected: 1, see_file: 2, unlicensed: 2, non_standard: 3, unknown: 4 };

export function weakestStatus(list: readonly LicenseStatus[]): LicenseStatus {
  let out: LicenseStatus = list.length === 0 ? 'unknown' : 'spdx';
  for (const s of list) if (STATUS_RANK[s] > STATUS_RANK[out]) out = s;
  return out;
}

/** Version-like numbers in a string, as numbers ("Apache 2" and "Apache-2.0" both give 2). */
function versionNumbers(s: string): number[] {
  return (s.match(/\d+(?:\.\d+)*/g) ?? []).map((n) => Number.parseFloat(n)).filter((n) => Number.isFinite(n));
}

/** spdx-correct may fix spelling and case, but must not add or change a version number. */
function acceptableCorrection(raw: string, corrected: string): boolean {
  const have = versionNumbers(raw);
  return versionNumbers(corrected).every((n) => have.includes(n));
}

/** Parse; null when not a valid SPDX expression. */
export function parseSpdx(expression: string): SpdxNode | null {
  try {
    return parse(expression);
  } catch {
    return null;
  }
}

/** Serialise an AST back to a canonical expression (OR inside AND gets parentheses). */
export function formatSpdx(node: SpdxNode, parent?: 'and' | 'or'): string {
  if ('license' in node) {
    let s = node.license + (node.plus ? '+' : '');
    if (node.exception) s += ` WITH ${node.exception}`;
    return s;
  }
  const inner = `${formatSpdx(node.left, node.conjunction)} ${node.conjunction.toUpperCase()} ${formatSpdx(node.right, node.conjunction)}`;
  return parent !== undefined && parent !== node.conjunction ? `(${inner})` : inner;
}

/** Every licence leaf in an expression. */
export function leaves(node: SpdxNode): SpdxLeaf[] {
  return 'license' in node ? [node] : [...leaves(node.left), ...leaves(node.right)];
}

/**
 * The SPDX id to classify a leaf by: deprecated GNU-style ids map to their current form as the
 * SPDX License List documents ("GPL-2.0" → "GPL-2.0-only", "GPL-2.0+" → "GPL-2.0-or-later").
 */
export function currentId(leaf: SpdxLeaf): string {
  const id = leaf.license;
  const bare = id.endsWith('+') ? id.slice(0, -1) : id;
  const plus = leaf.plus === true || id.endsWith('+');
  if (plus && LICENSE_IDS.has(`${bare}-or-later`)) return `${bare}-or-later`;
  if (DEPRECATED_IDS.has(bare) && LICENSE_IDS.has(`${bare}-only`)) return `${bare}-only`;
  return bare;
}

export function isDeprecatedId(id: string): boolean {
  return DEPRECATED_IDS.has(id);
}

/** Read one declared licence string. */
export function normalizeLicense(input: string): NormalizedLicense {
  const raw = input.trim().slice(0, MAX_RAW);
  if (!raw || /^(NOASSERTION|NONE)$/i.test(raw)) return { raw, status: 'unknown' };
  if (raw.toLowerCase() === 'non-standard') return { raw, status: 'non_standard' };
  if (raw === 'UNLICENSED' || raw.toUpperCase() === 'UNLICENSED') return { raw, status: 'unlicensed' };
  if (/^SEE LICEN[CS]E IN /i.test(raw)) return { raw, status: 'see_file' };
  const ast = parseSpdx(raw);
  if (ast) return { raw, expression: formatSpdx(ast), status: 'spdx' };
  let fixed: string | null = null;
  try {
    fixed = correct(raw);
  } catch {
    fixed = null;
  }
  if (fixed && acceptableCorrection(raw, fixed)) {
    const fixedAst = parseSpdx(fixed);
    if (fixedAst) return { raw, expression: formatSpdx(fixedAst), status: 'corrected', correctedFrom: raw };
  }
  return { raw, status: 'non_standard' };
}

/** The SPDX licence ids (classification ids) an expression names, sorted and unique. */
export function licenseIds(expression: string): string[] {
  const ast = parseSpdx(expression);
  if (!ast) return [];
  return [...new Set(leaves(ast).map(currentId))].sort();
}
