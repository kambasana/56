import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthProvider } from '@/auth';
import { meFor } from '@/test/fixtures';
import AcceptInvite, { inviteLink, tokenFromHash } from '../AcceptInvite';
import { Reply, Where, fakeApi } from './testkit';

function renderAt(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AuthProvider initialMe={null}>
        <Routes>
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AcceptInvite', () => {
  it('builds and parses invite links (token in the fragment)', () => {
    const link = inviteLink('https://br.example', 'a_b-c');
    expect(link).toBe('https://br.example/accept-invite#token=a_b-c');
    expect(tokenFromHash(new URL(link).hash)).toBe('a_b-c');
    expect(tokenFromHash('')).toBe('');
  });

  it('accepts with the token from the link, then signs in', async () => {
    const { calls } = fakeApi({
      'POST /api/auth/accept-invite': () => meFor('developer'),
      'GET /api/me': () => meFor('developer'),
    });
    renderAt('/accept-invite#token=tok123');
    expect(screen.getByRole('heading', { name: 'Accept your invite' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Invite token')).toBeNull();
    await userEvent.type(screen.getByLabelText('Password'), 'a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/'));
    expect(calls.find((c) => c.path === '/api/auth/accept-invite')?.body).toEqual({ token: 'tok123', password: 'a-brand-new-password' });
  });

  it('asks for the token when the link had none, and shows server errors', async () => {
    fakeApi({
      'POST /api/auth/accept-invite': () => new Reply(400, { error: { code: 'bad_request', message: 'This invite is invalid, expired or already used' } }),
    });
    renderAt('/accept-invite');
    const button = screen.getByRole('button', { name: 'Accept invite' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Invite token'), 'old');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-password');
    await userEvent.click(button);
    expect(await screen.findByText(/invalid, expired or already used/)).toBeInTheDocument();
  });
});
