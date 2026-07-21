import { Card } from '@assessify/ui';

/**
 * Friendly forbidden state for admin pages (D7 error-page pattern): the
 * service returned a typed forbidden error — render it as a calm card
 * instead of throwing. No PII, no stack traces.
 */
export function ForbiddenCard({
  title = 'You do not have access to this page',
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <Card className="flex flex-col items-start gap-2 p-6">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-sm text-muted">{message}</p>
    </Card>
  );
}
