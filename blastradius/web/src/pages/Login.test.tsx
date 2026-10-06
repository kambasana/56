import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { setFetcher } from '@/api';
import { AuthProvider } from '@/auth';
import Login from './Login';

describe('<Login>', () => {
  it('does not call login twice when Enter is pressed again while signing in', async () => {
    let loginCalls = 0;
    // The sign-in request never settles: the form stays in flight.
    setFetcher(async (input) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/auth/login') {
        loginCalls++;
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 });
    });
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider initialMe={null}>
          <Login />
        </AuthProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'admin@local');
    await user.type(screen.getByLabelText('Password'), 'secret-password{Enter}');
    // A second Enter, and a submit event that bypasses the disabled button, both while in flight.
    await user.keyboard('{Enter}');
    const form = screen.getByLabelText('Password').closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(loginCalls).toBe(1);
  });
});
