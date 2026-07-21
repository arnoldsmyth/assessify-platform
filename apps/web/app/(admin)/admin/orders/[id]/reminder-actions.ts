'use server';

import { revalidatePath } from 'next/cache';

import { requireCallerContext } from '@/lib/caller-context';
import { getWebReminderService } from '@/lib/reminders';

import type { ReminderActionState } from './reminder-form';

/**
 * Reminder server actions for the order detail page (D6 — spec 13/05).
 * Thin controllers: authenticate, hand to the reminder service (which
 * authorizes against the order's client scope, checks session/order state
 * and writes the audit trail), map the Result. No PII crosses this layer —
 * actions carry order/session ids only.
 */

export async function sendReminderAction(
  orderId: string,
  _prev: ReminderActionState,
  formData: FormData
): Promise<ReminderActionState> {
  const caller = await requireCallerContext();
  const sessionId = formData.get('sessionId');
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { status: 'error', message: 'Missing session.' };
  }
  const result = await getWebReminderService().sendManual(caller, { sessionId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return { status: 'success', message: 'Reminder queued.' };
}

export async function setReminderSuppressionAction(
  orderId: string,
  _prev: ReminderActionState,
  formData: FormData
): Promise<ReminderActionState> {
  const caller = await requireCallerContext();
  const sessionId = formData.get('sessionId');
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { status: 'error', message: 'Missing session.' };
  }
  const suppressed = formData.get('suppressed') === 'true';
  const result = await getWebReminderService().setSuppressed(caller, { sessionId, suppressed });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return {
    status: 'success',
    message: suppressed ? 'Reminders suppressed.' : 'Reminders resumed.',
  };
}
