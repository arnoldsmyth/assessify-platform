import { notFound } from 'next/navigation';

import { adminNavItems } from '../../_components/nav-items';

/**
 * Temporary placeholder for admin sections that have nav entries but no
 * implementation yet. Delete this route as real section pages land (a static
 * `/admin/<section>/page.tsx` always wins over this dynamic segment).
 */
export default async function AdminSectionPlaceholderPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const item = adminNavItems.find((navItem) => navItem.href === `/admin/${section}`);
  if (!item) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold text-ink">{item.label}</h1>
      <p className="text-muted">This section is not built yet.</p>
    </div>
  );
}
