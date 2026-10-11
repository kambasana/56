/**
 * Record the licence fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/licenses/record.ts          # validation subjects → test/fixtures/licenses/recorded/
 *   npx tsx test/licenses/record.ts --e2e    # the dev-seed / e2e fixture repo, as of FIXTURE_AS_OF
 *                                            # → test/fixtures/licenses/e2e-repo/
 *
 * Runs the real licences enricher on the subjects in subjects.ts (or the e2e repo's inventory)
 * against deps.dev and ClearlyDefined and writes every response as a fixture envelope under
 * test/fixtures/licenses/. Responses are trimmed to the fields the enricher reads (noted in each
 * envelope's _note); request URLs and bodies are kept exactly, so offline replay matches them.
 * GetPackage responses keep only plain releases: the enricher drops pre-releases and Go
 * pseudo-versions before building the batch, so the batch request is identical.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HttpClient, type Transport } from '../../src/core/http.js';
import { installEnvProxy } from '../../src/core/proxy.js';
import { parsePurl, type Component, type Inventory } from '../../src/core/types.js';
import { createLicenseEnricher } from '../../src/enrich/licenses/index.js';
import { releaseSegments } from '../../src/licenses/history.js';
import { LICENSE_SUBJECTS } from './subjects.js';
import { ingest } from '../../src/ingest/index.js';
import { E2E_REPO_DIR, FIXTURE_AS_OF } from '../../src/server/serve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = process.argv.includes('--e2e');
const OUT = join(HERE, '..', 'fixtures', 'licenses', E2E ? 'e2e-repo' : 'recorded');

installEnvProxy();

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
  status: number;
  response: unknown;
}
const recorded: Recorded[] = [];

const realFetch: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) });
  const body = await res.text();
  recorded.push({ url: req.url, method: req.method, ...(req.body !== undefined ? { body: JSON.parse(req.body) } : {}), status: res.status, response: body ? JSON.parse(body) : null });
  return { status: res.status, body };
};

function trimPackage(r: any): unknown {
  return { packageKey: r?.packageKey, versions: (r?.versions ?? []).filter((v: any) => releaseSegments(String(v?.versionKey?.version ?? '')) !== undefined).map((v: any) => ({ versionKey: v.versionKey, publishedAt: v.publishedAt })) };
}
function trimBatch(r: any): unknown {
  return {
    responses: (r?.responses ?? []).map((x: any) => ({
      request: x.request,
      ...(x.version ? { version: { publishedAt: x.version.publishedAt, licenseDetails: x.version.licenseDetails } } : {}),
    })),
    ...(r?.nextPageToken ? { nextPageToken: r.nextPageToken } : {}),
  };
}
function trimDefinitions(r: any): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r ?? {})) {
    const d = v as any;
    out[k] = { coordinates: d.coordinates, described: d.described ? { releaseDate: d.described.releaseDate } : undefined, licensed: d.licensed ? { declared: d.licensed.declared, score: d.licensed.score ? { total: d.licensed.score.total } : undefined } : undefined };
  }
  return out;
}

const components: Component[] = LICENSE_SUBJECTS.map((s) => {
  const p = parsePurl(s.purl);
  const name = p.namespace ? `${p.namespace}${p.type === 'maven' ? ':' : '/'}${p.name}` : p.name;
  return { purl: s.purl, ecosystem: p.type === 'npm' ? 'npm' : 'generic', name, version: p.version! };
});
const inventory: Inventory = E2E ? (await ingest(E2E_REPO_DIR)) : { assets: [], components, edges: [] };
const http = new HttpClient({ offline: false, cacheDir: false, transport: realFetch });
const recordedAt = new Date();
const now = E2E ? FIXTURE_AS_OF : recordedAt;
const facts = await createLicenseEnricher().enrich(inventory, { http, now, offline: false, historical: E2E, warn: (m) => console.error(`warn: ${m}`) });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const r of recorded) {
  const u = new URL(r.url);
  const kind = u.pathname.includes('versionbatch') ? 'batch' : u.pathname.startsWith('/definitions') ? 'clearlydefined' : 'package';
  const response = r.status !== 200 ? r.response : kind === 'batch' ? trimBatch(r.response) : kind === 'clearlydefined' ? trimDefinitions(r.response) : trimPackage(r.response);
  const id = createHash('sha256').update(`${r.method} ${r.url} ${JSON.stringify(r.body ?? null)}`).digest('hex').slice(0, 10);
  const slug = `${kind}-${decodeURIComponent(u.pathname.split('/').pop() ?? '').replace(/[^A-Za-z0-9.@-]+/g, '_').slice(0, 60)}-${id}`;
  writeFileSync(
    join(OUT, `${slug}.json`),
    // Compact JSON, one top-level key per line (the files are large; diffs stay readable per key).
    `{\n${[
      ['_note', `Recorded live ${recordedAt.toISOString()} by test/licenses/record.ts; response trimmed to the fields the licences enricher reads.`],
      ['request', { url: r.url, ...(r.method !== 'GET' ? { method: r.method } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }],
      ['status', r.status],
      ['response', response],
    ]
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n')}\n}\n`,
  );
}
const changes = facts.filter((f) => f.kind === 'license_change');
console.log(`recorded ${recorded.length} responses; ${facts.length} facts, ${changes.length} licence changes`);
for (const f of changes) if (f.kind === 'license_change') console.log(`${f.subject}: ${f.value.previousVersion} → ${f.value.version} ${f.value.from.join(' · ')} → ${f.value.to.join(' · ')} (${f.value.date ?? '?'})`);
for (const f of facts) if (f.kind === 'license') console.log(`${f.source.padEnd(15)} ${f.subject}: ${f.value.expressions.join(' · ') || f.value.raw.join(' · ')} [${f.value.status}, ${f.value.category}]`);
