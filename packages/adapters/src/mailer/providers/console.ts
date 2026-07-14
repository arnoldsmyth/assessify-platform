import type { Mailer } from '../types';

/**
 * Dev/fallback Mailer provider: writes the email to stdout instead of
 * sending. Wired at composition roots until the SendGrid provider lands
 * (spec 13); never used in production.
 */
export function createConsoleMailer(
  log: (line: string) => void = (line) => console.log(line)
): Mailer {
  return {
    async send({ to, subject, text, html }) {
      log(`[mailer:console] to=${to} subject=${subject}\n${text ?? html}`);
    },
  };
}
