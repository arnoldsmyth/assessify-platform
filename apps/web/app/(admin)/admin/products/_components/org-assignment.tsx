'use client';

import { useState, type FormEvent } from 'react';

import { Button, cn } from '@assessify/ui';

/**
 * Super_admin control to move a product to another organization. Separate
 * from the ordinary edit form on purpose — reassignment is an explicit
 * service operation (assignProductToOrg) with its own audit trail.
 */
export function OrgAssignment({
  productName,
  currentOrgId,
  organizations,
  action,
}: {
  productName: string;
  currentOrgId: string;
  organizations: { id: string; name: string }[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState('');
  const options = organizations.filter((organization) => organization.id !== currentOrgId);

  if (options.length === 0) {
    return <p className="text-sm text-muted">There is no other organization to move it to.</p>;
  }

  function confirmOrCancel(event: FormEvent<HTMLFormElement>) {
    const target = options.find((organization) => organization.id === targetId);
    if (
      !window.confirm(
        `Move ${productName} to ${target?.name ?? 'the selected organization'}?\n\nIts price list moves with it; access grants for the previous organization's clients will no longer match and should be reviewed.`
      )
    ) {
      event.preventDefault();
    }
  }

  return (
    <form action={action} onSubmit={confirmOrCancel} className="flex flex-wrap items-center gap-2">
      <label htmlFor="reassign-organization" className="text-sm font-medium text-ink">
        Move to
      </label>
      <select
        id="reassign-organization"
        name="organizationId"
        required
        value={targetId}
        onChange={(event) => setTargetId(event.target.value)}
        className={cn(
          'flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
        )}
      >
        <option value="" disabled>
          Choose an organization…
        </option>
        {options.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" size="sm" disabled={targetId === ''}>
        Move product
      </Button>
    </form>
  );
}
