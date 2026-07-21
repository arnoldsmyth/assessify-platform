'use client';

import {
  useActionState,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { Plus, Trash2 } from 'lucide-react';

import {
  orderableCurrencies,
  resolveOrderUnitPrice,
  type OrderPricingSource,
} from '@assessify/domain';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  cn,
} from '@assessify/ui';

import {
  formatMinor,
  parseMoneyToMinor,
  parseRespondentsCsv,
  type OrderFormState,
  type RespondentRow,
  type WizardClient,
  type WizardProduct,
} from '../_lib/form';

/**
 * Multi-step order wizard (spec 06 "Admin/client wizard"): client → product →
 * respondents → pricing → review. Products are loaded per selected client
 * (M3: only same-organization products the client has access to), and the
 * pricing step resolves the unit price from the org price list by (report
 * language, currency) — super admins may override it, everyone else is held
 * to the resolved price. Client-side state is convenience only — the server
 * action re-parses and the order service is the authority. Payment + submit
 * (draft → pending) happen on the order detail page after creation.
 */

export type { WizardClient, WizardProduct };

interface OrderWizardProps {
  clients: WizardClient[];
  isSuperAdmin: boolean;
  action: (state: OrderFormState, formData: FormData) => Promise<OrderFormState>;
  /** Server action: products the given client may order (empty on denial). */
  loadProducts: (clientId: string) => Promise<WizardProduct[]>;
}

function pricingSource(product: WizardProduct): OrderPricingSource {
  return {
    prices: product.prices,
    retailPrice: product.retailPrice,
    retailCurrency: product.retailCurrency,
  };
}

/** Preferred currency for a product/language: the client's default if priced, else the first priced option. */
function pickCurrency(
  product: WizardProduct,
  language: string,
  preferred: string | undefined
): string {
  const options = orderableCurrencies(pricingSource(product), language);
  if (preferred && options.includes(preferred)) return preferred;
  return options[0] ?? preferred ?? 'EUR';
}

const STEPS = ['Client', 'Product', 'Respondents', 'Pricing', 'Review'] as const;

const emptyRow = (): RespondentRow => ({ firstName: '', lastName: '', email: '' });

function rowComplete(row: RespondentRow): boolean {
  return row.firstName.trim() !== '' && row.lastName.trim() !== '' && row.email.trim() !== '';
}

export function OrderWizard({ clients, isSuperAdmin, action, loadProducts }: OrderWizardProps) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  const [step, setStep] = useState(0);

  const [clientId, setClientId] = useState(clients.length === 1 ? (clients[0]?.id ?? '') : '');
  const [products, setProducts] = useState<WizardProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productId, setProductId] = useState('');
  const [orderType, setOrderType] = useState<'named' | 'bulk_named'>('named');
  const [reportLanguage, setReportLanguage] = useState('en');
  const [entryMode, setEntryMode] = useState<'rows' | 'csv'>('rows');
  const [rows, setRows] = useState<RespondentRow[]>([emptyRow()]);
  const [csvText, setCsvText] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [discount, setDiscount] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [isTest, setIsTest] = useState(false);

  const client = clients.find((c) => c.id === clientId);
  const product = products.find((p) => p.id === productId);

  // The catalogue depends on the selected client (M3: same organization +
  // access). Re-fetch on every client change; ignore stale responses.
  useEffect(() => {
    if (clientId === '') {
      setProducts([]);
      return;
    }
    let cancelled = false;
    setProductsLoading(true);
    loadProducts(clientId)
      .then((list) => {
        if (!cancelled) setProducts(list);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      })
      .finally(() => {
        if (!cancelled) setProductsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, loadProducts]);

  const csvPreview = useMemo(
    () => (entryMode === 'csv' && csvText.trim() !== '' ? parseRespondentsCsv(csvText) : null),
    [entryMode, csvText]
  );
  const respondentCount =
    entryMode === 'csv' ? (csvPreview?.ok ? csvPreview.rows.length : 0) : rows.length;

  const unitPriceMinor = parseMoneyToMinor(unitPrice);
  const discountMinor = discount.trim() === '' ? 0 : parseMoneyToMinor(discount);
  const subtotalMinor = unitPriceMinor === null ? null : unitPriceMinor * respondentCount;
  const totalMinor =
    subtotalMinor === null || discountMinor === null ? null : subtotalMinor - discountMinor;

  const description = product ? `${product.name} assessment` : 'Assessment';

  // Resolved price for the current (product, report language, currency) —
  // mirrors the order service's enforcement (price list → retail fallback).
  const resolvedPrice = product
    ? resolveOrderUnitPrice(pricingSource(product), reportLanguage, currency)
    : null;
  const currencyOptions = product
    ? orderableCurrencies(pricingSource(product), reportLanguage)
    : [];
  const priceLocked = !isSuperAdmin;

  function applyResolvedPrice(target: WizardProduct, language: string, nextCurrency: string) {
    const resolved = resolveOrderUnitPrice(pricingSource(target), language, nextCurrency);
    setUnitPrice(resolved ? (resolved.unitPrice / 100).toFixed(2) : '');
  }

  function selectClient(id: string) {
    setClientId(id);
    // The catalogue changes with the client — never keep a stale product.
    setProductId('');
    setUnitPrice('');
  }

  function selectProduct(id: string) {
    setProductId(id);
    const next = products.find((p) => p.id === id);
    if (!next) return;
    setReportLanguage(next.defaultLanguage);
    const nextCurrency = pickCurrency(next, next.defaultLanguage, client?.defaultCurrency);
    setCurrency(nextCurrency);
    applyResolvedPrice(next, next.defaultLanguage, nextCurrency);
  }

  function selectLanguage(language: string) {
    setReportLanguage(language);
    if (!product) return;
    // Prices are per language edition — re-pick the currency and price.
    const nextCurrency = pickCurrency(product, language, currency);
    setCurrency(nextCurrency);
    applyResolvedPrice(product, language, nextCurrency);
  }

  function selectCurrency(nextCurrency: string) {
    setCurrency(nextCurrency);
    if (product) applyResolvedPrice(product, reportLanguage, nextCurrency);
  }

  function selectType(type: 'named' | 'bulk_named') {
    setOrderType(type);
    if (type === 'named') {
      setEntryMode('rows');
      setRows((current) => [current[0] ?? emptyRow()]);
    }
  }

  const stepReady: boolean[] = [
    clientId !== '',
    product !== undefined && product.activeSelfVersion !== null,
    entryMode === 'csv'
      ? csvPreview !== null && csvPreview.ok
      : rows.length > 0 && rows.every(rowComplete),
    unitPriceMinor !== null &&
      discountMinor !== null &&
      /^[A-Z]{3}$/.test(currency) &&
      (totalMinor ?? -1) >= 0 &&
      // Non-super-admins are held to the resolved price (the service enforces
      // it) — don't let them submit an order that will be rejected.
      (!priceLocked ||
        (resolvedPrice !== null && unitPriceMinor === resolvedPrice.unitPrice)),
    true,
  ];

  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-6">
      {/* Canonical values — the only inputs that post. */}
      <input type="hidden" name="type" value={orderType} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="productId" value={productId} />
      <input
        type="hidden"
        name="questionnaireVersionId"
        value={product?.activeSelfVersion?.id ?? ''}
      />
      <input type="hidden" name="reportLanguage" value={reportLanguage} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="unitPrice" value={unitPrice} />
      <input type="hidden" name="discount" value={discount} />
      <input type="hidden" name="description" value={description} />
      {isTest ? <input type="hidden" name="isTest" value="on" /> : null}
      {entryMode === 'csv' ? (
        <input type="hidden" name="respondentsCsv" value={csvText} />
      ) : (
        <input
          type="hidden"
          name="respondentsJson"
          value={JSON.stringify(
            rows.map((row) => ({
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              ...(row.language && row.language.trim() !== '' ? { language: row.language } : {}),
            }))
          )}
        />
      )}

      <StepIndicator step={step} />

      {state.status === 'error' ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm text-red"
        >
          {state.message ? <p className="font-medium">{state.message}</p> : null}
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs">
              {Object.entries(state.fieldErrors).map(([path, message]) => (
                <li key={path}>
                  <code className="rounded bg-surface px-1 py-0.5 font-mono">{path}</code>{' '}
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
          {state.csvErrors && state.csvErrors.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs">
              {state.csvErrors.map((error) => (
                <li key={`${error.line}-${error.message}`}>
                  Line {error.line}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client</CardTitle>
            <CardDescription>
              {isSuperAdmin
                ? 'Super admins can place an order on behalf of any client.'
                : 'The order is placed for one of your clients.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            <label htmlFor="wizard-client" className="text-sm font-medium text-ink">
              Order for
            </label>
            <select
              id="wizard-client"
              value={clientId}
              onChange={(event) => selectClient(event.target.value)}
              className="flex h-9 w-full max-w-md rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Product & order model</CardTitle>
            <CardDescription>
              The order pins the product&rsquo;s active questionnaire version at creation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="wizard-product" className="text-sm font-medium text-ink">
                Product
              </label>
              <select
                id="wizard-product"
                value={productId}
                onChange={(event) => selectProduct(event.target.value)}
                disabled={productsLoading}
                className="flex h-9 w-full max-w-md rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
              >
                <option value="">
                  {productsLoading ? 'Loading products…' : 'Select a product…'}
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {!productsLoading && products.length === 0 ? (
                <p className="text-xs font-medium text-red">
                  This client has no orderable products — they can only order their own
                  organization&rsquo;s products they have access to.
                </p>
              ) : null}
              {product ? (
                product.activeSelfVersion ? (
                  <p className="text-xs text-muted">
                    Questionnaire version v{product.activeSelfVersion.version} (active) will be
                    pinned to this order.
                  </p>
                ) : (
                  <p className="text-xs font-medium text-red">
                    This product has no active questionnaire version — activate one before
                    ordering.
                  </p>
                )
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-ink">Order model</legend>
              {(
                [
                  ['named', 'Named', 'One known respondent — one invitation, one report.'],
                  [
                    'bulk_named',
                    'Bulk named',
                    'Many known respondents — one invitation and one report each.',
                  ],
                ] as const
              ).map(([value, label, help]) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3',
                    orderType === value ? 'border-primary bg-primary-tint/40' : 'border-border'
                  )}
                >
                  <input
                    type="radio"
                    checked={orderType === value}
                    onChange={() => selectType(value)}
                    className="mt-1"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{label}</span>
                    <span className="text-xs text-muted">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="wizard-language" className="text-sm font-medium text-ink">
                Report language
              </label>
              <select
                id="wizard-language"
                value={reportLanguage}
                onChange={(event) => selectLanguage(event.target.value)}
                className="flex h-9 w-full max-w-48 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {(product?.availableLanguages ?? ['en']).map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Respondents</CardTitle>
            <CardDescription>
              {orderType === 'named'
                ? 'The single respondent this order covers.'
                : 'Enter respondents as rows, or paste them from a spreadsheet or CSV.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {orderType === 'bulk_named' ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={entryMode === 'rows' ? 'secondary' : 'outline'}
                  onClick={() => setEntryMode('rows')}
                >
                  Rows
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={entryMode === 'csv' ? 'secondary' : 'outline'}
                  onClick={() => setEntryMode('csv')}
                >
                  CSV paste
                </Button>
              </div>
            ) : null}

            {entryMode === 'rows' ? (
              <div className="flex flex-col gap-3">
                {rows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <RowField
                      label="First name"
                      value={row.firstName}
                      onChange={(value) => updateRow(setRows, index, { firstName: value })}
                    />
                    <RowField
                      label="Last name"
                      value={row.lastName}
                      onChange={(value) => updateRow(setRows, index, { lastName: value })}
                    />
                    <RowField
                      label="Email"
                      type="email"
                      value={row.email}
                      onChange={(value) => updateRow(setRows, index, { email: value })}
                      wide
                    />
                    <RowField
                      label="Language"
                      value={row.language ?? ''}
                      placeholder={reportLanguage}
                      onChange={(value) => updateRow(setRows, index, { language: value })}
                      narrow
                    />
                    {orderType === 'bulk_named' && rows.length > 1 ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove respondent ${index + 1}`}
                        onClick={() =>
                          setRows((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {orderType === 'bulk_named' ? (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setRows((current) => [...current, emptyRow()])}
                    >
                      <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                      Add respondent
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <label htmlFor="wizard-csv" className="text-sm font-medium text-ink">
                  One respondent per line: first name, last name, email, optional language
                </label>
                <textarea
                  id="wizard-csv"
                  rows={10}
                  value={csvText}
                  onChange={(event) => setCsvText(event.target.value)}
                  spellCheck={false}
                  placeholder={'Ada,Lovelace,ada@example.com\nAlan,Turing,alan@example.com,fr'}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
                {csvPreview ? (
                  csvPreview.ok ? (
                    <p className="text-xs text-teal">
                      {csvPreview.rows.length} respondent{csvPreview.rows.length === 1 ? '' : 's'}{' '}
                      parsed.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5 text-xs text-red">
                      {csvPreview.errors.slice(0, 10).map((error) => (
                        <li key={`${error.line}-${error.message}`}>
                          Line {error.line}: {error.message}
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <p className="text-xs text-muted">
                    Commas or tabs both work — paste straight from a spreadsheet. A header row is
                    skipped automatically.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pricing</CardTitle>
            <CardDescription>
              Prices are snapshotted on the order in integer minor units — later price changes
              never affect existing orders.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wizard-unit-price" className="text-sm font-medium text-ink">
                  Unit price ({currency})
                </label>
                <Input
                  id="wizard-unit-price"
                  value={unitPrice}
                  onChange={(event) => setUnitPrice(event.target.value)}
                  placeholder="150.00"
                  inputMode="decimal"
                  readOnly={priceLocked}
                  className={cn('w-36', priceLocked && 'bg-surface-page text-muted')}
                />
                {unitPrice !== '' && unitPriceMinor === null ? (
                  <p className="text-xs text-red">Enter an amount like 150 or 150.00</p>
                ) : null}
                {resolvedPrice ? (
                  <p className="text-xs text-muted">
                    {resolvedPrice.source === 'price_list'
                      ? `List price for ${reportLanguage}/${currency}: `
                      : 'Retail price (no list price for this language): '}
                    {formatMinor(resolvedPrice.unitPrice, currency)}
                    {isSuperAdmin &&
                    unitPriceMinor !== null &&
                    unitPriceMinor !== resolvedPrice.unitPrice
                      ? ' — manually overridden'
                      : ''}
                  </p>
                ) : (
                  <p className={cn('text-xs', priceLocked ? 'font-medium text-red' : 'text-muted')}>
                    {priceLocked
                      ? `No price is configured for ${reportLanguage} in ${currency} — ask the product's organization to add one.`
                      : `No price configured for ${reportLanguage}/${currency} — enter one manually (super admin).`}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wizard-currency" className="text-sm font-medium text-ink">
                  Currency
                </label>
                {priceLocked ? (
                  <select
                    id="wizard-currency"
                    value={currency}
                    onChange={(event) => selectCurrency(event.target.value)}
                    className="flex h-9 w-24 rounded-md border border-border bg-surface px-3 py-1 font-mono text-sm uppercase text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {(currencyOptions.length > 0 ? currencyOptions : [currency]).map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="wizard-currency"
                    value={currency}
                    onChange={(event) => selectCurrency(event.target.value.toUpperCase())}
                    maxLength={3}
                    className="w-24 font-mono uppercase"
                  />
                )}
              </div>
              {isSuperAdmin ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="wizard-discount" className="text-sm font-medium text-ink">
                    Discount ({currency})
                  </label>
                  <Input
                    id="wizard-discount"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="w-36"
                  />
                  <p className="text-xs text-muted">Whole-order discount (super admin only).</p>
                </div>
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={isTest}
                onChange={(event) => setIsTest(event.target.checked)}
              />
              Test order — full flow, excluded from all revenue and entitlement reporting
            </label>

            <PricingSummary
              respondentCount={respondentCount}
              unitPriceMinor={unitPriceMinor}
              discountMinor={discountMinor}
              totalMinor={totalMinor}
              currency={currency}
            />
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review</CardTitle>
            <CardDescription>
              The order is created as a draft — submit it for payment from the order page.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
              <dt className="text-muted">Client</dt>
              <dd className="text-ink">{client?.name ?? '—'}</dd>
              <dt className="text-muted">Product</dt>
              <dd className="text-ink">
                {product?.name ?? '—'}
                {product?.activeSelfVersion ? (
                  <span className="text-muted"> · questionnaire v{product.activeSelfVersion.version}</span>
                ) : null}
              </dd>
              <dt className="text-muted">Order model</dt>
              <dd className="text-ink">{orderType === 'named' ? 'Named' : 'Bulk named'}</dd>
              <dt className="text-muted">Report language</dt>
              <dd className="font-mono text-xs text-ink">{reportLanguage}</dd>
              <dt className="text-muted">Respondents</dt>
              <dd className="text-ink">{respondentCount}</dd>
              {isTest ? (
                <>
                  <dt className="text-muted">Test order</dt>
                  <dd className="text-ink">Yes</dd>
                </>
              ) : null}
            </dl>

            <PricingSummary
              respondentCount={respondentCount}
              unitPriceMinor={unitPriceMinor}
              discountMinor={discountMinor}
              totalMinor={totalMinor}
              currency={currency}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || pending}
        >
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button
            type="button"
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            disabled={!stepReady[step]}
          >
            Next
          </Button>
        ) : (
          <Button type="submit" disabled={pending || stepReady.some((ready) => !ready)}>
            {pending ? 'Creating…' : 'Create draft order'}
          </Button>
        )}
      </div>
    </form>
  );
}

function updateRow(
  setRows: Dispatch<SetStateAction<RespondentRow[]>>,
  index: number,
  patch: Partial<RespondentRow>
) {
  setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
}

function RowField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  wide,
  narrow,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  wide?: boolean;
  narrow?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
      {label}
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn('w-40', wide && 'w-64', narrow && 'w-24')}
      />
    </label>
  );
}

function PricingSummary({
  respondentCount,
  unitPriceMinor,
  discountMinor,
  totalMinor,
  currency,
}: {
  respondentCount: number;
  unitPriceMinor: number | null;
  discountMinor: number | null;
  totalMinor: number | null;
  currency: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-page px-4 py-3 text-sm">
      <div className="flex justify-between text-body">
        <span>
          {respondentCount} × {unitPriceMinor === null ? '—' : formatMinor(unitPriceMinor, currency)}
        </span>
        <span>
          {unitPriceMinor === null ? '—' : formatMinor(unitPriceMinor * respondentCount, currency)}
        </span>
      </div>
      {discountMinor !== null && discountMinor > 0 ? (
        <div className="flex justify-between text-body">
          <span>Discount</span>
          <span>-{formatMinor(discountMinor, currency)}</span>
        </div>
      ) : null}
      <div className="mt-1 flex justify-between border-t border-border pt-1 font-medium text-ink">
        <span>Total</span>
        <span>{totalMinor === null ? '—' : formatMinor(totalMinor, currency)}</span>
      </div>
      {totalMinor !== null && totalMinor < 0 ? (
        <p className="mt-1 text-xs text-red">The discount cannot exceed the subtotal.</p>
      ) : null}
    </div>
  );
}

function StepIndicator({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold',
              index < step && 'border-teal bg-teal-tint text-teal',
              index === step && 'border-primary bg-primary text-white',
              index > step && 'border-border bg-surface text-muted'
            )}
          >
            {index + 1}
          </span>
          <span className={cn('font-medium', index === step ? 'text-ink' : 'text-muted')}>
            {label}
          </span>
          {index < STEPS.length - 1 ? <span className="text-border">—</span> : null}
        </li>
      ))}
    </ol>
  );
}
