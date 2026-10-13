import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkGitUrl, cloneArgs, cloneEnv, cloneRepo, looksLikeGitUrl } from './git.js';

describe('git URL policy', () => {
  it('accepts https, ssh and scp-like URLs', () => {
    expect(checkGitUrl('https://github.com/o/r.git')).toBeNull();
    expect(checkGitUrl('ssh://git@github.com/o/r.git')).toBeNull();
    expect(checkGitUrl('git@github.com:o/r.git')).toBeNull();
  });

  it('refuses other schemes and injection attempts', () => {
    expect(checkGitUrl('http://github.com/o/r')).toMatch(/not allowed/);
    expect(checkGitUrl('file:///etc')).toMatch(/not allowed/);
    expect(checkGitUrl('git://github.com/o/r')).toMatch(/not allowed/);
    expect(checkGitUrl('ext::sh -c touch% /tmp/pwned')).not.toBeNull();
    expect(checkGitUrl('--upload-pack=touch /tmp/x')).not.toBeNull();
    expect(checkGitUrl('https://user:pass@github.com/o/r')).toMatch(/credentials/);
  });

  it('distinguishes URLs from local paths', () => {
    expect(looksLikeGitUrl('https://github.com/o/r')).toBe(true);
    expect(looksLikeGitUrl('git@github.com:o/r.git')).toBe(true);
    expect(looksLikeGitUrl('ext::sh')).toBe(true);
    expect(looksLikeGitUrl('./some/dir')).toBe(false);
    expect(looksLikeGitUrl('/abs/dir')).toBe(false);
  });
});

describe('cloneRepo', () => {
  it('runs a shallow, hook-free clone with an argument array', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const res = await cloneRepo('https://github.com/o/r.git', {
      runner: async (args, opts) => {
        calls.push({ args, env: opts.env });
      },
    });
    try {
      expect(calls).toHaveLength(1);
      const args = calls[0]!.args;
      expect(args).toEqual(cloneArgs('https://github.com/o/r.git', res.dir));
      expect(args).toContain('--depth');
      expect(args[args.indexOf('--depth') + 1]).toBe('1');
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args.indexOf('--')).toBe(args.length - 3);
      expect(calls[0]!.env.GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      await res.cleanup();
    }
    expect(existsSync(res.dir)).toBe(false);
  });

  it('refuses disallowed URLs without running git', async () => {
    let ran = false;
    await expect(cloneRepo('file:///etc', { runner: async () => void (ran = true) })).rejects.toThrow(/refusing/);
    expect(ran).toBe(false);
  });

  it('builds a minimal environment', () => {
    const env = cloneEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y' });
    expect(env.PATH).toBe('/bin');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
