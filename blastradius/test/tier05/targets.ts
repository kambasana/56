/**
 * Tier 0.5 fixture cases (docs/WHO-BEHIND-PLAN.md §11, "Tier 0.5"): slices of the teardown
 * repositories at the commits that were scanned (scans/target-commits.txt), chosen so the packages
 * the independent verification named are in them, with the real dependency paths that bring them in.
 */
export interface Tier05Part {
  /** Directory of the manifest in the repository ('' = root). */
  dir: string;
  /** Root dependencies kept, by the section the real package.json declares them in. */
  runtime: readonly string[];
  dev?: readonly string[];
}

export interface Tier05Case {
  id: 'parse-server' | 'jitsi-meet' | 'superset';
  repo: string;
  commit: string;
  parts: readonly Tier05Part[];
  /**
   * npm packuments kept in the fixture (the rest are left out to keep it small: those packages get
   * no registry facts in the replays, OSV and deps.dev answers are kept for every package). Names,
   * or `closure:<root>` for every package the root brings in.
   */
  packuments: readonly string[];
}

/** Reference time of the recordings: the day of the verification scans. */
export const TIER05_NOW = new Date('2026-10-12T00:00:00Z');

export const TIER05_CASES: readonly Tier05Case[] = [
  {
    id: 'parse-server',
    repo: 'https://github.com/parse-community/parse-server',
    commit: '23d7bbca9a6c9bdebdb12d166544375a83ef47fc',
    // express → proxy-addr / forwarded; @parse/push-adapter → firebase-admin (optional) → uuid 9.0.1;
    // mongodb → mongodb-connection-string-url 7.0.2; ws 8.21.3; madge (dev) → @typescript-eslint/* 7.18.0.
    parts: [{ dir: '', runtime: ['express', '@parse/push-adapter', 'mongodb', 'ws'], dev: ['madge'] }],
    packuments: [
      'closure:express',
      'mongodb-connection-string-url',
      'ws',
      'uuid',
      'firebase-admin',
      '@parse/push-adapter',
      '@typescript-eslint/types',
      '@typescript-eslint/typescript-estree',
      '@typescript-eslint/visitor-keys',
      'agent-base',
    ],
  },
  {
    id: 'jitsi-meet',
    repo: 'https://github.com/jitsi/jitsi-meet',
    commit: '36d4c1c7945016ecc588338ac0dff82cd060bbbf',
    // react-native-screens 4.23.0 (direct, and a peer of @react-navigation/*); ts-ebml → bigint-buffer 1.1.5;
    // @svgr/webpack → svgo 2.8.3; react-native-svg-transformer → svgo 3.3.4; @jitsi/eslint-config (dev) →
    // @typescript-eslint/* 8.19.1.
    parts: [
      {
        dir: '',
        runtime: ['react-native-screens', '@react-navigation/stack', '@react-navigation/bottom-tabs', 'ts-ebml', '@svgr/webpack', 'react-native-svg-transformer'],
        dev: ['@jitsi/eslint-config'],
      },
    ],
    packuments: ['react-native-screens', 'svgo', 'bigint-buffer', 'ts-ebml', '@typescript-eslint/types', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'fast-uri'],
  },
  {
    id: 'superset',
    repo: 'https://github.com/apache/superset',
    commit: '42bbfa49079eff910ead01b7880b94d09c5ca520',
    // superset-frontend: xlsx 0.20.3 (from cdn.sheetjs.com), antd → @rc-component/* and moment,
    // @rjsf/validator-ajv8 → ajv → fast-uri 3.1.8. client-ws-app: express → proxy-addr 2.0.8, forwarded, negotiator.
    parts: [
      { dir: 'superset-frontend', runtime: ['xlsx', 'antd', '@rjsf/validator-ajv8'] },
      { dir: 'superset-websocket/utils/client-ws-app', runtime: ['express'] },
    ],
    packuments: ['closure:express', 'closure:antd', 'xlsx', 'fast-uri', 'ajv'],
  },
];
