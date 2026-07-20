import type { ReactNode } from 'react';

import { TenantBrandingStyle } from '@/lib/tenant/tenant-branding';

/**
 * Public surface layout (product pages, retail checkout, code redemption —
 * spec 03). Same per-request branding injection as the respondent surface:
 * on a product host the resolved branding overrides the Ember CSS variables;
 * on the platform apex (marketing) nothing is injected.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <TenantBrandingStyle />
      {children}
    </div>
  );
}
