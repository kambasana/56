/**
 * Declared maintenance status in a package's README (plan S3: "README/package.json declares
 * deprecation (text match on a short fixed list → low confidence, needs a second fact)").
 *
 * The list is short and fixed on purpose; a match only ever counts together with a second fact
 * (see signals.ts), and the matched sentence is shown verbatim so a reader can judge it.
 */
import type { DeclaredStatusValue } from '../core/types.js';

const MAX_README = 50_000;

interface Pattern {
  status: DeclaredStatusValue['status'];
  re: RegExp;
}

const SUBJECT = String.raw`(?:project|package|library|module|repository|repo)`;

/** Fixed phrase list, tried in order (first match wins). */
export const DECLARED_PATTERNS: readonly Pattern[] = [
  { status: 'deprecated', re: /^#{1,3}\s*deprecated\b/im },
  { status: 'deprecated', re: /\b(?:is|has been) fully deprecated\b/i },
  { status: 'deprecated', re: new RegExp(String.raw`\bthis ${SUBJECT} (?:is|has been) (?:now )?(?:deprecated|archived)\b`, 'i') },
  { status: 'unmaintained', re: new RegExp(String.raw`\bthis ${SUBJECT} (?:is|has been) (?:now )?(?:no longer (?:actively )?maintained|unmaintained|abandoned)\b`, 'i') },
  { status: 'maintenance_mode', re: /\bis a legacy project\b|\b(?:now )?in maintenance mode\b|\bmaintenance mode only\b/i },
];

/** Markdown emphasis and code marks removed, whitespace collapsed (so "**maintenance mode**" matches). */
function plain(text: string): string {
  return text.slice(0, MAX_README).replace(/[*_`]+/g, '').replace(/[ \t]+/g, ' ');
}

/** The sentence (or line) around a match, at most 200 characters. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('\n', index), text.lastIndexOf('. ', index) >= 0 ? text.lastIndexOf('. ', index) + 1 : -1, 0);
  const endNl = text.indexOf('\n', index + length);
  const endDot = text.indexOf('. ', index + length);
  const ends = [endNl, endDot >= 0 ? endDot + 1 : -1].filter((n) => n >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).replace(/^[\s#>.-]+/, '').trim().slice(0, 200);
}

/** First declared status in a README, or undefined. Pure; the README itself is never stored. */
export function declaredStatusOf(readme: unknown): Omit<DeclaredStatusValue, 'via'> | undefined {
  if (typeof readme !== 'string' || readme.length === 0) return undefined;
  const text = plain(readme);
  for (const p of DECLARED_PATTERNS) {
    const m = p.re.exec(text);
    if (m) return { status: p.status, phrase: sentenceAround(text, m.index, m[0].length) };
  }
  return undefined;
}
