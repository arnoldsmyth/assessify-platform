'use client';

import type { FormEvent } from 'react';

import { Button } from '@assessify/ui';

/**
 * Row action for a price-list entry. Thin: the confirm dialog is the only
 * client behaviour; the bound server action calls the service.
 */
export function RemovePriceButton({
  language,
  currency,
  action,
}: {
  language: string;
  currency: string;
  action: () => Promise<void>;
}) {
  function confirmOrCancel(event: FormEvent<HTMLFormElement>) {
    if (!window.confirm(`Remove the ${language} / ${currency} price? Existing orders keep their agreed prices.`)) {
      event.preventDefault();
    }
  }

  return (
    <form action={action} onSubmit={confirmOrCancel}>
      <Button type="submit" size="sm" variant="outline">
        Remove
      </Button>
    </form>
  );
}
