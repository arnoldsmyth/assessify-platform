import { describe, expect, it } from 'vitest';

import { MailerError, type Mailer, type MailMessage } from '../types';
import { createMemoryMailer } from './memory';

const message: MailMessage = {
  to: 'respondent@example.com',
  from: { name: 'Pro-D Assessments', address: 'assessments@pro-d.example' },
  replyTo: { name: 'Pro-D Support', address: 'support@pro-d.example' },
  subject: 'Your assessment invitation',
  content: { template: 'invitation', data: { link: 'https://q.example/s/abc', pin: '1234' } },
  language: 'en',
  refs: {
    notificationId: '01890a5d-ac96-774b-bcce-b302099a8057',
    orderId: '01890a5d-ac96-774b-bcce-b302099a8058',
    sessionId: '01890a5d-ac96-774b-bcce-b302099a8059',
    kind: 'invitation',
  },
};

/**
 * Mailer adapter contract, exercised against the reference in-memory
 * provider: send() resolves with a non-empty provider message id and the
 * message is dispatched exactly as given (per-call sender identity — spec 11
 * white-label — travels with the message, never provider config).
 */
describe('mailer adapter contract (memory provider)', () => {
  it('resolves with a provider message id', async () => {
    const mailer: Mailer = createMemoryMailer();
    const result = await mailer.send(message);
    expect(result.providerMessageId).toBeTruthy();
  });

  it('returns distinct ids per send', async () => {
    const mailer = createMemoryMailer();
    const first = await mailer.send(message);
    const second = await mailer.send(message);
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
  });

  it('records the full message, including per-call sender identity and refs', async () => {
    const mailer = createMemoryMailer();
    await mailer.send(message);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toEqual(message);
  });

  it('supports raw-content messages (non-notification transactional mail)', async () => {
    const mailer = createMemoryMailer();
    await mailer.send({
      to: 'admin@example.com',
      from: { name: 'Assessify', address: 'no-reply@assessify.example' },
      subject: 'Sign in',
      content: { html: '<p>link</p>', text: 'link' },
    });
    expect(mailer.sent[0]?.content).toEqual({ html: '<p>link</p>', text: 'link' });
  });

  it('rejects with the injected MailerError and records nothing', async () => {
    const mailer = createMemoryMailer();
    mailer.failWith(new MailerError('provider unavailable', 503, false));
    await expect(mailer.send(message)).rejects.toMatchObject({
      name: 'MailerError',
      status: 503,
      permanent: false,
    });
    expect(mailer.sent).toHaveLength(0);
    mailer.failWith(null);
    await expect(mailer.send(message)).resolves.toBeDefined();
  });

  it('reset() clears recorded messages and restarts ids', async () => {
    const mailer = createMemoryMailer();
    await mailer.send(message);
    mailer.reset();
    expect(mailer.sent).toHaveLength(0);
    const result = await mailer.send(message);
    expect(result.providerMessageId).toBe('mem-1');
  });
});
