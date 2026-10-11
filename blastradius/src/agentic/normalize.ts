/**
 * Text normalisation for the verification gate: turn a fetched page (HTML, JSON or plain text)
 * into the text a reader sees, and compare a quote against it. Deterministic, no model involved.
 *
 * Both the page and the quote go through the same steps:
 *  - HTML: comments, <script>/<style>/<svg>/<noscript>/<template> removed; block-level tags become
 *    a space, inline tags (span, a, em, b, …) vanish, so "<b>foo</b>bar" reads "foobar" as in a
 *    browser; character references decoded;
 *  - Unicode NFKC; typographic quotes, dashes and non-breaking/zero-width spaces folded to ASCII;
 *  - whitespace collapsed; no space before , . ; : ! ? ) ] or after ( [;
 *  - case-folded.
 * The quote must then appear in the page as a contiguous substring. If it does not, a second,
 * stricter-to-fabricate comparison drops all whitespace (layouts that split words over tags)
 * but still needs every other character in order.
 */

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'body', 'html', 'head', 'title', 'option', 'button', 'label',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»', shy: '',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** True when the body looks like HTML (or XML) rather than plain text or JSON. */
export function looksLikeHtml(body: string): boolean {
  return /<(!doctype\b|\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>)/i.test(body.slice(0, 20_000));
}

/** Visible text of an HTML document (before folding). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|svg|noscript|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_m, tag: string) => (BLOCK_TAGS.has(tag.toLowerCase()) ? ' ' : ''))
      .replace(/<[^>]*>/g, ''),
  );
}

/** Fold typography, whitespace and case. Applied to pages and quotes alike. */
export function foldText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)\]])/g, '$1')
    .replace(/([([]) /g, '$1')
    .trim()
    .toLowerCase();
}

/** Normalised text of a fetched body (HTML or not). */
export function pageText(body: string): string {
  return foldText(looksLikeHtml(body) ? htmlToText(body) : decodeEntities(body));
}

export type QuoteMatch = 'exact' | 'compact' | null;

/**
 * Where the quote is on the page: 'exact' (normalised substring), 'compact' (equal once all
 * whitespace is removed), or null (not on the page).
 */
export function findQuote(page: string, quote: string): QuoteMatch {
  const q = foldText(quote);
  if (q.length === 0) return null;
  if (page.includes(q)) return 'exact';
  const compactQ = q.replace(/\s+/g, '');
  if (compactQ.length > 0 && page.replace(/\s+/g, '').includes(compactQ)) return 'compact';
  return null;
}

/** Number of significant characters in a quote (letters and digits). */
export function quoteWeight(quote: string): number {
  return (foldText(quote).match(/[\p{L}\p{N}]/gu) ?? []).length;
}
