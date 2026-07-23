'use client';

import { useActionState } from 'react';

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
import type { ComponentProps, ReactNode } from 'react';

import {
  initialClientFormState,
  type ClientFormState,
  type ClientFormValues,
} from '../_lib/form';

interface ClientFormProps {
  action: (state: ClientFormState, formData: FormData) => Promise<ClientFormState>;
  defaults?: ClientFormValues;
  submitLabel: string;
  /**
   * Organization picker — create form only. A single option renders as a
   * fixed, read-only organization (org admins scoped to one org); more than
   * one renders a select (super_admin, or the rare org admin scoped to
   * several orgs). Absent on the edit form: moving a client between
   * organizations is not part of this CRUD surface.
   */
  organizations?: { id: string; name: string }[];
}

export function ClientForm({ action, defaults, submitLabel, organizations }: ClientFormProps) {
  const [state, formAction, pending] = useActionState(action, initialClientFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-6">
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
          <CardTitle className="text-base">Client</CardTitle>
          <CardDescription>
            The organization&rsquo;s customer — orders are always placed for a client.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {organizations ? (
            organizations.length > 1 ? (
              <Field
                label="Organization"
                name="organizationId"
                error={errors.organizationId}
                hint="The client belongs to exactly one organization."
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
            ) : (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-sm font-medium text-ink">Organization</span>
                <p className="text-sm text-body">{organizations[0]?.name ?? '—'}</p>
                <input type="hidden" name="organizationId" value={organizations[0]?.id ?? ''} />
              </div>
            )
          ) : null}
          <Field label="Name" name="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              defaultValue={defaults?.name ?? ''}
              placeholder="Acme Talent"
              required
            />
          </Field>
          <Field
            label="Billing email"
            name="billingEmail"
            error={errors.billingEmail}
            hint="Leave blank to clear."
          >
            <Input
              id="billingEmail"
              name="billingEmail"
              type="email"
              defaultValue={defaults?.billingEmail ?? ''}
              placeholder="billing@example.com"
            />
          </Field>
          <Field
            label="Default currency"
            name="defaultCurrency"
            error={errors.defaultCurrency}
            hint="ISO 4217 code, e.g. EUR."
          >
            <Input
              id="defaultCurrency"
              name="defaultCurrency"
              defaultValue={defaults?.defaultCurrency ?? 'EUR'}
              placeholder="EUR"
              maxLength={3}
              className="uppercase"
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
        </CardContent>
      </Card>

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

/** Native select styled to match the Input primitive (mirrors products/_components/product-form.tsx). */
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
