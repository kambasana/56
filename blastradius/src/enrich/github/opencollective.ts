/**
 * Open Collective GraphQL v2: backers/sponsors of a collective.
 * https://graphql-docs-v2.opencollective.com/
 */
import type { FundingSource } from '../../core/types.js';
import type { OpenCollectiveFundingValue, OpenCollectiveResponse } from './types.js';

export const OPEN_COLLECTIVE_API = 'https://api.opencollective.com/graphql/v2';
export const OC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;

// MemberRole has no SPONSOR value (the live API rejected the whole query with GRAPHQL_VALIDATION_FAILED,
// so every funding lookup failed): sponsors and backers are both BACKER.
export const OPEN_COLLECTIVE_QUERY = `query BlastradiusCollective($slug: String!, $limit: Int!) {
  account(slug: $slug) {
    slug
    name
    type
    ... on AccountWithHost { host { slug name } }
    members(role: [BACKER], limit: $limit) {
      totalCount
      nodes {
        role
        account { slug name type }
        totalDonations { valueInCents currency }
      }
    }
  }
}`;

/** Exact request body sent for a slug (exported so fixtures can be keyed with fixtureKey()). */
export function openCollectiveRequestBody(slug: string, limit = 100): { query: string; variables: { slug: string; limit: number } } {
  if (!OC_SLUG_RE.test(slug)) throw new Error(`Invalid Open Collective slug: ${JSON.stringify(slug.slice(0, 120))}`);
  return { query: OPEN_COLLECTIVE_QUERY, variables: { slug: slug.toLowerCase(), limit } };
}

export interface BackerFilter {
  /** Include INDIVIDUAL accounts (default false: only organisations/collectives, to limit personal data). */
  includeIndividuals?: boolean;
  /** Max backers kept, largest total donations first (default 20). */
  maxBackers?: number;
}

/** Turn an Open Collective response into a funding value; undefined when the collective is unknown. */
export function parseOpenCollective(res: OpenCollectiveResponse, slug: string, filter: BackerFilter = {}): OpenCollectiveFundingValue | undefined {
  const account = res?.data?.account;
  if (!account || typeof account !== 'object') return undefined;
  const collective = typeof account.slug === 'string' && OC_SLUG_RE.test(account.slug) ? account.slug : slug;
  const nodes = Array.isArray(account.members?.nodes) ? account.members.nodes.slice(0, 1000) : [];
  const backers: { source: FundingSource; cents: number }[] = [];
  for (const n of nodes) {
    const a = n?.account;
    if (!a || typeof a.slug !== 'string' || !OC_SLUG_RE.test(a.slug)) continue;
    const type = typeof a.type === 'string' ? a.type : 'UNKNOWN';
    if (type === 'INDIVIDUAL' && !filter.includeIndividuals) continue;
    if (backers.some((b) => b.source.handle === a.slug)) continue;
    const cents = typeof n.totalDonations?.valueInCents === 'number' ? n.totalDonations.valueInCents : 0;
    backers.push({ source: { platform: 'open_collective', handle: a.slug, url: `https://opencollective.com/${a.slug}` }, cents });
  }
  backers.sort((x, y) => y.cents - x.cents || (x.source.handle! < y.source.handle! ? -1 : 1));
  const value: OpenCollectiveFundingValue = {
    sources: backers.slice(0, filter.maxBackers ?? 20).map((b) => b.source),
    via: 'opencollective',
    collective,
  };
  const host = account.host?.slug;
  if (typeof host === 'string' && OC_SLUG_RE.test(host)) value.host = host;
  const total = account.members?.totalCount;
  if (typeof total === 'number' && Number.isFinite(total)) value.totalBackers = total;
  return value;
}
