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
 * Tier 0.6 (an independent re-check of the README rule):
 *   - also "<Name> is deprecated / no longer maintained" where <Name> is the package or the README's
 *     title (TSLint), "This PyPI package is no longer actively maintained" (a qualifier before the
 *     subject: click-plugins), and an "End-of-support" / "End of life" heading with a date
 *     ("🚫 End-of-support as of September 8, 2025": aws-sdk v2);
 *   - never a version- or branch-scoped note ("Version 1.x is in maintenance mode", "The v3 branch is
 *     in maintenance mode"): those say an older line ended, not the project;
 *   - a badge counts only when its label is a status label (status, project status, maintenance,
 *     lifecycle, …) or it is a repostatus.org badge: "IE11 | deprecated" documents a feature.
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
/** Up to two qualifiers between "this" and the subject ("this PyPI package", "this Python library"). */
const QUALIFIED = String.raw`(?:[\w.-]+ ){0,2}${SUBJECT}`;

/** Project-level sentences, tried in order on the opening section (first match wins). */
export const DECLARED_PATTERNS: readonly Pattern[] = [
  { status: 'deprecated', re: /\b(?:is|has been) (?:now )?fully deprecated\b/i },
  { status: 'deprecated', re: new RegExp(String.raw`\bthis ${QUALIFIED} (?:is|has been) (?:now |officially )?(?:deprecated|archived)\b`, 'i') },
  { status: 'unmaintained', re: new RegExp(String.raw`\bthis ${QUALIFIED} (?:is|has been) (?:now )?(?:no longer (?:actively )?maintained|unmaintained|abandoned|discontinued)\b`, 'i') },
  { status: 'deprecated', re: new RegExp(String.raw`\bthis ${QUALIFIED} has reached (?:its )?end[- ]of[- ](?:life|support)\b`, 'i') },
  { status: 'unmaintained', re: /\b(?:active )?development(?: of [\w.-]+)? (?:has been|is) (?:now )?discontinued\b/i },
  { status: 'maintenance_mode', re: /\bis a legacy project\b|\b(?:now )?in maintenance mode\b|\bmaintenance mode only\b/i },
];

/** A heading that is nothing but a status. */
const STATUS_HEADING: readonly { status: Status; re: RegExp }[] = [
  { status: 'deprecated', re: /^(?:deprecated|deprecation notice|archived|end of life|end of support|eol)(?: (?:as of|since|on|from) .*)?$/i },
  { status: 'unmaintained', re: /^(?:discontinued|unmaintained|no longer maintained|not maintained|abandoned)$/i },
  { status: 'maintenance_mode', re: /^(?:maintenance mode)$/i },
];

/**
 * Version- or branch-scoped wording before the matched words in the same sentence: an older line
 * ended, not the project ("Version 1.x is now in maintenance mode", "The v3 branch is …").
 */
const SCOPED = /\b(?:versions?|v?\d+(?:\.(?:\d+|x))+|v\d+|branch(?:es)?|release lines?|major (?:version|release)s?|(?:the )?(?:old|older|previous|legacy|1st|2nd|first|second) (?:major|generation|line))\b/i;

/** Badge labels that state a project's status (the left side of a shields badge). */
const STATUS_LABEL = /^(?:status|project status|project|repo status|repository status|maintenance|maintained|lifecycle|project state|state|development|support)$/i;

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
  // Tier 0.6: a sentence hard-wrapped over lines (reST and plain-text descriptions on PyPI) runs on
  // to the next line while the line does not end a sentence and the next one continues the paragraph.
  let endNl = text.indexOf('\n', index + length);
  while (endNl >= 0 && !/[.!?:]\s*$/.test(text.slice(Math.max(0, endNl - 3), endNl)) && /^[ \t]*[\p{L}\p{N}`(]/u.test(text.slice(endNl + 1, endNl + 3)) && !text.slice(index, endNl).includes('. ')) {
    const next = text.indexOf('\n', endNl + 1);
    endNl = next;
  }
  const endDot = text.indexOf('. ', index + length);
  const ends = [endNl, endDot >= 0 ? endDot + 1 : -1].filter((n) => n >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).replace(/^[\s#>.-]+/, '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 200);
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

/** A name compared without case, scope, punctuation or spacing ("@palantir/tslint" = "TSLint"). */
function nameWords(n: string): string {
  return n.replace(/^@[^/]+\//, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function safeDecode(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

/** First declared status in a README, or undefined. Pure; the README itself is never stored. */
export function declaredStatusOf(readme: unknown, name?: string): Omit<DeclaredStatusValue, 'via'> | undefined {
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
  // 2. A project-level sentence in the opening section; never one scoped to a version or branch.
  const open = plain(opening);
  const scoped = (index: number) => {
    const start = Math.max(open.lastIndexOf('\n', index), open.lastIndexOf('. ', index), open.lastIndexOf('; ', index), 0);
    return SCOPED.test(open.slice(start, index));
  };
  for (const p of DECLARED_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    for (const m of open.matchAll(re)) if (!scoped(m.index)) return { status: p.status, phrase: sentenceAround(open, m.index, m[0].length) };
  }
  // "<Name> is deprecated" with the package's name or the README's title (TSLint).
  const names = [name, hs[0] ? headingWords(hs[0].text) : undefined].filter((n): n is string => !!n).map(nameWords).filter((n) => n.length >= 2);
  if (names.length) {
    const re = /(^|[\s>:!(])([\w@./-]+(?: [\w.-]+)?) (?:is|has been) (?:now |officially |fully )?(deprecated|archived|no longer (?:actively )?maintained|unmaintained|abandoned|discontinued)\b/gim;
    for (const m of open.matchAll(re)) {
      if (!names.includes(nameWords(m[2]!))) continue;
      const at = m.index + m[1]!.length;
      return { status: /deprecated|archived/i.test(m[3]!) ? 'deprecated' : 'unmaintained', phrase: sentenceAround(open, at, m[0].length - m[1]!.length) };
    }
  }
  // 3. A status badge in the opening section.
  for (const b of badges(opening, text)) {
    const url = safeDecode(b.url);
    let s: (typeof BADGE)[number] | undefined;
    if (/repostatus\.org/i.test(url)) s = BADGE.find((p) => p.re.test(url) || p.re.test(b.alt));
    else {
      // A shields static badge "/badge/<label>-<message>-<color>": the message counts only under a status label.
      const sh = /\/badge\/([^/?#]*)/i.exec(url)?.[1];
      const parts = sh !== undefined ? shieldsParts(sh) : undefined;
      if (parts) {
        if (!parts.label || STATUS_LABEL.test(parts.label)) s = BADGE.find((p) => p.re.test(parts.message));
      } else if (!/shields\.io|badgen\.net/i.test(url)) s = BADGE.find((p) => p.re.test(b.alt));
      // The alt text alone ("![deprecated](…)") counts when it is nothing but a status.
      s ??= /^(?:deprecated|unmaintained|abandoned|archived|no longer maintained|maintenance mode)$/i.test(b.alt.trim()) ? BADGE.find((p) => p.re.test(b.alt)) : undefined;
    }
    if (s) return { status: s.status, phrase: `Badge: ${(b.alt || b.url).slice(0, 180)}` };
  }
  return undefined;
}

/** Label and message of a shields.io static badge path segment ("IE11-deprecated-red", "status--unmaintained-red"). */
function shieldsParts(seg: string): { label: string; message: string } | undefined {
  // Shields escapes a literal dash as "--" and an underscore as "__"; "_" is a space.
  const raw = safeDecode(seg).replace(/--/g, '\u0000').replace(/__/g, '\u0001');
  const parts = raw.split('-').map((x) => x.replace(/\u0000/g, '-').replace(/\u0001/g, '_').replace(/_/g, ' ').trim());
  if (parts.length === 3) return { label: parts[0]!, message: parts[1]! };
  if (parts.length === 2) return { label: '', message: parts[0]! };
  return undefined;
}
