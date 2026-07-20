import type { OrderStatus, RespondentSessionStatus } from '@assessify/domain';
import { cn } from '@assessify/ui';

/**
 * Badges for the 13 order states (spec 06) and session states (spec 04),
 * using the Ember status colours (spec 15: teal = success, amber = warning /
 * on_hold / pending, red = error states).
 */

const NEUTRAL = 'border border-border bg-surface text-muted';
const INFO = 'bg-primary-tint text-primary-tint-ink';
const SUCCESS = 'bg-teal-tint text-teal';
const WARNING = 'bg-amber-tint text-amber';
const ERROR = 'bg-red-tint text-red';

export const ORDER_STATUS_BADGES: Record<OrderStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: NEUTRAL },
  pending: { label: 'Pending', className: WARNING },
  approved: { label: 'Approved', className: INFO },
  sent: { label: 'Sent', className: INFO },
  processing_report: { label: 'Processing report', className: INFO },
  completed: { label: 'Completed', className: SUCCESS },
  cancelled: { label: 'Cancelled', className: NEUTRAL },
  payment_error: { label: 'Payment error', className: ERROR },
  email_error: { label: 'Email error', className: ERROR },
  on_hold: { label: 'On hold', className: WARNING },
  refunded: { label: 'Refunded', className: NEUTRAL },
  resend_email: { label: 'Resending email', className: INFO },
  scoring_error: { label: 'Scoring error', className: ERROR },
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const badge = ORDER_STATUS_BADGES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        badge.className
      )}
    >
      {badge.label}
    </span>
  );
}

const SESSION_STATUS_BADGES: Record<
  RespondentSessionStatus,
  { label: string; className: string }
> = {
  created: { label: 'Created', className: NEUTRAL },
  invited: { label: 'Invited', className: INFO },
  started: { label: 'Started', className: INFO },
  completed: { label: 'Completed', className: SUCCESS },
  awaiting_scores: { label: 'Awaiting scores', className: WARNING },
  scored: { label: 'Scored', className: SUCCESS },
  report_ready: { label: 'Report ready', className: SUCCESS },
};

export function SessionStatusBadge({ status }: { status: RespondentSessionStatus }) {
  const badge = SESSION_STATUS_BADGES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        badge.className
      )}
    >
      {badge.label}
    </span>
  );
}
