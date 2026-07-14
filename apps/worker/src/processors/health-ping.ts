/**
 * `health.ping` processor — the demo round trip proving the wiring:
 * JobQueue adapter → Valkey → dispatcher → this processor → health service.
 *
 * Processors stay thin (03-architecture.md): the dispatcher has already
 * parsed the payload against the domain schema; a processor only calls a
 * service and maps its Result. Dependencies are injected so tests never
 * touch BullMQ or a real service graph.
 */
import type { HealthStatus } from '@assessify/services';
import type { JobPayload, Result } from '@assessify/domain';

export interface HealthPingDeps {
  getHealth(): Result<HealthStatus>;
}

export function createHealthPingProcessor(deps: HealthPingDeps) {
  return async (payload: JobPayload<'health.ping'>): Promise<void> => {
    const result = deps.getHealth();
    if (!result.ok) {
      // Throwing hands the job back to BullMQ for retry/backoff — the one
      // place an expected DomainError becomes a throw, at the queue boundary.
      throw new Error(`health service degraded: ${result.error.code}`);
    }
    console.log(
      `[worker] health.ping ok (source=${payload.source}, enqueued=${payload.requestedAt}, service=${result.value.timestamp})`
    );
  };
}
