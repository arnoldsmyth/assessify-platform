'use client';

import { useActionState, useRef } from 'react';
import { Upload } from 'lucide-react';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from '@assessify/ui';

import { initialUploadFormState, type TemplateUploadFormState } from '../_lib/form';

interface UploadFormProps {
  action: (
    state: TemplateUploadFormState,
    formData: FormData
  ) => Promise<TemplateUploadFormState>;
}

export function UploadForm({ action }: UploadFormProps) {
  const [state, formAction, pending] = useActionState(action, initialUploadFormState);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload a template</CardTitle>
        <CardDescription>
          Upload or paste a pixel-perfect HTML report template (spec 09). Placeholders like{' '}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">
            {'{{respondent.fullName}}'}
          </code>{' '}
          and{' '}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">
            {'{{scores.dimensions.drive}}'}
          </code>{' '}
          are merged at assembly. It is stored as a new draft version — activation is a separate
          step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction} className="flex flex-col gap-4">
          {state.status === 'error' && state.message ? (
            <div
              role="alert"
              className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm font-medium text-red"
            >
              {state.message}
            </div>
          ) : null}
          {state.status === 'success' && state.message ? (
            <div
              role="status"
              className="rounded-md border border-teal/30 bg-teal-tint px-4 py-3 text-sm font-medium text-teal"
            >
              {state.message}
            </div>
          ) : null}

          {state.issues && state.issues.length > 0 ? (
            <div className="rounded-md border border-red/30 bg-red-tint px-4 py-3">
              <p className="text-sm font-medium text-red">
                {state.issues.length} validation issue{state.issues.length === 1 ? '' : 's'}
              </p>
              <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                {state.issues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="text-xs text-red">
                    <code className="rounded bg-surface px-1 py-0.5 font-mono">{issue.path}</code>{' '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Availability</span>
              <label className="inline-flex items-center gap-2 text-sm text-body">
                <input
                  type="checkbox"
                  name="capabilityWeb"
                  defaultChecked
                  className="h-4 w-4 rounded border-border accent-[var(--color-primary,#C2410C)]"
                />
                Web report
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-body">
                <input
                  type="checkbox"
                  name="capabilityPdf"
                  className="h-4 w-4 rounded border-border accent-[var(--color-primary,#C2410C)]"
                />
                PDF download
              </label>
              <p className="text-xs text-muted">
                Web-only products leave PDF unchecked — the download affordance is hidden and
                pdf-service is never called.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="file" className="text-sm font-medium text-ink">
                Template file
              </label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".html,.htm,text/html"
                className={cn(
                  'flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-body shadow-sm',
                  'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-primary',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                )}
              />
              <p className="text-xs text-muted">
                A self-contained .html file (assets inlined) — takes precedence over the paste box.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="html" className="text-sm font-medium text-ink">
              Or paste HTML
            </label>
            <textarea
              id="html"
              name="html"
              rows={10}
              spellCheck={false}
              placeholder={'<!doctype html>\n<html>\n  <body>\n    <h1>{{t.report_title}}</h1>\n    ...\n  </body>\n</html>'}
              className={cn(
                'w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-body shadow-sm transition-colors duration-150 ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1'
              )}
            />
          </div>

          <div>
            <Button type="submit" disabled={pending}>
              <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
              {pending ? 'Uploading…' : 'Upload as draft'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
