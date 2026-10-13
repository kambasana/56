/**
 * Task specs: one per fact type. The pipeline is the same for all of them; a spec says what to
 * ask, which tools the agent may use, which source domains count as evidence, the value schema,
 * and the task's own deterministic rules (value ↔ quote consistency). New fact types are added by
 * registering a spec (`TaskRegistry.register`), which runs the privacy registration checks.
 */
import { z } from 'zod';
import type { AgentJson, AgentSubjectKind } from '../core/agentic-types.js';
import { findJudgementWord } from '../incidents/schema.js';
import { dateProblem } from './dates.js';
import { foldText, looksLikeHtml } from './normalize.js';
import { assertTaskSpecAllowed, CONTRIBUTOR_IDENTITY_TASK, PERSON_LOCATION_TASK } from './privacy.js';

/** Client tools the pipeline implements, plus Anthropic's server-side web tools. */
export const AGENT_TOOL_NAMES = [
  'collected_facts',
  'npm_package',
  'pypi_package',
  'depsdev_project',
  'osv_query',
  'opencollective_account',
  'github_user',
  'registry_fetch',
  'web_search',
  'web_fetch',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface RequestContext {
  /** Display name of the package or organisation. */
  name?: string;
  /** For packages: registry coordinates. */
  ecosystem?: 'npm' | 'pypi' | string;
  packageName?: string;
  repoUrl?: string;
  homepage?: string;
  /**
   * Domains our deterministic collectors associate with the subject (package homepage, the org's
   * site). They are allowed evidence domains for the tasks that accept context domains.
   */
  domains?: string[];
  /** Person subjects only: the person's own public profile URL. */
  profileUrl?: string;
  /** Facts already known, as short lines, for the prompt. */
  known?: string[];
}

/** A typed fact request. */
export interface FactRequest {
  task: string;
  /** Unversioned purl ("pkg:npm/babel"), or an entity id ("org:github/expressjs", "person:github/<login>"). */
  subject: string;
  subjectKind: AgentSubjectKind;
  question: string;
  context?: RequestContext;
}

/** What a task's own rules see: the proposal, the request and the re-fetched page. */
export interface TaskRuleInput<V> {
  value: V;
  quote: string;
  sourceUrl: URL;
  request: FactRequest;
  /** Normalised text of the re-fetched source (pageText()). */
  page: string;
  /** The re-fetched body as served (HTML, JSON or text): page metadata such as publication dates. */
  body: string;
  /**
   * Mark a field of the value as not verifiable from the source (kept, shown as unverified). The
   * proposal still passes; use a problem instead when the source contradicts the field.
   */
  flag: (field: string, reason: string) => void;
}

export interface TaskSpec<V extends AgentJson = AgentJson> {
  id: string;
  /** Bump when the prompt or schema changes: part of the result-cache key. */
  version: number;
  title: string;
  subjectKinds: readonly AgentSubjectKind[];
  /** True only for the self-declared location task (enforced at registration). */
  personLevel: boolean;
  /** `pending_confirmation`: verified values still wait for a human before any use. */
  storage: 'fact' | 'pending_confirmation';
  label?: 'self-declared';
  /** Task prompt (the pipeline adds the guardrails and the output contract). */
  instructions: string;
  tools: readonly AgentToolName[];
  /** Evidence domains (a host matches itself and its subdomains). */
  domains: readonly string[];
  /** Also accept the request's context domains (homepage, the org's own site). */
  contextDomains: boolean;
  /** Strict value schema. */
  schema: z.ZodType<V>;
  /** Most facts one run may propose. */
  maxFacts: number;
  /** Deterministic value ↔ source rules. Returns problems (empty = pass). */
  rules?: (input: TaskRuleInput<V>) => string[];
}

const FOUNDATIONS: Readonly<Record<string, string>> = {
  'openjsf.org': 'OpenJS Foundation',
  'apache.org': 'Apache Software Foundation',
  'linuxfoundation.org': 'Linux Foundation',
  'cncf.io': 'Cloud Native Computing Foundation',
  'eclipse.org': 'Eclipse Foundation',
  'python.org': 'Python Software Foundation',
  'numfocus.org': 'NumFOCUS',
  'sovereign.tech': 'Sovereign Tech Agency',
  'opencollective.com': 'Open Collective',
  'oscollective.org': 'Open Source Collective',
};

/** Host matches a domain list entry (itself or a subdomain). */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\*\./, '');
  return h === d || h.endsWith(`.${d}`);
}

function foundationFor(host: string): string | undefined {
  for (const [d, name] of Object.entries(FOUNDATIONS)) if (hostMatches(host, d)) return name;
  return undefined;
}

/** The text must be in the quote (normalised); returns a problem or null. */
function quoteHas(quote: string, text: string, what: string): string | null {
  return foldText(quote).includes(foldText(text)) ? null : `${what} "${text}" is not in the quote`;
}

function neutral(text: string, what: string): string | null {
  const w = findJudgementWord(text);
  return w ? `${what} uses the judgement word "${w}"` : null;
}

/**
 * Names a source may use for a package subject (folded): the display and package name, the npm
 * scope, and the repository owner and name. Names shorter than three characters are skipped.
 */
export function subjectNames(req: FactRequest): string[] {
  const c = req.context ?? {};
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    const f = s ? foldText(s) : '';
    if (f.length >= 3) out.add(f);
  };
  add(c.name);
  add(c.packageName);
  add(/^@([^/]+)\//.exec(c.packageName ?? c.name ?? '')?.[1]);
  const repo = /(?:github\.com|gitlab\.com)[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(c.repoUrl ?? '');
  if (repo) {
    add(repo[1]);
    add(repo[2]);
  }
  return [...out];
}

/**
 * The source must be about the subject: a real line from another project's page (another collective
 * on Open Collective, another package's README or incident post) otherwise passes every other check.
 * Returns a problem, or null when the page or the URL path names the subject (or no name is known).
 */
function sourceNamesSubject(request: FactRequest, page: string, sourceUrl: URL): string | null {
  const names = subjectNames(request);
  if (names.length === 0) return null;
  let path = sourceUrl.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return names.some((n) => page.includes(n) || foldText(path).includes(n)) ? null : `the source does not name the project (${names.join(', ')})`;
}

/** A lifecycle or incident date must be stated by the source near the quote or in its metadata (dates.ts). */
function factDateProblem(date: string | undefined, input: { quote: string; sourceUrl: URL; page: string; body: string }): string | null {
  return date ? dateProblem(date, { ...input, isHtml: looksLikeHtml(input.body) }) : null;
}

const isoDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'YYYY, YYYY-MM or YYYY-MM-DD');
const shortText = z.string().min(1).max(300);

// ---------------------------------------------------------------------------
// funding (P4: F1, F4)
// ---------------------------------------------------------------------------

const fundingSchema = z
  .object({
    kind: z.enum(['open_collective', 'github_sponsors', 'tidelift', 'thanks_dev', 'funding_json', 'corporate_backer', 'foundation', 'public_agency', 'fiscal_host', 'other']),
    /** Organisation named by the source (funder, foundation, fiscal host). Never a private individual. */
    organization: z.string().min(1).max(200).optional(),
    url: z.string().url().max(500).optional(),
    amount: z.object({ value: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/), since: z.string().max(20).optional() }).strict().optional(),
  })
  .strict();
type FundingValue = z.infer<typeof fundingSchema>;

/** Backer kinds whose type is checked against deterministic evidence. */
type BackerKind = 'corporate_backer' | 'foundation' | 'public_agency' | 'fiscal_host';

/**
 * Government bodies and public agencies that fund open source (folded names). A public agency is
 * never a corporate backer, whatever its name says ("National Science Foundation" is one too).
 */
export const PUBLIC_AGENCIES: readonly string[] = [
  'sovereign tech agency', 'sovereign tech fund', 'sprind', 'bundesagentur für sprunginnovationen', 'national science foundation', 'darpa',
  'cisa', 'cybersecurity and infrastructure security agency', 'european commission', 'next generation internet', 'ngi zero',
  'federal ministry of education and research', 'bmbf', 'uk research and innovation', 'ukri', 'agence nationale de la recherche',
];

/** Fiscal hosts and fiscal sponsors of open source projects (folded names). */
export const FISCAL_HOSTS: readonly string[] = [
  'open source collective', 'open collective foundation', 'open collective europe', 'opencollective europe', 'software freedom conservancy',
  'numfocus', 'software in the public interest', 'the commons conservancy', 'open source japan', 'allforclimate',
];

/** Payment platforms that list as an "organisation" but pass on other people's money. */
const FUNDING_PLATFORMS: readonly string[] = ['github sponsors', 'open collective', 'opencollective', 'tidelift', 'thanks.dev', 'polar', 'patreon', 'liberapay'];

const LEGAL_FORM = /(?:^|[\s,])(inc|llc|ltd|limited|gmbh|corp|corporation|plc|co|s\.a|n\.v|b\.v|ag|sarl|s\.r\.l|oy|ab|pty|kk|k\.k)\.?$/;
const GOVERNMENT_WORDS = /\b(government|ministry|ministerium|federal agency|public agency|department of|bundes\w*)\b/;

interface KindEvidence {
  /** `individual`: a person's account. Never a backer kind we store (organisation funders only). */
  kind: BackerKind | 'individual';
  /** Strong evidence (a list, a legal form, the source's wording) contradicts another kind; weak only supports. */
  strong: boolean;
  why: string;
}

/**
 * What deterministic evidence says the organisation is: the known public agency and fiscal host
 * lists, the name (legal form, "Foundation"), the quote ("Fiscal Host: …", "government"), and
 * the Open Collective page (listed under Organizations, i.e. an ORGANIZATION account). Null when
 * nothing says.
 */
export function backerKindEvidence(organization: string, quote: string, page: string, sourceUrl: URL): KindEvidence | null {
  const org = foldText(organization).replace(/^the /, '');
  const q = foldText(quote);
  const listed = (list: readonly string[]) => list.some((n) => org === n || org === `the ${n}` || org.startsWith(`${n} (`));
  if (listed(PUBLIC_AGENCIES)) return { kind: 'public_agency', strong: true, why: 'known public funders list' };
  if (listed(FISCAL_HOSTS)) return { kind: 'fiscal_host', strong: true, why: 'known fiscal hosts list' };
  if (q.includes(`fiscal host: ${org}`) || q.includes(`fiscal host ${org}`) || q.includes(`fiscally hosted by ${org}`)) return { kind: 'fiscal_host', strong: true, why: 'the quote names it as fiscal host' };
  if (GOVERNMENT_WORDS.test(org)) return { kind: 'public_agency', strong: true, why: 'the name is a government body' };
  if (Object.values(FOUNDATIONS).some((n) => foldText(n) === org) || /\b(foundation|stiftung|fondation|fundación|fundacion|fondazione)\b/.test(org)) return { kind: 'foundation', strong: true, why: 'the name is a foundation' };
  if (LEGAL_FORM.test(org)) return { kind: 'corporate_backer', strong: true, why: 'the name has a company legal form' };
  if (GOVERNMENT_WORDS.test(q)) return { kind: 'public_agency', strong: false, why: 'the quote names a government body' };
  if (listed(FUNDING_PLATFORMS)) return null;
  if (hostMatches(sourceUrl.hostname, 'opencollective.com')) {
    // "Top financial contributors · Organizations · 1 Airbnb …" up to "Individuals".
    const top = page.indexOf('top financial contributors');
    const start = top >= 0 ? page.indexOf('organizations', top) : -1;
    if (start >= 0) {
      const end = page.indexOf(' individuals', start);
      const section = page.slice(start, end > start ? end : undefined);
      const row = new RegExp(`(^|\\s)\\d+ ${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\$`);
      if (row.test(section)) return { kind: 'corporate_backer', strong: false, why: 'listed under Organizations on Open Collective (an organisation account) and not a known foundation, fiscal host or public agency' };
      if (end > start && row.test(page.slice(end))) return { kind: 'individual', strong: true, why: 'listed under Individuals on Open Collective' };
    }
  }
  return null;
}

const FUNDING: TaskSpec<FundingValue> = {
  id: 'funding',
  version: 2,
  title: 'Funding channels and backers',
  subjectKinds: ['package'],
  personLevel: false,
  storage: 'fact',
  instructions: [
    'Task: find how this open source project is funded and which organisations back it.',
    'Look for: a funding.json manifest (FLOSS/fund), a GitHub Sponsors page, the Open Collective page (fiscal host, top organisational contributors), Tidelift, thanks.dev, corporate backers named by the project, and foundation membership.',
    'Use collected_facts first (the scan may already know funding links), then the registry and collector tools, and only then the web tools.',
    'Propose one fact per channel or backer. "organization" must be an organisation exactly as the source names it; never propose individual people who donate. For an amount, copy the number and currency the source shows and quote the line that has it.',
    'Backer kind: corporate_backer for a company, foundation for a private or non-profit foundation, public_agency for a government body or public agency (e.g. Sovereign Tech Agency), fiscal_host for the fiscal host or sponsor. The kind is checked against known lists and the source; when unsure, use "other".',
  ].join('\n'),
  tools: ['collected_facts', 'npm_package', 'pypi_package', 'depsdev_project', 'opencollective_account', 'registry_fetch', 'web_search', 'web_fetch'],
  domains: ['opencollective.com', 'github.com', 'raw.githubusercontent.com', 'tidelift.com', 'thanks.dev', 'floss.fund', 'polar.sh', ...Object.keys(FOUNDATIONS)],
  contextDomains: true,
  schema: fundingSchema,
  maxFacts: 12,
  rules: ({ value, quote, sourceUrl, request, page, flag }) => {
    const problems: string[] = [];
    const off = sourceNamesSubject(request, page, sourceUrl);
    if (off) problems.push(off);
    if (value.organization) {
      const p = quoteHas(quote, value.organization, 'organisation');
      if (p) problems.push(p);
    }
    const backer = (['corporate_backer', 'foundation', 'public_agency', 'fiscal_host'] as const).find((k) => k === value.kind);
    if (backer) {
      const ev = value.organization ? backerKindEvidence(value.organization, quote, page, sourceUrl) : null;
      if (ev && ev.kind !== backer && ev.strong) problems.push(`${value.organization} is a ${ev.kind.replace(/_/g, ' ')} (${ev.why}), not a ${backer.replace(/_/g, ' ')}`);
      else if (!ev || ev.kind !== backer) flag('kind', ev ? `${backer.replace(/_/g, ' ')} not confirmed: ${ev.why} suggests ${ev.kind.replace(/_/g, ' ')}` : `no deterministic evidence that ${value.organization ?? 'the backer'} is a ${backer.replace(/_/g, ' ')}`);
    }
    if (value.amount?.since) {
      const p = quoteHas(quote, value.amount.since, 'since');
      if (p) problems.push(p);
    }
    if (value.amount) {
      const digits = foldText(quote).replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[^0-9.]/g, ' ');
      const n = value.amount.value;
      const forms = [String(n), n.toFixed(2)];
      if (!forms.some((f) => digits.split(/\s+/).some((t) => t.replace(/\.$/, '') === f || t === f))) problems.push(`amount ${n} is not in the quote`);
      if (!foldText(quote).includes(value.amount.currency.toLowerCase())) problems.push(`currency ${value.amount.currency} is not in the quote`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// governance (P4 F4b; who owns the project)
// ---------------------------------------------------------------------------

const governanceSchema = z
  .object({
    kind: z.enum(['foundation_member', 'governance_doc', 'owner_organization', 'fiscal_host']),
    organization: z.string().min(1).max(200),
    summary: shortText.optional(),
  })
  .strict();
type GovernanceValue = z.infer<typeof governanceSchema>;

const GOVERNANCE: TaskSpec<GovernanceValue> = {
  id: 'governance',
  version: 1,
  title: 'Foundation membership and governance',
  subjectKinds: ['package', 'org'],
  personLevel: false,
  storage: 'fact',
  instructions: [
    'Task: find which organisation owns or governs this project: foundation membership (OpenJS, Apache, Linux Foundation, CNCF, Eclipse, PSF, NumFOCUS), a governance document, or the owning company.',
    'Foundation membership counts only when the foundation\'s own site lists the project; quote the line that names the project.',
    'Use collected_facts first; then the web tools.',
  ].join('\n'),
  tools: ['collected_facts', 'npm_package', 'pypi_package', 'depsdev_project', 'registry_fetch', 'web_search', 'web_fetch'],
  domains: ['github.com', 'raw.githubusercontent.com', ...Object.keys(FOUNDATIONS)],
  contextDomains: true,
  schema: governanceSchema,
  maxFacts: 4,
  rules: ({ value, quote, sourceUrl, request, page }) => {
    const problems: string[] = [];
    if (value.kind === 'foundation_member') {
      const foundation = foundationFor(sourceUrl.hostname);
      if (!foundation) problems.push(`foundation membership needs the foundation's own site; ${sourceUrl.hostname} is not one`);
      else if (foldText(foundation) !== foldText(value.organization)) problems.push(`the source is ${foundation}'s site, not "${value.organization}"`);
      const name = request.context?.name;
      if (name && !foldText(quote).includes(foldText(name))) problems.push(`the quote does not name the project "${name}"`);
    } else if (!page.includes(foldText(value.organization)) && !foldText(quote).includes(foldText(value.organization))) {
      problems.push(`organisation "${value.organization}" is not on the source page`);
    }
    if (value.summary) {
      const p = neutral(value.summary, 'summary');
      if (p) problems.push(p);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// org_jurisdiction (P7 C4/C5): public registries only, always pending human confirmation
// ---------------------------------------------------------------------------

const REGISTRY_HOSTS: Readonly<Record<string, readonly string[]>> = {
  companies_house: ['find-and-update.company-information.service.gov.uk', 'company-information.service.gov.uk'],
  opencorporates: ['opencorporates.com'],
  sec_edgar: ['sec.gov'],
  foundation_filing: ['projects.propublica.org', 'apps.irs.gov', 'register-of-charities.charitycommission.gov.uk'],
};
/**
 * Registry hosts whose records are about one country only. A record may still name another country
 * (a foreign registrant filing with the SEC states "The Netherlands … (State or other jurisdiction of
 * incorporation)"); that country is accepted only when the quote names it.
 */
const REGISTRY_HOST_COUNTRY: Readonly<Record<string, string>> = {
  'company-information.service.gov.uk': 'GB',
  'sec.gov': 'US',
  'projects.propublica.org': 'US',
  'apps.irs.gov': 'US',
  'register-of-charities.charitycommission.gov.uk': 'GB',
};

function registryCountry(host: string): string | undefined {
  for (const [d, c] of Object.entries(REGISTRY_HOST_COUNTRY)) if (hostMatches(host, d)) return c;
  return undefined;
}
/** Names and abbreviations a source may use for a country (ISO 3166-1 alpha-2 → spellings). */
const COUNTRY_NAMES: Readonly<Record<string, readonly string[]>> = {
  US: ['united states', 'usa', 'u.s.a', 'u.s.', 'united states of america'],
  GB: ['united kingdom', 'england', 'wales', 'scotland', 'great britain', 'uk'],
  NL: ['netherlands', 'the netherlands'],
  DE: ['germany', 'deutschland'],
  FR: ['france'],
  CA: ['canada'],
  CH: ['switzerland'],
  IE: ['ireland'],
  BE: ['belgium'],
  SE: ['sweden'],
  JP: ['japan'],
  CN: ['china', "people's republic of china"],
  RU: ['russia', 'russian federation'],
  IN: ['india'],
  IL: ['israel'],
  AU: ['australia'],
  SG: ['singapore'],
};

const jurisdictionSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'),
    region: z.string().min(1).max(60).optional(),
    basis: z.enum(['registered_office', 'incorporation', 'business_address', 'tax_registration']),
    registry: z.enum(['companies_house', 'opencorporates', 'sec_edgar', 'foundation_filing', 'org_legal_page']),
    identifier: z.string().min(1).max(60).optional(),
  })
  .strict();
type JurisdictionValue = z.infer<typeof jurisdictionSchema>;

const ORG_JURISDICTION: TaskSpec<JurisdictionValue> = {
  id: 'org_jurisdiction',
  version: 1,
  title: 'Organisation jurisdiction (public registries)',
  subjectKinds: ['org'],
  personLevel: false,
  storage: 'pending_confirmation',
  instructions: [
    'Task: find the country an ORGANISATION (company, foundation, fiscal host) is registered or incorporated in, from public records only:',
    'UK Companies House, OpenCorporates, SEC EDGAR, foundation or charity filings (ProPublica Nonprofit Explorer, IRS, Charity Commission), or the organisation\'s own legal or imprint page.',
    'Never use where its staff or contributors appear to be. Quote the registry line that states the country, state, or registration (with the registration number when the record shows one).',
    'The value is proposed for a human to confirm; it is not used until then.',
  ].join('\n'),
  tools: ['collected_facts', 'web_search', 'web_fetch'],
  domains: Object.values(REGISTRY_HOSTS).flat(),
  contextDomains: true,
  schema: jurisdictionSchema,
  maxFacts: 2,
  rules: ({ value, quote, sourceUrl, request }) => {
    const problems: string[] = [];
    const host = sourceUrl.hostname;
    if (value.registry === 'org_legal_page') {
      const own = (request.context?.domains ?? []).some((d) => hostMatches(host, d));
      if (!own) problems.push(`"org_legal_page" must be on the organisation's own domain; ${host} is not`);
    } else if (!(REGISTRY_HOSTS[value.registry] ?? []).some((d) => hostMatches(host, d))) {
      problems.push(`registry "${value.registry}" does not match the source host ${host}`);
    }
    const q = ` ${foldText(quote).replace(/[^a-z0-9.' ]/g, ' ')} `;
    const implied = value.registry === 'org_legal_page' ? undefined : registryCountry(host);
    const named = (COUNTRY_NAMES[value.country] ?? []).some((n) => q.includes(` ${n} `) || q.includes(` ${n}.`) || q.includes(` ${n},`));
    if (implied !== undefined && implied !== value.country && !named) problems.push(`${host} records are for ${implied}; the quote does not name ${value.country}`);
    if (implied === undefined && !named) problems.push(`the quote does not name the country ${value.country}`);
    if (value.region && !foldText(quote).includes(foldText(value.region))) problems.push(`region "${value.region}" is not in the quote`);
    if (value.identifier && !foldText(quote).includes(foldText(value.identifier))) problems.push(`identifier "${value.identifier}" is not in the quote`);
    return problems;
  },
};

// ---------------------------------------------------------------------------
// lifecycle_events (P5): relicensing, deprecation, end of life, archival, maintenance mode
// ---------------------------------------------------------------------------

const EVENT_WORDS: Readonly<Record<string, RegExp>> = {
  relicensing: /licen[cs]/,
  deprecation: /deprecat/,
  end_of_life: /end[- ]of[- ]life|\beol\b|no longer (be )?(maintained|supported|developed)|discontinu/,
  archival: /archiv/,
  maintenance_mode: /maintenance mode|maintenance-only|legacy project/,
};

const lifecycleSchema = z
  .object({
    event: z.enum(['relicensing', 'deprecation', 'end_of_life', 'archival', 'maintenance_mode']),
    date: isoDate.optional(),
    summary: shortText,
    licenseFrom: z.array(z.string().min(1).max(80)).max(5).optional(),
    licenseTo: z.array(z.string().min(1).max(80)).max(5).optional(),
  })
  .strict();
type LifecycleValue = z.infer<typeof lifecycleSchema>;

const LIFECYCLE: TaskSpec<LifecycleValue> = {
  id: 'lifecycle_events',
  version: 1,
  title: 'Relicensing, deprecation, end-of-life and archival announcements',
  subjectKinds: ['package'],
  personLevel: false,
  storage: 'fact',
  instructions: [
    'Task: find the project\'s own announcement of a lifecycle event: a licence change, deprecation, end of life, archival, or maintenance mode.',
    'Prefer the project\'s own site, blog, README or registry notice. Give the date the source states. The summary is one neutral, factual sentence (no judgement words).',
  ].join('\n'),
  tools: ['collected_facts', 'npm_package', 'pypi_package', 'depsdev_project', 'registry_fetch', 'web_search', 'web_fetch'],
  domains: ['github.com', 'raw.githubusercontent.com', 'npmjs.com', 'pypi.org'],
  contextDomains: true,
  schema: lifecycleSchema,
  maxFacts: 4,
  rules: ({ value, quote, sourceUrl, request, page, body }) => {
    const problems: string[] = [];
    const off = sourceNamesSubject(request, page, sourceUrl);
    if (off) problems.push(off);
    const d = factDateProblem(value.date, { quote, sourceUrl, page, body });
    if (d) problems.push(d);
    if (!EVENT_WORDS[value.event]!.test(foldText(quote))) problems.push(`the quote does not describe a ${value.event.replace(/_/g, ' ')}`);
    // Licence names in announcements are rarely SPDX ids ("Apache 2.0-licensed", "SSPLv1"): the
    // licence family (leading letters of the id) must be in the quote.
    for (const l of [...(value.licenseFrom ?? []), ...(value.licenseTo ?? [])]) {
      const family = /^[A-Za-z]+/.exec(l)?.[0]?.toLowerCase();
      if (!family || family.length < 3 || !foldText(quote).includes(family)) problems.push(`licence "${l}" is not in the quote`);
    }
    const p = neutral(value.summary, 'summary');
    if (p) problems.push(p);
    return problems;
  },
};

// ---------------------------------------------------------------------------
// incident_writeups (P5): post-mortems and advisories about compromise or sabotage
// ---------------------------------------------------------------------------

const incidentSchema = z
  .object({
    kind: z.enum(['compromise', 'sabotage', 'malicious_release', 'account_takeover', 'unpublish', 'other']),
    date: isoDate.optional(),
    summary: shortText,
    advisoryIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/)).max(10).optional(),
  })
  .strict();
type IncidentValue = z.infer<typeof incidentSchema>;

const INCIDENTS: TaskSpec<IncidentValue> = {
  id: 'incident_writeups',
  version: 1,
  title: 'Public write-ups of compromise or sabotage',
  subjectKinds: ['package'],
  personLevel: false,
  storage: 'fact',
  instructions: [
    'Task: find public post-mortems, advisories or mailing-list reports about a compromise, sabotage, malicious release, account takeover or unpublish affecting this package.',
    'Use osv_query and collected_facts first for advisory ids; then the web tools for the write-up. Summaries are neutral and factual: say what the source reports, with "reported by", never a verdict about a person.',
  ].join('\n'),
  tools: ['collected_facts', 'osv_query', 'npm_package', 'registry_fetch', 'web_search', 'web_fetch'],
  domains: ['github.com', 'osv.dev', 'nvd.nist.gov', 'openwall.com', 'blog.npmjs.org', 'github.blog', 'cve.org', 'cisa.gov', 'lists.debian.org', 'security-tracker.debian.org'],
  contextDomains: true,
  schema: incidentSchema,
  maxFacts: 4,
  rules: ({ value, quote, sourceUrl, request, page, body }) => {
    const problems: string[] = [];
    const off = sourceNamesSubject(request, page, sourceUrl);
    if (off) problems.push(off);
    const d = factDateProblem(value.date, { quote, sourceUrl, page, body });
    if (d) problems.push(d);
    for (const id of value.advisoryIds ?? []) if (!page.includes(id.toLowerCase())) problems.push(`advisory id ${id} is not on the source page`);
    const p = neutral(value.summary, 'summary');
    if (p) problems.push(p);
    return problems;
  },
};

// ---------------------------------------------------------------------------
// person_self_declared_location: the ONLY person-level task
// ---------------------------------------------------------------------------

const personLocationSchema = z.object({ location: z.string().min(1).max(100) }).strict();
type PersonLocationValue = z.infer<typeof personLocationSchema>;

/** Hosts whose public profile pages carry a self-written location field. */
export const PROFILE_HOSTS = ['github.com', 'gitlab.com', 'npmjs.com'] as const;

/** Canonical form of a profile URL for comparison (https, lower-case host, no trailing slash, query or hash). */
export function canonicalProfileUrl(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    return `https://${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

const PERSON_LOCATION: TaskSpec<PersonLocationValue> = {
  id: PERSON_LOCATION_TASK,
  version: 1,
  title: 'Self-declared profile location',
  subjectKinds: ['person'],
  personLevel: true,
  storage: 'fact',
  label: 'self-declared',
  instructions: [
    'Task: copy the location text this person wrote in the location field of their own public profile page, given as profile_url. Only that page counts.',
    'Copy it exactly as written. Do not translate, expand, normalise or map it to anything else. If the field is empty or absent, propose nothing.',
  ].join('\n'),
  tools: ['web_fetch'],
  domains: PROFILE_HOSTS,
  contextDomains: false,
  schema: personLocationSchema,
  // One location is expected; a few submissions are let through so that every one meets the gate.
  maxFacts: 3,
  rules: ({ value, quote, sourceUrl, request, page }) => {
    const problems: string[] = [];
    const own = canonicalProfileUrl(request.context?.profileUrl ?? '');
    if (!own || canonicalProfileUrl(sourceUrl.href) !== own) problems.push('the quote must come from the person\'s own profile page (profile_url), not another page');
    if (!wholeField(quote, page, 'location', value.location)) problems.push('location must be the whole location field exactly as written on the profile');
    return problems;
  },
};

// ---------------------------------------------------------------------------
// contributor_identity: who a contributor is, from what they published (owner scope 2026-10-11)
// ---------------------------------------------------------------------------

/** GitHub REST endpoints about one user (public; a configured token raises the rate limit). */
export function githubUserApiUrls(login: string): string[] {
  const l = encodeURIComponent(login);
  return [`https://api.github.com/users/${l}`, `https://api.github.com/users/${l}/gpg_keys`, `https://api.github.com/users/${l}/ssh_signing_keys`, `https://api.github.com/users/${l}/orgs`];
}

/**
 * True when `text` is a whole published field: the quote is exactly the text (profile page), or the
 * re-fetched API JSON has `"<key>": "<text>"`.
 */
export function wholeField(quote: string, page: string, key: string, text: string): boolean {
  const t = foldText(text);
  return foldText(quote) === t || page.includes(`"${key}": "${t}"`) || page.includes(`"${key}":"${t}"`);
}

/** Profile hosts and foundation/registry sites a role statement may come from. */
const ROLE_DOMAINS = ['github.com', 'gitlab.com', 'npmjs.com', 'raw.githubusercontent.com', ...Object.keys(FOUNDATIONS)];

const identitySchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('account'), login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/), profileUrl: z.string().url(), createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional() }).strict(),
  z.object({ field: z.enum(['display_name', 'company', 'bio']), text: z.string().min(1).max(300) }).strict(),
  z.object({ field: z.literal('website'), url: z.string().url().max(300) }).strict(),
  z.object({ field: z.literal('org_membership'), organization: z.string().min(1).max(100) }).strict(),
  /** Location exactly as the person wrote it; never a country. */
  z.object({ field: z.literal('location'), text: z.string().min(1).max(100) }).strict(),
  z.object({ field: z.literal('role'), role: z.string().min(2).max(120), project: z.string().min(1).max(120) }).strict(),
  z.object({ field: z.literal('signing_key'), keyType: z.enum(['gpg', 'ssh']), keyId: z.string().min(6).max(200) }).strict(),
]);
type IdentityValue = z.infer<typeof identitySchema>;

const CONTRIBUTOR_IDENTITY: TaskSpec<IdentityValue> = {
  id: CONTRIBUTOR_IDENTITY_TASK,
  version: 1,
  title: 'Contributor identity (public profile)',
  subjectKinds: ['person'],
  personLevel: true,
  storage: 'fact',
  instructions: [
    'Task: describe the public account behind a contributor of a repository, using only what the person published.',
    'Use github_user first (the GitHub users API: account, creation date, profile fields, organisations, signing keys); then their own profile page (profile_url); then public pages that name their account for a role (maintainer of a project, member of a foundation, steering or technical committee).',
    'Propose one fact per field: account (login, profile URL, creation date), display_name, company, website, bio, org_membership, location (copied exactly as written: it is shown as self-declared), role (with the project), signing_key (key id).',
    'Copy values exactly as published. Do not translate, expand or interpret them, and do not add anything the person did not write.',
  ].join('\n'),
  tools: ['github_user', 'web_fetch', 'web_search'],
  domains: ['api.github.com', ...ROLE_DOMAINS],
  contextDomains: false,
  schema: identitySchema,
  maxFacts: 16,
  rules: ({ value, quote, sourceUrl, request, page }) => {
    const problems: string[] = [];
    const login = request.subject.replace(/^person:[a-z]+\//, '');
    const own = canonicalProfileUrl(request.context?.profileUrl ?? '');
    const src = canonicalProfileUrl(sourceUrl.href);
    const apiOwn = githubUserApiUrls(login).map((u) => canonicalProfileUrl(u));
    const fromOwn = src !== null && (src === own || apiOwn.includes(src));
    const needQuote = (text: string, what: string) => {
      const p = quoteHas(quote, text, what);
      if (p) problems.push(p);
    };
    if (value.field === 'role') {
      // A role may come from any allowed public page, but that page must name the account.
      if (!page.includes(login.toLowerCase())) problems.push(`the source page does not name the account ${login}`);
      needQuote(value.project, 'project');
      return problems;
    }
    if (!fromOwn) problems.push("profile fields must come from the person's own profile page or the GitHub users API for that login");
    switch (value.field) {
      case 'account':
        if (value.login.toLowerCase() !== login.toLowerCase()) problems.push(`login ${value.login} is not the subject ${login}`);
        if (!page.includes(login.toLowerCase())) problems.push(`the source does not name the account ${login}`);
        if (canonicalProfileUrl(value.profileUrl) !== own) problems.push('profileUrl is not the profile_url of the request');
        if (value.createdAt) needQuote(value.createdAt, 'creation date');
        else needQuote(value.login, 'login');
        break;
      case 'location':
        // The whole field as the person wrote it: never a shortened part (e.g. only the country).
        if (!wholeField(quote, page, 'location', value.text)) problems.push('location must be the whole location field exactly as written on the profile');
        break;
      case 'website':
        needQuote(value.url.replace(/\/$/, ''), 'website');
        break;
      case 'org_membership':
        needQuote(value.organization, 'organisation');
        break;
      case 'signing_key':
        needQuote(value.keyId, 'key id');
        break;
      default:
        needQuote(value.text, value.field.replace(/_/g, ' '));
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class TaskRegistry {
  private readonly specs = new Map<string, TaskSpec>();

  /** Add a task. Runs the privacy registration checks; throws PrivacyRefusal or Error. */
  register<V extends AgentJson>(spec: TaskSpec<V>): this {
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(spec.id)) throw new Error(`invalid task id "${spec.id}"`);
    if (this.specs.has(spec.id)) throw new Error(`task "${spec.id}" is already registered`);
    assertTaskSpecAllowed(spec);
    // A person-level task may search only within its fixed evidence domains (never the open web, never subject-derived domains).
    if (spec.personLevel && spec.tools.includes('web_search') && spec.contextDomains) throw new Error(`task "${spec.id}": person-level tasks may not search the open web for a person`);
    if (spec.personLevel && spec.id === PERSON_LOCATION_TASK && spec.tools.includes('web_search')) throw new Error(`task "${spec.id}": the self-declared location comes from the profile page only and may not search the web`);
    for (const t of spec.tools) if (!(AGENT_TOOL_NAMES as readonly string[]).includes(t)) throw new Error(`task "${spec.id}": unknown tool ${t}`);
    this.specs.set(spec.id, spec as unknown as TaskSpec);
    return this;
  }

  get(id: string): TaskSpec | undefined {
    return this.specs.get(id);
  }

  ids(): string[] {
    return [...this.specs.keys()].sort();
  }
}

/** The six shipped tasks. */
export const BUILTIN_TASKS: readonly TaskSpec[] = [FUNDING, GOVERNANCE, ORG_JURISDICTION, LIFECYCLE, INCIDENTS, PERSON_LOCATION, CONTRIBUTOR_IDENTITY] as unknown as TaskSpec[];

export function defaultTaskRegistry(): TaskRegistry {
  const r = new TaskRegistry();
  for (const s of BUILTIN_TASKS) r.register(s);
  return r;
}
