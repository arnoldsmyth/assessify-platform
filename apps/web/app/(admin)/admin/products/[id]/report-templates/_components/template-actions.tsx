'use client';

import type { FormEvent } from 'react';

import { Button } from '@assessify/ui';

/**
 * Row actions for a report template version. Thin: the confirm dialog is the
 * only client behaviour; the bound server actions call the service.
 */

interface TemplateActionsProps {
  status: 'draft' | 'active' | 'retired';
  version: number;
  activateAction: () => Promise<void>;
  retireAction: () => Promise<void>;
}

function confirmOrCancel(event: FormEvent<HTMLFormElement>, message: string) {
  if (!window.confirm(message)) event.preventDefault();
}

export function TemplateActions({
  status,
  version,
  activateAction,
  retireAction,
}: TemplateActionsProps) {
  if (status === 'retired') {
    return <span className="text-xs text-muted">—</span>;
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {status === 'draft' ? (
        <form
          action={activateAction}
          onSubmit={(event) =>
            confirmOrCancel(
              event,
              `Activate template version ${version}?\n\nThe currently active template, if any, will be retired. Active versions are immutable; new reports assemble against this version.`
            )
          }
        >
          <Button type="submit" size="sm">
            Activate
          </Button>
        </form>
      ) : null}
      <form
        action={retireAction}
        onSubmit={(event) =>
          confirmOrCancel(
            event,
            status === 'active'
              ? `Retire template version ${version}?\n\nThe product will have no active report template until another version is activated — report assembly will fail for new sessions until then. Orders pinned to this version keep it.`
              : `Retire draft template version ${version}? It can no longer be activated.`
          )
        }
      >
        <Button type="submit" size="sm" variant="outline">
          Retire
        </Button>
      </form>
    </div>
  );
}
