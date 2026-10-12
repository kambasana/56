/**
 * Manifests and lockfiles we recognise but do not analyse (Tier 0: never a false all-clear).
 *
 * Every file here ends up in `ScanResult.notAnalysed` with the number of packages it lists, as
 * far as a static count can tell, so a Go, Ruby or Yarn repository never reads as "0 findings".
 * The counts are estimates from the file text (lines, entries); nothing is resolved or executed.
 */
import path from 'node:path';
import type { NotAnalysedManifest } from '../core/types.js';

/** Base names (or patterns) of manifests we do not analyse, with their ecosystem. */
const UNSUPPORTED: readonly { test: (base: string) => boolean; ecosystem: string; kind: string; lockfile: boolean }[] = [
  { test: (b) => b === 'yarn.lock', ecosystem: 'npm', kind: 'yarn.lock', lockfile: true },
  { test: (b) => b === 'pnpm-lock.yaml', ecosystem: 'npm', kind: 'pnpm-lock.yaml', lockfile: true },
  { test: (b) => b === 'bun.lock' || b === 'bun.lockb', ecosystem: 'npm', kind: 'bun lockfile', lockfile: true },
  { test: (b) => b === 'deno.lock', ecosystem: 'npm', kind: 'deno.lock', lockfile: true },
  { test: (b) => b === 'go.mod', ecosystem: 'go', kind: 'go.mod', lockfile: true },
  { test: (b) => b === 'cargo.lock', ecosystem: 'cargo', kind: 'Cargo.lock', lockfile: true },
  { test: (b) => b === 'cargo.toml', ecosystem: 'cargo', kind: 'Cargo.toml', lockfile: false },
  { test: (b) => b === 'gemfile.lock', ecosystem: 'gem', kind: 'Gemfile.lock', lockfile: true },
  { test: (b) => b === 'gemfile', ecosystem: 'gem', kind: 'Gemfile', lockfile: false },
  { test: (b) => b === 'composer.lock', ecosystem: 'composer', kind: 'composer.lock', lockfile: true },
  { test: (b) => b === 'composer.json', ecosystem: 'composer', kind: 'composer.json', lockfile: false },
  { test: (b) => b === 'pom.xml', ecosystem: 'maven', kind: 'pom.xml', lockfile: true },
  { test: (b) => b === 'build.gradle' || b === 'build.gradle.kts', ecosystem: 'maven', kind: 'Gradle build', lockfile: true },
  { test: (b) => b === 'gradle.lockfile', ecosystem: 'maven', kind: 'gradle.lockfile', lockfile: true },
  { test: (b) => b === 'packages.lock.json', ecosystem: 'nuget', kind: 'packages.lock.json', lockfile: true },
  { test: (b) => b.endsWith('.csproj') || b.endsWith('.fsproj') || b.endsWith('.vbproj'), ecosystem: 'nuget', kind: '.NET project file', lockfile: false },
  { test: (b) => b === 'packages.config', ecosystem: 'nuget', kind: 'packages.config', lockfile: true },
  { test: (b) => b === 'mix.lock', ecosystem: 'hex', kind: 'mix.lock', lockfile: true },
  { test: (b) => b === 'pubspec.lock', ecosystem: 'pub', kind: 'pubspec.lock', lockfile: true },
  { test: (b) => b === 'package.resolved', ecosystem: 'swift', kind: 'Package.resolved', lockfile: true },
  { test: (b) => b === 'podfile.lock', ecosystem: 'cocoapods', kind: 'Podfile.lock', lockfile: true },
  { test: (b) => b === 'pdm.lock', ecosystem: 'pypi', kind: 'pdm.lock', lockfile: true },
  { test: (b) => b === 'pipfile', ecosystem: 'pypi', kind: 'Pipfile', lockfile: false },
  { test: (b) => b === 'setup.py' || b === 'setup.cfg', ecosystem: 'pypi', kind: 'setup script', lockfile: false },
  { test: (b) => b === 'environment.yml' || b === 'environment.yaml' || b === 'conda-lock.yml', ecosystem: 'conda', kind: 'conda environment', lockfile: true },
];

/** Recognised unsupported manifest for a base name, if any. */
export function unsupportedKind(base: string): { ecosystem: string; kind: string; lockfile: boolean } | undefined {
  const b = base.toLowerCase();
  const hit = UNSUPPORTED.find((u) => u.test(b));
  return hit ? { ecosystem: hit.ecosystem, kind: hit.kind, lockfile: hit.lockfile } : undefined;
}

const unique = (xs: Iterable<string>): number => new Set(xs).size;

/** Approximate number of packages a manifest lists (undefined when it cannot be told statically). */
export function estimatePackages(file: string, text: string): number | undefined {
  const base = path.posix.basename(file).toLowerCase();
  const lines = text.split(/\r?\n/);
  try {
    switch (true) {
      case base === 'yarn.lock':
        // Entries are unindented "name@range[, name@range]:" lines.
        return lines.filter((l) => /^"?[^\s#"][^:]*"?:\s*$/.test(l) && !l.startsWith('__metadata')).length;
      case base === 'pnpm-lock.yaml': {
        const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
        if (start < 0) return undefined;
        let n = 0;
        for (const l of lines.slice(start + 1)) {
          if (/^\S/.test(l)) break;
          if (/^ {2}\S.*:\s*$/.test(l)) n++;
        }
        return n;
      }
      case base === 'go.mod':
        return unique(lines.map((l) => /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+v\d/i.exec(l)?.[1] ?? '').filter(Boolean));
      case base === 'cargo.lock':
      case base === 'pdm.lock':
        return lines.filter((l) => l.trim() === '[[package]]').length;
      case base === 'gemfile.lock':
        return lines.filter((l) => /^ {4}[A-Za-z0-9_.-]+ \(/.test(l)).length;
      case base === 'composer.lock': {
        const j = JSON.parse(text) as { packages?: unknown[]; 'packages-dev'?: unknown[] };
        return (Array.isArray(j.packages) ? j.packages.length : 0) + (Array.isArray(j['packages-dev']) ? j['packages-dev'].length : 0);
      }
      case base === 'composer.json': {
        const j = JSON.parse(text) as { require?: Record<string, unknown>; 'require-dev'?: Record<string, unknown> };
        return Object.keys(j.require ?? {}).filter((k) => k.includes('/')).length + Object.keys(j['require-dev'] ?? {}).length;
      }
      case base === 'pom.xml':
        return (text.match(/<dependency>/g) ?? []).length;
      case base === 'build.gradle' || base === 'build.gradle.kts':
        return lines.filter((l) => /^\s*(implementation|api|compile|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|kapt|annotationProcessor|classpath)\s*[( ]\s*["']/.test(l)).length;
      case base === 'packages.lock.json': {
        const j = JSON.parse(text) as { dependencies?: Record<string, Record<string, unknown>> };
        return unique(Object.values(j.dependencies ?? {}).flatMap((fw) => Object.keys(fw ?? {})));
      }
      case base.endsWith('.csproj') || base.endsWith('.fsproj') || base.endsWith('.vbproj') || base === 'packages.config':
        return (text.match(/<(PackageReference|package)\s/gi) ?? []).length;
      case base === 'mix.lock':
        return lines.filter((l) => /^\s*"[^"]+":\s*\{/.test(l)).length;
      case base === 'pubspec.lock':
        return lines.filter((l) => /^ {2}[A-Za-z0-9_]+:\s*$/.test(l)).length;
      case base === 'package.resolved': {
        const j = JSON.parse(text) as { pins?: unknown[]; object?: { pins?: unknown[] } };
        return (j.pins ?? j.object?.pins ?? []).length;
      }
      case base === 'podfile.lock': {
        const start = lines.findIndex((l) => /^PODS:\s*$/.test(l));
        if (start < 0) return undefined;
        let n = 0;
        for (const l of lines.slice(start + 1)) {
          if (/^\S/.test(l)) break;
          if (/^ {2}- /.test(l)) n++;
        }
        return n;
      }
      case base === 'pipfile': {
        let n = 0;
        let inDeps = false;
        for (const l of lines) {
          if (/^\[/.test(l)) inDeps = /^\[(dev-)?packages\]/.test(l);
          else if (inDeps && /^[A-Za-z0-9][A-Za-z0-9._-]*\s*=/.test(l)) n++;
        }
        return n;
      }
      case base === 'gemfile':
        return lines.filter((l) => /^\s*gem\s+['"]/.test(l)).length;
      case base === 'cargo.toml': {
        let n = 0;
        let inDeps = false;
        for (const l of lines) {
          if (/^\[/.test(l)) inDeps = /^\[(.*\.)?(dev-|build-)?dependencies\]/.test(l);
          else if (inDeps && /^[A-Za-z0-9][A-Za-z0-9_-]*\s*=/.test(l)) n++;
        }
        return n;
      }
      case base === 'environment.yml' || base === 'environment.yaml' || base === 'conda-lock.yml':
        return lines.filter((l) => /^\s+-\s+[A-Za-z0-9]/.test(l)).length;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Build a not-analysed entry for a recognised file. */
export function notAnalysedEntry(file: string, text: string | null, reason?: string): NotAnalysedManifest | undefined {
  const kind = unsupportedKind(path.posix.basename(file));
  if (!kind) return undefined;
  const packages = text === null ? undefined : estimatePackages(file, text);
  return { file, ecosystem: kind.ecosystem, reason: reason ?? `${kind.kind} is not supported yet`, ...(packages !== undefined ? { packages } : {}) };
}

/** Total of the package estimates ("~N packages"); entries without an estimate are not counted. */
export function notAnalysedPackages(entries: readonly NotAnalysedManifest[]): number {
  return entries.reduce((n, e) => n + (e.packages ?? 0), 0);
}

/** One-line summary: "NOT ANALYSED: yarn.lock, go.mod (+3 more), ~412 packages". */
export function notAnalysedLine(entries: readonly NotAnalysedManifest[], maxFiles = 5): string {
  if (entries.length === 0) return '';
  const files = entries.slice(0, maxFiles).map((e) => e.file);
  const more = entries.length > maxFiles ? ` (+${entries.length - maxFiles} more)` : '';
  const n = notAnalysedPackages(entries);
  const unknown = entries.some((e) => e.packages === undefined);
  return `NOT ANALYSED: ${files.join(', ')}${more}, ~${n}${unknown ? '+' : ''} package${n === 1 && !unknown ? '' : 's'}`;
}
