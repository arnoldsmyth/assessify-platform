'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, cn } from '@assessify/ui';

import { initialPriceFormState, type PriceFormState } from '../_lib/form';

interface PriceFormProps {
  action: (state: PriceFormState, formData: FormData) => Promise<PriceFormState>;
  /** The product's availableLanguages — prices exist per language edition. */
  languages: string[];
}

/**
 * Add-or-overwrite one price-list row. Upserting an existing
 * (language, currency) pair overwrites its price — that IS the edit flow.
 */
export function PriceForm({ action, languages }: PriceFormProps) {
  const [state, formAction, pending] = useActionState(action, initialPriceFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add or update a price</CardTitle>
        <CardDescription>
          One row per language edition and currency. Saving an existing language + currency pair
          overwrites its price.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {state.status === 'error' && state.message ? (
            <div
              role="alert"
              className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
            >
              {state.message}
            </div>
          ) : null}
          <div className="grid items-start gap-4 sm:grid-cols-4">
            <Field label="Language" name="language" error={errors.language}>
              <select
                id="language"
                name="language"
                required
                defaultValue={languages[0] ?? ''}
                className={cn(
                  'flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                )}
              >
                {languages.map((language) => (
                  <option key={language} value={language}>
                    {language}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Currency" name="currency" error={errors.currency} hint="ISO 4217, e.g. EUR">
              <Input
                id="currency"
                name="currency"
                placeholder="EUR"
                maxLength={3}
                className="uppercase"
                required
              />
            </Field>
            <Field
              label="Unit price"
              name="unitPrice"
              error={errors.unitPrice}
              hint="Major units — 49.50"
            >
              <Input id="unitPrice" name="unitPrice" inputMode="decimal" placeholder="49.50" required />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-transparent" aria-hidden="true">
                Save
              </span>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save price'}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
