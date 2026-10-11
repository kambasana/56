/**
 * Types for the CommonJS SPDX packages we use (they ship no typings). Shapes from their READMEs:
 * https://github.com/jslicense/spdx-expression-parse.js, https://github.com/jslicense/spdx-correct.js,
 * https://github.com/jslicense/spdx-satisfies.js
 */
declare module 'spdx-expression-parse' {
  export type SpdxLeaf = { license: string; plus?: true; exception?: string };
  export type SpdxNode = SpdxLeaf | { left: SpdxNode; conjunction: 'and' | 'or'; right: SpdxNode };
  /** Throws on an invalid expression. */
  export default function parse(source: string): SpdxNode;
}

declare module 'spdx-correct' {
  /** A valid SPDX expression for a misspelled one, or null. */
  export default function correct(source: string, options?: { upgrade?: boolean }): string | null;
}

declare module 'spdx-satisfies' {
  /** True when the expression is satisfied by the approved licence ids. */
  export default function satisfies(expression: string, approved: string[]): boolean;
}

declare module 'spdx-license-ids/deprecated.json' {
  const ids: string[];
  export default ids;
}
