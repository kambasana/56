/**
 * Shared vocabulary for static install-script flags. The npm enricher (src/enrich/npm/scripts.ts)
 * emits these names and scoring (src/scoring/weights.ts) decides which are risky, so both sides
 * must import them from here: a name that only one side knows silently stops counting.
 */
export const INSTALL_SCRIPT_FLAGS = [
  'network',
  'obfuscated',
  'eval',
  'pipe_to_shell',
  'background_process',
  'env_access',
  'credential_files',
  'runs_package_file',
  'native_build',
  'long_command',
  'implicit_gyp',
  /** An install hook present in this version but not in the previous release (publishing anomaly). */
  'new_install_hook',
] as const;

export type InstallScriptFlag = (typeof INSTALL_SCRIPT_FLAGS)[number];

/** Flags that raise the install_script factor from its base value to "flagged". */
export const RISKY_INSTALL_SCRIPT_FLAGS: readonly InstallScriptFlag[] = Object.freeze([
  'network',
  'obfuscated',
  'eval',
  'pipe_to_shell',
  'background_process',
  'env_access',
  'credential_files',
  'new_install_hook',
]);
