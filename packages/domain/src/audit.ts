import { z } from 'zod';

/**
 * Audit domain types (spec 03 "Cross-cutting conventions" + spec 04 `audit_log`).
 *
 * Convention: every state-changing service method calls
 * `auditService.record(actor, action, entityRef, detail)` — controllers never
 * write audit entries directly. The actor mirrors the caller identity from
 * spec 05 (`CallerContext { kind, id }`); the `audit_log` table is append-only.
 */

/** Who performed the action — aligned with `CallerContext.kind` (spec 05). */
export const auditActorKindSchema = z.enum(['user', 'api_key', 'respondent', 'system']);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

export const auditActorSchema = z
  .object({
    kind: auditActorKindSchema,
    /** Better Auth user id, api key id, respondent id… `null` only for `system`. */
    id: z.string().min(1).nullable().default(null),
  })
  .refine((actor) => actor.kind === 'system' || actor.id !== null, {
    message: 'actor.id is required unless actor.kind is "system"',
    path: ['id'],
  });
export type AuditActor = z.infer<typeof auditActorSchema>;

/**
 * Namespaced action string: `<entity>.<verb>` in snake_case, e.g.
 * `order.status_changed`, `order.transition`, `report.downloaded`.
 */
export const auditActionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    message: 'action must be a namespaced snake_case string like "order.status_changed"',
  });

/** The entity the action applies to, e.g. `{ type: 'order', id: '<uuid>' }`. */
export const auditEntityRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().uuid(),
});
export type AuditEntityRef = z.infer<typeof auditEntityRefSchema>;

/** Structured JSON payload with extra context (old/new status, reason, …). */
export const auditDetailSchema = z.record(z.unknown());
export type AuditDetail = z.infer<typeof auditDetailSchema>;

/** Validated input for recording one audit event. */
export const auditEventInputSchema = z.object({
  actor: auditActorSchema,
  action: auditActionSchema,
  entityRef: auditEntityRefSchema,
  detail: auditDetailSchema.optional(),
});
export type AuditEventInput = z.infer<typeof auditEventInputSchema>;

/** A persisted audit event (one `audit_log` row, mapped to the domain). */
export interface AuditEvent {
  readonly id: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly entityRef: AuditEntityRef;
  readonly detail: AuditDetail | null;
  readonly createdAt: Date;
}
