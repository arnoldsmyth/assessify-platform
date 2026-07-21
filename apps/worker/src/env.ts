/**
 * Worker environment, validated at boot (docs/spec/03-architecture.md,
 * "Env/secrets": validated with a Zod env schema; missing config fails fast).
 */
import { z } from 'zod';

const queueUrl = z
  .string()
  .regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// connection URL');

const envSchema = z
  .object({
    /** DO managed Valkey connection string (preferred name). */
    VALKEY_URL: queueUrl.optional(),
    /** Redis-compatible fallback name (local docker, CI). */
    REDIS_URL: queueUrl.optional(),
    /** Max jobs processed concurrently by this worker process. */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
    /**
     * Neon Postgres connection string — required for jobs that touch the
     * database (notifications.send). Optional so a queue-only dev worker
     * still boots; DB-dependent processors fail their jobs when unset.
     */
    DATABASE_URL: z.string().url().optional(),
    /**
     * SendGrid API key (spec 13). When unset, the worker falls back to the
     * console mailer (dev only — emails are printed, not sent).
     */
    SENDGRID_API_KEY: z.string().min(1).optional(),
    /**
     * Base domains serving `{product-slug}.` subdomains (spec 11) — same
     * variable the web app validates. Invitation links (D5) are built on the
     * FIRST entry, so keep the public production domain first.
     */
    PRODUCT_SLUG_BASE_DOMAINS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host.length > 0)
      )
      .pipe(z.array(z.string().min(1)).min(1))
      .default('assessify.ie,localhost'),
    /** Platform sender identity (spec 13) — fallback when a product has no branding.emailFrom, and the error_alert sender. */
    MAIL_FROM_NAME: z.string().min(1).default('Assessify'),
    MAIL_FROM_ADDRESS: z.string().email().default('no-reply@assessify.local'),
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
  })
  .refine((env) => env.VALKEY_URL !== undefined || env.REDIS_URL !== undefined, {
    message:
      'set VALKEY_URL (preferred) or REDIS_URL to the queue connection string, e.g. redis://localhost:6379',
  });

export interface WorkerEnv {
  connectionUrl: string;
  concurrency: number;
  databaseUrl?: string;
  sendgridApiKey?: string;
  /** First entry is the primary base domain for invitation links (D5). */
  slugBaseDomains: string[];
  mailFrom: { name: string; address: string };
  errorAlertEmails?: string[];
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`[worker] invalid environment:\n${issues}`);
  }
  const connectionUrl = parsed.data.VALKEY_URL ?? parsed.data.REDIS_URL;
  if (connectionUrl === undefined) {
    // Unreachable (the refine above guarantees one is set) — narrows the type.
    throw new Error('[worker] invalid environment: no queue connection URL');
  }
  return {
    connectionUrl,
    concurrency: parsed.data.WORKER_CONCURRENCY,
    ...(parsed.data.DATABASE_URL !== undefined && { databaseUrl: parsed.data.DATABASE_URL }),
    ...(parsed.data.SENDGRID_API_KEY !== undefined && {
      sendgridApiKey: parsed.data.SENDGRID_API_KEY,
    }),
    slugBaseDomains: parsed.data.PRODUCT_SLUG_BASE_DOMAINS,
    mailFrom: {
      name: parsed.data.MAIL_FROM_NAME,
      address: parsed.data.MAIL_FROM_ADDRESS,
    },
    ...(parsed.data.ERROR_ALERT_EMAILS !== undefined && {
      errorAlertEmails: parsed.data.ERROR_ALERT_EMAILS,
    }),
  };
}
