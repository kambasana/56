import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/auth';
import { Button } from '@/components/Button';

/** Only same-app paths are allowed as a post-login redirect (no open redirect). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/login')) return '/';
  return next;
}

export default function Login() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email: email.trim(), password });
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="flex w-full max-w-[360px] flex-col gap-5 rounded-lg border bg-card p-6 text-card-foreground shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2">
          <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <circle cx="10" cy="10" r="2" />
            <circle cx="10" cy="10" r="5.5" opacity="0.6" />
            <circle cx="10" cy="10" r="9" opacity="0.3" />
          </svg>
          <h1 className="m-0 text-base font-semibold">Sign in to Blastradius</h1>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-[13px] font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[13px] font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="default" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="m-0 text-xs leading-4 text-muted-foreground">
          Dev mode (<span className="font-mono">blastradius serve --dev</span>): sign in as <span className="font-mono">admin@local</span>,{' '}
          <span className="font-mono">appsec@local</span>, <span className="font-mono">developer@local</span> or{' '}
          <span className="font-mono">auditor@local</span> with the password printed in the server console, then switch roles from the sidebar.
        </p>
      </div>
    </div>
  );
}
