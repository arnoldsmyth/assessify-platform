'use client';

import { useActionState, useState, type ComponentProps, type ReactNode } from 'react';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, cn } from '@assessify/ui';

import { initialProductFormState, type ProductFormState, type ProductFormValues } from '../_lib/form';
import { BrandingEditor } from './branding-editor';

interface ProductFormProps {
  action: (state: ProductFormState, formData: FormData) => Promise<ProductFormState>;
  defaults?: ProductFormValues;
  submitLabel: string;
  /**
   * When set, renders the owning-organization picker (create form only —
   * reassignment is a separate super_admin control on the product page).
   */
  organizations?: { id: string; name: string }[];
}

export function ProductForm({ action, defaults, submitLabel, organizations }: ProductFormProps) {
  const [state, formAction, pending] = useActionState(action, initialProductFormState);
  const [name, setName] = useState(defaults?.name ?? '');
  const [scoringMode, setScoringMode] = useState(defaults?.scoringConfig.mode ?? 'sync_internal');
  const [retailEnabled, setRetailEnabled] = useState(defaults?.retailEnabled ?? false);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex max-w-5xl flex-col gap-6">
      {state.status === 'error' && state.message ? (
        <div
          role="alert"
          className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
        >
          {state.message}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
          <CardDescription>Identity and defaults for this assessment product.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {organizations ? (
            <Field
              label="Organization"
              name="organizationId"
              error={errors.organizationId}
              hint="The product owner company. Reassignable later from the product page."
            >
              <Select id="organizationId" name="organizationId" defaultValue="" required>
                <option value="" disabled>
                  Choose an organization…
                </option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Name" name="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="PRO-D"
              required
            />
          </Field>
          <Field
            label="Slug"
            name="slug"
            error={errors.slug}
            hint="Serves the questionnaire at {slug}.assessify.ie — lowercase letters, digits and hyphens."
          >
            <Input
              id="slug"
              name="slug"
              defaultValue={defaults?.slug ?? ''}
              placeholder="pro-d"
              className="font-mono"
              required
            />
          </Field>
          <Field label="Timezone" name="timezone" error={errors.timezone}>
            <Input
              id="timezone"
              name="timezone"
              defaultValue={defaults?.timezone ?? 'Europe/Dublin'}
              placeholder="Europe/Dublin"
            />
          </Field>
          <Field
            label="Report page size"
            name="reportPageSizeDefault"
            error={errors.reportPageSizeDefault}
          >
            <Select
              id="reportPageSizeDefault"
              name="reportPageSizeDefault"
              defaultValue={defaults?.reportPageSizeDefault ?? 'a4'}
            >
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm font-medium text-ink sm:col-span-2">
            <input
              type="checkbox"
              name="defaultAccess"
              defaultChecked={defaults?.defaultAccess ?? true}
              className="size-4 accent-[var(--color-primary)]"
            />
            <span>
              Default access
              <span className="ml-2 font-normal text-muted">
                Available to all the organization&rsquo;s clients. Untick to restrict it to
                per-client grants (managed on the client access page).
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Languages</CardTitle>
          <CardDescription>
            BCP 47 tags (e.g. en, fr, pt-BR). Available languages must include the default.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Default language" name="defaultLanguage" error={errors.defaultLanguage}>
            <Input
              id="defaultLanguage"
              name="defaultLanguage"
              defaultValue={defaults?.defaultLanguage ?? 'en'}
              placeholder="en"
            />
          </Field>
          <Field
            label="Available languages"
            name="availableLanguages"
            error={errors.availableLanguages}
            hint="Comma-separated, e.g. en, fr, pt-BR"
          >
            <Input
              id="availableLanguages"
              name="availableLanguages"
              defaultValue={(defaults?.availableLanguages ?? ['en']).join(', ')}
              placeholder="en"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scoring</CardTitle>
          <CardDescription>
            How completed questionnaires are scored. Async external engines call back with results.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Mode" name="scoringConfig.mode" error={errors['scoringConfig.mode']}>
            <Select
              id="scoringConfig.mode"
              name="scoringConfig.mode"
              value={scoringMode}
              onChange={(event) =>
                setScoringMode(event.target.value as 'sync_internal' | 'async_external')
              }
            >
              <option value="sync_internal">Internal (sync)</option>
              <option value="async_external">External engine (async)</option>
            </Select>
          </Field>
          <Field
            label="Engine key"
            name="scoringConfig.engineKey"
            error={errors['scoringConfig.engineKey']}
          >
            <Input
              id="scoringConfig.engineKey"
              name="scoringConfig.engineKey"
              defaultValue={defaults?.scoringConfig.engineKey ?? ''}
              placeholder="pro-d-v1"
            />
          </Field>
          <Field
            label="Endpoint"
            name="scoringConfig.endpoint"
            error={errors['scoringConfig.endpoint']}
            hint={scoringMode === 'async_external' ? 'Required for external engines.' : undefined}
          >
            <Input
              id="scoringConfig.endpoint"
              name="scoringConfig.endpoint"
              defaultValue={defaults?.scoringConfig.endpoint ?? ''}
              placeholder="https://engine.example.com/score"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retail</CardTitle>
          <CardDescription>
            Enable direct-to-consumer purchase of this assessment (public product page + Stripe).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid items-end gap-4 sm:grid-cols-3">
          <label className="flex h-9 items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              name="retailEnabled"
              checked={retailEnabled}
              onChange={(event) => setRetailEnabled(event.target.checked)}
              className="size-4 accent-[var(--color-primary)]"
            />
            Retail enabled
          </label>
          <Field
            label="Price (minor units)"
            name="retailPrice"
            error={errors.retailPrice}
            hint="Integer minor units — 4950 = €49.50"
          >
            <Input
              id="retailPrice"
              name="retailPrice"
              inputMode="numeric"
              defaultValue={defaults?.retailPrice ?? ''}
              placeholder="4950"
              disabled={!retailEnabled}
            />
          </Field>
          <Field label="Currency" name="retailCurrency" error={errors.retailCurrency}>
            <Input
              id="retailCurrency"
              name="retailCurrency"
              defaultValue={defaults?.retailCurrency ?? ''}
              placeholder="EUR"
              maxLength={3}
              className="uppercase"
              disabled={!retailEnabled}
            />
          </Field>
        </CardContent>
      </Card>

      <BrandingEditor
        defaultValue={defaults?.branding ?? {}}
        productName={name}
        errors={errors}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
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

/** Native select styled to match the Input primitive. */
function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
