import {
  auditEntityRefSchema,
  auditEventInputSchema,
  err,
  ok,
  type AuditActor,
  type AuditDetail,
  type AuditEntityRef,
  type AuditEvent,
  type DomainError,
  type Result,
} from '@assessify/domain';
import type {
  AuditLogPage,
  AuditLogQuery,
  AuditLogRepository,
} from '@assessify/repositories';

/**
 * # Auditing convention (spec 03, "Cross-cutting conventions")
 *
 * Every **state-changing service method** MUST call
 * `auditService.record(actor, action, entityRef, detail)` after the change
 * succeeds — order transitions, report releases, entitlement changes, domain
 * or API-key management, invitation resends, and so on.
 *
 * - **Controllers never write audit entries.** Server actions, API routes and
 *   workers only authenticate the caller and build the actor; the service that
 *   performs the change records it.
 * - `actor` mirrors the caller identity from spec 05
 *   (`{ kind: 'user' | 'api_key' | 'respondent' | 'system', id }`;
 *   `id` is null only for `system`).
 * - `action` is a namespaced snake_case string: `<entity>.<verb>`, e.g.
 *   `order.status_changed`, `report.downloaded`, `invitation.resent`.
 * - `detail` is structured JSON context (old/new status, reason, …) — never
 *   PII beyond ids, and never secrets.
 * - The `audit_log` table is append-only (DB trigger); a failed audit write is
 *   reported as an error `Result`, never thrown.
 */
export interface AuditService {
  /** Record one audit event. Call from services only, after the state change. */
  record(
    actor: AuditActor,
    action: string,
    entityRef: AuditEntityRef,
    detail?: AuditDetail
  ): Promise<Result<AuditEvent, DomainError>>;
  /** Audit trail for one entity, newest first — for the admin UI. */
  listByEntity(
    entityRef: AuditEntityRef,
    query?: AuditLogQuery
  ): Promise<Result<AuditLogPage, DomainError>>;
}

export interface AuditServiceDeps {
  auditLogRepository: AuditLogRepository;
}

/** Factory-injected dependencies (composition-root DI convention). */
export function createAuditService(deps: AuditServiceDeps): AuditService {
  const { auditLogRepository } = deps;

  return {
    async record(actor, action, entityRef, detail) {
      const parsed = auditEventInputSchema.safeParse({ actor, action, entityRef, detail });
      if (!parsed.success) {
        return err({
          code: 'audit_event_invalid',
          message: 'audit event input is invalid',
          detail: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
        });
      }
      try {
        return ok(await auditLogRepository.insert(parsed.data));
      } catch (cause) {
        return err({
          code: 'audit_write_failed',
          message: 'failed to write audit event',
          detail: { cause: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    },

    async listByEntity(entityRef, query) {
      const parsed = auditEntityRefSchema.safeParse(entityRef);
      if (!parsed.success) {
        return err({
          code: 'audit_entity_ref_invalid',
          message: 'audit entity reference is invalid',
          detail: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
        });
      }
      try {
        return ok(await auditLogRepository.listByEntity(parsed.data, query));
      } catch (cause) {
        return err({
          code: 'audit_read_failed',
          message: 'failed to read audit events',
          detail: { cause: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    },
  };
}
