/**
 * Mailer adapter contract (docs/spec/13-notifications-and-reminders.md,
 * appendix-architecture-layers.md §4).
 *
 * The adapter only knows *how* to send — services decide *when* (and write
 * `notification_log` before dispatch). Providers (SendGrid, console, memory)
 * live in ./providers/ and are wired at composition roots; services import
 * these types only (enforced by .dependency-cruiser.cjs).
 */
import type { NotificationKind } from '@assessify/domain';

/** Sender identity, injected per call (product `branding.emailFrom` or the platform sender). */
export interface MailSender {
  name: string;
  address: string;
}

/**
 * Message body: a provider-side template plus data (all notification mail,
 * spec 13), or pre-rendered content for non-notification transactional mail
 * (e.g. auth magic links).
 */
export type MailContent =
  | { template: string; data: Record<string, unknown>; html?: undefined; text?: undefined }
  | { html: string; text?: string; template?: undefined; data?: undefined };

/**
 * Correlation ids attached to the outbound message (provider custom args) so
 * delivery events can be matched back to `notification_log`. Ids only —
 * never PII.
 */
export interface MailRefs {
  notificationId?: string;
  orderId?: string;
  sessionId?: string;
  kind?: NotificationKind;
}

export interface MailMessage {
  to: string;
  from: MailSender;
  replyTo?: MailSender;
  subject: string;
  content: MailContent;
  /** BCP-47 tag; used for template localisation. */
  language?: string;
  refs?: MailRefs;
}

export interface MailSendResult {
  /**
   * Provider-assigned message id for webhook correlation. Empty string when
   * the provider did not return one (the send still succeeded).
   */
  providerMessageId: string;
}

export interface Mailer {
  /** Dispatch one message. Rejects with {@link MailerError} on failure. */
  send(message: MailMessage): Promise<MailSendResult>;
}

/** Thrown by Mailer providers when a send fails. Message must never contain PII. */
export class MailerError extends Error {
  constructor(
    message: string,
    /** HTTP status returned by the provider, if any. */
    readonly status?: number,
    /** True when retrying can never succeed (rejected payload, auth failure). */
    readonly permanent: boolean = false
  ) {
    super(message);
    this.name = 'MailerError';
  }
}

/**
 * Normalised delivery event from the provider's event webhook. Produced by a
 * provider parser (e.g. providers/sendgrid-webhook.ts), consumed by the
 * notification service to advance `notification_log.status`.
 */
export type MailEventType =
  | 'processed'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'dropped'
  | 'deferred'
  | 'spam_report'
  | 'unsubscribed';

export interface MailProviderEvent {
  type: MailEventType;
  /** Normalised provider message id (matches {@link MailSendResult}), if present. */
  providerMessageId: string | null;
  /** `notification_log.id` echoed back via custom args, if present. */
  notificationId: string | null;
  occurredAt: Date | null;
}
