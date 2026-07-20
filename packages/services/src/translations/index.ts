export {
  createTranslationService,
  importTranslationsSchema,
  type ImportTranslationsInput,
  type LanguageCoverage,
  type ResolvedTranslations,
  type TranslationCoverage,
  type TranslationImportSummary,
  type TranslationService,
  type TranslationServiceDeps,
} from './translation-service';
export { collectTranslationKeys } from './translation-keys';
export { getTranslationService } from './default';
// Entity type re-exported for controllers — apps never import repositories
// or domain internals directly for this (.dependency-cruiser.cjs).
export type { TranslationString } from '@assessify/domain';
