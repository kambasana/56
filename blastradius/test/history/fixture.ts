/**
 * Test helpers for the recorded git history fixtures; the compact format itself is in
 * src/history/fixture.ts (the dev-seed replay reads it too).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryRecord } from '../../src/history/record.js';
import { decodeFixture, type HistoryFixture } from '../../src/history/fixture.js';

export { decodeFixture, encodeFixture, type HistoryFixture } from '../../src/history/fixture.js';

export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'history', 'recorded');

export function loadFixture(slug: string): { fixture: HistoryFixture; record: HistoryRecord } {
  const fixture = JSON.parse(readFileSync(join(RECORDED_DIR, `${slug}.json`), 'utf8')) as HistoryFixture;
  return { fixture, record: decodeFixture(fixture) };
}
