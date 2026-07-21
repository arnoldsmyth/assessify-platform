'use client';

import { useActionState } from 'react';

import { Button } from '@assessify/ui';

import { initialReminderActionState, type ReminderActionState } from './reminder-form';

/**
 * Reminder affordances on the order detail page (D6). The service is the
 * authority — a forbidden, suppressed, or ill-timed request comes back as a
 * typed error message and is rendered inline. Manual send bypasses the 2-day
 * spacing (spec 13); suppression is the per-session opt-out.
 */

type ReminderAction = (
  state: ReminderActionState,
  formData: FormData
) => Promise<ReminderActionState>;

function StateMessage({ state }: { state: ReminderActionState }) {
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-xs text-red">
        {state.message}
      </p>
    );
  }
  if (state.status === 'success') {
    return <p className="text-xs text-muted">{state.message}</p>;
  }
  return null;
}

/** Per-session "remind now" + suppress/resume pair. */
export function ReminderControls({
  sendAction,
  suppressAction,
  sessionId,
  suppressed,
}: {
  sendAction: ReminderAction;
  suppressAction: ReminderAction;
  sessionId: string;
  suppressed: boolean;
}) {
  const [sendState, sendFormAction, sendPending] = useActionState(
    sendAction,
    initialReminderActionState
  );
  const [suppressState, suppressFormAction, suppressPending] = useActionState(
    suppressAction,
    initialReminderActionState
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {suppressed ? null : (
          <form action={sendFormAction}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <Button type="submit" size="sm" variant="outline" disabled={sendPending}>
              {sendPending ? 'Queueing…' : 'Remind now'}
            </Button>
          </form>
        )}
        <form action={suppressFormAction}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="suppressed" value={suppressed ? 'false' : 'true'} />
          <Button type="submit" size="sm" variant="outline" disabled={suppressPending}>
            {suppressPending ? 'Saving…' : suppressed ? 'Resume' : 'Suppress'}
          </Button>
        </form>
      </div>
      <StateMessage state={sendState} />
      <StateMessage state={suppressState} />
    </div>
  );
}
