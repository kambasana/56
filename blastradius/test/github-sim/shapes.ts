/**
 * REST response bodies in GitHub's shapes, filled from simulator state. Every builder here is
 * checked against GitHub's OpenAPI description (@octokit/openapi) by openapi.test.ts.
 */

export interface SimUrls {
  /** REST API base, e.g. http://127.0.0.1:8787/api/v3 (GitHub Enterprise Server layout). */
  api: string;
  /** Web base (install page, OAuth, html_url). */
  web: string;
  /** raw file base: {raw}/{owner}/{repo}/{ref}/{path}. */
  raw: string;
}

export interface SimAccount {
  login: string;
  id: number;
  type: 'User' | 'Organization';
  name: string;
}

export interface SimRepoMeta {
  id: number;
  owner: SimAccount;
  name: string;
  fullName: string;
  private: boolean;
  fork: boolean;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  language: string | null;
  sizeKb: number;
}

export function nodeId(prefix: string, id: number | string): string {
  return Buffer.from(`${prefix}${id}`).toString('base64');
}

export function simpleUser(u: SimAccount, urls: SimUrls) {
  const api = `${urls.api}/users/${u.login}`;
  return {
    login: u.login,
    id: u.id,
    node_id: nodeId(u.type === 'Organization' ? '012:Organization' : '04:User', u.id),
    avatar_url: `${urls.web}/avatars/u/${u.id}?v=4`,
    gravatar_id: '',
    url: api,
    html_url: `${urls.web}/${u.login}`,
    followers_url: `${api}/followers`,
    following_url: `${api}/following{/other_user}`,
    gists_url: `${api}/gists{/gist_id}`,
    starred_url: `${api}/starred{/owner}{/repo}`,
    subscriptions_url: `${api}/subscriptions`,
    organizations_url: `${api}/orgs`,
    repos_url: `${api}/repos`,
    events_url: `${api}/events{/privacy}`,
    received_events_url: `${api}/received_events`,
    type: u.type,
    user_view_type: 'public',
    site_admin: false,
  };
}

/** The `*_url` templates every repository object carries. */
function repoUrls(r: SimRepoMeta, urls: SimUrls) {
  const a = `${urls.api}/repos/${r.fullName}`;
  return {
    url: a,
    forks_url: `${a}/forks`,
    keys_url: `${a}/keys{/key_id}`,
    collaborators_url: `${a}/collaborators{/collaborator}`,
    teams_url: `${a}/teams`,
    hooks_url: `${a}/hooks`,
    issue_events_url: `${a}/issues/events{/number}`,
    events_url: `${a}/events`,
    assignees_url: `${a}/assignees{/user}`,
    branches_url: `${a}/branches{/branch}`,
    tags_url: `${a}/tags`,
    blobs_url: `${a}/git/blobs{/sha}`,
    git_tags_url: `${a}/git/tags{/sha}`,
    git_refs_url: `${a}/git/refs{/sha}`,
    trees_url: `${a}/git/trees{/sha}`,
    statuses_url: `${a}/statuses/{sha}`,
    languages_url: `${a}/languages`,
    stargazers_url: `${a}/stargazers`,
    contributors_url: `${a}/contributors`,
    subscribers_url: `${a}/subscribers`,
    subscription_url: `${a}/subscription`,
    commits_url: `${a}/commits{/sha}`,
    git_commits_url: `${a}/git/commits{/sha}`,
    comments_url: `${a}/comments{/number}`,
    issue_comment_url: `${a}/issues/comments{/number}`,
    contents_url: `${a}/contents/{+path}`,
    compare_url: `${a}/compare/{base}...{head}`,
    merges_url: `${a}/merges`,
    archive_url: `${a}/{archive_format}{/ref}`,
    downloads_url: `${a}/downloads`,
    issues_url: `${a}/issues{/number}`,
    pulls_url: `${a}/pulls{/number}`,
    milestones_url: `${a}/milestones{/number}`,
    notifications_url: `${a}/notifications{?since,all,participating}`,
    labels_url: `${a}/labels{/name}`,
    releases_url: `${a}/releases{/id}`,
    deployments_url: `${a}/deployments`,
  };
}

/** `repository` (as in GET /installation/repositories). */
export function repository(r: SimRepoMeta, urls: SimUrls) {
  const host = new URL(urls.web).host;
  return {
    id: r.id,
    node_id: nodeId('010:Repository', r.id),
    name: r.name,
    full_name: r.fullName,
    private: r.private,
    owner: simpleUser(r.owner, urls),
    html_url: `${urls.web}/${r.fullName}`,
    description: r.description,
    fork: r.fork,
    ...repoUrls(r, urls),
    git_url: `git://${host}/${r.fullName}.git`,
    ssh_url: `git@${host}:${r.fullName}.git`,
    clone_url: `${urls.web}/${r.fullName}.git`,
    svn_url: `${urls.web}/${r.fullName}`,
    mirror_url: null,
    homepage: null,
    language: r.language,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: r.sizeKb,
    default_branch: r.defaultBranch,
    open_issues_count: 0,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: r.private ? 'private' : 'public',
    pushed_at: r.pushedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    allow_forking: true,
    web_commit_signoff_required: false,
    license: null,
    forks: 0,
    open_issues: 0,
    watchers: 0,
  };
}

/** `full-repository` (GET /repos/{owner}/{repo}). */
export function fullRepository(r: SimRepoMeta, urls: SimUrls) {
  const base = repository(r, urls);
  return {
    ...base,
    temp_clone_token: '',
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    allow_update_branch: false,
    use_squash_pr_title_as_default: false,
    network_count: 0,
    subscribers_count: 0,
    ...(r.owner.type === 'Organization' ? { organization: simpleUser(r.owner, urls) } : {}),
  };
}

/** The repository object of push webhooks: owner carries name/email, timestamps are numbers. */
export function pushRepository(r: SimRepoMeta, urls: SimUrls) {
  const base = repository(r, urls);
  const { permissions: _p, ...rest } = base;
  return {
    ...rest,
    owner: { name: r.owner.login, email: null, ...simpleUser(r.owner, urls) },
    url: `${urls.web}/${r.fullName}`,
    created_at: Math.floor(Date.parse(r.createdAt) / 1000),
    pushed_at: Math.floor(Date.parse(r.pushedAt) / 1000),
    stargazers: 0,
    master_branch: r.defaultBranch,
    ...(r.owner.type === 'Organization' ? { organization: r.owner.login } : {}),
    custom_properties: {},
  };
}

export function organization(o: SimAccount, urls: SimUrls) {
  const a = `${urls.api}/orgs/${o.login}`;
  return {
    login: o.login,
    id: o.id,
    node_id: nodeId('012:Organization', o.id),
    url: a,
    repos_url: `${a}/repos`,
    events_url: `${a}/events`,
    hooks_url: `${a}/hooks`,
    issues_url: `${a}/issues`,
    members_url: `${a}/members{/member}`,
    public_members_url: `${a}/public_members{/member}`,
    avatar_url: `${urls.web}/avatars/u/${o.id}?v=4`,
    description: '',
  };
}

export const APP_PERMISSIONS = { contents: 'read', metadata: 'read' } as const;
export const APP_EVENTS = ['push'] as const;

export interface SimAppMeta {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  owner: SimAccount;
  createdAt: string;
}

/** `integration` (GET /app). */
export function integration(app: SimAppMeta, urls: SimUrls, installationsCount: number) {
  return {
    id: app.id,
    slug: app.slug,
    node_id: nodeId('03:Integration', app.id),
    client_id: app.clientId,
    owner: simpleUser(app.owner, urls),
    name: app.name,
    description: 'Simulated GitHub App for Blastradius development (Contents and Metadata: read).',
    external_url: urls.web,
    html_url: `${urls.web}/apps/${app.slug}`,
    created_at: app.createdAt,
    updated_at: app.createdAt,
    permissions: { ...APP_PERMISSIONS },
    events: [...APP_EVENTS],
    installations_count: installationsCount,
  };
}

export interface SimInstallationMeta {
  id: number;
  account: SimAccount;
  selection: 'all' | 'selected';
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  suspendedBy: SimAccount | null;
}

/** `installation`. */
export function installation(i: SimInstallationMeta, app: SimAppMeta, urls: SimUrls) {
  return {
    id: i.id,
    client_id: app.clientId,
    account: simpleUser(i.account, urls),
    repository_selection: i.selection,
    access_tokens_url: `${urls.api}/app/installations/${i.id}/access_tokens`,
    repositories_url: `${urls.api}/installation/repositories`,
    html_url:
      i.account.type === 'Organization'
        ? `${urls.web}/organizations/${i.account.login}/settings/installations/${i.id}`
        : `${urls.web}/settings/installations/${i.id}`,
    app_id: app.id,
    app_slug: app.slug,
    target_id: i.account.id,
    target_type: i.account.type,
    permissions: { ...APP_PERMISSIONS },
    events: [...APP_EVENTS],
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    single_file_name: null,
    has_multiple_single_files: false,
    single_file_paths: [],
    suspended_by: i.suspendedBy ? simpleUser(i.suspendedBy, urls) : null,
    suspended_at: i.suspendedAt,
  };
}

/** `basic-error`. */
export function basicError(message: string, docs = 'https://docs.github.com/rest', status?: number) {
  return { message, documentation_url: docs, ...(status ? { status: String(status) } : {}) };
}

/** `validation-error` (422). */
export function validationError(message: string) {
  return { message, documentation_url: 'https://docs.github.com/rest', errors: [] as string[] };
}
