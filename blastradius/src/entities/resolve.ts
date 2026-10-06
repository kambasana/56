/**
 * Entity resolution (PLAN §3.3): Facts (+ incidents) → Entity[] / EntityLink[].
 *
 * Deterministic rules (confidence ≥ 0.9, reviewed = true):
 *  - npm `maintainers`      → account:npm/<h>  --maintains--> pkg            (1.0)
 *  - npm `publisher`        → account:npm/<h>  --publishes--> pkg            (1.0)
 *  - `repo_owner` (GitHub)  → org:github/<o> | account:github/<o> --owns--> pkg (0.9; repository field → owner)
 *  - `repo` without owner fact, GitHub host → same as above, type inferred    (0.9)
 *  - `funding` (FUNDING.yml / package.json#funding):
 *      open_collective / other platforms → funder:<platform>/<h> --funds--> owner org (or pkg)   (0.9)
 *      github (Sponsors)                  → account:github/<h> --linked_to--> pkg (funding account) (0.9)
 *  - incident entity refs   → Entity nodes (incidents attach in the graph, see graph.ts)
 *
 * Probabilistic rules (confidence < 0.8, reviewed = false; ignored by scoring until reviewed):
 *  - two npm accounts with public emails on the same non-webmail domain → linked_to (0.5)
 *  - npm handle equal (case-insensitive) to a GitHub login → linked_to (0.7)
 *  - npm handle within edit distance 1 of a GitHub login (len ≥ 6) → linked_to (0.4)
 *
 * Emails are used only for domain matching and are never copied into entities or links.
 * Every link carries ≥ 1 public evidence URL; a candidate link without one is dropped.
 */
import {
  isFactOf,
  parsePurl,
  unversionedPurl,
  type Entity,
  type EntityLink,
  type EntityType,
  type Fact,
  type Incident,
  type PurlString,
} from '../core/types.js';

export interface EntityGraphData {
  entities: Entity[];
  links: EntityLink[];
}

export interface ResolveOptions {
  /** Incidents whose entity refs become Entity nodes. */
  incidents?: readonly Incident[];
  /** Emit probabilistic candidate links (default true). They stay unreviewed until a review accepts them. */
  probabilistic?: boolean;
  /** Cap on accounts compared per email domain (avoids O(n²) blow-ups). Default 50. */
  maxAccountsPerDomain?: number;
}

export const DETERMINISTIC_CONFIDENCE = { registry: 1, repository: 0.9, funding: 0.9 } as const;
export const PROBABILISTIC_CONFIDENCE = { emailDomain: 0.5, sameHandle: 0.7, similarHandle: 0.4 } as const;

/** Webmail / relay domains that say nothing about affiliation. */
const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.de',
  'gmx.net', 'web.de', 'mail.ru', 'yandex.ru', 'yandex.com', 'qq.com', '163.com', '126.com', 'foxmail.com',
  'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'users.noreply.github.com', 'noreply.github.com',
  'example.com', 'localhost',
]);

const HANDLE_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function npmAccountId(handle: string): string {
  return `account:npm/${handle.toLowerCase()}`;
}
export function githubAccountId(login: string): string {
  return `account:github/${login.toLowerCase()}`;
}
export function githubOrgId(login: string): string {
  return `org:github/${login.toLowerCase()}`;
}
export function funderId(platform: string, handle: string): string {
  return `funder:${platform.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}/${handle.toLowerCase()}`;
}

/** Entity type implied by an id prefix ('account:', 'org:', 'person:', 'funder:'). */
export function entityTypeOf(id: string): EntityType | undefined {
  const prefix = id.slice(0, id.indexOf(':'));
  return prefix === 'account' || prefix === 'org' || prefix === 'person' || prefix === 'funder' ? prefix : undefined;
}

/** Display name for an entity id: the part after the platform ("account:npm/foo" → "foo"). */
export function entityNameOf(id: string): string {
  const afterColon = id.slice(id.indexOf(':') + 1);
  const slash = afterColon.indexOf('/');
  return slash >= 0 ? afterColon.slice(slash + 1) : afterColon;
}

/** Stable identity for a link: from|relation|to. */
export function linkKey(l: Pick<EntityLink, 'from' | 'to' | 'relation'>): string {
  return `${l.from}|${l.relation}|${l.to}`;
}

function npmPackageUrl(pkg: PurlString): string | undefined {
  try {
    const p = parsePurl(pkg);
    if (p.type !== 'npm') return undefined;
    const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    return `https://www.npmjs.com/package/${name}`;
  } catch {
    return undefined;
  }
}

function base(purl: string): string | undefined {
  try {
    return unversionedPurl(purl);
  } catch {
    return undefined;
  }
}

function httpsOnly(urls: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (!u || u.length > 2048) continue;
    try {
      if (new URL(u).protocol === 'https:' && !out.includes(u)) out.push(u);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function emailDomain(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf('@');
  if (at < 1) return undefined;
  const d = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || SHARED_EMAIL_DOMAINS.has(d)) return undefined;
  return d;
}

/** Levenshtein distance with early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

class Builder {
  readonly entities = new Map<string, Entity>();
  readonly links = new Map<string, EntityLink>();

  entity(id: string, type: EntityType, name: string): void {
    if (!this.entities.has(id)) this.entities.set(id, { id, type, name });
  }

  link(l: Omit<EntityLink, 'evidence'> & { evidence: (string | undefined)[] }): void {
    const evidence = httpsOnly(l.evidence);
    if (evidence.length === 0) return; // PLAN §7: no link without a public source
    const key = linkKey(l);
    const prev = this.links.get(key);
    if (prev) {
      // Merge: keep the strongest confidence; deterministic wins over probabilistic.
      for (const e of evidence) if (!prev.evidence.includes(e)) prev.evidence.push(e);
      if (l.method === 'deterministic' && prev.method === 'probabilistic') {
        Object.assign(prev, { method: l.method, confidence: l.confidence, reviewed: l.reviewed });
      } else if (l.method === prev.method && l.confidence > prev.confidence) {
        prev.confidence = l.confidence;
      }
      return;
    }
    this.links.set(key, { ...l, evidence });
  }
}

/** Build entities and links from facts (and incident entity refs). Pure and deterministic. */
export function resolveEntities(facts: readonly Fact[], opts: ResolveOptions = {}): EntityGraphData {
  const b = new Builder();
  const emailsByAccount = new Map<string, { domain: string; evidence: string }[]>();
  const noteEmail = (accountId: string, email: string | undefined, evidence: string | undefined): void => {
    const domain = emailDomain(email);
    if (!domain || !evidence) return;
    const list = emailsByAccount.get(accountId) ?? [];
    if (!list.some((x) => x.domain === domain)) list.push({ domain, evidence });
    emailsByAccount.set(accountId, list);
  };

  // GitHub owner types known from repo_owner facts, used when only a `repo` fact is present.
  const ownerTypes = new Map<string, 'User' | 'Organization'>();
  for (const f of facts.filter(isFactOf('repo_owner'))) {
    if (HANDLE_RE.test(f.value.owner)) ownerTypes.set(f.value.owner.toLowerCase(), f.value.ownerType);
  }
  const ownerEntity = (login: string): string => {
    const l = login.toLowerCase();
    if (ownerTypes.get(l) === 'User') {
      b.entity(githubAccountId(l), 'account', l);
      return githubAccountId(l);
    }
    // Organization, or unknown (a repository owner without a type fact is treated as an org-level owner).
    b.entity(githubOrgId(l), 'org', l);
    return githubOrgId(l);
  };
  const ownersByPkg = new Map<string, string>();

  for (const f of facts) {
    const pkg = base(f.subject);
    if (!pkg) continue;
    const pkgUrl = npmPackageUrl(pkg);
    switch (f.kind) {
      case 'maintainers':
        for (const m of f.value.maintainers) {
          if (!HANDLE_RE.test(m.name)) continue;
          const id = npmAccountId(m.name);
          b.entity(id, 'account', m.name.toLowerCase());
          b.link({
            from: id, to: pkg, relation: 'maintains', confidence: DETERMINISTIC_CONFIDENCE.registry,
            evidence: [...(f.evidence ?? []), pkgUrl], method: 'deterministic', reviewed: true,
          });
          noteEmail(id, m.email, pkgUrl);
        }
        break;
      case 'publisher': {
        if (!HANDLE_RE.test(f.value.name)) break;
        const id = npmAccountId(f.value.name);
        b.entity(id, 'account', f.value.name.toLowerCase());
        b.link({
          from: id, to: pkg, relation: 'publishes', confidence: DETERMINISTIC_CONFIDENCE.registry,
          evidence: [...(f.evidence ?? []), pkgUrl], method: 'deterministic', reviewed: true,
        });
        noteEmail(id, f.value.email, pkgUrl);
        break;
      }
      case 'repo_owner': {
        if (!HANDLE_RE.test(f.value.owner)) break;
        const id = ownerEntity(f.value.owner);
        ownersByPkg.set(pkg, id);
        b.link({
          from: id, to: pkg, relation: 'owns', confidence: DETERMINISTIC_CONFIDENCE.repository,
          evidence: [f.value.url, ...(f.evidence ?? [])], method: 'deterministic', reviewed: true,
        });
        break;
      }
      default:
        break;
    }
  }

  // `repo` facts without a matching repo_owner fact.
  for (const f of facts.filter(isFactOf('repo'))) {
    const pkg = base(f.subject);
    if (!pkg || ownersByPkg.has(pkg) || f.value.host !== 'github' || !f.value.owner) continue;
    if (!HANDLE_RE.test(f.value.owner)) continue;
    const id = ownerEntity(f.value.owner);
    ownersByPkg.set(pkg, id);
    b.link({
      from: id, to: pkg, relation: 'owns', confidence: DETERMINISTIC_CONFIDENCE.repository,
      evidence: [f.value.url, ...(f.evidence ?? [])], method: 'deterministic', reviewed: true,
    });
  }

  // Funding (after owners are known so funders attach to the owning org when there is one).
  for (const f of facts.filter(isFactOf('funding'))) {
    const pkg = base(f.subject);
    if (!pkg) continue;
    const pkgUrl = npmPackageUrl(pkg);
    for (const s of f.value.sources) {
      const platform = s.platform.toLowerCase();
      const handle = s.handle && HANDLE_RE.test(s.handle) ? s.handle : undefined;
      if (platform === 'github') {
        if (!handle) continue;
        const id = githubAccountId(handle);
        b.entity(id, 'account', handle.toLowerCase());
        b.link({
          from: id, to: pkg, relation: 'linked_to', confidence: DETERMINISTIC_CONFIDENCE.funding,
          evidence: [`https://github.com/sponsors/${handle}`, ...(f.evidence ?? []), pkgUrl],
          method: 'deterministic', reviewed: true,
        });
        continue;
      }
      if (!handle) continue; // bare URLs (custom) are not resolvable to an entity
      const isOpenCollective = platform === 'open_collective' || platform === 'opencollective';
      const fid = funderId(isOpenCollective ? 'opencollective' : platform, handle);
      b.entity(fid, 'funder', handle.toLowerCase());
      const ocUrl = isOpenCollective ? `https://opencollective.com/${handle}` : undefined;
      b.link({
        from: fid, to: ownersByPkg.get(pkg) ?? pkg, relation: 'funds', confidence: DETERMINISTIC_CONFIDENCE.funding,
        evidence: [s.url, ocUrl, ...(f.evidence ?? []), pkgUrl], method: 'deterministic', reviewed: true,
      });
    }
  }

  // Incident entity refs become nodes.
  for (const inc of opts.incidents ?? []) {
    for (const e of inc.entities) {
      const type = entityTypeOf(e.ref);
      if (type) b.entity(e.ref, type, entityNameOf(e.ref));
    }
  }

  if (opts.probabilistic !== false) addProbabilisticLinks(b, emailsByAccount, opts.maxAccountsPerDomain ?? 50);

  const entities = [...b.entities.values()].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  const links = [...b.links.values()].sort((a, c) => (linkKey(a) < linkKey(c) ? -1 : 1));
  return { entities, links };
}

function addProbabilisticLinks(
  b: Builder,
  emailsByAccount: Map<string, { domain: string; evidence: string }[]>,
  maxPerDomain: number,
): void {
  // Same non-webmail email domain between npm accounts.
  const byDomain = new Map<string, { account: string; evidence: string }[]>();
  for (const [account, list] of emailsByAccount) {
    for (const { domain, evidence } of list) {
      const arr = byDomain.get(domain) ?? [];
      if (arr.length < maxPerDomain) arr.push({ account, evidence });
      byDomain.set(domain, arr);
    }
  }
  for (const accounts of byDomain.values()) {
    const sorted = [...accounts].sort((x, y) => (x.account < y.account ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const x = sorted[i]!;
        const y = sorted[j]!;
        if (x.account === y.account) continue;
        b.link({
          from: x.account, to: y.account, relation: 'linked_to', confidence: PROBABILISTIC_CONFIDENCE.emailDomain,
          evidence: [x.evidence, y.evidence], method: 'probabilistic', reviewed: false,
        });
      }
    }
  }

  // npm handles vs GitHub logins.
  const npmAccounts = [...b.entities.values()].filter((e) => e.id.startsWith('account:npm/'));
  const githubIds = [...b.entities.values()].filter((e) => e.id.startsWith('account:github/') || e.id.startsWith('org:github/'));
  for (const n of npmAccounts) {
    for (const g of githubIds) {
      const a = n.name.toLowerCase();
      const c = g.name.toLowerCase();
      let confidence: number | undefined;
      if (a === c) confidence = PROBABILISTIC_CONFIDENCE.sameHandle;
      else if (Math.min(a.length, c.length) >= 6 && editDistance(a, c, 1) <= 1) confidence = PROBABILISTIC_CONFIDENCE.similarHandle;
      if (confidence === undefined) continue;
      b.link({
        from: n.id, to: g.id, relation: 'linked_to', confidence,
        evidence: [`https://www.npmjs.com/~${n.name}`, `https://github.com/${g.name}`],
        method: 'probabilistic', reviewed: false,
      });
    }
  }
}
