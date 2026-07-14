import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { auditLog, type Database } from '@assessify/db';
import type {
  AuditActor,
  AuditActorKind,
  AuditDetail,
  AuditEntityRef,
  AuditEvent,
  AuditEventInput,
} from '@assessify/domain';
import { uuidv7 } from 'uuidv7';

/** Offset pagination for audit queries (admin UI lists). */
export interface AuditLogQuery {
  /** Page size, 1–{@link MAX_AUDIT_PAGE_SIZE}. Defaults to {@link DEFAULT_AUDIT_PAGE_SIZE}. */
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  items: AuditEvent[];
  /** True when more rows exist beyond `offset + items.length`. */
  hasMore: boolean;
}

export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 200;

/**
 * Data access for the append-only `audit_log` table (spec 04). Insert-only by
 * design — the 0001 migration's trigger blocks UPDATE/DELETE at the database.
 * Rows are mapped to the `AuditEvent` domain entity; drizzle rows never leave
 * this layer. Infrastructure failures throw — the service layer converts them
 * to `Result` errors.
 */
export interface AuditLogRepository {
  insert(input: AuditEventInput): Promise<AuditEvent>;
  listByEntity(entityRef: AuditEntityRef, query?: AuditLogQuery): Promise<AuditLogPage>;
  listByActor(actor: AuditActor, query?: AuditLogQuery): Promise<AuditLogPage>;
}

type AuditLogRow = typeof auditLog.$inferSelect;

function toEntity(row: AuditLogRow): AuditEvent {
  return {
    id: row.id,
    actor: { kind: row.actorType as AuditActorKind, id: row.actorId },
    action: row.action,
    entityRef: { type: row.entityType, id: row.entityId },
    detail: (row.detail as AuditDetail | null) ?? null,
    createdAt: row.createdAt,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_AUDIT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_AUDIT_PAGE_SIZE);
}

export function createAuditLogRepository(db: Database): AuditLogRepository {
  async function page(where: SQL | undefined, query: AuditLogQuery): Promise<AuditLogPage> {
    const limit = clampLimit(query.limit);
    const offset = Math.max(query.offset ?? 0, 0);
    // Fetch one extra row to detect whether another page exists.
    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1)
      .offset(offset);
    return { items: rows.slice(0, limit).map(toEntity), hasMore: rows.length > limit };
  }

  return {
    async insert(input) {
      const [row] = await db
        .insert(auditLog)
        .values({
          id: uuidv7(),
          actorType: input.actor.kind,
          actorId: input.actor.id,
          action: input.action,
          entityType: input.entityRef.type,
          entityId: input.entityRef.id,
          detail: input.detail ?? null,
        })
        .returning();
      if (!row) throw new Error('audit_log insert returned no row');
      return toEntity(row);
    },

    listByEntity(entityRef, query = {}) {
      return page(
        and(eq(auditLog.entityType, entityRef.type), eq(auditLog.entityId, entityRef.id)),
        query
      );
    },

    listByActor(actor, query = {}) {
      return page(
        and(
          eq(auditLog.actorType, actor.kind),
          actor.id === null ? isNull(auditLog.actorId) : eq(auditLog.actorId, actor.id)
        ),
        query
      );
    },
  };
}
