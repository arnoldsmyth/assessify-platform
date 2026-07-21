'use client';

import { useActionState } from 'react';

import { Button } from '@assessify/ui';

import {
  initialInvitationActionState,
  type InvitationActionState,
} from './invitation-form';

/**
 * Invitation affordances on the order detail page (D5). The service is the
 * authority — a forbidden or ill-timed request comes back as a typed error
 * message and is rendered inline. PINs are never shown anywhere here (spec
 * 05: admins regenerate, never view).
 */

type InvitationAction = (
  state: InvitationActionState,
  formData: FormData
) => Promise<InvitationActionState>;

function StateMessage({ state }: { state: InvitationActionState }) {
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

/** "Send invitations" panel, offered while the order is `approved`. */
export function DispatchInvitationsPanel({ action }: { action: InvitationAction }) {
  const [state, formAction, pending] = useActionState(action, initialInvitationActionState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Queueing…' : 'Send invitations'}
      </Button>
      <p className="text-xs text-muted">
        Generates a PIN per respondent and emails each one their access link.
      </p>
      <StateMessage state={state} />
    </form>
  );
}

/** Per-session resend button — same token, regenerated PIN (spec 05). */
export function ResendInvitationButton({
  action,
  sessionId,
}: {
  action: InvitationAction;
  sessionId: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialInvitationActionState);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="sessionId" value={sessionId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Queueing…' : 'Resend'}
      </Button>
      <StateMessage state={state} />
    </form>
  );
}
