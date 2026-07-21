import type { AnswersMap } from '@assessify/domain';
import {
  computeVisibility,
  type QuestionnaireVisibility,
} from '@assessify/questionnaire-schema';

import type { Definition, Question, Section } from './renderer';

/**
 * Client-side branching helpers (C5 — spec 07 "Rendering & flow").
 *
 * The renderer mirrors the server's visibility with the SAME pure evaluator
 * (`computeVisibility` from @assessify/questionnaire-schema — zod-only, safe
 * in the client bundle), so questions show/hide reactively as answers change
 * while the server stays authoritative at save/submit time.
 */

export { computeVisibility };
export type { QuestionnaireVisibility };

/** Sections currently visible, in document order. */
export function visibleSections(
  definition: Definition,
  visibility: QuestionnaireVisibility
): Section[] {
  return definition.sections.filter((section) => visibility.visibleSectionKeys.has(section.key));
}

/** Questions of a section that are currently visible, in document order. */
export function visibleSectionQuestions(
  section: Section,
  visibility: QuestionnaireVisibility
): Question[] {
  return section.questions.filter((question) => visibility.visibleQuestionKeys.has(question.key));
}

export interface ProgressCounts {
  answeredCount: number;
  totalCount: number;
}

/**
 * answered/total of currently-visible required questions — the same formula
 * the service uses for server-side progress (spec 07 progress bar), computed
 * locally so the bar reacts before the next autosave round-trip.
 */
export function visibleProgress(
  definition: Definition,
  answers: AnswersMap,
  visibility: QuestionnaireVisibility
): ProgressCounts {
  let totalCount = 0;
  let answeredCount = 0;
  for (const section of visibleSections(definition, visibility)) {
    for (const question of visibleSectionQuestions(section, visibility)) {
      if (question.type === 'content' || !question.required) continue;
      totalCount += 1;
      if (answers[question.key] !== undefined) answeredCount += 1;
    }
  }
  return { answeredCount, totalCount };
}

/**
 * Visible required questions in a section that have no answer yet
 * (client-side next-section gate; hidden questions are never required).
 */
export function unansweredRequired(
  section: Section,
  answers: AnswersMap,
  visibility: QuestionnaireVisibility
): Question[] {
  return visibleSectionQuestions(section, visibility).filter(
    (q) => q.type !== 'content' && q.required && answers[q.key] === undefined
  );
}

/**
 * Map the server's resume index (into `definition.sections`) onto the
 * VISIBLE section list: the resumed section itself when visible, else the
 * nearest earlier visible section (first section is always visible in a
 * valid definition — its `showIf` could only reference earlier questions,
 * of which there are none).
 */
export function initialVisibleSectionIndex(
  definition: Definition,
  answers: AnswersMap,
  definitionSectionIndex: number
): number {
  const visibility = computeVisibility(definition, answers);
  let result = 0;
  let visibleIndex = -1;
  for (let i = 0; i < definition.sections.length && i <= definitionSectionIndex; i += 1) {
    const section = definition.sections[i];
    if (section && visibility.visibleSectionKeys.has(section.key)) {
      visibleIndex += 1;
      result = visibleIndex;
    }
  }
  return result;
}
