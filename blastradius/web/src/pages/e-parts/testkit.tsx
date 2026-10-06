/** Test helpers for the Track E screens: a fake API transport and a page renderer. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { MeResponse } from '@server/api-types';
import { setFetcher } from '@/api';
import { AuthProvider } from '@/auth';
import { ProjectProvider } from '@/project';
import { Toaster } from '@/components/ui/sonner';

export interface Call {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}

export type Handler = (call: Call) => unknown | { status: number; body: unknown } | Promise<unknown>;

/** `new Reply(status, body)` lets a handler return a non-200 response. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/**
 * Route table: keys are "METHOD /path" (no query). The handler's return value is sent as JSON
 * (200) unless it is a Reply. Unknown routes answer 404.
 */
export function fakeApi(routes: Record<string, Handler>): { calls: Call[] } {
  const calls: Call[] = [];
  setFetcher(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = { method, path: url.pathname, url, body };
    calls.push(call);
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 });
    const out = await h(call);
    if (out instanceof Reply) return new Response(JSON.stringify(out.body), { status: out.status });
    return new Response(JSON.stringify(out ?? { ok: true }), { status: 200 });
  });
  return { calls };
}

export function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

export function renderPage(element: ReactElement, opts: { path: string; at: string; me: MeResponse; projects?: { id: string; name: string }[] }) {
  return render(
    <MemoryRouter initialEntries={[opts.at]}>
      <AuthProvider initialMe={opts.me}>
        <ProjectProvider initialProjects={opts.projects ?? [{ id: 'p1', name: 'payments-platform' }]}>
          <Routes>
            <Route path={opts.path} element={element} />
          </Routes>
          <Where />
          <Toaster />
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Pick an option in a shadcn (Radix) Select by its trigger's accessible name. */
export async function choose(label: string | RegExp, option: string | RegExp, within: { getByRole: typeof screen.getByRole } = screen) {
  await userEvent.click(within.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}
