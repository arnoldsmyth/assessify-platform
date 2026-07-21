'use server';

import { revalidatePath } from 'next/cache';

import { requireCallerContext } from '@/lib/caller-context';
import { getWebInvitationService } from '@/lib/invitations';

import type { InvitationActionState } from './invitation-form';

/**
 * Invitation server actions for the order detail page (D5 — spec 05/06).
 * Thin controllers: authenticate, hand to the invitation service (which
 * authorizes, validates order/session state and enqueues the
 * `invitations.dispatch` job), map the Result. No PII crosses this layer —
 * actions carry order/session ids only.
 */

export async function dispatchInvitationsAction(
  orderId: string,
  _prev: InvitationActionState,
  _formData: FormData
): Promise<InvitationActionState> {
  const caller = await requireCallerContext();
  const result = await getWebInvitationService().requestDispatch(caller, { orderId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return {
    status: 'success',
    message: 'Invitation dispatch queued — sessions move to invited as emails go out.',
  };
}

export async function resendInvitationAction(
  orderId: string,
  _prev: InvitationActionState,
  formData: FormData
): Promise<InvitationActionState> {
  const caller = await requireCallerContext();
  const sessionId = formData.get('sessionId');
  const result = await getWebInvitationService().requestResend(caller, {
    orderId,
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return {
    status: 'success',
    message: 'Invitation resend queued — a fresh PIN is generated for the new email.',
  };
}
