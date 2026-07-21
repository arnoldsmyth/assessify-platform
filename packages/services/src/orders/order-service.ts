import {
  HOLD_PREVIOUS_STATUS_KEY,
  canPlaceOrdersForClient,
  clientScopeIds,
  createOrderSchema,
  err,
  findOrderTransition,
  isSuperAdmin,
  listOrdersQuerySchema,
  ok,
  orderEventsFrom,
  orderStatusSchema,
  orderTotals,
  orgScopeIds,
  resolveOrderTransitionTarget,
  resolveOrderUnitPrice,
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
  ClientProductAccessRepository,
  ClientRepository,
  NewOrder,
  NewOrderSession,
  OrderRepository,
  OrderStatusPatch,
  ProductPriceRepository,
  ProductRepository,
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
  /**
   * Resolves an order's product to its organization for org-scoped
   * assessment_admin visibility (M2 re-scope, owner decisions 2026-07-21)
   * and for the M3 creation invariants (org match, access, price).
   */
  products: ProductRepository;
  /** Resolves the ordering client's organization (M3 org-bound invariant). */
  clients: ClientRepository;
  /** Explicit grants for restricted products (`default_access = false`). */
  clientProductAccess: ClientProductAccessRepository;
  /** Org price list — unit-price resolution at creation (spec 06 step 3). */
  productPrices: ProductPriceRepository;
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

function clientNotFound(clientId: string): DomainError {
  return { code: 'order/client_not_found', message: 'Client not found', detail: { clientId } };
}

function productNotFoundForOrder(productId: string): DomainError {
  return {
    code: 'order/product_not_found',
    message: 'Product not found',
    detail: { productId },
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

/**
 * May the caller read this order — client-scoped roles only. Org-scoped
 * assessment_admin visibility needs the product's organization and is
 * resolved by the service (async product lookup).
 */
function canViewOrderViaClientScope(caller: CallerContext, order: Order): boolean {
  if (caller.kind !== 'user') return false;
  return caller.roles.some((a) => {
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
  const { orders, products, clients, clientProductAccess, productPrices, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;
  const generateToken = deps.generateToken ?? uuid4;

  /** May the caller read this order? (spec 05, org re-scope 2026-07-21) */
  async function canViewOrder(caller: CallerContext, order: Order): Promise<boolean> {
    if (caller.kind === 'system') return true;
    if (caller.kind !== 'user') return false;
    if (isSuperAdmin(caller)) return true;
    if (canViewOrderViaClientScope(caller, order)) return true;
    // Org-scoped assessment_admin: the order's product must belong to one of
    // the caller's organizations.
    const orgScope = orgScopeIds(caller);
    if (orgScope.length === 0) return false;
    const product = await products.findById(order.productId);
    return product !== null && orgScope.includes(product.organizationId);
  }

  return {
    async create(caller, input) {
      const parsed = createOrderSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const data = parsed.data;

      if (!canPlaceOrdersForClient(caller, data.clientId)) {
        return err(forbiddenOrder({ action: 'create', clientId: data.clientId }));
      }
      // Per-line discounts are super_admin only (spec 06 wizard step 3).
      const hasDiscount = data.items.some((item) => item.discount > 0);
      if (hasDiscount && !isSuperAdmin(caller)) {
        return err(
          forbiddenOrder({ action: 'create', reason: 'discounts_require_super_admin' })
        );
      }

      // -------------------------------------------------------------------
      // M3 invariants (owner model: Platform → Organization → Client): a
      // client may only order their OWN organization's products they have
      // access to. Structural — no caller (super_admin included) bypasses it.
      // -------------------------------------------------------------------
      const [client] = await clients.findByIds([data.clientId]);
      if (!client) return err(clientNotFound(data.clientId));
      const product = await products.findById(data.productId);
      if (!product) return err(productNotFoundForOrder(data.productId));

      if (product.organizationId !== client.organizationId) {
        return err({
          code: 'order/product_outside_organization',
          message: 'The product does not belong to the client’s organization',
          detail: {
            clientId: data.clientId,
            productId: data.productId,
            clientOrganizationId: client.organizationId,
            productOrganizationId: product.organizationId,
          },
        });
      }
      if (!product.defaultAccess) {
        const grants = await clientProductAccess.listByClient(data.clientId);
        if (!grants.some((grant) => grant.productId === data.productId)) {
          return err({
            code: 'order/product_not_available_to_client',
            message:
              'The client does not have access to this product — it is restricted and no access grant exists',
            detail: { clientId: data.clientId, productId: data.productId },
          });
        }
      }

      // -------------------------------------------------------------------
      // Price resolution (spec 06 step 3): the order's unit price comes from
      // the org price list by (report language, order currency), falling back
      // to the product's retail price when the currency matches; otherwise
      // the order is unpriced. super_admin may manually override the unit
      // price (spec 06 — same actor rule as discounts); everyone else must
      // submit exactly the resolved price. Chain details:
      // @assessify/domain resolveOrderUnitPrice.
      // -------------------------------------------------------------------
      if (!isSuperAdmin(caller)) {
        const prices = await productPrices.listByProduct(data.productId);
        const resolved = resolveOrderUnitPrice(
          {
            prices,
            retailPrice: product.retailPrice,
            retailCurrency: product.retailCurrency,
          },
          data.reportLanguage,
          data.currency
        );
        if (!resolved) {
          return err({
            code: 'order/no_price_for_language',
            message: `No price is configured for language '${data.reportLanguage}' in ${data.currency}`,
            detail: {
              productId: data.productId,
              language: data.reportLanguage,
              currency: data.currency,
            },
          });
        }
        if (data.items.some((item) => item.unitPrice !== resolved.unitPrice)) {
          return err({
            code: 'order/price_mismatch',
            message:
              'The submitted unit price does not match the resolved price for this language and currency',
            detail: {
              productId: data.productId,
              language: data.reportLanguage,
              currency: data.currency,
              expectedUnitPrice: resolved.unitPrice,
              priceSource: resolved.source,
            },
          });
        }
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
      if (!(await canViewOrder(caller, order))) return err(notFound(orderId));

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
      if (!(await canViewOrder(caller, order))) return err(notFound(orderId));
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
      if (!(await canViewOrder(caller, order))) return err(notFound(orderId));
      return audit.listByEntity({ type: 'order', id: orderId }, { limit: 100 });
    },

    async list(caller, query) {
      const parsed = listOrdersQuerySchema.safeParse(query ?? {});
      if (!parsed.success) {
        return err(validationError(zodIssues(parsed.error.issues), 'Order query failed validation'));
      }
      const { page, pageSize, clientId, productId, organizationId, status, type } = parsed.data;

      // Scope enforcement: non-super-admin users must query within their own
      // client/organization scope; the query is rejected rather than silently
      // widened (spec 05 — UUID knowledge is never sufficient). Org-scoped
      // assessment_admins query by organizationId (M2 re-scope); a productId
      // filter alone no longer authorizes anything.
      if (caller.kind !== 'system' && !(caller.kind === 'user' && isSuperAdmin(caller))) {
        if (caller.kind !== 'user') return err(forbiddenOrder({ action: 'list' }));
        const clientScope = clientScopeIds(caller);
        const orgScope = orgScopeIds(caller);
        const clientOk = clientId !== undefined && clientScope.includes(clientId);
        const orgOk = organizationId !== undefined && orgScope.includes(organizationId);
        if (!clientOk && !orgOk) {
          return err(
            forbiddenOrder({
              action: 'list',
              reason: 'query_must_be_scoped_to_own_client_or_organization',
            })
          );
        }
      }

      const result = await orders.list({
        clientId,
        productId,
        organizationId,
        status,
        type,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return ok({ items: result.items, total: result.total, page, pageSize });
    },
  };
}
