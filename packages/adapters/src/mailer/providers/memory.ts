import { MailerError, type Mailer, type MailMessage, type MailSendResult } from '../types';

/**
 * In-memory Mailer provider for tests and local development: records every
 * message instead of sending, returns deterministic provider message ids
 * (`mem-1`, `mem-2`, …), and can be told to fail to exercise error paths.
 * This is the reference implementation of the Mailer contract — the adapter
 * contract test runs against it.
 */
export interface MemoryMailer extends Mailer {
  /** Every message passed to send(), in order. */
  readonly sent: readonly MailMessage[];
  /** Make subsequent send() calls reject with the given error (null to reset). */
  failWith(error: MailerError | null): void;
  /** Forget recorded messages and reset the id counter. */
  reset(): void;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: MailMessage[] = [];
  let failure: MailerError | null = null;
  let counter = 0;

  return {
    sent,
    failWith(error) {
      failure = error;
    },
    reset() {
      sent.length = 0;
      failure = null;
      counter = 0;
    },
    async send(message: MailMessage): Promise<MailSendResult> {
      if (failure) throw failure;
      sent.push(message);
      counter += 1;
      return { providerMessageId: `mem-${counter}` };
    },
  };
}
