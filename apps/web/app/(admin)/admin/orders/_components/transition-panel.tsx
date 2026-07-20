'use client';

import { useActionState } from 'react';

import { Button, Input } from '@assessify/ui';

import { initialTransitionFormState, type TransitionFormState } from '../_lib/form';

/**
 * Manual state-machine actions for one order. The server page derives the
 * offered events from the domain transition table (`orderEventsFrom`); the
 * order service is still the authority — an illegal/forbidden event comes
 * back as a typed error and is rendered here.
 */

export interface TransitionButton {
  event: string;
  label: string;
  /** Rendered with the destructive variant + a confirm dialog. */
  destructive?: boolean;
  confirm?: string;
}

interface TransitionPanelProps {
  events: TransitionButton[];
  action: (state: TransitionFormState, formData: FormData) => Promise<TransitionFormState>;
}

export function TransitionPanel({ events, action }: TransitionPanelProps) {
  const [state, formAction, pending] = useActionState(action, initialTransitionFormState);

  if (events.length === 0) {
    return <p className="text-sm text-muted">No manual actions are available in this state.</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.status === 'error' ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm text-red"
        >
          <p className="font-medium">{state.message}</p>
          {state.legalEvents && state.legalEvents.length > 0 ? (
            <p className="mt-1 text-xs">
              Legal events right now: {state.legalEvents.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex max-w-md flex-col gap-1.5">
        <label htmlFor="transition-reason" className="text-xs font-medium text-muted">
          Reason (optional — recorded in the audit trail; never include personal data)
        </label>
        <Input id="transition-reason" name="reason" maxLength={1000} placeholder="e.g. client requested hold" />
      </div>

      <div className="flex flex-wrap gap-2">
        {events.map((button) => (
          <Button
            key={button.event}
            type="submit"
            name="event"
            value={button.event}
            size="sm"
            variant={button.destructive ? 'destructive' : 'outline'}
            disabled={pending}
            onClick={(clickEvent) => {
              if (button.confirm && !window.confirm(button.confirm)) {
                clickEvent.preventDefault();
              }
            }}
          >
            {button.label}
          </Button>
        ))}
      </div>
    </form>
  );
}
