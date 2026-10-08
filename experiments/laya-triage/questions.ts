/** Pinned model bundle and the pre-registered questions (LAYA-PREREGISTRATION.md), verbatim. */
export const REPO = 'receptron/laya-onnx';
export const REVISION = '68f27dfe5a27a54fb2b1fefc432f43f972e90868';
export const EXPECTED_SHA256: Record<string, string> = {
  'laya.onnx': 'a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e',
  'laya.onnx.data': '487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba',
};

/** The pre-registered questions, verbatim. */
export const QUESTIONS = {
  takeover: {
    type: 'noul',
    instructions:
      'This state describes a burst of npm releases: one npm account published new versions of at least 5 different packages within 6 hours. Using only these facts, is this burst likely an unauthorized publish by an attacker with a stolen account or token (for example a self-spreading worm), rather than a routine release by the legitimate maintainer or their release automation?',
    criteria: { true: 'unauthorized publish / account takeover', false: 'routine release by the maintainer or automation' },
  },
  kind: {
    type: 'choice',
    instructions: 'What kind of burst is this?',
    criteria: {
      release_automation: 'a release bot or monorepo publishing related packages together',
      maintainer_sweep: 'a maintainer updating many of their own packages, such as dependency or tooling bumps',
      account_takeover: 'an attacker or worm publishing with a stolen token',
    },
  },
  risk: { type: 'score', instructions: 'How suspicious is this burst of npm releases?', criteria: ['no concern', 'minor concern', 'suspicious', 'almost certainly malicious'] },
} as const;
