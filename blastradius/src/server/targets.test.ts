import { describe, expect, it } from 'vitest';
import { csrfProblem } from './app.js';
import { badRequest } from './errors.js';
import { safeScanMessage } from './jobs.js';
import { checkGitRef, checkGitTarget, serverCloneArgs } from './targets.js';
import { unversionedPurl } from './graph.js';

describe('git target checks', () => {
  it('normalises allow-listed URLs', () => {
    expect(checkGitTarget('https://gitlab.com/group/sub/repo')).toBe('https://gitlab.com/group/sub/repo');
    expect(checkGitTarget('https://bitbucket.org/team/repo.git')).toBe('https://bitbucket.org/team/repo.git');
  });

  it.each(['https://github.com/a/%2e%2e/b', 'https://github.com/a/./b', 'https://github.com\\a\\b', 'https://github.com.evil.example/a/b', 'https://github.com/-a/b'])(
    'rejects %s',
    (u) => {
      expect(() => checkGitTarget(u)).toThrow();
    },
  );

  it('validates refs', () => {
    expect(checkGitRef('release/1.2')).toBe('release/1.2');
    for (const r of ['-x', 'a..b', 'a b', 'a//b', 'x.lock', '/a', 'a/']) expect(() => checkGitRef(r)).toThrow();
  });

  it('builds a hook-free shallow clone argv with the URL after --', () => {
    const args = serverCloneArgs('https://github.com/a/b', '/tmp/x/repo', 'v1');
    expect(args.slice(0, 4)).toEqual(['-c', 'http.followRedirects=false', '-c', 'lfs.fetchexclude=*']);
    expect(args).toContain('core.hooksPath=/dev/null');
    expect(args.slice(-3)).toEqual(['--', 'https://github.com/a/b', '/tmp/x/repo']);
  });
});

describe('safe scan messages', () => {
  it('strips paths and URLs', () => {
    const m = safeScanMessage(new Error('ENOENT: no such file, open \'/home/me/secret/package.json\' via https://x.example/?token=abc'));
    expect(m).not.toContain('/home/me');
    expect(m).not.toContain('token=abc');
    expect(m.startsWith('Scan failed:')).toBe(true);
  });

  it('passes only ApiHttpError messages through; look-alike plain errors are redacted', () => {
    expect(safeScanMessage(badRequest('Local path must be an existing directory under the allowed scan root', ['target']))).toBe(
      'Local path must be an existing directory under the allowed scan root',
    );
    expect(safeScanMessage(badRequest(`Invalid ${'x'.repeat(300)}`))).toHaveLength(200);
    const leaked = safeScanMessage(new Error("Local path /home/me/secret/repo is not readable: EACCES, open '/home/me/secret/x'"));
    expect(leaked).not.toContain('/home/me');
    expect(leaked.startsWith('Scan failed:')).toBe(true);
    expect(safeScanMessage(new Error('Invalid package.json at /srv/checkouts/abc/package.json'))).not.toContain('/srv/checkouts');
  });
});

describe('csrf rule', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('ignores safe methods and needs X-Requested-With on writes', () => {
    expect(csrfProblem('GET', h({}), 'http://localhost/api/x')).toBeNull();
    expect(csrfProblem('POST', h({}), 'http://localhost/api/x')).not.toBeNull();
    expect(csrfProblem('POST', h({ 'x-requested-with': 'blastradius' }), 'http://localhost/api/x')).toBeNull();
  });
  it('checks Origin against Host', () => {
    expect(csrfProblem('DELETE', h({ 'x-requested-with': 'a', origin: 'http://localhost:8000', host: 'localhost:8000' }), 'http://localhost:8000/api/x')).toBeNull();
    expect(csrfProblem('DELETE', h({ 'x-requested-with': 'a', origin: 'null', host: 'localhost:8000' }), 'http://localhost:8000/api/x')).not.toBeNull();
    expect(csrfProblem('PATCH', h({ 'x-requested-with': 'a', origin: 'https://evil.example', host: 'localhost:8000' }), 'http://localhost:8000/api/x')).not.toBeNull();
  });
});

describe('purl helpers', () => {
  it('strips versions, including scoped names', () => {
    expect(unversionedPurl('pkg:npm/@scope/name@1.2.3')).toBe('pkg:npm/@scope/name');
    expect(unversionedPurl('pkg:npm/ms@2.1.1?x=y')).toBe('pkg:npm/ms');
    expect(unversionedPurl('pkg:npm/ms')).toBe('pkg:npm/ms');
  });
});
