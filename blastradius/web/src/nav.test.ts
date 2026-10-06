import { describe, expect, it } from 'vitest';
import { activeNavId, buildNav, landingPath, projectIdFromPath } from './nav';
import { meCan } from './auth';
import { meFor } from './test/fixtures';

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('buildNav (filtered by can())', () => {
  it('org admin sees every item', () => {
    const nav = buildNav(meFor('org_admin'), 'p1');
    expect(ids(nav.org)).toEqual(['home', 'projects', 'reports', 'integrations', 'settings']);
    expect(ids(nav.project)).toEqual(['changes', 'findings', 'exposure', 'investigate', 'scans']);
    expect(ids(nav.knowledge)).toEqual(['incidents']);
    expect(nav.project[1]?.to).toBe('/projects/p1/findings');
  });

  it('appsec and developer see everything but settings', () => {
    for (const role of ['appsec', 'developer'] as const) {
      const nav = buildNav(meFor(role), 'p1');
      expect(ids(nav.org)).toEqual(['home', 'projects', 'reports', 'integrations']);
      expect(ids(nav.project)).toHaveLength(5);
    }
  });

  it('auditor sees reports only, and no project group', () => {
    const nav = buildNav(meFor('auditor'), 'p1');
    expect(ids(nav.org)).toEqual(['reports']);
    expect(nav.project).toEqual([]);
    expect(nav.knowledge).toEqual([]);
  });

  it('adds project-scope permissions only for that project', () => {
    const me = meFor('auditor', { projectPermissions: { p2: ['findings', 'changes'] } });
    expect(ids(buildNav(me, 'p2').project)).toEqual(['changes', 'findings']);
    expect(buildNav(me, 'p1').project).toEqual([]);
    expect(meCan(me, 'findings')).toBe(false);
    expect(meCan(me, 'findings', 'p2')).toBe(true);
  });

  it('has no project group without a project', () => {
    expect(buildNav(meFor('org_admin'), null).project).toEqual([]);
  });

  it('encodes project ids in links', () => {
    expect(buildNav(meFor('org_admin'), 'a/b').project[0]?.to).toBe('/projects/a%2Fb/changes');
  });

  it('shows nothing without a session', () => {
    const nav = buildNav(null, 'p1');
    expect(nav.org).toEqual([]);
    expect(nav.project).toEqual([]);
  });
});

describe('routing helpers', () => {
  it('lands users on the first allowed page', () => {
    expect(landingPath(meFor('org_admin'), null)).toBe('/');
    expect(landingPath(meFor('auditor'), null)).toBe('/reports');
    expect(landingPath(null, null)).toBe('/login');
    const projOnly = meFor('auditor', { permissions: [], projectPermissions: { p9: ['findings'] } });
    expect(landingPath(projOnly, null)).toBe('/projects/p9/findings');
    expect(landingPath(meFor('auditor', { permissions: [] }), null)).toBeNull();
  });

  it('finds the active item and project id', () => {
    expect(activeNavId('/')).toBe('home');
    expect(activeNavId('/', '#projects')).toBe('projects');
    expect(activeNavId('/projects/p1/findings/f1')).toBe('findings');
    expect(activeNavId('/projects/p1/exposure')).toBe('exposure');
    expect(activeNavId('/settings')).toBe('settings');
    expect(activeNavId('/nope')).toBeNull();
    expect(projectIdFromPath('/projects/a%2Fb/findings')).toBe('a/b');
    expect(projectIdFromPath('/reports')).toBeNull();
  });
});
