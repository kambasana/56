/**
 * Real public pages recorded for the agentic verification gate (docs/WHO-BEHIND-PLAN.md §10
 * "Agentic gap-filler"). `segments` are [start, end] text markers in the cleaned HTML; the recorder
 * keeps only those parts. `real` quotes are copied from the live page as a reader sees it and must
 * pass the gate; `fabricated` quotes are plausible statements that are NOT on the page and must be
 * rejected.
 */
export interface RecordedPage {
  name: string;
  url: string;
  segments: [string, string][];
  /** Task the page is evidence for. */
  task: string;
  real: string[];
  fabricated: string[];
}

export const PAGES: RecordedPage[] = [
  {
    name: 'oc-babel',
    url: 'https://opencollective.com/babel',
    task: 'funding',
    // Header (fiscal host) and the organisations list; the "Individuals" list is cut (plan: organisation funders only).
    segments: [
      ['<span>Fiscal Host</span>', 'future of JavaScript</h2>'],
      ['<h2>Top financial contributors</h2>', '<p>Individuals</p>'],
    ],
    real: ['Fiscal Host: Open Source Collective', 'Airbnb $217,858 USD since Apr 2018', 'Sovereign Tech Agency $207,511.35 USD since May 2025'],
    fabricated: ['Fiscal Host: Linux Foundation', 'Babel is funded entirely by Google', 'Airbnb $2,178,580 USD since Apr 2018'],
  },
  {
    name: 'oc-webpack',
    url: 'https://opencollective.com/webpack',
    task: 'funding',
    segments: [
      ['<span>Fiscal Host</span>', 'modern web applications.'],
      ['<h2>Top financial contributors</h2>', '<p>Individuals</p>'],
    ],
    real: ['Fiscal Host: Open Source Collective', 'trivago $389,985 USD since Aug 2017'],
    fabricated: ['webpack is sponsored by Microsoft as its only funder'],
  },
  {
    name: 'oc-fakerjs',
    url: 'https://opencollective.com/fakerjs',
    task: 'funding',
    segments: [
      ['<span>Fiscal Host</span>', 'fake data solution available.'],
      ['<h2>Top financial contributors</h2>', '<p>Individuals</p>'],
    ],
    real: ['Fiscal Host: Open Source Collective', 'Indeed $29,000 USD since Feb 2021'],
    fabricated: ['Indeed $290,000 USD since Feb 2021'],
  },
  {
    name: 'moment-docs',
    url: 'https://momentjs.com/docs/',
    task: 'lifecycle_events',
    segments: [['Project status', 'Read the latest update']],
    real: ['Moment.js is a legacy project in maintenance mode.'],
    fabricated: ['Moment.js has reached end-of-life and the repository is archived.'],
  },
  {
    name: 'redis-agpl',
    url: 'https://redis.io/blog/agplv3/',
    task: 'lifecycle_events',
    segments: [['Back to blog', 'with its new capabilities and with AGPL']],
    real: [
      'Adding the OSI-approved AGPL as an additional licensing option for Redis, starting with Redis 8 (available now)',
      'in March 2024, we decided to move Redis to the SSPL license',
    ],
    fabricated: ['Redis 8 is released under the MIT license', 'Redis returns to the BSD-3-Clause license with Redis 8'],
  },
  {
    name: 'redis-2024',
    url: 'https://redis.io/blog/redis-adopts-dual-source-available-licensing/',
    task: 'lifecycle_events',
    segments: [['Back to blog', 'Berkeley Software Distribution (BSD).']],
    real: ['Starting with Redis 7.4, Redis will be dual-licensed under the Redis Source Available License (RSALv2) and Server Side Public License (SSPLv1).'],
    fabricated: ['Starting with Redis 7.2, Redis will be licensed under the AGPLv3.'],
  },
  {
    name: 'elastic-oss',
    url: 'https://www.elastic.co/blog/elasticsearch-is-open-source-again',
    task: 'lifecycle_events',
    segments: [['The tl;dr is that', 'removes any questions']],
    real: ['The tl;dr is that we will be adding AGPL as another license option next to ELv2 and SSPL in the coming weeks.'],
    fabricated: ['we will be removing SSPL and ELv2 and use only the Apache 2.0 license'],
  },
  {
    name: 'elastic-2021',
    url: 'https://www.elastic.co/blog/licensing-change',
    task: 'lifecycle_events',
    segments: [['Upcoming licensing changes to Elasticsearch and Kibana', 'collaborate on the code.']],
    real: ['We are moving our Apache 2.0-licensed source code in Elasticsearch and Kibana to be dual licensed under Server Side Public License (SSPL) and the Elastic License'],
    fabricated: ['We are moving Elasticsearch and Kibana to the GPL-3.0 license'],
  },
  {
    name: 'osc-home',
    url: 'https://www.oscollective.org/',
    task: 'org_jurisdiction',
    segments: [['As a 501(c)(6) nonprofit fiscal host', 'thousands of open source projects.'], ['We’re a 501(c)(6) non-profit registered in the USA', 'EIN 82-2037583']],
    real: ["We're a 501(c)(6) non-profit registered in the USA. EIN 82-2037583"],
    fabricated: ['Open Source Collective is registered in the United Kingdom'],
  },
  {
    name: 'edgar-elastic',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001707753&type=10-K&dateb=&owner=include&count=40',
    task: 'org_jurisdiction',
    segments: [['Elastic N.V.', 'Fiscal Year End: 0430']],
    real: ['State location: CA | Fiscal Year End: 0430'],
    fabricated: ['State location: NY | Fiscal Year End: 0430'],
  },
  {
    name: 'openjsf-projects',
    url: 'https://openjsf.org/projects',
    task: 'governance',
    segments: [['<h3>Express</h3>', 'web and mobile applications.']],
    real: ['Express is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.'],
    fabricated: ['Express is owned and operated by Google LLC.'],
  },
  {
    name: 'openwall-xz',
    url: 'https://www.openwall.com/lists/oss-security/2024/03/29/4',
    task: 'incident_writeups',
    // Subject line and the opening finding only; the mail headers (sender address) are cut.
    segments: [['Subject: backdoor in upstream xz/liblzma', 'have been backdoored.']],
    real: ['The upstream xz repository and the xz tarballs have been backdoored.'],
    fabricated: ['The xz maintainers have confirmed that no release was affected.'],
  },
  {
    name: 'npm-leftpad',
    url: 'https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm',
    task: 'incident_writeups',
    segments: [['kik, left-pad, and npm', 'over a package name.']],
    real: ['a package that many projects depend on — directly or indirectly — was unpublished by its author, as part of a dispute over a package name.'],
    fabricated: ['left-pad was removed by npm because it contained malware.'],
  },
  {
    // Recorded to show a blocked source: GitHub issue pages answer 403 to this environment.
    name: 'github-event-stream-116',
    url: 'https://github.com/dominictarr/event-stream/issues/116',
    task: 'incident_writeups',
    segments: [],
    real: [],
    fabricated: ['I have published a malicious version of event-stream'],
  },
];
