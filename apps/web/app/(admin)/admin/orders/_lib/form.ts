import type { DomainError } from '@assessify/domain';

/**
 * Pure form helpers for the order wizard + detail page (D2 — spec 06).
 * Controllers only shape input and translate errors — the create payload's
 * real validation lives in the order service's Zod schemas
 * (appendix-architecture-layers.md §3a). Everything here is side-effect-free
 * and unit-tested (`form.test.ts`).
 */

// ---------------------------------------------------------------------------
// Wizard data shapes (shared by the page, the products server action and the
// client component — kept here so all three agree on one projection)
// ---------------------------------------------------------------------------

export interface WizardClient {
  id: string;
  name: string;
  clientNumber: number;
  defaultCurrency: string;
}

/** One org price-list row (integer minor units). */
export interface WizardProductPrice {
  language: string;
  currency: string;
  unitPrice: number;
}

/**
 * Product as the wizard sees it: only products the SELECTED client may order
 * (same organization + access — M3), with the price list for the pricing
 * step. Loaded per client via the `listWizardProductsAction` server action.
 */
export interface WizardProduct {
  id: string;
  name: string;
  defaultLanguage: string;
  availableLanguages: string[];
  prices: WizardProductPrice[];
  retailPrice: number | null;
  retailCurrency: string | null;
  /** Active 'self' questionnaire version — orders pin it at creation. */
  activeSelfVersion: { id: string; version: number } | null;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

export interface OrderFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `respondents.2.email`. */
  fieldErrors?: Record<string, string>;
  /** Line-numbered CSV parse errors (1-based, original line numbers). */
  csvErrors?: CsvError[];
}

export const initialOrderFormState: OrderFormState = { status: 'idle' };

export function formStateFromError(error: DomainError): OrderFormState {
  if (error.code === 'order/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  return { status: 'error', message: error.message };
}

export interface TransitionFormState {
  status: 'idle' | 'error';
  message?: string;
  /** From `order/illegal_transition` detail — what WOULD be legal now. */
  legalEvents?: string[];
}

export const initialTransitionFormState: TransitionFormState = { status: 'idle' };

export function transitionStateFromError(error: DomainError): TransitionFormState {
  if (error.code === 'order/illegal_transition') {
    const legalEvents = Array.isArray(error.detail?.legalEvents)
      ? (error.detail.legalEvents as string[])
      : undefined;
    return {
      status: 'error',
      message: error.message,
      ...(legalEvents ? { legalEvents } : {}),
    };
  }
  return { status: 'error', message: error.message };
}

// ---------------------------------------------------------------------------
// Money (integer minor units — spec 06 pricing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Respondent CSV paste (bulk_named — spec 06 wizard step 2)
// ---------------------------------------------------------------------------

export interface RespondentRow {
  firstName: string;
  lastName: string;
  email: string;
  language?: string;
}

export interface CsvError {
  /** 1-based line number in the pasted text. */
  line: number;
  message: string;
}

export type CsvParseResult =
  | { ok: true; rows: RespondentRow[] }
  | { ok: false; errors: CsvError[] };

/** Split one line into fields: tab-separated (spreadsheet paste) wins, else comma with double-quote escaping. */
function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((field) => field.trim());
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

const HEADER_HINTS = ['email', 'e-mail', 'firstname', 'first name'];

function isHeaderLine(fields: string[]): boolean {
  return fields.some((field) => HEADER_HINTS.includes(field.toLowerCase().replace(/[_-]/g, ' ')));
}

/** Cheap plausibility check — the domain schema is the real authority. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse pasted respondent lines: `first,last,email[,language]` — comma- or
 * tab-separated, optional header row, optional quoting. All-or-nothing:
 * any bad line fails the whole paste with per-line errors (server-side
 * strict; the order service's Zod schema re-validates the result).
 */
export function parseRespondentsCsv(text: string): CsvParseResult {
  const rows: RespondentRow[] = [];
  const errors: CsvError[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let seenContent = false;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    const fields = splitLine(line);
    if (!seenContent) {
      seenContent = true;
      if (isHeaderLine(fields)) return;
    }
    const lineNo = index + 1;
    if (fields.length < 3 || fields.length > 4) {
      errors.push({
        line: lineNo,
        message: `Expected 3 or 4 columns (first name, last name, email, optional language) — got ${fields.length}`,
      });
      return;
    }
    const [firstName = '', lastName = '', email = '', language] = fields;
    if (firstName === '') {
      errors.push({ line: lineNo, message: 'First name is required' });
      return;
    }
    if (lastName === '') {
      errors.push({ line: lineNo, message: 'Last name is required' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ line: lineNo, message: `"${email}" is not a valid email address` });
      return;
    }
    rows.push({
      firstName,
      lastName,
      email,
      ...(language ? { language } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 1, message: 'Paste at least one respondent line' }] };
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// FormData → service payload
// ---------------------------------------------------------------------------

export type ParsedOrderForm =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; state: OrderFormState };

function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Shape-check the wizard's structured rows (hidden respondentsJson field). */
function rowsFromJson(json: string): RespondentRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: RespondentRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const { firstName, lastName, email, language } = record;
    if (
      typeof firstName !== 'string' ||
      typeof lastName !== 'string' ||
      typeof email !== 'string' ||
      (language !== undefined && typeof language !== 'string')
    ) {
      return null;
    }
    rows.push({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      ...(language && language.trim() !== '' ? { language: language.trim() } : {}),
    });
  }
  return rows;
}

/**
 * Map the wizard's FormData onto the order service's create payload. CSV /
 * money mapping errors are reported here with their own channels; everything
 * else is deliberately passed through for the service's Zod schema to judge
 * (its issue paths line up with the wizard's field names).
 */
export function parseOrderFormData(formData: FormData): ParsedOrderForm {
  // Respondents: raw CSV (csv mode) or structured rows (row mode).
  const csv = text(formData, 'respondentsCsv');
  let respondents: RespondentRow[];
  if (csv !== undefined) {
    const parsed = parseRespondentsCsv(csv);
    if (!parsed.ok) {
      return {
        ok: false,
        state: {
          status: 'error',
          message: 'Fix the respondent CSV errors below.',
          csvErrors: parsed.errors,
        },
      };
    }
    respondents = parsed.rows;
  } else {
    const rows = rowsFromJson(text(formData, 'respondentsJson') ?? '[]');
    if (rows === null) {
      return {
        ok: false,
        state: { status: 'error', message: 'Respondent rows were malformed — re-enter them.' },
      };
    }
    respondents = rows;
  }

  const unitPriceText = text(formData, 'unitPrice') ?? '';
  const unitPrice = parseMoneyToMinor(unitPriceText);
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

  const discountText = text(formData, 'discount');
  const discount = discountText === undefined ? 0 : parseMoneyToMinor(discountText);
  if (discount === null) {
    return {
      ok: false,
      state: {
        status: 'error',
        message: 'Please fix the highlighted fields.',
        fieldErrors: { discount: 'Enter an amount like 0 or 25.00' },
      },
    };
  }

  const payload: Record<string, unknown> = {
    type: text(formData, 'type') ?? '',
    clientId: text(formData, 'clientId') ?? '',
    productId: text(formData, 'productId') ?? '',
    questionnaireVersionId: text(formData, 'questionnaireVersionId') ?? '',
    reportLanguage: text(formData, 'reportLanguage') ?? 'en',
    currency: text(formData, 'currency') ?? '',
    items: [
      {
        description: text(formData, 'description') ?? 'Assessment',
        unitPrice,
        discount,
        quantity: respondents.length,
      },
    ],
    respondents,
    isTest: formData.get('isTest') === 'on',
  };
  return { ok: true, payload };
}
