import { z } from 'zod';

/**
 * Server-side env validation (03 — Env/secrets: validated with a Zod schema,
 * missing config fails fast). Accessed lazily so `next build` does not need
 * secrets; the first request without valid env throws loudly.
 *
 * All variables are documented in the repo-root `.env.example`.
 */
/** Comma-separated hostname list → normalised (trimmed, lowercased) array. */
const hostListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0)
  )
  .pipe(z.array(z.string().min(1)).min(1, 'At least one hostname is required'));

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
  /**
   * Stripe secret API key (`sk_…`) for the card payment adapter. Optional:
   * card payments are unavailable (payment/provider_unavailable) until set.
   */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  /**
   * Stripe webhook signing secret (`whsec_…`). Optional: /api/webhooks/stripe
   * answers 503 until it is configured — never verify-less.
   */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Platform sender identity for auth/system mail (spec 13; per-product senders come from product branding). */
  MAIL_FROM_NAME: z.string().min(1).default('Assessify'),
  MAIL_FROM_ADDRESS: z.string().email().default('no-reply@assessify.local'),
  /**
   * Queue connection (BullMQ on DO Valkey) for enqueueing background jobs
   * from server actions (D5 invitation dispatch/resend). Optional: actions
   * that need the queue return a typed error until one is configured.
   */
  VALKEY_URL: z.string().regex(/^rediss?:\/\//).optional(),
  /** Redis-compatible fallback name (local docker, CI). */
  REDIS_URL: z.string().regex(/^rediss?:\/\//).optional(),
  /**
   * Internal pdf-service base URL (spec 09, e.g.
   * `http://pdf-service.internal:8080`). Optional: report PDF downloads
   * return `report/pdf_renderer_unavailable` until both are configured.
   */
  PDF_SERVICE_URL: z.string().url().optional(),
  /**
   * Shared secret for BOTH directions of the pdf-service contract (E4): sent
   * as `x-pdf-service-secret` when calling /render, and required on inbound
   * `/report-print/{id}` fetches (option A). The print route answers 503
   * until it is configured — never secret-less.
   */
  PDF_SERVICE_SHARED_SECRET: z.string().min(16).optional(),
  /**
   * Comma-separated super-admin addresses for `error_alert` mail (spec 06
   * error states). Optional: unset skips alert emails (audit still records).
   */
  ERROR_ALERT_EMAILS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((address) => address.trim())
        .filter((address) => address.length > 0)
    )
    .pipe(z.array(z.string().email()))
    .optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Tenant resolution (spec 11 / F1). Hostnames serving the Assessify admin
   * surface; localhost variants keep every surface reachable in dev.
   */
  ADMIN_HOSTNAMES: hostListSchema.default('app.assessify.ie,localhost,127.0.0.1'),
  /** Platform marketing/public apex hostnames. */
  PLATFORM_HOSTNAMES: hostListSchema.default('assessify.ie,www.assessify.ie'),
  /**
   * Base domains that serve `{product-slug}.` subdomains. `localhost` is
   * included so `pro-d.localhost:3000` exercises the white-label path in dev
   * (browsers resolve *.localhost to loopback without /etc/hosts edits).
   */
  PRODUCT_SLUG_BASE_DOMAINS: hostListSchema.default('assessify.ie,localhost'),
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
