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
} from '@assessify/ui';
import type { ReactNode } from 'react';

import {
  initialOrganizationFormState,
  type OrganizationFormState,
  type OrganizationFormValues,
} from '../_lib/form';

interface OrganizationFormProps {
  action: (state: OrganizationFormState, formData: FormData) => Promise<OrganizationFormState>;
  defaults?: OrganizationFormValues;
  submitLabel: string;
}

export function OrganizationForm({ action, defaults, submitLabel }: OrganizationFormProps) {
  const [state, formAction, pending] = useActionState(action, initialOrganizationFormState);
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
          <CardTitle className="text-base">Organization</CardTitle>
          <CardDescription>
            The product owner company. Products, prices and clients hang off this organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              defaultValue={defaults?.name ?? ''}
              placeholder="PRO-D Publishing"
              required
            />
          </Field>
          <Field
            label="Slug"
            name="slug"
            error={errors.slug}
            hint="Stable lowercase handle — letters, digits and hyphens."
          >
            <Input
              id="slug"
              name="slug"
              defaultValue={defaults?.slug ?? ''}
              placeholder="pro-d-publishing"
              className="font-mono"
              required
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settlement</CardTitle>
          <CardDescription>
            Royalty settlement identity. Rates stay per product; the Stripe Connect account is
            linked by the onboarding flow, not here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Settlement email"
            name="settlementEmail"
            error={errors.settlementEmail}
            hint="Leave blank to clear."
          >
            <Input
              id="settlementEmail"
              name="settlementEmail"
              type="email"
              defaultValue={defaults?.settlementEmail ?? ''}
              placeholder="billing@example.com"
            />
          </Field>
          <Field
            label="Settlement currency"
            name="settlementCurrency"
            error={errors.settlementCurrency}
            hint="ISO 4217 code, e.g. EUR."
          >
            <Input
              id="settlementCurrency"
              name="settlementCurrency"
              defaultValue={defaults?.settlementCurrency ?? 'EUR'}
              placeholder="EUR"
              maxLength={3}
              className="uppercase"
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
