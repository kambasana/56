/** HttpClient: binary bodies (npm tarballs) and manual redirects (agentic source re-fetch). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient, type TransportRequest } from './http.js';

describe('HttpClient binary and redirect options', () => {
  it('fetchBytesOrNull returns the bytes, caches them base64-encoded, and null on 404', async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x80]);
    const seen: TransportRequest[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'br-http-'));
    try {
      const http = new HttpClient({ cacheDir: dir, offline: false, minIntervalMs: 0, transport: async (r) => (seen.push(r), r.url.endsWith('/x.tgz') ? { status: 200, body: bytes.toString('base64') } : { status: 404, body: '' }) });
      expect(await http.fetchBytesOrNull('https://r.example/x.tgz')).toEqual(bytes);
      expect(await http.fetchBytesOrNull('https://r.example/x.tgz')).toEqual(bytes);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.binary).toBe(true);
      expect(await http.fetchBytesOrNull('https://r.example/none.tgz')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redirect 'manual' returns the 3xx with its Location and never shares the followed response's cache entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-http-'));
    try {
      const http = new HttpClient({
        cacheDir: dir,
        offline: false,
        minIntervalMs: 0,
        transport: async (r) => (r.redirect === 'manual' ? { status: 301, body: '', location: 'https://other.example/' } : { status: 200, body: 'followed' }),
      });
      expect((await http.request('https://a.example/')).body).toBe('followed');
      expect(await http.request('https://a.example/', { redirect: 'manual' })).toMatchObject({ status: 301, location: 'https://other.example/' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
