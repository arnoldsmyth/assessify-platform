import {
  answersPatchSchema,
  err,
  languageTagSchema,
  ok,
  questionKeySchema,
  uuidv7,
  type AnswerRecord,
  type AnswersMap,
  type AnswersPatch,
  type DomainError,
  type QuestionnaireResponse,
  type RespondentSessionPayload,
  type ResponseProgress,
  type ResponseStatus,
  type Result,
} from '@assessify/domain';
import {
  questionnaireDefinitionSchema,
  type Question,
  type QuestionnaireDefinition,
  type Section,
} from '@assessify/questionnaire-schema';
import type {
  ProductRepository,
  QuestionnaireVersionRepository,
  RespondentSessionRepository,
  ResponseRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import { noopScoringDispatcher, type ScoringDispatcher } from '../scoring/dispatcher';
import { collectTranslationKeys } from '../translations/translation-keys';
import type { TranslationService } from '../translations/translation-service';
import { saveIssues, submitIssues } from './answer-validation';
import { showIfVisibility, type VisibilityEvaluator } from './visibility';

/**
 * Questionnaire session service (C2 — spec 07 "Rendering & flow").
 *
 * Everything the respondent surface needs behind one seam: load renderer
 * state (pinned definition + saved answers + progress → resume), autosave
 * answer flushes, track section position, and submit. Controllers stay thin:
 * they pass the raw `resp_session` cookie value through — session identity
 * ALWAYS comes from the validated signed payload, never from a
 * client-supplied id.
 *
 * Immutability (spec 07 "Completion"): once a response is submitted every
 * write path returns `questionnaire/already_submitted`; the repository's
 * `status = 'draft'` guards are the race-free backstop.
 *
 * No PII anywhere in errors or audit detail — only ids, question keys and
 * machine-readable issue codes (never answer values).
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RendererState {
  /** The pinned, already-validated questionnaire definition. */
  definition: QuestionnaireDefinition;
  answers: AnswersMap;
  progress: ResponseProgress;
  status: ResponseStatus;
  /** Section index to resume at (0 when there is no saved position). */
  resumeSectionIndex: number;
  /**
   * Active display language (asy-sex): the stored choice when the product
   * still offers it, else the product's default language. Never null — the
   * renderer always has a concrete language to resolve against.
   */
  language: string;
  /** Languages the respondent may switch to (`products.available_languages`). */
  availableLanguages: string[];
  /** The product's default language (the translation fallback source). */
  defaultLanguage: string;
  /**
   * Server-resolved translation copy for `language` (translation key →
   * string, default-language fallback already applied — B4 `resolve`). Keys
   * with no copy in any language are absent; the renderer falls back to the
   * humanized key form for those.
   */
  strings: Record<string, string>;
  /** Non-null once submitted (ISO-8601). */
  completedAt: string | null;
}

export interface SaveAnswersOutcome {
  savedKeys: string[];
  progress: ResponseProgress;
}

export interface SubmitOutcome {
  completedAt: string;
  progress: ResponseProgress;
}

export interface QuestionnaireSessionService {
  /**
   * Resolve the signed session cookie into full renderer state, creating the
   * draft response on first load (resume-safe) and transitioning the session
   * to `started`.
   */
  loadState(sessionToken: unknown): Promise<Result<RendererState>>;
  /**
   * Persist a debounced autosave flush: a map of questionKey → answer record.
   * Validates every record against the pinned definition; rejects the whole
   * patch when any record is malformed (autosave retries with corrected
   * state), and always recomputes progress server-side.
   */
  saveAnswers(sessionToken: unknown, patch: unknown): Promise<Result<SaveAnswersOutcome>>;
  /** Record the section the respondent is on (resume position). */
  savePosition(sessionToken: unknown, sectionKey: unknown): Promise<Result<ResponseProgress>>;
  /**
   * Validate that every currently-visible required question is answered (and
   * answered completely), flag hidden answers, mark the response submitted
   * and the session completed, and audit the submission.
   */
  submit(sessionToken: unknown): Promise<Result<SubmitOutcome>>;
  /**
   * C6: switch the respondent's display language mid-flight. Rejects
   * languages the product does not offer; persists the choice on the draft
   * response row (the renderer's single source of truth), after which
   * `loadState` resolves translations in the new language. Answers are
   * language-independent option/question keys and are NEVER touched by a
   * switch (spec 07 "switching mid-flight is lossless").
   */
  setLanguage(sessionToken: unknown, language: unknown): Promise<Result<SetLanguageOutcome>>;
}

export interface SetLanguageOutcome {
  language: string;
}

/** Narrow B4 port (asy-sex): exactly the resolution half of the translation
 * service — the session service never imports its admin surface. */
export type TranslationResolver = Pick<TranslationService, 'resolve'>;

export interface QuestionnaireSessionServiceDeps {
  /** C1 seam: validates the signed `resp_session` payload. */
  access: {
    validateSessionToken(sessionToken: unknown): Promise<Result<RespondentSessionPayload>>;
  };
  sessions: RespondentSessionRepository;
  versions: QuestionnaireVersionRepository;
  responses: ResponseRepository;
  /** Language metadata source (available/default languages per product). */
  products: Pick<ProductRepository, 'findById'>;
  /** B4 seam (asy-sex): server-side translation resolution for the renderer. */
  translations: TranslationResolver;
  audit: AuditService;
  /** C5 seam: `showIf` evaluation. Defaults to the real branching evaluator. */
  visibility?: VisibilityEvaluator;
  /**
   * E1 seam: submit → scoring dispatch (spec 08 "session completed →
   * scoringService.dispatch"). Defaults to a no-op where the composition
   * root has no scoring wiring; dispatch failures never fail the submit —
   * the scoring service audits them and admin retry/re-score catches up.
   */
  scoring?: ScoringDispatcher;
  now?: () => Date;
  newId?: () => string;
}

// ---------------------------------------------------------------------------
// Errors (namespaced; messages are respondent-safe, detail is ids/codes only)
// ---------------------------------------------------------------------------

function versionNotFound(): DomainError {
  return {
    code: 'questionnaire/version_not_found',
    message: 'This assessment is not available. Please contact your administrator.',
  };
}

function definitionInvalid(): DomainError {
  return {
    code: 'questionnaire/definition_invalid',
    message: 'This assessment is not available. Please contact your administrator.',
  };
}

function responseNotFound(): DomainError {
  return {
    code: 'questionnaire/response_not_found',
    message: 'Your questionnaire could not be found. Please reopen your invitation link.',
  };
}

function alreadySubmitted(): DomainError {
  return {
    code: 'questionnaire/already_submitted',
    message: 'Your answers have already been submitted and can no longer be changed.',
  };
}

function answersInvalid(issues: Record<string, string[]>): DomainError {
  return {
    code: 'questionnaire/answers_invalid',
    message: 'Some answers could not be saved. Please review and try again.',
    detail: { issues },
  };
}

function sectionInvalid(): DomainError {
  return {
    code: 'questionnaire/section_invalid',
    message: 'That section does not exist in this questionnaire.',
  };
}

function languageInvalid(): DomainError {
  return {
    code: 'questionnaire/language_invalid',
    message: 'That language code is not valid.',
  };
}

function languageUnavailable(language: string, availableLanguages: string[]): DomainError {
  return {
    code: 'questionnaire/language_unavailable',
    message: 'That language is not available for this assessment.',
    detail: { language, availableLanguages },
  };
}

function incomplete(missing: string[], invalid: Record<string, string[]>): DomainError {
  return {
    code: 'questionnaire/incomplete',
    message: 'Please answer all required questions before submitting.',
    detail: { missing, invalid },
  };
}

// ---------------------------------------------------------------------------
// Definition helpers (all iteration goes through the visibility evaluator)
// ---------------------------------------------------------------------------

function questionsByKey(definition: QuestionnaireDefinition): Map<string, Question> {
  const map = new Map<string, Question>();
  for (const section of definition.sections) {
    for (const question of section.questions) map.set(question.key, question);
  }
  return map;
}

function visibleSections(
  definition: QuestionnaireDefinition,
  answers: AnswersMap,
  visibility: VisibilityEvaluator
): Section[] {
  return definition.sections.filter((s) => visibility.isSectionVisible(definition, s, answers));
}

/** Currently-visible questions, flattened. */
function visibleQuestions(
  definition: QuestionnaireDefinition,
  answers: AnswersMap,
  visibility: VisibilityEvaluator
): Question[] {
  return visibleSections(definition, answers, visibility).flatMap((section) =>
    section.questions.filter((q) => visibility.isQuestionVisible(definition, q, answers))
  );
}

/**
 * Progress = answered / total of currently-visible required questions
 * (spec 07 progress bar semantics). `content` items never count.
 */
function computeProgress(
  definition: QuestionnaireDefinition,
  answers: AnswersMap,
  visibility: VisibilityEvaluator,
  currentSectionKey: string | null
): ResponseProgress {
  let total = 0;
  let answered = 0;
  for (const question of visibleQuestions(definition, answers, visibility)) {
    if (question.type === 'content' || !question.required) continue;
    total += 1;
    if (answers[question.key] !== undefined) answered += 1;
  }
  const sectionExists =
    currentSectionKey !== null &&
    definition.sections.some((section) => section.key === currentSectionKey);
  return {
    currentSectionKey: sectionExists ? currentSectionKey : null,
    answeredCount: answered,
    totalCount: total,
  };
}

/**
 * Active display language: the stored choice while the product still offers
 * it, else the product's default. Pure so both loadState and tests share it.
 */
function activeLanguage(
  stored: string | null | undefined,
  availableLanguages: string[],
  defaultLanguage: string
): string {
  return stored && availableLanguages.includes(stored) ? stored : defaultLanguage;
}

function sameProgress(a: ResponseProgress, b: ResponseProgress): boolean {
  return (
    a.currentSectionKey === b.currentSectionKey &&
    a.answeredCount === b.answeredCount &&
    a.totalCount === b.totalCount
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createQuestionnaireSessionService(
  deps: QuestionnaireSessionServiceDeps
): QuestionnaireSessionService {
  const { access, sessions, versions, responses, products, translations, audit } = deps;
  const visibility = deps.visibility ?? showIfVisibility;
  const scoring = deps.scoring ?? noopScoringDispatcher;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? uuidv7;

  /** Cookie → sessionId; access errors pass through untouched so the
   * controller can route back to PIN entry. */
  async function resolveSessionId(sessionToken: unknown): Promise<Result<string>> {
    const validated = await access.validateSessionToken(sessionToken);
    if (!validated.ok) return validated;
    return ok(validated.value.sessionId);
  }

  /** Load the pinned definition for a response, Zod-validated at the boundary. */
  async function loadDefinition(
    questionnaireVersionId: string
  ): Promise<Result<QuestionnaireDefinition>> {
    const version = await versions.findById(questionnaireVersionId);
    if (!version) return err(versionNotFound());
    const parsed = questionnaireDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) return err(definitionInvalid());
    return ok(parsed.data);
  }

  /** Shared preamble for the write paths: draft response + definition. */
  async function loadDraft(
    sessionToken: unknown
  ): Promise<Result<{ response: QuestionnaireResponse; definition: QuestionnaireDefinition }>> {
    const sessionId = await resolveSessionId(sessionToken);
    if (!sessionId.ok) return sessionId;
    const response = await responses.findBySessionId(sessionId.value);
    if (!response) return err(responseNotFound());
    if (response.status !== 'draft') return err(alreadySubmitted());
    const definition = await loadDefinition(response.questionnaireVersionId);
    if (!definition.ok) return definition;
    return ok({ response, definition: definition.value });
  }

  return {
    async loadState(sessionToken) {
      const sessionId = await resolveSessionId(sessionToken);
      if (!sessionId.ok) return sessionId;
      const session = await sessions.findById(sessionId.value);
      // validateSessionToken guarantees existence; a vanished row means the
      // cookie is worthless.
      if (!session) return err(responseNotFound());

      const definition = await loadDefinition(session.questionnaireVersionId);
      if (!definition.ok) return definition;
      const version = await versions.findById(session.questionnaireVersionId);
      if (!version) return err(versionNotFound());

      const at = now();
      let response = await responses.getOrCreate({
        id: newId(),
        sessionId: session.id,
        orderId: session.orderId,
        productId: version.productId,
        questionnaireVersionId: session.questionnaireVersionId,
        language: session.language,
        startedAt: at,
      });

      // Opening the questionnaire is what starts a session (spec 04/07).
      if (session.status === 'created' || session.status === 'invited') {
        await sessions.markStarted(session.id, at);
      }

      // Recompute progress totals against the live definition + visibility so
      // resume never trusts a stale snapshot (first load starts at 0/0).
      if (response.status === 'draft') {
        const fresh = computeProgress(
          definition.value,
          response.answers,
          visibility,
          response.progress.currentSectionKey
        );
        if (!sameProgress(fresh, response.progress)) {
          response = (await responses.updateProgress(session.id, fresh)) ?? response;
        }
      }

      // Localisation (asy-sex — spec 07): the definition carries translation
      // KEYS; resolve the copy server-side for the active language. The
      // respondent's choice lives on the response row (seeded from the
      // session's language at creation, updated by setLanguage/C6). Both
      // product lookup and resolution fail SOFT: a broken translation setup
      // must never block answering — the renderer humanizes unresolved keys.
      const product = await products.findById(version.productId);
      const defaultLanguage = product?.defaultLanguage ?? 'en';
      const availableLanguages = product?.availableLanguages ?? [defaultLanguage];
      const language = activeLanguage(
        response.language ?? session.language,
        availableLanguages,
        defaultLanguage
      );
      const resolved = await translations.resolve(
        version.productId,
        language,
        collectTranslationKeys(definition.value)
      );
      const strings = resolved.ok ? resolved.value.strings : {};

      const sectionIndex = definition.value.sections.findIndex(
        (section) => section.key === response.progress.currentSectionKey
      );
      return ok({
        definition: definition.value,
        answers: response.answers,
        progress: response.progress,
        status: response.status,
        resumeSectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
        language,
        availableLanguages,
        defaultLanguage,
        strings,
        completedAt: response.completedAt ? response.completedAt.toISOString() : null,
      });
    },

    async saveAnswers(sessionToken, patch) {
      const draft = await loadDraft(sessionToken);
      if (!draft.ok) return draft;
      const { response, definition } = draft.value;

      const parsed = answersPatchSchema.safeParse(patch);
      if (!parsed.success) {
        return err(answersInvalid({ _patch: ['malformed_patch'] }));
      }

      const byKey = questionsByKey(definition);
      const issues: Record<string, string[]> = {};
      for (const [key, record] of Object.entries(parsed.data)) {
        const question = byKey.get(key);
        if (!question) {
          issues[key] = ['unknown_question'];
          continue;
        }
        const recordIssues = saveIssues(question, record);
        if (recordIssues.length > 0) issues[key] = recordIssues;
      }
      if (Object.keys(issues).length > 0) return err(answersInvalid(issues));

      const updated = await responses.patchAnswers(response.sessionId, parsed.data);
      if (!updated) return err(alreadySubmitted());

      const progress = computeProgress(
        definition,
        updated.answers,
        visibility,
        updated.progress.currentSectionKey
      );
      const withProgress = await responses.updateProgress(response.sessionId, progress);
      return ok({
        savedKeys: Object.keys(parsed.data),
        progress: withProgress?.progress ?? progress,
      });
    },

    async savePosition(sessionToken, sectionKey) {
      const draft = await loadDraft(sessionToken);
      if (!draft.ok) return draft;
      const { response, definition } = draft.value;

      const parsedKey = questionKeySchema.safeParse(sectionKey);
      if (!parsedKey.success) return err(sectionInvalid());
      const section = definition.sections.find((s) => s.key === parsedKey.data);
      if (!section || !visibility.isSectionVisible(definition, section, response.answers)) {
        return err(sectionInvalid());
      }

      const progress = computeProgress(definition, response.answers, visibility, parsedKey.data);
      const updated = await responses.updateProgress(response.sessionId, progress);
      if (!updated) return err(alreadySubmitted());
      return ok(updated.progress);
    },

    async setLanguage(sessionToken, language) {
      const parsed = languageTagSchema.safeParse(language);
      if (!parsed.success) return err(languageInvalid());

      const draft = await loadDraft(sessionToken);
      if (!draft.ok) return draft;
      const { response, definition } = draft.value;

      // Spec 07 "Language switching": the switcher lists (and the service
      // only accepts) the product's available languages.
      const product = await products.findById(response.productId);
      const availableLanguages = product?.availableLanguages ?? [];
      if (!availableLanguages.includes(parsed.data)) {
        return err(languageUnavailable(parsed.data, availableLanguages));
      }

      // Persist on the response row ONLY — the renderer's single source of
      // truth for the active language. Progress is recomputed as on every
      // other write path; answers are language-independent keys and are
      // never touched (lossless switching, spec 07).
      const progress = computeProgress(
        definition,
        response.answers,
        visibility,
        response.progress.currentSectionKey
      );
      const updated = await responses.updateProgress(response.sessionId, progress, {
        language: parsed.data,
      });
      if (!updated) return err(alreadySubmitted());
      return ok({ language: updated.language ?? parsed.data });
    },

    async submit(sessionToken) {
      const draft = await loadDraft(sessionToken);
      if (!draft.ok) return draft;
      const { response, definition } = draft.value;
      const answers = response.answers;

      // Server-side completeness gate (spec 07 "Completion"): every visible
      // required question answered, every visible answer complete.
      const missing: string[] = [];
      const invalid: Record<string, string[]> = {};
      const visibleKeys = new Set<string>();
      for (const question of visibleQuestions(definition, answers, visibility)) {
        if (question.type === 'content') continue;
        visibleKeys.add(question.key);
        const record = answers[question.key];
        if (record === undefined) {
          if (question.required) missing.push(question.key);
          continue;
        }
        const recordIssues = submitIssues(question, record);
        if (recordIssues.length > 0) invalid[question.key] = recordIssues;
      }
      if (missing.length > 0 || Object.keys(invalid).length > 0) {
        return err(incomplete(missing, invalid));
      }

      // Retain-but-flag answers whose question is currently hidden by
      // branching (spec 07): scoring adapters decide whether to use them.
      const byKey = questionsByKey(definition);
      const hiddenPatch: AnswersPatch = {};
      for (const [key, record] of Object.entries(answers)) {
        if (byKey.has(key) && !visibleKeys.has(key) && record.hidden !== true) {
          hiddenPatch[key] = { ...record, hidden: true } as AnswerRecord;
        }
      }
      if (Object.keys(hiddenPatch).length > 0) {
        const flagged = await responses.patchAnswers(response.sessionId, hiddenPatch);
        if (!flagged) return err(alreadySubmitted());
      }

      const at = now();
      const submitted = await responses.markSubmitted(response.sessionId, at);
      if (!submitted) return err(alreadySubmitted());
      await sessions.markCompleted(response.sessionId, at);

      const audited = await audit.record(
        { kind: 'respondent', id: response.sessionId },
        'questionnaire_response.submitted',
        { type: 'questionnaire_response', id: response.id },
        {
          sessionId: response.sessionId,
          questionnaireVersionId: response.questionnaireVersionId,
          answeredCount: submitted.progress.answeredCount,
          totalCount: submitted.progress.totalCount,
        }
      );
      if (!audited.ok) return err(audited.error);

      // E1 hook (spec 08): the completed session triggers scoring dispatch.
      // A failed dispatch never fails the submit — the answers are safely
      // immutable, the scoring service audits its own failures, and admin
      // retry/re-score picks the session up from the error queue.
      await scoring.dispatch(response.sessionId);

      return ok({ completedAt: at.toISOString(), progress: submitted.progress });
    },
  };
}
