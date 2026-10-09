/**
 * Projects (List template; stage 2 adds the scope bar, chips and bulk actions). One row per
 * project; a row opens the project's first page the viewer may use.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderPlus } from 'lucide-react';
import type { ProjectRow } from '@server/api-types';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { projectHome } from '@/nav';
import { Button } from '@/components/Button';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { StateBlock } from '@/components/br';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
import { CreateProjectDialog } from './d-parts/CreateProjectDialog';
import { homeFromProjects, PROJECT_COLUMNS } from './OrgHome';

export default function Projects() {
  const { me, can } = useAuth();
  const { reload: reloadProjects } = useProject();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi((s) => homeFromProjects(s), []);
  const [creating, setCreating] = useState(false);
  const canCreate = can('manage_projects');
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Projects', to: '/projects' },
  ];

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading projects" rows={5} columns={5} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load projects" cause={error.message} onRetry={reload} />;
  else if (data && data.projects.length === 0)
    body = (
      <StateBlock
        kind="no-results"
        title="No projects yet"
        description="Create a project and point it at a repository to run the first scan."
        actions={canCreate ? [{ label: 'New project', onClick: () => setCreating(true) }] : [{ label: 'Ask an admin to add a project', to: '/' }]}
      />
    );
  else if (data)
    body = (
      <DataTable<ProjectRow>
        label="Projects"
        data={data.projects}
        columns={PROJECT_COLUMNS}
        getRowId={(r) => r.id}
        filterPlaceholder="Filter projects…"
        initialSorting={[{ id: 'counts', desc: true }]}
        onRowClick={(row) => navigate(projectHome(row.id))}
      />
    );

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Projects"
        meta={data ? `${fmtNum(data.projects.length)} projects` : undefined}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <FolderPlus aria-hidden="true" />
              New project
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-4 p-4">{body}</div>
      {canCreate && (
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(p) => {
            setCreating(false);
            reloadProjects();
            reload();
            navigate(projectHome(p.id));
          }}
        />
      )}
    </>
  );
}
