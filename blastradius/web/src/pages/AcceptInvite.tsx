import { useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CircleAlert } from 'lucide-react';
import { request, type AcceptInviteRequest, type AcceptInviteResponse } from '@/api';
import { useAuth } from '@/auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { BrandMark } from '@/components/Nav';

/** The invite token from the link's fragment (`/accept-invite#token=...`): never sent to the server in the URL. */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
}

/** The shareable link an admin sends to an invitee. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/accept-invite#token=${encodeURIComponent(token)}`;
}

/**
 * Public page for POST /api/auth/accept-invite. With no account for the invited email the
 * password becomes the new account's password; with an existing account it must be that
 * account's current password (the server decides; the page never learns which).
 */
export default function AcceptInvite() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromLink = tokenFromHash(location.hash);
  const [token, setToken] = useState(fromLink);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { token: useId(), password: useId() };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: AcceptInviteRequest = { token: token.trim(), password };
      await request<AcceptInviteResponse>('POST', '/api/auth/accept-invite', body);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invite could not be accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandMark className="size-5" />
          </div>
          Blastradius
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-xl font-semibold">Accept your invite</h1>
            </CardTitle>
            <CardDescription>Join the organization that invited you.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} noValidate aria-label="Accept invite">
              <FieldGroup>
                {!fromLink && (
                  <Field>
                    <FieldLabel htmlFor={ids.token}>Invite token</FieldLabel>
                    <Input id={ids.token} autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
                    <FieldDescription>Paste the token from your invite link.</FieldDescription>
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor={ids.password}>Password</FieldLabel>
                  <Input
                    id={ids.password}
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <FieldDescription>
                    New to Blastradius: choose a password of at least 12 characters. Already have an account with this email: enter its current password.
                  </FieldDescription>
                </Field>
                {error && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Could not accept the invite</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <Field>
                  <Button type="submit" disabled={busy || !token.trim() || !password}>
                    {busy && <Spinner role="presentation" aria-label={undefined} aria-hidden="true" />}
                    {busy ? 'Joining…' : 'Accept invite'}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
