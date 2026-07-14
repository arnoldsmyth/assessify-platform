'use client';

import { useState, type CSSProperties } from 'react';

import type { BrandingConfig } from '@assessify/domain';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@assessify/ui';

/**
 * Branding config editor (spec 11 "Branding application") with a live
 * preview. The preview overrides the Ember token CSS variables inline on its
 * container, exactly like F1's per-request injection will on respondent
 * surfaces, so every Tailwind utility inside re-themes without custom CSS.
 *
 * Logo/favicon are URL fields only — file upload is deferred pending the
 * object storage decision (Firebase Storage dropped; likely DO Spaces).
 */

type ColourKey = 'primary' | 'primaryDark' | 'accent' | 'surfaceTint' | 'ink';

interface ColourFieldDef {
  key: ColourKey;
  label: string;
  hint: string;
  /** Provisional Ember variable mapping — mirrored by F1's injection. */
  cssVar: string;
  fallback: string;
}

const COLOUR_FIELDS: ColourFieldDef[] = [
  {
    key: 'primary',
    label: 'Primary',
    hint: 'Buttons, links, active states',
    cssVar: '--color-primary',
    fallback: '#c2410c',
  },
  {
    key: 'primaryDark',
    label: 'Primary dark',
    hint: 'Text on tinted backgrounds',
    cssVar: '--color-primary-tint-ink',
    fallback: '#9a3412',
  },
  {
    key: 'accent',
    label: 'Accent',
    hint: 'Progress bars, highlights',
    cssVar: '--color-primary-bright',
    fallback: '#f97316',
  },
  {
    key: 'surfaceTint',
    label: 'Surface tint',
    hint: 'Selected rows, badges, callouts',
    cssVar: '--color-primary-tint',
    fallback: '#fff7ed',
  },
  {
    key: 'ink',
    label: 'Ink',
    hint: 'Headings and dark chrome',
    cssVar: '--color-ink',
    fallback: '#292524',
  },
];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isHexColour(value: string | undefined): value is string {
  return value !== undefined && HEX_RE.test(value);
}

/** <input type="color"> only accepts #rrggbb. */
function toPickerHex(value: string | undefined, fallback: string): string {
  if (!isHexColour(value)) return fallback;
  if (value.length === 7) return value.toLowerCase();
  const [, r, g, b] = value;
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

interface BrandingEditorProps {
  defaultValue: BrandingConfig;
  productName?: string;
  errors: Record<string, string>;
}

export function BrandingEditor({ defaultValue, productName, errors }: BrandingEditorProps) {
  const [colors, setColors] = useState<Partial<Record<ColourKey, string>>>({
    ...defaultValue.colors,
  });
  const [logoUrl, setLogoUrl] = useState(defaultValue.logoUrl ?? '');
  const [fontFamily, setFontFamily] = useState(defaultValue.fontFamily ?? '');

  const previewVars: Record<string, string> = {};
  for (const field of COLOUR_FIELDS) {
    const value = colors[field.key];
    if (isHexColour(value)) previewVars[field.cssVar] = value;
  }
  const previewStyle = previewVars as CSSProperties;

  const showLogo = /^https?:\/\/\S+$/i.test(logoUrl.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Branding</CardTitle>
        <CardDescription>
          Applied to respondent and public surfaces as CSS variables, plus emails and PDF reports.
          Leave blank to use the Assessify default theme. Logo upload is not available yet — paste
          a hosted image URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {COLOUR_FIELDS.map((field) => (
              <ColourField
                key={field.key}
                def={field}
                value={colors[field.key] ?? ''}
                error={errors[`branding.colors.${field.key}`]}
                onChange={(value) =>
                  setColors((current) => ({ ...current, [field.key]: value || undefined }))
                }
              />
            ))}
          </div>

          <TextField
            label="Logo URL"
            name="branding.logoUrl"
            placeholder="https://cdn.example.com/logo.svg"
            value={logoUrl}
            error={errors['branding.logoUrl']}
            onChange={setLogoUrl}
          />
          <TextField
            label="Favicon URL"
            name="branding.faviconUrl"
            placeholder="https://cdn.example.com/favicon.png"
            defaultValue={defaultValue.faviconUrl ?? ''}
            error={errors['branding.faviconUrl']}
          />
          <TextField
            label="Font family"
            name="branding.fontFamily"
            placeholder="'Alte Haas', Georgia, serif"
            hint="CSS font stack used on respondent surfaces and reports."
            value={fontFamily}
            error={errors['branding.fontFamily']}
            onChange={setFontFamily}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Email sender name"
              name="branding.emailFrom.name"
              placeholder="PRO-D reports"
              defaultValue={defaultValue.emailFrom?.name ?? ''}
              error={errors['branding.emailFrom.name']}
            />
            <TextField
              label="Email sender address"
              name="branding.emailFrom.address"
              placeholder="reports@example.com"
              hint="Sender domain must be verified in SendGrid before use."
              defaultValue={defaultValue.emailFrom?.address ?? ''}
              error={errors['branding.emailFrom.address']}
            />
          </div>
        </div>

        {/* Live preview — Ember token variables overridden inline. */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink">Respondent preview</span>
          <div
            style={previewStyle}
            className="overflow-hidden rounded-lg border border-border shadow-sm"
          >
            <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
              {showLogo ? (
                // Plain <img>: arbitrary external hosts, preview-only.
                <img src={logoUrl.trim()} alt="Product logo" className="h-6 w-auto" />
              ) : (
                <div className="size-6 rounded bg-primary" aria-hidden="true" />
              )}
              <span className="text-base font-semibold text-ink">
                {productName?.trim() || 'Your product'}
              </span>
            </div>
            <div
              className="flex flex-col gap-4 bg-surface-page p-4"
              style={fontFamily.trim() ? { fontFamily: fontFamily.trim() } : undefined}
            >
              <div className="flex flex-col gap-1">
                <span className="text-lg font-semibold text-ink">Section 2 of 5</span>
                <p className="text-sm text-body">
                  Read each statement and choose the answer that fits you best.
                </p>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary-tint">
                <div className="h-full w-2/5 rounded-full bg-primary-bright" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" size="sm">
                  Continue
                </Button>
                <span className="inline-flex items-center rounded-full bg-primary-tint px-2.5 py-0.5 text-xs font-medium text-primary-tint-ink">
                  In progress
                </span>
                <span className="text-sm font-medium text-primary underline underline-offset-4">
                  Save and resume later
                </span>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted">
            Colours override the Ember design tokens per request; components never hardcode hex
            values, so this preview matches what respondents will see.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ColourField({
  def,
  value,
  error,
  onChange,
}: {
  def: ColourFieldDef;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const name = `branding.colors.${def.key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-ink">
        {def.label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${def.label} colour picker`}
          value={toPickerHex(value, def.fallback)}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-1"
        />
        <Input
          id={name}
          name={name}
          value={value}
          placeholder={def.fallback}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono"
        />
      </div>
      {error ? (
        <p className="text-xs text-red">{error}</p>
      ) : (
        <p className="text-xs text-muted">{def.hint}</p>
      )}
    </div>
  );
}

function TextField({
  label,
  name,
  placeholder,
  hint,
  error,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  name: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-ink">
        {label}
      </label>
      <Input
        id={name}
        name={name}
        placeholder={placeholder}
        {...(onChange
          ? { value, onChange: (event) => onChange(event.target.value) }
          : { defaultValue })}
      />
      {error ? (
        <p className="text-xs text-red">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
