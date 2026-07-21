/** `products.default_access` state: org-default vs restricted (per-client grants). */
export function DefaultAccessBadge({ defaultAccess }: { defaultAccess: boolean }) {
  return defaultAccess ? (
    <span className="inline-flex items-center rounded-full bg-teal-tint px-2.5 py-0.5 text-xs font-medium text-teal">
      All clients
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-tint px-2.5 py-0.5 text-xs font-medium text-amber">
      Restricted
    </span>
  );
}
