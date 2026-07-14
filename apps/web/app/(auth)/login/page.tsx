'use client';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@assessify/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { authClient } from '@/lib/auth-client';

/**
 * Minimal admin-surface login (spec 05): email/password + magic link for
 * staff/client users. Respondents never sign in here — they use token + PIN.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handlePasswordSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? 'Sign-in failed. Check your email and password.');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  async function handleMagicLink() {
    setError(null);
    setNotice(null);
    if (!email) {
      setError('Enter your email address first.');
      return;
    }
    setPending(true);
    const { error: magicLinkError } = await authClient.signIn.magicLink({
      email,
      callbackURL: '/admin',
    });
    setPending(false);
    if (magicLinkError) {
      setError(magicLinkError.message ?? 'Could not send the magic link. Try again.');
      return;
    }
    setNotice('Check your email for a sign-in link.');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Assessify</CardTitle>
          <CardDescription>Staff and client accounts only.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSignIn} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              Email
              <Input
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              Password
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-red">
                {error}
              </p>
            ) : null}
            {notice ? <p className="text-sm text-muted">{notice}</p> : null}
            <Button type="submit" disabled={pending}>
              Sign in
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={handleMagicLink}>
              Email me a magic link
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
