# Webhooks

Inbound webhook routes. Flow per appendix-architecture-layers.md: API Route →
Adapter (parse/validate) → Service (handle).

- `sendgrid/` — SendGrid signed event webhook (spec 13): signature-verified
  (`SENDGRID_WEBHOOK_PUBLIC_KEY`), maps delivery/open/bounce events onto
  `notification_log` status via the notification service.

Stripe and scoring callbacks land with their respective epics.
