/**
 * Tier 0 fixture cases (docs/WHO-BEHIND-PLAN.md, Tier 0): the real repositories of the teardown,
 * pinned to the commits that were scanned, and the slice of each that the fixtures keep.
 */
export interface Tier0Case {
  id: 'parse-server' | 'jitsi-meet' | 'flask' | 'superset';
  /** Directory name under the targets dir given to record.ts. */
  target: string;
  repo: string;
  commit: string;
  /** npm root dependencies kept (runtime / dev). */
  npmRuntime?: readonly string[];
  npmDev?: readonly string[];
  /** jitsi: entries of react-native-sdk/package.json kept (placeholders as committed). */
  sdkEntries?: readonly string[];
  /** flask: uv.lock packages kept (the root project and its runtime, optional and one dev group). */
  uvPackages?: readonly string[];
  /** superset: requirements/base.txt entries kept. */
  requirements?: readonly string[];
}

/** Reference time of the recordings (advisories after it are ignored by replays). */
export const TIER0_NOW = new Date('2026-10-12T00:00:00Z');

export const TIER0_CASES: readonly Tier0Case[] = [
  {
    id: 'parse-server',
    target: 'parse-server',
    repo: 'https://github.com/parse-community/parse-server',
    commit: '23d7bbca9a6c9bdebdb12d166544375a83ef47fc',
    // express → proxy-addr (GHSA-jqcg-44mw-7w3h), body-parser → debug; @parse/push-adapter → web-push →
    // https-proxy-agent → agent-base (runtime). Dev: @babel/core → debug, @semantic-release/github →
    // https-proxy-agent → agent-base, mongodb-runner → … → decompress (GHSA-hrh2-vp3x-79xf), @babel/cli → chokidar → fsevents.
    npmRuntime: ['express', '@parse/push-adapter'],
    npmDev: ['@babel/core', '@babel/cli', '@semantic-release/github', 'mongodb-runner'],
  },
  {
    id: 'jitsi-meet',
    target: 'jitsi-meet',
    repo: 'https://github.com/jitsi/jitsi-meet',
    commit: '36d4c1c7945016ecc588338ac0dff82cd060bbbf',
    npmRuntime: ['@xmldom/xmldom', 'uuid', 'lodash-es'],
    sdkEntries: ['@xmldom/xmldom', 'uuid', 'lodash-es', '@braintree/sanitize-url', 'i18next', '@jitsi/logger'],
  },
  {
    id: 'flask',
    target: 'flask',
    repo: 'https://github.com/pallets/flask',
    commit: 'd086db856be187255b8ec61ef409357393020f32',
    uvPackages: ['flask', 'blinker', 'click', 'colorama', 'itsdangerous', 'jinja2', 'markupsafe', 'werkzeug', 'asgiref', 'python-dotenv', 'ruff'],
  },
  {
    id: 'superset',
    target: 'superset',
    repo: 'https://github.com/apache/superset',
    commit: '42bbfa49079eff910ead01b7880b94d09c5ca520',
    requirements: ['bcrypt', 'cffi', 'cryptography', 'paramiko', 'pycparser', 'pynacl', 'pyxlsb'],
  },
];
