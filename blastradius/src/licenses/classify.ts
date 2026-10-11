/**
 * Obligation categories for SPDX licences, from published classifications only (we do not write
 * our own legal matrix). Order of precedence:
 *
 * 1. Blue Oak Council copyleft guide, families weak / strong / network / maximal
 *    (npm @blueoak/copyleft 10.0.0, CC0-1.0, https://blueoakcouncil.org/copyleft).
 *    "maximal" (e.g. CAL-1.0, Parity, RPL) is shown as network copyleft, its nearest category here.
 * 2. Blue Oak Council licence list, every rated licence is permissive
 *    (npm @blueoak/list 15.0.0, CC0-1.0, https://blueoakcouncil.org/list).
 * 3. For licences Blue Oak does not list (source-available and proprietary terms are out of its
 *    scope): the ScanCode LicenseDB category (CC-BY-4.0, https://scancode-licensedb.aboutcode.org/,
 *    vendored in ./data/scancode-categories.ts), mapped as in SCANCODE_TO_CATEGORY below.
 * 4. Anything else: unknown.
 *
 * One exception: SSPL-1.0 is in Blue Oak's network copyleft family, but it is not OSI-approved and
 * buyers group it with BUSL and Elastic, so ScanCode's "Source-available" decides it (see
 * SCANCODE_FIRST below).
 *
 * Categories describe the kind of obligations, not whether a use is allowed: that is the
 * customer's policy (./policy.ts). Not legal advice.
 */
import { createRequire } from 'node:module';
import type { LicenseCategory } from '../core/types.js';
import { SCANCODE_CATEGORIES, SCANCODE_LICENSEDB, type ScanCodeCategory } from './data/scancode-categories.js';
import { currentId, leaves, parseSpdx } from './spdx.js';
import type { SpdxNode } from 'spdx-expression-parse';

const require = createRequire(import.meta.url);

interface BlueOakList {
  name: string;
  licenses: { id: string; name: string; url?: string }[];
}
type BlueOakCopyleft = Record<'weak' | 'strong' | 'network' | 'maximal', { id: string; name: string }[]>;

const BLUE_OAK_LIST = require('@blueoak/list/index.json') as BlueOakList[];
const BLUE_OAK_COPYLEFT = require('@blueoak/copyleft/index.json') as BlueOakCopyleft;
const BLUE_OAK_LIST_VERSION = (require('@blueoak/list/package.json') as { version: string }).version;
const BLUE_OAK_COPYLEFT_VERSION = (require('@blueoak/copyleft/package.json') as { version: string }).version;

/** Where the classification comes from (shown with every category; required attribution). */
export const CLASSIFICATION_SOURCES = [
  { name: 'Blue Oak Council license list', url: 'https://blueoakcouncil.org/list', version: `@blueoak/list ${BLUE_OAK_LIST_VERSION}`, license: 'CC0-1.0' },
  { name: 'Blue Oak Council copyleft guide', url: 'https://blueoakcouncil.org/copyleft', version: `@blueoak/copyleft ${BLUE_OAK_COPYLEFT_VERSION}`, license: 'CC0-1.0' },
  { name: 'ScanCode LicenseDB (AboutCode)', url: 'https://scancode-licensedb.aboutcode.org/', version: `fetched ${SCANCODE_LICENSEDB.fetchedAt}`, license: SCANCODE_LICENSEDB.license },
] as const;

export const NOT_LEGAL_ADVICE =
  'Licence categories come from Blue Oak Council and ScanCode LicenseDB; policy results apply your own rules. This is not legal advice.';

/** How each ScanCode category maps onto ours. */
export const SCANCODE_TO_CATEGORY: Readonly<Record<ScanCodeCategory, LicenseCategory>> = {
  Permissive: 'permissive',
  'Public Domain': 'permissive',
  'Copyleft Limited': 'weak_copyleft',
  Copyleft: 'strong_copyleft',
  'Source-available': 'source_available',
  'Non-Commercial': 'source_available',
  'Free Restricted': 'source_available',
  'Proprietary Free': 'proprietary',
  Commercial: 'proprietary',
  'Patent License': 'unknown',
  CLA: 'unknown',
  'Unstated License': 'unknown',
};

export interface CategoryOf {
  category: LicenseCategory;
  /** Which classification decided it. */
  by: 'blueoak-copyleft' | 'blueoak-list' | 'scancode' | 'npm' | 'none';
}

/** Licences where ScanCode's category is used ahead of Blue Oak's (reason in the header comment). */
export const SCANCODE_FIRST: ReadonlySet<string> = new Set(['SSPL-1.0']);

const BY_ID = new Map<string, CategoryOf>();
for (const fam of ['maximal', 'network', 'strong', 'weak'] as const) {
  const category: LicenseCategory = fam === 'weak' ? 'weak_copyleft' : fam === 'strong' ? 'strong_copyleft' : 'network_copyleft';
  for (const l of BLUE_OAK_COPYLEFT[fam] ?? []) if (!BY_ID.has(l.id)) BY_ID.set(l.id, { category, by: 'blueoak-copyleft' });
}
for (const rating of BLUE_OAK_LIST) for (const l of rating.licenses) if (!BY_ID.has(l.id)) BY_ID.set(l.id, { category: 'permissive', by: 'blueoak-list' });

/** Category of one SPDX licence id (deprecated ids are mapped to their current form first). */
export function categoryOfId(id: string): CategoryOf {
  const sc = SCANCODE_CATEGORIES[id];
  if (sc && SCANCODE_FIRST.has(id)) return { category: SCANCODE_TO_CATEGORY[sc], by: 'scancode' };
  const known = BY_ID.get(id);
  if (known) return known;
  if (sc) return { category: SCANCODE_TO_CATEGORY[sc], by: 'scancode' };
  return { category: 'unknown', by: 'none' };
}

/**
 * Restrictiveness order used to combine categories: in an AND every licence applies, so the
 * combination is the most restrictive; in an OR the licensee may pick, so the least. Unknown
 * ranks highest, so it is never hidden by a known licence it is combined with.
 */
export const CATEGORY_RANK: Readonly<Record<LicenseCategory, number>> = {
  permissive: 0,
  weak_copyleft: 1,
  strong_copyleft: 2,
  network_copyleft: 3,
  source_available: 4,
  proprietary: 5,
  unknown: 6,
};

export const CATEGORY_LABEL: Readonly<Record<LicenseCategory, string>> = {
  permissive: 'Permissive',
  weak_copyleft: 'Weak copyleft',
  strong_copyleft: 'Strong copyleft',
  network_copyleft: 'Network copyleft',
  source_available: 'Source-available',
  proprietary: 'Proprietary',
  unknown: 'Unknown',
};

function most(a: LicenseCategory, b: LicenseCategory): LicenseCategory {
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}
function least(a: LicenseCategory, b: LicenseCategory): LicenseCategory {
  return CATEGORY_RANK[a] <= CATEGORY_RANK[b] ? a : b;
}

function categoryOfNode(node: SpdxNode): LicenseCategory {
  if ('license' in node) return categoryOfId(currentId(node)).category;
  const l = categoryOfNode(node.left);
  const r = categoryOfNode(node.right);
  return node.conjunction === 'and' ? most(l, r) : least(l, r);
}

/** Category of one SPDX expression (unknown when it does not parse). */
export function categoryOfExpression(expression: string): LicenseCategory {
  const ast = parseSpdx(expression);
  return ast ? categoryOfNode(ast) : 'unknown';
}

/**
 * Category of a set of expressions whose relation is unspecified (deps.dev lists several
 * licences "with their relationship unspecified"): treated as all applying, so the most
 * restrictive wins. An empty set is unknown.
 */
export function categoryOfSet(expressions: readonly string[]): LicenseCategory {
  if (expressions.length === 0) return 'unknown';
  return expressions.map(categoryOfExpression).reduce(most);
}

/** Licence ids an expression set names, with each id's category and which list decided it. */
export function classifyIds(expressions: readonly string[]): { id: string; category: LicenseCategory; by: CategoryOf['by'] }[] {
  const ids = new Set<string>();
  for (const e of expressions) {
    const ast = parseSpdx(e);
    if (ast) for (const leaf of leaves(ast)) ids.add(currentId(leaf));
  }
  return [...ids].sort().map((id) => ({ id, ...categoryOfId(id) }));
}
