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

// ---------------------------------------------------------------------------
// Completion notification policy (spec 13 — "Completion notification policy
// (resolved, not boolean)")
// ---------------------------------------------------------------------------

/**
 * Who a completion-time notification can address (spec 13): the client's
 * admin contact(s), the respondent themself, or named third parties (HR
 * contact, manager — their emails stored on the order's policy override).
 */
export const completionRecipientTypes = ['client', 'respondent', 'third_party'] as const;
export const completionRecipientTypeSchema = z.enum(completionRecipientTypes);
export type CompletionRecipientType = z.infer<typeof completionRecipientTypeSchema>;

/**
 * One recipient rule of the spec-13 policy object
 * `{ recipients: [{ type, emails?, includeReportLink }] }`.
 *
 * - `respondent`: addressed via the session's respondent record — `emails`
 *   is ignored for this type (the platform never mails a "respondent" at an
 *   address that isn't the session's own).
 * - `client`: explicit `emails` win; without them the client's billing email
 *   is the fallback contact (no dedicated client-contact column exists yet).
 * - `third_party`: `emails` is REQUIRED (there is nowhere else to look).
 * - `includeReportLink` defaults to false (opt in): only the respondent's own
 *   mail may ever carry the `/a/{token}/report` link — the token is the
 *   respondent's access credential (spec 05), so client/third-party notices
 *   never include it regardless of this flag.
 */
export const completionNotificationRecipientSchema = z
  .object({
    type: completionRecipientTypeSchema,
    emails: z.array(z.string().trim().email()).max(20).optional(),
    includeReportLink: z.boolean().default(false),
  })
  .strict()
  .superRefine((recipient, ctx) => {
    if (recipient.type === 'third_party' && (recipient.emails?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emails'],
        message: 'third_party recipients must name at least one email address',
      });
    }
  });
export type CompletionNotificationRecipient = z.infer<
  typeof completionNotificationRecipientSchema
>;

/** The resolved policy object (spec 13). An empty recipients list = silence. */
export const completionNotificationPolicySchema = z
  .object({
    recipients: z.array(completionNotificationRecipientSchema).max(20),
  })
  .strict();
export type CompletionNotificationPolicy = z.infer<typeof completionNotificationPolicySchema>;

/**
 * Platform default when no layer configures completion notifications: tell
 * the respondent their report is ready, with their own report link — the
 * core promise of completing an assessment — and send no client mail (a
 * client that wants completion notices configures them explicitly).
 */
export const DEFAULT_COMPLETION_NOTIFICATION_POLICY: CompletionNotificationPolicy = Object.freeze({
  recipients: [Object.freeze({ type: 'respondent' as const, includeReportLink: true })],
});

/** Which precedence layer supplied the resolved policy (audit snapshot). */
export type CompletionPolicySource = 'order' | 'client' | 'product' | 'default';

export interface ResolvedCompletionNotificationPolicy {
  policy: CompletionNotificationPolicy;
  source: CompletionPolicySource;
}

/**
 * Resolve the completion notification policy for one order (spec 13):
 *
 *   `orders.notification_policy.completion`
 *     → `clients.notification_overrides.completion`
 *       → `products.notification_defaults.completion`
 *         → {@link DEFAULT_COMPLETION_NOTIFICATION_POLICY}.
 *
 * Rides the existing jsonb columns under the `completion` key, mirroring the
 * `reportRelease` key convention (`resolveReportReleasePolicy`, spec 09). A
 * layer whose value fails validation is skipped — a malformed override can
 * only fall back, never break notification sends.
 */
export function resolveCompletionNotificationPolicy(
  orderPolicy: Record<string, unknown> | null,
  clientOverrides: Record<string, unknown> | null,
  productDefaults: Record<string, unknown> | null
): ResolvedCompletionNotificationPolicy {
  const layers: ReadonlyArray<
    readonly [Exclude<CompletionPolicySource, 'default'>, Record<string, unknown> | null]
  > = [
    ['order', orderPolicy],
    ['client', clientOverrides],
    ['product', productDefaults],
  ];
  for (const [source, config] of layers) {
    const parsed = completionNotificationPolicySchema.safeParse(config?.['completion']);
    if (parsed.success) return { policy: parsed.data, source };
  }
  return { policy: DEFAULT_COMPLETION_NOTIFICATION_POLICY, source: 'default' };
}

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
