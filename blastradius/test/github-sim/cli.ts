/**
 * GitHub simulator CLI (dev only; docs/CONNECTORS.md "Develop against the simulator").
 *
 *   npm run sim:github                         start it (port 8787), seeded with the default org
 *   npm run sim:github -- state                what it holds, and every webhook it sent
 *   npm run sim:github -- install acme-sim --repos a11y-map,mocha   (or --all)
 *   npm run sim:github -- add-repo <installation> acme-sim/logops
 *   npm run sim:github -- push acme-sim/a11y-map --bump ua-parser-js@0.7.29
 *   npm run sim:github -- push acme-sim/a11y-map --file README.md="# hi"
 *   npm run sim:github -- revoke <installation>     (also suspend / unsuspend)
 *   npm run sim:github -- forge [--unsigned]        a webhook with a bad (or no) signature
 *   npm run sim:github -- replay [delivery-id]      a delivery sent again, byte for byte
 *
 * `serve` writes a throwaway App key and an env file for `blastradius serve`; every other
 * command calls the running simulator's /_sim control API.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { seedScenario } from './scenario.js';
import { GitHubSim } from './sim.js';

const program = new Command('sim:github').description('Local GitHub simulator for the Blastradius GitHub App connector');
const DEFAULT_SIM = process.env.BLASTRADIUS_GITHUB_SIM_URL ?? 'http://127.0.0.1:8787';

async function control(sim: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${sim.replace(/\/$/, '')}/_sim${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const out = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(out)}`);
  return out;
}

const print = (x: unknown): void => {
  process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
};

program
  .command('serve', { isDefault: true })
  .description('start the simulator (seeded with org acme-sim: forks of the replay org repos and mocha)')
  .option('--port <n>', 'port', '8787')
  .option('--host <h>', 'bind address (loopback only by default)', '127.0.0.1')
  .option('--blastradius <url>', 'the Blastradius server webhooks and the install callback go to', 'http://127.0.0.1:8000')
  .option('--no-seed', 'start empty (no orgs or repos)')
  .option('--write-env <path>', 'where to write the env file for blastradius serve (default: a new temp dir)')
  .action(async (o: { port: string; host: string; blastradius: string; seed: boolean; writeEnv?: string }) => {
    const br = o.blastradius.replace(/\/$/, '');
    const sim = new GitHubSim({ host: o.host, port: Number(o.port), hookUrl: `${br}/api/hooks/github`, callbackUrl: `${br}/api/sources/github/callback`, log: (m) => process.stderr.write(`${m}\n`) });
    await sim.start();
    if (o.seed) await seedScenario(sim);
    const dir = mkdtempSync(join(tmpdir(), 'blastradius-github-sim-'));
    const keyFile = join(dir, 'app-key.pem');
    writeFileSync(keyFile, sim.key.privateKey, { mode: 0o600 });
    const { BLASTRADIUS_GITHUB_PRIVATE_KEY: _pem, ...env } = sim.env();
    const lines = Object.entries({ ...env, BLASTRADIUS_GITHUB_PRIVATE_KEY_FILE: keyFile }).map(([k, v]) => `${k}=${v}`);
    const envFile = o.writeEnv ?? join(dir, 'blastradius.env');
    writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    process.stdout.write(
      [
        `GitHub simulator on ${sim.urls.web}  (API ${sim.urls.api}, raw ${sim.urls.raw}, control ${sim.urls.web}/_sim/state)`,
        `App "${sim.appMeta.name}" (id ${sim.appMeta.id}); a throwaway key and secrets for this run only.`,
        `Webhooks → ${sim.hookUrl}`,
        `Install callback → ${sim.callbackUrl}`,
        '',
        `Env for blastradius serve (also in ${envFile}):`,
        ...lines.map((l) => `  ${l.startsWith('BLASTRADIUS_GITHUB_WEBHOOK_SECRET=') || l.startsWith('BLASTRADIUS_GITHUB_CLIENT_SECRET=') ? `${l.split('=')[0]}=<in the env file>` : l}`),
        '',
        'Run Blastradius against it (another terminal, in blastradius/):',
        `  set -a; . ${envFile}; set +a; NO_PROXY="127.0.0.1,localhost,$NO_PROXY" npm start -- serve --dev-seed`,
        `Then: sign in as admin@local, POST /api/sources {"host":"github"}, open the installUrl (this simulator's install page).`,
        `Scenario commands: npm run sim:github -- --help`,
        '',
      ].join('\n'),
    );
    const stop = async () => {
      await sim.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  });

const withSim = (c: Command) => c.option('--sim <url>', 'simulator base URL', DEFAULT_SIM);

withSim(program.command('state').description('orgs, repos, installations and webhook deliveries')).action(async (o: { sim: string }) => print(await control(o.sim, 'GET', '/state')));

withSim(program.command('create-repo <fullName>').description('create a repo (owner/name), optionally a fork of a recorded real repo'))
  .option('--from <real>', 'recorded real repo (test/fixtures/sources), e.g. Esri/a11y-map')
  .option('--private', 'private repository')
  .action(async (fullName: string, o: { sim: string; from?: string; private?: boolean }) => {
    const [owner, name] = fullName.split('/');
    print(await control(o.sim, 'POST', '/repos', { owner, name, ...(o.from ? { from: o.from } : {}), ...(o.private ? { private: true } : {}) }));
  });

withSim(program.command('install <account>').description('install the App on an account without going through Blastradius (sends installation.created)'))
  .option('--all', 'all repositories')
  .option('--repos <names>', 'comma-separated repo names (selected)')
  .option('--by <user>', 'installing user')
  .action(async (account: string, o: { sim: string; all?: boolean; repos?: string; by?: string }) =>
    print(await control(o.sim, 'POST', '/installations', { account, selection: o.all || !o.repos ? 'all' : 'selected', repos: o.repos ? o.repos.split(',') : [], ...(o.by ? { by: o.by } : {}) })),
  );

withSim(program.command('add-repo <installation> <repo>').description('add a repo to a selected installation (installation_repositories.added)')).action(async (id: string, repo: string, o: { sim: string }) =>
  print(await control(o.sim, 'POST', `/installations/${id}/repositories`, { repo })),
);

withSim(program.command('remove-repo <installation> <repo>').description('remove a repo from an installation (installation_repositories.removed)')).action(async (id: string, repo: string, o: { sim: string }) =>
  print(await control(o.sim, 'DELETE', `/installations/${id}/repositories/${repo}`)),
);

withSim(program.command('push <repo>').description('push one commit to the default branch (signed push webhook)'))
  .option('--bump <spec>', 'add or bump a dependency in package.json and package-lock.json, e.g. ua-parser-js@0.7.29')
  .option('--dev', 'as a devDependency')
  .option('--file <path=content...>', 'write a file (repeatable); an empty content after = deletes it')
  .option('--branch <name>', 'branch (default: the default branch)')
  .option('--message <m>', 'commit message')
  .action(async (repo: string, o: { sim: string; bump?: string; dev?: boolean; file?: string[]; branch?: string; message?: string }) => {
    const files = Object.fromEntries((o.file ?? []).map((f) => {
      const i = f.indexOf('=');
      const content = f.slice(i + 1);
      return [f.slice(0, i), content === '' ? null : `${content.replace(/\\n/g, '\n')}\n`];
    }));
    print(await control(o.sim, 'POST', '/push', { repo, ...(o.bump ? { bump: o.bump } : {}), ...(o.dev ? { dev: true } : {}), ...(o.file ? { files } : {}), ...(o.branch ? { branch: o.branch } : {}), ...(o.message ? { message: o.message } : {}) }));
  });

for (const action of ['revoke', 'suspend', 'unsuspend'] as const) {
  withSim(program.command(`${action} <installation>`).description(action === 'revoke' ? 'uninstall the App (tokens stop working; installation.deleted)' : `${action} the installation`)).action(async (id: string, o: { sim: string }) =>
    print(await control(o.sim, 'POST', `/installations/${id}/${action}`)),
  );
}

withSim(program.command('forge').description('send a webhook signed with the wrong secret (or unsigned)'))
  .option('--unsigned', 'no signature at all')
  .option('--event <name>', 'event', 'push')
  .option('--repo <repo>', 'repository for a push')
  .action(async (o: { sim: string; unsigned?: boolean; event: string; repo?: string }) => print(await control(o.sim, 'POST', '/webhooks/forge', { event: o.event, unsigned: Boolean(o.unsigned), ...(o.repo ? { repo: o.repo } : {}) })));

withSim(program.command('replay [delivery]').description('send a delivery again, byte for byte (default: the last validly signed one)')).action(async (id: string | undefined, o: { sim: string }) =>
  print(await control(o.sim, 'POST', '/webhooks/replay', id ? { id } : {})),
);

withSim(program.command('code [user]').description('an OAuth code for a user (to try a forged callback)')).action(async (user: string | undefined, o: { sim: string }) =>
  print(await control(o.sim, 'POST', '/oauth-code', user ? { user } : {})),
);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
