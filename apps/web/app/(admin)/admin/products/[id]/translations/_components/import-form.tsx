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

import {
  initialImportFormState,
  type TranslationImportFormState,
} from '../_lib/form';

interface ImportFormProps {
  action: (
    state: TranslationImportFormState,
    formData: FormData
  ) => Promise<TranslationImportFormState>;
}

export function ImportForm({ action }: ImportFormProps) {
  const [state, formAction, pending] = useActionState(action, initialImportFormState);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import translations</CardTitle>
        <CardDescription>
          Upload or paste a JSON file of the shape{' '}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">
            {'{"language": "fr", "strings": {"q1.text": "…"}}'}
          </code>
          . Existing keys for that language are overwritten; other keys are left untouched.
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

          <div className="flex flex-col gap-1.5">
            <label htmlFor="file" className="text-sm font-medium text-ink">
              Translations file
            </label>
            <input
              id="file"
              name="file"
              type="file"
              accept=".json,application/json"
              className={cn(
                'flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-body shadow-sm',
                'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
            />
            <p className="text-xs text-muted">A .json file — takes precedence over the paste box.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="payload" className="text-sm font-medium text-ink">
              Or paste JSON
            </label>
            <textarea
              id="payload"
              name="payload"
              rows={10}
              spellCheck={false}
              placeholder={'{\n  "language": "fr",\n  "strings": {\n    "q1.text": "Question un"\n  }\n}'}
              className={cn(
                'w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-body shadow-sm transition-colors duration-150 ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1'
              )}
            />
          </div>

          <div>
            <Button type="submit" disabled={pending}>
              <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
              {pending ? 'Importing…' : 'Validate & import'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
