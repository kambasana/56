import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, isApiError, setFetcher, setUnauthenticatedHandler, withQuery } from './api';

function respond(status: number, body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body === undefined ? '' : JSON.stringify(body), { status }));
}

afterEach(() => {
  setFetcher((...a) => fetch(...a));
  setUnauthenticatedHandler(null);
});

describe('api client', () => {
  it('builds query strings without empty values', () => {
    expect(withQuery('/api/findings', { project: 'p1', level: 'critical,high', q: '', scan: undefined })).toBe('/api/findings?project=p1&level=critical%2Chigh');
    expect(withQuery('/api/home')).toBe('/api/home');
  });

  it('GETs without the CSRF header and with same-origin credentials', async () => {
    const f = respond(200, { items: [], total: 0, nextCursor: null, scan: null });
    setFetcher(f as unknown as typeof fetch);
    await api.findings({ project: 'p 1', level: 'high' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/findings?project=p+1&level=high');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['X-Requested-With']).toBeUndefined();
  });

  it('sends X-Requested-With and a JSON body on mutations', async () => {
    const f = respond(202, { id: 's1' });
    setFetcher(f as unknown as typeof fetch);
    await api.runScan('p/1', { offline: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/projects/p%2F1/scans');
    expect(init?.method).toBe('POST');
    const h = init?.headers as Record<string, string>;
    expect(h['X-Requested-With']).toBe('blastradius');
    expect(h['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"offline":true}');
  });

  it('turns ApiError bodies into ApiRequestError', async () => {
    setFetcher(respond(403, { error: { code: 'forbidden', message: 'Missing permission: manage_projects' } }) as unknown as typeof fetch);
    const err = await api.createProject({ name: 'x', tier: 'Small', target: 'https://github.com/a/b' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(isApiError(err, 'forbidden')).toBe(true);
    expect((err as ApiRequestError).status).toBe(403);
    expect((err as ApiRequestError).message).toBe('Missing permission: manage_projects');
  });

  it('calls the unauthenticated handler on 401', async () => {
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);
    setFetcher(respond(401, { error: { code: 'unauthenticated', message: 'Sign in' } }) as unknown as typeof fetch);
    await expect(api.me()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(onUnauth).toHaveBeenCalledOnce();
  });

  it('maps network failures to a safe error', async () => {
    setFetcher((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(api.health()).rejects.toMatchObject({ code: 'internal', status: 0 });
  });

  it('builds report download URLs', () => {
    expect(api.reportUrl('scan_ab12', 'sarif')).toBe('/api/reports/scan_ab12.sarif');
  });
});
