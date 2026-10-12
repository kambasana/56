/**
 * Declared maintenance status in a package's README (plan S3: "README/package.json declares
 * deprecation (text match on a short fixed list → low confidence, needs a second fact)").
 *
 * Tier 0.5: only a project-level declaration counts, never a heading or word that documents a
 * feature. rc-util documents its `deprecated()` helper under "### deprecated", amplitude-js has a
 * "Deprecated - React Native" section, @xmpp/jid lists deprecated XEPs: none of them says the
 * project ended. A declaration counts when it is
 *   - a status heading (the whole heading is "Deprecated", "Discontinued", "Unmaintained", "No
 *     longer maintained", "Archived", "Abandoned" or "End of life") among the README's first two
 *     headings (buf-compare, request, node-domexception, crypto-js);
 *   - an explicit project-level sentence ("this project/package/library is deprecated / archived /
 *     no longer maintained / unmaintained / abandoned", "is fully deprecated", "is a legacy
 *     project", "in maintenance mode", "development has been discontinued") in the opening section:
 *     the text before the README's third heading, at most OPENING_MAX characters;
 *   - a status badge in the opening section (shields.io / repostatus.org images whose label or
 *     URL says deprecated, unmaintained, abandoned, archived, inactive, unsupported or maintenance
 *     mode).
 * The match only ever counts together with a second fact (see label.ts) and stays low confidence;
 * the matched sentence is shown verbatim so a reader can judge it.
 */
import type { DeclaredStatusValue } from '../core/types.js';

const MAX_README = 50_000;
/** The opening section ends at the third heading, and after this many characters at most. */
export const OPENING_MAX = 3_000;

type Status = DeclaredStatusValue['status'];

interface Pattern {
  status: Status;
  re: RegExp;
}

const SUBJECT = String.raw`(?:project|package|library|module|repository|repo|plugin|sdk|tool|crate|gem)`;

/** Project-level sentences, tried in order on the opening section (first match wins). */
export const DECLARED_PATTERNS: readonly Pattern[] = [
  { status: 'deprecated', re: /\b(?:is|has been) (?:now )?fully deprecated\b/i },
  { status: 'deprecated', re: new RegExp(String.raw`\bthis ${SUBJECT} (?:is|has been) (?:now |officially )?(?:deprecated|archived)\b`, 'i') },
  { status: 'unmaintained', re: new RegExp(String.raw`\bthis ${SUBJECT} (?:is|has been) (?:now )?(?:no longer (?:actively )?maintained|unmaintained|abandoned|discontinued)\b`, 'i') },
  { status: 'unmaintained', re: /\b(?:active )?development(?: of [\w.-]+)? (?:has been|is) (?:now )?discontinued\b/i },
  { status: 'maintenance_mode', re: /\bis a legacy project\b|\b(?:now )?in maintenance mode\b|\bmaintenance mode only\b/i },
];

/** A heading that is nothing but a status. */
const STATUS_HEADING: readonly { status: Status; re: RegExp }[] = [
  { status: 'deprecated', re: /^(?:deprecated|deprecation notice|archived|end of life|eol)$/i },
  { status: 'unmaintained', re: /^(?:discontinued|unmaintained|no longer maintained|not maintained|abandoned)$/i },
  { status: 'maintenance_mode', re: /^(?:maintenance mode)$/i },
];

/** Badge label or URL words (shields.io custom badges, repostatus.org). */
const BADGE: readonly { status: Status; re: RegExp }[] = [
  { status: 'deprecated', re: /\bdeprecated\b|\barchived\b|repostatus\.org\/badges\/latest\/(?:moved|unsupported)/i },
  { status: 'unmaintained', re: /\bunmaintained\b|\bno[ -]longer[ -]maintained\b|\babandoned\b|\binactive\b|repostatus\.org\/badges\/latest\/(?:abandoned|inactive)/i },
  { status: 'maintenance_mode', re: /\bmaintenance[ -_]mode\b/i },
];

/** Markdown emphasis and code marks removed, whitespace collapsed (so "**maintenance mode**" matches). */
function plain(text: string): string {
  return text.replace(/[*_`]+/g, '').replace(/[ \t]+/g, ' ');
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

interface Heading {
  line: number;
  text: string;
}

/** ATX headings ("# Title") and setext headings ("Title\n====="), outside fenced code. */
function headings(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s{0,3}(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (atx) out.push({ line: i, text: atx[1]! });
    else if (i > 0 && /^\s{0,3}(=+|-+)\s*$/.test(l) && lines[i - 1]!.trim() && !/^\s{0,3}#/.test(lines[i - 1]!)) out.push({ line: i - 1, text: lines[i - 1]!.trim() });
    const h = /^\s*<h[1-6][^>]*>(.*?)<\/h[1-6]>\s*$/i.exec(l);
    if (h) out.push({ line: i, text: h[1]!.replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}

/** Heading text without links, images, emoji and trailing punctuation. */
function headingWords(t: string): string {
  return plain(t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Image badges in a stretch of markdown / HTML: their alt text and URL (reference-style images resolved). */
function badges(section: string, whole: string): { alt: string; url: string }[] {
  const refs = new Map<string, string>();
  for (const m of whole.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) refs.set(m[1]!.toLowerCase(), m[2]!);
  const out: { alt: string; url: string }[] = [];
  for (const m of section.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) out.push({ alt: m[1]!, url: m[2]! });
  for (const m of section.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const url = refs.get((m[2] || m[1]!).toLowerCase());
    if (url) out.push({ alt: m[1]!, url });
  }
  for (const m of section.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] ?? '';
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '';
    out.push({ alt, url: src });
  }
  // Only status badges: shields-style or repostatus.org images.
  return out.filter((b) => /shields\.io|badgen\.net|repostatus\.org|badge/i.test(b.url));
}

/** The opening section: everything before the third heading, at most OPENING_MAX characters. */
export function openingSection(readme: string): string {
  const lines = readme.slice(0, MAX_README).split(/\r?\n/);
  const hs = headings(lines);
  const end = hs.length >= 3 ? hs[2]!.line : lines.length;
  return lines.slice(0, end).join('\n').slice(0, OPENING_MAX);
}

/** The first sentence of the section under a heading (for a status heading's phrase). */
function sectionLead(lines: readonly string[], from: number): string {
  for (let i = from + 1; i < Math.min(lines.length, from + 12); i++) {
    const t = plain(lines[i]!).trim();
    if (!t || /^(=+|-+)$/.test(t)) continue;
    if (/^\s{0,3}#/.test(lines[i]!)) break;
    const s = t.replace(/^[>\s]+/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    const dot = s.search(/\.(\s|$)/);
    return (dot >= 0 ? s.slice(0, dot + 1) : s).slice(0, 160);
  }
  return '';
}

function safeDecode(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

/** First declared status in a README, or undefined. Pure; the README itself is never stored. */
export function declaredStatusOf(readme: unknown): Omit<DeclaredStatusValue, 'via'> | undefined {
  if (typeof readme !== 'string' || readme.length === 0) return undefined;
  const text = readme.slice(0, MAX_README);
  const lines = text.split(/\r?\n/);
  const hs = headings(lines);
  // 1. A status heading among the first two headings.
  for (const h of hs.slice(0, 2)) {
    const words = headingWords(h.text);
    const s = STATUS_HEADING.find((p) => p.re.test(words));
    if (!s) continue;
    const lead = sectionLead(lines, h.line);
    return { status: s.status, phrase: `${words}${lead ? `: ${lead}` : ''}`.slice(0, 200) };
  }
  const opening = openingSection(text);
  // 2. A project-level sentence in the opening section.
  const open = plain(opening);
  for (const p of DECLARED_PATTERNS) {
    const m = p.re.exec(open);
    if (m) return { status: p.status, phrase: sentenceAround(open, m.index, m[0].length) };
  }
  // 3. A status badge in the opening section.
  for (const b of badges(opening, text)) {
    const s = BADGE.find((p) => p.re.test(b.alt) || p.re.test(safeDecode(b.url)));
    if (s) return { status: s.status, phrase: `Badge: ${(b.alt || b.url).slice(0, 180)}` };
  }
  return undefined;
}
