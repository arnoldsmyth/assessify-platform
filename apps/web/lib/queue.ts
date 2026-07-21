import { BullMqJobQueue } from '@assessify/adapters/queue/bullmq';
import type { JobQueue } from '@assessify/adapters';

import { getServerEnv } from './env';

/**
 * Web-side JobQueue composition (composition root — services never import
 * the BullMQ provider, .dependency-cruiser.cjs). Server actions use this to
 * enqueue background work (D5: `invitations.dispatch`); the worker consumes.
 *
 * Lazy + memoised: one connection per web process, opened on first use, and
 * never during `next build`. Returns null when no queue URL is configured so
 * callers can surface a typed "queue unavailable" error instead of crashing.
 */
let instance: BullMqJobQueue | undefined;

export function getJobQueue(): JobQueue | null {
  const env = getServerEnv();
  const connectionUrl = env.VALKEY_URL ?? env.REDIS_URL;
  if (!connectionUrl) return null;
  if (!instance) {
    instance = new BullMqJobQueue({ connectionUrl });
  }
  return instance;
}
