/**
 * The peek sheet's body: where the package is, who brings it in and when it was first seen.
 * For a package row it lists each project with its own finding page, production first.
 */
import { Link } from 'react-router';
import { ReachTag } from '@/components/br';
import { StatusBadge } from '../d-parts/ui';
import { findingHref, type ListRow } from './rows';
import { fmtDay, introducedText, relTime } from './triage';

function Term({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

export function FindingPeekBody({ row }: { row: ListRow }) {
  const via = row.introducedBy.via;
  const brought = row.introducedBy.direct && via.length === 0 ? 'Direct dependency' : via.length ? `${row.introducedBy.direct ? 'Direct, and via ' : ''}${via.join(', ')}` : '—';
  return (
    <div className="flex flex-col gap-4">
      <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 text-body">
        <Term>Where</Term>
        <dd className="m-0 flex flex-wrap items-center gap-1.5">
          {row.projects} {row.projects === 1 ? 'project' : 'projects'}
          {row.prodProjects > 0 ? <ReachTag reach="production" count={row.prodProjects} /> : <ReachTag reach="dev" />}
        </dd>
        {row.reachText && (
          <>
            <Term>Reach</Term>
            <dd className="m-0 text-text-secondary">{row.reachText}</dd>
          </>
        )}
        <Term>Brought in by</Term>
        <dd className="m-0 font-mono text-[12px]" title={introducedText(row.introducedBy)}>
          {brought}
        </dd>
        <Term>First seen</Term>
        <dd className="m-0" title={row.firstSeenAt}>
          {relTime(row.firstSeenAt)} <span className="text-muted-foreground">({fmtDay(row.firstSeenAt)})</span>
        </dd>
      </dl>
      {row.kind === 'package' && (
        <section aria-label="Projects with this package" className="flex flex-col gap-1.5">
          <h3 className="m-0 text-label font-medium">In these projects</h3>
          <ul className="m-0 flex list-none flex-col divide-y rounded-lg border p-0">
            {row.findings.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Link to={findingHref(f)} className="font-medium">
                  {f.projectName}
                </Link>
                <ReachTag reach={f.production ? 'production' : 'dev'} />
                <span className="grow" />
                <StatusBadge status={f.status} />
                <span className="text-caption text-muted-foreground">{f.owner?.name ?? 'Unassigned'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
