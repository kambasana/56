/**
 * Date support for the verification gate. A lifecycle or incident fact's `date` is kept only when
 * the re-fetched source states a date that agrees with it at the proposed precision:
 *
 *  - near the quote: dates in the normalised page text within NEAR_CHARS characters of the quote
 *    (the quote itself included); a day and month without a year ("on November 26th") takes the year
 *    of the page's publication date, else of the nearest dated mention in the same window;
 *  - page metadata: `article:published_time` and similar <meta> tags, JSON-LD `datePublished`, the
 *    first <time datetime> (or one marked pubdate / itemprop="datePublished"), the first byline
 *    element (id or class "timestamp", "byline", "post-date", "published", …), and a /YYYY/MM/DD/
 *    date in the URL path (mailing-list archives).
 *
 * A date agrees when it is at least as precise as the proposed one and equal once cut to the
 * proposed precision ("2016-03" is supported by "March 23rd, 2016"; "2024-03-20" is not supported
 * by "March 2024"). A year elsewhere on the page is not enough. Deterministic; no model involved.
 */
import { findQuote, foldText } from './normalize.js';

export type DatePrecision = 'year' | 'month' | 'day';

export interface SourceDate {
  year: number;
  month?: number;
  day?: number;
  precision: DatePrecision;
  /** Where the date was found: 'near quote', 'meta article:published_time', 'url path', … */
  where: string;
  /** The text the date was read from. */
  text: string;
}

/** Characters on each side of the quote that count as "near" (about one paragraph). */
export const NEAR_CHARS = 400;

const RANK: Readonly<Record<DatePrecision, number>> = { year: 0, month: 1, day: 2 };

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY_RE = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR_RE = String.raw`((?:19|20)\d{2})`;

function valid(y: number, m?: number, d?: number): boolean {
  if (y < 1970 || y > 2100) return false;
  if (m === undefined) return true;
  if (m < 1 || m > 12) return false;
  if (d === undefined) return true;
  return d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function mk(y: number, m: number | undefined, d: number | undefined, where: string, text: string): SourceDate | null {
  if (!valid(y, m, d)) return null;
  const precision: DatePrecision = d !== undefined ? 'day' : m !== undefined ? 'month' : 'year';
  return { year: y, ...(m !== undefined ? { month: m } : {}), ...(d !== undefined ? { day: d } : {}), precision, where, text };
}

/** A fact's date ("YYYY", "YYYY-MM" or "YYYY-MM-DD"); null when it is not a real calendar date. */
export function parseFactDate(s: string): SourceDate | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  return mk(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined, 'fact', s);
}

/** A machine-readable date: ISO 8601 (date part as written) or epoch milliseconds/seconds. */
export function parseMachineDate(raw: string, where: string): SourceDate | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ]|$)/.exec(s);
  if (iso) return mk(Number(iso[1]), Number(iso[2]), iso[3] ? Number(iso[3]) : undefined, where, s);
  if (/^\d{4}$/.test(s)) return mk(Number(s), undefined, undefined, where, s);
  if (/^\d{10}(\d{3})?$/.test(s)) {
    const d = new Date(s.length === 13 ? Number(s) : Number(s) * 1000);
    return mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), where, s);
  }
  // Human-readable dates in a machine slot ("Fri, 29 Mar 2024 08:51:26 -0700").
  return textDates(foldText(s), where)[0]?.date ?? null;
}

interface TextDate {
  date: SourceDate;
  /** Day and month without a year: the year is filled in later. */
  yearless?: { month: number; day: number };
  index: number;
}

/** Dates written in (folded) text: ISO, "March 20, 2024", "29 Mar 2024", "Feb 11th 2020", "January 2021", "November 26th". */
export function textDates(text: string, where: string): TextDate[] {
  const out: TextDate[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const add = (re: RegExp, f: (m: RegExpExecArray) => Omit<TextDate, 'index'> | null) => {
    for (const m of text.matchAll(re)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      const r = f(m as RegExpExecArray);
      if (!r) continue;
      taken.push([a, b]);
      out.push({ ...r, index: a });
    }
  };
  const one = (y: number, mo: number | undefined, d: number | undefined, t: string) => {
    const date = mk(y, mo, d, where, t);
    return date ? { date } : null;
  };
  const b = String.raw`(?<![\p{L}\p{N}])`;
  const e = String.raw`(?![\p{L}\p{N}])`;
  // ISO 2024-03-29 (also inside timestamps) and 2024/03/29.
  add(new RegExp(`${b}${YEAR_RE}([-/])(\\d{2})\\2(\\d{2})(?!\\d)`, 'gu'), (m) => one(Number(m[1]), Number(m[3]), Number(m[4]), m[0]));
  // Month day, year: "march 20, 2024", "feb 11th 2020", "november 26th, 2018".
  add(new RegExp(`${b}${MONTH_RE}\\s+${DAY_RE},?\\s+${YEAR_RE}${e}`, 'gu'), (m) => one(Number(m[3]), MONTHS[m[1]!], Number(m[2]), m[0]));
  // Day month year: "29 mar 2024", "09 january 2022", "1st of may 2025".
  add(new RegExp(`${b}${DAY_RE}\\s+(?:of\\s+)?${MONTH_RE},?\\s+${YEAR_RE}${e}`, 'gu'), (m) => one(Number(m[3]), MONTHS[m[2]!], Number(m[1]), m[0]));
  // Month year: "january 2021", "november of 2024".
  add(new RegExp(`${b}${MONTH_RE},?\\s+(?:of\\s+)?${YEAR_RE}${e}`, 'gu'), (m) => one(Number(m[2]), MONTHS[m[1]!], undefined, m[0]));
  // ISO month 2022-01 (not a range like 2019-2020).
  add(new RegExp(`${b}${YEAR_RE}-(\\d{2})(?![\\d-])`, 'gu'), (m) => one(Number(m[1]), Number(m[2]), undefined, m[0]));
  // Day and month without a year: "november 26th", "26 november".
  const yearless = (mo: number | undefined, d: number, t: string): Omit<TextDate, 'index'> | null => {
    if (mo === undefined || !valid(2000, mo, d)) return null;
    return { date: { year: 0, month: mo, day: d, precision: 'day', where, text: t }, yearless: { month: mo, day: d } };
  };
  add(new RegExp(`${b}${MONTH_RE}\\s+${DAY_RE}(?![\\p{L}\\p{N}:.,]\\d|[\\p{N}])`, 'gu'), (m) => {
    // "may 2" is too often the verb: an ordinal suffix is required for "may".
    if (m[1] === 'may' && !/(st|nd|rd|th)$/.test(m[0])) return null;
    return yearless(MONTHS[m[1]!], Number(m[2]), m[0]);
  });
  add(new RegExp(`${b}${DAY_RE}\\s+(?:of\\s+)?${MONTH_RE}${e}`, 'gu'), (m) => (m[2] === 'may' ? null : yearless(MONTHS[m[2]!], Number(m[1]), m[0])));
  // A bare year.
  add(new RegExp(`${b}${YEAR_RE}${e}`, 'gu'), (m) => one(Number(m[1]), undefined, undefined, m[0]));
  return out.sort((x, y) => x.index - y.index);
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** <meta> names/properties that state when a page was published. */
const PUBLISHED_META = /^(article:published_time|og:published_time|og:article:published_time|datepublished|date|dc\.date|dc\.date\.issued|dcterms\.issued|dcterms\.created|pubdate|publish[-_]?date|publication[-_]?date|parsely-pub-date|sailthru\.date|citation_publication_date|citation_date)$/i;
const BYLINE = /(^|[\s_-])(timestamp|byline|post-?date|posted-?on|published|publish-?date|entry-date|article-?date|pubdate|date)($|[\s_-])/i;

/** One metadata element: the date it states and the element itself (kept verbatim in fixtures). */
export interface DateMetadata {
  date: SourceDate;
  html: string;
}

/** Publication dates from an HTML page's metadata (meta tags, JSON-LD, <time>, byline). */
export function htmlDateMetadata(html: string): DateMetadata[] {
  const out: DateMetadata[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(m[0], 'property') ?? attr(m[0], 'name') ?? attr(m[0], 'itemprop');
    const content = attr(m[0], 'content');
    if (!key || !content || !PUBLISHED_META.test(key)) continue;
    const d = parseMachineDate(content, `meta ${key.toLowerCase()}`);
    if (d) out.push({ date: d, html: `<meta property="${key}" content="${content.replace(/"/g, '&quot;')}">` });
  }
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const d of m[1]!.matchAll(/"datePublished"\s*:\s*"([^"]{4,40})"/g)) {
      const sd = parseMachineDate(d[1]!, 'JSON-LD datePublished');
      if (sd) out.push({ date: sd, html: `<script type="application/ld+json">{"datePublished":"${d[1]}"}</script>` });
    }
  }
  let firstTime = true;
  for (const m of html.matchAll(/<time\b[^>]*>([\s\S]{0,200}?)<\/time\s*>/gi)) {
    const open = /^<time\b[^>]*>/i.exec(m[0])![0];
    const marked = /\spubdate\b/i.test(open) || /itemprop\s*=\s*["']?datePublished/i.test(open);
    if (!firstTime && !marked) continue;
    firstTime = false;
    const dt = attr(open, 'datetime');
    const inner = m[1]!.replace(/<[^>]*>/g, '').trim();
    const d = (dt ? parseMachineDate(dt, 'time datetime') : null) ?? parseMachineDate(inner, 'time element');
    if (d) out.push({ date: d, html: `<time datetime="${(dt ?? '').replace(/"/g, '&quot;')}">${inner}</time>` });
  }
  // First byline element: <span id="timestamp"> March 23rd, 2016 6:21pm </span>.
  for (const m of html.matchAll(/<(span|div|p|small|li|a)\b([^>]*)>([^<]{4,120})(?=<)/gi)) {
    const id = attr(`<x ${m[2]}>`, 'id') ?? '';
    const cls = attr(`<x ${m[2]}>`, 'class') ?? '';
    if (!BYLINE.test(id) && !BYLINE.test(cls)) continue;
    const d = textDates(foldText(m[3]!), `byline ${id ? `#${id}` : `.${cls.split(/\s+/)[0]}`}`).find((x) => !x.yearless && x.date.precision !== 'year');
    if (!d) continue;
    out.push({ date: d.date, html: `<${m[1]}${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''}>${m[3]!.trim()}</${m[1]}>` });
    break;
  }
  const seen = new Set<string>();
  return out.filter((m) => !seen.has(m.html) && seen.add(m.html));
}

/** /2024/03/29/ in a URL path (mailing-list archives, dated blog URLs). */
export function urlPathDate(url: URL): SourceDate | null {
  const m = /\/((?:19|20)\d{2})\/(\d{2})(?:\/(\d{2}))?(?:\/|$)/.exec(url.pathname);
  return m ? mk(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, 'url path', m[0]) : null;
}

/** Where the quote is in the normalised page: [start, end), or null. */
export function quoteSpan(page: string, quote: string): [number, number] | null {
  const q = foldText(quote);
  const at = page.indexOf(q);
  if (at >= 0) return [at, at + q.length];
  if (findQuote(page, quote) !== 'compact') return null;
  // Compact match: map positions of the whitespace-free page back to the page.
  const map: number[] = [];
  let compact = '';
  for (let i = 0; i < page.length; i++) {
    if (/\s/.test(page[i]!)) continue;
    map.push(i);
    compact += page[i];
  }
  const cq = q.replace(/\s+/g, '');
  const c = compact.indexOf(cq);
  return c < 0 ? null : [map[c]!, map[c + cq.length - 1]! + 1];
}

export interface DateEvidence {
  /** Dates near the quote (within NEAR_CHARS), the quote's own included. */
  near: SourceDate[];
  /** Page-level publication dates (metadata, byline, URL path). */
  page: SourceDate[];
}

/** Every date the source offers for a fact quoted from it. */
export function dateEvidence(input: { body: string; page: string; quote: string; sourceUrl: URL; isHtml: boolean }): DateEvidence {
  const page: SourceDate[] = [];
  if (input.isHtml) for (const m of htmlDateMetadata(input.body)) page.push(m.date);
  const u = urlPathDate(input.sourceUrl);
  if (u) page.push(u);
  const near: SourceDate[] = [];
  const span = quoteSpan(input.page, input.quote);
  if (span) {
    const from = Math.max(0, span[0] - NEAR_CHARS);
    const to = Math.min(input.page.length, span[1] + NEAR_CHARS);
    const found = textDates(input.page.slice(from, to), 'near quote');
    const pub = page.find((d) => d.precision === 'day' && d.where !== 'url path') ?? page.find((d) => d.precision !== 'year');
    for (const f of found) {
      if (!f.yearless) {
        near.push(f.date);
        continue;
      }
      // Year for "November 26th": the publication year (the year before when that would put the
      // date after publication), else the nearest dated mention in the window.
      let year: number | undefined;
      if (pub) {
        year = pub.year;
        if (pub.month !== undefined && (f.yearless.month > pub.month || (f.yearless.month === pub.month && pub.day !== undefined && f.yearless.day > pub.day))) year -= 1;
      } else {
        let best = Infinity;
        for (const g of found) {
          if (g.yearless) continue;
          const dist = Math.abs(g.index - f.index);
          if (dist < best) {
            best = dist;
            year = g.date.year;
          }
        }
      }
      if (year === undefined) continue;
      const d = mk(year, f.yearless.month, f.yearless.day, 'near quote (year from ' + (pub ? 'publication date' : 'nearest dated mention') + ')', f.date.text);
      if (d) near.push(d);
    }
  }
  return { near, page };
}

/** True when `d` supports the proposed date: at least as precise and equal at the proposed precision. */
export function agrees(proposed: SourceDate, d: SourceDate): boolean {
  if (RANK[d.precision] < RANK[proposed.precision]) return false;
  if (d.year !== proposed.year) return false;
  if (proposed.precision === 'year') return true;
  if (d.month !== proposed.month) return false;
  return proposed.precision === 'month' || d.day === proposed.day;
}

const show = (d: SourceDate) => `${d.year}${d.month ? `-${String(d.month).padStart(2, '0')}` : ''}${d.day ? `-${String(d.day).padStart(2, '0')}` : ''}`;

/**
 * Problem with a proposed fact date, or null when the source supports it. The problem lists what the
 * source does state so a reviewer sees the disagreement.
 */
export function dateProblem(date: string, input: { body: string; page: string; quote: string; sourceUrl: URL; isHtml: boolean }): string | null {
  const proposed = parseFactDate(date);
  if (!proposed) return `date ${date} is not a calendar date`;
  const ev = dateEvidence(input);
  if ([...ev.near, ...ev.page].some((d) => agrees(proposed, d))) return null;
  const seen = [...new Set([...ev.page, ...ev.near].filter((d) => d.precision !== 'year' || proposed.precision === 'year').map(show))].slice(0, 6);
  return `date ${date} is not supported by the source (${seen.length ? `dates near the quote or in the page metadata: ${seen.join(', ')}` : 'no date near the quote or in the page metadata'})`;
}
