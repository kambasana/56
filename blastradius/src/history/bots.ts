/**
 * Organisation release bots (Tier 0, teardown problem 3): accounts that publish or tag releases for
 * an organisation's pipeline. They are not a person, so they are never "the single maintainer", never
 * a contributor in the CAF, and a release they make is never "a release by a new person".
 *
 * Each entry names where the account is documented. Matching is on the account name or git author
 * name, case-insensitive, with a trailing "[bot]" ignored.
 */
export interface ReleaseBot {
  account: string;
  /** Where it appears: npm publisher / maintainer account, git author or tagger name, or both. */
  where: 'npm' | 'git' | 'both';
  source: string;
}

export const RELEASE_BOTS: readonly ReleaseBot[] = [
  { account: 'google-wombot', where: 'npm', source: 'https://www.npmjs.com/~google-wombot (publishes the googleapis/google-cloud-node releases cut by release-please)' },
  { account: 'react-bot', where: 'npm', source: 'https://www.npmjs.com/~react-bot (publishes facebook/react releases from CI)' },
  { account: 'yoshi-automation', where: 'git', source: 'https://github.com/yoshi-automation (googleapis repository automation)' },
  { account: 'release-please', where: 'git', source: 'https://github.com/googleapis/release-please (commits and tags as release-please[bot])' },
  { account: 'github-actions', where: 'both', source: 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication (github-actions[bot])' },
  { account: 'GitHub Actions', where: 'npm', source: 'https://docs.npmjs.com/trusted-publishers (npm trusted publishing from GitHub Actions records this _npmUser)' },
  { account: 'semantic-release-bot', where: 'both', source: 'https://github.com/semantic-release/semantic-release/blob/master/docs/usage/configuration.md (default git author semantic-release-bot)' },
  { account: 'renovate', where: 'git', source: 'https://docs.renovatebot.com/ (renovate[bot])' },
  { account: 'renovate-bot', where: 'git', source: 'https://docs.renovatebot.com/ (self-hosted Renovate author)' },
  { account: 'dependabot', where: 'git', source: 'https://docs.github.com/en/code-security/dependabot (dependabot[bot])' },
  { account: 'dependabot-preview', where: 'git', source: 'https://github.com/dependabot (retired dependabot-preview[bot])' },
  { account: 'changeset-bot', where: 'git', source: 'https://github.com/changesets/bot' },
  { account: 'changesets', where: 'git', source: 'https://github.com/changesets/action (release PRs and tags from the changesets action)' },
  { account: 'nodejs-github-bot', where: 'git', source: 'https://github.com/nodejs/github-bot' },
  { account: 'npm-cli-bot', where: 'git', source: 'https://github.com/npm-cli-bot (npm CLI release automation)' },
  { account: 'greenkeeper', where: 'git', source: 'https://github.com/greenkeeperio (greenkeeper[bot], retired)' },
  { account: 'snyk-bot', where: 'git', source: 'https://github.com/snyk-bot' },
  { account: 'allcontributors', where: 'git', source: 'https://allcontributors.org/docs/en/bot/overview (allcontributors[bot])' },
  { account: 'mergify', where: 'git', source: 'https://docs.mergify.com/ (mergify[bot])' },
];

const NAMES = new Set(RELEASE_BOTS.map((b) => b.account.toLowerCase()));

/** Whether an account, login or git author name is an organisation release bot on the list. */
export function isReleaseBot(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\[bot\]$/, '').trim();
  return n.length > 0 && NAMES.has(n);
}
