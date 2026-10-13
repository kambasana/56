/**
 * Zod schema for incident KB records (PLAN §3.4, CONTRACTS §5).
 *
 * The YAML files in kb/incidents use exactly the field names of `Incident`.
 * Beyond shape checks, the schema enforces the KB's editorial rules:
 *  - ids look like INC-YYYY-NNNN and the year matches `date`;
 *  - dates are real ISO calendar dates (YYYY-MM-DD);
 *  - every incident has at least one public https evidence URL
 *    (required for `confirmed`, and for every other status too, PLAN §7);
 *  - entity refs use the namespaced id conventions and confidence is 0–1;
 *  - titles are factual: no judgement words ("malicious", "evil", ...);
 *  - `sanctions` incidents must cite an official sanctions list.
 */
import { z } from 'zod';
import { INCIDENT_TYPES, parsePurl, unversionedPurl, type Incident } from '../core/types.js';

export const INCIDENT_ID_RE = /^INC-(\d{4})-(\d{4})$/;
export const ENTITY_REF_RE =
  /^(account:(npm|github)\/[A-Za-z0-9._-]{1,100}|org:github\/[A-Za-z0-9._-]{1,100}|person:[a-z0-9-]{1,100}|funder:[a-z0-9_-]{1,50}\/[A-Za-z0-9._-]{1,100})$/;

/**
 * Words that express a judgement rather than a fact. Titles must describe
 * what happened ("version X published with code that ..."), not characterise
 * anyone. Matched case-insensitively on word boundaries.
 */
export const JUDGEMENT_WORDS = [
  'malicious',
  'evil',
  'criminal',
  'crook',
  'scam',
  'scammer',
  'fraudster',
  'rogue',
  'traitor',
  'villain',
  'nefarious',
  'shady',
  'hacker',
  'terrorist',
  'thief',
  'sinister',
  'bad actor',
  'threat actor',
] as const;

const JUDGEMENT_RE = new RegExp(`\\b(${JUDGEMENT_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

/** Returns the first judgement word found in `text`, or undefined. */
export function findJudgementWord(text: string): string | undefined {
  const m = JUDGEMENT_RE.exec(text);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Hosts accepted as evidence for `sanctions` incidents (official lists only, PLAN §7). */
export const OFFICIAL_SANCTIONS_HOSTS = [
  'ofac.treasury.gov',
  'home.treasury.gov',
  'sanctionssearch.ofac.treas.gov',
  'www.treasury.gov',
  'sanctionslist.ofac.treas.gov',
] as const;

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isHttpsUrl(s: string): boolean {
  if (s.length > 2048) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

const isoDate = z.string().refine(isIsoDate, { message: 'must be an ISO date YYYY-MM-DD' });
const httpsUrl = z.string().refine(isHttpsUrl, { message: 'must be a public https URL' });

const affectedSchema = z
  .object({
    purl: z.string().min(1).max(512),
    versions: z.array(z.string().min(1).max(128)).min(1),
  })
  .strict()
  .superRefine((a, ctx) => {
    let canonical: string;
    try {
      canonical = unversionedPurl(a.purl);
      parsePurl(a.purl);
    } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['purl'], message: (e as Error).message });
      return;
    }
    if (canonical !== a.purl) {
      ctx.addIssue({
        code: 'custom',
        path: ['purl'],
        message: `must be an unversioned canonical purl (expected "${canonical}")`,
      });
    }
    if (a.versions.includes('*') && a.versions.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['versions'], message: '"*" must be the only entry when used' });
    }
  });

const entitySchema = z
  .object({
    ref: z.string().regex(ENTITY_REF_RE, 'must be an entity id like account:npm/<handle> or org:github/<login>'),
    role: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9_]+$/, 'must be a factual snake_case role, e.g. "published_affected_versions"'),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const incidentSchema = z
  .object({
    id: z.string().regex(INCIDENT_ID_RE, 'must look like INC-YYYY-NNNN'),
    title: z.string().min(5).max(200),
    type: z.enum(INCIDENT_TYPES),
    status: z.enum(['confirmed', 'alleged', 'disputed', 'retracted']),
    date: isoDate,
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    affected: z.array(affectedSchema).min(1),
    entities: z.array(entitySchema).default([]),
    evidence: z.array(httpsUrl).default([]),
    reviewed_by: z.array(z.string().min(1).max(100)).optional(),
  })
  .strict()
  .superRefine((inc, ctx) => {
    const word = findJudgementWord(inc.title);
    if (word) {
      ctx.addIssue({
        code: 'custom',
        path: ['title'],
        message: `title contains judgement word "${word}"; describe what happened factually`,
      });
    }
    const idYear = INCIDENT_ID_RE.exec(inc.id)?.[1];
    if (idYear && isIsoDate(inc.date) && inc.date.slice(0, 4) !== idYear) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: `id year ${idYear} does not match date ${inc.date}` });
    }
    if (inc.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          inc.status === 'confirmed'
            ? 'a confirmed incident needs at least one public evidence URL'
            : 'at least one public evidence URL is required',
      });
    }
    if (inc.type === 'sanctions') {
      const official = inc.evidence.some((u) => {
        try {
          return (OFFICIAL_SANCTIONS_HOSTS as readonly string[]).includes(new URL(u).hostname);
        } catch {
          return false;
        }
      });
      if (!official) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: 'sanctions incidents must cite an official sanctions list (e.g. OFAC)',
        });
      }
    }
    const refs = new Set<string>();
    inc.entities.forEach((e, i) => {
      if (refs.has(e.ref)) ctx.addIssue({ code: 'custom', path: ['entities', i, 'ref'], message: `duplicate ref ${e.ref}` });
      refs.add(e.ref);
    });
    const purls = new Set<string>();
    inc.affected.forEach((a, i) => {
      if (purls.has(a.purl)) ctx.addIssue({ code: 'custom', path: ['affected', i, 'purl'], message: `duplicate purl ${a.purl}` });
      purls.add(a.purl);
    });
  });

export type IncidentInput = z.input<typeof incidentSchema>;

/** Validate an unknown value as an Incident. Returns either the incident or human-readable errors. */
export function parseIncident(value: unknown): { ok: true; incident: Incident } | { ok: false; errors: string[] } {
  const res = incidentSchema.safeParse(value);
  if (res.success) {
    const d = res.data;
    const incident: Incident = {
      id: d.id,
      title: d.title,
      type: d.type,
      status: d.status,
      date: d.date,
      severity: d.severity,
      affected: d.affected.map((a) => ({ purl: a.purl, versions: [...a.versions] })),
      entities: d.entities.map((e) => ({ ref: e.ref, role: e.role, confidence: e.confidence })),
      evidence: [...d.evidence],
    };
    if (d.reviewed_by) incident.reviewed_by = [...d.reviewed_by];
    return { ok: true, incident };
  }
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
  };
}
