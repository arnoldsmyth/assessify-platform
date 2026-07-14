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
  })
  .refine((env) => env.VALKEY_URL !== undefined || env.REDIS_URL !== undefined, {
    message:
      'set VALKEY_URL (preferred) or REDIS_URL to the queue connection string, e.g. redis://localhost:6379',
  });

export interface WorkerEnv {
  connectionUrl: string;
  concurrency: number;
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
  return { connectionUrl, concurrency: parsed.data.WORKER_CONCURRENCY };
}
