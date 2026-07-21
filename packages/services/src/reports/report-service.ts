import {
  clientScopeIds,
  err,
  isSuperAdmin,
  ok,
  orgScopeIds,
  reportMergeContextSchema,
  reportPageSizeSchema,
  reportTemplateCapabilitiesSchema,
  resolveReportReleasePolicy,
  scoreSetSchema,
  systemCallerContext,
  uuidv7,
  type CallerContext,
  type DomainError,
  type Order,
  type Product,
  type ReportMergeContext,
  type ReportPageSize,
  type ReportStatus,
  type Result,
} from '@assessify/domain';
import type { ObjectStorage, PdfRenderer } from '@assessify/adapters';
import type {
  OrderRepository,
  ProductRepository,
  ReportRecord,
  ReportRepository,
  ReportTemplateVersionRepository,
  RespondentSessionRepository,
} from '@assessify/repositories';
import { z } from 'zod';

import type { AuditService } from '../audit';
import type { OrderService } from '../orders';
import type { TranslationService } from '../translations';
import { mergeTemplate } from './merge';
import { parseTemplateConfig } from './report-template-service';

/**
 * Report assembly + release controls (E3 — spec 09, re-scoped 2026-07-21:
 * uploaded HTML templates).
 *
 * Assembly (`report.assemble` worker job, fired by scoring's applyScores):
 *   load scored session (+ respondent name) → resolve the template (the
 *   order's pinned `report_template_version_id`, else the product's active
 *   one) → fetch template HTML from object storage → build + Zod-validate
 *   the merge context (scores, respondent, product, resolved translation
 *   strings for the session's language) → merge → store the assembled HTML
 *   at `reports/{orderId}/{reportId}.html` → upsert the `reports` row with
 *   the context snapshot in `data` (spec 09: rendering never re-queries live
 *   data) → session `report_ready` → auto-release per policy → when every
 *   focal session has a ready report, drive the order `reports_ready`
 *   (processing_report → completed) through `orderService.transition`.
 *
 * Release controls (spec 05 matrix "Release/hold reports"): super_admin,
 * client_admin of the order's client, or client_user with
 * `canReleaseReports` (and product scope). Releasing makes the report
 * visible on the respondent's token+PIN-gated report route; every release/
 * withhold/view/download writes `audit_log`. The `onReleased` hook is the
 * seam E6 plugs its `report_ready` notification into.
 *
 * Generated PDFs are never persisted (spec 09) — `renderPdfForSession`
 * streams straight from the PdfRenderer, and only for templates whose
 * capabilities include pdf (web-only products have no PDF affordance).
 */

export interface AssembledReportReceipt {
  reportId: string;
  sessionId: string;
  orderId: string;
  status: ReportStatus;
  /** Placeholder paths that resolved to nothing (template/data drift). */
  unknownPlaceholders: string[];
}

export interface ReportView {
  id: string;
  orderId: string;
  sessionId: string | null;
  status: ReportStatus;
  kind: ReportRecord['kind'];
  releasedAt: Date | null;
  releasedBy: string | null;
}

export interface RespondentReportView {
  reportId: string;
  html: string;
  pageSize: ReportPageSize;
  /** True when the template supports PDF (drives the download affordance). */
  pdfAvailable: boolean;
}

export interface PrintableReport {
  reportId: string;
  html: string;
  pageSize: ReportPageSize;
}

/** Seam for E6's `report_ready` notification — called after each release. */
export type ReportReleasedHook = (released: {
  reportId: string;
  orderId: string;
  sessionId: string | null;
  mode: 'auto' | 'manual';
}) => Promise<void>;

export interface ReportService {
  /** Worker-only (system): assemble the report for a scored session. Idempotent. */
  assemble(sessionId: string): Promise<Result<AssembledReportReceipt>>;
  /** Admin retry: re-run assembly (super_admin or the product org's assessment_admin). */
  reassemble(caller: CallerContext, sessionId: string): Promise<Result<AssembledReportReceipt>>;
  /** ready → released. Idempotent for already-released reports. */
  release(caller: CallerContext, reportId: string): Promise<Result<ReportView>>;
  /** released → ready (withhold from the respondent). Idempotent for `ready`. */
  withhold(caller: CallerContext, reportId: string): Promise<Result<ReportView>>;
  /** Respondent-facing view: released reports only (controllers gate token+PIN). */
  getRespondentReport(sessionId: string): Promise<Result<RespondentReportView>>;
  /** Raw assembled HTML for pdf-service's print fetch (controller checks the shared secret). */
  getPrintHtml(reportId: string): Promise<Result<PrintableReport>>;
  /** Stream a PDF for a released, pdf-capable report (respondent download). */
  renderPdfForSession(sessionId: string): Promise<Result<ReadableStream<Uint8Array>>>;
}

export interface ReportServiceDeps {
  reports: ReportRepository;
  reportTemplates: Pick<ReportTemplateVersionRepository, 'findById' | 'findActive'>;
  sessions: Pick<RespondentSessionRepository, 'markReportReady'>;
  orders: Pick<OrderRepository, 'findById'>;
  products: Pick<ProductRepository, 'findById'>;
  translations: Pick<TranslationService, 'resolve'>;
  orderService: Pick<OrderService, 'transition'>;
  audit: AuditService;
  storage: ObjectStorage;
  /** Optional — PDF downloads return `report/pdf_unavailable` without it. */
  pdf?: PdfRenderer;
  /** E6 seam; defaults to a no-op. Failures are audited, never fatal. */
  onReleased?: ReportReleasedHook;
  now?: () => Date;
  generateId?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deterministic storage-key scheme for assembled HTML — ids only, no PII. */
export function reportStorageKey(orderId: string, reportId: string): string {
  return `reports/${orderId}/${reportId}.html`;
}

/**
 * The shape persisted to `reports.data`: the validated merge context
 * snapshot plus everything serving needs without re-querying live data.
 */
export const reportDataSnapshotSchema = z.object({
  /** Object-storage key of the assembled HTML. */
  storageKey: z.string().min(1),
  pageSize: reportPageSizeSchema,
  capabilities: reportTemplateCapabilitiesSchema,
  unknownPlaceholders: z.array(z.string()),
  /** ISO-8601 assembly instant. */
  assembledAt: z.string().min(1),
  context: reportMergeContextSchema,
});
export type ReportDataSnapshot = z.infer<typeof reportDataSnapshotSchema>;

function notFound(code: string, message: string, id: string, permanent = false): DomainError {
  return { code, message, detail: { id, ...(permanent ? { permanent: true } : {}) } };
}

function permanentError(
  code: string,
  message: string,
  detail: Record<string, unknown> = {}
): DomainError {
  return { code, message, detail: { ...detail, permanent: true } };
}

function toView(report: ReportRecord): ReportView {
  return {
    id: report.id,
    orderId: report.orderId,
    sessionId: report.sessionId,
    status: report.status,
    kind: report.kind,
    releasedAt: report.releasedAt,
    releasedBy: report.releasedBy,
  };
}

/**
 * Spec 05 matrix, "Release/hold reports": super_admin ✔, assessment_admin ✖,
 * client_admin ✔ (their client's orders), client_user only with
 * `canReleaseReports` and product scope, respondents ✖.
 */
export function canReleaseReports(caller: CallerContext, order: Order): boolean {
  if (isSuperAdmin(caller)) return true;
  if (caller.kind !== 'user') return false;
  if (clientScopeIds(caller).length > 0) {
    for (const assignment of caller.roles) {
      if (assignment.clientId !== order.clientId) continue;
      if (assignment.role === 'client_admin') return true;
      if (assignment.role === 'client_user' && assignment.permissions.canReleaseReports) {
        const products = assignment.permissions.products;
        if (products === 'all' || products.includes(order.productId)) return true;
      }
    }
  }
  return false;
}

/** Manage-side authz (reassemble): super_admin or the product org's assessment_admin. */
function canManageProduct(caller: CallerContext, product: Product): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(product.organizationId);
}

export function createReportService(deps: ReportServiceDeps): ReportService {
  const { reports, reportTemplates, sessions, orders, products, translations, orderService, audit, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;
  const onReleased = deps.onReleased ?? (async () => undefined);
  const systemActor = { kind: 'system' as const, id: 'system' };

  /** Tolerant system-side order nudge (same convention as the scoring service). */
  async function nudgeOrderReportsReady(orderId: string): Promise<Result<null>> {
    const focal = await reports.countFocalSessions(orderId);
    if (focal === 0) return ok(null);
    const ready = await reports.countByOrder(orderId, ['ready', 'released']);
    if (ready < focal) return ok(null);
    const result = await orderService.transition(systemCallerContext(), orderId, {
      event: 'reports_ready',
    });
    if (!result.ok) {
      const tolerated =
        result.error.code === 'order/illegal_transition' || result.error.code === 'order/conflict';
      if (!tolerated) return err(result.error);
    }
    return ok(null);
  }

  /** Release core shared by auto-release and the manual action. */
  async function applyRelease(
    report: ReportRecord,
    releasedBy: string,
    mode: 'auto' | 'manual',
    actor: { kind: CallerContext['kind']; id: string }
  ): Promise<Result<ReportRecord>> {
    const released = await reports.release(report.id, releasedBy, now());
    if (!released) {
      // Lost a CAS race — report the row's current state idempotently.
      const current = await reports.findById(report.id);
      if (current?.status === 'released') return ok(current);
      return err({
        code: 'report/conflict',
        message: 'The report changed state concurrently',
        detail: { reportId: report.id },
      });
    }
    const audited = await audit.record(
      actor,
      'report.released',
      { type: 'report', id: report.id },
      { orderId: report.orderId, sessionId: report.sessionId, mode }
    );
    if (!audited.ok) return err(audited.error);
    try {
      await onReleased({
        reportId: released.id,
        orderId: released.orderId,
        sessionId: released.sessionId,
        mode,
      });
    } catch (cause) {
      // The hook (E6 notification) must never roll back a release.
      await audit.record(
        systemActor,
        'report.release_hook_failed',
        { type: 'report', id: report.id },
        { cause: cause instanceof Error ? cause.message : String(cause) }
      );
    }
    return ok(released);
  }

  /**
   * Assembly core. `manageCaller` is null for the worker (system) path and
   * the acting admin for `reassemble` (authz checked against the product).
   */
  async function assembleCore(
    sessionId: string,
    manageCaller: CallerContext | null
  ): Promise<Result<AssembledReportReceipt>> {
    if (!UUID_RE.test(sessionId)) {
      return err(notFound('report/session_not_found', 'Session not found', sessionId, true));
    }
    const source = await reports.findAssemblySource(sessionId);
    if (!source) {
      return err(notFound('report/session_not_found', 'Session not found', sessionId, true));
    }
    if (!source.isFocal) {
      // Rater sessions feed aggregate reports (spec 09) — out of E3's scope.
      return err(
        permanentError('report/session_not_focal', 'Rater sessions have no individual report', {
          sessionId,
        })
      );
    }
    if (source.scores === null || !['scored', 'report_ready'].includes(source.sessionStatus)) {
      return err(
        permanentError('report/session_not_scored', 'The session has not been scored yet', {
          sessionId,
          status: source.sessionStatus,
        })
      );
    }
    const scores = scoreSetSchema.safeParse(source.scores);
    if (!scores.success) {
      return err(
        permanentError('report/scores_invalid', 'The stored score document failed validation', {
          sessionId,
        })
      );
    }

    const order = await orders.findById(source.orderId);
    if (!order) {
      return err(notFound('report/order_not_found', 'Order not found', source.orderId, true));
    }
    const product = await products.findById(order.productId);
    if (!product) {
      return err(notFound('report/product_not_found', 'Product not found', order.productId, true));
    }
    if (manageCaller && !canManageProduct(manageCaller, product)) {
      return err({
        code: 'report/forbidden',
        message: 'Only super admins or the product’s assessment admins can re-assemble reports',
        detail: { action: 'reassemble' },
      });
    }

    // Template: the order's pinned version wins; else the product's active one.
    const template = order.reportTemplateVersionId
      ? await reportTemplates.findById(order.reportTemplateVersionId)
      : await reportTemplates.findActive(order.productId);
    if (!template) {
      return err(
        permanentError('report/template_missing', 'No report template is available for this product', {
          productId: order.productId,
          pinnedTemplateVersionId: order.reportTemplateVersionId,
        })
      );
    }
    const config = parseTemplateConfig(template);
    if (!config.ok) return err({ ...config.error, detail: { ...config.error.detail, permanent: true } });

    const templateObject = await storage.download(config.value.storageKey);
    if (!templateObject) {
      return err(
        permanentError('report/template_bytes_missing', 'The template HTML is missing from storage', {
          templateVersionId: template.id,
          storageKey: config.value.storageKey,
        })
      );
    }
    const templateHtml = decodeUtf8(templateObject.body);

    // Report copy in the session's language (asy-22p: the session language is
    // the source of truth), falling back to the order's report language.
    const language = source.language ?? order.reportLanguage;
    const resolved = await translations.resolve(order.productId, language);
    if (!resolved.ok) return err(resolved.error);

    const existing = await reports.findBySessionId(sessionId);
    const reportId = existing?.id ?? generateId();
    const at = now();
    const pageSizeParsed = reportPageSizeSchema.safeParse(
      order.pageSize ?? product.reportPageSizeDefault
    );
    const pageSize: ReportPageSize = pageSizeParsed.success ? pageSizeParsed.data : 'a4';

    const firstName = source.respondent?.firstName ?? '';
    const lastName = source.respondent?.lastName ?? '';
    const contextCandidate: ReportMergeContext = {
      report: {
        id: reportId,
        kind: 'individual',
        language: resolved.value.language,
        generatedAt: at.toISOString(),
        pageSize,
      },
      order: { id: order.id, reference: order.reference },
      product: { name: product.name, slug: product.slug },
      respondent: {
        firstName,
        lastName,
        fullName: [firstName, lastName].filter((part) => part !== '').join(' '),
      },
      session: { completedAt: source.completedAt?.toISOString() ?? null },
      scores: scores.data,
      t: resolved.value.strings,
    };
    const context = reportMergeContextSchema.safeParse(contextCandidate);
    if (!context.success) {
      return err(
        permanentError('report/context_invalid', 'The merge context failed validation', {
          sessionId,
          issues: context.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      );
    }

    const merged = mergeTemplate(templateHtml, context.data);
    const storageKey = reportStorageKey(order.id, reportId);
    try {
      await storage.upload({
        key: storageKey,
        body: encodeUtf8(merged.html),
        contentType: 'text/html; charset=utf-8',
      });
    } catch (cause) {
      return err({
        code: 'report/storage_failed',
        message: 'Failed to store the assembled report HTML',
        detail: { reportId, cause: cause instanceof Error ? cause.message : String(cause) },
      });
    }

    const snapshot: ReportDataSnapshot = {
      storageKey,
      pageSize,
      capabilities: config.value.capabilities,
      unknownPlaceholders: merged.unknownPlaceholders,
      assembledAt: at.toISOString(),
      context: context.data,
    };

    let report: ReportRecord;
    if (existing) {
      const updated = await reports.updateAssembly(existing.id, {
        templateVersionId: template.id,
        data: snapshot,
        updatedAt: at,
      });
      if (!updated) {
        return err(notFound('report/not_found', 'Report not found', existing.id, true));
      }
      report = updated;
    } else {
      report = await reports.insert({
        id: reportId,
        orderId: order.id,
        sessionId,
        templateVersionId: template.id,
        kind: 'individual',
        status: 'ready',
        releasedAt: null,
        releasedBy: null,
        legacyPdfPath: null,
        data: snapshot,
        createdAt: at,
        updatedAt: at,
      });
    }

    await sessions.markReportReady(sessionId, at);

    const actor = manageCaller ? { kind: manageCaller.kind, id: manageCaller.id } : systemActor;
    const audited = await audit.record(
      actor,
      existing ? 'report.reassembled' : 'report.assembled',
      { type: 'report', id: report.id },
      {
        orderId: order.id,
        sessionId,
        templateVersionId: template.id,
        language: resolved.value.language,
        // Paths only — never merged values (they can contain respondent data).
        unknownPlaceholders: merged.unknownPlaceholders,
      }
    );
    if (!audited.ok) return err(audited.error);

    // Auto-release per product/order policy (spec 09) — fresh assemblies only;
    // re-assembly never resurrects a withheld report.
    if (report.status === 'ready' && !existing) {
      const policy = resolveReportReleasePolicy(order.notificationPolicy, product.notificationDefaults);
      if (policy === 'auto') {
        const released = await applyRelease(report, 'system', 'auto', systemActor);
        if (!released.ok) return err(released.error);
        report = released.value;
      }
    }

    const nudged = await nudgeOrderReportsReady(order.id);
    if (!nudged.ok) return nudged;

    return ok({
      reportId: report.id,
      sessionId,
      orderId: order.id,
      status: report.status,
      unknownPlaceholders: merged.unknownPlaceholders,
    });
  }

  /** Load a report + its data snapshot, or a typed error. */
  async function loadSnapshot(
    report: ReportRecord
  ): Promise<Result<ReportDataSnapshot>> {
    const parsed = reportDataSnapshotSchema.safeParse(report.data);
    if (!parsed.success) {
      return err({
        code: 'report/not_assembled',
        message: 'The report has not been assembled yet',
        detail: { reportId: report.id, status: report.status },
      });
    }
    return ok(parsed.data);
  }

  async function loadAssembledHtml(snapshot: ReportDataSnapshot, reportId: string): Promise<Result<string>> {
    const object = await storage.download(snapshot.storageKey);
    if (!object) {
      return err({
        code: 'report/html_missing',
        message: 'The assembled report HTML is missing from storage',
        detail: { reportId, storageKey: snapshot.storageKey },
      });
    }
    return ok(decodeUtf8(object.body));
  }

  return {
    assemble(sessionId) {
      return assembleCore(sessionId, null);
    },

    reassemble(caller, sessionId) {
      return assembleCore(sessionId, caller);
    },

    async release(caller, reportId) {
      if (!UUID_RE.test(reportId)) {
        return err(notFound('report/not_found', 'Report not found', reportId));
      }
      const report = await reports.findById(reportId);
      if (!report) return err(notFound('report/not_found', 'Report not found', reportId));
      const order = await orders.findById(report.orderId);
      if (!order) {
        return err(notFound('report/order_not_found', 'Order not found', report.orderId));
      }
      if (!canReleaseReports(caller, order)) {
        return err({
          code: 'report/forbidden',
          message: 'You do not have permission to release reports for this order',
          detail: { action: 'release' },
        });
      }
      if (report.status === 'released') return ok(toView(report));
      if (report.status !== 'ready') {
        return err({
          code: 'report/not_ready',
          message: 'The report has not been assembled yet',
          detail: { reportId, status: report.status },
        });
      }
      const released = await applyRelease(report, caller.id, 'manual', {
        kind: caller.kind,
        id: caller.id,
      });
      if (!released.ok) return released;
      return ok(toView(released.value));
    },

    async withhold(caller, reportId) {
      if (!UUID_RE.test(reportId)) {
        return err(notFound('report/not_found', 'Report not found', reportId));
      }
      const report = await reports.findById(reportId);
      if (!report) return err(notFound('report/not_found', 'Report not found', reportId));
      const order = await orders.findById(report.orderId);
      if (!order) {
        return err(notFound('report/order_not_found', 'Order not found', report.orderId));
      }
      if (!canReleaseReports(caller, order)) {
        return err({
          code: 'report/forbidden',
          message: 'You do not have permission to withhold reports for this order',
          detail: { action: 'withhold' },
        });
      }
      if (report.status === 'ready') return ok(toView(report));
      if (report.status !== 'released') {
        return err({
          code: 'report/not_ready',
          message: 'Only released reports can be withheld',
          detail: { reportId, status: report.status },
        });
      }
      const withheld = await reports.withhold(reportId, now());
      if (!withheld) {
        const current = await reports.findById(reportId);
        if (current?.status === 'ready') return ok(toView(current));
        return err({
          code: 'report/conflict',
          message: 'The report changed state concurrently',
          detail: { reportId },
        });
      }
      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'report.withheld',
        { type: 'report', id: reportId },
        { orderId: report.orderId, sessionId: report.sessionId }
      );
      if (!audited.ok) return err(audited.error);
      return ok(toView(withheld));
    },

    async getRespondentReport(sessionId) {
      if (!UUID_RE.test(sessionId)) {
        return err(notFound('report/not_found', 'Report not found', sessionId));
      }
      const report = await reports.findBySessionId(sessionId);
      // One generic "not available" error — never leak whether a report
      // exists but is unreleased vs missing entirely.
      if (!report || report.status !== 'released') {
        return err({
          code: 'report/not_available',
          message: 'Your report is not available yet',
        });
      }
      const snapshot = await loadSnapshot(report);
      if (!snapshot.ok) return snapshot;
      const html = await loadAssembledHtml(snapshot.value, report.id);
      if (!html.ok) return html;
      const audited = await audit.record(
        { kind: 'respondent', id: sessionId },
        'report.viewed',
        { type: 'report', id: report.id },
        { orderId: report.orderId, sessionId }
      );
      if (!audited.ok) return err(audited.error);
      return ok({
        reportId: report.id,
        html: html.value,
        pageSize: snapshot.value.pageSize,
        pdfAvailable: snapshot.value.capabilities.pdf && deps.pdf !== undefined,
      });
    },

    async getPrintHtml(reportId) {
      if (!UUID_RE.test(reportId)) {
        return err(notFound('report/not_found', 'Report not found', reportId));
      }
      const report = await reports.findById(reportId);
      if (!report || report.status === 'pending') {
        return err(notFound('report/not_found', 'Report not found', reportId));
      }
      const snapshot = await loadSnapshot(report);
      if (!snapshot.ok) return snapshot;
      const html = await loadAssembledHtml(snapshot.value, report.id);
      if (!html.ok) return html;
      return ok({ reportId: report.id, html: html.value, pageSize: snapshot.value.pageSize });
    },

    async renderPdfForSession(sessionId) {
      if (!UUID_RE.test(sessionId)) {
        return err(notFound('report/not_found', 'Report not found', sessionId));
      }
      const report = await reports.findBySessionId(sessionId);
      if (!report || report.status !== 'released') {
        return err({
          code: 'report/not_available',
          message: 'Your report is not available yet',
        });
      }
      const snapshot = await loadSnapshot(report);
      if (!snapshot.ok) return snapshot;
      if (!snapshot.value.capabilities.pdf) {
        return err({
          code: 'report/pdf_unavailable',
          message: 'This report is available on the web only',
          detail: { reportId: report.id },
        });
      }
      if (!deps.pdf) {
        return err({
          code: 'report/pdf_renderer_unavailable',
          message: 'PDF rendering is not configured',
        });
      }
      const html = await loadAssembledHtml(snapshot.value, report.id);
      if (!html.ok) return html;
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await deps.pdf.render({ html: html.value, pageSize: snapshot.value.pageSize });
      } catch (cause) {
        return err({
          code: 'report/pdf_render_failed',
          message: 'The PDF could not be generated',
          detail: { reportId: report.id, cause: cause instanceof Error ? cause.message : String(cause) },
        });
      }
      const audited = await audit.record(
        { kind: 'respondent', id: sessionId },
        'report.downloaded',
        { type: 'report', id: report.id },
        { orderId: report.orderId, sessionId, pageSize: snapshot.value.pageSize }
      );
      if (!audited.ok) return err(audited.error);
      return ok(stream);
    },
  };
}

// ---------------------------------------------------------------------------
// UTF-8 helpers — this package compiles with lib ES2022 (no DOM/@types/node),
// so declare the encoder/decoder globals every supported runtime provides.
// ---------------------------------------------------------------------------

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label?: string) => { decode(input: Uint8Array): string };

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function decodeUtf8(input: Uint8Array): string {
  return new TextDecoder('utf-8').decode(input);
}
