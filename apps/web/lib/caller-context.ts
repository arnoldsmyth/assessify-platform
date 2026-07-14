import type { CallerContext } from '@assessify/domain';
import {
  createCallerContextServiceFromDatabaseUrl,
  type CallerContextService,
} from '@assessify/services';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth, SESSION_ABSOLUTE_MAX_MS } from './auth';
import { getServerEnv } from './env';

/**
 * Controller-layer auth helper (appendix-architecture-layers.md §3a):
 * reads the Better Auth session and asks the service layer for the caller's
 * CallerContext. Services never see cookies/sessions — only the context.
 */

let service: CallerContextService | undefined;

function getCallerContextService(): CallerContextService {
  if (!service) {
    service = createCallerContextServiceFromDatabaseUrl(getServerEnv().DATABASE_URL);
  }
  return service;
}

/** CallerContext for the current request, or null when not signed in. */
export async function getCallerContext(): Promise<CallerContext | null> {
  // headers() first: marks the route dynamic before any env/DB access runs.
  const requestHeaders = await headers();
  const auth = getAuth();
  const sessionData = await auth.api.getSession({ headers: requestHeaders });
  if (!sessionData) {
    return null;
  }

  // 30-day refresh max (spec 05): Better Auth's expiry is sliding-only, so
  // enforce the absolute cap here and revoke sessions past it.
  const createdAt = new Date(sessionData.session.createdAt).getTime();
  if (Date.now() - createdAt > SESSION_ABSOLUTE_MAX_MS) {
    await auth.api.revokeSession({
      headers: requestHeaders,
      body: { token: sessionData.session.token },
    });
    return null;
  }

  const result = await getCallerContextService().forUser(sessionData.user.id);
  return result.ok ? result.value : null;
}

/**
 * For server actions / route handlers / layouts behind auth: returns the
 * CallerContext or redirects to the login page. Per-feature permission
 * checks stay in the service layer (spec 05).
 */
export async function requireCallerContext(): Promise<CallerContext> {
  const context = await getCallerContext();
  if (!context) {
    redirect('/login');
  }
  return context;
}
