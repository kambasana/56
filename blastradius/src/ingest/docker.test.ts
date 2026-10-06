import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dockerfileInventory, parseDockerfile, parseImageRef } from './docker.js';

const fx = (p: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/ingest/${p}`, import.meta.url)), 'utf8');
const D = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('parseImageRef', () => {
  it('normalises Docker Hub, registries, tags and digests', () => {
    expect(parseImageRef('node')).toMatchObject({ purl: 'pkg:docker/library/node@latest', pinning: 'unpinned' });
    expect(parseImageRef('node:20-alpine')).toMatchObject({ purl: 'pkg:docker/library/node@20-alpine', pinning: 'tag', tag: '20-alpine' });
    expect(parseImageRef('docker.io/bitnami/redis:7')).toMatchObject({ purl: 'pkg:docker/bitnami/redis@7' });
    expect(parseImageRef(`ghcr.io/acme/app:1.0@sha256:${D}`)).toMatchObject({
      purl: `pkg:docker/acme/app@sha256:${D}?repository_url=ghcr.io&tag=1.0`,
      pinning: 'digest',
      registry: 'ghcr.io',
    });
    expect(parseImageRef('localhost:5000/x/y:1')).toMatchObject({ registry: 'localhost:5000', namespace: 'x', name: 'y' });
    expect(parseImageRef('$IMAGE')).toBeNull();
    expect(parseImageRef('bad image')).toBeNull();
    expect(parseImageRef('node@sha256:short')).toBeNull();
  });
});

describe('parseDockerfile', () => {
  it('reads FROM lines with args, platforms, stages and COPY --from', () => {
    const r = parseDockerfile(fx('lock-v3/Dockerfile'));
    expect(r.warnings).toEqual([]);
    expect(r.images.map((i) => [i.image.purl, i.scope])).toEqual([
      ['pkg:docker/library/node@20.11.1-alpine', 'build'],
      [`pkg:docker/distroless/nodejs20-debian12@sha256:${D}?repository_url=gcr.io`, 'runtime'],
      ['pkg:docker/acme/assets@1.2.3?repository_url=ghcr.io', 'build'],
    ]);
  });

  it('skips scratch and stage references, warns on unresolved args', () => {
    const r = parseDockerfile('FROM golang:1.22 AS b\nFROM b AS c\nFROM $BASE\nFROM scratch\nCOPY --from=c /x /x\n', 'X');
    expect(r.images.map((i) => i.image.purl)).toEqual(['pkg:docker/library/golang@1.22']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/unresolved build arg/);
  });

  it('marks the root image of the final stage as runtime when the final stage builds FROM an earlier stage', () => {
    const r = parseDockerfile('FROM node:20 AS base\nFROM golang:1.22 AS tools\nFROM base AS deps\nFROM deps AS final\nCOPY --from=tools /x /x\n');
    expect(r.images.map((i) => [i.image.purl, i.scope])).toEqual([
      ['pkg:docker/library/node@20', 'runtime'],
      ['pkg:docker/library/golang@1.22', 'build'],
    ]);
    // Final stage FROM scratch: no external runtime image.
    const s = parseDockerfile('FROM node:20 AS b\nFROM scratch\nCOPY --from=b /x /x\n');
    expect(s.images.map((i) => i.scope)).toEqual(['build']);
  });

  it('builds an image asset', () => {
    const r = dockerfileInventory(parseDockerfile('FROM node:20\n'), 'svc/Dockerfile', { environment: 'prod', criticality: 3 });
    expect(r.asset).toEqual({ id: 'image:svc/Dockerfile', kind: 'image', name: 'svc/Dockerfile', environment: 'prod', criticality: 3, sourceFile: 'svc/Dockerfile' });
    expect(r.edges).toEqual([{ from: 'image:svc/Dockerfile', to: 'pkg:docker/library/node@20', scope: 'runtime', direct: true }]);
    expect(r.components[0]).toMatchObject({ ecosystem: 'docker', name: 'library/node', version: '20', pinning: 'tag' });
  });
});
