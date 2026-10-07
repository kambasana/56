import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../../src/features/store.js';
import { DATA_DIR } from '../replay/server.js';
import { baseline, gateVerdict } from './gate.js';

const H = 3_600_000;

describe('backtest gate', () => {
  it('needs strictly better recall and noise for a pass; Pareto is reported separately', () => {
    const base = { recall: 0.5, noiseAtRelease: 10, noiseOnScanDay: 5 };
    expect(gateVerdict({ recall: 0.6, noiseAtRelease: 9, noiseOnScanDay: 4 }, base)).toMatchObject({ strict: true, pareto: true });
    expect(gateVerdict({ recall: 0.5, noiseAtRelease: 9, noiseOnScanDay: 4 }, base)).toMatchObject({ strict: false, pareto: true });
    expect(gateVerdict({ recall: 0.9, noiseAtRelease: 1, noiseOnScanDay: 6 }, base)).toMatchObject({ strict: false, pareto: false });
  });

  it('the baseline is the scan-time noisy-OR on the same packuments (replay data, offline)', () => {
    const store = openStore({ overlayDir: join(DATA_DIR, 'registry') });
    const at = (name: string, v: string) => new Date(Date.parse(store.get(name)!.time![v] as string) + H);
    expect(baseline(store, 'ua-parser-js', '0.7.29', at('ua-parser-js', '0.7.29'))).toMatchObject({ flagged: true, detail: 'install_script' });
    expect(baseline(store, 'nx', '21.5.0', at('nx', '21.5.0'))?.detail).toContain('provenance_dropped');
    expect(baseline(store, 'debug', '4.4.2', at('debug', '4.4.2'))).toMatchObject({ flagged: false });
    expect(baseline(store, 'debug', '0.0.0-nope', new Date())).toBeUndefined();
  });
});
