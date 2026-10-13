/**
 * Response shapes (subsets) for the APIs the GitHub enricher reads. All fields
 * are untrusted and validated before use.
 */
import type { FundingValue, PurlString } from '../../core/types.js';

/** GET https://api.github.com/repos/{owner}/{repo} — https://docs.github.com/en/rest/repos/repos#get-a-repository */
export interface GithubRepoResponse {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  owner?: { login?: unknown; type?: unknown; html_url?: unknown };
  archived?: unknown;
  disabled?: unknown;
  fork?: unknown;
  pushed_at?: unknown;
  default_branch?: unknown;
}

/** POST https://api.opencollective.com/graphql/v2 (account + members query). */
export interface OpenCollectiveResponse {
  data?: {
    account?: {
      slug?: unknown;
      name?: unknown;
      type?: unknown;
      host?: { slug?: unknown; name?: unknown } | null;
      members?: {
        totalCount?: unknown;
        nodes?: {
          role?: unknown;
          account?: { slug?: unknown; name?: unknown; type?: unknown } | null;
          totalDonations?: { valueInCents?: unknown; currency?: unknown } | null;
        }[];
      } | null;
    } | null;
  };
  errors?: { message?: unknown }[];
}

/** A GitHub repo to look up, and the package(s) it is declared for. */
export interface GithubRepoTarget {
  /** Unversioned purl the facts are about (npm package or GitHub Action). */
  subject: PurlString;
  /** Owner / repo as declared (package.json `repository`, or the action reference). */
  owner: string;
  repo: string;
  /** Declared URL, used as evidence. */
  declaredUrl: string;
  /** Open Collective slugs declared by the package (e.g. package.json#funding). */
  openCollectiveSlugs?: string[];
}

/** Funding fact value from Open Collective, with collective context. */
export interface OpenCollectiveFundingValue extends FundingValue {
  via: 'opencollective';
  /** The collective whose backers these are. */
  collective: string;
  /** Fiscal host slug, if any. */
  host?: string;
  /** Total backers/sponsors reported by Open Collective (before filtering). */
  totalBackers?: number;
}
