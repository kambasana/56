import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from './auth';
import { ProjectProvider, useProject } from './project';
import { meFor } from './test/fixtures';
import { fakeApi } from './pages/e-parts/testkit';

function Names() {
  const { projects, loading } = useProject();
  return <output data-testid="projects">{loading ? 'loading' : projects.map((p) => p.name).join(',')}</output>;
}

describe('<ProjectProvider>', () => {
  it('lists projects through /api/me/projects, which every role may call (no 403 for an auditor)', async () => {
    const { calls } = fakeApi({
      'GET /api/me/projects': () => ({ items: [{ id: 'p1', name: 'payments-platform' }, { id: 'p2', name: 'web-storefront' }] }),
    });
    render(
      <MemoryRouter initialEntries={['/reports']}>
        <AuthProvider initialMe={meFor('auditor')}>
          <ProjectProvider>
            <Names />
          </ProjectProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('projects')).toHaveTextContent('payments-platform,web-storefront'));
    expect(calls.map((c) => c.path)).not.toContain('/api/projects');
    expect(calls.map((c) => c.path)).toContain('/api/me/projects');
  });
});
