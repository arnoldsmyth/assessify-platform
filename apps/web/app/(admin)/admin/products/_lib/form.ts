import type { BrandingConfig, DomainError, Product } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the product create/edit forms.
 * Controllers only map input and translate errors — all validation and
 * business rules live in productService (appendix-architecture-layers.md §3a).
 */

export interface ProductFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `branding.colors.primary`. */
  fieldErrors?: Record<string, string>;
}

export const initialProductFormState: ProductFormState = { status: 'idle' };

export function formStateFromError(error: DomainError): ProductFormState {
  if (error.code === 'product/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  if (error.code === 'product/slug_taken') {
    return { status: 'error', message: error.message, fieldErrors: { slug: error.message } };
  }
  return { status: 'error', message: error.message };
}

/** Client-safe view of a product for prefilling the form. */
export interface ProductFormValues {
  slug: string;
  name: string;
  defaultAccess: boolean;
  defaultLanguage: string;
  availableLanguages: string[];
  timezone: string;
  reportPageSizeDefault: 'a4' | 'letter';
  retailEnabled: boolean;
  retailPrice: number | null;
  retailCurrency: string | null;
  scoringConfig: { mode: 'sync_internal' | 'async_external'; engineKey?: string; endpoint?: string };
  branding: BrandingConfig;
}

export function toFormValues(product: Product): ProductFormValues {
  return {
    slug: product.slug,
    name: product.name,
    defaultAccess: product.defaultAccess,
    defaultLanguage: product.defaultLanguage,
    availableLanguages: product.availableLanguages,
    timezone: product.timezone,
    reportPageSizeDefault: product.reportPageSizeDefault,
    retailEnabled: product.retailEnabled,
    retailPrice: product.retailPrice,
    retailCurrency: product.retailCurrency,
    scoringConfig: {
      mode: product.scoringConfig.mode,
      ...(product.scoringConfig.engineKey ? { engineKey: product.scoringConfig.engineKey } : {}),
      ...(product.scoringConfig.endpoint ? { endpoint: product.scoringConfig.endpoint } : {}),
    },
    branding: product.branding,
  };
}

const BRANDING_COLOUR_KEYS = ['primary', 'primaryDark', 'accent', 'surfaceTint', 'ink'] as const;

/**
 * Map the flat form fields to the nested service payload. Deliberately does
 * no validation beyond shaping — the service's Zod schemas are the source of
 * truth and their issue paths line up with the input names used here.
 */
export function parseProductFormData(formData: FormData): unknown {
  const text = (name: string): string | undefined => {
    const value = formData.get(name);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  const colors: Record<string, string> = {};
  for (const key of BRANDING_COLOUR_KEYS) {
    const value = text(`branding.colors.${key}`);
    if (value) colors[key] = value;
  }

  const branding: Record<string, unknown> = {};
  const logoUrl = text('branding.logoUrl');
  if (logoUrl) branding.logoUrl = logoUrl;
  const faviconUrl = text('branding.faviconUrl');
  if (faviconUrl) branding.faviconUrl = faviconUrl;
  const fontFamily = text('branding.fontFamily');
  if (fontFamily) branding.fontFamily = fontFamily;
  if (Object.keys(colors).length > 0) branding.colors = colors;
  const emailFromName = text('branding.emailFrom.name');
  const emailFromAddress = text('branding.emailFrom.address');
  if (emailFromName || emailFromAddress) {
    branding.emailFrom = {
      ...(emailFromName ? { name: emailFromName } : {}),
      ...(emailFromAddress ? { address: emailFromAddress } : {}),
    };
  }

  const scoringConfig: Record<string, unknown> = {
    mode: text('scoringConfig.mode') ?? 'sync_internal',
  };
  const engineKey = text('scoringConfig.engineKey');
  if (engineKey) scoringConfig.engineKey = engineKey;
  const endpoint = text('scoringConfig.endpoint');
  if (endpoint) scoringConfig.endpoint = endpoint;

  // Only the create form renders the organization picker (M4). The update
  // schema is strict and org reassignment is a separate super_admin
  // operation, so the key must be absent when the field is not in the form.
  const organizationId = text('organizationId');

  const retailPriceRaw = text('retailPrice');
  const retailPrice =
    retailPriceRaw === undefined
      ? null
      : /^\d+$/.test(retailPriceRaw)
        ? Number(retailPriceRaw)
        : retailPriceRaw; // let the schema report the type error

  return {
    ...(formData.has('organizationId') ? { organizationId: organizationId ?? '' } : {}),
    slug: text('slug') ?? '',
    name: text('name') ?? '',
    defaultAccess: formData.get('defaultAccess') === 'on',
    branding,
    defaultLanguage: text('defaultLanguage') ?? 'en',
    availableLanguages:
      text('availableLanguages')
        ?.split(',')
        .map((tag) => tag.trim())
        .filter(Boolean) ?? ['en'],
    scoringConfig,
    reportPageSizeDefault: text('reportPageSizeDefault') ?? 'a4',
    retailEnabled: formData.get('retailEnabled') === 'on',
    retailPrice,
    retailCurrency: text('retailCurrency') ?? null,
    timezone: text('timezone') ?? 'Europe/Dublin',
  };
}
