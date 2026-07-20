import type { Mailer, MailMessage } from '../types';

/**
 * Dev/fallback Mailer provider: writes the email to stdout instead of
 * sending. Wired at composition roots when SENDGRID_API_KEY is not set;
 * never used in production (it prints recipient addresses, which the
 * production no-PII-in-logs rule forbids).
 */
export function createConsoleMailer(
  log: (line: string) => void = (line) => console.log(line)
): Mailer {
  let counter = 0;
  return {
    async send(message: MailMessage) {
      counter += 1;
      const body =
        'template' in message.content && message.content.template !== undefined
          ? `template=${message.content.template} data=${JSON.stringify(message.content.data)}`
          : (message.content.text ?? message.content.html ?? '');
      log(
        `[mailer:console] to=${message.to} from="${message.from.name}" <${message.from.address}> ` +
          `subject=${message.subject}\n${body}`
      );
      return { providerMessageId: `console-${counter}` };
    },
  };
}
