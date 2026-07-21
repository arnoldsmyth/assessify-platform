'use server';

import { revalidatePath } from 'next/cache';

import { getOrderService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  transitionStateFromError,
  type TransitionFormState,
} from '../orders/_lib/form';

/**
 * Inline retry from the error queue (D7). Thin controller: the order service
 * owns the state machine, actor checks (retry is super_admin only — spec 05)
 * and the audit write; this action only shapes input and translates errors.
 * The event is bound server-side per row from the domain transition table.
 */
export async function retryOrderAction(
  orderId: string,
  event: string,
  _prev: TransitionFormState,
  _formData: FormData
): Promise<TransitionFormState> {
  const caller = await requireCallerContext();

  const result = await getOrderService().transition(caller, orderId, { event });
  if (!result.ok) return transitionStateFromError(result.error);

  revalidatePath('/admin/errors');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  return { status: 'idle' };
}
