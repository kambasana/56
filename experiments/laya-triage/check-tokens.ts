/**
 * Truncation check (LAYA-PREREGISTRATION.md): for each state and each question, how many state tokens
 * fit in max_len after the question header, and whether everything up to and including `aggregates`
 * (i.e. all but the per-package list) fits. Tokenizer only, no model run. Writes results/tokens.json.
 *
 *   LAYA_MODEL_DIR=<bundle dir> npx tsx check-tokens.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
// Internal module of the pinned runtime: the exact serializer and sequence builder it uses.
import { buildSequence, pyJsonDumps, toInternal } from './node_modules/@receptron/laya/dist/sequence.js';
import type { TriagePoint } from './build-states.ts';
import { QUESTIONS } from './questions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, 'results');
const dir = process.env.LAYA_MODEL_DIR;
if (!dir) throw new Error('set LAYA_MODEL_DIR');
const tok = new Tokenizer(JSON.parse(readFileSync(join(dir, 'tokenizer/tokenizer.json'), 'utf8')), JSON.parse(readFileSync(join(dir, 'tokenizer/tokenizer_config.json'), 'utf8')));
const cfg = JSON.parse(readFileSync(join(dir, 'laya_config.json'), 'utf8')) as { max_len: number; head_max_len: number };
const id = (t: string) => tok.token_to_id(t)!;
const ids = { cls: id('[CLS]'), sep: id('[SEP]'), mask: id('[MASK]'), pad: id('[PAD]'), maskTok: '[MASK]' };
const encode = (s: string) => tok.encode(s, { add_special_tokens: false }).ids as number[];

const points = readFileSync(join(RES, 'states.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TriagePoint);
const out: Record<string, { stateTokens: number; prefixTokens: number; room: number; aggregatesFit: boolean; fullStateFits: boolean }> = {};
for (const [qid, q] of Object.entries(QUESTIONS)) {
  const internal = toInternal(q as never);
  const empty = buildSequence(encode, ids, '', internal, cfg.max_len, cfg.head_max_len).ids.length;
  const room = cfg.max_len - empty; // state tokens that fit (the sequence ends with [SEP])
  let aggregatesFit = 0;
  let fullFits = 0;
  let maxState = 0;
  let maxPrefix = 0;
  for (const p of points) {
    const full = pyJsonDumps(p.state);
    const prefix = full.slice(0, full.indexOf('"packages": '));
    const n = encode(full).length;
    const k = encode(prefix).length;
    maxState = Math.max(maxState, n);
    maxPrefix = Math.max(maxPrefix, k);
    if (k <= room) aggregatesFit++;
    if (n <= room) fullFits++;
  }
  out[qid] = { stateTokens: maxState, prefixTokens: maxPrefix, room, aggregatesFit: aggregatesFit === points.length, fullStateFits: fullFits === points.length };
  console.log(`${qid}: room ${room} state tokens; states fully inside ${fullFits}/${points.length}; up to aggregates inside ${aggregatesFit}/${points.length}; max state ${maxState}, max prefix ${maxPrefix}`);
}
writeFileSync(join(RES, 'tokens.json'), `${JSON.stringify(out, null, 1)}\n`);
