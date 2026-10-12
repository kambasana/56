/**
 * Date support (src/agentic/dates.ts) and the funding backer-kind evidence (tasks.ts): parsing,
 * where a date may come from, precision, and the "a year elsewhere on the page is not enough" rule.
 */
import { describe, expect, it } from 'vitest';
import { agrees, backerKindEvidence, dateProblem, htmlDateMetadata, NEAR_CHARS, pageText, parseFactDate, parseMachineDate, textDates, urlPathDate } from '../../src/agentic/index.js';

const ymd = (s: string) => parseFactDate(s)!;
const html = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
function problem(date: string, doc: string, quote: string, url = 'https://example.org/blog/post'): string | null {
  return dateProblem(date, { body: doc, page: pageText(doc), quote, sourceUrl: new URL(url), isHtml: /<html/.test(doc) });
}

describe('parsing', () => {
  it('fact dates at year, month and day precision; impossible dates are refused', () => {
    expect(parseFactDate('2024')).toMatchObject({ year: 2024, precision: 'year' });
    expect(parseFactDate('2024-03')).toMatchObject({ year: 2024, month: 3, precision: 'month' });
    expect(parseFactDate('2024-02-29')).toMatchObject({ day: 29, precision: 'day' });
    for (const bad of ['2023-02-29', '2024-13', '2024-00-10', '24-03-01', 'March 2024']) expect(parseFactDate(bad), bad).toBeNull();
  });

  it('dates written in text', () => {
    const got = (t: string) => textDates(t, 'x').map((d) => (d.yearless ? `--${d.yearless.month}-${d.yearless.day}` : `${d.date.year}-${d.date.month ?? ''}-${d.date.day ?? ''}`));
    expect(got('march 20, 2024 16 minute read')).toEqual(['2024-3-20']);
    expect(got('as of feb 11th 2020, request is deprecated')).toEqual(['2020-2-11']);
    expect(got('date: fri, 29 mar 2024 08:51:26 -0700')).toEqual(['2024-3-29']);
    expect(got('between 07 and 09 january 2022')).toEqual(['2022-1-9']);
    expect(got('in november of 2024 he rejoined')).toEqual(['2024-11-']);
    expect(got('published 2022-01-10t17:29:53z')).toEqual(['2022-1-10']);
    expect(got('on the morning of november 26th, npm')).toEqual(['--11-26']);
    expect(got('in 2019-2020 and version 5.6.0, you may 2x it')).toEqual(['2019--', '2020--']);
  });

  it('machine dates: ISO (date part as written) and epoch milliseconds', () => {
    expect(parseMachineDate('2025-05-01T06:00:00.000Z', 'm')).toMatchObject({ year: 2025, month: 5, day: 1 });
    expect(parseMachineDate('1610643600000', 'm')).toMatchObject({ year: 2021, month: 1, day: 14 });
  });

  it('page metadata: meta tags, JSON-LD datePublished, the first <time>, the first byline; not modified dates', () => {
    const doc = html(
      '<meta property="article:modified_time" content="2025-04-24T18:57:47Z"><meta property="article:published_time" content="2021-01-14T17:00:00Z"><script type="application/ld+json">{"dateModified":"2025-04-24","datePublished":"2021-01-14T17:00:00Z"}</script>',
      '<span id="timestamp"> March 23rd, 2016 6:21pm </span><time datetime="1724961600000">August 29, 2024</time><time datetime="2019-01-01">related post</time>',
    );
    expect(htmlDateMetadata(doc).map((m) => `${m.date.where}=${m.date.year}-${m.date.month}-${m.date.day}`)).toEqual([
      'meta article:published_time=2021-1-14',
      'JSON-LD datePublished=2021-1-14',
      'time datetime=2024-8-29',
      'byline #timestamp=2016-3-23',
    ]);
    expect(urlPathDate(new URL('https://www.openwall.com/lists/oss-security/2024/03/29/4'))).toMatchObject({ year: 2024, month: 3, day: 29 });
    expect(urlPathDate(new URL('https://example.org/v/2024-03-29'))).toBeNull();
  });
});

describe('precision', () => {
  it('a source date supports a proposal when it is at least as precise and equal at the proposed precision', () => {
    expect(agrees(ymd('2016-03'), ymd('2016-03-23'))).toBe(true);
    expect(agrees(ymd('2016'), ymd('2016-03-23'))).toBe(true);
    expect(agrees(ymd('2016-03-23'), ymd('2016-03-23'))).toBe(true);
    expect(agrees(ymd('2016-03-23'), ymd('2016-03'))).toBe(false);
    expect(agrees(ymd('2016-03'), ymd('2016'))).toBe(false);
    expect(agrees(ymd('2016-03-22'), ymd('2016-03-23'))).toBe(false);
    expect(agrees(ymd('2016-04'), ymd('2016-03-23'))).toBe(false);
  });
});

describe('the date gate', () => {
  const quote = 'Adding the OSI-approved AGPL as an additional licensing option';
  const filler = ' Lorem ipsum dolor sit amet.'.repeat(Math.ceil((NEAR_CHARS + 50) / 27));

  it('accepts a date stated near the quote or in the metadata', () => {
    expect(problem('2025-05-01', html('', `<p>On May 1, 2025: ${quote}.</p>`), quote)).toBeNull();
    expect(problem('2025-05', html('', `<p>${quote} (May 2025).</p>`), quote)).toBeNull();
    expect(problem('2025-05-01', html('<script type="application/ld+json">{"datePublished":"2025-05-01T06:00:00Z"}</script>', `<p>${filler}</p><p>${quote}.</p>`), quote)).toBeNull();
    expect(problem('2024-03-29', 'The upstream xz repository and the xz tarballs have been backdoored.', 'the xz tarballs have been backdoored', 'https://www.openwall.com/lists/oss-security/2024/03/29/4')).toBeNull();
  });

  it('a day and month without a year take the publication year', () => {
    const doc = html('<span id="timestamp">November 27th, 2018 2:42pm</span>', `<p>On the morning of November 26th, npm's security team was notified.</p><p>${quote}.</p>`);
    expect(problem('2018-11-26', doc, quote)).toBeNull();
    expect(problem('2017-11-26', doc, quote)).not.toBeNull();
  });

  it('rejects the Redis AGPL probe: a year-off date with a real quote', () => {
    const doc = html('<script type="application/ld+json">{"datePublished":"2025-05-01T06:00:00Z"}</script>', `<p>In November of 2024 Salvatore rejoined.</p><p>${quote}, starting with Redis 8.</p>`);
    expect(problem('2024-05-01', doc, quote)).toBe('date 2024-05-01 is not supported by the source (dates near the quote or in the page metadata: 2025-05-01, 2024-11)');
    expect(problem('2025-05-01', doc, quote)).toBeNull();
  });

  it('a year elsewhere on the page is not enough', () => {
    const doc = html('', `<p>Founded in 2024.</p><p>${filler}</p><p>${quote}.</p>`);
    expect(problem('2024', doc, quote)).toMatch(/^date 2024 is not supported by the source \(no date near the quote/);
    expect(problem('2024', html('', `<p>${quote} in 2024.</p>`), quote)).toBeNull();
  });

  it('a date less precise than the proposal does not support it; impossible dates are refused', () => {
    expect(problem('2025-05-01', html('', `<p>${quote} (May 2025).</p>`), quote)).toMatch(/not supported/);
    expect(problem('2025-02-30', html('', `<p>${quote}.</p>`), quote)).toBe('date 2025-02-30 is not a calendar date');
  });
});

describe('funding backer kind evidence', () => {
  const oc = new URL('https://opencollective.com/babel');
  const ocPage = pageText('<h2>Top financial contributors</h2><p>Organizations</p><div>1 Airbnb $217,858 USD since Apr 2018</div><div>2 Sovereign Tech Agency $207,511.35 USD since May 2025</div><div>3 GitHub Sponsors $157,561.48 USD since Dec 2020</div>');
  const other = new URL('https://example.org/sponsors');
  const kind = (org: string, quote: string, page = '', url = other) => backerKindEvidence(org, quote, page, url);

  it('known lists and names are strong evidence', () => {
    expect(kind('Sovereign Tech Agency', 'Sovereign Tech Agency $207,511.35 USD since May 2025', ocPage, oc)).toMatchObject({ kind: 'public_agency', strong: true });
    expect(kind('National Science Foundation', 'Supported by the National Science Foundation')).toMatchObject({ kind: 'public_agency', strong: true });
    expect(kind('Open Source Collective', 'Fiscal Host: Open Source Collective')).toMatchObject({ kind: 'fiscal_host', strong: true });
    expect(kind('Acme Collective', 'Fiscal Host: Acme Collective')).toMatchObject({ kind: 'fiscal_host', why: 'the quote names it as fiscal host' });
    expect(kind('OpenJS Foundation', 'Supported by the OpenJS Foundation')).toMatchObject({ kind: 'foundation', strong: true });
    expect(kind('Federal Ministry of the Interior', 'Funded by the Federal Ministry of the Interior')).toMatchObject({ kind: 'public_agency', strong: true });
    expect(kind('Acme Inc.', 'Sponsored by Acme Inc.')).toMatchObject({ kind: 'corporate_backer', strong: true });
  });

  it('an Open Collective organisation account is weak evidence of a company; platforms and unknowns give none', () => {
    expect(kind('Airbnb', 'Airbnb $217,858 USD since Apr 2018', ocPage, oc)).toMatchObject({ kind: 'corporate_backer', strong: false });
    expect(kind('GitHub Sponsors', 'GitHub Sponsors $157,561.48 USD since Dec 2020', ocPage, oc)).toBeNull();
    expect(kind('Airbnb', 'Airbnb sponsors us', '', other)).toBeNull();
    expect(kind('Handshake', 'Handshake $100,000 USD since Aug 2018', ocPage, oc)).toBeNull();
  });

  it('a name listed under Individuals on Open Collective is an individual (never stored as a backer)', () => {
    const withPeople = pageText('<h2>Top financial contributors</h2><p>Organizations</p><div>1 Airbnb $217,858 USD since Apr 2018</div><p>Individuals</p><div>1 Jane Example $5,000 USD since Jan 2019</div>');
    expect(kind('Jane Example', 'Jane Example $5,000 USD since Jan 2019', withPeople, oc)).toMatchObject({ kind: 'individual', strong: true });
  });
});
