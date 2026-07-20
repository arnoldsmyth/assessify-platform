'use client';

import { useActionState } from 'react';

import { Button, Input } from '@assessify/ui';

import { initialAccessFormState, type AccessFormState } from '../_lib/form';

interface TokenFormProps {
  action: (state: AccessFormState, formData: FormData) => Promise<AccessFormState>;
}

export function TokenForm({ action }: TokenFormProps) {
  const [state, formAction, pending] = useActionState(action, initialAccessFormState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.status !== 'idle' && state.message ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
        >
          {state.message}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="token" className="text-sm font-medium text-ink">
          Invitation link or access code
        </label>
        <Input
          id="token"
          name="token"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your invitation link here"
          required
        />
        <p className="text-xs text-muted">
          You can paste the whole link from your invitation email.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  );
}
