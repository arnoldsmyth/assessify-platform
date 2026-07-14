import { referencedQuestionKeys, type Condition } from './condition';
import type { QuestionnaireDefinition } from './schema';

/**
 * Semantic validator rules from docs/spec/07-questionnaire-engine.md:
 *
 * - unique keys (sections, questions, options/rows/items within a question)
 * - `showIf` references only questions EARLIER in document order
 *   (no forward or circular references, no self-references)
 * - `showIf` cannot reference `content` blocks (they are never answered)
 * - `settings.randomizeSections` entries must name existing sections
 *
 * Ipsative >= 3 items, ranking <= 10 options and matrix <= 12 rows are
 * enforced by the shape schema (schema.ts). The "every *Key exists in
 * translation_strings" rule needs the product's translation table and is
 * enforced at admin import time, not by this standalone validator.
 */

export interface SemanticIssue {
  /** JSON path segments into the definition document. */
  path: (string | number)[];
  message: string;
}

interface QuestionPosition {
  /** Global document-order index across all sections. */
  index: number;
  type: string;
}

export function checkSemantics(definition: QuestionnaireDefinition): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  // --- unique section keys -------------------------------------------------
  const sectionKeys = new Map<string, number>();
  definition.sections.forEach((section, s) => {
    const firstSeen = sectionKeys.get(section.key);
    if (firstSeen !== undefined) {
      issues.push({
        path: ['sections', s, 'key'],
        message: `duplicate section key "${section.key}" (already used by sections[${firstSeen}])`,
      });
    } else {
      sectionKeys.set(section.key, s);
    }
  });

  // --- unique question keys (global: answers are keyed by question key) ----
  const questionPositions = new Map<string, QuestionPosition>();
  let globalIndex = 0;
  definition.sections.forEach((section, s) => {
    section.questions.forEach((question, q) => {
      const existing = questionPositions.get(question.key);
      if (existing) {
        issues.push({
          path: ['sections', s, 'questions', q, 'key'],
          message: `duplicate question key "${question.key}" — question keys must be unique across the whole definition`,
        });
      } else {
        questionPositions.set(question.key, { index: globalIndex, type: question.type });
      }
      globalIndex += 1;
    });
  });

  // --- unique option/row/item keys within each question ---------------------
  definition.sections.forEach((section, s) => {
    section.questions.forEach((question, q) => {
      const optionSets: [string, { key: string }[]][] = [];
      if (question.type === 'multiple_choice' || question.type === 'ranking') {
        optionSets.push(['options', question.options]);
      } else if (question.type === 'matrix') {
        optionSets.push(['rows', question.rows]);
      } else if (question.type === 'ipsative_most_least') {
        optionSets.push(['items', question.items]);
      }
      for (const [field, entries] of optionSets) {
        const seen = new Set<string>();
        entries.forEach((entry, i) => {
          if (seen.has(entry.key)) {
            issues.push({
              path: ['sections', s, 'questions', q, field, i, 'key'],
              message: `duplicate ${field.replace(/s$/, '')} key "${entry.key}" within question "${question.key}"`,
            });
          }
          seen.add(entry.key);
        });
      }
    });
  });

  // --- randomizeSections must reference existing sections -------------------
  definition.settings.randomizeSections?.forEach((key, i) => {
    if (!sectionKeys.has(key)) {
      issues.push({
        path: ['settings', 'randomizeSections', i],
        message: `randomizeSections references unknown section key "${key}"`,
      });
    }
  });

  // --- showIf references: existing, answerable, strictly earlier ------------
  const checkCondition = (
    condition: Condition,
    path: (string | number)[],
    /** Global index the referenced question must come strictly before. */
    beforeIndex: number,
    context: string
  ): void => {
    for (const ref of referencedQuestionKeys(condition)) {
      const target = questionPositions.get(ref);
      if (!target) {
        issues.push({
          path,
          message: `${context} references unknown question "${ref}"`,
        });
        continue;
      }
      if (target.type === 'content') {
        issues.push({
          path,
          message: `${context} references content block "${ref}" — content is never answered`,
        });
        continue;
      }
      if (target.index >= beforeIndex) {
        issues.push({
          path,
          message: `${context} references "${ref}", which does not come earlier in document order — showIf may only reference earlier questions (no forward or circular references)`,
        });
      }
    }
  };

  globalIndex = 0;
  definition.sections.forEach((section, s) => {
    if (section.showIf) {
      // A section condition must be decidable before the section is entered:
      // it may only reference questions in PRECEDING sections.
      checkCondition(
        section.showIf,
        ['sections', s, 'showIf'],
        globalIndex,
        `sections[${s}] ("${section.key}") showIf`
      );
    }
    section.questions.forEach((question, q) => {
      if (question.showIf) {
        checkCondition(
          question.showIf,
          ['sections', s, 'questions', q, 'showIf'],
          globalIndex,
          `question "${question.key}" showIf`
        );
      }
      globalIndex += 1;
    });
  });

  return issues;
}
