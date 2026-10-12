/**
 * Live run of 2026-10-12: model turns produced by a Claude Code agent acting as the model, live
 * web. No Anthropic API key was used: the agent read each task's system prompt and evidence domains,
 * fetched the sources itself (curl through the egress proxy, allowed domains only), and wrote the
 * submit_facts calls below. `test/agentic/live-run.ts` turns them into model turns, runs them
 * through the real pipeline (privacy screen → gate with a live re-fetch), and saves the run as a
 * replay fixture (test/fixtures/agentic-live/).
 *
 * Requests mirror what src/enrich/agentic plans (same questions and context shape; npm homepages
 * are added by the enricher's own addHomepages()). Subjects outside npm (Elasticsearch, Redis,
 * xz-utils) and the two organisations are written by hand in the same shape.
 */
import type { FactRequest } from '../../src/agentic/index.js';

export interface ScriptedFetch {
  url: string;
  /** When the agent read the page (UTC, to the second). */
  retrievedAt: string;
  /** What the agent read there (excerpt, as text). */
  excerpt: string;
}

export interface ScriptedFact {
  value: unknown;
  source_url: string;
  quote: string;
  confidence_note: string;
}

export interface ScriptedTurn {
  text: string;
  fetches?: ScriptedFetch[];
  /** Client tools the agent called (run for real by the pipeline). */
  tools?: { name: string; input: Record<string, unknown> }[];
  submit?: { facts: ScriptedFact[]; none_found_reason?: string };
}

export interface ScriptedConversation {
  id: string;
  request: FactRequest;
  /** npm requests get the registry homepage the way the enricher adds it. */
  npmHomepage?: boolean;
  turns: ScriptedTurn[];
  /** Adversarial or probe runs: what the attempt is and the verdict expected from a correct gate. */
  attempt?: { kind: 'adversarial' | 'probe'; what: string; correct: 'reject' | 'accept' };
}

const FUNDING_Q = 'Which funding channels does this project declare, and which organisations back it?';
const GOVERNANCE_Q = 'Which organisation or foundation owns or governs this project?';
const INCIDENT_Q = 'Advisories list this package as compromised or malicious. Find the public write-up or post-mortem.';
const JURISDICTION_Q = 'In which country is this organisation registered or incorporated, according to a public registry or its own legal page?';

function npmReq(task: string, name: string, question: string, repo: string): FactRequest {
  return { task, subject: `pkg:npm/${name}`, subjectKind: 'package', question, context: { name, ecosystem: 'npm', packageName: name, repoUrl: repo } };
}

const T = (s: string) => `2026-10-12T${s}Z`;
const OSC = 'Fiscal Host: Open Source Collective';

function ocFunding(id: string, name: string, slug: string, repo: string, time: string, backers: { org: string; value: number; since: string; quote: string }[]): ScriptedConversation {
  const url = `https://opencollective.com/${slug}`;
  return {
    id,
    request: npmReq('funding', name, FUNDING_Q, repo),
    npmHomepage: true,
    turns: [
      {
        text: `No funding facts from the collectors; reading the Open Collective page for ${slug}.`,
        fetches: [{ url, retrievedAt: T(time), excerpt: [OSC, 'Top financial contributors Organizations', ...backers.map((b) => b.quote)].join(' ... ') }],
        submit: {
          facts: [
            { value: { kind: 'fiscal_host', organization: 'Open Source Collective', url }, source_url: url, quote: OSC, confidence_note: 'High: the collective header on Open Collective names the fiscal host.' },
            ...backers.map((b) => ({
              value: { kind: 'corporate_backer', organization: b.org, amount: { value: b.value, currency: 'USD', since: b.since } },
              source_url: url,
              quote: b.quote,
              confidence_note: 'High: entry of the Organizations list under Top financial contributors (lifetime total as shown).',
            })),
          ],
        },
      },
    ],
  };
}

export const LIVE: ScriptedConversation[] = [
  // ---------------------------------------------------------------- funding
  ocFunding('funding-core-js', 'core-js', 'core-js', 'https://github.com/zloirock/core-js', '20:22:02', [{ org: 'Cybozu', value: 21017, since: 'Jun 2021', quote: 'Cybozu $21,017 USD since Jun 2021' }]),
  ocFunding('funding-babel', '@babel/core', 'babel', 'https://github.com/babel/babel', '20:22:03', [
    { org: 'Airbnb', value: 217858, since: 'Apr 2018', quote: 'Airbnb $217,858 USD since Apr 2018' },
    { org: 'Sovereign Tech Agency', value: 207511.35, since: 'May 2025', quote: 'Sovereign Tech Agency $207,511.35 USD since May 2025' },
  ]),
  ocFunding('funding-webpack', 'webpack', 'webpack', 'https://github.com/webpack/webpack', '20:22:04', [
    { org: 'trivago', value: 389985, since: 'Aug 2017', quote: 'trivago $389,985 USD since Aug 2017' },
    { org: 'AG Grid', value: 267500, since: 'Mar 2017', quote: 'AG Grid $267,500 USD since Mar 2017' },
  ]),
  ocFunding('funding-faker', '@faker-js/faker', 'fakerjs', 'https://github.com/faker-js/faker', '20:22:05', [{ org: 'Indeed', value: 29000, since: 'Feb 2021', quote: 'Indeed $29,000 USD since Feb 2021' }]),
  // Express: the page lists individual contributors only; no organisation is proposed.
  ocFunding('funding-express', 'express', 'express', 'https://github.com/expressjs/express', '20:22:06', []),

  // ---------------------------------------------------------------- governance
  ...(
    [
      ['governance-express', 'express', 'https://github.com/expressjs/express', 'Express is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.'],
      ['governance-webpack', 'webpack', 'https://github.com/webpack/webpack', 'webpack is a bundler for modules and is primarily used to bundle JavaScript files for usage in a browser.'],
      ['governance-lodash', 'lodash', 'https://github.com/lodash/lodash', 'Lodash is a modern JavaScript utility library delivering modularity, performance & extras.'],
    ] as const
  ).map(
    ([id, name, repo, quote]): ScriptedConversation => ({
      id,
      request: npmReq('governance', name, GOVERNANCE_Q, repo),
      npmHomepage: true,
      turns: [
        {
          text: `Checking whether the OpenJS Foundation lists ${name} as a hosted project.`,
          fetches: [{ url: 'https://openjsf.org/projects', retrievedAt: T('20:22:06'), excerpt: `Hosted Projects ... ${quote} Learn more` }],
          submit: {
            facts: [
              {
                value: { kind: 'foundation_member', organization: 'OpenJS Foundation', summary: `The OpenJS Foundation projects page lists ${name} among its hosted projects.` },
                source_url: 'https://openjsf.org/projects',
                quote,
                confidence_note: "High: the foundation's own projects page has an entry for the project.",
              },
            ],
          },
        },
      ],
    }),
  ),

  // ---------------------------------------------------------------- lifecycle_events
  {
    id: 'lifecycle-moment',
    request: npmReq('lifecycle_events', 'moment', 'Has the project announced maintenance mode, deprecation or end of life? Find the project\'s own announcement and its date.', 'https://github.com/moment/moment'),
    npmHomepage: true,
    turns: [
      {
        text: 'Reading the project status note on the Moment.js docs (the npm homepage domain).',
        fetches: [{ url: 'https://momentjs.com/docs/', retrievedAt: T('20:22:07'), excerpt: 'Project status Moment.js is a legacy project in maintenance mode. Read the latest update' }],
        submit: {
          facts: [
            {
              value: { event: 'maintenance_mode', summary: 'The Moment.js documentation describes the project as a legacy project in maintenance mode.' },
              source_url: 'https://momentjs.com/docs/',
              quote: 'Moment.js is a legacy project in maintenance mode.',
              confidence_note: 'High: project status banner on the official docs; this sentence carries no date, so none is given.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'lifecycle-request',
    request: npmReq('lifecycle_events', 'request', 'Our collectors report that npm marks the latest version deprecated ("request has been deprecated, see https://github.com/request/request/issues/3142"). Find the project\'s own announcement and its date.', 'https://github.com/request/request'),
    npmHomepage: true,
    turns: [
      { text: 'Checking the registry record first.', tools: [{ name: 'npm_package', input: { name: 'request' } }] },
      {
        text: 'github.com answers 403 here; reading the README through raw.githubusercontent.com.',
        fetches: [{ url: 'https://raw.githubusercontent.com/request/request/master/README.md', retrievedAt: T('20:22:07'), excerpt: '# Deprecated! As of Feb 11th 2020, request is fully deprecated. No new changes are expected to land. In fact, none have landed for some time.' }],
        submit: {
          facts: [
            {
              value: { event: 'deprecation', date: '2020-02-11', summary: 'The request README states that the package is fully deprecated as of 11 February 2020 and that no new changes are expected.' },
              source_url: 'https://raw.githubusercontent.com/request/request/master/README.md',
              quote: 'As of Feb 11th 2020, request is fully deprecated. No new changes are expected to land.',
              confidence_note: "High: first lines of the project's own README; the date is stated in the sentence.",
            },
          ],
        },
      },
    ],
  },
  {
    id: 'lifecycle-elasticsearch',
    request: {
      task: 'lifecycle_events',
      subject: 'pkg:maven/org.elasticsearch/elasticsearch',
      subjectKind: 'package',
      question: 'Our collectors report that the declared licence changed between releases. Find the project\'s own announcement and its date.',
      context: { name: 'Elasticsearch', ecosystem: 'maven', packageName: 'org.elasticsearch:elasticsearch', repoUrl: 'https://github.com/elastic/elasticsearch', homepage: 'https://www.elastic.co/elasticsearch', domains: ['www.elastic.co'] },
    },
    turns: [
      {
        text: "Reading Elastic's own licensing announcements of 2021 and 2024.",
        fetches: [
          { url: 'https://www.elastic.co/blog/licensing-change', retrievedAt: T('20:22:07'), excerpt: 'January 14, 2021 ... We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL) and the Elastic License, giving users the choice of which license to apply.' },
          { url: 'https://www.elastic.co/blog/elasticsearch-is-open-source-again', retrievedAt: T('20:22:08'), excerpt: 'By Shay Banon August 29, 2024 ... The tl;dr is that we will be adding AGPL as another license option next to ELv2 and SSPL in the coming weeks.' },
        ],
        submit: {
          facts: [
            {
              value: { event: 'relicensing', date: '2021-01-14', summary: 'Elastic announced that Elasticsearch and Kibana source code would move from Apache 2.0 to dual licensing under SSPL and the Elastic License.', licenseFrom: ['Apache-2.0'], licenseTo: ['SSPL-1.0', 'Elastic License'] },
              source_url: 'https://www.elastic.co/blog/licensing-change',
              quote: 'We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL) and the Elastic License, giving users the choice of which license to apply.',
              confidence_note: "High: Elastic's own blog post dated January 14, 2021.",
            },
            {
              value: { event: 'relicensing', date: '2024-08-29', summary: 'Elastic announced that AGPL would be added as a further licence option for Elasticsearch next to ELv2 and SSPL.', licenseTo: ['AGPL-3.0'] },
              source_url: 'https://www.elastic.co/blog/elasticsearch-is-open-source-again',
              quote: 'The tl;dr is that we will be adding AGPL as another license option next to ELv2 and SSPL in the coming weeks.',
              confidence_note: "High: Elastic's own blog post dated August 29, 2024.",
            },
          ],
        },
      },
    ],
  },
  {
    id: 'lifecycle-redis',
    request: {
      task: 'lifecycle_events',
      subject: 'pkg:github/redis/redis',
      subjectKind: 'package',
      question: 'Our collectors report that the declared licence changed between releases. Find the project\'s own announcement and its date.',
      context: { name: 'Redis', repoUrl: 'https://github.com/redis/redis', homepage: 'https://redis.io', domains: ['redis.io'] },
    },
    turns: [
      {
        text: 'Reading the two licensing posts on redis.io.',
        fetches: [
          { url: 'https://redis.io/blog/redis-adopts-dual-source-available-licensing/', retrievedAt: T('20:22:08'), excerpt: 'Redis Adopts Dual Source-Available Licensing March 20, 2024 ... Starting with Redis 7.4, Redis will be dual-licensed under the Redis Source Available License (RSALv2) and Server Side Public License (SSPLv1). Consequently, Redis will no longer be distributed under the three-clause Berkeley Software Distribution (BSD).' },
          { url: 'https://redis.io/blog/agplv3/', retrievedAt: T('20:22:08'), excerpt: 'Redis is now available under the AGPLv3 open source license May 01, 2025 ... Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now);' },
        ],
        submit: {
          facts: [
            {
              value: { event: 'relicensing', date: '2024-03-20', summary: 'Redis announced that from Redis 7.4 it is dual-licensed under RSALv2 and SSPLv1 instead of the three-clause BSD licence.', licenseFrom: ['BSD-3-Clause'], licenseTo: ['RSALv2', 'SSPL-1.0'] },
              source_url: 'https://redis.io/blog/redis-adopts-dual-source-available-licensing/',
              quote: 'Starting with Redis 7.4, Redis will be dual-licensed under the Redis Source Available License (RSALv2) and Server Side Public License (SSPLv1). Consequently, Redis will no longer be distributed under the three-clause Berkeley Software Distribution (BSD).',
              confidence_note: "High: Redis's own post dated March 20, 2024.",
            },
            {
              value: { event: 'relicensing', date: '2025-05-01', summary: 'Redis announced AGPL as an additional licence option starting with Redis 8.', licenseTo: ['AGPL-3.0'] },
              source_url: 'https://redis.io/blog/agplv3/',
              quote: 'Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now)',
              confidence_note: "High: Redis's own post dated May 01, 2025.",
            },
          ],
        },
      },
    ],
  },

  // ---------------------------------------------------------------- incident_writeups
  {
    id: 'incident-xz',
    request: {
      task: 'incident_writeups',
      subject: 'pkg:github/tukaani-project/xz',
      subjectKind: 'package',
      question: INCIDENT_Q,
      context: { name: 'xz-utils', repoUrl: 'https://github.com/tukaani-project/xz' },
    },
    turns: [
      {
        text: 'Reading the original oss-security report and the NVD record for CVE-2024-3094 (the NVD detail page renders with JavaScript; the NVD API returns the same description).',
        fetches: [
          { url: 'https://www.openwall.com/lists/oss-security/2024/03/29/4', retrievedAt: T('20:22:09'), excerpt: 'Date: Fri, 29 Mar 2024 ... I figured out the answer: The upstream xz repository and the xz tarballs have been backdoored.' },
          { url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2024-3094', retrievedAt: T('20:22:10'), excerpt: '"id":"CVE-2024-3094" ... "value":"Malicious code was discovered in the upstream tarballs of xz, starting with version 5.6.0.' },
        ],
        submit: {
          facts: [
            {
              value: { kind: 'compromise', date: '2024-03-29', summary: 'Reported on the oss-security list that the upstream xz repository and release tarballs contained a backdoor.' },
              source_url: 'https://www.openwall.com/lists/oss-security/2024/03/29/4',
              quote: 'The upstream xz repository and the xz tarballs have been backdoored.',
              confidence_note: 'High: the original public report, dated 29 March 2024.',
            },
            {
              value: { kind: 'compromise', summary: 'NVD describes code in the upstream xz tarballs, starting with version 5.6.0, that modifies the liblzma library.', advisoryIds: ['CVE-2024-3094'] },
              source_url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2024-3094',
              quote: 'Malicious code was discovered in the upstream tarballs of xz, starting with version 5.6.0.',
              confidence_note: 'High: NVD record description for CVE-2024-3094.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'incident-event-stream',
    request: npmReq('incident_writeups', 'event-stream', INCIDENT_Q, 'https://github.com/dominictarr/event-stream'),
    npmHomepage: true,
    turns: [
      {
        text: "github.com issue #116 answers 403 here; reading npm's incident post and the OSV record of the GitHub advisory.",
        fetches: [
          { url: 'https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident', retrievedAt: T('20:22:10'), excerpt: 'On the morning of November 26th, npm’s security team was notified ... The malicious package was version 0.1.1 of flatmap-stream. This package was added as a direct dependency of the event-stream package by a new maintainer on September 9, 2018, in version 3.3.6.' },
          { url: 'https://osv.dev/vulnerability/GHSA-mh6f-8j2x-4483', retrievedAt: T('20:22:10'), excerpt: 'Critical severity vulnerability that affects event-stream and flatmap-stream ... A malicious actor added this package as a dependency to the NPM event-stream package in version 3.3.6.' },
        ],
        submit: {
          facts: [
            {
              value: { kind: 'malicious_release', date: '2018-11-26', summary: 'npm reports that flatmap-stream 0.1.1 was added as a dependency of event-stream 3.3.6 by a new maintainer, and that npm removed both from the registry after being notified on November 26.' },
              source_url: 'https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident',
              quote: 'The malicious package was version 0.1.1 of flatmap-stream. This package was added as a direct dependency of the event-stream package by a new maintainer on September 9, 2018, in version 3.3.6.',
              confidence_note: "High: npm's own incident write-up (2018).",
            },
            {
              value: { kind: 'malicious_release', summary: 'The GitHub advisory (via OSV) reports that flatmap-stream was added as a dependency of event-stream 3.3.6.', advisoryIds: ['GHSA-mh6f-8j2x-4483'] },
              source_url: 'https://osv.dev/vulnerability/GHSA-mh6f-8j2x-4483',
              quote: 'A malicious actor added this package as a dependency to the NPM event-stream package in version 3.3.6.',
              confidence_note: 'High: reviewed GitHub advisory as published on osv.dev.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'incident-left-pad',
    request: npmReq('incident_writeups', 'left-pad', 'Is there a public write-up of a compromise, sabotage or unpublish affecting this package?', 'https://github.com/stevemao/left-pad'),
    npmHomepage: true,
    turns: [
      {
        text: "Reading npm's 2016 post about left-pad.",
        fetches: [{ url: 'https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm', retrievedAt: T('20:22:11'), excerpt: 'kik, left-pad, and npm Earlier this week, many npm users suffered a disruption when a package that many projects depend on — directly or indirectly — was unpublished by its author, as part of a dispute over a package name. ... March 23rd, 2016' }],
        submit: {
          facts: [
            {
              value: { kind: 'unpublish', date: '2016-03', summary: 'npm reports that a widely used package was unpublished by its author during a dispute over a package name, disrupting many npm users.' },
              source_url: 'https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm',
              quote: 'Earlier this week, many npm users suffered a disruption when a package that many projects depend on — directly or indirectly — was unpublished by its author, as part of a dispute over a package name.',
              confidence_note: 'High: npm blog post "kik, left-pad, and npm" of March 23rd, 2016; the title names left-pad, the quoted sentence does not.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'incident-colors',
    request: npmReq('incident_writeups', 'colors', INCIDENT_Q, 'https://github.com/Marak/colors.js'),
    npmHomepage: true,
    turns: [
      {
        text: 'Reading the OSV record of the January 2022 colors advisory (github.com answers 403 here).',
        fetches: [{ url: 'https://osv.dev/vulnerability/GHSA-5rqg-jm4f-cqx7', retrievedAt: T('20:22:11'), excerpt: 'Published 2022-01-10T17:29:53Z ... Infinite loop causing Denial of Service in colors ... Between 07 and 09 January 2022, colors versions 1.4.1, 1.4.2, and 1.4.44-liberty-2 were published including malicious code that caused a Denial of Service due to an infinite loop.' }],
        submit: {
          facts: [
            {
              value: { kind: 'malicious_release', date: '2022-01', summary: 'OSV reports that colors 1.4.1, 1.4.2 and 1.4.44-liberty-2, published 7 to 9 January 2022, contained code that causes an infinite loop.', advisoryIds: ['GHSA-5rqg-jm4f-cqx7'] },
              source_url: 'https://osv.dev/vulnerability/GHSA-5rqg-jm4f-cqx7',
              quote: 'Between 07 and 09 January 2022, colors versions 1.4.1, 1.4.2, and 1.4.44-liberty-2 were published including malicious code that caused a Denial of Service due to an infinite loop.',
              confidence_note: 'High: reviewed GitHub advisory as published on osv.dev.',
            },
          ],
        },
      },
    ],
  },

  // ---------------------------------------------------------------- org_jurisdiction (pending_confirmation)
  {
    id: 'jurisdiction-osc',
    request: { task: 'org_jurisdiction', subject: 'funder:opencollective/opensource', subjectKind: 'org', question: JURISDICTION_Q, context: { name: 'Open Source Collective', domains: ['oscollective.org'] } },
    turns: [
      {
        text: "Reading the organisation's own site and its ProPublica Nonprofit Explorer record (IRS data).",
        fetches: [
          { url: 'https://oscollective.org/', retrievedAt: T('20:21:10'), excerpt: 'Get in touch We’re a 501(c)(6) non-profit registered in the USA. EIN 82-2037583' },
          { url: 'https://projects.propublica.org/nonprofits/organizations/822037583', retrievedAt: T('20:22:42'), excerpt: 'Open Source Collective Covina, CA Tax exemption issued: April 2018 EIN: 82-2037583' },
        ],
        submit: {
          facts: [
            {
              value: { country: 'US', basis: 'tax_registration', registry: 'org_legal_page', identifier: '82-2037583' },
              source_url: 'https://oscollective.org/',
              quote: 'We’re a 501(c)(6) non-profit registered in the USA. EIN 82-2037583',
              confidence_note: "High: the organisation's own site states the registration and EIN; proposed for human confirmation.",
            },
            {
              value: { country: 'US', region: 'CA', basis: 'business_address', registry: 'foundation_filing', identifier: '82-2037583' },
              source_url: 'https://projects.propublica.org/nonprofits/organizations/822037583',
              quote: 'Open Source Collective Covina, CA Tax exemption issued: April 2018 EIN: 82-2037583',
              confidence_note: 'High: IRS exempt-organisation record as shown by ProPublica Nonprofit Explorer (US filings only).',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'jurisdiction-elastic',
    request: { task: 'org_jurisdiction', subject: 'org:github/elastic', subjectKind: 'org', question: JURISDICTION_Q, context: { name: 'elastic', domains: ['www.elastic.co'], known: ['GitHub organisation: https://github.com/elastic'] } },
    turns: [
      {
        text: 'EDGAR company page renders with JavaScript and lists no state of incorporation; reading the cover page of the latest 10-K (fiscal year ended April 30, 2026).',
        fetches: [{ url: 'https://www.sec.gov/Archives/edgar/data/1707753/000170775326000018/estc-20260430.htm', retrievedAt: T('20:20:40'), excerpt: 'Elastic N.V. (Exact name of registrant as specified in its charter) ... The Netherlands 98-1756035 (State or other jurisdiction of incorporation or organization) (I.R.S. Employer Identification No.)' }],
        submit: {
          facts: [
            {
              value: { country: 'NL', basis: 'incorporation', registry: 'sec_edgar' },
              source_url: 'https://www.sec.gov/Archives/edgar/data/1707753/000170775326000018/estc-20260430.htm',
              quote: 'The Netherlands 98-1756035 (State or other jurisdiction of incorporation or organization)',
              confidence_note: 'High: cover page of the annual report Elastic N.V. filed with the SEC; proposed for human confirmation.',
            },
          ],
        },
      },
    ],
  },
];

/** Three adversarial attempts and two probes of known weak spots. Separate fixture file (same keys would collide). */
export const ADVERSARIAL: ScriptedConversation[] = [
  {
    id: 'adv-wrong-amount',
    attempt: { kind: 'adversarial', what: 'plausible but wrong amount: trivago 398,985 with the real quote "trivago $389,985 USD since Aug 2017"', correct: 'reject' },
    request: npmReq('funding', 'webpack', FUNDING_Q, 'https://github.com/webpack/webpack'),
    npmHomepage: true,
    turns: [
      {
        text: 'Adversarial: transposed digits in the amount.',
        fetches: [{ url: 'https://opencollective.com/webpack', retrievedAt: T('20:22:04'), excerpt: 'trivago $389,985 USD since Aug 2017' }],
        submit: { facts: [{ value: { kind: 'corporate_backer', organization: 'trivago', amount: { value: 398985, currency: 'USD', since: 'Aug 2017' } }, source_url: 'https://opencollective.com/webpack', quote: 'trivago $389,985 USD since Aug 2017', confidence_note: 'adversarial' }] },
      },
    ],
  },
  {
    id: 'adv-wrong-subject-funding',
    attempt: { kind: 'adversarial', what: "real quote on the wrong subject: core-js's Open Collective backer Cybozu proposed as a funder of express", correct: 'reject' },
    request: npmReq('funding', 'express', FUNDING_Q, 'https://github.com/expressjs/express'),
    npmHomepage: true,
    turns: [
      {
        text: "Adversarial: another project's Open Collective page.",
        fetches: [{ url: 'https://opencollective.com/core-js', retrievedAt: T('20:22:02'), excerpt: 'Cybozu $21,017 USD since Jun 2021' }],
        submit: { facts: [{ value: { kind: 'corporate_backer', organization: 'Cybozu', amount: { value: 21017, currency: 'USD', since: 'Jun 2021' } }, source_url: 'https://opencollective.com/core-js', quote: 'Cybozu $21,017 USD since Jun 2021', confidence_note: 'adversarial' }] },
      },
    ],
  },
  {
    id: 'adv-wrong-subject-governance',
    attempt: { kind: 'adversarial', what: "real quote on the wrong subject: OpenJS's Express entry proposed as lodash's foundation membership", correct: 'reject' },
    request: npmReq('governance', 'lodash', GOVERNANCE_Q, 'https://github.com/lodash/lodash'),
    npmHomepage: true,
    turns: [
      {
        text: "Adversarial: another project's line on the foundation page.",
        fetches: [{ url: 'https://openjsf.org/projects', retrievedAt: T('20:22:06'), excerpt: 'Express is a minimal and flexible Node.js web application framework' }],
        submit: { facts: [{ value: { kind: 'foundation_member', organization: 'OpenJS Foundation' }, source_url: 'https://openjsf.org/projects', quote: 'Express is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.', confidence_note: 'adversarial' }] },
      },
    ],
  },
  {
    id: 'adv-wrong-subject-incident',
    attempt: { kind: 'adversarial', what: "real quote on the wrong subject: npm's left-pad unpublish post proposed as an incident of express", correct: 'reject' },
    request: npmReq('incident_writeups', 'express', 'Is there a public write-up of a compromise affecting this package?', 'https://github.com/expressjs/express'),
    npmHomepage: true,
    turns: [
      {
        text: "Adversarial: another package's incident write-up.",
        fetches: [{ url: 'https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm', retrievedAt: T('20:22:11'), excerpt: 'was unpublished by its author, as part of a dispute over a package name.' }],
        submit: { facts: [{ value: { kind: 'unpublish', date: '2016-03', summary: 'npm reports that the package was unpublished by its author during a dispute over a package name.' }, source_url: 'https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm', quote: 'Earlier this week, many npm users suffered a disruption when a package that many projects depend on — directly or indirectly — was unpublished by its author, as part of a dispute over a package name.', confidence_note: 'adversarial' }] },
      },
    ],
  },
  {
    id: 'adv-off-domain',
    attempt: { kind: 'adversarial', what: 'off-domain source: a real Wikipedia sentence about the 2021 Elasticsearch relicensing', correct: 'reject' },
    request: {
      task: 'lifecycle_events',
      subject: 'pkg:maven/org.elasticsearch/elasticsearch',
      subjectKind: 'package',
      question: 'Our collectors report that the declared licence changed between releases. Find the project\'s own announcement and its date.',
      context: { name: 'Elasticsearch', ecosystem: 'maven', packageName: 'org.elasticsearch:elasticsearch', repoUrl: 'https://github.com/elastic/elasticsearch', homepage: 'https://www.elastic.co/elasticsearch', domains: ['www.elastic.co'] },
    },
    turns: [
      {
        text: 'Adversarial: Wikipedia is not an evidence domain for this task.',
        fetches: [{ url: 'https://en.wikipedia.org/wiki/Elasticsearch', retrievedAt: T('20:22:42'), excerpt: 'In January 2021, Elastic announced that starting with version 7.11, Elasticsearch and Kibana would be relicensed from Apache License 2.0 to a dual license under the Server Side Public License and the Elastic License' }],
        submit: {
          facts: [
            {
              value: { event: 'relicensing', date: '2021-01', summary: 'Elasticsearch and Kibana were relicensed from Apache 2.0 to SSPL and the Elastic License starting with version 7.11.', licenseFrom: ['Apache-2.0'], licenseTo: ['SSPL-1.0'] },
              source_url: 'https://en.wikipedia.org/wiki/Elasticsearch',
              quote: 'In January 2021, Elastic announced that starting with version 7.11, Elasticsearch and Kibana would be relicensed from Apache License 2.0 to a dual license under the Server Side Public License and the Elastic License',
              confidence_note: 'adversarial',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'probe-wrong-date',
    attempt: { kind: 'probe', what: 'wrong date: the Redis AGPL announcement (May 01, 2025) proposed with date 2024-05-01, real quote', correct: 'reject' },
    request: {
      task: 'lifecycle_events',
      subject: 'pkg:github/redis/redis',
      subjectKind: 'package',
      question: 'Our collectors report that the declared licence changed between releases. Find the project\'s own announcement and its date.',
      context: { name: 'Redis', repoUrl: 'https://github.com/redis/redis', homepage: 'https://redis.io', domains: ['redis.io'] },
    },
    turns: [
      {
        text: 'Probe: the date is a year off.',
        fetches: [{ url: 'https://redis.io/blog/agplv3/', retrievedAt: T('20:22:08'), excerpt: 'May 01, 2025' }],
        submit: { facts: [{ value: { event: 'relicensing', date: '2024-05-01', summary: 'Redis announced AGPL as an additional licence option starting with Redis 8.', licenseTo: ['AGPL-3.0'] }, source_url: 'https://redis.io/blog/agplv3/', quote: 'Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now)', confidence_note: 'probe' }] },
      },
    ],
  },
  {
    id: 'probe-js-rendered',
    attempt: { kind: 'probe', what: 'JS-rendered page: the true NVD description of CVE-2024-3094 cited on the NVD detail page (which redirects to a lower-case URL and renders its text with JavaScript)', correct: 'accept' },
    request: {
      task: 'incident_writeups',
      subject: 'pkg:github/tukaani-project/xz',
      subjectKind: 'package',
      question: INCIDENT_Q,
      context: { name: 'xz-utils', repoUrl: 'https://github.com/tukaani-project/xz' },
    },
    turns: [
      {
        text: 'Probe: the human-facing NVD page.',
        fetches: [{ url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-3094', retrievedAt: T('20:22:43'), excerpt: '(page body is rendered by JavaScript)' }],
        submit: { facts: [{ value: { kind: 'compromise', summary: 'NVD describes code in the upstream xz tarballs, starting with version 5.6.0, that modifies the liblzma library.', advisoryIds: ['CVE-2024-3094'] }, source_url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-3094', quote: 'Malicious code was discovered in the upstream tarballs of xz, starting with version 5.6.0.', confidence_note: 'probe' }] },
      },
    ],
  },
];
