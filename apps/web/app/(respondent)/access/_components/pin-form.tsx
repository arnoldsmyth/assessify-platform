'use client';

import { useActionState } from 'react';

import { Button, Input } from '@assessify/ui';

import { initialAccessFormState, type AccessFormState } from '../_lib/form';

interface PinFormProps {
  action: (state: AccessFormState, formData: FormData) => Promise<AccessFormState>;
  /** ISO instant while PIN entry is already locked out (from resolveToken). */
  initialLockedUntil: string | null;
}

function lockMessage(retryAtIso: string | undefined): string {
  if (retryAtIso) {
    const retryAt = new Date(retryAtIso);
    if (!Number.isNaN(retryAt.getTime())) {
      const minutes = Math.max(Math.ceil((retryAt.getTime() - Date.now()) / 60_000), 1);
      return `Too many incorrect PIN attempts. Please try again in about ${minutes} minute${
        minutes === 1 ? '' : 's'
      }.`;
    }
  }
  return 'Too many incorrect PIN attempts. Please try again later.';
}

export function PinForm({ action, initialLockedUntil }: PinFormProps) {
  const [state, formAction, pending] = useActionState(action, initialAccessFormState);

  const lockedRetryAt =
    state.status === 'locked' ? (state.retryAt ?? null) : (initialLockedUntil ?? null);
  const isLocked =
    (state.status === 'locked' || (state.status === 'idle' && initialLockedUntil !== null)) &&
    (lockedRetryAt === null || new Date(lockedRetryAt).getTime() > Date.now());

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {isLocked ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
        >
          {lockMessage(lockedRetryAt ?? undefined)}
        </div>
      ) : state.status === 'error' && state.message ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
        >
          {state.message}
          {typeof state.attemptsRemaining === 'number' && state.attemptsRemaining > 0 ? (
            <span className="mt-1 block font-normal">
              {state.attemptsRemaining} attempt{state.attemptsRemaining === 1 ? '' : 's'} remaining
              before this link is temporarily locked.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pin" className="text-sm font-medium text-ink">
          6-digit PIN
        </label>
        <Input
          id="pin"
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="\d{6}"
          minLength={6}
          maxLength={6}
          autoComplete="one-time-code"
          placeholder="••••••"
          className="text-center text-lg tracking-[0.5em]"
          required
          disabled={isLocked}
        />
        <p className="text-xs text-muted">The PIN is in your invitation email.</p>
      </div>

      <Button type="submit" disabled={pending || isLocked}>
        {pending ? 'Verifying…' : 'Continue'}
      </Button>
    </form>
  );
}
