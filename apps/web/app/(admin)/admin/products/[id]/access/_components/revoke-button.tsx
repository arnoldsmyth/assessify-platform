'use client';

import type { FormEvent } from 'react';

import { Button } from '@assessify/ui';

/**
 * Row action for an access grant. Thin: the confirm dialog is the only
 * client behaviour; the bound server action calls the service.
 */
export function RevokeButton({
  clientName,
  action,
}: {
  clientName: string;
  action: () => Promise<void>;
}) {
  function confirmOrCancel(event: FormEvent<HTMLFormElement>) {
    if (
      !window.confirm(
        `Revoke ${clientName}'s access to this product?\n\nThey will no longer be able to place new orders for it; existing orders are unaffected.`
      )
    ) {
      event.preventDefault();
    }
  }

  return (
    <form action={action} onSubmit={confirmOrCancel}>
      <Button type="submit" size="sm" variant="outline">
        Revoke
      </Button>
    </form>
  );
}
