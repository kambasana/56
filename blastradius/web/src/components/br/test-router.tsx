/** Test helper: render under a memory router and read the current URL and history. */
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}

export function renderWithRouter(ui: ReactNode, at = '/list') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            {ui}
            <Where />
          </>
        ),
      },
    ],
    { initialEntries: [at] },
  );
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, router, url: () => router.state.location.pathname + router.state.location.search };
}
