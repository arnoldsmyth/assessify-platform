import { createConsoleMailer } from '@assessify/adapters/mailer/console';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';
import { Pool } from 'pg';

import { getServerEnv } from './env';

/**
 * Session policy (spec 05): 1-hour idle timeout, 30-day refresh max.
 * Activity slides the 1-hour expiry forward (refreshed at most every
 * 5 minutes); the 30-day absolute cap is enforced in getCallerContext,
 * since Better Auth's expiry is purely sliding.
 */
export const SESSION_IDLE_SECONDS = 60 * 60;
export const SESSION_IDLE_REFRESH_SECONDS = 60 * 5;
export const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function createAuth() {
  const env = getServerEnv();
  // Composition root: swap for the SendGrid Mailer provider when it lands (13).
  const mailer = createConsoleMailer();

  return betterAuth({
    // Better Auth owns these rows at runtime; the DDL is a drizzle migration
    // in packages/db (0002_better_auth) so all schema lives in one place.
    database: new Pool({ connectionString: env.DATABASE_URL }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Staff/client users only (spec 03/05) — respondents use token + PIN, not accounts.
    emailAndPassword: { enabled: true },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await mailer.send({
            to: email,
            subject: 'Sign in to Assessify',
            html: `<p><a href="${url}">Sign in to Assessify</a></p><p>This link expires shortly and can be used once.</p>`,
            text: `Sign in to Assessify: ${url}`,
          });
        },
      }),
      nextCookies(),
    ],
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_IDLE_REFRESH_SECONDS,
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

/** Lazy singleton so importing this module never requires env/DB (e.g. at build time). */
export function getAuth(): ReturnType<typeof createAuth> {
  if (!instance) {
    instance = createAuth();
  }
  return instance;
}
