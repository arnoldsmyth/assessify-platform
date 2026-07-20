import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types';
import { createSendGridMailer } from './sendgrid';

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function stubFetch(
  responses: Response[] = []
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return (
      queue.shift() ??
      new Response(null, { status: 202, headers: { 'x-message-id': 'msg-abc123' } })
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const message: MailMessage = {
  to: 'respondent@example.com',
  from: { name: 'Pro-D', address: 'assessments@pro-d.example' },
  replyTo: { name: 'Support', address: 'support@pro-d.example' },
  subject: 'Your invitation',
  content: { template: 'invitation', data: { link: 'https://q.example/s/abc' } },
  language: 'fr',
  refs: {
    notificationId: '01890a5d-ac96-774b-bcce-b302099a8057',
    orderId: '01890a5d-ac96-774b-bcce-b302099a8058',
    kind: 'invitation',
  },
};

describe('createSendGridMailer', () => {
  it('POSTs to the v3 mail/send endpoint with the bearer key', async () => {
    const { fetchImpl, requests } = stubFetch();
    await createSendGridMailer({ apiKey: 'sg-key', fetchImpl }).send(message);
    expect(requests[0]?.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(requests[0]?.init.method).toBe('POST');
    expect((requests[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sg-key'
    );
  });

  it('maps a templated message to a dynamic-template send with per-call sender', async () => {
    const { fetchImpl, requests } = stubFetch();
    await createSendGridMailer({
      apiKey: 'sg-key',
      fetchImpl,
      templateIds: { invitation: 'd-111invitation' },
    }).send(message);
    const body = requests[0]?.body as {
      template_id: string;
      from: unknown;
      reply_to: unknown;
      subject: string;
      personalizations: { to: unknown; dynamic_template_data: unknown }[];
      custom_args: Record<string, string>;
      content?: unknown;
    };
    expect(body.template_id).toBe('d-111invitation');
    expect(body.from).toEqual({ email: 'assessments@pro-d.example', name: 'Pro-D' });
    expect(body.reply_to).toEqual({ email: 'support@pro-d.example', name: 'Support' });
    expect(body.subject).toBe('Your invitation');
    expect(body.personalizations[0]?.to).toEqual([{ email: 'respondent@example.com' }]);
    expect(body.personalizations[0]?.dynamic_template_data).toEqual({
      link: 'https://q.example/s/abc',
    });
    expect(body.content).toBeUndefined();
    // Correlation ids for the event webhook — ids only, no PII.
    expect(body.custom_args).toEqual({
      notification_id: '01890a5d-ac96-774b-bcce-b302099a8057',
      order_id: '01890a5d-ac96-774b-bcce-b302099a8058',
      kind: 'invitation',
    });
  });

  it('passes an unmapped template key through as the template id', async () => {
    const { fetchImpl, requests } = stubFetch();
    await createSendGridMailer({ apiKey: 'k', fetchImpl }).send({
      ...message,
      content: { template: 'd-direct-id', data: {} },
    });
    expect((requests[0]?.body as { template_id: string }).template_id).toBe('d-direct-id');
  });

  it('sends raw content with text/plain before text/html and no template', async () => {
    const { fetchImpl, requests } = stubFetch();
    await createSendGridMailer({ apiKey: 'k', fetchImpl }).send({
      to: 'a@example.com',
      from: { name: 'Assessify', address: 'no-reply@assessify.example' },
      subject: 'Sign in',
      content: { html: '<p>hi</p>', text: 'hi' },
    });
    const body = requests[0]?.body as {
      template_id?: string;
      content: { type: string; value: string }[];
    };
    expect(body.template_id).toBeUndefined();
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'hi' },
      { type: 'text/html', value: '<p>hi</p>' },
    ]);
  });

  it('returns the X-Message-Id header as providerMessageId', async () => {
    const { fetchImpl } = stubFetch([
      new Response(null, { status: 202, headers: { 'x-message-id': 'sg-42' } }),
    ]);
    const result = await createSendGridMailer({ apiKey: 'k', fetchImpl }).send(message);
    expect(result.providerMessageId).toBe('sg-42');
  });

  it('returns an empty providerMessageId when the header is missing', async () => {
    const { fetchImpl } = stubFetch([new Response(null, { status: 202 })]);
    const result = await createSendGridMailer({ apiKey: 'k', fetchImpl }).send(message);
    expect(result.providerMessageId).toBe('');
  });

  it('throws a permanent MailerError on 4xx without echoing the recipient', async () => {
    const { fetchImpl } = stubFetch([
      new Response(JSON.stringify({ errors: [{ message: 'from address is not verified' }] }), {
        status: 400,
      }),
    ]);
    const error = (await createSendGridMailer({ apiKey: 'k', fetchImpl })
      .send(message)
      .then(
        () => {
          throw new Error('expected send to reject');
        },
        (e: unknown) => e
      )) as Error & { status?: number; permanent?: boolean };
    expect(error).toMatchObject({ name: 'MailerError', status: 400, permanent: true });
    expect(error.message).toContain('from address is not verified');
    expect(error.message).not.toContain('respondent@example.com');
  });

  it('marks 5xx and 429 as transient (retryable)', async () => {
    for (const status of [500, 429]) {
      const { fetchImpl } = stubFetch([new Response('oops', { status })]);
      await expect(
        createSendGridMailer({ apiKey: 'k', fetchImpl }).send(message)
      ).rejects.toMatchObject({ status, permanent: false });
    }
  });

  it('wraps network failures in a transient MailerError', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;
    await expect(
      createSendGridMailer({ apiKey: 'k', fetchImpl }).send(message)
    ).rejects.toMatchObject({ name: 'MailerError', permanent: false });
  });
});
