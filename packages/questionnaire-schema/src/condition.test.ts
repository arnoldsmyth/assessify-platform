import { describe, expect, it } from 'vitest';
import { conditionSchema, referencedQuestionKeys, type Condition } from './condition';

describe('conditionSchema', () => {
  it.each([
    [{ op: 'answered', question: 'q1' }],
    [{ op: 'eq', question: 'q1', value: 'yes' }],
    [{ op: 'neq', question: 'q1', value: 3 }],
    [{ op: 'in', question: 'q1', values: ['a', 2] }],
    [{ op: 'gt', question: 'q1', value: 1 }],
    [{ op: 'gte', question: 'q1', value: 1 }],
    [{ op: 'lt', question: 'q1', value: 1 }],
    [{ op: 'lte', question: 'q1', value: 1 }],
    [{ op: 'not', condition: { op: 'answered', question: 'q1' } }],
    [
      {
        op: 'and',
        conditions: [
          { op: 'answered', question: 'q1' },
          { op: 'or', conditions: [{ op: 'eq', question: 'q2', value: 1 }] },
        ],
      },
    ],
  ])('accepts %j', (condition) => {
    expect(conditionSchema.safeParse(condition).success).toBe(true);
  });

  it.each([
    [{ op: 'equals', question: 'q1', value: 1 }],
    [{ op: 'gt', question: 'q1', value: 'high' }],
    [{ op: 'in', question: 'q1', values: [] }],
    [{ op: 'and', conditions: [] }],
    [{ op: 'answered' }],
    [{ op: 'not', condition: { op: 'nope' } }],
    ['answered'],
  ])('rejects %j', (condition) => {
    expect(conditionSchema.safeParse(condition).success).toBe(false);
  });
});

describe('referencedQuestionKeys', () => {
  it('collects keys from arbitrarily nested conditions', () => {
    const condition: Condition = {
      op: 'and',
      conditions: [
        { op: 'answered', question: 'a' },
        {
          op: 'or',
          conditions: [
            { op: 'in', question: 'b', values: [1] },
            { op: 'not', condition: { op: 'lte', question: 'c', value: 2 } },
          ],
        },
      ],
    };
    expect(referencedQuestionKeys(condition)).toEqual(['a', 'b', 'c']);
  });
});
