import { z } from 'zod';

/**
 * Structured branching logic (docs/spec/07-questionnaire-engine.md).
 *
 * `question` always refers to a question `key`; the semantic validator
 * (semantic.ts) enforces that references point at existing, earlier,
 * answerable questions.
 */
export type Condition =
  | { op: 'answered'; question: string }
  | { op: 'eq' | 'neq'; question: string; value: string | number }
  | { op: 'in'; question: string; values: (string | number)[] }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; question: string; value: number }
  | { op: 'and' | 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

const questionKey = z.string().min(1);

const answeredCondition = z
  .object({ op: z.literal('answered'), question: questionKey })
  .strict();

const equalityCondition = (op: 'eq' | 'neq') =>
  z
    .object({
      op: z.literal(op),
      question: questionKey,
      value: z.union([z.string(), z.number()]),
    })
    .strict();

const inCondition = z
  .object({
    op: z.literal('in'),
    question: questionKey,
    values: z.array(z.union([z.string(), z.number()])).min(1),
  })
  .strict();

const comparisonCondition = (op: 'gt' | 'gte' | 'lt' | 'lte') =>
  z
    .object({ op: z.literal(op), question: questionKey, value: z.number() })
    .strict();

const logicalCondition = (op: 'and' | 'or') =>
  z
    .object({
      op: z.literal(op),
      conditions: z.array(z.lazy(() => conditionSchema)).min(1),
    })
    .strict();

const notCondition = z
  .object({ op: z.literal('not'), condition: z.lazy(() => conditionSchema) })
  .strict();

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    answeredCondition,
    equalityCondition('eq'),
    equalityCondition('neq'),
    inCondition,
    comparisonCondition('gt'),
    comparisonCondition('gte'),
    comparisonCondition('lt'),
    comparisonCondition('lte'),
    logicalCondition('and'),
    logicalCondition('or'),
    notCondition,
  ])
);

/** Collect every question key referenced anywhere inside a condition tree. */
export function referencedQuestionKeys(condition: Condition): string[] {
  switch (condition.op) {
    case 'answered':
    case 'eq':
    case 'neq':
    case 'in':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return [condition.question];
    case 'and':
    case 'or':
      return condition.conditions.flatMap(referencedQuestionKeys);
    case 'not':
      return referencedQuestionKeys(condition.condition);
  }
}
