'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { isSuperAdmin } from '@assessify/domain';
import { getOrderService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  formStateFromError,
  parseOrderFormData,
  transitionStateFromError,
  type OrderFormState,
  type TransitionFormState,
} from './_lib/form';

export async function createOrderAction(
  _prev: OrderFormState,
  formData: FormData
): Promise<OrderFormState> {
  const caller = await requireCallerContext();

  const parsed = parseOrderFormData(formData);
  if (!parsed.ok) return parsed.state;

  // spec 06: placed_via records the surface — super admins order on behalf of
  // clients ('admin'); client-scoped roles order for themselves ('client').
  const placedVia = isSuperAdmin(caller) ? 'admin' : 'client';
  const result = await getOrderService().create(caller, { ...parsed.payload, placedVia });
  if (!result.ok) return formStateFromError(result.error);

  revalidatePath('/admin/orders');
  redirect(`/admin/orders/${result.value.id}`);
}

export async function transitionOrderAction(
  orderId: string,
  _prev: TransitionFormState,
  formData: FormData
): Promise<TransitionFormState> {
  const caller = await requireCallerContext();

  const event = formData.get('event');
  const reason = formData.get('reason');
  const input = {
    event: typeof event === 'string' ? event : '',
    ...(typeof reason === 'string' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
  };

  const result = await getOrderService().transition(caller, orderId, input);
  if (!result.ok) return transitionStateFromError(result.error);

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin/orders');
  return { status: 'idle' };
}
