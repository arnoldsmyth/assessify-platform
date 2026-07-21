import {
  err,
  isSuperAdmin,
  languageTagSchema,
  ok,
  orgScopeIds,
  translationKeySchema,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Product,
  type Result,
  type TranslationString,
} from '@assessify/domain';
import type {
  ProductRepository,
  QuestionnaireVersionRepository,
  TranslationStringRepository,
} from '@assessify/repositories';
import { z } from 'zod';

import type { AuditService } from '../audit';
import { collectTranslationKeys } from './translation-keys';

/**
 * Translation strings storage + resolution (B4 — spec 07 localisation model,
 * spec 04 `translation_strings`). Questionnaire definitions carry translation
 * KEYS only; the copy per product+language lives in `translation_strings`.
 *
 * Resolution rule (spec 07): a key missing in the requested language falls
 * back to the product's **default language**; which keys fell back is
 * reported so the UI can badge untranslated copy. Default-language coverage
 * is mandatory at definition import time, other languages only warn — so
 * fallback is the expected steady state for partially translated products.
 *
 * Authorization (spec 05 permission matrix — assessment_admin "manage
 * questionnaire/report versions and translations", re-scoped per owner
 * decisions 2026-07-21): super_admin, or assessment_admin scoped to the
 * product's ORGANIZATION. `resolve` is
 * intentionally caller-free: it serves the respondent renderer (C2), which
 * has no admin caller — translation strings are respondent-facing copy, not
 * sensitive data.
 */

export interface TranslationImportSummary {
  productId: string;
  language: string;
  /** Number of keys upserted (inserted or overwritten). */
  importedCount: number;
  keys: string[];
}

export interface ResolvedTranslations {
  productId: string;
  /** The language that was requested. */
  language: string;
  /** The product's default language (fallback source). */
  defaultLanguage: string;
  /** Resolved copy: requested-language value, else default-language value. */
  strings: Record<string, string>;
  /** Keys that fell back to the default language — badge as untranslated. */
  fallbackKeys: string[];
  /**
   * Keys with no value in either language. Only non-empty when `keys` were
   * requested explicitly (without a key set there is nothing to miss against).
   */
  missingKeys: string[];
}

export interface LanguageCoverage {
  language: string;
  /** True for the product's default language (the fallback source). */
  isDefault: boolean;
  translatedCount: number;
  missingCount: number;
  missingKeys: string[];
}

/** Per-language coverage of a questionnaire version's translation key set. */
export interface TranslationCoverage {
  questionnaireVersionId: string;
  productId: string;
  version: number;
  variant: string;
  totalKeys: number;
  /** Default language first, then A→Z. */
  languages: LanguageCoverage[];
}

export interface TranslationService {
  /**
   * Bulk import/upsert of translations for one product+language (JSON upload
   * shape `{language, strings: {key: value}}` plus the productId from the
   * route). Existing keys are overwritten; keys absent from the upload are
   * left untouched. Records an audit event.
   */
  importTranslations(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<TranslationImportSummary>>;
  /**
   * Resolve strings for a product+language with default-language fallback.
   * Omit `keys` to resolve every key known for the product in either the
   * requested or the default language (what the renderer wants for a version
   * it has already key-collected — or pass the version's keys explicitly to
   * also learn which are missing entirely).
   */
  resolve(
    productId: string,
    language: string,
    keys?: string[]
  ): Promise<Result<ResolvedTranslations>>;
  /**
   * Coverage report for a questionnaire version's key set: per language,
   * how many keys are translated / missing (B3 follow-up — lets the import
   * UI show coverage per version).
   */
  coverageForVersion(
    caller: CallerContext,
    questionnaireVersionId: string
  ): Promise<Result<TranslationCoverage>>;
}

export interface TranslationServiceDeps {
  translationStrings: TranslationStringRepository;
  products: ProductRepository;
  questionnaireVersions: QuestionnaireVersionRepository;
  audit: AuditService;
  now?: () => Date;
}

export const importTranslationsSchema = z.object({
  productId: z.string().uuid(),
  language: languageTagSchema,
  strings: z
    .record(translationKeySchema, z.string().min(1).max(20_000))
    .refine((strings) => Object.keys(strings).length > 0, {
      message: 'strings must contain at least one key',
    }),
});
export type ImportTranslationsInput = z.infer<typeof importTranslationsSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forbidden(caller: CallerContext): DomainError {
  return {
    code: 'translation/forbidden',
    message: 'Only super admins or the product’s assessment admins can manage translations',
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

/**
 * Spec 05 re-scoped (M2, owner decisions 2026-07-21): manage translations =
 * super_admin, or assessment_admin of the product's organization.
 */
function canManage(caller: CallerContext, product: Product): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(product.organizationId);
}

function productNotFound(productId: string): DomainError {
  return {
    code: 'translation/product_not_found',
    message: 'Product not found',
    detail: { productId },
  };
}

function versionNotFound(id: string): DomainError {
  return {
    code: 'translation/version_not_found',
    message: 'Questionnaire version not found',
    detail: { id },
  };
}

function validationError(issues: { path: string; message: string }[]): DomainError {
  return {
    code: 'translation/validation',
    message: 'Translation import payload failed validation',
    detail: { issues },
  };
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

function valuesByKey(rows: TranslationString[]): Map<string, string> {
  return new Map(rows.map((row) => [row.stringKey, row.value]));
}

export function createTranslationService(deps: TranslationServiceDeps): TranslationService {
  const { translationStrings, products, questionnaireVersions, audit } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async importTranslations(caller, input) {
      const parsed = importTranslationsSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            }))
          )
        );
      }
      const { productId, language, strings } = parsed.data;

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      // Languages are declared on the product first (spec 04
      // `products.available_languages`) — an import for an undeclared
      // language is almost certainly a typo in the upload's `language`.
      if (!product.availableLanguages.includes(language)) {
        return err({
          code: 'translation/language_not_available',
          message: `Language '${language}' is not in the product's available languages`,
          detail: { language, availableLanguages: product.availableLanguages },
        });
      }

      const upserted = await translationStrings.upsertMany(productId, language, strings, now());

      const audited = await audit.record(
        auditActor(caller),
        'translations.imported',
        { type: 'product', id: productId },
        { language, keyCount: upserted.length }
      );
      if (!audited.ok) return err(audited.error);

      return ok({
        productId,
        language,
        importedCount: upserted.length,
        keys: upserted.map((row) => row.stringKey).sort(),
      });
    },

    async resolve(productId, language, keys) {
      if (!UUID_RE.test(productId)) return err(productNotFound(productId));
      const languageParsed = languageTagSchema.safeParse(language);
      if (!languageParsed.success) {
        return err(
          validationError([{ path: 'language', message: languageParsed.error.issues[0]?.message ?? 'invalid language' }])
        );
      }

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      const defaultLanguage = product.defaultLanguage;

      const requested = valuesByKey(
        await translationStrings.findByLanguage(productId, language, keys)
      );
      const fallback =
        language === defaultLanguage
          ? requested
          : valuesByKey(await translationStrings.findByLanguage(productId, defaultLanguage, keys));

      // Explicit key set → resolve exactly those (and report true misses);
      // otherwise resolve every key known in either language.
      const keySet = keys ?? [...new Set([...requested.keys(), ...fallback.keys()])].sort();

      const strings: Record<string, string> = {};
      const fallbackKeys: string[] = [];
      const missingKeys: string[] = [];
      for (const key of keySet) {
        const value = requested.get(key);
        if (value !== undefined) {
          strings[key] = value;
          continue;
        }
        const fallbackValue = fallback.get(key);
        if (fallbackValue !== undefined) {
          strings[key] = fallbackValue;
          fallbackKeys.push(key);
        } else {
          missingKeys.push(key);
        }
      }

      return ok({ productId, language, defaultLanguage, strings, fallbackKeys, missingKeys });
    },

    async coverageForVersion(caller, questionnaireVersionId) {
      if (!UUID_RE.test(questionnaireVersionId)) return err(versionNotFound(questionnaireVersionId));
      const version = await questionnaireVersions.findById(questionnaireVersionId);
      if (!version) return err(versionNotFound(questionnaireVersionId));

      const product = await products.findById(version.productId);
      if (!product) return err(productNotFound(version.productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      const keys = collectTranslationKeys(version.definition);

      // Report every declared language plus any language that already has
      // strings (e.g. imported before being removed from the product).
      const languages = [
        ...new Set([
          ...product.availableLanguages,
          ...(await translationStrings.listLanguages(version.productId)),
        ]),
      ].sort(
        (a, b) =>
          Number(b === product.defaultLanguage) - Number(a === product.defaultLanguage) ||
          a.localeCompare(b)
      );

      const perLanguage: LanguageCoverage[] = [];
      for (const language of languages) {
        const translated = valuesByKey(
          await translationStrings.findByLanguage(version.productId, language, keys)
        );
        const missingKeys = keys.filter((key) => !translated.has(key));
        perLanguage.push({
          language,
          isDefault: language === product.defaultLanguage,
          translatedCount: keys.length - missingKeys.length,
          missingCount: missingKeys.length,
          missingKeys,
        });
      }

      return ok({
        questionnaireVersionId,
        productId: version.productId,
        version: version.version,
        variant: version.variant,
        totalKeys: keys.length,
        languages: perLanguage,
      });
    },
  };
}
