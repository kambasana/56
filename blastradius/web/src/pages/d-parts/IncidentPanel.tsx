/**
 * Org-wide incident mode on Home: "Is X anywhere?" over every project's stored inventory, and
 * the alerts raised when a new advisory or the knowledge pack hits a project. Nothing is
 * re-scanned; answers come back in milliseconds.
 */
import { useState, type FormEvent } from 'react';
import type { SearchExposureResponse } from '@server/api-types';
import { Search } from 'lucide-react';
import { api } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { useApi } from '@/lib/useApi';
import { fmtNum, fmtTime } from '@/lib/cn';
import { PageSkeleton, SectionCard } from './ui';

function Place({ production }: { production: boolean }) {
  return production ? (
    <Badge variant="outline" className="border-level-critical/40 text-level-critical">
      production
    </Badge>
  ) : (
    <Badge variant="outline">dev / test</Badge>
  );
}

export function ExposureSearch() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchExposureResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.searchExposure(q.trim()));
    } catch (err) {
      setError(err as Error);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard id="anywhere" title="Is it anywhere?" description="Search every project's latest scan for a package, optionally at a version (chalk@5.6.1)">
      <form className="flex gap-2" onSubmit={submit} role="search" aria-label="Search all projects for a package">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="package or package@version" aria-label="Package or package@version" className="font-mono" />
        <Button type="submit" disabled={busy || !q.trim()}>
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>
      {error && <div className="mt-3"><ErrorState error={error} /></div>}
      {result && (
        <div className="mt-3 text-sm" aria-live="polite">
          <p className="mb-2 text-muted-foreground">
            {result.items.length === 0
              ? `Not found in any of ${fmtNum(result.projectsSearched)} projects.`
              : `${fmtNum(new Set(result.items.map((i) => i.projectId)).size)} of ${fmtNum(result.projectsSearched)} projects contain ${result.query.name}${result.query.version ? `@${result.query.version}` : ''}.`}
          </p>
          <ul className="flex flex-col divide-y rounded-md border" aria-label="Search results">
            {result.items.map((i) => (
              <li key={`${i.projectId}-${i.purl}`} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.projectName}</span>
                  <span className="font-mono text-xs">
                    {i.name}@{i.version}
                  </span>
                  <Place production={i.production} />
                </div>
                <span className="text-xs text-muted-foreground">{i.reachText}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function AlertsCard() {
  const { data, error, loading, reload } = useApi((s) => api.alerts(s), []);
  return (
    <SectionCard id="alerts" title="Alerts" description="New advisories that hit a project, from stored inventories (no re-scan)" flush>
      {loading && !data && <PageSkeleton label="Loading alerts…" rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {data && data.items.length === 0 && <EmptyState title="No alerts" description="When a new advisory names a package one of your projects uses, it shows up here." />}
      {data && data.items.length > 0 && (
        <ul className="flex flex-col divide-y" aria-label="Alerts">
          {data.items.slice(0, 20).map((a) => (
            <li key={a.id} className="flex flex-col gap-1 px-4 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.projectName}</span>
                <span className="font-mono text-xs">{decodeURIComponent(a.purl.replace(/^pkg:npm\//, ''))}</span>
                <Place production={a.production} />
                <a className="text-xs underline underline-offset-2" href={`https://osv.dev/vulnerability/${encodeURIComponent(a.advisoryId)}`} target="_blank" rel="noreferrer noopener">
                  {a.advisoryId}
                </a>
                <span className="ml-auto text-xs text-muted-foreground">{fmtTime(a.createdAt)}</span>
              </div>
              <span className="text-xs text-muted-foreground">{a.reachText}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
