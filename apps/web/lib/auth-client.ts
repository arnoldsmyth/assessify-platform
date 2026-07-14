import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Browser-side Better Auth client (login page). Same-origin base URL. */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});
