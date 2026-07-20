import { z } from 'zod';

import { languageTagSchema, reportPageSizeSchema } from '../products/product';
import { orderEventSchema } from './state-machine';
import { orderStatusSchema, orderTypeSchema, type OrderStatus, type OrderType } from './order-status';

/**
 * Order aggregate: entities + service-input schemas
 * (docs/spec/04-data-model.md `orders`/`order_items`; docs/spec/06 pricing).
 * Assessment-agnostic — nothing product-specific lives here. All money is
 * integer minor units; all external identifiers are UUIDs (the human
 * reference `ORD-00042` is display/search only, never used in URLs).
 */

// ---------------------------------------------------------------------------
// Supporting schemas
// ---------------------------------------------------------------------------

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code, e.g. EUR');

export const reportModelSchema = z.enum(['individual', 'aggregate', 'both']);
export type OrderReportModel = z.infer<typeof reportModelSchema>;

export const orderPlacedViaSchema = z.enum(['admin', 'client', 'retail', 'api']);
export type OrderPlacedVia = z.infer<typeof orderPlacedViaSchema>;

// ---------------------------------------------------------------------------
// Create payload
// ---------------------------------------------------------------------------

/** One pricing line (spec 06: total = Σ quantity × unit_price − discount). */
export const orderItemInputSchema = z
  .object({
    description: z.string().trim().min(1, 'Required').max(500),
    /** Integer minor units (cents). */
    unitPrice: z.number().int().nonnegative(),
    /** Integer minor units, whole-line discount. Editable by super_admin only (enforced in service). */
    discount: z.number().int().nonnegative().default(0),
    quantity: z.number().int().min(1).default(1),
  })
  .strict()
  .refine((item) => item.discount <= item.unitPrice * item.quantity, {
    path: ['discount'],
    message: 'Discount cannot exceed quantity × unit price',
  });

export type OrderItemInput = z.input<typeof orderItemInputSchema>;

/**
 * Create-order payload. D1 supports the phase-1 models `named` and
 * `bulk_named`; the remaining types (multi_rater, group, retail, batch_code)
 * land with their own epics (G1–G4) and extend this schema then.
 */
export const createOrderSchema = z
  .object({
    type: z.enum(['named', 'bulk_named']),
    clientId: z.string().uuid(),
    productId: z.string().uuid(),
    /** Pinned at creation (spec 04). */
    questionnaireVersionId: z.string().uuid(),
    reportTemplateVersionId: z.string().uuid().nullable().default(null),
    reportLanguage: languageTagSchema.default('en'),
    reportModel: reportModelSchema.default('individual'),
    currency: currencyCodeSchema,
    items: z.array(orderItemInputSchema).min(1).max(200),
    /** Order-level notification override (spec 13). */
    notificationPolicy: z.record(z.unknown()).nullable().default(null),
    /** Legacy 'silent mode' (partner API). */
    suppressNotifications: z.boolean().default(false),
    /** Report page size override. */
    pageSize: reportPageSizeSchema.nullable().default(null),
    /** Excluded from all revenue/royalty/entitlement reporting (spec 06). */
    isTest: z.boolean().default(false),
    placedVia: orderPlacedViaSchema.default('admin'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const respondentCount = value.items.reduce((sum, item) => sum + item.quantity, 0);
    if (value.type === 'named' && respondentCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'A named order covers exactly one respondent (total quantity must be 1)',
      });
    }
  });

export type CreateOrderInput = z.input<typeof createOrderSchema>;
export type CreateOrder = z.output<typeof createOrderSchema>;

// ---------------------------------------------------------------------------
// Transition payload
// ---------------------------------------------------------------------------

export const transitionOrderSchema = z
  .object({
    event: orderEventSchema,
    /** Free-text reason recorded in the audit trail — never PII. */
    reason: z.string().trim().min(1).max(1000).optional(),
    /** Structured context for *_error states → `orders.error_detail`. */
    errorDetail: z.record(z.unknown()).optional(),
  })
  .strict();

export type TransitionOrderInput = z.input<typeof transitionOrderSchema>;
export type TransitionOrder = z.output<typeof transitionOrderSchema>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const listOrdersQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: orderStatusSchema.optional(),
  type: orderTypeSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export type ListOrdersQueryInput = z.input<typeof listOrdersQuerySchema>;
export type ListOrdersQuery = z.output<typeof listOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Order {
  id: string;
  /** `ORD-00042` — display/search only, generated by the DB sequence. */
  reference: string;
  type: OrderType;
  status: OrderStatus;
  clientId: string;
  productId: string;
  questionnaireVersionId: string;
  reportTemplateVersionId: string | null;
  reportLanguage: string;
  reportModel: OrderReportModel;
  currency: string;
  /** Integer minor units; snapshot at creation (spec 06 pricing). */
  subtotal: number;
  discountTotal: number;
  total: number;
  paymentProvider: 'stripe' | 'offline' | 'gocardless' | null;
  entitlementId: string | null;
  notificationPolicy: Record<string, unknown> | null;
  suppressNotifications: boolean;
  expectedRespondents: number | null;
  pageSize: string | null;
  isTest: boolean;
  relatedOrderId: string | null;
  placedByUserId: string | null;
  placedVia: OrderPlacedVia;
  /** Populated in *_error states; holds `previousStatus` while on_hold. */
  errorDetail: Record<string, unknown> | null;
  source: string;
  legacyId: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  id: string;
  orderId: string;
  lineNo: number;
  description: string;
  /** Integer minor units. */
  unitPrice: number;
  discount: number;
  quantity: number;
}

/** Key under which the held order's prior status lives in `error_detail`. */
export const HOLD_PREVIOUS_STATUS_KEY = 'previousStatus';

/** Pricing totals from validated line items (spec 06: fixed at creation). */
export function orderTotals(items: ReadonlyArray<{ unitPrice: number; discount: number; quantity: number }>): {
  subtotal: number;
  discountTotal: number;
  total: number;
} {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const discountTotal = items.reduce((sum, item) => sum + item.discount, 0);
  return { subtotal, discountTotal, total: subtotal - discountTotal };
}
