import {
  orderItems,
  orders,
  products,
  respondentSessions,
  respondents,
  type Database,
} from '@assessify/db';
import type {
  Order,
  OrderItem,
  OrderPlacedVia,
  OrderReportModel,
  OrderSessionSummary,
  OrderStatus,
  OrderType,
  PaymentProvider,
  RespondentSessionStatus,
} from '@assessify/domain';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

/**
 * Data access for `orders` + `order_items` (spec 04). Pure persistence — no
 * business rules, no transition validation (that is the order service's job).
 * Rows are mapped to domain entities; drizzle rows never leave this layer.
 * Infrastructure failures throw; the service layer converts them to Results.
 */

/** Insert payload: the repository generates `reference` from `order_ref_seq` inside the transaction (spec 04 identifier conventions). */
export type NewOrder = Omit<Order, 'reference'>;

export type NewOrderItem = Omit<OrderItem, 'orderId'>;

/**
 * Respondent identity captured by the wizard for one session. `id` is used
 * only when no existing respondent matches the email (find-or-create — email
 * is the dedupe anchor per spec 04; the wizard's values refresh the name and
 * language on a match).
 */
export interface NewOrderRespondent {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  language: string | null;
}

/**
 * One `respondent_sessions` row to create with the order (named/bulk_named:
 * respondents are known at order time — spec 05 patterns 1/2). The PIN is NOT
 * set here: it is generated and bcrypt-hashed at invitation dispatch (D5),
 * because the plaintext is sent only in the invitation email (spec 05).
 */
export interface NewOrderSession {
  id: string;
  /** UUIDv4 URL secret (spec 05 token rules). */
  token: string;
  questionnaireVersionId: string;
  language: string | null;
  respondent: NewOrderRespondent;
  createdAt: Date;
}

/** Fields a status transition may touch — nothing else is updatable here. */
export interface OrderStatusPatch {
  status: OrderStatus;
  errorDetail: Record<string, unknown> | null;
  approvedAt?: Date;
  sentAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

export interface OrderListQuery {
  clientId?: string;
  productId?: string;
  /** Orders of the org's products (resolved through `products.organization_id`). */
  organizationId?: string;
  status?: OrderStatus;
  type?: OrderType;
  limit: number;
  offset: number;
}

export interface OrderPage {
  items: Order[];
  total: number;
}

/**
 * Multi-status listing for the admin error queue (D7 — spec 06 "error states
 * alert an admin and offer retry"). Ordered by `updated_at` DESC: a status
 * transition is the write that stamps `updated_at`, so the most recently
 * failed orders surface first.
 */
export interface OrderStatusListQuery {
  statuses: readonly OrderStatus[];
  limit: number;
  offset: number;
}

export interface OrderRepository {
  /**
   * Insert order + items + respondent sessions atomically; the DB sequence
   * supplies the ORD-xxxxx reference. Respondents are found-or-created by
   * email inside the same transaction.
   */
  insert(order: NewOrder, items: NewOrderItem[], sessions: NewOrderSession[]): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  findItems(orderId: string): Promise<OrderItem[]>;
  /** Sessions on the order with respondent identity, oldest first. */
  findSessions(orderId: string): Promise<OrderSessionSummary[]>;
  /**
   * Compare-and-set status update: applies the patch only while the row still
   * has `expectedStatus`. Returns null when the order is missing OR was
   * concurrently transitioned — the service reports a conflict either way.
   */
  updateStatus(id: string, expectedStatus: OrderStatus, patch: OrderStatusPatch): Promise<Order | null>;
  /**
   * Record the provider chosen at the payment step (D3) — not a status
   * change, so it bypasses the state-machine patch on purpose.
   */
  setPaymentProvider(id: string, provider: PaymentProvider | null): Promise<void>;
  list(query: OrderListQuery): Promise<OrderPage>;
  /** Orders in any of the given statuses, most recently updated first (error queue). */
  listByStatuses(query: OrderStatusListQuery): Promise<OrderPage>;
  /** Per-status order counts for the given statuses (absent = zero rows). */
  countByStatuses(
    statuses: readonly OrderStatus[]
  ): Promise<Partial<Record<OrderStatus, number>>>;
}

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

function toOrderEntity(row: OrderRow): Order {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type as OrderType,
    status: row.status as OrderStatus,
    clientId: row.clientId,
    productId: row.productId,
    questionnaireVersionId: row.questionnaireVersionId,
    reportTemplateVersionId: row.reportTemplateVersionId,
    reportLanguage: row.reportLanguage,
    reportModel: row.reportModel as OrderReportModel,
    currency: row.currency,
    subtotal: row.subtotal,
    discountTotal: row.discountTotal,
    total: row.total,
    paymentProvider: row.paymentProvider,
    entitlementId: row.entitlementId,
    notificationPolicy: (row.notificationPolicy as Record<string, unknown> | null) ?? null,
    suppressNotifications: row.suppressNotifications,
    expectedRespondents: row.expectedRespondents,
    pageSize: row.pageSize,
    isTest: row.isTest,
    relatedOrderId: row.relatedOrderId,
    placedByUserId: row.placedByUserId,
    placedVia: row.placedVia as OrderPlacedVia,
    errorDetail: (row.errorDetail as Record<string, unknown> | null) ?? null,
    source: row.source,
    legacyId: row.legacyId,
    approvedAt: row.approvedAt,
    sentAt: row.sentAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toItemEntity(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.orderId,
    lineNo: row.lineNo,
    description: row.description,
    unitPrice: row.unitPrice,
    discount: row.discount,
    quantity: row.quantity,
  };
}

export function createOrderRepository(db: Database): OrderRepository {
  return {
    async insert(order, items, sessions) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(orders)
          .values({
            id: order.id,
            // Generated inside the insert transaction, never client-side.
            reference: sql`'ORD-' || lpad(nextval('order_ref_seq')::text, 5, '0')`,
            type: order.type,
            status: order.status,
            clientId: order.clientId,
            productId: order.productId,
            questionnaireVersionId: order.questionnaireVersionId,
            reportTemplateVersionId: order.reportTemplateVersionId,
            reportLanguage: order.reportLanguage,
            reportModel: order.reportModel,
            currency: order.currency,
            subtotal: order.subtotal,
            discountTotal: order.discountTotal,
            total: order.total,
            paymentProvider: order.paymentProvider,
            entitlementId: order.entitlementId,
            notificationPolicy: order.notificationPolicy,
            suppressNotifications: order.suppressNotifications,
            expectedRespondents: order.expectedRespondents,
            pageSize: order.pageSize,
            isTest: order.isTest,
            relatedOrderId: order.relatedOrderId,
            placedByUserId: order.placedByUserId,
            placedVia: order.placedVia,
            errorDetail: order.errorDetail,
            source: order.source,
            legacyId: order.legacyId,
            approvedAt: order.approvedAt,
            sentAt: order.sentAt,
            completedAt: order.completedAt,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          })
          .returning();
        if (!row) throw new Error('Insert into orders returned no row');

        if (items.length > 0) {
          await tx.insert(orderItems).values(
            items.map((item) => ({
              id: item.id,
              orderId: row.id,
              lineNo: item.lineNo,
              description: item.description,
              unitPrice: item.unitPrice,
              discount: item.discount,
              quantity: item.quantity,
            }))
          );
        }

        // Sessions + respondents in the same transaction: find-or-create the
        // respondent by email (citext — case-insensitive dedupe anchor, spec
        // 04); a match refreshes name/language with the wizard's values.
        for (const session of sessions) {
          const existing = await tx
            .select({ id: respondents.id })
            .from(respondents)
            .where(eq(respondents.email, session.respondent.email))
            .limit(1);
          let respondentId = existing[0]?.id;
          if (respondentId) {
            await tx
              .update(respondents)
              .set({
                firstName: session.respondent.firstName,
                lastName: session.respondent.lastName,
                ...(session.respondent.language
                  ? { language: session.respondent.language }
                  : {}),
                updatedAt: session.createdAt,
              })
              .where(eq(respondents.id, respondentId));
          } else {
            respondentId = session.respondent.id;
            await tx.insert(respondents).values({
              id: respondentId,
              email: session.respondent.email,
              firstName: session.respondent.firstName,
              lastName: session.respondent.lastName,
              language: session.respondent.language,
              createdAt: session.createdAt,
              updatedAt: session.createdAt,
            });
          }

          await tx.insert(respondentSessions).values({
            id: session.id,
            orderId: row.id,
            respondentId,
            token: session.token,
            // PIN is generated + hashed at invitation dispatch (D5).
            pinHash: null,
            status: 'created',
            isFocal: true,
            questionnaireVersionId: session.questionnaireVersionId,
            language: session.language,
            createdAt: session.createdAt,
            updatedAt: session.createdAt,
          });
        }

        return toOrderEntity(row);
      });
    },

    async findById(id) {
      const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      const row = rows[0];
      return row ? toOrderEntity(row) : null;
    },

    async findItems(orderId) {
      const rows = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.lineNo));
      return rows.map(toItemEntity);
    },

    async findSessions(orderId) {
      const rows = await db
        .select({
          id: respondentSessions.id,
          orderId: respondentSessions.orderId,
          respondentId: respondentSessions.respondentId,
          status: respondentSessions.status,
          isFocal: respondentSessions.isFocal,
          language: respondentSessions.language,
          invitedAt: respondentSessions.invitedAt,
          startedAt: respondentSessions.startedAt,
          completedAt: respondentSessions.completedAt,
          reminderCount: respondentSessions.reminderCount,
          lastReminderAt: respondentSessions.lastReminderAt,
          remindersSuppressed: respondentSessions.remindersSuppressed,
          createdAt: respondentSessions.createdAt,
          respondentEmail: respondents.email,
          respondentFirstName: respondents.firstName,
          respondentLastName: respondents.lastName,
        })
        .from(respondentSessions)
        .leftJoin(respondents, eq(respondentSessions.respondentId, respondents.id))
        .where(eq(respondentSessions.orderId, orderId))
        .orderBy(asc(respondentSessions.createdAt), asc(respondentSessions.id));
      return rows.map(
        (row): OrderSessionSummary => ({
          id: row.id,
          orderId: row.orderId,
          respondentId: row.respondentId,
          status: row.status as RespondentSessionStatus,
          isFocal: row.isFocal,
          language: row.language,
          invitedAt: row.invitedAt,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          reminderCount: row.reminderCount,
          lastReminderAt: row.lastReminderAt,
          remindersSuppressed: row.remindersSuppressed,
          createdAt: row.createdAt,
          respondent:
            row.respondentId === null
              ? null
              : {
                  email: row.respondentEmail,
                  firstName: row.respondentFirstName,
                  lastName: row.respondentLastName,
                },
        })
      );
    },

    async updateStatus(id, expectedStatus, patch) {
      const set: Partial<typeof orders.$inferInsert> = {
        status: patch.status,
        errorDetail: patch.errorDetail,
        updatedAt: patch.updatedAt,
      };
      if (patch.approvedAt !== undefined) set.approvedAt = patch.approvedAt;
      if (patch.sentAt !== undefined) set.sentAt = patch.sentAt;
      if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;

      const rows = await db
        .update(orders)
        .set(set)
        .where(and(eq(orders.id, id), eq(orders.status, expectedStatus)))
        .returning();
      const row = rows[0];
      return row ? toOrderEntity(row) : null;
    },

    async setPaymentProvider(id, provider) {
      await db
        .update(orders)
        .set({ paymentProvider: provider, updatedAt: new Date() })
        .where(eq(orders.id, id));
    },

    async list(query) {
      const conditions: SQL[] = [];
      if (query.clientId) conditions.push(eq(orders.clientId, query.clientId));
      if (query.productId) conditions.push(eq(orders.productId, query.productId));
      if (query.organizationId) {
        // Org scope resolves through the product (orders carry product_id only).
        conditions.push(
          inArray(
            orders.productId,
            db
              .select({ id: products.id })
              .from(products)
              .where(eq(products.organizationId, query.organizationId))
          )
        );
      }
      if (query.status) conditions.push(eq(orders.status, query.status));
      if (query.type) conditions.push(eq(orders.type, query.type));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(orders)
          .where(where)
          .orderBy(desc(orders.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ count: sql<number>`count(*)::int` }).from(orders).where(where),
      ]);
      return { items: rows.map(toOrderEntity), total: countRows[0]?.count ?? 0 };
    },

    async listByStatuses(query) {
      if (query.statuses.length === 0) return { items: [], total: 0 };
      const where = inArray(orders.status, [...query.statuses]);
      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(orders)
          .where(where)
          .orderBy(desc(orders.updatedAt), desc(orders.id))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ count: sql<number>`count(*)::int` }).from(orders).where(where),
      ]);
      return { items: rows.map(toOrderEntity), total: countRows[0]?.count ?? 0 };
    },

    async countByStatuses(statuses) {
      if (statuses.length === 0) return {};
      const rows = await db
        .select({ status: orders.status, count: sql<number>`count(*)::int` })
        .from(orders)
        .where(inArray(orders.status, [...statuses]))
        .groupBy(orders.status);
      const counts: Partial<Record<OrderStatus, number>> = {};
      for (const row of rows) counts[row.status as OrderStatus] = row.count;
      return counts;
    },
  };
}
