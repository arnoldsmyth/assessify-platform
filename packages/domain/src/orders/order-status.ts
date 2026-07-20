import { z } from 'zod';

/**
 * Order status + type vocabulary (docs/spec/06-orders-and-state-machine.md,
 * docs/spec/04-data-model.md enums — normative, do not reorder).
 */

export const orderStatuses = [
  'draft',
  'pending',
  'approved',
  'sent',
  'processing_report',
  'completed',
  'cancelled',
  'payment_error',
  'email_error',
  'on_hold',
  'refunded',
  'resend_email',
  'scoring_error',
] as const;

export const orderStatusSchema = z.enum(orderStatuses);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const orderTypes = [
  'named',
  'bulk_named',
  'multi_rater',
  'group',
  'retail',
  'batch_code',
] as const;

export const orderTypeSchema = z.enum(orderTypes);
export type OrderType = z.infer<typeof orderTypeSchema>;

/**
 * Terminal states: nothing ever leaves them (spec 06). `completed` is NOT
 * terminal — it can still move to `refunded`, `resend_email`, or `on_hold`.
 */
export const TERMINAL_ORDER_STATUSES = ['cancelled', 'refunded'] as const satisfies readonly OrderStatus[];

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

/** The three retryable error states (spec 06 "Error states"). */
export const ORDER_ERROR_STATUSES = [
  'payment_error',
  'email_error',
  'scoring_error',
] as const satisfies readonly OrderStatus[];

export function isOrderErrorStatus(status: OrderStatus): boolean {
  return (ORDER_ERROR_STATUSES as readonly OrderStatus[]).includes(status);
}

/**
 * States an admin may put on hold: "any non-terminal ──admin──▶ on_hold"
 * (spec 06) — every status except the terminal two and `on_hold` itself.
 */
export const HOLDABLE_ORDER_STATUSES = orderStatuses.filter(
  (status) => !isTerminalOrderStatus(status) && status !== 'on_hold'
) as readonly OrderStatus[];

export function isHoldableOrderStatus(status: OrderStatus): boolean {
  return HOLDABLE_ORDER_STATUSES.includes(status);
}
