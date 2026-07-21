'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { isSuperAdmin } from '@assessify/domain';
import {
  getOrderService,
  getProductService,
  getQuestionnaireVersionService,
} from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  formStateFromError,
  parseOrderFormData,
  transitionStateFromError,
  type OrderFormState,
  type TransitionFormState,
  type WizardProduct,
} from './_lib/form';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Products the given client may order (M3: same organization + access), with
 * price list and pinned questionnaire version — fetched by the wizard when
 * the client selection changes. Authorization lives in the product service
 * (spec 05: the caller must be able to place orders FOR this client); a
 * denial or unknown client simply yields an empty catalogue.
 */
export async function listWizardProductsAction(clientId: string): Promise<WizardProduct[]> {
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return [];
  const caller = await requireCallerContext();

  const result = await getProductService().listOrderable(caller, clientId);
  if (!result.ok) return [];

  // Resolve each product's active 'self' questionnaire version — the wizard
  // pins it on the order (spec 06). Products without one are shown disabled.
  const versionService = getQuestionnaireVersionService();
  return Promise.all(
    result.value.map(async (product): Promise<WizardProduct> => {
      const versions = await versionService.listActiveForOrdering(caller, product.id);
      const activeSelf = versions.ok
        ? (versions.value.find((version) => version.variant === 'self') ?? null)
        : null;
      return {
        id: product.id,
        name: product.name,
        defaultLanguage: product.defaultLanguage,
        availableLanguages: product.availableLanguages,
        prices: product.prices,
        retailPrice: product.retailPrice,
        retailCurrency: product.retailCurrency,
        activeSelfVersion: activeSelf ? { id: activeSelf.id, version: activeSelf.version } : null,
      };
    })
  );
}

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
