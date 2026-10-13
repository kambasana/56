/**
 * Tier 0: never a silent all-clear. On every project page, a loud banner when the project's latest
 * scan found manifests it did not analyse (unsupported lockfiles, Python without a lockfile,
 * package.json without package-lock.json), with the approximate number of packages they list.
 */
import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { NotAnalysedManifest, SourceCoverage } from '@server/api-types';
import { api } from '@/api';
import { useOptionalProject } from '@/project';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function notAnalysedTitle(list: readonly NotAnalysedManifest[]): string {
  const n = list.reduce((s, e) => s + (e.packages ?? 0), 0);
  const unknown = list.some((e) => e.packages === undefined);
  const files = list.slice(0, 3).map((e) => e.file).join(', ');
  const more = list.length > 3 ? ` (+${list.length - 3} more)` : '';
  return `NOT ANALYSED: ${files}${more}, ~${n}${unknown ? '+' : ''} packages`;
}

export function NotAnalysedAlert({ list }: { list: readonly NotAnalysedManifest[] }) {
  if (list.length === 0) return null;
  return (
    <Alert variant="destructive" className="border-destructive" data-testid="not-analysed">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none font-semibold">{notAnalysedTitle(list)}</AlertTitle>
      <AlertDescription>
        <p>These files were found in the last scan but not analysed, so their packages are not covered by the findings, licences or SBOM here. This is not an all-clear for them.</p>
        <ul className="list-disc pl-4">
          {list.slice(0, 8).map((e) => (
            <li key={e.file}>
              <span className="font-mono">{e.file}</span>: {e.reason}
              {e.packages !== undefined ? ` (~${e.packages} packages)` : ''}
            </li>
          ))}
          {list.length > 8 && <li>… {list.length - 8} more in the scan report</li>}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** Sources (OSV, deps.dev, ...) that failed or answered in part: a missing finding is not a clean result. */
export function DegradedSourcesAlert({ sources }: { sources: readonly SourceCoverage[] }) {
  if (sources.length === 0) return null;
  const security = sources.some((s) => s.security);
  return (
    <Alert variant={security ? 'destructive' : 'default'} className={security ? 'border-destructive' : undefined} data-testid="degraded-sources">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none font-semibold">
        {security ? 'SECURITY SOURCE INCOMPLETE' : 'SOURCES INCOMPLETE'}: {sources.map((s) => `${s.source} ${s.status}`).join(', ')}
      </AlertTitle>
      <AlertDescription>
        <p>These sources did not fully answer in the last scan, so a missing finding does not mean the package is clean.</p>
        <ul className="list-disc pl-4">
          {sources.map((s) => (
            <li key={s.source}>
              <span className="font-mono">{s.source}</span>: {s.status}
              {s.reason ? ` (${s.reason})` : ''}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** Fetches what the current project's latest succeeded scan did not analyse; renders nothing outside project pages. */
export function NotAnalysedBanner() {
  const ctx = useOptionalProject();
  const projectId = ctx?.inProjectRoute ? ctx.projectId : null;
  const [list, setList] = useState<NotAnalysedManifest[]>([]);
  const [sources, setSources] = useState<SourceCoverage[]>([]);
  useEffect(() => {
    setList([]);
    setSources([]);
    if (!projectId) return;
    const ac = new AbortController();
    api
      .projectCoverage(projectId, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setList(r.notAnalysed ?? []);
        setSources(r.degradedSources ?? []);
      })
      .catch(() => {
        /* the banner is advisory; pages show their own errors */
      });
    return () => ac.abort();
  }, [projectId]);
  if (list.length === 0 && sources.length === 0) return null;
  return (
    <div className="grid gap-2 px-4 pb-3">
      <NotAnalysedAlert list={list} />
      <DegradedSourcesAlert sources={sources} />
    </div>
  );
}
