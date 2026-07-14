import { ok, type Result } from '@assessify/domain';

export interface HealthStatus {
  status: 'ok';
  timestamp: string;
}

/** Placeholder service proving the app → service wiring end to end. */
export function getHealth(): Result<HealthStatus> {
  return ok({ status: 'ok', timestamp: new Date().toISOString() });
}
