/**
 * Webhook deliveries as GitHub sends them to a GitHub App: payloads start from the community
 * examples in @octokit/webhooks-examples (pinned) and every field is filled from simulator state;
 * bodies are signed with HMAC-SHA256 (X-Hub-Signature-256) and HMAC-SHA1 (X-Hub-Signature), with
 * X-GitHub-Event, X-GitHub-Delivery and the hook headers GitHub adds.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installation as restInstallation, nodeId, organization, pushRepository, simpleUser, type SimAccount, type SimAppMeta, type SimInstallationMeta, type SimRepoMeta, type SimUrls } from './shapes.js';

interface ExampleEvent {
  name: string;
  examples: Record<string, unknown>[];
}

let examples: ExampleEvent[] | null = null;

/** The pinned @octokit/webhooks-examples catalogue (api.github.com). */
export function webhookExamples(): ExampleEvent[] {
  if (!examples) {
    const require = createRequire(import.meta.url);
    examples = JSON.parse(readFileSync(require.resolve('@octokit/webhooks-examples'), 'utf8')) as ExampleEvent[];
  }
  return examples;
}

/**
 * The example a payload is built from: the first one for `event` (and `action`) that has every
 * key in `mustHave` (GitHub App deliveries carry `installation`).
 */
export function exampleFor(event: string, action: string | null, mustHave: readonly string[] = []): Record<string, unknown> {
  const e = webhookExamples().find((x) => x.name === event);
  const ex = e?.examples.find((x) => (action === null || x.action === action) && mustHave.every((k) => k in x));
  if (!ex) throw new Error(`no @octokit/webhooks-examples payload for ${event}${action ? `.${action}` : ''}`);
  return structuredClone(ex);
}

/** Overwrite the example's fields with ours, keeping the example's key order. */
function fill(example: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(example)) out[k] = k in values ? values[k] : example[k];
  for (const [k, v] of Object.entries(values)) if (!(k in out)) out[k] = v;
  return out;
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * The installation object of installation / installation_repositories events. The examples
 * disagree on timestamps (unix seconds in some, ISO strings in others): follow the example's.
 */
function webhookInstallation(i: SimInstallationMeta, app: SimAppMeta, urls: SimUrls, example: Record<string, unknown>) {
  const rest = restInstallation(i, app, urls);
  const like = (example.installation as { created_at?: unknown } | undefined)?.created_at;
  return typeof like === 'number' ? { ...rest, created_at: unix(i.createdAt), updated_at: unix(i.updatedAt) } : rest;
}

const shortRepo = (r: SimRepoMeta) => ({ id: r.id, node_id: nodeId('010:Repository', r.id), name: r.name, full_name: r.fullName, private: r.private });

export interface SimPushCommit {
  sha: string;
  tree: string;
  message: string;
  time: string;
  author: { name: string; email: string; username: string };
  added: string[];
  removed: string[];
  modified: string[];
}

export const payloads = {
  installation(action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted', i: SimInstallationMeta, app: SimAppMeta, repos: SimRepoMeta[], sender: SimAccount, urls: SimUrls) {
    const ex = exampleFor('installation', action);
    return fill(ex, {
      action,
      installation: webhookInstallation(i, app, urls, ex),
      ...('repositories' in ex ? { repositories: repos.map(shortRepo) } : {}),
      ...('requester' in ex ? { requester: null } : {}),
      sender: simpleUser(sender, urls),
    });
  },

  installationRepositories(action: 'added' | 'removed', i: SimInstallationMeta, app: SimAppMeta, added: SimRepoMeta[], removed: SimRepoMeta[], sender: SimAccount, urls: SimUrls) {
    const ex = exampleFor('installation_repositories', action);
    return fill(ex, {
      action,
      installation: webhookInstallation(i, app, urls, ex),
      repository_selection: i.selection,
      repositories_added: added.map(shortRepo),
      repositories_removed: removed.map(shortRepo),
      ...('requester' in ex ? { requester: null } : {}),
      sender: simpleUser(sender, urls),
    });
  },

  push(repo: SimRepoMeta, push: { ref: string; before: string; after: string; created: boolean; deleted: boolean; forced: boolean; commits: SimPushCommit[] }, i: SimInstallationMeta, pusher: SimAccount, urls: SimUrls) {
    const ex = exampleFor('push', null, ['installation']);
    const commit = (c: SimPushCommit) => ({
      id: c.sha,
      tree_id: c.tree,
      distinct: true,
      message: c.message,
      timestamp: c.time,
      url: `${urls.web}/${repo.fullName}/commit/${c.sha}`,
      author: c.author,
      committer: c.author,
      added: c.added,
      removed: c.removed,
      modified: c.modified,
    });
    const commits = push.commits.map(commit);
    return fill(ex, {
      ref: push.ref,
      before: push.before,
      after: push.after,
      repository: pushRepository(repo, urls),
      ...(repo.owner.type === 'Organization' ? { organization: organization(repo.owner, urls) } : {}),
      pusher: { name: pusher.login, email: `${pusher.id}+${pusher.login}@users.noreply.${new URL(urls.web).hostname}` },
      sender: simpleUser(pusher, urls),
      installation: { id: i.id, node_id: nodeId('023:IntegrationInstallation', i.id) },
      created: push.created,
      deleted: push.deleted,
      forced: push.forced,
      base_ref: null,
      compare: push.created ? `${urls.web}/${repo.fullName}/commit/${push.after}` : `${urls.web}/${repo.fullName}/compare/${push.before.slice(0, 12)}...${push.after.slice(0, 12)}`,
      commits,
      head_commit: commits[commits.length - 1] ?? null,
    });
  },
};

export interface SignedDelivery {
  id: string;
  event: string;
  headers: Record<string, string>;
  body: string;
}

/** Headers and body exactly as GitHub posts a delivery; `secret: null` sends it unsigned. */
export function signDelivery(event: string, payload: unknown, opts: { secret: string | null; appId: number; hookId: number; id?: string }): SignedDelivery {
  const body = JSON.stringify(payload);
  const id = opts.id ?? randomUUID();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/sim',
    'x-github-event': event,
    'x-github-delivery': id,
    'x-github-hook-id': String(opts.hookId),
    'x-github-hook-installation-target-id': String(opts.appId),
    'x-github-hook-installation-target-type': 'integration',
  };
  if (opts.secret !== null) {
    headers['x-hub-signature'] = `sha1=${createHmac('sha1', opts.secret).update(body).digest('hex')}`;
    headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', opts.secret).update(body).digest('hex')}`;
  }
  return { id, event, headers, body };
}
