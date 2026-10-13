/**
 * Allowed golden differences, read from DECLARED.md: a markdown table with the columns
 *   | Path | Reason | Stage |
 * Path is `<case>/<format> <json path>`. `*` matches one case, one format, or any characters of one
 * path segment; `**` matches anything. A path also covers everything below it ($.coverage covers
 * $.coverage.sources[0].status). For HTML the path is `$.line` (any line) or `$.line[<n>]`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Declared {
  path: string;
  reason: string;
  stage: string;
  match: (scope: string, path: string) => boolean;
}

export const DECLARED_FILE = fileURLToPath(new URL('./DECLARED.md', import.meta.url));

function globToRegex(glob: string, segmentChars: string): string {
  return glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join(`[^${segmentChars}]*`),
    )
    .join('.*');
}

export function parseDeclared(text: string): Declared[] {
  const out: Declared[] = [];
  // Only the table whose header is | Path | Reason | Stage | (other tables in the file are prose).
  let inTable = false;
  for (const line of text.split('\n')) {
    const cells = line.trim().match(/^\|(.*)\|$/)?.[1]?.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
    if (!cells) {
      inTable = false;
      continue;
    }
    if (cells[0] === 'Path' && cells[1] === 'Reason' && cells[2] === 'Stage') {
      inTable = true;
      continue;
    }
    if (!inTable || cells.length < 3) continue;
    const [path, reason, stage] = cells as [string, string, string];
    if (/^:?-+:?$/.test(path) || path === '') continue;
    const m = path.match(/^(\S+)\/(\S+)\s+(\$\S*)$/);
    if (!m) throw new Error(`DECLARED.md: cannot parse path "${path}" (expected "<case>/<format> <json path>")`);
    if (!reason || !stage) throw new Error(`DECLARED.md: "${path}" needs a reason and a stage`);
    const scope = new RegExp(`^${globToRegex(m[1]!, '/')}/${globToRegex(m[2]!, '/')}$`);
    const json = new RegExp(`^${globToRegex(m[3]!, '.\\[\\]')}(?=$|[.\\[])`);
    out.push({ path, reason, stage, match: (s, p) => scope.test(s) && json.test(p) });
  }
  return out;
}

export function loadDeclared(file = DECLARED_FILE): Declared[] {
  return parseDeclared(readFileSync(file, 'utf8'));
}
