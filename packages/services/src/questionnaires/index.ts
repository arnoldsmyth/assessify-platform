export {
  createQuestionnaireVersionService,
  importQuestionnaireVersionSchema,
  type ActiveQuestionnaireVersion,
  type ImportQuestionnaireVersionInput,
  type QuestionnaireVersionService,
  type QuestionnaireVersionServiceDeps,
} from './questionnaire-version-service';
export { getQuestionnaireVersionService } from './default';
// Entity types re-exported for controllers — apps never import repositories
// directly (.dependency-cruiser.cjs).
export type {
  QuestionnaireVersion,
  QuestionnaireVersionStatus,
} from '@assessify/repositories';
