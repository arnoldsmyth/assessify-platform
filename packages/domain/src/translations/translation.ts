import { z } from 'zod';

import { languageTagSchema } from '../products';

/**
 * Translation strings (spec 04 `translation_strings`, spec 07 localisation
 * model). Questionnaire definitions contain translation KEYS only; the copy
 * for each product+language lives here. Missing keys in a requested language
 * fall back to the product's default language (spec 07 validator rules:
 * default-language coverage is mandatory, other languages only warn).
 */

/** e.g. `q1.text`, `sec1.title` — authored in the questionnaire definition. */
export const translationKeySchema = z.string().trim().min(1).max(200);

export const translationStringSchema = z.object({
  productId: z.string().uuid(),
  stringKey: translationKeySchema,
  language: languageTagSchema,
  value: z.string(),
  updatedAt: z.coerce.date(),
});

/** One row of `translation_strings` (composite PK product+key+language). */
export type TranslationString = z.infer<typeof translationStringSchema>;
