import type { AnswerRecord, AnswersMap } from '@assessify/domain';
import {
  questionnaireDefinitionSchema,
  type QuestionnaireDefinitionInput,
} from '@assessify/questionnaire-schema';
import { describe, expect, it } from 'vitest';

import {
  computeVisibility,
  initialVisibleSectionIndex,
  unansweredRequired,
  visibleProgress,
  visibleSectionQuestions,
  visibleSections,
} from './visibility';

const AT = '2026-07-20T10:00:00.000Z';

function record(
  partial: Partial<AnswerRecord> & Pick<AnswerRecord, 'type' | 'value'>
): AnswerRecord {
  return { answeredAt: AT, ...partial } as AnswerRecord;
}

/**
 * s1: q_gate (yes/no) + q_dep (required, showIf q_gate = 'yes')
 * s2: showIf q_gate = 'yes' — note (content) + q_s2 (required)
 * s3: q_end (required, always visible)
 */
const definitionInput: QuestionnaireDefinitionInput = {
  schemaVersion: 1,
  key: 'client-branching',
  titleKey: 'c.title',
  settings: { progressBar: true, allowBack: true },
  sections: [
    {
      key: 's1',
      questions: [
        {
          key: 'q_gate',
          type: 'multiple_choice',
          textKey: 'c.gate',
          multi: false,
          options: [
            { key: 'yes', labelKey: 'c.yes' },
            { key: 'no', labelKey: 'c.no' },
          ],
        },
        {
          key: 'q_dep',
          type: 'likert',
          textKey: 'c.dep',
          scale: { min: 1, max: 5, labelKeys: {}, presentation: 'radio' },
          showIf: { op: 'eq', question: 'q_gate', value: 'yes' },
        },
      ],
    },
    {
      key: 's2',
      showIf: { op: 'eq', question: 'q_gate', value: 'yes' },
      questions: [
        { key: 'note', type: 'content', textKey: 'c.n', bodyKey: 'c.nb', required: false },
        { key: 'q_s2', type: 'free_text', textKey: 'c.s2', multiline: false },
      ],
    },
    {
      key: 's3',
      questions: [{ key: 'q_end', type: 'free_text', textKey: 'c.end', multiline: false }],
    },
  ],
};
const definition = questionnaireDefinitionSchema.parse(definitionInput);

const gateYes: AnswersMap = { q_gate: record({ type: 'multiple_choice', value: 'yes' }) };
const gateNo: AnswersMap = { q_gate: record({ type: 'multiple_choice', value: 'no' }) };

describe('visibleSections / visibleSectionQuestions', () => {
  it('filters hidden sections and questions, preserving document order', () => {
    const hidden = computeVisibility(definition, gateNo);
    expect(visibleSections(definition, hidden).map((s) => s.key)).toEqual(['s1', 's3']);
    const s1 = definition.sections[0]!;
    expect(visibleSectionQuestions(s1, hidden).map((q) => q.key)).toEqual(['q_gate']);

    const shown = computeVisibility(definition, gateYes);
    expect(visibleSections(definition, shown).map((s) => s.key)).toEqual(['s1', 's2', 's3']);
    expect(visibleSectionQuestions(s1, shown).map((q) => q.key)).toEqual(['q_gate', 'q_dep']);
  });
});

describe('visibleProgress', () => {
  it('counts only visible required questions (content excluded)', () => {
    const hidden = computeVisibility(definition, gateNo);
    expect(visibleProgress(definition, gateNo, hidden)).toEqual({
      answeredCount: 1, // q_gate
      totalCount: 2, // q_gate + q_end
    });

    const shown = computeVisibility(definition, gateYes);
    expect(visibleProgress(definition, gateYes, shown)).toEqual({
      answeredCount: 1,
      totalCount: 4, // q_gate + q_dep + q_s2 + q_end
    });
  });
});

describe('unansweredRequired', () => {
  it('never demands answers to questions hidden by branching', () => {
    const s1 = definition.sections[0]!;
    const hidden = computeVisibility(definition, gateNo);
    expect(unansweredRequired(s1, gateNo, hidden)).toEqual([]);

    const shown = computeVisibility(definition, gateYes);
    expect(unansweredRequired(s1, gateYes, shown).map((q) => q.key)).toEqual(['q_dep']);
  });
});

describe('initialVisibleSectionIndex', () => {
  it('keeps the resumed section when it is visible', () => {
    expect(initialVisibleSectionIndex(definition, gateYes, 1)).toBe(1); // s2
    expect(initialVisibleSectionIndex(definition, gateYes, 2)).toBe(2); // s3
  });

  it('falls back to the nearest earlier visible section when hidden', () => {
    // s2 (definition index 1) is hidden → resume at s1 (visible index 0);
    // s3 (definition index 2) maps to visible index 1.
    expect(initialVisibleSectionIndex(definition, gateNo, 1)).toBe(0);
    expect(initialVisibleSectionIndex(definition, gateNo, 2)).toBe(1);
    expect(initialVisibleSectionIndex(definition, {}, 0)).toBe(0);
  });
});
