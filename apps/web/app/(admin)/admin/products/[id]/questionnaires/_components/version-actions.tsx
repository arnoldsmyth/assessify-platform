'use client';

import type { FormEvent } from 'react';

import { Button } from '@assessify/ui';

/**
 * Row actions for a questionnaire version. Thin: the confirm dialog is the
 * only client behaviour; the bound server actions call the service.
 */

interface VersionActionsProps {
  status: 'draft' | 'active' | 'retired';
  version: number;
  variant: string;
  activateAction: () => Promise<void>;
  retireAction: () => Promise<void>;
}

function confirmOrCancel(event: FormEvent<HTMLFormElement>, message: string) {
  if (!window.confirm(message)) event.preventDefault();
}

export function VersionActions({
  status,
  version,
  variant,
  activateAction,
  retireAction,
}: VersionActionsProps) {
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
              `Activate version ${version} (${variant})?\n\nThe currently active ${variant} version, if any, will be retired. Active versions are immutable; new orders will pin this version.`
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
              ? `Retire version ${version} (${variant})?\n\nThe product will have no active ${variant} questionnaire until another version is activated. In-flight sessions keep their pinned version.`
              : `Retire draft version ${version} (${variant})? It can no longer be activated.`
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
