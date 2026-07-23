'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getClientService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  formStateFromError,
  parseClientFormData,
  type ClientFormState,
} from './_lib/form';

export async function createClientAction(
  _prev: ClientFormState,
  formData: FormData
): Promise<ClientFormState> {
  const caller = await requireCallerContext();
  const result = await getClientService().create(caller, parseClientFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/clients');
  redirect(`/admin/clients/${result.value.id}`);
}

export async function updateClientAction(
  id: string,
  _prev: ClientFormState,
  formData: FormData
): Promise<ClientFormState> {
  const caller = await requireCallerContext();
  const result = await getClientService().update(caller, id, parseClientFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/clients');
  revalidatePath(`/admin/clients/${id}`);
  redirect('/admin/clients');
}
