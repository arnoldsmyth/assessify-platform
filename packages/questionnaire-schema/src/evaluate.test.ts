import type { AnswerRecord, AnswersMap } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import type { Condition } from './condition';
import { computeVisibility, evaluateCondition } from './evaluate';
import { questionnaireDefinitionSchema, type QuestionnaireDefinitionInput } from './schema';
import { checkSemantics } from './semantic';

const AT = '2026-07-20T10:00:00.000Z';

function record(
  partial: Partial<AnswerRecord> & Pick<AnswerRecord, 'type' | 'value'>
): AnswerRecord {
  return { answeredAt: AT, ...partial } as AnswerRecord;
}

const answers: AnswersMap = {
  q_likert: record({ type: 'likert', value: 4 }),
  q_numeric: record({ type: 'numeric', value: 2.5 }),
  q_single: record({ type: 'multiple_choice', value: 'yes' }),
  q_multi: record({ type: 'multiple_choice', value: ['a', 'c'] }),
  q_text: record({ type: 'free_text', value: 'hello' }),
  q_matrix: record({ type: 'matrix', value: { r1: 2 } }),
  q_rank: record({ type: 'ranking', value: ['x', 'y'] }),
  q_ips: record({ type: 'ipsative_most_least', value: { most: 'i1', least: 'i2' } }),
};

// ---------------------------------------------------------------------------
// evaluateCondition — leaf operators
// ---------------------------------------------------------------------------

describe('evaluateCondition: answered', () => {
  it('is true for any answered question, whatever the value shape', () => {
    for (const question of Object.keys(answers)) {
      expect(evaluateCondition({ op: 'answered', question }, answers)).toBe(true);
    }
  });

  it('is false for unanswered / unknown questions', () => {
    expect(evaluateCondition({ op: 'answered', question: 'nope' }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'answered', question: 'nope' }, {})).toBe(false);
  });
});

describe('evaluateCondition: eq / neq', () => {
  it('compares numbers and strings strictly (no coercion)', () => {
    expect(evaluateCondition({ op: 'eq', question: 'q_likert', value: 4 }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'eq', question: 'q_likert', value: '4' }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'eq', question: 'q_likert', value: 5 }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'eq', question: 'q_single', value: 'yes' }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'eq', question: 'q_single', value: 'no' }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'eq', question: 'q_text', value: 'hello' }, answers)).toBe(true);
  });

  it('treats eq on a multi-select as membership of the selection', () => {
    expect(evaluateCondition({ op: 'eq', question: 'q_multi', value: 'a' }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'eq', question: 'q_multi', value: 'b' }, answers)).toBe(false);
  });

  it('neq means "answered with a different value"', () => {
    expect(evaluateCondition({ op: 'neq', question: 'q_single', value: 'no' }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'neq', question: 'q_single', value: 'yes' }, answers)).toBe(false);
    // multi-select: "does not contain"
    expect(evaluateCondition({ op: 'neq', question: 'q_multi', value: 'a' }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'neq', question: 'q_multi', value: 'b' }, answers)).toBe(true);
  });

  it('is false (both eq and neq) for unanswered questions', () => {
    expect(evaluateCondition({ op: 'eq', question: 'nope', value: 1 }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'neq', question: 'nope', value: 1 }, answers)).toBe(false);
  });

  it('is false against structured values (matrix / ranking / ipsative)', () => {
    for (const question of ['q_matrix', 'q_rank', 'q_ips']) {
      expect(evaluateCondition({ op: 'eq', question, value: 'r1' }, answers)).toBe(false);
      expect(evaluateCondition({ op: 'neq', question, value: 'r1' }, answers)).toBe(true); // answered, contains nothing comparable
    }
  });
});

describe('evaluateCondition: in', () => {
  it('tests membership for scalar answers', () => {
    expect(evaluateCondition({ op: 'in', question: 'q_likert', values: [3, 4] }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'in', question: 'q_likert', values: [1, 2] }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'in', question: 'q_single', values: ['yes', 'maybe'] }, answers)).toBe(true);
  });

  it('tests intersection for multi-select answers', () => {
    expect(evaluateCondition({ op: 'in', question: 'q_multi', values: ['c', 'z'] }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'in', question: 'q_multi', values: ['z'] }, answers)).toBe(false);
  });

  it('is false for unanswered questions and structured values', () => {
    expect(evaluateCondition({ op: 'in', question: 'nope', values: [1] }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'in', question: 'q_matrix', values: ['r1', 2] }, answers)).toBe(false);
  });
});

describe('evaluateCondition: gt / gte / lt / lte', () => {
  it.each([
    ['gt', 3, true],
    ['gt', 4, false],
    ['gte', 4, true],
    ['gte', 5, false],
    ['lt', 5, true],
    ['lt', 4, false],
    ['lte', 4, true],
    ['lte', 3, false],
  ] as const)('%s %d on likert 4 → %s', (op, value, expected) => {
    expect(evaluateCondition({ op, question: 'q_likert', value }, answers)).toBe(expected);
  });

  it('works on non-integer numeric answers', () => {
    expect(evaluateCondition({ op: 'gt', question: 'q_numeric', value: 2 }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'lte', question: 'q_numeric', value: 2.5 }, answers)).toBe(true);
  });

  it('is false for unanswered and for non-numeric answers', () => {
    expect(evaluateCondition({ op: 'gt', question: 'nope', value: 0 }, answers)).toBe(false);
    for (const question of ['q_single', 'q_multi', 'q_text', 'q_matrix', 'q_rank', 'q_ips']) {
      expect(evaluateCondition({ op: 'gt', question, value: -999 }, answers)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — composition
// ---------------------------------------------------------------------------

describe('evaluateCondition: and / or / not', () => {
  const yes: Condition = { op: 'eq', question: 'q_single', value: 'yes' };
  const no: Condition = { op: 'eq', question: 'q_single', value: 'no' };

  it('and requires every branch', () => {
    expect(evaluateCondition({ op: 'and', conditions: [yes, yes] }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'and', conditions: [yes, no] }, answers)).toBe(false);
  });

  it('or requires any branch', () => {
    expect(evaluateCondition({ op: 'or', conditions: [no, yes] }, answers)).toBe(true);
    expect(evaluateCondition({ op: 'or', conditions: [no, no] }, answers)).toBe(false);
  });

  it('not negates, including not(answered) for absence branching', () => {
    expect(evaluateCondition({ op: 'not', condition: yes }, answers)).toBe(false);
    expect(evaluateCondition({ op: 'not', condition: no }, answers)).toBe(true);
    expect(
      evaluateCondition({ op: 'not', condition: { op: 'answered', question: 'nope' } }, answers)
    ).toBe(true);
  });

  it('evaluates arbitrarily deep nesting', () => {
    const condition: Condition = {
      op: 'and',
      conditions: [
        { op: 'or', conditions: [no, { op: 'gt', question: 'q_likert', value: 3 }] },
        {
          op: 'not',
          condition: {
            op: 'and',
            conditions: [
              { op: 'in', question: 'q_multi', values: ['z'] },
              { op: 'answered', question: 'q_text' },
            ],
          },
        },
      ],
    };
    expect(evaluateCondition(condition, answers)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeVisibility — sections, questions, cascading
// ---------------------------------------------------------------------------

/**
 * s1: q1 (choice yes/no), q2 showIf q1 eq 'yes' (likert)
 * s2: showIf q1 eq 'yes' — c_note (content), q3 (choice), q4 showIf q2 gte 3
 * s3: q5 showIf answered q3
 */
const branchingInput: QuestionnaireDefinitionInput = {
  schemaVersion: 1,
  key: 'branching',
  titleKey: 't.title',
  settings: { progressBar: true, allowBack: true },
  sections: [
    {
      key: 's1',
      questions: [
        {
          key: 'q1',
          type: 'multiple_choice',
          textKey: 't.q1',
          multi: false,
          options: [
            { key: 'yes', labelKey: 't.yes' },
            { key: 'no', labelKey: 't.no' },
          ],
        },
        {
          key: 'q2',
          type: 'likert',
          textKey: 't.q2',
          scale: { min: 1, max: 5, labelKeys: {}, presentation: 'radio' },
          showIf: { op: 'eq', question: 'q1', value: 'yes' },
        },
      ],
    },
    {
      key: 's2',
      showIf: { op: 'eq', question: 'q1', value: 'yes' },
      questions: [
        { key: 'c_note', type: 'content', textKey: 't.c', bodyKey: 't.cb', required: false },
        {
          key: 'q3',
          type: 'multiple_choice',
          textKey: 't.q3',
          multi: false,
          options: [
            { key: 'a', labelKey: 't.a' },
            { key: 'b', labelKey: 't.b' },
          ],
        },
        {
          key: 'q4',
          type: 'free_text',
          textKey: 't.q4',
          multiline: false,
          showIf: { op: 'gte', question: 'q2', value: 3 },
        },
      ],
    },
    {
      key: 's3',
      questions: [
        {
          key: 'q5',
          type: 'free_text',
          textKey: 't.q5',
          multiline: false,
          showIf: { op: 'answered', question: 'q3' },
        },
      ],
    },
  ],
};
const branching = questionnaireDefinitionSchema.parse(branchingInput);

function visible(answersMap: AnswersMap) {
  const v = computeVisibility(branching, answersMap);
  return {
    sections: [...v.visibleSectionKeys].sort(),
    questions: [...v.visibleQuestionKeys].sort(),
  };
}

describe('computeVisibility', () => {
  it('the branching fixture passes the semantic validator (backward refs only)', () => {
    expect(checkSemantics(branching)).toEqual([]);
  });

  it('shows everything without showIf, hides conditional items when unanswered', () => {
    expect(visible({})).toEqual({
      sections: ['s1', 's3'], // s2 hidden: q1 unanswered
      questions: ['q1'], // q2 needs q1=yes; q5 needs q3 answered (q3 hidden with s2)
    });
  });

  it('reveals dependent questions and sections when the condition is met', () => {
    const a: AnswersMap = { q1: record({ type: 'multiple_choice', value: 'yes' }) };
    expect(visible(a)).toEqual({
      sections: ['s1', 's2', 's3'],
      questions: ['c_note', 'q1', 'q2', 'q3'], // q4 needs q2>=3; q5 needs q3 answered
    });
  });

  it('section-level showIf hides the whole section including its questions', () => {
    const a: AnswersMap = { q1: record({ type: 'multiple_choice', value: 'no' }) };
    expect(visible(a)).toEqual({
      sections: ['s1', 's3'],
      questions: ['q1'],
    });
  });

  it('cascades: an answer to a hidden question cannot satisfy later conditions', () => {
    // q3 was answered while visible; flipping q1 to 'no' hides s2 (and q3),
    // so q5 (answered q3) must hide too even though the record is retained.
    const a: AnswersMap = {
      q1: record({ type: 'multiple_choice', value: 'no' }),
      q3: record({ type: 'multiple_choice', value: 'a' }),
    };
    expect(visible(a)).toEqual({
      sections: ['s1', 's3'],
      questions: ['q1'],
    });
  });

  it('cascades through question-level hides inside a visible section', () => {
    // q2 answered 5 while visible; flipping q1 to 'no' hides q2, which must
    // drag q4 (q2 >= 3) down with it even though s2 would otherwise... s2 is
    // also condition-hidden here, so probe the question-level chain directly:
    // q1='yes' keeps everything eligible; retained q2 record only counts if
    // q2 itself is visible.
    const met: AnswersMap = {
      q1: record({ type: 'multiple_choice', value: 'yes' }),
      q2: record({ type: 'likert', value: 5 }),
    };
    expect(visible(met).questions).toContain('q4');

    const broken: AnswersMap = {
      q1: record({ type: 'multiple_choice', value: 'no' }),
      q2: record({ type: 'likert', value: 5 }),
    };
    expect(visible(broken).questions).not.toContain('q4');
  });

  it('full chain: all conditions met shows every section and question', () => {
    const a: AnswersMap = {
      q1: record({ type: 'multiple_choice', value: 'yes' }),
      q2: record({ type: 'likert', value: 3 }),
      q3: record({ type: 'multiple_choice', value: 'b' }),
    };
    expect(visible(a)).toEqual({
      sections: ['s1', 's2', 's3'],
      questions: ['c_note', 'q1', 'q2', 'q3', 'q4', 'q5'],
    });
  });

  it('ignores stray answer records under content keys', () => {
    // Even if a bogus record sneaks in under a content key, it never becomes
    // usable — content is never answered (spec 07).
    const contentRef = questionnaireDefinitionSchema.parse({
      ...branchingInput,
      sections: [
        {
          key: 'only',
          questions: [
            { key: 'c1', type: 'content', textKey: 't.c1', bodyKey: 't.b', required: false },
            {
              key: 'q_after',
              type: 'free_text',
              textKey: 't.qa',
              multiline: false,
              showIf: { op: 'answered', question: 'c1' },
            },
          ],
        },
      ],
    });
    const v = computeVisibility(contentRef, {
      c1: record({ type: 'free_text', value: 'sneaky' }),
    });
    expect(v.visibleQuestionKeys.has('q_after')).toBe(false);
  });

  it('is deterministic: same inputs always produce the same result', () => {
    const a: AnswersMap = {
      q1: record({ type: 'multiple_choice', value: 'yes' }),
      q2: record({ type: 'likert', value: 4 }),
    };
    expect(visible(a)).toEqual(visible(a));
  });

  it('does not mutate the answers map', () => {
    const a: AnswersMap = { q1: record({ type: 'multiple_choice', value: 'yes' }) };
    const snapshot = JSON.parse(JSON.stringify(a));
    computeVisibility(branching, a);
    expect(a).toEqual(snapshot);
  });
});
