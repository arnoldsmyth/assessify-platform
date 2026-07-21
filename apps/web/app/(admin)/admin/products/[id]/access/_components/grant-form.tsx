'use client';

import { useActionState } from 'react';

import { Button, cn } from '@assessify/ui';

import { initialAccessFormState, type AccessFormState } from '../_lib/form';

interface GrantFormProps {
  action: (state: AccessFormState, formData: FormData) => Promise<AccessFormState>;
  /** The org's clients without a grant yet. */
  clients: { id: string; name: string }[];
}

export function GrantForm({ action, clients }: GrantFormProps) {
  const [state, formAction, pending] = useActionState(action, initialAccessFormState);
  const errors = state.fieldErrors ?? {};

  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted">
        Every client of this organization already has access to this product.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state.status === 'error' && state.message ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
        >
          {state.message}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="clientId" className="text-sm font-medium text-ink">
          Grant access to
        </label>
        <select
          id="clientId"
          name="clientId"
          required
          defaultValue=""
          className={cn(
            'flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
          )}
        >
          <option value="" disabled>
            Choose a client…
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? 'Granting…' : 'Grant access'}
        </Button>
      </div>
      {errors.clientId ? <p className="text-xs text-red">{errors.clientId}</p> : null}
    </form>
  );
}
