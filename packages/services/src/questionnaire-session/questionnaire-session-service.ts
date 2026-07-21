import {
  answersPatchSchema,
  err,
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
  QuestionnaireVersionRepository,
  RespondentSessionRepository,
  ResponseRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
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
  /** Respondent's display language, if set on the session. */
  language: string | null;
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
}

export interface QuestionnaireSessionServiceDeps {
  /** C1 seam: validates the signed `resp_session` payload. */
  access: {
    validateSessionToken(sessionToken: unknown): Promise<Result<RespondentSessionPayload>>;
  };
  sessions: RespondentSessionRepository;
  versions: QuestionnaireVersionRepository;
  responses: ResponseRepository;
  audit: AuditService;
  /** C5 seam: `showIf` evaluation. Defaults to the real branching evaluator. */
  visibility?: VisibilityEvaluator;
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
  const { access, sessions, versions, responses, audit } = deps;
  const visibility = deps.visibility ?? showIfVisibility;
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

      const sectionIndex = definition.value.sections.findIndex(
        (section) => section.key === response.progress.currentSectionKey
      );
      return ok({
        definition: definition.value,
        answers: response.answers,
        progress: response.progress,
        status: response.status,
        resumeSectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
        language: response.language,
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

      return ok({ completedAt: at.toISOString(), progress: submitted.progress });
    },
  };
}
