import { z } from 'zod';

import {
  ORDER_ERROR_STATUSES,
  ORDER_TRANSITIONS,
  err,
  isSuperAdmin,
  ok,
  type AuditEvent,
  type CallerContext,
  type DomainError,
  type NotificationLogEntry,
  type Order,
  type OrderEvent,
  type Result,
} from '@assessify/domain';
import type {
  ClientRepository,
  NotificationLogRepository,
  OrderRepository,
  ProductRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';

/**
 * Admin error queue (D7 — spec 06 "Error states"): the focused view over
 * orders stuck in the three retryable error states (`payment_error`,
 * `email_error`, `scoring_error`), plus recent failed/bounced notification_log
 * entries for email-failure context (spec 13). Retries themselves go through
 * `orderService.transition` — this service only *reads*.
 *
 * ## Scoping decision (spec 05)
 *
 * The queue is **super_admin only** (system callers included for workers):
 * spec 06 says error states "create an admin alert (error queue UI + email to
 * super admins)" and the spec 05 permission matrix reserves "Retry
 * error-state orders" for super_admin alone. Client- and product-scoped
 * roles are NOT given a scoped slice here — they already see their own error
 * orders through `orderService.list` status filters, and the failed-email
 * view exposes cross-client recipient addresses that only a super admin may
 * browse. Everyone else gets a typed `error_queue/forbidden`.
 */

export type OrderErrorStatus = (typeof ORDER_ERROR_STATUSES)[number];

export interface ErrorQueueEntry {
  order: Order;
  /** Best-effort display names — null when the row is gone/not visible. */
  clientName: string | null;
  productName: string | null;
  /**
   * When the order entered its current error state: the newest
   * `order.status_changed` audit event whose target is the current status,
   * falling back to `order.updatedAt` when the trail is unavailable.
   */
  enteredErrorAt: Date;
  /** The admin retry event that is legal from this error state (domain table). */
  retryEvent: OrderEvent;
  /** Prior admin retries of this error type, counted from the audit trail. */
  retryCount: number;
}

export interface ErrorQueuePage {
  items: ErrorQueueEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ErrorQueueCounts {
  total: number;
  byStatus: Record<OrderErrorStatus, number>;
}

export interface ErrorQueueService {
  /** Orders in the error states (optionally one state), newest failures first. */
  list(caller: CallerContext, query?: unknown): Promise<Result<ErrorQueuePage>>;
  /** Open error counts per state — the admin nav badge and the queue chips. */
  countOpen(caller: CallerContext): Promise<Result<ErrorQueueCounts>>;
  /**
   * Recent failed/bounced notification_log entries, newest first. Read-only
   * email-failure context (spec 13) — resending belongs to D5's flow.
   */
  listFailedNotifications(
    caller: CallerContext,
    query?: unknown
  ): Promise<Result<NotificationLogEntry[]>>;
}

export interface ErrorQueueServiceDeps {
  orders: OrderRepository;
  notificationLog: NotificationLogRepository;
  clients: ClientRepository;
  products: ProductRepository;
  audit: AuditService;
}

/**
 * The retry event legal from an error state, read straight from the domain
 * transition table so this can never drift from spec 06 (payment_error →
 * retry_payment, email_error → retry_email, scoring_error → retry_scoring).
 */
export function retryEventForErrorStatus(status: OrderErrorStatus): OrderEvent {
  const rule = ORDER_TRANSITIONS.find(
    (candidate) => candidate.from === status && candidate.event.startsWith('retry_')
  );
  if (!rule) {
    // Unreachable by construction — every error state has a retry row.
    throw new Error(`No retry transition is defined for order status "${status}"`);
  }
  return rule.event;
}

// ---------------------------------------------------------------------------
// Boundary validation (Zod at every boundary)
// ---------------------------------------------------------------------------

const errorQueueQuerySchema = z.object({
  status: z.enum(ORDER_ERROR_STATUSES).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
});

const failedNotificationsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

/** Audit pages fetched per order when deriving entered-at/retry counts. */
const AUDIT_TRAIL_LIMIT = 100;

const FAILED_NOTIFICATION_STATUSES = ['failed', 'bounced'] as const;

// ---------------------------------------------------------------------------
// Errors — ids only in detail, never respondent data (no-PII rule).
// ---------------------------------------------------------------------------

function forbidden(caller: CallerContext): DomainError {
  return {
    code: 'error_queue/forbidden',
    message: 'Only super admins can work the error queue',
    detail: { kind: caller.kind },
  };
}

function validationError(issues: z.ZodIssue[]): DomainError {
  return {
    code: 'error_queue/validation',
    message: 'Error queue query failed validation',
    detail: {
      issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

function canWorkQueue(caller: CallerContext): boolean {
  return caller.kind === 'system' || isSuperAdmin(caller);
}

// ---------------------------------------------------------------------------
// Audit-trail derivations (pure)
// ---------------------------------------------------------------------------

function detailString(event: AuditEvent, key: string): string | null {
  const value = event.detail?.[key];
  return typeof value === 'string' ? value : null;
}

/** Newest `order.status_changed` event that moved the order INTO its current status. */
function enteredErrorAtFromTrail(order: Order, trail: AuditEvent[]): Date {
  for (const event of trail) {
    if (event.action === 'order.status_changed' && detailString(event, 'to') === order.status) {
      return event.createdAt;
    }
  }
  return order.updatedAt;
}

/** How many times an admin already fired this retry event on the order. */
function retryCountFromTrail(trail: AuditEvent[], retryEvent: OrderEvent): number {
  return trail.filter(
    (event) =>
      event.action === 'order.status_changed' && detailString(event, 'event') === retryEvent
  ).length;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createErrorQueueService(deps: ErrorQueueServiceDeps): ErrorQueueService {
  const { orders, notificationLog, clients, products, audit } = deps;

  return {
    async list(caller, query) {
      if (!canWorkQueue(caller)) return err(forbidden(caller));
      const parsed = errorQueueQuerySchema.safeParse(query ?? {});
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { status, page, pageSize } = parsed.data;

      const statuses: readonly OrderErrorStatus[] = status ? [status] : ORDER_ERROR_STATUSES;
      const result = await orders.listByStatuses({
        statuses,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      // Best-effort display names (unknown ids simply resolve to null).
      const clientIds = [...new Set(result.items.map((order) => order.clientId))];
      const productIds = [...new Set(result.items.map((order) => order.productId))];
      const [clientRows, productRows] = await Promise.all([
        clientIds.length > 0 ? clients.findByIds(clientIds) : Promise.resolve([]),
        Promise.all(productIds.map((id) => products.findById(id))),
      ]);
      const clientNames = new Map(clientRows.map((client) => [client.id, client.name]));
      const productNames = new Map(
        productRows.flatMap((product) => (product ? [[product.id, product.name] as const] : []))
      );

      const items: ErrorQueueEntry[] = await Promise.all(
        result.items.map(async (order) => {
          const retryEvent = retryEventForErrorStatus(order.status as OrderErrorStatus);
          // Best-effort: a failed audit read degrades to updatedAt / 0, it
          // never blocks the queue (the queue IS the recovery surface).
          const trailResult = await audit.listByEntity(
            { type: 'order', id: order.id },
            { limit: AUDIT_TRAIL_LIMIT }
          );
          const trail = trailResult.ok ? trailResult.value.items : [];
          return {
            order,
            clientName: clientNames.get(order.clientId) ?? null,
            productName: productNames.get(order.productId) ?? null,
            enteredErrorAt: enteredErrorAtFromTrail(order, trail),
            retryEvent,
            retryCount: retryCountFromTrail(trail, retryEvent),
          };
        })
      );

      return ok({ items, total: result.total, page, pageSize });
    },

    async countOpen(caller) {
      if (!canWorkQueue(caller)) return err(forbidden(caller));
      const counts = await orders.countByStatuses(ORDER_ERROR_STATUSES);
      const byStatus = {
        payment_error: counts.payment_error ?? 0,
        email_error: counts.email_error ?? 0,
        scoring_error: counts.scoring_error ?? 0,
      } satisfies Record<OrderErrorStatus, number>;
      return ok({
        total: byStatus.payment_error + byStatus.email_error + byStatus.scoring_error,
        byStatus,
      });
    },

    async listFailedNotifications(caller, query) {
      if (!canWorkQueue(caller)) return err(forbidden(caller));
      const parsed = failedNotificationsQuerySchema.safeParse(query ?? {});
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const entries = await notificationLog.listByStatuses(
        FAILED_NOTIFICATION_STATUSES,
        parsed.data.limit
      );
      return ok(entries);
    },
  };
}
