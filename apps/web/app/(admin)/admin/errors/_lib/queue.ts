/**
 * Pure helpers for the admin error queue page (D7 — spec 06 "Error states").
 * Side-effect-free and unit-tested (`queue.test.ts`); the queue's real data
 * shaping lives in the error-queue service.
 */

/**
 * One-line human summary of `orders.error_detail`. D1/D3 write structured
 * detail ({ code, reason, message, eventId, providerRef, … }) — surface the
 * human-ish fields first and fall back to compact JSON, truncated so a noisy
 * payload can never blow up the table row. Never includes respondent PII
 * because the writers never put any in (no-PII rule).
 */
export function summarizeErrorDetail(
  detail: Record<string, unknown> | null,
  maxLength = 140
): string {
  if (!detail || Object.keys(detail).length === 0) return 'No detail recorded';

  const parts: string[] = [];
  for (const key of ['message', 'reason', 'error']) {
    const value = detail[key];
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(value.trim());
      break;
    }
  }
  const code = detail['code'];
  if (typeof code === 'string' && code.trim() !== '') parts.push(`[${code.trim()}]`);

  const summary = parts.length > 0 ? parts.join(' ') : JSON.stringify(detail);
  return truncate(summary, maxLength);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Retry button labels per retry event (spec 06 retry transitions). */
export const RETRY_LABELS: Record<string, string> = {
  retry_payment: 'Retry payment',
  retry_email: 'Retry invitations',
  retry_scoring: 'Retry scoring',
};

export function retryLabel(event: string): string {
  return RETRY_LABELS[event] ?? 'Retry';
}
