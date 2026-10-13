import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyActionRef, parseUses, parseWorkflow } from './workflows.js';

const fx = (p: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/ingest/${p}`, import.meta.url)), 'utf8');

describe('classifyActionRef', () => {
  it('classifies sha / tag / branch / unpinned', () => {
    expect(classifyActionRef('b4ffde65f46336ab88eb53be808477a3936bae11')).toBe('sha');
    expect(classifyActionRef('v4')).toBe('tag');
    expect(classifyActionRef('v3.24.0')).toBe('tag');
    expect(classifyActionRef('1.2.3-beta.1')).toBe('tag');
    expect(classifyActionRef('main')).toBe('branch');
    expect(classifyActionRef('release/v1')).toBe('branch');
    expect(classifyActionRef(undefined)).toBe('unpinned');
  });
});

describe('parseUses', () => {
  it('builds githubactions purls for actions, sub-path actions and reusable workflows', () => {
    expect(parseUses('actions/checkout@v4', 'j')).toMatchObject({ kind: 'action', purl: 'pkg:githubactions/actions/checkout@v4', pinning: 'tag' });
    expect(parseUses('github/codeql-action/init@v3', 'j')).toMatchObject({ kind: 'action', purl: 'pkg:githubactions/github/codeql-action@v3#init', path: 'init' });
    expect(parseUses('Acme/Shared/.github/workflows/lint.yml@main', 'j')).toMatchObject({
      kind: 'reusable_workflow',
      purl: 'pkg:githubactions/acme/shared@main#.github/workflows/lint.yml',
      pinning: 'branch',
    });
    expect(parseUses('docker://alpine:3.19', 'j')).toMatchObject({ kind: 'docker', purl: 'pkg:docker/library/alpine@3.19', pinning: 'tag' });
    expect(parseUses('./local', 'j')).toMatchObject({ kind: 'local', pinning: 'unpinned' });
    expect(parseUses('../../etc@x', 'j')?.kind).toBe('local');
    expect(parseUses('owner/repo/../x@v1', 'j')).toBeNull();
    expect(parseUses('not-an-action', 'j')).toBeNull();
  });
});

describe('parseWorkflow', () => {
  const ci = parseWorkflow(fx('lock-v3/.github/workflows/ci.yml'), '.github/workflows/ci.yml');

  it('creates a ci workflow asset', () => {
    expect(ci.asset).toMatchObject({ id: 'workflow:.github/workflows/ci.yml', kind: 'workflow', name: 'CI', environment: 'ci', criticality: 3 });
  });

  it('extracts components with mixed pinning', () => {
    const byPurl = Object.fromEntries(ci.components.map((c) => [c.purl, c]));
    expect(byPurl['pkg:githubactions/actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11']?.pinning).toBe('sha');
    expect(byPurl['pkg:githubactions/actions/setup-node@v4']?.pinning).toBe('tag');
    expect(byPurl['pkg:githubactions/tj-actions/changed-files@main']?.pinning).toBe('branch');
    expect(byPurl['pkg:githubactions/github/codeql-action@v3.24.0#init']).toMatchObject({ name: 'github/codeql-action', pinning: 'tag', ecosystem: 'githubactions' });
    expect(byPurl['pkg:githubactions/acme/shared-workflows@v1#.github/workflows/lint.yml']?.pinning).toBe('tag');
    expect(byPurl['pkg:docker/library/alpine@3.19']?.ecosystem).toBe('docker');
    expect(byPurl['pkg:docker/library/node@20']?.pinning).toBe('tag'); // job container
    expect(byPurl['pkg:docker/library/redis@7.2.4']).toBeDefined(); // service
    expect(ci.components).toHaveLength(8);
    for (const e of ci.edges) expect(e).toMatchObject({ from: ci.asset.id, scope: 'build', direct: true });
    expect(ci.edges).toHaveLength(8);
  });

  it('records triggers, permissions and PR-head checkout', () => {
    expect(ci.info.triggers).toEqual(['pull_request_target', 'push']);
    expect(ci.info.privilegedTriggers).toEqual(['pull_request_target']);
    expect(ci.info.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(ci.info.writeScopes).toEqual(['pull-requests']);
    expect(ci.info.hasWriteTokens).toBe(true);
    expect(ci.info.hasOidc).toBe(false);
    expect(ci.info.checksOutPrHead).toBe(true);
    expect(ci.info.secrets).toContain('CODECOV_TOKEN');
    expect(ci.info.jobs.find((j) => j.id === 'lint')?.secrets).toContain('*inherit*');
    expect(ci.info.actions.some((a) => a.kind === 'local')).toBe(true);
    expect(ci.asset.ci).toEqual({ hasWriteTokens: true, hasOidc: false, publishes: false });
  });

  it('detects OIDC and publishing in a release workflow', () => {
    const rel = parseWorkflow(fx('lock-v3/.github/workflows/release.yml'), '.github/workflows/release.yml');
    expect(rel.info.permissionsUndeclared).toBe(false);
    expect(rel.info.writeScopes).toEqual(['contents', 'id-token']);
    expect(rel.asset.ci).toEqual({ hasWriteTokens: true, hasOidc: true, publishes: true });
    expect(rel.info.privilegedTriggers).toEqual([]);
  });

  it('handles write-all, string triggers and undeclared permissions', () => {
    const w = parseWorkflow('on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: "docker push x" }]\n', 'w.yml');
    expect(w.info.triggers).toEqual(['push']);
    expect(w.info.writeScopes).toEqual(['*']);
    expect(w.asset.ci).toEqual({ hasWriteTokens: true, hasOidc: true, publishes: true });
    const u = parseWorkflow('on: [push, workflow_run]\njobs:\n  a:\n    runs-on: x\n', 'u.yml');
    expect(u.info.permissionsUndeclared).toBe(true);
    expect(u.info.privilegedTriggers).toEqual(['workflow_run']);
  });

  it('refuses YAML alias bombs and non-mappings', () => {
    const bomb = 'a: &a ["x","x","x","x","x","x","x","x","x"]\n' + Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`).join('\n');
    expect(() => parseWorkflow(bomb, 'bomb.yml')).toThrow();
    expect(() => parseWorkflow('- just\n- a list\n', 'l.yml')).toThrow(/mapping/);
    expect(() => parseWorkflow('on: [unclosed', 'bad.yml')).toThrow(/invalid YAML/);
  });
});
