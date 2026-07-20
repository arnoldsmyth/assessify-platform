import type { ReactNode } from 'react';

import { TenantBrandingStyle } from '@/lib/tenant/tenant-branding';

/**
 * Respondent surface layout (spec 11 "Branding application", spec 15): loads
 * the product branding the middleware resolved for this request and injects
 * it as CSS variables, so every nested page (token entry, questionnaire,
 * report viewer) inherits the white-label theme with no per-page work. On
 * hosts without a product context (localhost/admin in dev) nothing is
 * injected and the Ember defaults apply. Base font 16 respondent-facing
 * (spec 15); no admin chrome ever renders here (spec 03).
 */
export default function RespondentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen text-base">
      <TenantBrandingStyle />
      {children}
    </div>
  );
}
