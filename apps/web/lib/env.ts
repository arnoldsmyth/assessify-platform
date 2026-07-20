import { z } from 'zod';

/**
 * Server-side env validation (03 — Env/secrets: validated with a Zod schema,
 * missing config fails fast). Accessed lazily so `next build` does not need
 * secrets; the first request without valid env throws loudly.
 *
 * All variables are documented in the repo-root `.env.example`.
 */
const serverEnvSchema = z.object({
  /** Neon Postgres connection string (Better Auth + repositories). */
  DATABASE_URL: z.string().url(),
  /** Better Auth signing secret — `openssl rand -base64 32`. */
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Canonical base URL of the web app (admin surface host). */
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  /**
   * SendGrid signed event webhook verification key (PEM or base64 DER, from
   * the SendGrid console). Optional: /api/webhooks/sendgrid answers 503
   * until it is configured — never verify-less.
   */
  SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  /** Platform sender identity for auth/system mail (spec 13; per-product senders come from product branding). */
  MAIL_FROM_NAME: z.string().min(1).default('Assessify'),
  MAIL_FROM_ADDRESS: z.string().email().default('no-reply@assessify.local'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (!cached) {
    const parsed = serverEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid server environment (see .env.example): ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
