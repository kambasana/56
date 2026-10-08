/**
 * Package page: "is it here?" for one package (optionally one version) across every project the
 * viewer can see, from stored inventories (GET /api/search/exposure). The ⌘K Verdict links here.
 * URL: /packages?name=<name>&version=<version>. Stage 2 grows it into the Incident page.
 */
import { Link, useSearchParams } from 'react-router';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ReachTag, reachOf, StateBlock, VerdictContent, verdictSurface } from '@/components/br';
import { useCommandPalette } from '@/components/CommandPalette';
import { verdictFrom } from '@/lib/package-query';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';

export default function PackagePage() {
  const { me, can } = useAuth();
  const [sp] = useSearchParams();
  const { setOpen } = useCommandPalette();
  const name = sp.get('name')?.trim() ?? '';
  const version = sp.get('version')?.trim() || null;
  const pkg = version ? `${name}@${version}` : name;
  const { data, error, loading, reload } = useApi((s) => (name ? api.searchExposure(pkg, s) : Promise.resolve(null)), [pkg]);

  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
    { label: pkg || 'Package', to: packagePath(name || '', version) },
  ];

  let body;
  if (!name)
    body = <StateBlock kind="no-results" title="No package given" description="Search for a package with a version to check every project." actions={[{ label: 'Search (⌘K)', onClick: () => setOpen(true) }]} />;
  else if (loading && !data) body = <StateBlock kind="loading" label={`Checking every project for ${pkg}`} rows={3} columns={3} />;
  else if (error && !data) body = <StateBlock kind="error" title={`Could not check ${pkg}`} cause={error.message} onRetry={reload} />;
  else if (data) {
    const verdict = verdictFrom(data);
    const rows = [...data.items].sort((a, b) => Number(b.production) - Number(a.production) || a.projectName.localeCompare(b.projectName));
    body = (
      <>
        <section aria-label="Verdict" className={cn('rounded-xl p-4', verdictSurface(verdict.projects > 0))}>
          <VerdictContent data={verdict} />
        </section>
        {rows.length > 0 && (
          <section aria-labelledby="where" className="overflow-hidden rounded-xl border">
            <h2 id="where" className="border-b bg-muted px-4 py-2 text-label font-medium text-text-secondary">
              Where it is (production first)
            </h2>
            <ul aria-label="Projects" className="m-0 flex list-none flex-col divide-y p-0">
              {rows.map((r) => (
                <li key={`${r.projectId}-${r.purl}`} className="flex flex-col gap-1 px-4 py-2.5">
                  <span className="flex flex-wrap items-center gap-2">
                    {can('findings', r.projectId) ? (
                      <Link to={projectPath(r.projectId, 'findings')} className="font-medium">
                        {r.projectName}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.projectName}</span>
                    )}
                    <span className="font-mono text-[12px]">
                      {r.name}@{r.version}
                    </span>
                    <ReachTag reach={reachOf(r.production)} />
                  </span>
                  <span className="text-caption text-muted-foreground">{r.reachText}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {version && (
          <p className="text-label text-text-secondary">
            Other versions: <Link to={packagePath(name)}>{name} in every project</Link>.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader crumbs={crumbs} title={<span className="font-mono">{pkg || 'Package'}</span>} meta={data ? `${data.projectsSearched} projects searched` : undefined} />
      <div className="flex max-w-4xl flex-col gap-4 p-4">{body}</div>
    </>
  );
}
