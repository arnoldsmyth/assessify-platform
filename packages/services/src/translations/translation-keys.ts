import type { Question, QuestionnaireDefinition } from '@assessify/questionnaire-schema';

/**
 * Collect every translation string key referenced by a questionnaire
 * definition (spec 07: ALL user-facing text = translation string keys).
 * This is the key set coverage reports are computed against; the renderer
 * (C2) can use it to prefetch exactly the keys a version needs.
 *
 * Returned sorted and de-duplicated (a key may be reused across questions).
 */
export function collectTranslationKeys(definition: QuestionnaireDefinition): string[] {
  const keys = new Set<string>();
  keys.add(definition.titleKey);

  for (const section of definition.sections) {
    if (section.titleKey) keys.add(section.titleKey);
    if (section.instructionsKey) keys.add(section.instructionsKey);
    for (const question of section.questions) {
      collectQuestionKeys(question, keys);
    }
  }

  return [...keys].sort();
}

function collectQuestionKeys(question: Question, keys: Set<string>): void {
  keys.add(question.textKey);
  if (question.helpKey) keys.add(question.helpKey);

  switch (question.type) {
    case 'likert':
    case 'matrix':
      for (const labelKey of Object.values(question.scale.labelKeys)) keys.add(labelKey);
      if (question.type === 'matrix') {
        for (const row of question.rows) keys.add(row.labelKey);
      }
      break;
    case 'multiple_choice':
    case 'ranking':
      for (const option of question.options) keys.add(option.labelKey);
      break;
    case 'numeric':
      if (question.unitKey) keys.add(question.unitKey);
      break;
    case 'ipsative_most_least':
      for (const item of question.items) keys.add(item.labelKey);
      break;
    case 'content':
      keys.add(question.bodyKey);
      break;
    case 'free_text':
      break;
  }
}
