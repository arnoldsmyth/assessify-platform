'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  formStateFromError,
  parseOrganizationFormData,
  type OrganizationFormState,
} from './_lib/form';

export async function createOrganizationAction(
  _prev: OrganizationFormState,
  formData: FormData
): Promise<OrganizationFormState> {
  const caller = await requireCallerContext();
  const result = await getOrganizationService().create(
    caller,
    parseOrganizationFormData(formData)
  );
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/organizations');
  redirect(`/admin/organizations/${result.value.id}`);
}

export async function updateOrganizationAction(
  id: string,
  _prev: OrganizationFormState,
  formData: FormData
): Promise<OrganizationFormState> {
  const caller = await requireCallerContext();
  const result = await getOrganizationService().update(
    caller,
    id,
    parseOrganizationFormData(formData)
  );
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/organizations');
  revalidatePath(`/admin/organizations/${id}`);
  redirect('/admin/organizations');
}

export async function archiveOrganizationAction(id: string): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getOrganizationService().archive(caller, id);
  if (!result.ok) {
    // No form-state channel for this row action; the id comes from a
    // server-rendered page, so an expected failure still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath('/admin/organizations');
  revalidatePath(`/admin/organizations/${id}`);
  redirect('/admin/organizations');
}
