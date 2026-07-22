import {
  brandingConfigSchema,
  err,
  ok,
  resolveCompletionNotificationPolicy,
  type CompletionNotificationPolicy,
  type CompletionPolicySource,
  type DomainError,
  type EmailSender,
  type NotificationKind,
  type NotificationStatus,
  type Order,
  type Product,
  type Result,
} from '@assessify/domain';
import type {
  ClientNotificationRepository,
  CustomDomainRepository,
  InvitationSessionRecord,
  InvitationSessionRepository,
  NotificationLogRepository,
  OrderRepository,
  ProductRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import { buildRespondentEntryUrl, resolveInvitationHost } from '../invitations/invitation-link';
import type { NotificationService } from '../notifications';
import type { ReportReleasedHook } from '../reports';

/**
 * Completion notifications (E6 — spec 13): the `onReleased` seam E3 left on
 * the report service, implemented. Every report release (auto during
 * assembly in the worker, manual admin action in web) lands here, and per
 * the policy resolved order > client > product > platform default
 * (`resolveCompletionNotificationPolicy`, spec 13 precedence):
 *
 *  - `report_ready` → the RESPONDENT: product sender identity (spec 11
 *    `branding.emailFrom`), session language (asy-22p; falls back to the
 *    order's report language), and — only when the policy's respondent
 *    recipient opts in — their own report link
 *    `https://{product-host}/a/{token}/report` on the same white-label host
 *    invitations use (spec 09: the link only works because the report is
 *    released).
 *  - `completion_notice` → the client contact(s) and named third parties:
 *    platform sender (spec 13: admin-facing mail), client-locale language
 *    (not modelled yet → 'en'), and NEVER the respondent's report link — the
 *    `/a/{token}` token is the respondent's access credential (spec 05), so
 *    it must not travel to anyone else regardless of `includeReportLink`.
 *    The notice carries order reference + product/client names only — no
 *    respondent identity (spec 00 PII rule; the dashboard has the detail).
 *
 * Idempotent per report release: before sending each kind, the
 * notification_log is consulted for an existing row of that kind referencing
 * the session (`listByKindAndSession`). Any row that is still in flight or
 * arrived (queued/sent/delivered/opened) blocks a re-send, so a withhold →
 * re-release cycle cannot double-mail; rows that terminally failed
 * (failed/bounced) do NOT block, so a re-release after fixing a bad address
 * recovers naturally.
 *
 * Failure containment mirrors the hook contract (report-service): expected
 * conditions (policy silence, duplicates, missing addresses, notification
 * service errors) are summary codes — never throws, never blocks a release.
 * Only broken references (order/product/client/session rows missing) surface
 * as errors; the report service audits those as `report.release_hook_failed`.
 *
 * PII: recipient addresses live only in the notification_log/job payload
 * written by the notification service — never in audit detail, error detail,
 * or the summary this service returns.
 */

// ---------------------------------------------------------------------------
// Template keys resolved by the mailer provider (spec 13)
// ---------------------------------------------------------------------------

export const REPORT_READY_TEMPLATE = 'report-ready';
export const COMPLETION_NOTICE_TEMPLATE = 'completion-notice';

/**
 * Client/third-party mail language: spec 13 says "client locale", but no
 * client locale is modelled yet (clients carry only a timezone) — documented
 * simplification until a locale column exists.
 */
export const CLIENT_NOTICE_LANGUAGE = 'en';

/** notification_log statuses that mean "this mail already left (or will)". */
const BLOCKING_STATUSES: ReadonlySet<NotificationStatus> = new Set([
  'queued',
  'sent',
  'delivered',
  'opened',
]);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type RespondentSendOutcome =
  | 'queued'
  | 'skipped_policy'
  | 'skipped_duplicate'
  | 'skipped_missing_email'
  | 'failed';

export type ClientSendSkipReason = 'policy' | 'duplicate' | 'missing_recipients' | null;

export interface CompletionNotificationSummary {
  reportId: string;
  orderId: string;
  sessionId: string | null;
  /** Null when the run was skipped before policy resolution. */
  policySource: CompletionPolicySource | null;
  /** Whole-run skip (before any recipient work), or null when processed. */
  skipped: 'aggregate_report' | 'notifications_suppressed' | null;
  respondent: RespondentSendOutcome;
  client: {
    queued: number;
    failed: number;
    skipped: ClientSendSkipReason;
  };
}

export interface CompletionNotificationService {
  /**
   * Process one released report. Returns a summary Result; send-level
   * failures are summary codes, error Results mean broken data (missing
   * order/product/client/session rows) or an audit-write failure.
   */
  notifyReportReleased(released: {
    reportId: string;
    orderId: string;
    sessionId: string | null;
    mode: 'auto' | 'manual';
  }): Promise<Result<CompletionNotificationSummary>>;
  /**
   * `ReportReleasedHook` adapter for `getReportService({ onReleased })`:
   * throws (ids/codes only — no PII) on an error Result so the report
   * service audits `report.release_hook_failed`; a release is never rolled
   * back (E3 contract).
   */
  onReportReleased: ReportReleasedHook;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CompletionNotificationConfig {
  /** Primary base domain for `{slug}.` product hosts (e.g. `assessify.ie`). */
  slugBaseDomain: string;
  /** Sender for client/third-party mail + fallback respondent sender (spec 13). */
  platformSender: EmailSender;
}

export interface CompletionNotificationServiceDeps {
  orders: Pick<OrderRepository, 'findById'>;
  products: Pick<ProductRepository, 'findById'>;
  clients: ClientNotificationRepository;
  /** Session token + respondent email for the report link (same read D5 uses). */
  sessions: Pick<InvitationSessionRepository, 'listByOrder'>;
  customDomains: Pick<CustomDomainRepository, 'findActiveByProductId'>;
  /** Dedupe read only — sends go through the notification service. */
  notificationLog: Pick<NotificationLogRepository, 'listByKindAndSession'>;
  notifications: Pick<NotificationService, 'send'>;
  audit: AuditService;
  config: CompletionNotificationConfig;
}

// ---------------------------------------------------------------------------
// Errors — ids and codes only, never recipient data.
// ---------------------------------------------------------------------------

function notFound(code: string, message: string, id: string): DomainError {
  return { code, message, detail: { id } };
}

function repoFailure(op: string, cause: unknown): DomainError {
  return {
    code: 'completion_notification/storage_failed',
    message: `Failed to ${op}`,
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createCompletionNotificationService(
  deps: CompletionNotificationServiceDeps
): CompletionNotificationService {
  const {
    orders,
    products,
    clients,
    sessions,
    customDomains,
    notificationLog,
    notifications,
    audit,
    config,
  } = deps;

  /** Product sender identity (spec 13): branding.emailFrom, else platform. */
  function senderFor(product: Product): EmailSender {
    const branding = brandingConfigSchema.safeParse(product.branding ?? {});
    return branding.success && branding.data.emailFrom
      ? branding.data.emailFrom
      : config.platformSender;
  }

  /** True when a prior send of this kind for the session is queued/arrived. */
  async function alreadySent(kind: NotificationKind, sessionId: string): Promise<boolean> {
    const entries = await notificationLog.listByKindAndSession(kind, sessionId);
    return entries.some((entry) => BLOCKING_STATUSES.has(entry.status));
  }

  async function sendRespondentReportReady(input: {
    order: Order;
    product: Product;
    session: InvitationSessionRecord;
    includeReportLink: boolean;
  }): Promise<RespondentSendOutcome> {
    const { order, product, session, includeReportLink } = input;
    const email = session.respondent?.email;
    if (!email) return 'skipped_missing_email';
    if (await alreadySent('report_ready', session.id)) return 'skipped_duplicate';

    let reportUrl: string | undefined;
    if (includeReportLink) {
      const domains = await customDomains.findActiveByProductId(order.productId);
      const host = resolveInvitationHost({
        productSlug: product.slug,
        slugBaseDomain: config.slugBaseDomain,
        customDomains: domains,
        clientId: order.clientId,
      });
      // Spec 09: /a/{token}/report on the product's white-label host — the
      // token is the URL secret; no PII.
      reportUrl = `${buildRespondentEntryUrl(host, session.token)}/report`;
    }

    const sent = await notifications.send({
      kind: 'report_ready',
      to: email,
      subject: `Your ${product.name} report is ready`,
      template: REPORT_READY_TEMPLATE,
      data: {
        productName: product.name,
        firstName: session.respondent?.firstName ?? null,
        ...(reportUrl !== undefined && { reportUrl }),
      },
      // Session language is the source of truth (asy-22p), as in D5/D6.
      language: session.language ?? order.reportLanguage,
      sender: { from: senderFor(product) },
      refs: { orderId: order.id, sessionId: session.id },
    });
    return sent.ok ? 'queued' : 'failed';
  }

  async function sendClientCompletionNotices(input: {
    order: Order;
    product: Product;
    sessionId: string;
    clientName: string;
    clientBillingEmail: string | null;
    recipients: CompletionNotificationPolicy['recipients'];
  }): Promise<CompletionNotificationSummary['client']> {
    const { order, product, sessionId, clientName, clientBillingEmail, recipients } = input;
    if (recipients.length === 0) return { queued: 0, failed: 0, skipped: 'policy' };
    if (await alreadySent('completion_notice', sessionId)) {
      return { queued: 0, failed: 0, skipped: 'duplicate' };
    }

    // Explicit emails win; a `client` recipient without them falls back to
    // the client's billing contact. Deduplicated across recipient rules.
    const addresses = new Set<string>();
    for (const recipient of recipients) {
      const explicit = recipient.emails ?? [];
      if (explicit.length > 0) {
        for (const address of explicit) addresses.add(address);
      } else if (recipient.type === 'client' && clientBillingEmail) {
        addresses.add(clientBillingEmail);
      }
    }
    if (addresses.size === 0) return { queued: 0, failed: 0, skipped: 'missing_recipients' };

    let queued = 0;
    let failed = 0;
    for (const to of addresses) {
      const sent = await notifications.send({
        kind: 'completion_notice',
        to,
        subject: `${product.name} completed — order ${order.reference}`,
        template: COMPLETION_NOTICE_TEMPLATE,
        // No respondent identity and no report link (see module docs): the
        // client reviews detail in their dashboard.
        data: {
          productName: product.name,
          orderReference: order.reference,
          clientName,
        },
        language: CLIENT_NOTICE_LANGUAGE,
        sender: { from: config.platformSender },
        refs: { orderId: order.id, sessionId },
      });
      if (sent.ok) queued += 1;
      else failed += 1;
    }
    return { queued, failed, skipped: null };
  }

  async function notifyReportReleased(released: {
    reportId: string;
    orderId: string;
    sessionId: string | null;
    mode: 'auto' | 'manual';
  }): Promise<Result<CompletionNotificationSummary>> {
    const base: CompletionNotificationSummary = {
      reportId: released.reportId,
      orderId: released.orderId,
      sessionId: released.sessionId,
      policySource: null,
      skipped: null,
      respondent: 'skipped_policy',
      client: { queued: 0, failed: 0, skipped: 'policy' },
    };

    // Aggregate reports (sessionId null) are out of scope until they exist
    // (E3 assembles individual reports only) — no-op, not an error.
    if (released.sessionId === null) {
      return ok({ ...base, skipped: 'aggregate_report' });
    }
    const sessionId = released.sessionId;

    let order: Order | null;
    try {
      order = await orders.findById(released.orderId);
    } catch (cause) {
      return err(repoFailure('read order', cause));
    }
    if (!order) {
      return err(
        notFound('completion_notification/order_not_found', 'Order not found', released.orderId)
      );
    }

    // Silent mode (spec 06 partner API): the platform sends NO mail on this
    // order — the ordering partner owns all respondent/client communication.
    if (order.suppressNotifications) {
      const summary: CompletionNotificationSummary = {
        ...base,
        skipped: 'notifications_suppressed',
      };
      const audited = await recordAudit(summary, released.mode);
      if (!audited.ok) return err(audited.error);
      return ok(summary);
    }

    const product = await products.findById(order.productId);
    if (!product) {
      return err(
        notFound('completion_notification/product_not_found', 'Product not found', order.productId)
      );
    }
    let clientProfile;
    try {
      clientProfile = await clients.findNotificationProfile(order.clientId);
    } catch (cause) {
      return err(repoFailure('read client', cause));
    }
    if (!clientProfile) {
      return err(
        notFound('completion_notification/client_not_found', 'Client not found', order.clientId)
      );
    }

    const resolved = resolveCompletionNotificationPolicy(
      order.notificationPolicy,
      clientProfile.notificationOverrides,
      product.notificationDefaults
    );

    let session: InvitationSessionRecord | undefined;
    try {
      const all = await sessions.listByOrder(order.id);
      session = all.find((candidate) => candidate.id === sessionId);
    } catch (cause) {
      return err(repoFailure('read respondent sessions', cause));
    }
    if (!session) {
      return err(
        notFound('completion_notification/session_not_found', 'Session not found', sessionId)
      );
    }

    const respondentRule = resolved.policy.recipients.find(
      (recipient) => recipient.type === 'respondent'
    );
    const clientRules = resolved.policy.recipients.filter(
      (recipient) => recipient.type === 'client' || recipient.type === 'third_party'
    );

    const summary: CompletionNotificationSummary = {
      ...base,
      policySource: resolved.source,
      respondent: respondentRule
        ? await sendRespondentReportReady({
            order,
            product,
            session,
            includeReportLink: respondentRule.includeReportLink,
          })
        : 'skipped_policy',
      client: await sendClientCompletionNotices({
        order,
        product,
        sessionId,
        clientName: clientProfile.name,
        clientBillingEmail: clientProfile.billingEmail,
        recipients: clientRules,
      }),
    };

    const audited = await recordAudit(summary, released.mode);
    if (!audited.ok) return err(audited.error);
    return ok(summary);
  }

  /** One audit event per processed release — ids, codes and counts only. */
  function recordAudit(summary: CompletionNotificationSummary, mode: 'auto' | 'manual') {
    return audit.record(
      { kind: 'system', id: 'system' },
      'notification.completion_dispatched',
      { type: 'report', id: summary.reportId },
      {
        orderId: summary.orderId,
        sessionId: summary.sessionId,
        mode,
        policySource: summary.policySource,
        skipped: summary.skipped,
        respondent: summary.respondent,
        clientQueued: summary.client.queued,
        clientFailed: summary.client.failed,
        clientSkipped: summary.client.skipped,
      }
    );
  }

  return {
    notifyReportReleased,

    async onReportReleased(released) {
      const result = await notifyReportReleased(released);
      if (!result.ok) {
        // Codes and ids only (the report service audits this message).
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
    },
  };
}
