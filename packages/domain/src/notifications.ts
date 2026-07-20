import { z } from 'zod';

/**
 * Notification contracts (docs/spec/13-notifications-and-reminders.md).
 *
 * One schema per shape, shared by every consumer: the notification service
 * validates requests with `notificationRequestSchema`, the `notifications.send`
 * job payload embeds it (jobs.ts), and the notification-log repository maps
 * rows to `NotificationLogEntry`. Nothing assessment-specific lives here —
 * sender identity is injected per call from product config (spec 11
 * `branding.emailFrom`) or the platform sender.
 */

/** Notification kinds from the spec 13 table. Wire-visible in `notification_log.kind`. */
export const notificationKinds = [
  'invitation',
  'reminder',
  'report_ready',
  'completion_notice',
  'low_balance',
  'invoice',
  'error_alert',
] as const;

export const notificationKindSchema = z.enum(notificationKinds);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * Lifecycle of a `notification_log` row: `queued` on creation, `sent`/`failed`
 * by the worker send, `delivered`/`opened`/`bounced` by provider event
 * webhooks (spec 13 "Delivery failure handling").
 */
export const notificationStatuses = [
  'queued',
  'sent',
  'delivered',
  'opened',
  'bounced',
  'failed',
] as const;

export const notificationStatusSchema = z.enum(notificationStatuses);

export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/** Sender identity — spec 11: product `branding.emailFrom` or the platform sender. */
export const emailSenderSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().email(),
  })
  .strict();

export type EmailSender = z.infer<typeof emailSenderSchema>;

/**
 * A request to send one notification. The caller (order/reminder/billing
 * services) resolves *who* and *with which sender identity*; the notification
 * service only logs and dispatches.
 */
export const notificationRequestSchema = z
  .object({
    kind: notificationKindSchema,
    /** Recipient email address. PII — never log it. */
    to: z.string().trim().email(),
    subject: z.string().trim().min(1).max(500),
    /** Template key (resolved to a provider template id by the mailer provider). */
    template: z.string().trim().min(1).max(200),
    /** Template data. Keep values renderable JSON — no functions, no secrets. */
    data: z.record(z.unknown()).default({}),
    /** BCP-47 language tag (session language or client locale, spec 13). */
    language: z.string().trim().min(2).max(35).default('en'),
    /** Sender identity, injected per call (per-product white-label, spec 11). */
    sender: z
      .object({
        from: emailSenderSchema,
        replyTo: emailSenderSchema.optional(),
      })
      .strict(),
    /** Traceability references stored on the notification_log row. */
    refs: z
      .object({
        orderId: z.string().uuid().optional(),
        sessionId: z.string().uuid().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type NotificationRequest = z.infer<typeof notificationRequestSchema>;
export type NotificationRequestInput = z.input<typeof notificationRequestSchema>;

/** One `notification_log` row mapped to the domain (spec 04 data model). */
export const notificationLogEntrySchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  kind: notificationKindSchema,
  /** Recipient email. Purged on GDPR erasure for the respondent (spec 04). */
  recipient: z.string(),
  template: z.string(),
  language: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  status: notificationStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NotificationLogEntry = z.infer<typeof notificationLogEntrySchema>;
