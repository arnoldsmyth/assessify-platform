import type { Actor } from '@assessify/services';

/**
 * TODO(A3): gate on CallerContext — replace this stub with the session-derived
 * caller once auth (Better Auth) lands; the coordinator wires this at merge.
 * Until then the admin surface proceeds unauthenticated with a super_admin
 * stub so the service-layer authorization seam is exercised.
 */
export const devActor: Actor = { userId: 'dev-unauthenticated', role: 'super_admin' };
