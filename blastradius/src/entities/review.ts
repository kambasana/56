/**
 * Review state for entity links (PLAN §3.3 review queue).
 *
 * A JSON file records human decisions about links:
 *
 * ```json
 * { "version": 1,
 *   "decisions": [
 *     { "from": "account:npm/foo", "to": "account:github/foo", "relation": "linked_to",
 *       "decision": "accept", "reviewer": "alice", "at": "2026-01-01", "note": "same profile link" } ] }
 * ```
 *
 * `accept` marks a link reviewed (so scoring may use it); `reject` removes it. Decisions about
 * links that are not present are ignored (reported as `unmatched`).
 */
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { EntityLink } from '../core/types.js';
import { REVIEW_CONFIDENCE_THRESHOLD } from '../scoring/weights.js';
import { linkKey } from './resolve.js';

const decisionSchema = z
  .object({
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512),
    relation: z.enum(['maintains', 'publishes', 'owns', 'funds', 'member_of', 'linked_to']),
    decision: z.enum(['accept', 'reject']),
    reviewer: z.string().min(1).max(100).optional(),
    at: z.string().max(40).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const reviewStateSchema = z
  .object({
    version: z.literal(1),
    decisions: z.array(decisionSchema),
  })
  .strict();

export type ReviewDecision = z.infer<typeof decisionSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const EMPTY_REVIEW_STATE: ReviewState = { version: 1, decisions: [] };

/** Parse a review-state value; throws an Error with readable messages when invalid. */
export function parseReviewState(value: unknown): ReviewState {
  const res = reviewStateSchema.safeParse(value);
  if (!res.success) {
    throw new Error(
      `invalid review state: ${res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return res.data;
}

const MAX_REVIEW_STATE_BYTES = 10_000_000;

/** Load a review-state JSON file. A missing file yields an empty state. */
export async function loadReviewState(file: string): Promise<ReviewState> {
  let text: string;
  try {
    if ((await stat(file)).size > MAX_REVIEW_STATE_BYTES) throw new Error('review state file too large');
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, decisions: [] };
    throw e;
  }
  return parseReviewState(JSON.parse(text));
}

export interface ReviewApplication {
  links: EntityLink[];
  accepted: number;
  rejected: number;
  unmatched: ReviewDecision[];
}

/** Apply review decisions to links. The last decision for a link wins. Returns new link objects. */
export function applyReviewState(links: readonly EntityLink[], state: ReviewState): ReviewApplication {
  const decisions = new Map<string, ReviewDecision>();
  for (const d of state.decisions) decisions.set(linkKey(d), d);
  const used = new Set<string>();
  const out: EntityLink[] = [];
  let accepted = 0;
  let rejected = 0;
  for (const l of links) {
    const key = linkKey(l);
    const d = decisions.get(key);
    if (!d) {
      out.push({ ...l, evidence: [...l.evidence] });
      continue;
    }
    used.add(key);
    if (d.decision === 'reject') {
      rejected++;
      continue;
    }
    accepted++;
    out.push({ ...l, evidence: [...l.evidence], reviewed: true });
  }
  const unmatched = [...decisions.entries()].filter(([k]) => !used.has(k)).map(([, d]) => d);
  return { links: out, accepted, rejected, unmatched };
}

/** Probabilistic links under REVIEW_CONFIDENCE_THRESHOLD (0.8): excluded from scoring until a reviewer accepts them. */
export function needsReview(l: EntityLink): boolean {
  return l.method === 'probabilistic' && l.confidence < REVIEW_CONFIDENCE_THRESHOLD && !l.reviewed;
}

/** Whether scoring may use this link. */
export function isLinkUsable(l: EntityLink): boolean {
  return l.confidence > 0 && !needsReview(l);
}

/** Links waiting for a reviewer, highest confidence first. */
export function reviewQueue(links: readonly EntityLink[]): EntityLink[] {
  return links.filter(needsReview).sort((a, b) => b.confidence - a.confidence || (linkKey(a) < linkKey(b) ? -1 : 1));
}
