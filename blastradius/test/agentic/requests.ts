/** Fact requests used by the agentic tests and the dev seed (one per stubbed conversation). */
import type { FactRequest } from '../../src/agentic/index.js';

export const REQUESTS: Record<string, FactRequest> = {
  babel: { task: 'funding', subject: 'pkg:npm/@babel/core', subjectKind: 'package', question: 'Which channels and organisations fund this project?', context: { name: 'Babel', ecosystem: 'npm', packageName: '@babel/core' } },
  webpack: { task: 'funding', subject: 'pkg:npm/webpack', subjectKind: 'package', question: 'Which channels and organisations fund this project?', context: { name: 'webpack' } },
  moment: { task: 'lifecycle_events', subject: 'pkg:npm/moment', subjectKind: 'package', question: 'Has the project announced maintenance mode, deprecation or end of life?', context: { name: 'moment', homepage: 'https://momentjs.com', domains: ['momentjs.com'] } },
  leftpadIncident: { task: 'incident_writeups', subject: 'pkg:npm/left-pad', subjectKind: 'package', question: 'Is there a public write-up of a compromise, sabotage or unpublish affecting this package?', context: { name: 'left-pad' } },
  leftpadLifecycle: { task: 'lifecycle_events', subject: 'pkg:npm/left-pad', subjectKind: 'package', question: 'npm marks the latest version deprecated; is there an announcement?', context: { name: 'left-pad' } },
  express: { task: 'governance', subject: 'pkg:npm/express', subjectKind: 'package', question: 'Which organisation or foundation governs this project?', context: { name: 'Express' } },
  expressIncident: { task: 'incident_writeups', subject: 'pkg:npm/express', subjectKind: 'package', question: 'Is there a public write-up of a compromise affecting this package?', context: { name: 'Express' } },
  osc: { task: 'org_jurisdiction', subject: 'funder:opencollective/opensource', subjectKind: 'org', question: 'In which country is this organisation registered?', context: { name: 'Open Source Collective', domains: ['oscollective.org'] } },
  elastic: { task: 'org_jurisdiction', subject: 'org:github/elastic', subjectKind: 'org', question: 'In which country is this organisation registered?', context: { name: 'Elastic N.V.' } },
  person: { task: 'person_self_declared_location', subject: 'person:github/synthetic--profile', subjectKind: 'person', question: 'What location did this person write on their own public profile?', context: { profileUrl: 'https://github.com/synthetic--profile' } },
};
