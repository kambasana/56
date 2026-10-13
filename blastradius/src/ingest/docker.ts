/**
 * Static Dockerfile / image reference parsing → pkg:docker components.
 * Nothing is pulled or built.
 */
import { formatPurl, type Asset, type Component, type DepEdge, type DepScope, type Purl } from '../core/types.js';
import { cap } from './fs.js';

export interface ImageRef {
  purl: string;
  /** Registry host when not Docker Hub, e.g. "ghcr.io". */
  registry?: string;
  /** "library" for official Docker Hub images. */
  namespace: string;
  name: string;
  tag?: string;
  digest?: string;
  /** Digest if present, else tag, else "latest". */
  reference: string;
  pinning: 'digest' | 'tag' | 'unpinned';
}

const HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);
const COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;

/** Parse an image reference like "node:20", "ghcr.io/o/img@sha256:…", "library/node:20-alpine". Null if malformed. */
export function parseImageRef(input: string): ImageRef | null {
  const s = input.trim();
  if (!s || s.length > 512 || /[\s$]/.test(s)) return null;
  let rest = s;
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG_RE.test(tag)) return null;
  }
  const parts = rest.split('/');
  let registry: string | undefined;
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift()!.toLowerCase();
    if (HUB_HOSTS.has(registry)) registry = undefined;
  }
  if (parts.length === 0 || parts.some((p) => !COMPONENT_RE.test(p))) return null;
  if (!registry && parts.length === 1) parts.unshift('library');
  const name = parts.pop()!;
  const namespace = parts.join('/');
  const reference = digest ?? tag ?? 'latest';
  const p: Purl = { type: 'docker', namespace, name, version: reference };
  const qualifiers: Record<string, string> = {};
  if (registry) qualifiers.repository_url = registry;
  if (digest && tag) qualifiers.tag = tag;
  if (Object.keys(qualifiers).length > 0) p.qualifiers = qualifiers;
  const pinning: ImageRef['pinning'] = digest ? 'digest' : tag && tag !== 'latest' ? 'tag' : 'unpinned';
  const out: ImageRef = { purl: formatPurl(p), namespace, name, reference, pinning };
  if (registry) out.registry = registry;
  if (tag) out.tag = tag;
  if (digest) out.digest = digest;
  return out;
}

export function imageComponent(img: ImageRef): Component {
  return {
    purl: img.purl,
    ecosystem: 'docker',
    name: `${img.registry ? `${img.registry}/` : ''}${img.namespace}/${img.name}`,
    version: img.reference,
    pinning: img.pinning,
  };
}

export interface DockerfileImage {
  image: ImageRef;
  line: number;
  /** "runtime" for the final stage's base image, "build" for earlier stages and COPY --from. */
  scope: DepScope;
  stage?: string;
}

export interface ParsedDockerfile {
  images: DockerfileImage[];
  warnings: string[];
}

/** Logical instruction lines (continuations joined, comments dropped) with their starting line numbers. */
function logicalLines(text: string): { line: number; text: string }[] {
  const physical = text.split(/\r?\n/);
  let escape = '\\';
  // Parser directive "# escape=`" must appear before any instruction.
  for (const l of physical) {
    const m = /^#\s*escape\s*=\s*(\S)\s*$/i.exec(l);
    if (m) {
      escape = m[1]!;
      break;
    }
    if (!/^#/.test(l.trim()) && l.trim() !== '') break;
  }
  const out: { line: number; text: string }[] = [];
  let buf = '';
  let start = 0;
  physical.forEach((raw, i) => {
    const l = raw.replace(/\s+$/, '');
    if (buf === '' && /^\s*#/.test(l)) return;
    if (buf !== '' && /^\s*#/.test(l)) return; // comments inside continuations are skipped
    if (buf === '') start = i + 1;
    if (l.endsWith(escape)) {
      buf += l.slice(0, -1) + ' ';
      return;
    }
    buf += l;
    if (buf.trim() !== '') out.push({ line: start, text: buf.trim() });
    buf = '';
  });
  if (buf.trim() !== '') out.push({ line: start, text: buf.trim() });
  return out;
}

function substitute(s: string, args: Map<string, string>): string | null {
  let unresolved = false;
  const out = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, b1, op, word, b2) => {
    const name = (b1 ?? b2) as string;
    const val = args.get(name);
    if (op === '-') return val ? val : (word as string);
    if (op === '+') return val ? (word as string) : '';
    if (val === undefined || val === '') {
      unresolved = true;
      return '';
    }
    return val;
  });
  return unresolved ? null : out;
}

/** Parse Dockerfile text; `relPath` is used only for warnings. */
export function parseDockerfile(text: string, relPath = 'Dockerfile'): ParsedDockerfile {
  const warnings: string[] = [];
  const globalArgs = new Map<string, string>();
  const stages = new Set<string>();
  /** Stage name → index into `froms` of the external image at the root of that stage (undefined: scratch/unresolved). */
  const stageRoot = new Map<string, number | undefined>();
  /** Root external image of the stage currently being parsed (the last one is the final, runtime stage). */
  let currentRoot: number | undefined;
  const froms: { image: ImageRef; line: number; stage?: string; index: number }[] = [];
  const copyFroms: { image: ImageRef; line: number }[] = [];
  let seenFrom = false;
  let stageIndex = -1;

  for (const { line, text: l } of logicalLines(text)) {
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const instr = m[1]!.toUpperCase();
    const args = m[2]!;
    if (instr === 'ARG' && !seenFrom) {
      for (const tok of args.split(/\s+/)) {
        const am = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(tok);
        if (am) globalArgs.set(am[1]!, (am[2] ?? '').replace(/^["']|["']$/g, ''));
      }
      continue;
    }
    if (instr === 'FROM') {
      seenFrom = true;
      stageIndex++;
      const toks = args.split(/\s+/).filter((t) => !t.startsWith('--'));
      const rawImage = toks[0];
      const stage = toks.length >= 3 && toks[1]!.toUpperCase() === 'AS' ? toks[2]!.toLowerCase() : undefined;
      if (!rawImage) continue;
      currentRoot = undefined;
      const resolved = substitute(rawImage, globalArgs);
      if (resolved === null) {
        warnings.push(`${relPath}:${line}: FROM uses an unresolved build arg (${cap(rawImage, 100)}); skipped`);
      } else if (stages.has(resolved.toLowerCase())) {
        // internal stage: inherits that stage's root image
        currentRoot = stageRoot.get(resolved.toLowerCase());
      } else if (resolved.toLowerCase() === 'scratch') {
        // empty base
      } else {
        const img = parseImageRef(resolved);
        if (img) {
          currentRoot = froms.length;
          froms.push({ image: img, line, ...(stage ? { stage } : {}), index: stageIndex });
        } else warnings.push(`${relPath}:${line}: unrecognised image reference "${cap(resolved, 100)}"`);
      }
      if (stage) {
        stages.add(stage);
        stageRoot.set(stage, currentRoot);
      }
      continue;
    }
    if (instr === 'COPY' || instr === 'ADD') {
      const fm = /--from=(\S+)/.exec(args);
      if (!fm) continue;
      const ref = fm[1]!.replace(/^["']|["']$/g, '');
      if (/^\d+$/.test(ref) || stages.has(ref.toLowerCase())) continue;
      const resolved = substitute(ref, globalArgs);
      const img = resolved ? parseImageRef(resolved) : null;
      if (img) copyFroms.push({ image: img, line });
    }
  }

  const images: DockerfileImage[] = [];
  // The runtime image is the external image at the root of the final stage, even when the final
  // stage is built FROM an earlier named stage; every other image is build-only.
  froms.forEach((f, i) => {
    images.push({ image: f.image, line: f.line, scope: i === currentRoot ? 'runtime' : 'build', ...(f.stage ? { stage: f.stage } : {}) });
  });
  for (const c of copyFroms) images.push({ image: c.image, line: c.line, scope: 'build' });
  return { images, warnings };
}

/** Build the image Asset + components + edges for a parsed Dockerfile. */
export function dockerfileInventory(
  parsed: ParsedDockerfile,
  relPath: string,
  asset: Pick<Asset, 'environment' | 'criticality'>,
): { asset: Asset; components: Component[]; edges: DepEdge[] } {
  const a: Asset = {
    id: `image:${relPath}`,
    kind: 'image',
    name: relPath,
    environment: asset.environment,
    criticality: asset.criticality,
    sourceFile: relPath,
  };
  const components = new Map<string, Component>();
  const edges = new Map<string, DepEdge>();
  for (const im of parsed.images) {
    components.set(im.image.purl, imageComponent(im.image));
    const key = `${im.image.purl}\u0000${im.scope}`;
    edges.set(key, { from: a.id, to: im.image.purl, scope: im.scope, direct: true });
  }
  return { asset: a, components: [...components.values()], edges: [...edges.values()] };
}
