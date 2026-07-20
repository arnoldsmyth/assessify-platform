/**
 * SendGrid Mailer provider (docs/spec/13-notifications-and-reminders.md).
 *
 * Talks straight to the SendGrid v3 REST API over fetch — no @sendgrid/mail
 * SDK dependency. Templated sends use SendGrid dynamic templates: the
 * message's `template` key is resolved to a template id via the injected
 * `templateIds` map (falling back to the key itself, so a `d-…` id can be
 * passed through directly). Sender identity is per-message (spec 11
 * white-label: product `branding.emailFrom` or the platform sender) — never
 * configured on the provider.
 *
 * Concrete provider — wired at composition roots only; services see the
 * Mailer interface (enforced by .dependency-cruiser.cjs).
 */
import { MailerError, type Mailer, type MailMessage, type MailSendResult } from '../types';

export const SENDGRID_API_BASE_URL = 'https://api.sendgrid.com';

export interface SendGridMailerOptions {
  /** SendGrid API key — from env at the composition root, never hardcoded. */
  apiKey: string;
  /** Template key → SendGrid dynamic template id (`d-…`). Missing keys pass through. */
  templateIds?: Record<string, string>;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests / regional endpoints. */
  baseUrl?: string;
}

interface SendGridPersonalization {
  to: { email: string }[];
  dynamic_template_data?: Record<string, unknown>;
}

interface SendGridRequestBody {
  personalizations: SendGridPersonalization[];
  from: { email: string; name: string };
  reply_to?: { email: string; name?: string };
  subject: string;
  template_id?: string;
  content?: { type: string; value: string }[];
  custom_args?: Record<string, string>;
}

/** Correlation ids echoed back on every webhook event. Ids only — no PII. */
function customArgs(message: MailMessage): Record<string, string> | undefined {
  const refs = message.refs;
  if (!refs) return undefined;
  const args: Record<string, string> = {};
  if (refs.notificationId) args['notification_id'] = refs.notificationId;
  if (refs.orderId) args['order_id'] = refs.orderId;
  if (refs.sessionId) args['session_id'] = refs.sessionId;
  if (refs.kind) args['kind'] = refs.kind;
  return Object.keys(args).length > 0 ? args : undefined;
}

function buildRequestBody(
  message: MailMessage,
  templateIds: Record<string, string>
): SendGridRequestBody {
  const personalization: SendGridPersonalization = { to: [{ email: message.to }] };
  const body: SendGridRequestBody = {
    personalizations: [personalization],
    from: { email: message.from.address, name: message.from.name },
    subject: message.subject,
  };
  if (message.replyTo) {
    body.reply_to = { email: message.replyTo.address, name: message.replyTo.name };
  }
  if ('template' in message.content && message.content.template !== undefined) {
    body.template_id = templateIds[message.content.template] ?? message.content.template;
    personalization.dynamic_template_data = message.content.data;
  } else {
    // SendGrid requires text/plain before text/html.
    const content: { type: string; value: string }[] = [];
    if (message.content.text !== undefined) {
      content.push({ type: 'text/plain', value: message.content.text });
    }
    content.push({ type: 'text/html', value: message.content.html as string });
    body.content = content;
  }
  const args = customArgs(message);
  if (args) body.custom_args = args;
  return body;
}

/** Extract provider error messages without echoing request values (no PII). */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && 'errors' in parsed) {
      const errors = (parsed as { errors: unknown }).errors;
      if (Array.isArray(errors)) {
        const messages = errors
          .map((e: unknown) =>
            e !== null && typeof e === 'object' && 'message' in e
              ? String((e as { message: unknown }).message)
              : ''
          )
          .filter((m) => m.length > 0);
        if (messages.length > 0) return messages.join('; ').slice(0, 500);
      }
    }
  } catch {
    // Non-JSON error body — fall through to the generic detail.
  }
  return 'no error detail';
}

export function createSendGridMailer(options: SendGridMailerOptions): Mailer {
  const { apiKey, templateIds = {}, fetchImpl = fetch, baseUrl = SENDGRID_API_BASE_URL } = options;

  return {
    async send(message: MailMessage): Promise<MailSendResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v3/mail/send`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(buildRequestBody(message, templateIds)),
        });
      } catch (cause) {
        throw new MailerError(
          `sendgrid request failed: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        // 4xx (except 408/429) can never succeed on retry; 5xx/429 are transient.
        const permanent =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429;
        throw new MailerError(
          `sendgrid rejected the send (${response.status}): ${detail}`,
          response.status,
          permanent
        );
      }

      // 202 Accepted; X-Message-Id is the prefix of every event's sg_message_id.
      return { providerMessageId: response.headers.get('x-message-id') ?? '' };
    },
  };
}
