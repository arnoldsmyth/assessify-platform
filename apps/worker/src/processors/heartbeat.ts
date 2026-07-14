/**
 * `maintenance.heartbeat` processor — intentionally a no-op. It exists so the
 * repeatable-job registry (../repeatable-jobs.ts) demonstrates the scheduler
 * pattern end to end and so a silent queue is distinguishable from a dead
 * worker in the logs.
 */
import type { JobPayload } from '@assessify/domain';

export function createHeartbeatProcessor() {
  return async (_payload: JobPayload<'maintenance.heartbeat'>): Promise<void> => {
    console.log('[worker] heartbeat');
  };
}
