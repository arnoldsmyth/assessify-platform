import { describe, expect, it } from 'vitest';
import type {
  JobName,
  JobPayload,
  NotificationLogEntry,
  NotificationRequestInput,
} from '@assessify/domain';
import {
  JobQueueError,
  MailerError,
  type EnqueueOptions,
  type JobQueue,
  type MailProviderEvent,
} from '@assessify/adapters';
import { createMemoryMailer } from '@assessify/adapters/mailer/memory';
import type { NotificationLogCreate, NotificationLogRepository } from '@assessify/repositories';

import { createNotificationService } from './notification-service';

/** In-memory NotificationLogRepository double. */
function createFakeLogRepo() {
  const rows = new Map<string, NotificationLogEntry>();
  let failNextWrite = false;
  const repo: NotificationLogRepository = {
    async insert(input: NotificationLogCreate) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('db down');
      }
      const entry: NotificationLogEntry = {
        id: input.id,
        orderId: input.orderId ?? null,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        recipient: input.recipient,
        template: input.template,
        language: input.language ?? null,
        providerMessageId: null,
        status: 'queued',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(entry.id, entry);
      return entry;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findByProviderMessageId(providerMessageId) {
      for (const entry of rows.values()) {
        if (entry.providerMessageId === providerMessageId) return entry;
      }
      return null;
    },
    async markSent(id, providerMessageId) {
      const entry = rows.get(id);
      if (!entry) return null;
      const updated = { ...entry, status: 'sent' as const, providerMessageId };
      rows.set(id, updated);
      return updated;
    },
    async updateStatus(id, status) {
      const entry = rows.get(id);
      if (!entry) return null;
      const updated = { ...entry, status };
      rows.set(id, updated);
      return updated;
    },
    async listByStatuses(statuses, limit) {
      return [...rows.values()].filter((entry) => statuses.includes(entry.status)).slice(0, limit);
    },
    async listByKindAndSession(kind, sessionId) {
      return [...rows.values()].filter(
        (entry) => entry.kind === kind && entry.sessionId === sessionId
      );
    },
  };
  return {
    repo,
    rows,
    failNextWrite() {
      failNextWrite = true;
    },
  };
}

interface EnqueuedCall {
  jobName: JobName;
  payload: unknown;
  options: EnqueueOptions | undefined;
}

function createFakeQueue(failWith?: Error) {
  const calls: EnqueuedCall[] = [];
  const queue: JobQueue = {
    async enqueue(jobName, payload, options) {
      if (failWith) throw failWith;
      calls.push({ jobName, payload, options });
      return { jobId: options?.idempotencyKey ?? jobName };
    },
  };
  return { queue, calls };
}

const request: NotificationRequestInput = {
  kind: 'invitation',
  to: 'respondent@example.com',
  subject: 'Your assessment invitation',
  template: 'invitation',
  data: { link: 'https://q.example/s/abc' },
  language: 'de',
  sender: {
    from: { name: 'Pro-D', address: 'assessments@pro-d.example' },
    replyTo: { name: 'Support', address: 'support@pro-d.example' },
  },
  refs: { orderId: '01890a5d-ac96-774b-bcce-b302099a8058' },
};

function buildService(
  overrides: {
    repo?: ReturnType<typeof createFakeLogRepo>;
    queue?: ReturnType<typeof createFakeQueue>;
    mailer?: ReturnType<typeof createMemoryMailer>;
  } = {}
) {
  const repoBundle = overrides.repo ?? createFakeLogRepo();
  const queueBundle = overrides.queue ?? createFakeQueue();
  const mailer = overrides.mailer ?? createMemoryMailer();
  const service = createNotificationService({
    notificationLog: repoBundle.repo,
    mailer,
    queue: queueBundle.queue,
  });
  return { service, ...repoBundle, ...queueBundle, mailer };
}

async function queuedPayload(
  ctx: ReturnType<typeof buildService>
): Promise<JobPayload<'notifications.send'>> {
  const result = await ctx.service.send(request);
  if (!result.ok) throw new Error('send failed in fixture');
  const call = ctx.calls[0];
  return call?.payload as JobPayload<'notifications.send'>;
}

describe('notificationService.send', () => {
  it('writes a queued notification_log row and enqueues notifications.send', async () => {
    const ctx = buildService();
    const result = await ctx.service.send(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = ctx.rows.get(result.value.notificationId);
    expect(entry).toMatchObject({
      kind: 'invitation',
      recipient: 'respondent@example.com',
      template: 'invitation',
      language: 'de',
      orderId: '01890a5d-ac96-774b-bcce-b302099a8058',
      status: 'queued',
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({
      jobName: 'notifications.send',
      options: { idempotencyKey: `notifications.send:${result.value.notificationId}` },
    });
    // Nothing is sent synchronously — spec 13: no emails from request handlers.
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('rejects an invalid request with a validation error and writes nothing', async () => {
    const ctx = buildService();
    const result = await ctx.service.send({ ...request, to: 'not-an-email' });
    expect(result).toMatchObject({ ok: false, error: { code: 'notification/validation' } });
    expect(ctx.rows.size).toBe(0);
    expect(ctx.calls).toHaveLength(0);
  });

  it('fails without a queue (composition error, typed not thrown)', async () => {
    const { repo } = createFakeLogRepo();
    const service = createNotificationService({
      notificationLog: repo,
      mailer: createMemoryMailer(),
    });
    const result = await service.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'notification/queue_unavailable' },
    });
  });

  it('returns a log_write error when the insert fails', async () => {
    const ctx = buildService();
    ctx.failNextWrite();
    const result = await ctx.service.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'notification/log_write_failed' },
    });
  });

  it('marks the row failed when enqueueing fails', async () => {
    const repo = createFakeLogRepo();
    const queue = createFakeQueue(new JobQueueError('valkey unreachable'));
    const ctx = buildService({ repo, queue });
    const result = await ctx.service.send(request);
    expect(result).toMatchObject({ ok: false, error: { code: 'notification/enqueue_failed' } });
    const [entry] = [...ctx.rows.values()];
    expect(entry?.status).toBe('failed');
  });
});

describe('notificationService.deliverQueued', () => {
  it('sends via the mailer with per-call sender identity and marks the row sent', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    const result = await ctx.service.deliverQueued(payload);
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'sent', providerMessageId: 'mem-1' },
    });
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({
      to: 'respondent@example.com',
      from: { name: 'Pro-D', address: 'assessments@pro-d.example' },
      replyTo: { name: 'Support', address: 'support@pro-d.example' },
      content: { template: 'invitation', data: { link: 'https://q.example/s/abc' } },
      language: 'de',
      refs: {
        notificationId: payload.notificationId,
        kind: 'invitation',
        orderId: '01890a5d-ac96-774b-bcce-b302099a8058',
      },
    });
    expect(ctx.rows.get(payload.notificationId)).toMatchObject({
      status: 'sent',
      providerMessageId: 'mem-1',
    });
  });

  it('is idempotent: a row already sent is not re-sent', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    await ctx.service.deliverQueued(payload);
    const again = await ctx.service.deliverQueued(payload);
    expect(again).toMatchObject({ ok: true, value: { status: 'sent' } });
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('marks the row failed and reports transient failures as retryable', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    ctx.mailer.failWith(new MailerError('sendgrid 500', 500, false));
    const result = await ctx.service.deliverQueued(payload);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'notification/send_failed', detail: { permanent: false } },
    });
    expect(ctx.rows.get(payload.notificationId)?.status).toBe('failed');
    // A queue retry may deliver a previously failed row.
    ctx.mailer.failWith(null);
    const retry = await ctx.service.deliverQueued(payload);
    expect(retry).toMatchObject({ ok: true, value: { status: 'sent' } });
  });

  it('propagates the provider permanent flag for unrecoverable rejects', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    ctx.mailer.failWith(new MailerError('unverified sender', 400, true));
    const result = await ctx.service.deliverQueued(payload);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'notification/send_failed', detail: { permanent: true } },
    });
  });

  it('does not leak the recipient address into error results', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    ctx.mailer.failWith(new MailerError('provider rejected the send', 400, true));
    const result = await ctx.service.deliverQueued(payload);
    expect(JSON.stringify(result)).not.toContain('respondent@example.com');
  });

  it('fails permanently when the notification_log row is missing', async () => {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    ctx.rows.clear();
    const result = await ctx.service.deliverQueued(payload);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'notification/not_found', detail: { permanent: true } },
    });
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});

describe('notificationService.recordProviderEvent', () => {
  function event(
    type: MailProviderEvent['type'],
    overrides: Partial<MailProviderEvent> = {}
  ): MailProviderEvent {
    return { type, providerMessageId: null, notificationId: null, occurredAt: null, ...overrides };
  }

  async function sentFixture() {
    const ctx = buildService();
    const payload = await queuedPayload(ctx);
    await ctx.service.deliverQueued(payload); // status: sent, providerMessageId: mem-1
    return { ctx, id: payload.notificationId };
  }

  it('advances sent → delivered → opened via provider events', async () => {
    const { ctx, id } = await sentFixture();
    const delivered = await ctx.service.recordProviderEvent(
      event('delivered', { notificationId: id })
    );
    expect(delivered).toMatchObject({
      ok: true,
      value: { matched: true, changed: true, notification: { status: 'delivered' } },
    });
    const opened = await ctx.service.recordProviderEvent(event('opened', { notificationId: id }));
    expect(opened).toMatchObject({ ok: true, value: { changed: true } });
    expect(ctx.rows.get(id)?.status).toBe('opened');
  });

  it('matches by provider message id when no notification id is echoed', async () => {
    const { ctx, id } = await sentFixture();
    const result = await ctx.service.recordProviderEvent(
      event('delivered', { providerMessageId: 'mem-1' })
    );
    expect(result).toMatchObject({ ok: true, value: { matched: true, changed: true } });
    expect(ctx.rows.get(id)?.status).toBe('delivered');
  });

  it('never rewinds status (late delivered after opened is a no-op)', async () => {
    const { ctx, id } = await sentFixture();
    await ctx.service.recordProviderEvent(event('opened', { notificationId: id }));
    const late = await ctx.service.recordProviderEvent(
      event('delivered', { notificationId: id })
    );
    expect(late).toMatchObject({ ok: true, value: { matched: true, changed: false } });
    expect(ctx.rows.get(id)?.status).toBe('opened');
  });

  it('lets a hard bounce override opened (authoritative failure, spec 13)', async () => {
    const { ctx, id } = await sentFixture();
    await ctx.service.recordProviderEvent(event('opened', { notificationId: id }));
    const bounced = await ctx.service.recordProviderEvent(
      event('bounced', { notificationId: id })
    );
    expect(bounced).toMatchObject({
      ok: true,
      value: { changed: true, notification: { kind: 'invitation', status: 'bounced' } },
    });
  });

  it('maps dropped to failed', async () => {
    const { ctx, id } = await sentFixture();
    await ctx.service.recordProviderEvent(event('dropped', { notificationId: id }));
    expect(ctx.rows.get(id)?.status).toBe('failed');
  });

  it('ignores untracked event types without changing status', async () => {
    const { ctx, id } = await sentFixture();
    const result = await ctx.service.recordProviderEvent(
      event('deferred', { notificationId: id })
    );
    expect(result).toMatchObject({ ok: true, value: { matched: true, changed: false } });
    expect(ctx.rows.get(id)?.status).toBe('sent');
  });

  it('reports unknown messages as unmatched, not as errors', async () => {
    const { ctx } = await sentFixture();
    const result = await ctx.service.recordProviderEvent(
      event('delivered', { providerMessageId: 'someone-elses-message' })
    );
    expect(result).toMatchObject({ ok: true, value: { matched: false, changed: false } });
  });
});
