# 13 — Notifications & Reminders

## Mailer adapter

```ts
interface MailerAdapter {
  send(msg: { to: string; from: { name: string; address: string }; subject: string;
              template: string; data: Record<string, unknown>; language: string;
              refs: { orderId?: string; sessionId?: string; kind: NotificationKind } }): Promise<{ providerMessageId: string }>;
}
```

- Backend: **SendGrid** (dynamic templates or MJML-compiled local templates — decide in implementation; local MJML preferred so templates are in-repo and versioned). Adapter is swappable (Resend/Postmark) with zero service changes.
- Services decide *when*; the adapter only *how*. Every send goes through the worker (`notification.send` job) — no emails from request handlers — and writes `notification_log` first (`queued`), updated by the send and by SendGrid event webhooks (`/api/webhooks/sendgrid`: delivered/open/bounce → log status; signature-verified).
- Sender identity: product `branding.emailFrom` on respondent-facing mail; Assessify platform sender for admin/billing mail.
- All templates localised via `translation_strings` keys with default-language fallback; language = session language (respondent mail) or client locale (client mail).

## Notification kinds & templates

| kind | To | Trigger |
|---|---|---|
| `invitation` | respondent | order approved → sessions invited (contains link + PIN) |
| `reminder` | respondent | reminder engine (below) |
| `report_ready` | respondent | report released (if policy includes respondent) |
| `completion_notice` | client admin / named third parties | order → `completed`, per policy |
| `low_balance` | client admin + super admin | entitlement threshold crossing |
| `invoice` | client billing email | invoice issued |
| `error_alert` | super admins | order enters an error state; scoring watchdog |

## Completion notification policy (resolved, not boolean)

Policy object: `{ recipients: [{ type: 'client'|'respondent'|'third_party', emails?: string[], includeReportLink: boolean }] }`.
Resolution precedence: **order override → client override (`clients.notification_overrides`) → product default (`products.notification_defaults`)**. Resolved snapshot stored on the order at completion time (audit). Third-party emails (HR contact, manager) are stored on the order.

## Reminder engine

For sessions in status `invited`/`started` on orders in `sent`:
- Repeatable BullMQ job (hourly sweep, timezone-aware send window 08:00–18:00 recipient-local, falling back to product timezone): select sessions where `now − max(invited_at, last_reminder_at) ≥ 2 days`, `reminder_count < 15`, `reminders_suppressed = false`, and `now − invited_at ≤ 30 days`.
- Send reminder → increment `reminder_count`, set `last_reminder_at`, log. Stops automatically on completion, order cancel/refund/hold, 30 days elapsed, or suppression.
- Manual controls (client admin + super admin): send-now (ignores the 2-day spacing, still logged) and suppress/unsuppress per session.
- Group orders: reminders only to self-registered incomplete sessions (the platform can't remind people who never opened the shared link). Batch-code orders: no automatic reminders (platform doesn't know code recipients); client dashboard shows unredeemed counts instead.

## Delivery failure handling

SendGrid hard bounce → `notification_log` `bounced` → if it was an `invitation`, order → `email_error` + admin alert (bad address is an order-blocking problem). Soft failures retry via BullMQ backoff (3 attempts) before surfacing.
