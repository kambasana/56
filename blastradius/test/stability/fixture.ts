/**
 * Recorded stability fixtures (record.ts writes them, stability.test.ts replays them offline).
 *   - subjects.json: per §8 subject, the trimmed npm packument, the source repository and the
 *     deps.dev / Scorecard Maintained check; history/<slug>.json: histories recorded in P3 (the
 *     P2 format plus `npmPublishers`); P2 histories are reused from test/fixtures/history/recorded/.
 *   - control.json.gz: the same for every production npm dependency of the control repositories.
 * No e-mail address, name or per-person time zone is in these files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { HistoryRecord } from '../../src/history/record.js';
import { decodeFixture, loadFixture, type HistoryFixture } from '../history/fixture.js';

export const STABILITY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'stability', 'recorded');

export interface RecordedPackage {
  name: string;
  /** Versions in use (subjects: the gate version; control: the locked versions in production). */
  versions: string[];
  packument: Record<string, any>;
  repo?: { url: string; directory?: string };
  /** Size of versions in use the registry has no dist.unpackedSize for, read from the tarball (--augment). */
  tarballs?: Record<string, { unpackedSize: number; fileCount: number }>;
  /** OSV records affecting each version in use, trimmed (--augment). Absent: advisories not recorded. */
  osv?: Record<string, Record<string, any>[]>;
}

export interface ControlFixture {
  _note: string;
  recordedAt: string;
  packages: Record<string, RecordedPackage>;
  /** deps.dev project (Scorecard) per repository key. */
  projects: Record<string, Record<string, any>>;
  /** Pseudonymised histories per repository key (src/enrich/history repository key). */
  histories: Record<string, HistoryFixture>;
  /** Repositories that could not be read, with git's message. */
  historyErrors: Record<string, string>;
  /** When --augment added the size and OSV inputs. */
  augmentedAt?: string;
}

export interface SubjectsFixture {
  _note: string;
  recordedAt: string;
  packages: Record<string, RecordedPackage & { project?: Record<string, any>; historyError?: string }>;
}

export function loadSubjects(): SubjectsFixture {
  return JSON.parse(readFileSync(join(STABILITY_DIR, 'subjects.json'), 'utf8')) as SubjectsFixture;
}

/** A subject's history: recorded in P3 (history/<slug>.json) or the P2 fixture. */
export function subjectHistory(history: { p2: string } | { record: string } | null, slug: string): HistoryRecord | undefined {
  if (!history) return undefined;
  if ('p2' in history) return loadFixture(history.p2).record;
  const file = join(STABILITY_DIR, 'history', `${slug}.json`);
  return existsSync(file) ? decodeFixture(JSON.parse(readFileSync(file, 'utf8')) as HistoryFixture) : undefined;
}

export function loadControl(): ControlFixture {
  return JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, 'control.json.gz'))).toString('utf8')) as ControlFixture;
}
