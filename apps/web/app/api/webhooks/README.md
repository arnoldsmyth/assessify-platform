# Webhooks

Inbound webhook routes. Flow per appendix-architecture-layers.md: API Route →
Adapter (parse/validate) → Service (handle).

- `sendgrid/` — SendGrid signed event webhook (spec 13): signature-verified
  (`SENDGRID_WEBHOOK_PUBLIC_KEY`), maps delivery/open/bounce events onto
  `notification_log` status via the notification service.
- `stripe/` — Stripe payment webhook (spec 06): signature-verified
  (`STRIPE_WEBHOOK_SECRET`), translates payment events for the payment
  service.
- `prologic/` — Pro-Logic `scored` webhook (E2): raw-body HMAC-SHA256
  verified (`PROLOGIC_WEBHOOK_SECRET`), resolves the scoring job by the
  engine's assessment id and replays through the idempotent `applyScores`
  (redundant confirmation of the synchronous score call).
