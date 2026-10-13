/**
 * Licence policy: the customer's own rules, never ours (docs/WHO-BEHIND-PLAN.md L4).
 *
 * A policy maps each obligation category (./classify.ts) and, optionally, single SPDX ids to
 * allow / review / deny. An id rule wins over its category. Expressions are evaluated with the
 * SPDX operators (SPDX spec, Annex D "SPDX license expressions"): in `A OR B` the licensee may
 * choose, so the most favourable side counts; in `A AND B` both apply, so the least favourable
 * side counts. Several declared licences whose relation the source does not state are treated as
 * all applying (AND). Unknown or unparseable licences take the `unknown` decision, which can never
 * be "allow". spdx-satisfies is used in tests as an independent check of the allow logic.
 *
 * The shipped default is a conservative template: permissive allowed, everything else needs
 * review. Nothing is denied until the customer says so. Not legal advice.
 */
import { z } from 'zod';
import { LICENSE_CATEGORIES, LICENSE_POLICY_DECISIONS, type LicenseCategory, type LicensePolicy, type LicensePolicyDecision, type LicenseStatus } from '../core/types.js';
import { CATEGORY_LABEL, categoryOfId } from './classify.js';
import { currentId, parseSpdx } from './spdx.js';
import type { SpdxNode } from 'spdx-expression-parse';

export const POLICY_DECISIONS = LICENSE_POLICY_DECISIONS;
export type PolicyDecision = LicensePolicyDecision;
export type { LicensePolicy };

export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  version: 1,
  categories: {
    permissive: 'allow',
    weak_copyleft: 'review',
    strong_copyleft: 'review',
    network_copyleft: 'review',
    source_available: 'review',
    proprietary: 'review',
    unknown: 'review',
  },
  ids: [],
};

const decision = z.enum(POLICY_DECISIONS);

export const LicensePolicySchema = z
  .object({
    version: z.literal(1),
    categories: z.object({
      permissive: decision,
      weak_copyleft: decision,
      strong_copyleft: decision,
      network_copyleft: decision,
      source_available: decision,
      proprietary: decision,
      unknown: z.enum(['review', 'deny'], { message: 'Unknown licences can only be reviewed or denied, never allowed' }),
    }),
    ids: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .max(100)
            .refine((id) => parseSpdx(id) !== null && !/\s/.test(id), { message: 'Must be one SPDX licence id' }),
          decision,
          note: z.string().max(300).optional(),
        }),
      )
      .max(500),
  })
  .strict();

/** Validate a policy from a request or file. Throws a ZodError with field paths. */
export function parseLicensePolicy(input: unknown): LicensePolicy {
  const p = LicensePolicySchema.parse(input);
  const seen = new Set<string>();
  const ids = p.ids.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { version: 1, categories: p.categories, ids: ids.map((r) => (r.note ? { id: r.id, decision: r.decision, note: r.note } : { id: r.id, decision: r.decision })) };
}

const RANK: Record<PolicyDecision, number> = { allow: 0, review: 1, deny: 2 };

export interface PolicyResult {
  decision: PolicyDecision;
  /** The rule that decided, e.g. 'licence AGPL-3.0-only' or 'category Network copyleft'. */
  rule: string;
}

function leafResult(id: string, policy: LicensePolicy): PolicyResult {
  const own = policy.ids.find((r) => r.id === id);
  if (own) return { decision: own.decision, rule: `licence ${id}` };
  const { category } = categoryOfId(id);
  return { decision: policy.categories[category], rule: `category ${CATEGORY_LABEL[category]} (${id})` };
}

function evalNode(node: SpdxNode, policy: LicensePolicy): PolicyResult {
  if ('license' in node) {
    // An id rule may name the id as written (e.g. a deprecated "GPL-2.0") or its current form.
    const written = node.license;
    if (policy.ids.some((r) => r.id === written)) return leafResult(written, policy);
    return leafResult(currentId(node), policy);
  }
  const l = evalNode(node.left, policy);
  const r = evalNode(node.right, policy);
  if (node.conjunction === 'or') return RANK[r.decision] < RANK[l.decision] ? r : l;
  return RANK[r.decision] > RANK[l.decision] ? r : l;
}

const STATUS_RULE: Partial<Record<LicenseStatus, string>> = {
  unknown: 'no licence declared',
  non_standard: 'licence not in the SPDX list',
  see_file: 'licence only in a file ("SEE LICENSE IN")',
};

/**
 * Evaluate a component's declared licences. `expressions` are the parsed entries; `status` is
 * the weakest status of the entries (an entry we could not parse makes the whole set unknown).
 */
export function evaluatePolicy(expressions: readonly string[], status: LicenseStatus, policy: LicensePolicy = DEFAULT_LICENSE_POLICY): PolicyResult {
  if (status === 'unlicensed') return { decision: policy.categories.proprietary, rule: 'category Proprietary (npm "UNLICENSED")' };
  const unknownRule = STATUS_RULE[status];
  if (unknownRule || expressions.length === 0) return { decision: policy.categories.unknown, rule: `unknown: ${unknownRule ?? 'no licence declared'}` };
  let worst: PolicyResult | undefined;
  for (const e of expressions) {
    const ast = parseSpdx(e);
    const r = ast ? evalNode(ast, policy) : { decision: policy.categories.unknown, rule: 'unknown: licence not in the SPDX list' };
    if (!worst || RANK[r.decision] > RANK[worst.decision]) worst = r;
  }
  return worst!;
}

export function isLicenseCategory(v: unknown): v is LicenseCategory {
  return typeof v === 'string' && (LICENSE_CATEGORIES as readonly string[]).includes(v);
}
