import { orderItems, orders, type Database } from '@assessify/db';
import type {
  Order,
  OrderItem,
  OrderPlacedVia,
  OrderReportModel,
  OrderStatus,
  OrderType,
  PaymentProvider,
} from '@assessify/domain';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';

/**
 * Data access for `orders` + `order_items` (spec 04). Pure persistence — no
 * business rules, no transition validation (that is the order service's job).
 * Rows are mapped to domain entities; drizzle rows never leave this layer.
 * Infrastructure failures throw; the service layer converts them to Results.
 */

/** Insert payload: the repository generates `reference` from `order_ref_seq` inside the transaction (spec 04 identifier conventions). */
export type NewOrder = Omit<Order, 'reference'>;

export type NewOrderItem = Omit<OrderItem, 'orderId'>;

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
  status?: OrderStatus;
  type?: OrderType;
  limit: number;
  offset: number;
}

export interface OrderPage {
  items: Order[];
  total: number;
}

export interface OrderRepository {
  /** Insert order + items atomically; the DB sequence supplies the ORD-xxxxx reference. */
  insert(order: NewOrder, items: NewOrderItem[]): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  findItems(orderId: string): Promise<OrderItem[]>;
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
    async insert(order, items) {
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
  };
}
