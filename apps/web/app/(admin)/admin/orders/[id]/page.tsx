import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import {
  ORDER_TRANSITIONS,
  type AuditEvent,
  type OrderStatus,
} from '@assessify/domain';
import {
  getClientDirectoryService,
  getOrderService,
  getProductService,
} from '@assessify/services';
import { Card, CardContent, CardHeader, CardTitle } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { transitionOrderAction } from '../actions';
import { formatMinor } from '../_lib/form';
import { OrderStatusBadge, SessionStatusBadge } from '../_components/status-badge';
import { TransitionPanel, type TransitionButton } from '../_components/transition-panel';
import { dispatchInvitationsAction, resendInvitationAction } from './invitation-actions';
import { DispatchInvitationsPanel, ResendInvitationButton } from './invitation-controls';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Manual (non-system) event affordances per state. The domain transition
 * table decides WHICH of these are offered; the service enforces actors —
 * an unauthorized click surfaces its typed error in the panel.
 */
const EVENT_BUTTONS: Record<string, Omit<TransitionButton, 'event'>> = {
  submit: { label: 'Submit for payment' },
  payment_succeeded: {
    label: 'Confirm offline payment',
    confirm:
      'Confirm this order as paid (offline invoice)? It moves to approved and invitations can be dispatched.',
  },
  retry_payment: { label: 'Retry payment' },
  retry_email: { label: 'Retry invitations' },
  retry_scoring: { label: 'Retry scoring' },
  completion_rule_met: {
    label: 'Force close responses',
    confirm:
      'Force the completion rule? Outstanding sessions will no longer count and report processing starts.',
  },
  resend_email: { label: 'Resend report email' },
  hold: { label: 'Put on hold' },
  release: { label: 'Release hold' },
  cancel: {
    label: 'Cancel order',
    destructive: true,
    confirm: 'Cancel this order? This is a terminal state.',
  },
  refund: {
    label: 'Mark refunded',
    destructive: true,
    confirm: 'Mark as refunded? Only do this after the provider refund succeeded.',
  },
};

function manualEventButtons(status: OrderStatus): TransitionButton[] {
  const buttons: TransitionButton[] = [];
  for (const rule of ORDER_TRANSITIONS) {
    if (rule.from !== status || !rule.actors.some((actor) => actor !== 'system')) continue;
    const button = EVENT_BUTTONS[rule.event];
    if (button) buttons.push({ event: rule.event, ...button });
  }
  return buttons;
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();

  const result = await getOrderService().get(caller, id);
  if (!result.ok) {
    if (result.error.code === 'order/not_found') notFound();
    throw new Error(result.error.message);
  }
  const { order, items, sessions } = result.value;

  // Decoration: names are best-effort — scoped callers may not see the client
  // list or the (possibly retired) product; fall back to shortened ids.
  const [historyResult, clientsResult, productsResult] = await Promise.all([
    getOrderService().history(caller, id),
    getClientDirectoryService().listVisible(caller),
    getProductService().listOrderable(caller),
  ]);
  const clientName = clientsResult.ok
    ? (clientsResult.value.find((client) => client.id === order.clientId)?.name ??
      `${order.clientId.slice(0, 8)}…`)
    : `${order.clientId.slice(0, 8)}…`;
  const productName = productsResult.ok
    ? (productsResult.value.find((product) => product.id === order.productId)?.name ??
      `${order.productId.slice(0, 8)}…`)
    : `${order.productId.slice(0, 8)}…`;

  const transitionAction = transitionOrderAction.bind(null, order.id);
  const dispatchAction = dispatchInvitationsAction.bind(null, order.id);
  const resendAction = resendInvitationAction.bind(null, order.id);
  // D5 affordances: dispatch while approved; per-session resend once
  // invitations exist (spec 05: same token, regenerated PIN).
  const canDispatchInvitations = order.status === 'approved';
  const canResendInvitations =
    !order.suppressNotifications &&
    (order.status === 'approved' || order.status === 'sent' || order.status === 'email_error');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/orders"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Orders
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold text-ink">{order.reference}</h1>
          <OrderStatusBadge status={order.status} />
          {order.isTest ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium uppercase text-muted">
              Test order
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted">
          {clientName} · {productName} · {order.type.replace('_', ' ')}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Respondents</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {sessions.length === 0 ? (
                <p className="px-6 pb-4 text-sm text-muted">No respondent sessions.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                      <th className="px-6 py-2">Name</th>
                      <th className="px-4 py-2">Email</th>
                      <th className="px-4 py-2">Language</th>
                      <th className="px-4 py-2">Session</th>
                      <th className="px-4 py-2">Invited</th>
                      <th className="px-4 py-2">Completed</th>
                      {canResendInvitations ? <th className="px-4 py-2">Invitation</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => (
                      <tr key={session.id} className="border-b border-border last:border-0">
                        <td className="px-6 py-2 text-ink">
                          {session.respondent &&
                          (session.respondent.firstName || session.respondent.lastName)
                            ? `${session.respondent.firstName ?? ''} ${session.respondent.lastName ?? ''}`.trim()
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-body">
                          {session.respondent?.email ?? '—'}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-body">
                          {session.language ?? '—'}
                        </td>
                        <td className="px-4 py-2">
                          <SessionStatusBadge status={session.status} />
                        </td>
                        <td className="px-4 py-2 text-muted">
                          {session.invitedAt ? session.invitedAt.toISOString().slice(0, 10) : '—'}
                        </td>
                        <td className="px-4 py-2 text-muted">
                          {session.completedAt
                            ? session.completedAt.toISOString().slice(0, 10)
                            : '—'}
                        </td>
                        {canResendInvitations ? (
                          <td className="px-4 py-2">
                            {session.status === 'invited' || session.status === 'started' ? (
                              <ResendInvitationButton
                                action={resendAction}
                                sessionId={session.id}
                              />
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pricing</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                    <th className="px-6 py-2">#</th>
                    <th className="px-4 py-2">Description</th>
                    <th className="px-4 py-2 text-right">Qty</th>
                    <th className="px-4 py-2 text-right">Unit price</th>
                    <th className="px-4 py-2 text-right">Discount</th>
                    <th className="px-4 py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-border last:border-0">
                      <td className="px-6 py-2 text-muted">{item.lineNo}</td>
                      <td className="px-4 py-2 text-body">{item.description}</td>
                      <td className="px-4 py-2 text-right text-body">{item.quantity}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-body">
                        {formatMinor(item.unitPrice, order.currency)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-body">
                        {item.discount > 0 ? `-${formatMinor(item.discount, order.currency)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-ink">
                        {formatMinor(
                          item.quantity * item.unitPrice - item.discount,
                          order.currency
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={5} className="px-4 py-2 text-right font-medium text-ink">
                      Total
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-ink">
                      {formatMinor(order.total, order.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">History</CardTitle>
            </CardHeader>
            <CardContent>
              {historyResult.ok ? (
                <HistoryList events={historyResult.value.items} />
              ) : (
                <p className="text-sm text-muted">
                  History is unavailable right now — current state only.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Actions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {canDispatchInvitations ? (
                // Suppressed (silent-mode) orders still dispatch — sessions are
                // marked invited without email; the partner delivers access.
                <DispatchInvitationsPanel action={dispatchAction} />
              ) : null}
              <TransitionPanel
                events={manualEventButtons(order.status)}
                action={transitionAction}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                <dt className="text-muted">Currency</dt>
                <dd className="font-mono text-xs text-body">{order.currency}</dd>
                <dt className="text-muted">Report language</dt>
                <dd className="font-mono text-xs text-body">{order.reportLanguage}</dd>
                <dt className="text-muted">Placed via</dt>
                <dd className="text-body">{order.placedVia}</dd>
                <dt className="text-muted">Created</dt>
                <dd className="text-body">
                  {order.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                </dd>
                <dt className="text-muted">Approved</dt>
                <dd className="text-body">
                  {order.approvedAt
                    ? order.approvedAt.toISOString().slice(0, 16).replace('T', ' ')
                    : '—'}
                </dd>
                <dt className="text-muted">Sent</dt>
                <dd className="text-body">
                  {order.sentAt ? order.sentAt.toISOString().slice(0, 16).replace('T', ' ') : '—'}
                </dd>
                <dt className="text-muted">Completed</dt>
                <dd className="text-body">
                  {order.completedAt
                    ? order.completedAt.toISOString().slice(0, 16).replace('T', ' ')
                    : '—'}
                </dd>
              </dl>
              {order.errorDetail ? (
                <div className="mt-3 rounded-md border border-border bg-surface-page p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    State detail
                  </p>
                  <pre className="mt-1 overflow-x-auto font-mono text-xs text-body">
                    {JSON.stringify(order.errorDetail, null, 2)}
                  </pre>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function HistoryList({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">No recorded events yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
          <span className="text-sm font-medium text-ink">{describeAuditEvent(event)}</span>
          <span className="text-xs text-muted">
            {event.createdAt.toISOString().slice(0, 16).replace('T', ' ')} ·{' '}
            {event.actor.kind === 'system'
              ? 'system'
              : `${event.actor.kind} ${event.actor.id ? `${event.actor.id.slice(0, 8)}…` : ''}`}
          </span>
          {typeof event.detail?.reason === 'string' ? (
            <span className="text-xs text-body">Reason: {event.detail.reason}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function describeAuditEvent(event: AuditEvent): string {
  if (event.action === 'order.created') return 'Order created (draft)';
  if (event.action === 'order.status_changed') {
    const from = typeof event.detail?.from === 'string' ? event.detail.from : '?';
    const to = typeof event.detail?.to === 'string' ? event.detail.to : '?';
    const trigger = typeof event.detail?.event === 'string' ? ` (${event.detail.event})` : '';
    return `${from} → ${to}${trigger}`;
  }
  return event.action;
}
