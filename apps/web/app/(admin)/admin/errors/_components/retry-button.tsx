'use client';

import { useActionState } from 'react';

import { Button } from '@assessify/ui';

import {
  initialTransitionFormState,
  type TransitionFormState,
} from '../../orders/_lib/form';

/**
 * One inline retry control for an error-queue row. The bound server action
 * carries the order id and the retry event resolved from the domain
 * transition table; the order service remains the authority — a forbidden or
 * illegal retry comes back as a typed error and is rendered under the button.
 */
export function RetryButton({
  label,
  action,
}: {
  label: string;
  action: (state: TransitionFormState, formData: FormData) => Promise<TransitionFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialTransitionFormState);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Retrying…' : label}
      </Button>
      {state.status === 'error' ? (
        <p role="alert" className="max-w-52 text-right text-xs text-red">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
