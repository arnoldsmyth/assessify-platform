import {
  ORDER_TRANSITIONS,
  PREVIOUS_STATUS,
  canTransitionOrder,
  findOrderTransition,
  isHoldableOrderStatus,
  isOrderErrorStatus,
  isTerminalOrderStatus,
  orderEvents,
  orderEventsFrom,
  orderStatuses,
  resolveOrderTransitionTarget,
  type OrderEvent,
  type OrderStatus,
} from '@assessify/domain';
import { describe, expect, it } from 'vitest';

/**
 * Exhaustive state-machine tests (spec 00 hard rule: "state machine
 * transitions get exhaustive tests"). The expected table below is
 * re-declared literally from docs/spec/06-orders-and-state-machine.md,
 * independent of the domain's table, so a typo there cannot self-validate.
 * Every one of the 13 × 17 (state, event) pairs is checked.
 */

type Expected = { from: OrderStatus; event: OrderEvent; to: OrderStatus | typeof PREVIOUS_STATUS };

const HOLDABLE: OrderStatus[] = [
  'draft',
  'pending',
  'approved',
  'sent',
  'processing_report',
  'completed',
  'payment_error',
  'email_error',
  'resend_email',
  'scoring_error',
];

const EXPECTED_LEGAL: Expected[] = [
  { from: 'draft', event: 'submit', to: 'pending' },
  { from: 'pending', event: 'payment_succeeded', to: 'approved' },
  { from: 'pending', event: 'payment_failed', to: 'payment_error' },
  { from: 'payment_error', event: 'retry_payment', to: 'pending' },
  { from: 'approved', event: 'invitations_sent', to: 'sent' },
  { from: 'approved', event: 'invitation_failed', to: 'email_error' },
  // Spec 13 delivery-failure handling: an invitation hard bounce lands after
  // dispatch already moved the order to `sent` — it still forces email_error.
  { from: 'sent', event: 'invitation_failed', to: 'email_error' },
  { from: 'email_error', event: 'retry_email', to: 'approved' },
  { from: 'sent', event: 'completion_rule_met', to: 'processing_report' },
  { from: 'processing_report', event: 'reports_ready', to: 'completed' },
  { from: 'processing_report', event: 'scoring_failed', to: 'scoring_error' },
  { from: 'scoring_error', event: 'retry_scoring', to: 'processing_report' },
  { from: 'draft', event: 'cancel', to: 'cancelled' },
  { from: 'pending', event: 'cancel', to: 'cancelled' },
  { from: 'approved', event: 'cancel', to: 'cancelled' },
  { from: 'sent', event: 'cancel', to: 'cancelled' },
  { from: 'completed', event: 'refund', to: 'refunded' },
  { from: 'completed', event: 'resend_email', to: 'resend_email' },
  { from: 'resend_email', event: 'resend_completed', to: 'completed' },
  ...HOLDABLE.map((from): Expected => ({ from, event: 'hold', to: 'on_hold' })),
  { from: 'on_hold', event: 'release', to: PREVIOUS_STATUS },
];

function expectedFor(from: OrderStatus, event: OrderEvent): Expected | undefined {
  return EXPECTED_LEGAL.find((t) => t.from === from && t.event === event);
}

describe('order transition table (spec 06, normative)', () => {
  it('has exactly the 30 legal (from, event) pairs and no duplicates', () => {
    expect(EXPECTED_LEGAL).toHaveLength(30);
    expect(ORDER_TRANSITIONS).toHaveLength(30);
    const keys = ORDER_TRANSITIONS.map((rule) => `${rule.from}→${rule.event}`);
    expect(new Set(keys).size).toBe(30);
  });

  it.each(EXPECTED_LEGAL)('allows $from ──$event──▶ $to', ({ from, event, to }) => {
    const rule = findOrderTransition(from, event);
    expect(rule).toBeDefined();
    expect(rule?.to).toBe(to);
    expect(canTransitionOrder(from, event)).toBe(true);
  });

  // Exhaustive sweep: for every state, every one of the 17 events either
  // matches the expected table or is rejected. 13 × 17 = 221 pairs total.
  describe.each(orderStatuses.map((s) => [s] as const))('from %s', (from) => {
    it.each(orderEvents.map((e) => [e] as const))('event %s matches the spec table', (event) => {
      const expected = expectedFor(from, event);
      const rule = findOrderTransition(from, event);
      if (expected) {
        expect(rule?.to).toBe(expected.to);
      } else {
        expect(rule).toBeUndefined();
        expect(canTransitionOrder(from, event)).toBe(false);
      }
    });
  });

  it('terminal states (cancelled, refunded) have no outgoing transitions', () => {
    for (const status of ['cancelled', 'refunded'] as const) {
      expect(isTerminalOrderStatus(status)).toBe(true);
      expect(orderEventsFrom(status)).toEqual([]);
    }
  });

  it('classifies statuses (13 total, 3 error, 10 holdable)', () => {
    expect(orderStatuses).toHaveLength(13);
    expect(orderStatuses.filter(isOrderErrorStatus)).toEqual([
      'payment_error',
      'email_error',
      'scoring_error',
    ]);
    expect(orderStatuses.filter(isHoldableOrderStatus).sort()).toEqual([...HOLDABLE].sort());
    expect(isHoldableOrderStatus('on_hold')).toBe(false);
    expect(isHoldableOrderStatus('cancelled')).toBe(false);
    expect(isHoldableOrderStatus('refunded')).toBe(false);
  });

  it('orderEventsFrom lists every legal event for a status', () => {
    expect(orderEventsFrom('draft').sort()).toEqual(['cancel', 'hold', 'submit']);
    expect(orderEventsFrom('completed').sort()).toEqual(['hold', 'refund', 'resend_email']);
    expect(orderEventsFrom('on_hold')).toEqual(['release']);
  });
});

describe('actor requirements (spec 05 permission matrix)', () => {
  it('error-state retries are super_admin only', () => {
    for (const [from, event] of [
      ['payment_error', 'retry_payment'],
      ['email_error', 'retry_email'],
      ['scoring_error', 'retry_scoring'],
    ] as const) {
      expect(findOrderTransition(from, event)?.actors).toEqual(['super_admin']);
    }
  });

  it('automatic transitions are system only', () => {
    for (const [from, event] of [
      ['pending', 'payment_failed'],
      ['approved', 'invitations_sent'],
      ['approved', 'invitation_failed'],
      ['processing_report', 'reports_ready'],
      ['processing_report', 'scoring_failed'],
      ['resend_email', 'resend_completed'],
    ] as const) {
      expect(findOrderTransition(from, event)?.actors).toEqual(['system']);
    }
  });

  it('submit is open to order-placing roles and system', () => {
    expect(findOrderTransition('draft', 'submit')?.actors).toEqual([
      'super_admin',
      'client_admin',
      'client_user',
      'system',
    ]);
  });

  it('hold, release, cancel, refund and resend trigger are super_admin only', () => {
    for (const rule of ORDER_TRANSITIONS) {
      if (['hold', 'release', 'cancel', 'refund', 'resend_email'].includes(rule.event)) {
        expect(rule.actors).toEqual(['super_admin']);
      }
    }
  });

  it('client_admin may force completion (multi_rater/group early close)', () => {
    expect(findOrderTransition('sent', 'completion_rule_met')?.actors).toContain('client_admin');
  });
});

describe('resolveOrderTransitionTarget', () => {
  const release = findOrderTransition('on_hold', 'release');
  if (!release) throw new Error('release rule missing');

  it('returns the recorded previous status for release', () => {
    for (const previous of HOLDABLE) {
      expect(resolveOrderTransitionTarget(release, previous)).toBe(previous);
    }
  });

  it('rejects release without a valid held status', () => {
    expect(resolveOrderTransitionTarget(release, null)).toBeNull();
    expect(resolveOrderTransitionTarget(release, undefined)).toBeNull();
    expect(resolveOrderTransitionTarget(release, 'on_hold')).toBeNull();
    expect(resolveOrderTransitionTarget(release, 'cancelled')).toBeNull();
    expect(resolveOrderTransitionTarget(release, 'refunded')).toBeNull();
  });

  it('ignores previousStatus for concrete-target rules', () => {
    const submit = findOrderTransition('draft', 'submit');
    if (!submit) throw new Error('submit rule missing');
    expect(resolveOrderTransitionTarget(submit, 'cancelled')).toBe('pending');
    expect(resolveOrderTransitionTarget(submit)).toBe('pending');
  });
});
