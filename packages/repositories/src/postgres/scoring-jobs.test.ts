import type { Database } from '@assessify/db';
import { uuidv7 } from '@assessify/domain';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { createScoringJobRepository } from './scoring-jobs';

const now = new Date('2026-07-20T10:00:00.000Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    sessionId: uuidv7(),
    mode: 'sync_internal',
    status: 'queued',
    callbackTokenHash: null,
    requestPayload: null,
    responsePayload: null,
    error: null,
    attempts: 0,
    dispatchedAt: null,
    completedAt: null,
    createdAt: now,
    ...overrides,
  };
}

/**
 * Chainable double for the Drizzle query builder — records the values passed
 * to insert/update and resolves the configured rows (same pattern as
 * responses.test.ts).
 */
function makeDbDouble(options: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  updateRows?: unknown[];
}) {
  const calls: { insertValues?: Record<string, unknown>; updateSet?: Record<string, unknown> } = {};

  const rowsPromise = Promise.resolve(options.selectRows ?? []);
  // `.orderBy(...)` is awaited directly by the list queries but also carries
  // `.limit(...)` for listStuck — a thenable with a limit method covers both.
  const orderChain = {
    limit: vi.fn(async () => options.selectRows ?? []),
    then: rowsPromise.then.bind(rowsPromise),
    catch: rowsPromise.catch.bind(rowsPromise),
  };
  const selectChain = {
    from: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => orderChain),
    limit: vi.fn(async () => options.selectRows ?? []),
  };

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        calls.insertValues = values;
        return { returning: vi.fn(async () => options.insertRows ?? []) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        calls.updateSet = values;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => options.updateRows ?? []),
          })),
        };
      }),
    })),
  };

  return { db: db as unknown as Database, calls };
}

describe('createScoringJobRepository', () => {
  it('insert seeds a queued job with zero attempts and maps the returned row', async () => {
    const row = makeRow();
    const { db, calls } = makeDbDouble({ insertRows: [row] });
    const repo = createScoringJobRepository(db);
    const job = await repo.insert({
      id: row.id as string,
      sessionId: row.sessionId as string,
      mode: 'sync_internal',
      createdAt: now,
    });
    expect(calls.insertValues).toMatchObject({
      id: row.id,
      sessionId: row.sessionId,
      mode: 'sync_internal',
      status: 'queued',
      attempts: 0,
      callbackTokenHash: null,
    });
    expect(job.status).toBe('queued');
    expect(job.createdAt).toEqual(now);
  });

  it('findById maps rows through the Zod entity schema (bad rows throw)', async () => {
    const good = makeRow({ status: 'completed', completedAt: now });
    const { db } = makeDbDouble({ selectRows: [good] });
    const repo = createScoringJobRepository(db);
    const job = await repo.findById(good.id as string);
    expect(job?.status).toBe('completed');

    const bad = makeRow({ status: 'not-a-status' });
    const { db: badDb } = makeDbDouble({ selectRows: [bad] });
    await expect(createScoringJobRepository(badDb).findById(bad.id as string)).rejects.toThrow(
      ZodError
    );
  });

  it('markDispatched CAS-updates with an attempts increment and payload snapshot', async () => {
    const row = makeRow({ status: 'dispatched', attempts: 1, dispatchedAt: now });
    const { db, calls } = makeDbDouble({ updateRows: [row] });
    const repo = createScoringJobRepository(db);
    const payload = { answers: { q1: 3 } };
    const job = await repo.markDispatched(row.id as string, now, payload);
    expect(job?.status).toBe('dispatched');
    expect(calls.updateSet).toMatchObject({
      status: 'dispatched',
      dispatchedAt: now,
      requestPayload: payload,
    });
    // attempts is a SQL expression (`attempts + 1`), not a literal.
    expect(calls.updateSet?.['attempts']).toBeDefined();
    expect(typeof calls.updateSet?.['attempts']).not.toBe('number');
  });

  it('CAS updates return null when no row matched (lost race / wrong state)', async () => {
    const { db } = makeDbDouble({ updateRows: [] });
    const repo = createScoringJobRepository(db);
    const id = uuidv7();
    await expect(repo.markDispatched(id, now, {})).resolves.toBeNull();
    await expect(repo.markAwaitingCallback(id, 'hash')).resolves.toBeNull();
    await expect(repo.complete(id, {}, now)).resolves.toBeNull();
    await expect(repo.fail(id, 'boom')).resolves.toBeNull();
    await expect(repo.requeue(id)).resolves.toBeNull();
  });

  it('complete stores the score payload and clears the error', async () => {
    const scores = { dimensions: { drive: 7 } };
    const row = makeRow({ status: 'completed', responsePayload: scores, completedAt: now });
    const { db, calls } = makeDbDouble({ updateRows: [row] });
    const repo = createScoringJobRepository(db);
    const job = await repo.complete(row.id as string, scores, now);
    expect(job?.responsePayload).toEqual(scores);
    expect(calls.updateSet).toMatchObject({
      status: 'completed',
      responsePayload: scores,
      completedAt: now,
      error: null,
    });
  });

  it('fail records the machine-readable error', async () => {
    const row = makeRow({ status: 'failed', error: 'engine_timeout' });
    const { db, calls } = makeDbDouble({ updateRows: [row] });
    const repo = createScoringJobRepository(db);
    const job = await repo.fail(row.id as string, 'engine_timeout');
    expect(job?.error).toBe('engine_timeout');
    expect(calls.updateSet).toEqual({ status: 'failed', error: 'engine_timeout' });
  });

  it('requeue resets the retry bookkeeping', async () => {
    const row = makeRow();
    const { db, calls } = makeDbDouble({ updateRows: [row] });
    const repo = createScoringJobRepository(db);
    await repo.requeue(row.id as string);
    expect(calls.updateSet).toEqual({
      status: 'queued',
      error: null,
      attempts: 0,
      dispatchedAt: null,
      callbackTokenHash: null,
    });
  });

  it('findBySessionId maps every row', async () => {
    const rows = [makeRow(), makeRow({ status: 'failed', error: 'x' })];
    const { db } = makeDbDouble({ selectRows: rows });
    const repo = createScoringJobRepository(db);
    const jobs = await repo.findBySessionId(rows[0]!.sessionId as string);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.status).toBe('failed');
  });

  it('findByOrderId unwraps the joined row shape', async () => {
    const row = makeRow();
    const { db } = makeDbDouble({ selectRows: [{ job: row }] });
    const repo = createScoringJobRepository(db);
    const jobs = await repo.findByOrderId(uuidv7());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(row.id);
  });

  it('listStuck maps awaiting_callback rows', async () => {
    const row = makeRow({ status: 'awaiting_callback', dispatchedAt: now, attempts: 1 });
    const { db } = makeDbDouble({ selectRows: [row] });
    const repo = createScoringJobRepository(db);
    const jobs = await repo.listStuck(new Date());
    expect(jobs[0]?.status).toBe('awaiting_callback');
  });

  it('setExternalRef merges into request_payload via SQL (never replaces the snapshot)', async () => {
    const ref = { provider: 'prologic', assessmentId: 'A-1' };
    const row = makeRow({
      status: 'dispatched',
      dispatchedAt: now,
      attempts: 1,
      requestPayload: { answers: { q1: 3 }, externalRef: ref },
    });
    const { db, calls } = makeDbDouble({ updateRows: [row] });
    const repo = createScoringJobRepository(db);
    const job = await repo.setExternalRef(row.id as string, ref);
    expect(job?.requestPayload).toEqual({ answers: { q1: 3 }, externalRef: ref });
    // The payload write is a jsonb || merge expression (drizzle SQL object
    // with queryChunks), not a literal record that would clobber the snapshot.
    const written = calls.updateSet?.['requestPayload'] as Record<string, unknown>;
    expect(written).toBeDefined();
    expect(written).toHaveProperty('queryChunks');

    const { db: missDb } = makeDbDouble({ updateRows: [] });
    await expect(createScoringJobRepository(missDb).setExternalRef(uuidv7(), ref)).resolves.toBeNull();
  });

  it('findByExternalRef maps the newest matching row and nulls on no match', async () => {
    const row = makeRow({
      status: 'dispatched',
      dispatchedAt: now,
      attempts: 1,
      requestPayload: { externalRef: { provider: 'prologic', assessmentId: 'A-1' } },
    });
    const { db } = makeDbDouble({ selectRows: [row] });
    const repo = createScoringJobRepository(db);
    const job = await repo.findByExternalRef('prologic', 'A-1');
    expect(job?.id).toBe(row.id);

    const { db: emptyDb } = makeDbDouble({ selectRows: [] });
    await expect(
      createScoringJobRepository(emptyDb).findByExternalRef('prologic', 'A-404')
    ).resolves.toBeNull();
  });
});
