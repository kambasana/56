/**
 * Minimal TOML reader for the Python lockfiles and manifests ingest reads (uv.lock, poetry.lock,
 * pyproject.toml). It covers what those files use: comments, `[table]` and `[[array.of.tables]]`
 * headers with bare or quoted dotted keys, `key = value` with dotted keys, basic and literal
 * strings (single- and multi-line), integers, floats, booleans, dates (kept as strings), arrays
 * (multi-line, trailing commas) and inline tables.
 *
 * The input is untrusted: nesting depth and sizes are capped, nothing is evaluated, and keys
 * are stored on null-prototype objects so "__proto__" is an ordinary key. Throws TomlError on
 * malformed input; callers turn that into a warning.
 */

export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`TOML line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const MAX_DEPTH = 32;
const MAX_STRING = 1_000_000;

function table(): TomlTable {
  return Object.create(null) as TomlTable;
}

function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

class Reader {
  pos = 0;
  line = 1;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    throw new TomlError(msg, this.line);
  }
  peek(o = 0): string {
    return this.s[this.pos + o] ?? '';
  }
  eof(): boolean {
    return this.pos >= this.s.length;
  }
  next(): string {
    const c = this.s[this.pos++] ?? '';
    if (c === '\n') this.line++;
    return c;
  }
  /** Skip spaces and tabs. */
  ws(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }
  /** Skip whitespace, newlines and comments (inside arrays). */
  wsnl(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.pos++;
      else if (c === '\n') this.next();
      else if (c === '#') this.comment();
      else return;
    }
  }
  comment(): void {
    while (!this.eof() && this.peek() !== '\n') this.pos++;
  }
  /** After a value or header: only a comment or the end of the line may follow. */
  endOfLine(): void {
    this.ws();
    if (this.peek() === '#') this.comment();
    if (this.peek() === '\r') this.pos++;
    if (this.eof()) return;
    if (this.peek() !== '\n') this.fail(`unexpected "${this.peek()}"`);
    this.next();
  }
}

function parseKey(r: Reader): string[] {
  const parts: string[] = [];
  for (;;) {
    r.ws();
    const c = r.peek();
    if (c === '"') parts.push(basicString(r));
    else if (c === "'") parts.push(literalString(r));
    else {
      const start = r.pos;
      while (/[A-Za-z0-9_-]/.test(r.peek())) r.pos++;
      if (r.pos === start) r.fail('expected a key');
      parts.push(r.s.slice(start, r.pos));
    }
    r.ws();
    if (r.peek() !== '.') return parts;
    r.pos++;
  }
}

function hex(r: Reader, n: number): string {
  const h = r.s.slice(r.pos, r.pos + n);
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== n) r.fail('bad unicode escape');
  r.pos += n;
  const cp = parseInt(h, 16);
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) r.fail('bad unicode escape');
  return String.fromCodePoint(cp);
}

function escape(r: Reader): string {
  const c = r.next();
  switch (c) {
    case 'b':
      return '\b';
    case 't':
      return '\t';
    case 'n':
      return '\n';
    case 'f':
      return '\f';
    case 'r':
      return '\r';
    case 'e':
      return '\u001b';
    case '"':
      return '"';
    case '\\':
      return '\\';
    case 'u':
      return hex(r, 4);
    case 'U':
      return hex(r, 8);
    default:
      return r.fail(`bad escape "\\${c}"`);
  }
}

function basicString(r: Reader): string {
  if (r.s.startsWith('"""', r.pos)) {
    r.pos += 3;
    if (r.peek() === '\r') r.pos++;
    if (r.peek() === '\n') r.next();
    let out = '';
    for (;;) {
      if (r.eof()) r.fail('unterminated string');
      if (r.s.startsWith('"""', r.pos)) {
        // Up to two quotes may sit right before the closing delimiter.
        let extra = 0;
        while (r.s[r.pos + 3 + extra] === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        r.pos += 3 + extra;
        return out;
      }
      const c = r.next();
      if (c === '\\') {
        if (/[ \t\r\n]/.test(r.peek())) {
          // Line-ending backslash: trim whitespace up to the next non-blank character.
          while (/[ \t\r\n]/.test(r.peek())) r.next();
          continue;
        }
        out += escape(r);
      } else out += c;
      if (out.length > MAX_STRING) r.fail('string too long');
    }
  }
  r.pos++;
  let out = '';
  for (;;) {
    const c = r.next();
    if (c === '' || c === '\n') r.fail('unterminated string');
    if (c === '"') return out;
    out += c === '\\' ? escape(r) : c;
    if (out.length > MAX_STRING) r.fail('string too long');
  }
}

function literalString(r: Reader): string {
  if (r.s.startsWith("'''", r.pos)) {
    r.pos += 3;
    if (r.peek() === '\r') r.pos++;
    if (r.peek() === '\n') r.next();
    const end = r.s.indexOf("'''", r.pos);
    if (end < 0) r.fail('unterminated string');
    let stop = end;
    while (r.s[stop + 3] === "'" && stop - end < 2) stop++;
    const out = r.s.slice(r.pos, stop);
    for (const ch of out) if (ch === '\n') r.line++;
    r.pos = stop + 3;
    return out;
  }
  r.pos++;
  const start = r.pos;
  while (!r.eof() && r.peek() !== "'" && r.peek() !== '\n') r.pos++;
  if (r.peek() !== "'") r.fail('unterminated string');
  const out = r.s.slice(start, r.pos);
  r.pos++;
  return out;
}

function value(r: Reader, depth: number): TomlValue {
  if (depth > MAX_DEPTH) r.fail('nesting too deep');
  r.ws();
  const c = r.peek();
  if (c === '"') return basicString(r);
  if (c === "'") return literalString(r);
  if (c === '[') {
    r.pos++;
    const arr: TomlValue[] = [];
    for (;;) {
      r.wsnl();
      if (r.peek() === ']') {
        r.pos++;
        return arr;
      }
      arr.push(value(r, depth + 1));
      r.wsnl();
      if (r.peek() === ',') r.pos++;
      else if (r.peek() === ']') {
        r.pos++;
        return arr;
      } else r.fail('expected "," or "]" in array');
    }
  }
  if (c === '{') {
    r.pos++;
    const t = table();
    r.ws();
    if (r.peek() === '}') {
      r.pos++;
      return t;
    }
    for (;;) {
      const key = parseKey(r);
      if (r.next() !== '=') r.fail('expected "=" in inline table');
      setPath(r, t, key, value(r, depth + 1));
      r.ws();
      const d = r.next();
      if (d === '}') return t;
      if (d !== ',') r.fail('expected "," or "}" in inline table');
      r.ws();
      // TOML 1.1 allows a trailing comma.
      if (r.peek() === '}') {
        r.pos++;
        return t;
      }
    }
  }
  // Bare scalar: boolean, number, date/time (kept as text).
  const start = r.pos;
  while (!r.eof() && !/[,\]}\n#\r]/.test(r.peek())) r.pos++;
  const raw = r.s.slice(start, r.pos).trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === '') r.fail('expected a value');
  const num = raw.replace(/_/g, '');
  if (/^[+-]?(0x[0-9a-f]+|0o[0-7]+|0b[01]+)$/i.test(num)) return Number(num.replace(/^\+/, ''));
  if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(num)) return Number(num);
  if (/^[+-]?(inf|nan)$/.test(num)) return num.endsWith('inf') ? (num.startsWith('-') ? -Infinity : Infinity) : NaN;
  if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([Zz]|[+-]\d{2}:\d{2})?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) return raw;
  return r.fail(`bad value "${raw.slice(0, 40)}"`);
}

function setPath(r: Reader, root: TomlTable, key: string[], v: TomlValue): void {
  let t = root;
  for (const k of key.slice(0, -1)) {
    const cur = t[k];
    if (cur === undefined) t = t[k] = table();
    else if (isTable(cur)) t = cur;
    else r.fail(`key "${k}" is not a table`);
  }
  const last = key[key.length - 1]!;
  if (last in t) r.fail(`duplicate key "${last}"`);
  t[last] = v;
}

/** Walk (creating tables) to the table a header names; arrays of tables resolve to their last element. */
function walk(r: Reader, root: TomlTable, key: string[]): TomlTable {
  let t = root;
  for (const k of key) {
    const cur = t[k];
    if (cur === undefined) t = t[k] = table();
    else if (isTable(cur)) t = cur;
    else if (Array.isArray(cur) && cur.length > 0 && isTable(cur[cur.length - 1])) t = cur[cur.length - 1] as TomlTable;
    else r.fail(`key "${k}" is not a table`);
  }
  return t;
}

/** Parse a TOML document. */
export function parseToml(text: string): TomlTable {
  const r = new Reader(text.replace(/^﻿/, ''));
  const root = table();
  let current = root;
  while (!r.eof()) {
    r.wsnl();
    if (r.eof()) break;
    if (r.peek() === '[') {
      const arrayTable = r.peek(1) === '[';
      r.pos += arrayTable ? 2 : 1;
      const key = parseKey(r);
      if (r.next() !== ']' || (arrayTable && r.next() !== ']')) r.fail('bad table header');
      if (arrayTable) {
        const parent = walk(r, root, key.slice(0, -1));
        const last = key[key.length - 1]!;
        const list = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(list)) return r.fail(`key "${last}" is not an array of tables`);
        const t = table();
        list.push(t);
        current = t;
      } else current = walk(r, root, key);
      r.endOfLine();
      continue;
    }
    const key = parseKey(r);
    r.ws();
    if (r.next() !== '=') r.fail('expected "="');
    setPath(r, current, key, value(r, 0));
    r.endOfLine();
  }
  return root;
}

/** Typed accessors for untrusted TOML. */
export function tomlTable(v: unknown): TomlTable | undefined {
  return isTable(v) ? v : undefined;
}
export function tomlString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function tomlArray(v: unknown): TomlValue[] {
  return Array.isArray(v) ? v : [];
}
