import { z } from 'zod';

import {
  HOLDABLE_ORDER_STATUSES,
  isHoldableOrderStatus,
  type OrderStatus,
} from './order-status';

/**
 * The 13-state order machine as a declarative transition table
 * (docs/spec/06-orders-and-state-machine.md, "Normative transition table").
 * The order service rejects anything not listed here; every applied
 * transition writes an `audit_log` entry (spec 00 hard rule).
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const orderEvents = [
  /** Wizard/API submit: validation + entitlement reserve. */
  'submit',
  /** Payment succeeded / offline confirmed / entitlement drawn. */
  'payment_succeeded',
  'payment_failed',
  /** Admin retry / new payment method. */
  'retry_payment',
  /** Invitation dispatch succeeded (order is `sent` when ≥1 invite sent). */
  'invitations_sent',
  'invitation_failed',
  /** Admin retry after email_error. */
  'retry_email',
  /** Per-type completion rule met (spec 06 "Completion rule"). */
  'completion_rule_met',
  /** All expected reports `ready`. */
  'reports_ready',
  /** Scoring adapter failure/timeout. */
  'scoring_failed',
  /** Admin retry after scoring_error. */
  'retry_scoring',
  'cancel',
  /** Admin refund — only after the provider refund succeeds. */
  'refund',
  /** Admin resend trigger (transient state, auto-returns to completed). */
  'resend_email',
  /** Auto-return from the transient resend_email state. */
  'resend_completed',
  /** Admin hold (previous status stored in `error_detail`). */
  'hold',
  /** Admin release back to the held state's previous status. */
  'release',
] as const;

export const orderEventSchema = z.enum(orderEvents);
export type OrderEvent = z.infer<typeof orderEventSchema>;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * Who may trigger a transition (spec 05 permission matrix). The service maps
 * the CallerContext onto these tags — role scoping (client/product) is
 * checked there; this table only names the roles. `api_key` callers arrive
 * with the partner API epic (I1) and are not yet granted anything here.
 */
export const orderTransitionActors = [
  'system',
  'super_admin',
  'client_admin',
  'client_user',
] as const;

export type OrderTransitionActor = (typeof orderTransitionActors)[number];

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Sentinel target for `on_hold ──release──▶ (previous state)`: the concrete
 * target is the status stored when the hold was applied.
 */
export const PREVIOUS_STATUS = 'previous' as const;

export interface OrderTransitionRule {
  readonly from: OrderStatus;
  readonly event: OrderEvent;
  readonly to: OrderStatus | typeof PREVIOUS_STATUS;
  /** Actor tags allowed to trigger this transition. */
  readonly actors: readonly OrderTransitionActor[];
}

const SYSTEM_ONLY = ['system'] as const;
const ADMIN_ONLY = ['super_admin'] as const;

/**
 * The single source of truth. One row per legal (from, event) pair — the
 * spec's "any non-terminal → on_hold" row is expanded to concrete states.
 */
export const ORDER_TRANSITIONS: readonly OrderTransitionRule[] = [
  // Core happy path
  { from: 'draft', event: 'submit', to: 'pending', actors: ['super_admin', 'client_admin', 'client_user', 'system'] },
  // Offline confirmation is an admin action; card/entitlement is system (webhook/worker).
  { from: 'pending', event: 'payment_succeeded', to: 'approved', actors: ['system', 'super_admin'] },
  { from: 'approved', event: 'invitations_sent', to: 'sent', actors: SYSTEM_ONLY },
  // multi_rater/group orders can be force-closed by client admins (spec 06 completion rule).
  { from: 'sent', event: 'completion_rule_met', to: 'processing_report', actors: ['system', 'super_admin', 'client_admin'] },
  { from: 'processing_report', event: 'reports_ready', to: 'completed', actors: SYSTEM_ONLY },

  // Error states + admin retries (retry is super_admin only — spec 05 matrix)
  { from: 'pending', event: 'payment_failed', to: 'payment_error', actors: SYSTEM_ONLY },
  { from: 'payment_error', event: 'retry_payment', to: 'pending', actors: ADMIN_ONLY },
  { from: 'approved', event: 'invitation_failed', to: 'email_error', actors: SYSTEM_ONLY },
  // Spec 13 delivery-failure handling: a hard bounce on an invitation email
  // arrives AFTER dispatch moved the order to `sent` (order is `sent` when
  // ≥1 invite sent) — the bounce still drives the order to email_error ("bad
  // address is an order-blocking problem"). retry_email returns to approved;
  // re-dispatch skips already-invited sessions.
  { from: 'sent', event: 'invitation_failed', to: 'email_error', actors: SYSTEM_ONLY },
  { from: 'email_error', event: 'retry_email', to: 'approved', actors: ADMIN_ONLY },
  { from: 'processing_report', event: 'scoring_failed', to: 'scoring_error', actors: SYSTEM_ONLY },
  { from: 'scoring_error', event: 'retry_scoring', to: 'processing_report', actors: ADMIN_ONLY },

  // Admin cancel: draft|pending|approved|sent only
  { from: 'draft', event: 'cancel', to: 'cancelled', actors: ADMIN_ONLY },
  { from: 'pending', event: 'cancel', to: 'cancelled', actors: ADMIN_ONLY },
  { from: 'approved', event: 'cancel', to: 'cancelled', actors: ADMIN_ONLY },
  { from: 'sent', event: 'cancel', to: 'cancelled', actors: ADMIN_ONLY },

  // Post-completion admin actions
  { from: 'completed', event: 'refund', to: 'refunded', actors: ADMIN_ONLY },
  { from: 'completed', event: 'resend_email', to: 'resend_email', actors: ADMIN_ONLY },
  { from: 'resend_email', event: 'resend_completed', to: 'completed', actors: SYSTEM_ONLY },

  // Hold / release (any non-terminal → on_hold → previous)
  ...HOLDABLE_ORDER_STATUSES.map(
    (from): OrderTransitionRule => ({ from, event: 'hold', to: 'on_hold', actors: ADMIN_ONLY })
  ),
  { from: 'on_hold', event: 'release', to: PREVIOUS_STATUS, actors: ADMIN_ONLY },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findOrderTransition(
  from: OrderStatus,
  event: OrderEvent
): OrderTransitionRule | undefined {
  return ORDER_TRANSITIONS.find((rule) => rule.from === from && rule.event === event);
}

export function canTransitionOrder(from: OrderStatus, event: OrderEvent): boolean {
  return findOrderTransition(from, event) !== undefined;
}

/** Legal events out of a status — for admin UI affordances and error detail. */
export function orderEventsFrom(from: OrderStatus): OrderEvent[] {
  return ORDER_TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.event);
}

/**
 * Resolve the concrete target status for a rule. For `release`, the caller
 * must supply the status recorded at hold time; returns null when it is
 * missing or not a state that could legally have been held.
 */
export function resolveOrderTransitionTarget(
  rule: OrderTransitionRule,
  previousStatus?: OrderStatus | null
): OrderStatus | null {
  if (rule.to !== PREVIOUS_STATUS) return rule.to;
  if (!previousStatus || !isHoldableOrderStatus(previousStatus)) return null;
  return previousStatus;
}
