import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../uuid';
import {
  answerRecordSchema,
  answersMapSchema,
  answersPatchSchema,
  emptyResponseProgress,
  newQuestionnaireResponseSchema,
  questionnaireResponseSchema,
  responseProgressSchema,
} from './response';

const answeredAt = '2026-07-14T09:00:00.000Z';

describe('answerRecordSchema', () => {
  it('accepts every answer value shape from spec 07', () => {
    const valid = [
      { type: 'likert', value: 4, answeredAt },
      { type: 'numeric', value: 7.5, answeredAt },
      { type: 'multiple_choice', value: 'opt_a', answeredAt },
      { type: 'multiple_choice', value: ['opt_a', 'opt_b'], answeredAt },
      { type: 'matrix', value: { row_1: 3, row_2: 5 }, answeredAt },
      { type: 'ranking', value: ['c', 'a', 'b'], answeredAt },
      { type: 'free_text', value: 'Some open answer.', answeredAt },
      { type: 'ipsative_most_least', value: { most: 'i1', least: 'i3' }, answeredAt },
    ];
    for (const record of valid) {
      expect(answerRecordSchema.safeParse(record).success, JSON.stringify(record)).toBe(true);
    }
  });

  it('rejects value shapes that do not match the question type', () => {
    const invalid = [
      { type: 'likert', value: 'four', answeredAt },
      { type: 'numeric', value: Number.NaN, answeredAt },
      { type: 'matrix', value: ['not', 'a', 'record'], answeredAt },
      { type: 'ranking', value: [], answeredAt },
      { type: 'free_text', value: 42, answeredAt },
      { type: 'ipsative_most_least', value: { most: 'i1' }, answeredAt },
      { type: 'content', value: 'never answered', answeredAt },
    ];
    for (const record of invalid) {
      expect(answerRecordSchema.safeParse(record).success, JSON.stringify(record)).toBe(false);
    }
  });

  it('rejects ipsative answers where most === least (spec 07 hard rule)', () => {
    const result = answerRecordSchema.safeParse({
      type: 'ipsative_most_least',
      value: { most: 'i2', least: 'i2' },
      answeredAt,
    });
    expect(result.success).toBe(false);
  });

  it('requires an ISO-8601 answeredAt and allows the hidden flag', () => {
    expect(
      answerRecordSchema.safeParse({ type: 'likert', value: 1, answeredAt: 'yesterday' }).success
    ).toBe(false);
    expect(
      answerRecordSchema.safeParse({ type: 'likert', value: 1, answeredAt, hidden: true }).success
    ).toBe(true);
  });
});

describe('answersPatchSchema', () => {
  it('rejects an empty patch', () => {
    expect(answersPatchSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a patch of one or more keyed answer records', () => {
    const patch = {
      q_energy: { type: 'likert', value: 3, answeredAt },
      q_style: { type: 'multiple_choice', value: ['a'], answeredAt },
    };
    expect(answersPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('rejects a patch containing an invalid record', () => {
    const patch = { q_energy: { type: 'likert', value: 'high', answeredAt } };
    expect(answersPatchSchema.safeParse(patch).success).toBe(false);
  });
});

describe('responseProgressSchema', () => {
  it('accepts the empty progress default', () => {
    expect(responseProgressSchema.safeParse(emptyResponseProgress).success).toBe(true);
  });

  it('rejects negative or fractional counts and unknown fields', () => {
    expect(
      responseProgressSchema.safeParse({
        currentSectionKey: 's1',
        answeredCount: -1,
        totalCount: 10,
      }).success
    ).toBe(false);
    expect(
      responseProgressSchema.safeParse({
        currentSectionKey: 's1',
        answeredCount: 1.5,
        totalCount: 10,
      }).success
    ).toBe(false);
    expect(
      responseProgressSchema.safeParse({
        currentSectionKey: 's1',
        answeredCount: 1,
        totalCount: 10,
        extra: true,
      }).success
    ).toBe(false);
  });
});

describe('questionnaireResponseSchema', () => {
  function makeResponse() {
    return {
      id: uuidv7(),
      sessionId: uuidv7(),
      orderId: uuidv7(),
      productId: uuidv7(),
      questionnaireVersionId: uuidv7(),
      language: 'pt-BR',
      status: 'draft',
      answers: { q1: { type: 'likert', value: 2, answeredAt } },
      progress: { currentSectionKey: 'core', answeredCount: 1, totalCount: 12 },
      startedAt: new Date(answeredAt),
      completedAt: null,
      createdAt: new Date(answeredAt),
      updatedAt: new Date(answeredAt),
    };
  }

  it('parses a full draft entity', () => {
    expect(questionnaireResponseSchema.safeParse(makeResponse()).success).toBe(true);
  });

  it('rejects unknown statuses and malformed answers maps', () => {
    expect(
      questionnaireResponseSchema.safeParse({ ...makeResponse(), status: 'in_progress' }).success
    ).toBe(false);
    expect(
      questionnaireResponseSchema.safeParse({
        ...makeResponse(),
        answers: { q1: { value: 2 } },
      }).success
    ).toBe(false);
  });

  it('answersMapSchema accepts an empty map (fresh draft)', () => {
    expect(answersMapSchema.safeParse({}).success).toBe(true);
  });
});

describe('newQuestionnaireResponseSchema', () => {
  it('accepts a minimal creation payload', () => {
    const result = newQuestionnaireResponseSchema.safeParse({
      id: uuidv7(),
      sessionId: uuidv7(),
      orderId: uuidv7(),
      productId: uuidv7(),
      questionnaireVersionId: uuidv7(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID ids and bad language tags', () => {
    const base = {
      id: uuidv7(),
      sessionId: uuidv7(),
      orderId: uuidv7(),
      productId: uuidv7(),
      questionnaireVersionId: uuidv7(),
    };
    expect(
      newQuestionnaireResponseSchema.safeParse({ ...base, sessionId: 'ORD-00042' }).success
    ).toBe(false);
    expect(
      newQuestionnaireResponseSchema.safeParse({ ...base, language: 'Not A Language' }).success
    ).toBe(false);
  });
});
