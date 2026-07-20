import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { responseStatus } from './enums';
import { products, questionnaireVersions } from './catalogue';
import { orders, respondentSessions } from './orders';

// Response store (A4 re-scope, 2026-07-14): the Firestore collections from
// docs/spec/04-data-model.md ("Firestore collections") translated to Neon
// Postgres jsonb. Accessed only from the server via packages/repositories.

/**
 * One row per respondent session — the former `responses/{sessionId}` doc.
 *
 * `answers` is `{ [questionKey]: { type, value, answeredAt, hidden? } }`
 * (value shapes per spec 07; option KEYS stored, never display text).
 * Partial saves are applied as a top-level jsonb merge (`answers || patch`),
 * so each answer record is replaced atomically without read-modify-write.
 *
 * No PII lives here (spec 04 "PII separation"): rows reference session ids
 * only. Answers are never mutated after submit (`status = 'submitted'`).
 */
export const questionnaireResponses = pgTable(
  'questionnaire_responses',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .unique()
      .notNull()
      .references(() => respondentSessions.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** Pinned per session (spec 07: in-flight sessions never migrate versions). */
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id),
    /** Respondent's display language at last save (answers are language-agnostic). */
    language: text('language'),
    status: responseStatus('status').notNull().default('draft'),
    /** { [questionKey]: { type, value, answeredAt, hidden? } } */
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
    /** { currentSectionKey, answeredCount, totalCount } — recomputed server-side. */
    progress: jsonb('progress')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ currentSectionKey: null, answeredCount: 0, totalCount: 0 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set exactly once at submit; answers are immutable afterwards. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('responses_order_idx').on(t.orderId),
    index('responses_product_status_idx').on(t.productId, t.status),
  ]
);

/**
 * Append-only fine-grained response events — the former
 * `response_events/{sessionId}/events/{autoId}` subcollection
 * (optional in spec 04, phase 1.5+; table lands now so the shape is settled).
 */
export const questionnaireResponseEvents = pgTable(
  'questionnaire_response_events',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => respondentSessions.id),
    /** e.g. 'answer_saved' | 'section_entered' | 'submitted' */
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('response_events_session_idx').on(t.sessionId, t.createdAt)]
);
