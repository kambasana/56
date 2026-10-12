/**
 * Agentic gap-filler gate on real recorded pages (docs/WHO-BEHIND-PLAN.md §10 "Agentic
 * gap-filler"). Pages were fetched once by record.ts and replay offline; the gate re-fetches them
 * through the offline HttpClient exactly as it would online.
 *
 * Real quotes (copied from the live pages) with values they support → verified (or
 * pending_confirmation for org jurisdiction). Fabricated quotes, wrong domains, values the quote
 * does not support and a blocked source → unverified, with the failing check named.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import type { AgentJson, AgentProposal } from '../../src/core/agentic-types.js';
import { defaultTaskRegistry, verifyProposal, type FactRequest, type ProposedFact } from '../../src/agentic/index.js';
import { PAGES } from './pages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGES_DIR = join(HERE, '..', 'fixtures', 'agentic', 'pages');
const NOW = new Date('2026-10-11T12:00:00Z');
const registry = defaultTaskRegistry();

function http(): HttpClient {
  return new HttpClient({ offline: true, fixturesDir: PAGES_DIR, cacheDir: false });
}

function urlOf(name: string): string {
  const p = PAGES.find((x) => x.name === name);
  if (!p) throw new Error(name);
  return p.url;
}

interface Case {
  name: string;
  page: string;
  req: FactRequest;
  value: AgentJson;
  quote: string;
  /** Override the source URL (domain tests). */
  url?: string;
  expect: AgentProposal['status'];
  /** For unverified: the check that must fail. */
  failed?: string;
}

const babel: FactRequest = { task: 'funding', subject: 'pkg:npm/@babel/core', subjectKind: 'package', question: 'Who funds Babel?', context: { name: 'Babel' } };
const webpack: FactRequest = { task: 'funding', subject: 'pkg:npm/webpack', subjectKind: 'package', question: 'Who funds webpack?', context: { name: 'webpack' } };
const faker: FactRequest = { task: 'funding', subject: 'pkg:npm/@faker-js/faker', subjectKind: 'package', question: 'Who funds Faker?', context: { name: 'Faker' } };
const moment: FactRequest = { task: 'lifecycle_events', subject: 'pkg:npm/moment', subjectKind: 'package', question: 'Has Moment.js announced maintenance mode or end of life?', context: { name: 'Moment.js', homepage: 'https://momentjs.com', domains: ['momentjs.com'] } };
const redis: FactRequest = { task: 'lifecycle_events', subject: 'pkg:github/redis/redis', subjectKind: 'package', question: 'Has Redis changed its licence?', context: { name: 'Redis', homepage: 'https://redis.io', domains: ['redis.io'] } };
const elastic: FactRequest = { task: 'lifecycle_events', subject: 'pkg:maven/org.elasticsearch/elasticsearch', subjectKind: 'package', question: 'Has Elasticsearch changed its licence?', context: { name: 'Elasticsearch', homepage: 'https://www.elastic.co', domains: ['elastic.co'] } };
const osc: FactRequest = { task: 'org_jurisdiction', subject: 'funder:opencollective/opensource', subjectKind: 'org', question: 'Where is Open Source Collective registered?', context: { name: 'Open Source Collective', domains: ['oscollective.org'] } };
const elasticNv: FactRequest = { task: 'org_jurisdiction', subject: 'org:github/elastic', subjectKind: 'org', question: 'Where is Elastic N.V. registered?', context: { name: 'Elastic N.V.' } };
const express: FactRequest = { task: 'governance', subject: 'pkg:npm/express', subjectKind: 'package', question: 'Is Express part of a foundation?', context: { name: 'Express' } };
const xz: FactRequest = { task: 'incident_writeups', subject: 'pkg:github/tukaani-project/xz', subjectKind: 'package', question: 'Is there a public write-up of a compromise of xz?', context: { name: 'xz' } };
const leftpad: FactRequest = { task: 'incident_writeups', subject: 'pkg:npm/left-pad', subjectKind: 'package', question: 'Is there a public write-up of the left-pad unpublish?', context: { name: 'left-pad' } };
const eventStream: FactRequest = { task: 'incident_writeups', subject: 'pkg:npm/event-stream', subjectKind: 'package', question: 'Is there a public write-up of the event-stream compromise?', context: { name: 'event-stream' } };

export const ACCEPTED: Case[] = [
  { name: 'babel fiscal host', page: 'oc-babel', req: babel, value: { kind: 'fiscal_host', organization: 'Open Source Collective' }, quote: 'Fiscal Host: Open Source Collective', expect: 'verified' },
  { name: 'babel top backer with amount', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Airbnb', amount: { value: 217858, currency: 'USD', since: 'Apr 2018' } }, quote: 'Airbnb $217,858 USD since Apr 2018', expect: 'verified' },
  { name: 'babel second backer, decimals (a public agency)', page: 'oc-babel', req: babel, value: { kind: 'public_agency', organization: 'Sovereign Tech Agency', amount: { value: 207511.35, currency: 'USD' } }, quote: 'Sovereign Tech Agency $207,511.35 USD since May 2025', expect: 'verified' },
  { name: 'webpack fiscal host', page: 'oc-webpack', req: webpack, value: { kind: 'fiscal_host', organization: 'Open Source Collective' }, quote: 'Fiscal Host: Open Source Collective', expect: 'verified' },
  { name: 'webpack top backer', page: 'oc-webpack', req: webpack, value: { kind: 'corporate_backer', organization: 'trivago', amount: { value: 389985, currency: 'USD' } }, quote: 'trivago $389,985 USD since Aug 2017', expect: 'verified' },
  { name: 'faker top backer', page: 'oc-fakerjs', req: faker, value: { kind: 'corporate_backer', organization: 'Indeed', amount: { value: 29000, currency: 'USD' } }, quote: 'Indeed $29,000 USD since Feb 2021', expect: 'verified' },
  { name: 'moment maintenance mode', page: 'moment-docs', req: moment, value: { event: 'maintenance_mode', summary: 'The Moment.js documentation describes it as a legacy project in maintenance mode.' }, quote: 'Moment.js is a legacy project in maintenance mode.', expect: 'verified' },
  { name: 'redis AGPL option (2025)', page: 'redis-agpl', req: redis, value: { event: 'relicensing', date: '2025-05-01', summary: 'Redis added AGPLv3 as a licensing option starting with Redis 8.', licenseTo: ['AGPL-3.0-only'] }, quote: 'Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now)', expect: 'verified' },
  { name: 'redis RSAL/SSPL (2024)', page: 'redis-2024', req: redis, value: { event: 'relicensing', date: '2024-03-20', summary: 'Redis 7.4 and later are dual-licensed under RSALv2 and SSPLv1.', licenseTo: ['RSALv2', 'SSPL-1.0'] }, quote: 'Starting with Redis 7.4, Redis will be dual-licensed under the Redis Source Available License (RSALv2) and Server Side Public License (SSPLv1).', expect: 'verified' },
  { name: 'elastic AGPL option (2024)', page: 'elastic-oss', req: elastic, value: { event: 'relicensing', date: '2024-08-29', summary: 'Elastic announced AGPL as an added licence option next to ELv2 and SSPL.', licenseTo: ['AGPL-3.0-only'] }, quote: 'The tl;dr is that we will be adding AGPL as another license option next to ELv2 and SSPL in the coming weeks.', expect: 'verified' },
  { name: 'elastic SSPL/ELv2 (2021)', page: 'elastic-2021', req: elastic, value: { event: 'relicensing', date: '2021-01', summary: 'Elasticsearch and Kibana moved from Apache 2.0 to SSPL and the Elastic License.', licenseFrom: ['Apache-2.0'], licenseTo: ['SSPL-1.0', 'Elastic-2.0'] }, quote: 'We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL) and the Elastic License', expect: 'verified' },
  { name: 'Open Source Collective jurisdiction (own site)', page: 'osc-home', req: osc, value: { country: 'US', basis: 'tax_registration', registry: 'org_legal_page', identifier: '82-2037583' }, quote: "We're a 501(c)(6) non-profit registered in the USA. EIN 82-2037583", expect: 'pending_confirmation' },
  { name: 'Elastic N.V. business address (SEC EDGAR)', page: 'edgar-elastic', req: elasticNv, value: { country: 'US', region: 'CA', basis: 'business_address', registry: 'sec_edgar' }, quote: 'State location: CA | Fiscal Year End: 0430', expect: 'pending_confirmation' },
  { name: 'express in the OpenJS Foundation', page: 'openjsf-projects', req: express, value: { kind: 'foundation_member', organization: 'OpenJS Foundation' }, quote: 'Express is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.', expect: 'verified' },
  { name: 'xz backdoor report', page: 'openwall-xz', req: xz, value: { kind: 'compromise', date: '2024-03-29', summary: 'Reported on oss-security: the upstream xz repository and release tarballs contained a backdoor.' }, quote: 'The upstream xz repository and the xz tarballs have been backdoored.', expect: 'verified' },
  { name: 'left-pad unpublish (npm blog)', page: 'npm-leftpad', req: leftpad, value: { kind: 'unpublish', date: '2016-03', summary: 'npm reported that left-pad was unpublished by its author during a dispute over a package name.' }, quote: 'a package that many projects depend on — directly or indirectly — was unpublished by its author, as part of a dispute over a package name.', expect: 'verified' },
  // Dates at every precision, from the page metadata (byline, JSON-LD, <time>) or the URL path.
  { name: 'date from the byline at day precision (npm blog)', page: 'npm-leftpad', req: leftpad, value: { kind: 'unpublish', date: '2016-03-23', summary: 'npm reported that a package was unpublished by its author during a dispute over a package name.' }, quote: 'was unpublished by its author, as part of a dispute over a package name.', expect: 'verified' },
  { name: 'date at year precision (npm blog)', page: 'npm-leftpad', req: leftpad, value: { kind: 'unpublish', date: '2016', summary: 'npm reported that a package was unpublished by its author during a dispute over a package name.' }, quote: 'was unpublished by its author, as part of a dispute over a package name.', expect: 'verified' },
  { name: 'date from article:published_time (Elastic 2021, day)', page: 'elastic-2021', req: elastic, value: { event: 'relicensing', date: '2021-01-14', summary: 'Elasticsearch and Kibana moved from Apache 2.0 to SSPL and the Elastic License.', licenseFrom: ['Apache-2.0'], licenseTo: ['SSPL-1.0'] }, quote: 'We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL)', expect: 'verified' },
  { name: 'date from the URL path (oss-security archive)', page: 'openwall-xz', req: xz, value: { kind: 'compromise', date: '2024-03', summary: 'Reported on oss-security: the upstream xz repository and release tarballs contained a backdoor.' }, quote: 'The upstream xz repository and the xz tarballs have been backdoored.', expect: 'verified' },
  { name: 'date at month precision from the text near the quote ("in March 2024")', page: 'redis-agpl', req: redis, value: { event: 'relicensing', date: '2024-03', summary: 'Redis moved to the SSPL licence.', licenseTo: ['SSPL-1.0'] }, quote: 'in March 2024, we decided to move Redis to the SSPL license', expect: 'verified' },
  // Funding kinds checked against deterministic evidence.
  { name: 'public agency by the known list (Sovereign Tech Agency)', page: 'oc-babel', req: babel, value: { kind: 'public_agency', organization: 'Sovereign Tech Agency' }, quote: 'Sovereign Tech Agency $207,511.35 USD since May 2025', expect: 'verified' },
];

export const REJECTED: Case[] = [
  // Fabricated quotes: plausible statements that are not on the page.
  { name: 'fabricated: babel fiscal host', page: 'oc-babel', req: babel, value: { kind: 'fiscal_host', organization: 'Linux Foundation' }, quote: 'Fiscal Host: Linux Foundation', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: babel funded by Google', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Google' }, quote: 'Babel is funded entirely by Google', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: babel amount x10', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Airbnb', amount: { value: 2178580, currency: 'USD' } }, quote: 'Airbnb $2,178,580 USD since Apr 2018', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: webpack Microsoft', page: 'oc-webpack', req: webpack, value: { kind: 'corporate_backer', organization: 'Microsoft' }, quote: 'webpack is sponsored by Microsoft as its only funder', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: faker amount', page: 'oc-fakerjs', req: faker, value: { kind: 'corporate_backer', organization: 'Indeed', amount: { value: 290000, currency: 'USD' } }, quote: 'Indeed $290,000 USD since Feb 2021', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: moment archived', page: 'moment-docs', req: moment, value: { event: 'archival', summary: 'Moment.js was archived.' }, quote: 'Moment.js has reached end-of-life and the repository is archived.', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: redis MIT', page: 'redis-agpl', req: redis, value: { event: 'relicensing', summary: 'Redis 8 is MIT licensed.', licenseTo: ['MIT'] }, quote: 'Redis 8 is released under the MIT license', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: redis 7.2 AGPL', page: 'redis-2024', req: redis, value: { event: 'relicensing', summary: 'Redis 7.2 moved to AGPLv3.', licenseTo: ['AGPL-3.0-only'] }, quote: 'Starting with Redis 7.2, Redis will be licensed under the AGPLv3.', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: elastic back to Apache', page: 'elastic-oss', req: elastic, value: { event: 'relicensing', summary: 'Elastic returned to Apache 2.0 only.', licenseTo: ['Apache-2.0'] }, quote: 'we will be removing SSPL and ELv2 and use only the Apache 2.0 license', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: elastic GPL', page: 'elastic-2021', req: elastic, value: { event: 'relicensing', summary: 'Elasticsearch moved to GPL-3.0.', licenseTo: ['GPL-3.0-only'] }, quote: 'We are moving Elasticsearch and Kibana to the GPL-3.0 license', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: OSC in the UK', page: 'osc-home', req: osc, value: { country: 'GB', basis: 'registered_office', registry: 'org_legal_page' }, quote: 'Open Source Collective is registered in the United Kingdom', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: EDGAR NY', page: 'edgar-elastic', req: elasticNv, value: { country: 'US', region: 'NY', basis: 'business_address', registry: 'sec_edgar' }, quote: 'State location: NY | Fiscal Year End: 0430', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: express owned by Google', page: 'openjsf-projects', req: express, value: { kind: 'owner_organization', organization: 'Google LLC' }, quote: 'Express is owned and operated by Google LLC.', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: xz not affected', page: 'openwall-xz', req: xz, value: { kind: 'other', summary: 'No release was affected.' }, quote: 'The xz maintainers have confirmed that no release was affected.', expect: 'unverified', failed: 'quote_present' },
  { name: 'fabricated: left-pad malware', page: 'npm-leftpad', req: leftpad, value: { kind: 'malicious_release', summary: 'left-pad contained malware.' }, quote: 'left-pad was removed by npm because it contained malware.', expect: 'unverified', failed: 'quote_present' },
  // Real quote, but the value is not what the quote says.
  { name: 'real quote, wrong backer', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Google', amount: { value: 217858, currency: 'USD' } }, quote: 'Airbnb $217,858 USD since Apr 2018', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, wrong amount', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Airbnb', amount: { value: 2178580, currency: 'USD' } }, quote: 'Airbnb $217,858 USD since Apr 2018', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, wrong foundation', page: 'openjsf-projects', req: express, value: { kind: 'foundation_member', organization: 'Linux Foundation' }, quote: 'Express is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, wrong country', page: 'osc-home', req: osc, value: { country: 'GB', basis: 'registered_office', registry: 'org_legal_page' }, quote: "We're a 501(c)(6) non-profit registered in the USA. EIN 82-2037583", expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, EDGAR is US-only', page: 'edgar-elastic', req: elasticNv, value: { country: 'NL', basis: 'business_address', registry: 'sec_edgar' }, quote: 'State location: CA | Fiscal Year End: 0430', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, wrong event type', page: 'moment-docs', req: moment, value: { event: 'deprecation', summary: 'Moment.js is deprecated.' }, quote: 'Moment.js is a legacy project in maintenance mode.', expect: 'unverified', failed: 'task_rules' },
  // Real quote, wrong date: the source states another date (or none of that precision).
  { name: 'real quote, date a year off (Redis AGPL 2024-05-01, real 2025-05-01)', page: 'redis-agpl', req: redis, value: { event: 'relicensing', date: '2024-05-01', summary: 'Redis added AGPLv3 as a licensing option starting with Redis 8.', licenseTo: ['AGPL-3.0-only'] }, quote: 'Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now)', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, date a month off (Elastic 2021-02)', page: 'elastic-2021', req: elastic, value: { event: 'relicensing', date: '2021-02', summary: 'Elasticsearch and Kibana moved from Apache 2.0 to SSPL and the Elastic License.', licenseFrom: ['Apache-2.0'], licenseTo: ['SSPL-1.0'] }, quote: 'We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL)', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, date a day off (npm blog 2016-03-22)', page: 'npm-leftpad', req: leftpad, value: { kind: 'unpublish', date: '2016-03-22', summary: 'npm reported that a package was unpublished by its author during a dispute over a package name.' }, quote: 'was unpublished by its author, as part of a dispute over a package name.', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, date a day off (Elastic AGPL 2024-08-30, the page states 2024-08-29)', page: 'elastic-oss', req: elastic, value: { event: 'relicensing', date: '2024-08-30', summary: 'Elastic announced AGPL as an added licence option next to ELv2 and SSPL.', licenseTo: ['AGPL-3.0-only'] }, quote: 'The tl;dr is that we will be adding AGPL as another license option next to ELv2 and SSPL in the coming weeks.', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, day more precise than the source ("in March 2024")', page: 'redis-agpl', req: redis, value: { event: 'relicensing', date: '2024-03-15', summary: 'Redis moved to the SSPL licence.', licenseTo: ['SSPL-1.0'] }, quote: 'in March 2024, we decided to move Redis to the SSPL license', expect: 'unverified', failed: 'task_rules' },
  // Real quote, wrong backer kind (contradicted by the known lists).
  { name: 'real quote, public agency proposed as corporate backer (Sovereign Tech Agency)', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Sovereign Tech Agency', amount: { value: 207511.35, currency: 'USD' } }, quote: 'Sovereign Tech Agency $207,511.35 USD since May 2025', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, fiscal host proposed as corporate backer', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Open Source Collective' }, quote: 'Fiscal Host: Open Source Collective', expect: 'unverified', failed: 'task_rules' },
  { name: 'real quote, judgement word in summary', page: 'openwall-xz', req: xz, value: { kind: 'compromise', summary: 'A rogue maintainer backdoored xz.' }, quote: 'The upstream xz repository and the xz tarballs have been backdoored.', expect: 'unverified', failed: 'task_rules' },
  // Domain: the source host is not evidence for this task / subject.
  { name: 'moment quote without the homepage domain', page: 'moment-docs', req: { ...moment, context: { name: 'Moment.js' } }, value: { event: 'maintenance_mode', summary: 'In maintenance mode.' }, quote: 'Moment.js is a legacy project in maintenance mode.', expect: 'unverified', failed: 'domain' },
  { name: 'funding fact cited from a vendor blog', page: 'redis-agpl', req: babel, value: { kind: 'other', organization: 'Redis' }, quote: 'Adding the OSI-approved AGPL as an additional licensing option for Redis', expect: 'unverified', failed: 'domain' },
  { name: 'jurisdiction from an own page on another org', page: 'osc-home', req: elasticNv, value: { country: 'US', basis: 'tax_registration', registry: 'org_legal_page' }, quote: "We're a 501(c)(6) non-profit registered in the USA. EIN 82-2037583", expect: 'unverified', failed: 'domain' },
  // Too short to verify anything.
  { name: 'quote too short', page: 'osc-home', req: osc, value: { country: 'US', basis: 'registered_office', registry: 'org_legal_page' }, quote: 'the USA', expect: 'unverified', failed: 'quote_length' },
  // Blocked source: GitHub issue pages answer 403 here (recorded), so nothing from them verifies.
  { name: 'blocked source (github.com 403)', page: 'github-event-stream-116', req: eventStream, value: { kind: 'malicious_release', summary: 'Reported in the issue tracker.' }, quote: 'I have published a malicious version of event-stream', expect: 'unverified', failed: 'fetch' },
];

async function gate(c: Case): Promise<AgentProposal> {
  const spec = registry.get(c.req.task)!;
  const p: ProposedFact = { task: c.req.task, subject: c.req.subject, value: c.value, sourceUrl: c.url ?? urlOf(c.page), quote: c.quote, retrievedAt: NOW.toISOString(), confidenceNote: 'test' };
  const r = await verifyProposal(p, c.req, spec, { http: http(), now: NOW });
  if (r.kind !== 'proposal') throw new Error(`privacy refusal: ${r.reason}`);
  return r.proposal;
}

describe('recorded pages', () => {
  it('every page in pages.ts has a fixture; the GitHub issue page is recorded as blocked (403)', () => {
    for (const p of PAGES) {
      const env = JSON.parse(readFileSync(join(PAGES_DIR, `${p.name}.json`), 'utf8')) as { request: { url: string }; status: number; _blocked?: string };
      expect(env.request.url).toBe(p.url);
      if (p.name === 'github-event-stream-116') {
        expect(env.status).toBe(403);
        expect(env._blocked).toMatch(/HTTP 403/);
      } else expect(env.status).toBe(200);
    }
  });

  it('every real quote in pages.ts is on its recorded page, every fabricated one is not', async () => {
    const { findQuote, pageText } = await import('../../src/agentic/normalize.js');
    for (const p of PAGES) {
      const env = JSON.parse(readFileSync(join(PAGES_DIR, `${p.name}.json`), 'utf8')) as { response: string };
      const text = pageText(env.response);
      for (const q of p.real) expect(findQuote(text, q), `${p.name}: ${q}`).not.toBeNull();
      for (const q of p.fabricated) expect(findQuote(text, q), `${p.name}: ${q}`).toBeNull();
    }
  });

  it('recorded Open Collective pages keep organisations only (the Individuals list is cut)', () => {
    for (const name of ['oc-babel', 'oc-webpack', 'oc-fakerjs']) {
      const env = JSON.parse(readFileSync(join(PAGES_DIR, `${name}.json`), 'utf8')) as { response: string };
      expect(env.response).toContain('Organizations');
      expect(env.response).not.toMatch(/<p>Individuals<\/p>\s*<div>/);
    }
  });
});

describe('verification gate: real quotes are accepted', () => {
  for (const c of ACCEPTED) {
    it(c.name, async () => {
      const p = await gate(c);
      expect(p.reasons).toEqual([]);
      expect(p.status).toBe(c.expect);
      expect(p.checks.every((x) => x.ok)).toBe(true);
      expect(p.checks.map((x) => x.check)).toEqual(['task_binding', 'schema', 'privacy', 'domain', 'quote_length', 'fetch', 'quote_present', 'task_rules']);
      expect(p.verifiedAt).toBe(NOW.toISOString());
    });
  }
});

describe('verification gate: fabricated or unsupported proposals are rejected', () => {
  for (const c of REJECTED) {
    it(c.name, async () => {
      const p = await gate(c);
      expect(p.status).toBe('unverified');
      const failed = p.checks.filter((x) => !x.ok).map((x) => x.check);
      expect(failed).toContain(c.failed);
      expect(p.reasons.length).toBeGreaterThan(0);
      expect(p.verifiedAt).toBeUndefined();
    });
  }
});

describe('funding kind: checked where evidence exists, otherwise kept as an unverified kind', () => {
  it('a corporate backer listed under Organizations on Open Collective is verified with its kind', async () => {
    const p = await gate(ACCEPTED.find((c) => c.name === 'babel top backer with amount')!);
    expect(p.status).toBe('verified');
    expect(p.unverifiedFields).toBeUndefined();
  });

  it('a kind nothing deterministic supports keeps the amount and is marked unverified', async () => {
    // Airbnb is an organisation account on Open Collective; nothing says it is a foundation, and nothing contradicts it.
    const p = await gate({ name: 'airbnb as foundation', page: 'oc-babel', req: babel, value: { kind: 'foundation', organization: 'Airbnb', amount: { value: 217858, currency: 'USD' } }, quote: 'Airbnb $217,858 USD since Apr 2018', expect: 'verified' });
    expect(p.status).toBe('verified');
    expect(p.unverifiedFields).toEqual(['kind']);
    expect(p.checks.find((c) => c.check === 'task_rules')).toMatchObject({ ok: true, detail: expect.stringMatching(/^kind unverified: foundation not confirmed/) });
  });

  it('an amount with a "since" the quote does not have is rejected', async () => {
    const p = await gate({ name: 'since', page: 'oc-babel', req: babel, value: { kind: 'corporate_backer', organization: 'Airbnb', amount: { value: 217858, currency: 'USD', since: 'Apr 2017' } }, quote: 'Airbnb $217,858 USD since Apr 2018', expect: 'unverified' });
    expect(p.reasons).toEqual(['since "Apr 2017" is not in the quote']);
  });

  it('the public agency is rejected as a corporate backer with the reason', async () => {
    const p = await gate(REJECTED.find((c) => c.name.startsWith('real quote, public agency'))!);
    expect(p.reasons).toEqual(['Sovereign Tech Agency is a public agency (known public funders list), not a corporate backer']);
  });
});

describe('gate summary (numbers quoted in the plan)', () => {
  it('counts', () => {
    expect(ACCEPTED.length).toBe(22);
    expect(REJECTED.length).toBe(34);
    expect(REJECTED.filter((c) => c.failed === 'quote_present').length).toBe(15);
  });
});
