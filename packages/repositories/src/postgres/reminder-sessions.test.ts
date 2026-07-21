import type { Database } from '@assessify/db';
import { describe, expect, it, vi } from 'vitest';

import { createReminderSessionRepository } from './reminder-sessions';

/**
 * Reminder-session repository tests (D6). Chainable double for the Drizzle
 * query builder — records the values passed to update and resolves the
 * configured rows (same pattern as scoring-jobs.test.ts). The due-selection
 * BUSINESS rules are exercised exhaustively against the service's pure
 * predicate (reminder-service.test.ts); here we verify the mechanical
 * contract: guarded updates return row-hit booleans and set the right
 * columns.
 */

const SESSION_ID = '01890a5d-ac96-774b-bcce-b302099a000a';
const AT = new Date('2026-07-21T12:00:00.000Z');

function makeDbDouble(options: { selectRows?: unknown[]; updateRows?: unknown[] }) {
  const calls: { updateSet?: Record<string, unknown> } = {};

  const limitResult = Promise.resolve(options.selectRows ?? []);
  const orderChain = {
    limit: vi.fn(async () => options.selectRows ?? []),
  };
  const selectChain = {
    from: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    leftJoin: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => orderChain),
    limit: vi.fn(async () => limitResult),
  };

  const db = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => {
        calls.updateSet = set;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => options.updateRows ?? []),
          })),
        };
      }),
    })),
  } as unknown as Database;

  return { db, calls };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    orderId: '01890a5d-ac96-774b-bcce-b302099a0001',
    token: '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9a1',
    status: 'invited',
    language: 'en',
    invitedAt: new Date('2026-07-18T12:00:00.000Z'),
    createdAt: new Date('2026-07-18T11:00:00.000Z'),
    reminderCount: 0,
    lastReminderAt: null,
    remindersSuppressed: false,
    orderStatus: 'sent',
    orderType: 'bulk_named',
    orderClientId: '01890a5d-ac96-774b-bcce-b302099a0003',
    orderProductId: '01890a5d-ac96-774b-bcce-b302099a0002',
    orderReportLanguage: 'en',
    orderSuppressNotifications: false,
    respondentId: '01890a5d-ac96-774b-bcce-b302099a0004',
    respondentEmail: 'ada@example.com',
    respondentFirstName: 'Ada',
    ...overrides,
  };
}

describe('reminder-session repository', () => {
  it('maps due rows to records with nested order and respondent', async () => {
    const { db } = makeDbDouble({ selectRows: [makeRow()] });
    const repo = createReminderSessionRepository(db);
    const records = await repo.listDue({
      now: AT,
      minGapMs: 2 * 24 * 60 * 60 * 1000,
      windowMs: 30 * 24 * 60 * 60 * 1000,
      maxReminders: 15,
      limit: 100,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: SESSION_ID,
      status: 'invited',
      reminderCount: 0,
      order: { status: 'sent', type: 'bulk_named', suppressNotifications: false },
      respondent: { email: 'ada@example.com', firstName: 'Ada' },
    });
  });

  it('maps an erased respondent to null', async () => {
    const { db } = makeDbDouble({
      selectRows: [makeRow({ respondentId: null, respondentEmail: null, respondentFirstName: null })],
    });
    const repo = createReminderSessionRepository(db);
    const record = await repo.findById(SESSION_ID);
    expect(record?.respondent).toBeNull();
  });

  it('findById returns null for an unknown session', async () => {
    const { db } = makeDbDouble({ selectRows: [] });
    const repo = createReminderSessionRepository(db);
    expect(await repo.findById(SESSION_ID)).toBeNull();
  });

  it('markReminderSent stamps last_reminder_at and reports the row hit', async () => {
    const { db, calls } = makeDbDouble({ updateRows: [{ id: SESSION_ID }] });
    const repo = createReminderSessionRepository(db);
    await expect(repo.markReminderSent(SESSION_ID, 0, AT)).resolves.toBe(true);
    expect(calls.updateSet).toMatchObject({ lastReminderAt: AT, updatedAt: AT });
    // The increment is a SQL expression (count = count + 1), never a JS value.
    expect(calls.updateSet?.['reminderCount']).toBeTypeOf('object');
  });

  it('markReminderSent reports false when the guard filtered the row out', async () => {
    const { db } = makeDbDouble({ updateRows: [] });
    const repo = createReminderSessionRepository(db);
    await expect(repo.markReminderSent(SESSION_ID, 3, AT)).resolves.toBe(false);
  });

  it('setSuppressed writes the flag and reports missing sessions', async () => {
    const hit = makeDbDouble({ updateRows: [{ id: SESSION_ID }] });
    const repo = createReminderSessionRepository(hit.db);
    await expect(repo.setSuppressed(SESSION_ID, true, AT)).resolves.toBe(true);
    expect(hit.calls.updateSet).toMatchObject({ remindersSuppressed: true, updatedAt: AT });

    const miss = makeDbDouble({ updateRows: [] });
    await expect(
      createReminderSessionRepository(miss.db).setSuppressed(SESSION_ID, false, AT)
    ).resolves.toBe(false);
  });
});
