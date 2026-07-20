import {
  HOLD_PREVIOUS_STATUS_KEY,
  clientScopeIds,
  createOrderSchema,
  err,
  findOrderTransition,
  hasRole,
  isSuperAdmin,
  listOrdersQuerySchema,
  ok,
  orderEventsFrom,
  orderStatusSchema,
  orderTotals,
  productScopeIds,
  resolveOrderTransitionTarget,
  transitionOrderSchema,
  uuid4,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderSessionSummary,
  type OrderStatus,
  type OrderTransitionActor,
  type Result,
} from '@assessify/domain';
import type {
  AuditLogPage,
  NewOrder,
  NewOrderSession,
  OrderRepository,
  OrderStatusPatch,
} from '@assessify/repositories';

import type { AuditService } from '../audit';

/**
 * Order business logic (D1 — spec 06). Owns the 13-state machine: every
 * transition is validated against the declarative table in
 * `@assessify/domain` (the service rejects anything not listed) and EVERY
 * applied state change writes an `audit_log` event with the acting caller
 * (spec 00 hard rule). Payments (D3), invitations (D5) and scoring (E1) call
 * `transition` with their events — they never set `orders.status` directly.
 */

export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
  /** Respondent sessions on the order (named/bulk_named: created with it). */
  sessions: OrderSessionSummary[];
}

export interface OrderList {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderService {
  /**
   * Create a draft order (named/bulk_named) with its pricing snapshot and one
   * respondent session per captured respondent (find-or-create by email).
   */
  create(caller: CallerContext, input: unknown): Promise<Result<Order>>;
  /** Apply one state-machine event; illegal transitions return typed errors. */
  transition(caller: CallerContext, orderId: string, input: unknown): Promise<Result<Order>>;
  get(caller: CallerContext, orderId: string): Promise<Result<OrderWithItems>>;
  list(caller: CallerContext, query: unknown): Promise<Result<OrderList>>;
  /** Audit trail for the order (creation + every transition), newest first. */
  history(caller: CallerContext, orderId: string): Promise<Result<AuditLogPage>>;
}

export interface OrderServiceDeps {
  orders: OrderRepository;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
  /** Session URL tokens — UUIDv4 by default (spec 05: no time-ordering leakage). */
  generateToken?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors — ids only in detail, never respondent data (no-PII rule).
// ---------------------------------------------------------------------------

function validationError(
  issues: { path: string; message: string }[],
  message = 'Order payload failed validation'
): DomainError {
  return { code: 'order/validation', message, detail: { issues } };
}

function zodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function notFound(id: string): DomainError {
  return { code: 'order/not_found', message: 'Order not found', detail: { id } };
}

function forbiddenOrder(detail: Record<string, unknown>): DomainError {
  return {
    code: 'order/forbidden',
    message: 'You do not have permission to perform this action on this order',
    detail,
  };
}

function illegalTransition(from: OrderStatus, event: OrderEvent): DomainError {
  return {
    code: 'order/illegal_transition',
    message: `Event "${event}" is not allowed while the order is "${from}"`,
    detail: { from, event, legalEvents: orderEventsFrom(from) },
  };
}

function conflict(id: string, expected: OrderStatus): DomainError {
  return {
    code: 'order/conflict',
    message: 'The order was modified concurrently — reload and retry',
    detail: { id, expectedStatus: expected },
  };
}

function invalidHoldState(id: string): DomainError {
  return {
    code: 'order/invalid_hold_state',
    message: 'The held order does not record a valid previous status to release to',
    detail: { id },
  };
}

// ---------------------------------------------------------------------------
// Authorization (spec 05 permission matrix)
// ---------------------------------------------------------------------------

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

/** May the caller place an order for this client? */
function canPlaceOrderFor(caller: CallerContext, clientId: string): boolean {
  if (caller.kind === 'system') return true; // retail flow (G1) and workers
  if (caller.kind !== 'user') return false; // api_key ordering lands with I1
  if (isSuperAdmin(caller)) return true;
  return caller.roles.some(
    (a) =>
      a.clientId === clientId &&
      (a.role === 'client_admin' || (a.role === 'client_user' && a.permissions.canPlaceOrders))
  );
}

/** May the caller read this order? */
function canViewOrder(caller: CallerContext, order: Order): boolean {
  if (caller.kind === 'system') return true;
  if (caller.kind !== 'user') return false;
  if (isSuperAdmin(caller)) return true;
  return caller.roles.some((a) => {
    if (a.role === 'assessment_admin') return a.productId === order.productId;
    if (a.role === 'client_admin') return a.clientId === order.clientId;
    if (a.role === 'client_user')
      return (
        a.clientId === order.clientId &&
        (a.permissions.canViewResults || a.permissions.canPlaceOrders)
      );
    return false;
  });
}

/**
 * Map the caller onto the transition table's actor tags, applying scope:
 * client roles only count for orders of their own client (spec 05: UUID
 * knowledge is never sufficient).
 */
function transitionActorTags(caller: CallerContext, orderClientId: string): OrderTransitionActor[] {
  if (caller.kind === 'system') return ['system'];
  if (caller.kind !== 'user') return [];
  const tags: OrderTransitionActor[] = [];
  if (isSuperAdmin(caller)) tags.push('super_admin');
  for (const a of caller.roles) {
    if (a.role === 'client_admin' && a.clientId === orderClientId) tags.push('client_admin');
    if (
      a.role === 'client_user' &&
      a.clientId === orderClientId &&
      a.permissions.canPlaceOrders
    )
      tags.push('client_user');
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createOrderService(deps: OrderServiceDeps): OrderService {
  const { orders, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;
  const generateToken = deps.generateToken ?? uuid4;

  return {
    async create(caller, input) {
      const parsed = createOrderSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const data = parsed.data;

      if (!canPlaceOrderFor(caller, data.clientId)) {
        return err(forbiddenOrder({ action: 'create', clientId: data.clientId }));
      }
      // Per-line discounts are super_admin only (spec 06 wizard step 3).
      const hasDiscount = data.items.some((item) => item.discount > 0);
      if (hasDiscount && !(caller.kind === 'user' && isSuperAdmin(caller))) {
        return err(
          forbiddenOrder({ action: 'create', reason: 'discounts_require_super_admin' })
        );
      }

      const timestamp = now();
      const totals = orderTotals(data.items);
      const order: NewOrder = {
        id: generateId(),
        type: data.type,
        status: 'draft',
        clientId: data.clientId,
        productId: data.productId,
        questionnaireVersionId: data.questionnaireVersionId,
        reportTemplateVersionId: data.reportTemplateVersionId,
        reportLanguage: data.reportLanguage,
        reportModel: data.reportModel,
        currency: data.currency,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        total: totals.total,
        paymentProvider: null, // set by the payment step (D3)
        entitlementId: null, // set by entitlement draw-down (H1)
        notificationPolicy: data.notificationPolicy,
        suppressNotifications: data.suppressNotifications,
        expectedRespondents: null,
        pageSize: data.pageSize,
        isTest: data.isTest,
        relatedOrderId: null,
        placedByUserId: caller.kind === 'user' ? caller.id : null,
        placedVia: data.placedVia,
        errorDetail: null,
        source: 'native',
        legacyId: null,
        approvedAt: null,
        sentAt: null,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const items = data.items.map((item, index) => ({
        id: generateId(),
        lineNo: index + 1,
        description: item.description,
        unitPrice: item.unitPrice,
        discount: item.discount,
        quantity: item.quantity,
      }));
      // One session per respondent, created with the order (spec 05 patterns
      // 1/2: identity known at order time). PINs are generated at invitation
      // dispatch (D5) — the plaintext only ever travels in the invite email.
      const sessions: NewOrderSession[] = data.respondents.map((respondent) => ({
        id: generateId(),
        token: generateToken(),
        questionnaireVersionId: data.questionnaireVersionId,
        language: respondent.language ?? data.reportLanguage,
        respondent: {
          id: generateId(),
          email: respondent.email,
          firstName: respondent.firstName,
          lastName: respondent.lastName,
          language: respondent.language ?? null,
        },
        createdAt: timestamp,
      }));

      const created = await orders.insert(order, items, sessions);
      const audited = await audit.record(
        auditActor(caller),
        'order.created',
        { type: 'order', id: created.id },
        {
          reference: created.reference,
          orderType: created.type,
          clientId: created.clientId,
          productId: created.productId,
          currency: created.currency,
          total: created.total,
          isTest: created.isTest,
          // Count only — respondent PII never enters the audit log.
          respondentCount: sessions.length,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(created);
    },

    async transition(caller, orderId, input) {
      if (!UUID_RE.test(orderId)) return err(notFound(orderId));
      const parsed = transitionOrderSchema.safeParse(input);
      if (!parsed.success) {
        return err(validationError(zodIssues(parsed.error.issues), 'Transition payload failed validation'));
      }
      const { event, reason, errorDetail } = parsed.data;

      const order = await orders.findById(orderId);
      if (!order) return err(notFound(orderId));
      // Hide existence from callers who cannot even view the order.
      if (!canViewOrder(caller, order)) return err(notFound(orderId));

      const rule = findOrderTransition(order.status, event);
      if (!rule) return err(illegalTransition(order.status, event));

      const tags = transitionActorTags(caller, order.clientId);
      if (!tags.some((tag) => rule.actors.includes(tag))) {
        return err(
          forbiddenOrder({ action: 'transition', event, requiredActors: [...rule.actors] })
        );
      }

      // Resolve the target (release goes back to the recorded previous state).
      const heldPrevious =
        event === 'release'
          ? orderStatusSchema.safeParse(order.errorDetail?.[HOLD_PREVIOUS_STATUS_KEY])
          : null;
      const to = resolveOrderTransitionTarget(
        rule,
        heldPrevious?.success ? heldPrevious.data : null
      );
      if (to === null) return err(invalidHoldState(orderId));

      // Next error_detail: hold stores the previous state (+ any prior error
      // detail so release can restore it); error states store the failure
      // context; everything else clears it.
      let nextErrorDetail: Record<string, unknown> | null = null;
      if (event === 'hold') {
        nextErrorDetail = {
          [HOLD_PREVIOUS_STATUS_KEY]: order.status,
          ...(order.errorDetail ? { heldErrorDetail: order.errorDetail } : {}),
          ...(reason ? { reason } : {}),
        };
      } else if (event === 'release') {
        const held = order.errorDetail?.heldErrorDetail;
        nextErrorDetail =
          held && typeof held === 'object' ? (held as Record<string, unknown>) : null;
      } else if (to === 'payment_error' || to === 'email_error' || to === 'scoring_error') {
        nextErrorDetail = errorDetail ?? (reason ? { reason } : {});
      }

      const timestamp = now();
      const patch: OrderStatusPatch = {
        status: to,
        errorDetail: nextErrorDetail,
        updatedAt: timestamp,
      };
      // Milestone timestamps are set on first entry only (resend_email's
      // auto-return must not overwrite completed_at).
      if (to === 'approved' && order.approvedAt === null) patch.approvedAt = timestamp;
      if (to === 'sent' && order.sentAt === null) patch.sentAt = timestamp;
      if (to === 'completed' && order.completedAt === null) patch.completedAt = timestamp;

      const updated = await orders.updateStatus(orderId, order.status, patch);
      if (!updated) return err(conflict(orderId, order.status));

      const audited = await audit.record(
        auditActor(caller),
        'order.status_changed',
        { type: 'order', id: orderId },
        {
          from: order.status,
          to,
          event,
          ...(reason ? { reason } : {}),
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(updated);
    },

    async get(caller, orderId) {
      if (!UUID_RE.test(orderId)) return err(notFound(orderId));
      const order = await orders.findById(orderId);
      if (!order) return err(notFound(orderId));
      if (!canViewOrder(caller, order)) return err(notFound(orderId));
      const [items, sessions] = await Promise.all([
        orders.findItems(orderId),
        orders.findSessions(orderId),
      ]);
      return ok({ order, items, sessions });
    },

    async history(caller, orderId) {
      if (!UUID_RE.test(orderId)) return err(notFound(orderId));
      const order = await orders.findById(orderId);
      if (!order) return err(notFound(orderId));
      // Same visibility rule as get — hide existence from out-of-scope callers.
      if (!canViewOrder(caller, order)) return err(notFound(orderId));
      return audit.listByEntity({ type: 'order', id: orderId }, { limit: 100 });
    },

    async list(caller, query) {
      const parsed = listOrdersQuerySchema.safeParse(query ?? {});
      if (!parsed.success) {
        return err(validationError(zodIssues(parsed.error.issues), 'Order query failed validation'));
      }
      const { page, pageSize, clientId, productId, status, type } = parsed.data;

      // Scope enforcement: non-super-admin users must query within their own
      // client/product scope; the query is rejected rather than silently
      // widened (spec 05 — UUID knowledge is never sufficient).
      if (caller.kind !== 'system' && !(caller.kind === 'user' && isSuperAdmin(caller))) {
        if (caller.kind !== 'user') return err(forbiddenOrder({ action: 'list' }));
        const clientScope = clientScopeIds(caller);
        const productScope = productScopeIds(caller);
        const clientOk = clientId !== undefined && clientScope.includes(clientId);
        const productOk =
          hasRole(caller, 'assessment_admin') &&
          productId !== undefined &&
          productScope.includes(productId);
        if (!clientOk && !productOk) {
          return err(
            forbiddenOrder({ action: 'list', reason: 'query_must_be_scoped_to_own_client_or_product' })
          );
        }
      }

      const result = await orders.list({
        clientId,
        productId,
        status,
        type,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return ok({ items: result.items, total: result.total, page, pageSize });
    },
  };
}
