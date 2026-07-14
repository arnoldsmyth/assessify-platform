import { z } from 'zod';
import { conditionSchema } from './condition';

/**
 * Zod schemas for the questionnaire JSON definition format
 * (docs/spec/07-questionnaire-engine.md, "Definition schema").
 *
 * All user-facing text fields hold translation string KEYS (resolved against
 * `translation_strings` at render time), never literal copy. Presence of the
 * keys in the translation table is checked at admin import time, not here.
 */

/** Stable identifier: section keys, question keys, option keys. */
const keySchema = z.string().min(1);

/** Translation string key (`titleKey`, `textKey`, `labelKey`, ...). */
const translationKeySchema = z.string().min(1);

export const optionSchema = z
  .object({
    key: keySchema,
    labelKey: translationKeySchema,
  })
  .strict();

/**
 * Likert/matrix scale. `labelKeys` is keyed by scale point; JSON object keys
 * are strings, so integer-shaped strings are required.
 */
const scalePointLabelKeys = z.record(
  z.string().regex(/^-?\d+$/, 'labelKeys keys must be integer scale points'),
  translationKeySchema
);

const scaleBounds = {
  min: z.number().int(),
  max: z.number().int(),
  labelKeys: scalePointLabelKeys,
};

const questionBaseShape = {
  key: keySchema,
  textKey: translationKeySchema,
  helpKey: translationKeySchema.optional(),
  required: z.boolean().default(true),
  showIf: conditionSchema.optional(),
};

export const likertQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('likert'),
    scale: z
      .object({
        ...scaleBounds,
        presentation: z.enum(['radio', 'slider']),
      })
      .strict()
      .refine((s) => s.max > s.min, {
        message: 'scale.max must be greater than scale.min',
        path: ['max'],
      }),
  })
  .strict();

/** Cross-field rule (see questionSchema): minSelections <= maxSelections. */
export const multipleChoiceQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('multiple_choice'),
    options: z.array(optionSchema).min(1),
    multi: z.boolean(),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z.number().int().min(1).optional(),
  })
  .strict();

/** Validator rule: matrix questions have at most 12 rows. */
export const matrixQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('matrix'),
    rows: z.array(optionSchema).min(1).max(12, 'matrix questions allow at most 12 rows'),
    scale: z
      .object(scaleBounds)
      .strict()
      .refine((s) => s.max > s.min, {
        message: 'scale.max must be greater than scale.min',
        path: ['max'],
      }),
  })
  .strict();

/** Cross-field rule (see questionSchema): max > min. */
export const numericQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('numeric'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive('step must be a positive number'),
    unitKey: translationKeySchema.optional(),
    presentation: z.enum(['slider', 'input']),
  })
  .strict();

/** Validator rule: ranking questions have at most 10 options. */
export const rankingQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('ranking'),
    options: z
      .array(optionSchema)
      .min(2, 'ranking needs at least 2 options to order')
      .max(10, 'ranking questions allow at most 10 options'),
  })
  .strict();

export const freeTextQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('free_text'),
    multiline: z.boolean(),
    minWords: z.number().int().min(0).optional(),
    maxWords: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).optional(),
  })
  .strict();

/** Validator rule: ipsative blocks have at least 3 items. */
export const ipsativeMostLeastQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('ipsative_most_least'),
    items: z.array(optionSchema).min(3, 'ipsative blocks need at least 3 items'),
  })
  .strict();

/** Non-response section content; never answered. */
export const contentQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('content'),
    bodyKey: translationKeySchema,
    mediaUrl: z.string().url().optional(),
  })
  .strict();

/**
 * All 9 question types. Cross-field rules that would wrap the member schemas
 * in ZodEffects (not allowed inside a discriminated union) live in the
 * superRefine below instead.
 */
export const questionSchema = z
  .discriminatedUnion('type', [
    likertQuestionSchema,
    multipleChoiceQuestionSchema,
    matrixQuestionSchema,
    numericQuestionSchema,
    rankingQuestionSchema,
    freeTextQuestionSchema,
    ipsativeMostLeastQuestionSchema,
    contentQuestionSchema,
  ])
  .superRefine((q, ctx) => {
    if (
      q.type === 'multiple_choice' &&
      q.minSelections !== undefined &&
      q.maxSelections !== undefined &&
      q.minSelections > q.maxSelections
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minSelections must be less than or equal to maxSelections',
        path: ['minSelections'],
      });
    }
    if (q.type === 'numeric' && q.max <= q.min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'max must be greater than min',
        path: ['max'],
      });
    }
    if (
      q.type === 'free_text' &&
      q.minWords !== undefined &&
      q.maxWords !== undefined &&
      q.minWords > q.maxWords
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minWords must be less than or equal to maxWords',
        path: ['minWords'],
      });
    }
  });

export const sectionSchema = z
  .object({
    key: keySchema,
    titleKey: translationKeySchema.optional(),
    instructionsKey: translationKeySchema.optional(),
    showIf: conditionSchema.optional(),
    questions: z.array(questionSchema).min(1),
  })
  .strict();

export const questionnaireSettingsSchema = z
  .object({
    progressBar: z.boolean(),
    allowBack: z.boolean(),
    randomizeSections: z.array(keySchema).optional(),
  })
  .strict();

/**
 * Shape-only schema for a questionnaire definition. Use `validateDefinition`
 * (validate.ts) to also apply the semantic rules (unique keys, backward-only
 * `showIf` references, ...).
 */
export const questionnaireDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: keySchema,
    titleKey: translationKeySchema,
    settings: questionnaireSettingsSchema,
    sections: z.array(sectionSchema).min(1),
  })
  .strict();

export type Option = z.infer<typeof optionSchema>;
export type LikertQuestion = z.infer<typeof likertQuestionSchema>;
export type MultipleChoiceQuestion = z.infer<typeof multipleChoiceQuestionSchema>;
export type MatrixQuestion = z.infer<typeof matrixQuestionSchema>;
export type NumericQuestion = z.infer<typeof numericQuestionSchema>;
export type RankingQuestion = z.infer<typeof rankingQuestionSchema>;
export type FreeTextQuestion = z.infer<typeof freeTextQuestionSchema>;
export type IpsativeMostLeastQuestion = z.infer<typeof ipsativeMostLeastQuestionSchema>;
export type ContentQuestion = z.infer<typeof contentQuestionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type QuestionType = Question['type'];
export type Section = z.infer<typeof sectionSchema>;
export type QuestionnaireSettings = z.infer<typeof questionnaireSettingsSchema>;
export type QuestionnaireDefinition = z.infer<typeof questionnaireDefinitionSchema>;

/** Input shape (before defaults such as `required: true` are applied). */
export type QuestionnaireDefinitionInput = z.input<typeof questionnaireDefinitionSchema>;
