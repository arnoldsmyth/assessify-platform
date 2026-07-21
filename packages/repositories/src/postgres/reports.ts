import { reports, respondentSessions, respondents, type Database } from '@assessify/db';
import type { ReportKind, ReportStatus } from '@assessify/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Data access for `reports` (spec 04 / spec 09) plus the one cross-table
 * read report assembly needs (scored session + respondent display name).
 * Pure persistence — release rules, authz and the order state machine live
 * in the report service. Status flips are guarded compare-and-set updates so
 * concurrent assembly/release attempts are race-free.
 */

export interface ReportRecord {
  id: string;
  orderId: string;
  /** Null for aggregate reports (spec 09). */
  sessionId: string | null;
  templateVersionId: string;
  kind: ReportKind;
  status: ReportStatus;
  releasedAt: Date | null;
  releasedBy: string | null;
  /** Set only for migrated legacy reports (spec 09). */
  legacyPdfPath: string | null;
  /** Assembly snapshot (merge context + storage key) — see report service. */
  data: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Everything `reportService.assemble(sessionId)` reads about the session in
 * one query. The respondent name is report CONTENT (it appears on the
 * report) — callers must never log it (spec 00 PII rule).
 */
export interface ReportAssemblySource {
  sessionId: string;
  orderId: string;
  /** Mirrors the `session_status` pg enum. */
  sessionStatus: string;
  /** Respondent's display language; null → order.reportLanguage. */
  language: string | null;
  completedAt: Date | null;
  /** The validated ScoreSet written by applyScores; null until scored. */
  scores: Record<string, unknown> | null;
  isFocal: boolean;
  respondent: { firstName: string | null; lastName: string | null } | null;
}

export interface ReportAssemblyPatch {
  templateVersionId: string;
  data: Record<string, unknown>;
  updatedAt: Date;
}

export interface ReportRepository {
  findById(id: string): Promise<ReportRecord | null>;
  /** The individual report for one session, if any. */
  findBySessionId(sessionId: string): Promise<ReportRecord | null>;
  /** All reports on an order, oldest first. */
  listByOrder(orderId: string): Promise<ReportRecord[]>;
  insert(report: ReportRecord): Promise<ReportRecord>;
  /**
   * Re-assembly: refresh template pin + data snapshot without touching the
   * release state. Returns the updated row, or null if no row matched.
   */
  updateAssembly(id: string, patch: ReportAssemblyPatch): Promise<ReportRecord | null>;
  /** ready → released (CAS). Null when missing or not `ready`. */
  release(id: string, releasedBy: string, at: Date): Promise<ReportRecord | null>;
  /** released → ready (CAS), clearing the release stamp. Null when missing or not `released`. */
  withhold(id: string, at: Date): Promise<ReportRecord | null>;
  /** Reports on the order in any of the given statuses. */
  countByOrder(orderId: string, statuses: readonly ReportStatus[]): Promise<number>;
  /** Focal sessions on the order (= expected individual reports, spec 09). */
  countFocalSessions(orderId: string): Promise<number>;
  /** Scored-session + respondent-name projection for assembly. */
  findAssemblySource(sessionId: string): Promise<ReportAssemblySource | null>;
}

type ReportRow = typeof reports.$inferSelect;

function toEntity(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    sessionId: row.sessionId,
    templateVersionId: row.templateVersionId,
    kind: row.kind as ReportKind,
    status: row.status as ReportStatus,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedBy,
    legacyPdfPath: row.legacyPdfPath,
    data: row.data as Record<string, unknown> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createReportRepository(db: Database): ReportRepository {
  return {
    async findById(id) {
      const rows = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async findBySessionId(sessionId) {
      const rows = await db
        .select()
        .from(reports)
        .where(eq(reports.sessionId, sessionId))
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async listByOrder(orderId) {
      const rows = await db
        .select()
        .from(reports)
        .where(eq(reports.orderId, orderId))
        .orderBy(reports.createdAt, reports.id);
      return rows.map(toEntity);
    },

    async insert(report) {
      const rows = await db
        .insert(reports)
        .values({
          id: report.id,
          orderId: report.orderId,
          sessionId: report.sessionId,
          templateVersionId: report.templateVersionId,
          kind: report.kind,
          status: report.status,
          releasedAt: report.releasedAt,
          releasedBy: report.releasedBy,
          legacyPdfPath: report.legacyPdfPath,
          data: report.data,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Insert into reports returned no row');
      return toEntity(row);
    },

    async updateAssembly(id, patch) {
      const rows = await db
        .update(reports)
        .set({
          templateVersionId: patch.templateVersionId,
          data: patch.data,
          updatedAt: patch.updatedAt,
        })
        .where(eq(reports.id, id))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async release(id, releasedBy, at) {
      const rows = await db
        .update(reports)
        .set({ status: 'released', releasedAt: at, releasedBy, updatedAt: at })
        .where(and(eq(reports.id, id), eq(reports.status, 'ready')))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async withhold(id, at) {
      const rows = await db
        .update(reports)
        .set({ status: 'ready', releasedAt: null, releasedBy: null, updatedAt: at })
        .where(and(eq(reports.id, id), eq(reports.status, 'released')))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async countByOrder(orderId, statuses) {
      if (statuses.length === 0) return 0;
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(reports)
        .where(and(eq(reports.orderId, orderId), inArray(reports.status, [...statuses])));
      return rows[0]?.count ?? 0;
    },

    async countFocalSessions(orderId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(respondentSessions)
        .where(
          and(eq(respondentSessions.orderId, orderId), eq(respondentSessions.isFocal, true))
        );
      return rows[0]?.count ?? 0;
    },

    async findAssemblySource(sessionId) {
      const rows = await db
        .select({
          sessionId: respondentSessions.id,
          orderId: respondentSessions.orderId,
          sessionStatus: respondentSessions.status,
          language: respondentSessions.language,
          completedAt: respondentSessions.completedAt,
          scores: respondentSessions.scores,
          isFocal: respondentSessions.isFocal,
          respondentId: respondentSessions.respondentId,
          firstName: respondents.firstName,
          lastName: respondents.lastName,
        })
        .from(respondentSessions)
        .leftJoin(respondents, eq(respondentSessions.respondentId, respondents.id))
        .where(eq(respondentSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        sessionId: row.sessionId,
        orderId: row.orderId,
        sessionStatus: row.sessionStatus,
        language: row.language,
        completedAt: row.completedAt,
        scores: row.scores as Record<string, unknown> | null,
        isFocal: row.isFocal,
        respondent:
          row.respondentId === null
            ? null
            : { firstName: row.firstName, lastName: row.lastName },
      };
    },
  };
}
