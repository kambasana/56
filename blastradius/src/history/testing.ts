/**
 * Test helper: a small local git repository with known people, emails, time zones, a .mailmap,
 * a bot, a version commit, tags and a commit carrying a signature header. Built with git itself;
 * the signature is a placeholder header (only its presence is read, never verified).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LOCAL_PEOPLE = {
  alice: { name: 'Alice Example', email: 'alice.secret@example.org', oldEmail: 'Alice.Old@Example.org', tz: '+0300' },
  bob: { name: 'Bob Example', email: 'bob.hidden@example.net', tz: '+0800' },
  carol: { name: 'Carol Example', email: '12345+carol-gh@users.noreply.github.com', tz: '-0500' },
  bot: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com', tz: '+0000' },
} as const;

/** Every clear-text string about a person that must never leave memory. */
export const LOCAL_SECRETS = ['alice.secret@example.org', 'alice.old@example.org', 'Alice.Old@Example.org', 'bob.hidden@example.net', 'Alice Example', 'Bob Example', 'Carol Example', 'example.org', 'example.net'];

export function makeLocalRepo(dir: string): { dir: string; head: string } {
  mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: string[], extra: Record<string, string> = {}, input?: string) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: dir, env: { ...env, ...extra }, input, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  let n = 0;
  const commit = (who: { name: string; email: string; tz: string }, date: string, msg?: string) => {
    n++;
    writeFileSync(path.join(dir, 'file.txt'), `change ${n}\n`);
    git(['add', 'file.txt']);
    const when = `${date}T10:00:00${who.tz}`;
    git(['commit', '-q', '-m', msg ?? `change ${n}`], { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: when });
  };
  const { alice, bob, carol, bot } = LOCAL_PEOPLE;
  // Alice's early commits use an old address that the .mailmap maps to her current one.
  for (let i = 0; i < 5; i++) commit({ ...alice, email: alice.oldEmail }, `2023-0${i + 1}-10`);
  writeFileSync(path.join(dir, '.mailmap'), `${alice.name} <${alice.email}> <${alice.oldEmail.toLowerCase()}>\n${alice.name} <${alice.email}> <${alice.oldEmail}>\n`);
  git(['add', '.mailmap']);
  for (let i = 0; i < 20; i++) commit(alice, `2024-${String((i % 12) + 1).padStart(2, '0')}-${String(10 + (i % 15)).padStart(2, '0')}`);
  for (let i = 0; i < 8; i++) commit(bob, `2025-0${(i % 9) + 1}-05`);
  commit(bob, '2025-09-20', '1.0.1');
  for (let i = 0; i < 3; i++) commit(carol, `2025-0${i + 4}-15`);
  for (let i = 0; i < 2; i++) commit(bot, `2025-0${i + 6}-01`);
  // Annotated tag by Alice, lightweight tag on the version commit.
  git(['tag', '-a', 'v1.0.0', '-m', 'release 1.0.0', 'HEAD~6'], { GIT_COMMITTER_NAME: alice.name, GIT_COMMITTER_EMAIL: alice.email, GIT_COMMITTER_DATE: `2025-09-01T12:00:00${alice.tz}` });
  git(['tag', 'v1.0.1', 'HEAD~5']);
  // A commit with a signature header (git log --pretty=raw shows it; nothing verifies it here).
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const parent = git(['rev-parse', 'HEAD']);
  const t = Math.floor(Date.parse('2025-10-01T10:00:00Z') / 1000);
  const raw = [
    `tree ${tree}`,
    `parent ${parent}`,
    `author ${alice.name} <${alice.email}> ${t} ${alice.tz}`,
    `committer ${alice.name} <${alice.email}> ${t} ${alice.tz}`,
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' placeholder',
    ' -----END PGP SIGNATURE-----',
    '',
    'signed change',
    '',
  ].join('\n');
  const signed = git(['hash-object', '-t', 'commit', '-w', '--stdin'], {}, raw);
  git(['update-ref', 'refs/heads/main', signed]);
  return { dir, head: signed };
}
