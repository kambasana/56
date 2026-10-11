/**
 * Record the verification-gate page fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/agentic/record.ts
 *
 * Fetches each page in PAGES (real public pages: Open Collective, Moment.js docs, Redis and Elastic
 * licensing posts, Open Source Collective, SEC EDGAR, OpenJS Foundation, Openwall, npm blog),
 * trims it, and writes a fixture envelope under test/fixtures/agentic/pages/ that the offline
 * HttpClient replays by URL. Trimming keeps the page's own HTML for the listed segments (so the
 * gate's HTML normalisation is exercised on real markup) and removes scripts, styles, SVG, comments
 * and attributes (only `href` is kept). Segments that would carry individual people's data (Open
 * Collective "Individuals" backers, mail headers) are cut out on purpose: the plan stores
 * organisation funders only.
 *
 * A page that cannot be fetched is recorded as {status, response: ""} with `_blocked` set, so the
 * gate test can show what happens and the plan can say so.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEnvProxy } from '../../src/core/proxy.js';
import { readBodyLimited } from '../../src/core/http.js';
import { PAGES } from './pages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'fixtures', 'agentic', 'pages');

/** Remove active content and attributes; keep the visible HTML structure. */
export function cleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(link|meta|img|source|input)\b[^>]*>/gi, '')
    .replace(/<([a-zA-Z][a-zA-Z0-9]*)\s([^>]*)>/g, (_m, tag: string, attrs: string) => {
      const href = /\bhref="(https?:[^"]*)"/.exec(attrs)?.[1];
      return href && tag.toLowerCase() === 'a' ? `<a href="${href}">` : `<${tag}>`;
    })
    .replace(/[ \t\r\n]+/g, ' ');
}

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  await installEnvProxy();
  mkdirSync(OUT, { recursive: true });
  const recordedAt = new Date().toISOString();
  for (const page of PAGES) {
    let status = 0;
    let body = '';
    try {
      const res = await fetch(page.url, {
        headers: { 'user-agent': 'blastradius/0.1 (+supply-chain auditor; fixture recorder)', accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(40_000),
      });
      status = res.status;
      body = await readBodyLimited(res, page.url, 5 * 1024 * 1024);
    } catch (e) {
      body = '';
      status = 0;
      console.error(`${page.name}: ${(e as Error).message}`);
    }
    const file = join(OUT, `${page.name}.json`);
    if (status !== 200) {
      writeFileSync(file, `${JSON.stringify({ request: { url: page.url }, status: status || 502, response: '', _blocked: `HTTP ${status || 'network error'} at ${recordedAt}`, _recordedAt: recordedAt }, null, 2)}\n`);
      console.log(`${page.name}: blocked (${status})`);
      continue;
    }
    const clean = cleanHtml(body);
    const parts: string[] = [];
    for (const [start, end] of page.segments) {
      const i = clean.indexOf(start);
      if (i < 0) throw new Error(`${page.name}: start marker not found: ${start}`);
      const j = clean.indexOf(end, i);
      if (j < 0) throw new Error(`${page.name}: end marker not found after start: ${end}`);
      parts.push(clean.slice(i, j + end.length));
    }
    const html = `<!doctype html><html><head><title>${titleOf(body)}</title></head><body>\n${parts.join('\n<hr>\n')}\n</body></html>`;
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          request: { url: page.url },
          status: 200,
          response: html,
          _note: `Trimmed by test/agentic/record.ts: ${page.segments.length} segment(s) of the live page; scripts, styles, attributes and personal data removed.`,
          _recordedAt: recordedAt,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`${page.name}: ${body.length} → ${html.length} bytes`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
