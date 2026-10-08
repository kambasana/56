import { describe, expect, it } from 'vitest';
import { activeNavId, buildNav, landingPath, packagePath, projectCrumb, projectIdFromPath, projectLandingPath, projectNav, settingsNav } from './nav';
import { meCan } from './auth';
import { meFor, reportsOnly } from './test/fixtures';

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('buildNav (filtered by can())', () => {
  it('org admin sees the one-level sidebar, with Reports and Settings at the bottom', () => {
    const nav = buildNav(meFor('org_admin'), 'p1');
    expect(ids(nav.main)).toEqual(['overview', 'findings', 'incidents', 'projects', 'alerts']);
    expect(nav.main.map((i) => i.label)).toEqual(['Overview', 'Findings', 'Incidents', 'Projects', 'Alerts']);
    expect(ids(nav.footer)).toEqual(['reports', 'settings']);
    expect(nav.footer[1]?.to).toBe('/settings');
    // Real pages only: no anchors.
    for (const it of [...nav.main, ...nav.footer]) expect(it.to).not.toContain('#');
  });

  it('appsec and developer see every page; Settings opens Sources for them', () => {
    for (const role of ['appsec', 'developer'] as const) {
      const nav = buildNav(meFor(role), 'p1');
      expect(ids(nav.main)).toEqual(['overview', 'findings', 'incidents', 'projects', 'alerts']);
      expect(nav.footer.find((i) => i.id === 'settings')?.to).toBe('/integrations');
    }
  });

  it('the auditor reads every page but Settings', () => {
    const nav = buildNav(meFor('auditor'), 'p1');
    expect(ids(nav.main)).toEqual(['overview', 'findings', 'incidents', 'projects', 'alerts']);
    expect(ids(nav.footer)).toEqual(['reports']);
  });

  it('a reports-only member sees Reports only', () => {
    const nav = buildNav(reportsOnly(), 'p1');
    expect(nav.main).toEqual([]);
    expect(ids(nav.footer)).toEqual(['reports']);
  });

  it('project-scope permissions count for the current project only', () => {
    const me = reportsOnly({ projectPermissions: { p2: ['findings', 'changes'] } });
    expect(ids(buildNav(me, 'p2').main)).toEqual(['findings', 'incidents', 'alerts']);
    expect(buildNav(me, 'p1').main).toEqual([]);
    expect(ids(projectNav(me, 'p2'))).toEqual(['changes', 'findings']);
    expect(projectNav(me, 'p1')).toEqual([]);
    expect(meCan(me, 'findings')).toBe(false);
    expect(meCan(me, 'findings', 'p2')).toBe(true);
  });

  it('marks scoped pages so the sidebar carries the scope', () => {
    const nav = buildNav(meFor('org_admin'), null);
    expect(nav.main.filter((i) => i.scoped).map((i) => i.id)).toEqual(['overview', 'findings', 'incidents']);
  });

  it('shows nothing without a session', () => {
    expect(buildNav(null, 'p1')).toEqual({ main: [], footer: [] });
  });
});

describe('sub-navs and links', () => {
  it('lists project pages with encoded ids', () => {
    expect(projectNav(meFor('org_admin'), 'a/b').map((i) => i.to)).toEqual([
      '/projects/a%2Fb/changes',
      '/projects/a%2Fb/findings',
      '/projects/a%2Fb/exposure',
      '/projects/a%2Fb/investigate',
      '/projects/a%2Fb/scans',
    ]);
    expect(projectNav(meFor('org_admin'), null)).toEqual([]);
    expect(projectLandingPath(meFor('developer'), 'p1')).toBe('/projects/p1/findings');
    expect(projectLandingPath(reportsOnly(), 'p1')).toBeNull();
  });

  it('lists settings sections per permission', () => {
    expect(settingsNav(meFor('org_admin')).map((i) => i.label)).toEqual(['Members and roles', 'Sources']);
    expect(settingsNav(meFor('auditor'))).toEqual([]);
  });

  it('builds package and crumb links', () => {
    expect(packagePath('@scope/pkg', '1.0.0')).toBe('/packages?name=%40scope%2Fpkg&version=1.0.0');
    expect(packagePath('lodash')).toBe('/packages?name=lodash');
    expect(projectCrumb({ id: 'p 1', name: 'web' })).toEqual({ label: 'web', to: '/projects/p%201' });
    expect(projectCrumb(null)).toEqual({ label: 'Project', to: '/projects' });
  });
});

describe('routing helpers', () => {
  it('lands users on the first allowed page', () => {
    expect(landingPath(meFor('org_admin'), null)).toBe('/');
    expect(landingPath(meFor('auditor'), null)).toBe('/');
    expect(landingPath(reportsOnly(), null)).toBe('/reports');
    expect(landingPath(null, null)).toBe('/login');
    const projOnly = reportsOnly({ permissions: [], projectPermissions: { p9: ['findings'] } });
    expect(landingPath(projOnly, null)).toBe('/projects/p9/findings');
    expect(landingPath(reportsOnly({ permissions: [] }), null)).toBeNull();
  });

  it('finds the active item and project id', () => {
    expect(activeNavId('/')).toBe('overview');
    expect(activeNavId('/findings')).toBe('findings');
    expect(activeNavId('/projects/p1/findings/f1')).toBe('findings');
    expect(activeNavId('/projects/p1/exposure')).toBe('projects');
    expect(activeNavId('/projects')).toBe('projects');
    expect(activeNavId('/packages')).toBe('incidents');
    expect(activeNavId('/incidents')).toBe('incidents');
    expect(activeNavId('/alerts')).toBe('alerts');
    expect(activeNavId('/settings')).toBe('settings');
    expect(activeNavId('/integrations')).toBe('settings');
    expect(activeNavId('/reports')).toBe('reports');
    expect(activeNavId('/nope')).toBeNull();
    expect(projectIdFromPath('/projects/a%2Fb/findings')).toBe('a/b');
    expect(projectIdFromPath('/reports')).toBeNull();
  });
});
