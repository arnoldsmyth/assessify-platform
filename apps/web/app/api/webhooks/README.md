# Webhooks

Inbound webhook routes (Stripe, SendGrid, scoring callbacks) land with their
respective epics. Flow per appendix-architecture-layers.md: API Route → Adapter
(parse/validate) → Service (handle).
