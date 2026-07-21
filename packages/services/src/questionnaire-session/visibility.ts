import type { AnswersMap } from '@assessify/domain';
import {
  computeVisibility,
  type Question,
  type QuestionnaireDefinition,
  type QuestionnaireVisibility,
  type Section,
} from '@assessify/questionnaire-schema';

/**
 * Branching visibility hook (spec 07 "Rendering & flow").
 *
 * C2 left this seam with an `alwaysVisible` default; C5 filled it with
 * `showIfVisibility`, backed by the pure `computeVisibility` evaluator in
 * @assessify/questionnaire-schema (shared with the renderer and the
 * definition validator). Cascading semantics require whole-definition
 * context, so both methods take the definition alongside the item.
 */
export interface VisibilityEvaluator {
  isSectionVisible(
    definition: QuestionnaireDefinition,
    section: Section,
    answers: AnswersMap
  ): boolean;
  isQuestionVisible(
    definition: QuestionnaireDefinition,
    question: Question,
    answers: AnswersMap
  ): boolean;
}

/** Everything-visible evaluator (pre-C5 behaviour; useful in tests). */
export const alwaysVisible: VisibilityEvaluator = {
  isSectionVisible: () => true,
  isQuestionVisible: () => true,
};

/**
 * Per-(definition, answers) memo so the per-item interface stays O(1) amortised
 * while the service iterates a whole definition against the same answers
 * object. Referentially transparent: same inputs, same result.
 */
const memo = new WeakMap<QuestionnaireDefinition, WeakMap<AnswersMap, QuestionnaireVisibility>>();

function cachedVisibility(
  definition: QuestionnaireDefinition,
  answers: AnswersMap
): QuestionnaireVisibility {
  let byAnswers = memo.get(definition);
  if (!byAnswers) {
    byAnswers = new WeakMap();
    memo.set(definition, byAnswers);
  }
  let visibility = byAnswers.get(answers);
  if (!visibility) {
    visibility = computeVisibility(definition, answers);
    byAnswers.set(answers, visibility);
  }
  return visibility;
}

/**
 * The real `showIf` evaluator (C5): document-order, cascading — a question
 * hidden by branching cannot satisfy another condition. See
 * @assessify/questionnaire-schema `evaluate.ts` for the normative semantics.
 */
export const showIfVisibility: VisibilityEvaluator = {
  isSectionVisible: (definition, section, answers) =>
    cachedVisibility(definition, answers).visibleSectionKeys.has(section.key),
  isQuestionVisible: (definition, question, answers) =>
    cachedVisibility(definition, answers).visibleQuestionKeys.has(question.key),
};
