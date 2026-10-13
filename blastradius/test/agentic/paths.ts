import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Recorded pages, registry documents, synthetic pages and model replays for the agentic tests. */
export const AGENTIC_FIXTURES = join(HERE, '..', 'fixtures', 'agentic');
/** Hand-written model turns (no API key here); every page and registry document they lead to is recorded. */
export const STUBBED = join(AGENTIC_FIXTURES, 'model', 'stubbed.json');
