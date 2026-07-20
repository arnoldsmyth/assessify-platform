import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@assessify/ui';

/**
 * Centered single-card shell for the respondent access pages. White-label
 * note: per-product branding arrives as request-scoped CSS variables when F1
 * (tenant middleware) lands — the Ember token classes used here are the
 * unbranded-graceful fallback, so nothing needs to change per tenant.
 */
export function AccessShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
