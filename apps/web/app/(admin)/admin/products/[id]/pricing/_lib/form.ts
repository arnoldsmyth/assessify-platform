import type { DomainError } from '@assessify/domain';

/**
 * Pure helpers for the product price-list editor (M4). Prices are entered in
 * major units and stored as integer minor units (spec 04 money convention);
 * the money parser mirrors the order wizard's (D2 `admin/orders/_lib/form.ts`)
 * — strict, never guessing. All validation beyond money shaping lives in
 * organizationService's Zod schemas. Side-effect-free and unit-tested.
 */

export interface PriceFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `language`. */
  fieldErrors?: Record<string, string>;
}

export const initialPriceFormState: PriceFormState = { status: 'idle' };

export function priceStateFromError(error: DomainError): PriceFormState {
  if (error.code === 'organization/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  if (error.code === 'organization/language_not_available') {
    return {
      status: 'error',
      message: error.message,
      fieldErrors: { language: error.message },
    };
  }
  return { status: 'error', message: error.message };
}

/**
 * Strict decimal-major-units → integer-minor-units parser: "150" → 15000,
 * "150.5" → 15050, "150.50" → 15050. Null for anything else (negative,
 * thousands separators, >2 decimals, empty) — money is never guessed at.
 */
export function parseMoneyToMinor(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
}

/** Integer minor units → "150.00 EUR" for display. */
export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${currency}`;
}

export type ParsedPriceForm =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; state: PriceFormState };

/**
 * Map the price form onto organizationService.upsertPrice's payload. The
 * money conversion is judged here (it has no schema-side equivalent); the
 * rest passes through for the service's Zod schema, whose issue paths line
 * up with the field names used here.
 */
export function parsePriceFormData(productId: string, formData: FormData): ParsedPriceForm {
  const text = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };

  const unitPrice = parseMoneyToMinor(text('unitPrice'));
  if (unitPrice === null) {
    return {
      ok: false,
      state: {
        status: 'error',
        message: 'Please fix the highlighted fields.',
        fieldErrors: { unitPrice: 'Enter an amount like 150 or 150.00' },
      },
    };
  }

  return {
    ok: true,
    payload: {
      productId,
      language: text('language'),
      currency: text('currency').toUpperCase(),
      unitPrice,
    },
  };
}
