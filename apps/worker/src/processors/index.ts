/**
 * Processor registry: every job name in `@assessify/domain`'s
 * `jobPayloadSchemas` MUST have a handler here — the mapped type makes a
 * missing (or extra) processor a compile error, so a job can never be
 * enqueueable but unprocessable.
 *
 * Adding a job type = add its schema to packages/domain/src/jobs.ts, add a
 * thin processor module here, wire it into `createProcessorRegistry`.
 */
import type { JobName, JobPayload } from '@assessify/domain';
import { createHealthPingProcessor, type HealthPingDeps } from './health-ping';
import { createHeartbeatProcessor } from './heartbeat';
import { createInvitationsDispatchProcessor, type InvitationsDeps } from './invitations';
import { createNotificationSendProcessor, type NotificationsDeps } from './notifications';
import { createRemindersSweepProcessor, type RemindersDeps } from './reminders';
import { createScoringDispatchProcessor, type ScoringDeps } from './scoring';

export type ProcessorRegistry = {
  [N in JobName]: (payload: JobPayload<N>) => Promise<void>;
};

export interface ProcessorDeps {
  health: HealthPingDeps;
  notifications: NotificationsDeps;
  scoring: ScoringDeps;
  invitations: InvitationsDeps;
  reminders: RemindersDeps;
}

export function createProcessorRegistry(deps: ProcessorDeps): ProcessorRegistry {
  return {
    'health.ping': createHealthPingProcessor(deps.health),
    'maintenance.heartbeat': createHeartbeatProcessor(),
    'notifications.send': createNotificationSendProcessor(deps.notifications),
    'scoring.dispatch': createScoringDispatchProcessor(deps.scoring),
    'invitations.dispatch': createInvitationsDispatchProcessor(deps.invitations),
    'reminders.sweep': createRemindersSweepProcessor(deps.reminders),
  };
}
