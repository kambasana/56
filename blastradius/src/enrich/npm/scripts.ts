/**
 * Static inspection of npm lifecycle scripts. The script text is untrusted and
 * is only ever matched with regular expressions — never executed, never passed
 * to a shell.
 */
import type { InstallScriptFlag } from '../../core/install-flags.js';
import type { InstallHook } from '../../core/types.js';
import { isObject } from './registry.js';
import type { NpmInstallScriptValue } from './types.js';

/** Hooks npm runs when a registry tarball is installed (`prepare` does not run for registry installs). */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const satisfies readonly InstallHook[];

export const MAX_COMMAND_CHARS = 500;
/** Inputs longer than this are truncated before pattern matching (bounds regex cost). */
const MAX_SCAN_CHARS = 20_000;

/** Flag → patterns. Flags are hints for reviewers, not verdicts. */
const FLAG_PATTERNS: [flag: InstallScriptFlag, patterns: RegExp[]][] = [
  [
    'network',
    [
      /\b(curl|wget|nc|ncat|netcat|ftp|tftp|scp)\b/i,
      /\bInvoke-(WebRequest|RestMethod)\b|\biwr\b|\bbitsadmin\b|\bcertutil\b[^\n]*-urlcache/i,
      /\bhttps?:\/\//i,
      /\brequire\(\s*['"](https?|net|dgram|dns)['"]\s*\)/,
      /\bfetch\s*\(/,
      /\b\d{1,3}(\.\d{1,3}){3}(:\d{2,5})?\b/,
    ],
  ],
  [
    'obfuscated',
    [
      /[A-Za-z0-9+/]{120,}={0,2}/, // long base64-looking run
      /(\\x[0-9a-f]{2}){8,}/i,
      /(\\u[0-9a-f]{4}){8,}/i,
      /\bString\.fromCharCode\b/,
      /\batob\s*\(|Buffer\.from\([^)]*['"](base64|hex)['"]/,
      /\bbase64\s+(-d|--decode)\b/,
    ],
  ],
  ['eval', [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bnode\s+(-e|--eval|-p|--print)\b/]],
  ['pipe_to_shell', [/\|\s*(ba|z|da)?sh\b/, /\|\s*(node|python3?|perl|ruby|powershell|pwsh)\b/i]],
  ['background_process', [/\bstart\s+\/B\b/i, /\bnohup\b/, /&\s*$/m, /\bdisown\b/, /\bsetsid\b/]],
  ['env_access', [/\bprocess\.env\b/, /\$\{?(NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|AWS_[A-Z_]+|HOME)\b/, /%[A-Z_]*TOKEN%/]],
  ['credential_files', [/\.npmrc\b/, /\.ssh\b|id_rsa/, /\.aws\/credentials/, /\.git-credentials/]],
  ['runs_package_file', [/\bnode\s+(?!-)[\w./-]+\.(c|m)?js\b/, /\b(sh|bash)\s+[\w./-]+\.sh\b/, /\.(exe|bat|cmd|ps1)\b/i]],
  ['native_build', [/\bnode-gyp\b|\bprebuild(-install)?\b|\bnode-pre-gyp\b|\bcmake-js\b/]],
];

/** Static flags for one command string. Sorted, de-duplicated. */
export function scriptFlags(command: string): InstallScriptFlag[] {
  const text = command.slice(0, MAX_SCAN_CHARS);
  const flags = new Set<InstallScriptFlag>();
  for (const [flag, patterns] of FLAG_PATTERNS) if (patterns.some((re) => re.test(text))) flags.add(flag);
  if (command.length > MAX_COMMAND_CHARS) flags.add('long_command');
  return [...flags].sort();
}

/**
 * Build an install_script value from a manifest's `scripts` field.
 * `gypfile` (binding.gyp present) implies an implicit `node-gyp rebuild` install hook, which npm
 * adds only when the package defines neither an `install` nor a `preinstall` script
 * (@npmcli/package-json normalize, `gypfile` step).
 */
export function analyzeInstallScripts(scripts: unknown, opts: { gypfile?: boolean; registryFlag?: boolean } = {}): NpmInstallScriptValue {
  const hooks: InstallHook[] = [];
  const commands: Partial<Record<InstallHook, string>> = {};
  const lengths: Partial<Record<InstallHook, number>> = {};
  const flags = new Set<InstallScriptFlag>();
  const s = isObject(scripts) ? scripts : {};
  for (const hook of INSTALL_HOOKS) {
    const cmd = s[hook];
    if (typeof cmd !== 'string' || cmd.trim() === '') continue;
    hooks.push(hook);
    commands[hook] = cmd.slice(0, MAX_COMMAND_CHARS);
    lengths[hook] = cmd.length;
    for (const f of scriptFlags(cmd)) flags.add(f);
  }
  if (opts.gypfile && !hooks.includes('install') && !hooks.includes('preinstall')) {
    hooks.push('install');
    commands.install = 'node-gyp rebuild';
    lengths.install = 'node-gyp rebuild'.length;
    flags.add('native_build');
    flags.add('implicit_gyp');
  }
  const value: NpmInstallScriptValue = {
    hasInstallScript: hooks.length > 0 || opts.registryFlag === true,
    hooks,
    commands,
    lengths,
  };
  if (flags.size > 0) value.flags = [...flags].sort();
  return value;
}

/**
 * Publishing anomaly: install hooks in `current` that `previous` (the prior release) did not have,
 * e.g. ua-parser-js 0.7.29 added a `preinstall` that 0.7.28 lacked. Mutates and returns `current`.
 */
export function markNewInstallHooks(current: NpmInstallScriptValue, previous: NpmInstallScriptValue, previousVersion: string): NpmInstallScriptValue {
  const added = current.hooks.filter((h) => !previous.hooks.includes(h));
  if (added.length === 0) return current;
  current.newHooks = added;
  current.previousVersion = previousVersion;
  current.flags = [...new Set([...(current.flags ?? []), 'new_install_hook'])].sort();
  return current;
}
