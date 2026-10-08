/**
 * Known-bad layer from the knowledge pack: malware facts for npm components the pack lists, so
 * a scan flags them even when the live OSV API is unreachable. Runs after the other enrichers
 * and skips anything they already reported (same component and advisory id or alias).
 */
import type { Enricher } from '../core/plugin.js';
import { makeFact, parsePurl, type Fact, type MalwareValue } from '../core/types.js';
import { packMalware, type LoadedPack } from './load.js';

export function createPackEnricher(loaded: LoadedPack, getFacts: () => readonly Fact[]): Enricher {
  return {
    name: 'pack',
    usesEarlierFacts: true,
    async enrich(inv, ctx) {
      const seen = new Set<string>();
      for (const f of getFacts()) if (f.kind === 'malware') seen.add(`${f.subject}\u0000${(f.value as MalwareValue).id}`);
      const now = new Date().toISOString();
      const facts: Fact[] = [];
      for (const c of inv.components) {
        let p;
        try {
          p = parsePurl(c.purl);
        } catch {
          continue;
        }
        if (p.type !== 'npm') continue;
        const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
        for (const ref of packMalware(loaded.pack, name, p.version)) {
          // KB refs: the scan reads the incident KB itself; the pack carries them for org alerts.
          if (ref.source === 'kb') continue;
          const ids = [ref.id, ...(ref.aliases ?? [])];
          if (ids.some((id) => seen.has(`${c.purl}\u0000${id}`))) continue;
          seen.add(`${c.purl}\u0000${ref.id}`);
          const url = ref.url ?? `https://osv.dev/vulnerability/${encodeURIComponent(ref.id)}`;
          const value: MalwareValue = { id: ref.id, origin: ref.source === 'datadog' ? 'other' : 'osv', url, summary: `known-bad list in the knowledge pack built ${loaded.pack.builtAt.slice(0, 10)}` };
          if (ref.published) value.published = ref.published;
          facts.push(makeFact('malware', c.purl, value, { source: 'pack', fetchedAt: now, evidence: [url] }));
        }
      }
      if (facts.length) ctx.warn?.(`pack: ${facts.length} malware match(es) from the knowledge pack (sha256 ${loaded.sha256.slice(0, 12)}…)`);
      return facts;
    },
  };
}
