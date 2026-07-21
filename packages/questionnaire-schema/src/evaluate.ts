import type { AnswerRecord, AnswersMap } from '@assessify/domain';

import type { Condition } from './condition';
import type { QuestionnaireDefinition } from './schema';

/**
 * Pure `showIf` condition evaluator (C5 — spec 07 "Rendering & flow").
 *
 * Shared by the questionnaire session service (server-authoritative progress,
 * submit gating, hidden-answer flagging) and the respondent renderer (reactive
 * client-side show/hide). No I/O, no framework imports — safe in any bundle.
 *
 * ## Evaluation-order semantics (normative for this codebase)
 *
 * The semantic validator (semantic.ts) guarantees `showIf` only references
 * questions strictly EARLIER in document order (and section conditions only
 * reference questions in PRECEDING sections), so visibility is computed in a
 * single document-order pass and is fully deterministic — cycles cannot
 * exist in a valid definition.
 *
 * Cascading hides: a question hidden by branching cannot satisfy another
 * condition. Concretely, an answer only becomes "usable" for later conditions
 * once its question has been evaluated as visible (its section visible AND its
 * own `showIf` true). Retained-but-hidden answers (spec 07: answers are kept
 * and flagged at submit) are therefore invisible to the evaluator.
 *
 * Leaf-operator semantics against an unusable reference (unanswered, hidden,
 * or unknown question):
 *
 * - every leaf operator evaluates to `false` — including `neq`, which reads
 *   as "answered (and visible) with a different value". A question never
 *   reveals itself off the back of missing data.
 * - `not` negates its sub-condition as usual, so `not(answered q)` is `true`
 *   for an unanswered/hidden `q` — that is the explicit way to branch on
 *   absence.
 *
 * Value comparison is strict (`===`, no type coercion: `3 !== '3'`). For
 * multi-select `multiple_choice` answers, `eq`/`in` test set membership of
 * the selected option keys ("contains"). `gt`/`gte`/`lt`/`lte` apply only to
 * numeric answers (likert / numeric); everything else compares `false`.
 * Structured values (matrix, ranking, ipsative) support `answered` only.
 */

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/**
 * Scalar values of an answer that `eq` / `neq` / `in` can compare against.
 * Structured answers (matrix, ranking, ipsative) have no defined scalar
 * comparison and yield an empty list.
 */
function comparableValues(record: AnswerRecord): (string | number)[] {
  switch (record.type) {
    case 'likert':
    case 'numeric':
      return [record.value];
    case 'free_text':
      return [record.value];
    case 'multiple_choice':
      return Array.isArray(record.value) ? record.value : [record.value];
    case 'matrix':
    case 'ranking':
    case 'ipsative_most_least':
      return [];
  }
}

/** Numeric value for ordering comparisons; only likert/numeric answers have one. */
function numericValue(record: AnswerRecord): number | undefined {
  return record.type === 'likert' || record.type === 'numeric' ? record.value : undefined;
}

/**
 * Evaluate a single condition against a map of USABLE answers — i.e. answers
 * whose questions are currently visible. `computeVisibility` builds that map
 * for you; only call this directly when every answer in `answers` is known to
 * be visible (e.g. unit tests).
 */
export function evaluateCondition(condition: Condition, answers: AnswersMap): boolean {
  switch (condition.op) {
    case 'answered':
      return answers[condition.question] !== undefined;
    case 'eq': {
      const record = answers[condition.question];
      return record !== undefined && comparableValues(record).includes(condition.value);
    }
    case 'neq': {
      // "Answered with a different value" — false when unanswered/hidden.
      const record = answers[condition.question];
      return record !== undefined && !comparableValues(record).includes(condition.value);
    }
    case 'in': {
      const record = answers[condition.question];
      if (record === undefined) return false;
      const values = comparableValues(record);
      return condition.values.some((candidate) => values.includes(candidate));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const record = answers[condition.question];
      if (record === undefined) return false;
      const value = numericValue(record);
      if (value === undefined) return false;
      if (condition.op === 'gt') return value > condition.value;
      if (condition.op === 'gte') return value >= condition.value;
      if (condition.op === 'lt') return value < condition.value;
      return value <= condition.value;
    }
    case 'and':
      return condition.conditions.every((c) => evaluateCondition(c, answers));
    case 'or':
      return condition.conditions.some((c) => evaluateCondition(c, answers));
    case 'not':
      return !evaluateCondition(condition.condition, answers);
  }
}

// ---------------------------------------------------------------------------
// Whole-definition visibility
// ---------------------------------------------------------------------------

export interface QuestionnaireVisibility {
  /** Keys of sections whose `showIf` (if any) currently evaluates true. */
  visibleSectionKeys: ReadonlySet<string>;
  /**
   * Keys of questions that are currently visible: their section is visible
   * AND their own `showIf` (if any) evaluates true. Includes `content` items.
   */
  visibleQuestionKeys: ReadonlySet<string>;
}

/**
 * Compute section + question visibility for a whole definition in one
 * document-order pass (see module docs for the cascading semantics).
 */
export function computeVisibility(
  definition: QuestionnaireDefinition,
  answers: AnswersMap
): QuestionnaireVisibility {
  const visibleSectionKeys = new Set<string>();
  const visibleQuestionKeys = new Set<string>();
  /** Answers of questions already evaluated as visible (document order). */
  const usable: AnswersMap = {};

  for (const section of definition.sections) {
    const sectionVisible = section.showIf === undefined || evaluateCondition(section.showIf, usable);
    if (sectionVisible) visibleSectionKeys.add(section.key);
    for (const question of section.questions) {
      const questionVisible =
        sectionVisible &&
        (question.showIf === undefined || evaluateCondition(question.showIf, usable));
      if (!questionVisible) continue;
      visibleQuestionKeys.add(question.key);
      // `content` is never answered (spec 07) — a stray record under a content
      // key must not satisfy conditions.
      if (question.type === 'content') continue;
      const record = answers[question.key];
      if (record !== undefined) usable[question.key] = record;
    }
  }

  return { visibleSectionKeys, visibleQuestionKeys };
}
