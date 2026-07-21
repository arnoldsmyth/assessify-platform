import type { Organization } from '@assessify/domain';

export function OrganizationStatusBadge({ status }: { status: Organization['status'] }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-full bg-teal-tint px-2.5 py-0.5 text-xs font-medium text-teal">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-muted">
      Archived
    </span>
  );
}
