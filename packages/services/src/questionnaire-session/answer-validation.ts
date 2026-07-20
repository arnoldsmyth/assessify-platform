import type { AnswerRecord } from '@assessify/domain';
import type { Question } from '@assessify/questionnaire-schema';

/**
 * Definition-aware answer validation (spec 07 "Answer value shapes").
 *
 * The domain `answerRecordSchema` guarantees each record is structurally
 * well-formed for its type; these checks add what only the questionnaire
 * definition knows: the question exists, the record type matches the question
 * type, option/row keys are real, and numeric values sit inside the declared
 * scale/bounds.
 *
 * Two tiers, matching autosave semantics:
 *  - `saveIssues`   — hard shape rules enforced on every autosave flush. A
 *    draft may be *incomplete* (e.g. two of five matrix rows) but never
 *    *malformed* (an option key that does not exist).
 *  - `submitIssues` — completeness rules enforced at submit on answered
 *    questions (min selections, min words, all matrix rows), mirroring the
 *    client-side checks server-side as spec 07 requires.
 *
 * Issue strings are machine-usable codes with no respondent content — safe
 * for `DomainError.detail` and logs (free-text answers never appear).
 */

function optionKeys(options: readonly { key: string }[]): Set<string> {
  return new Set(options.map((o) => o.key));
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Hard shape violations for one answer record against its question. */
export function saveIssues(question: Question, record: AnswerRecord): string[] {
  if (question.type === 'content') return ['content_not_answerable'];
  if (record.type !== question.type) return ['type_mismatch'];
  const issues: string[] = [];

  switch (question.type) {
    case 'likert': {
      if (record.type !== 'likert') break;
      const { min, max } = question.scale;
      if (!Number.isInteger(record.value) || record.value < min || record.value > max) {
        issues.push('value_out_of_scale');
      }
      break;
    }
    case 'numeric': {
      if (record.type !== 'numeric') break;
      if (record.value < question.min || record.value > question.max) {
        issues.push('value_out_of_range');
      }
      break;
    }
    case 'multiple_choice': {
      if (record.type !== 'multiple_choice') break;
      const known = optionKeys(question.options);
      if (question.multi) {
        if (!Array.isArray(record.value)) {
          issues.push('expected_multiple_selection');
          break;
        }
        if (new Set(record.value).size !== record.value.length) {
          issues.push('duplicate_option');
        }
        if (record.value.some((key) => !known.has(key))) issues.push('unknown_option');
        if (question.maxSelections !== undefined && record.value.length > question.maxSelections) {
          issues.push('too_many_selections');
        }
      } else {
        if (Array.isArray(record.value)) {
          issues.push('expected_single_selection');
          break;
        }
        if (!known.has(record.value)) issues.push('unknown_option');
      }
      break;
    }
    case 'matrix': {
      if (record.type !== 'matrix') break;
      const known = optionKeys(question.rows);
      const { min, max } = question.scale;
      for (const [rowKey, value] of Object.entries(record.value)) {
        if (!known.has(rowKey)) issues.push('unknown_row');
        if (!Number.isInteger(value) || value < min || value > max) {
          issues.push('value_out_of_scale');
        }
      }
      break;
    }
    case 'ranking': {
      if (record.type !== 'ranking') break;
      // Spec 07: drag-to-order ALL items — a ranking answer is a full
      // permutation of the option keys, never a subset.
      const known = optionKeys(question.options);
      const isPermutation =
        record.value.length === known.size &&
        new Set(record.value).size === record.value.length &&
        record.value.every((key) => known.has(key));
      if (!isPermutation) issues.push('not_a_permutation_of_options');
      break;
    }
    case 'free_text': {
      if (record.type !== 'free_text') break;
      if (question.maxChars !== undefined && record.value.length > question.maxChars) {
        issues.push('too_many_chars');
      }
      if (question.maxWords !== undefined && wordCount(record.value) > question.maxWords) {
        issues.push('too_many_words');
      }
      break;
    }
    case 'ipsative_most_least': {
      if (record.type !== 'ipsative_most_least') break;
      const known = optionKeys(question.items);
      if (!known.has(record.value.most) || !known.has(record.value.least)) {
        issues.push('unknown_item');
      }
      break;
    }
  }
  // De-duplicate (matrix loops can repeat a code per row).
  return [...new Set(issues)];
}

/** Completeness violations enforced at submit for an ANSWERED question. */
export function submitIssues(question: Question, record: AnswerRecord): string[] {
  const issues: string[] = [];
  switch (question.type) {
    case 'multiple_choice': {
      if (record.type !== 'multiple_choice') break;
      if (
        question.multi &&
        question.minSelections !== undefined &&
        Array.isArray(record.value) &&
        record.value.length < question.minSelections
      ) {
        issues.push('too_few_selections');
      }
      break;
    }
    case 'matrix': {
      if (record.type !== 'matrix') break;
      const answered = new Set(Object.keys(record.value));
      if (question.rows.some((row) => !answered.has(row.key))) {
        issues.push('missing_rows');
      }
      break;
    }
    case 'free_text': {
      if (record.type !== 'free_text') break;
      if (question.minWords !== undefined && wordCount(record.value) < question.minWords) {
        issues.push('too_few_words');
      }
      break;
    }
    default:
      break;
  }
  return issues;
}
