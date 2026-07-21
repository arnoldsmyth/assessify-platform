// Postgres (Drizzle) repositories.
import { createDb } from '@assessify/db';

import {
  createQuestionnaireVersionRepository,
  type QuestionnaireVersionRepository,
} from './postgres/questionnaire-versions';
import { DrizzleProductRepository } from './products/drizzle-product-repository';
import type { ProductRepository } from './products/product-repository';
import { DrizzleResponseRepository, type ResponseRepository } from './postgres/responses';
import {
  createTranslationStringRepository,
  type TranslationStringRepository,
} from './postgres/translation-strings';

export * from './audit-log';
export { getDbHandle } from './postgres/client';
export {
  createQuestionnaireVersionRepository,
  type QuestionnaireVersion,
  type QuestionnaireVersionRepository,
  type QuestionnaireVersionStatus,
} from './postgres/questionnaire-versions';
export {
  createOrderRepository,
  type NewOrder,
  type NewOrderItem,
  type NewOrderRespondent,
  type NewOrderSession,
  type OrderListQuery,
  type OrderPage,
  type OrderRepository,
  type OrderStatusListQuery,
  type OrderStatusPatch,
} from './postgres/orders';
export {
  createClientRepository,
  type ClientRepository,
  type ClientSummary,
} from './postgres/clients';
export {
  createNotificationLogRepository,
  type NotificationLogCreate,
  type NotificationLogRepository,
} from './postgres/notification-log';
export {
  createCustomDomainRepository,
  type ActiveCustomDomain,
  type CustomDomainRepository,
} from './postgres/custom-domains';
export {
  createPaymentRepository,
  type PaymentCreate,
  type PaymentRepository,
  type PaymentStatusPatch,
} from './postgres/payments';
export {
  createRoleAssignmentRepository,
  type RoleAssignmentRepository,
} from './postgres/role-assignments';
export {
  createRespondentSessionRepository,
  type RespondentSessionRepository,
} from './postgres/respondent-sessions';
export {
  createScoringJobRepository,
  type ScoringJobCreate,
  type ScoringJobRepository,
} from './postgres/scoring-jobs';
export {
  createInMemoryPinAttemptStore,
  type PinAttemptState,
  type PinAttemptStore,
} from './respondent-access/pin-attempt-store';
export {
  createResponseRepository,
  DrizzleResponseRepository,
  type ResponseRepository,
} from './postgres/responses';
export {
  createTranslationStringRepository,
  type TranslationStringRepository,
} from './postgres/translation-strings';

export type {
  ProductListQuery,
  ProductPage,
  ProductPatch,
  ProductRepository,
} from './products/product-repository';
export { DrizzleProductRepository } from './products/drizzle-product-repository';

export interface Repositories {
  products: ProductRepository;
  questionnaireVersions: QuestionnaireVersionRepository;
  /** Questionnaire response store (Neon jsonb — A4). */
  responses: ResponseRepository;
  /** Translation strings per product+language (B4). */
  translationStrings: TranslationStringRepository;
  /** Drain the underlying pg pool (worker/app shutdown). */
  close(): Promise<void>;
}

/**
 * Composition helper: build the full Drizzle repository set from a Postgres
 * connection string. Called from composition roots (via the service layer's
 * default wiring) — apps never import repositories or db directly
 * (.dependency-cruiser.cjs).
 */
export function createRepositories(connectionString: string): Repositories {
  const { db, pool } = createDb(connectionString);
  return {
    products: new DrizzleProductRepository(db),
    questionnaireVersions: createQuestionnaireVersionRepository(db),
    responses: new DrizzleResponseRepository(db),
    translationStrings: createTranslationStringRepository(db),
    close: async () => {
      await pool.end();
    },
  };
}
