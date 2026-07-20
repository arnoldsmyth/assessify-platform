import type { AnswersMap } from '@assessify/domain';
import type { Question, Section } from '@assessify/questionnaire-schema';

/**
 * Branching visibility hook (spec 07 "Rendering & flow").
 *
 * C5 replaces `alwaysVisible` with an evaluator backed by the pure `showIf`
 * condition function (shared with the definition validator). C2 iterates
 * sections/questions exclusively through this interface, so slotting the real
 * evaluator in is a one-line change at the composition root — nothing else in
 * the renderer or the session service changes.
 */
export interface VisibilityEvaluator {
  isSectionVisible(section: Section, answers: AnswersMap): boolean;
  isQuestionVisible(question: Question, answers: AnswersMap): boolean;
}

/** Pre-C5 default: every section and question is visible. */
export const alwaysVisible: VisibilityEvaluator = {
  isSectionVisible: () => true,
  isQuestionVisible: () => true,
};
