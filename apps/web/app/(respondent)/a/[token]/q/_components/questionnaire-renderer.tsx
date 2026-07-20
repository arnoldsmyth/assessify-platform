'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnswerRecord, AnswersMap, ResponseProgress } from '@assessify/domain';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@assessify/ui';

import { saveAnswersAction, savePositionAction, submitAction } from '../actions';
import { labelFromKey, unansweredRequired, type Definition } from '../_lib/renderer';
import { QuestionInput } from './question-input';

/**
 * Section-by-section questionnaire flow (C2 — spec 07 "Rendering & flow").
 *
 * - Autosave: every answer change is queued and flushed through
 *   `saveAnswersAction` after a short debounce; flushes are forced before any
 *   navigation. A failed flush shows a retry banner and BLOCKS moving to the
 *   next section — answers are never lost silently (spec 07).
 * - Back navigation only when `settings.allowBack`.
 * - Progress bar (when `settings.progressBar`) shows the server-computed
 *   answered/total of currently-visible required questions.
 * - Resume: the server supplies `resumeSectionIndex` from the saved progress.
 * - Submit: review screen → server-side completeness validation → confirmation.
 *
 * Branching (C5) slots in server-side via the service's visibility evaluator;
 * this component renders whatever the definition + state say, so hiding
 * sections/questions client-side is an additive change here.
 */

const AUTOSAVE_DEBOUNCE_MS = 750;

const SESSION_EXPIRED_CODES = new Set([
  'respondent_access/session_invalid',
  'respondent_access/session_expired',
]);

type Phase = 'sections' | 'review' | 'done';

interface QuestionnaireRendererProps {
  token: string;
  definition: Definition;
  initialAnswers: AnswersMap;
  initialProgress: ResponseProgress;
  resumeSectionIndex: number;
}

export function QuestionnaireRenderer({
  token,
  definition,
  initialAnswers,
  initialProgress,
  resumeSectionIndex,
}: QuestionnaireRendererProps) {
  const [answers, setAnswers] = useState<AnswersMap>(initialAnswers);
  const [sectionIndex, setSectionIndex] = useState(resumeSectionIndex);
  const [phase, setPhase] = useState<Phase>('sections');
  const [progress, setProgress] = useState(initialProgress);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [submitMissing, setSubmitMissing] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Latest answers + dirty keys live in refs so the debounced flush always
  // sends current state without re-arming on every keystroke.
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const dirtyRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const keys = [...dirtyRef.current];
    if (keys.length === 0) return true;
    const patch: Record<string, AnswerRecord> = {};
    for (const key of keys) {
      const record = answersRef.current[key];
      if (record) patch[key] = record;
    }
    keys.forEach((key) => dirtyRef.current.delete(key));
    setSaving(true);
    try {
      const result = await saveAnswersAction(patch);
      if (result.ok) {
        setProgress(result.value.progress);
        setSaveError(null);
        return true;
      }
      if (SESSION_EXPIRED_CODES.has(result.error.code)) {
        setSessionExpired(true);
        return false;
      }
      keys.forEach((key) => dirtyRef.current.add(key));
      setSaveError(result.error.message);
      return false;
    } catch {
      keys.forEach((key) => dirtyRef.current.add(key));
      setSaveError('Your answers could not be saved. Check your connection and retry.');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleAnswer = useCallback(
    (questionKey: string, record: AnswerRecord) => {
      setAnswers((prev) => ({ ...prev, [questionKey]: record }));
      dirtyRef.current.add(questionKey);
      setGateMessage(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush]
  );

  // Spec 07: debounced client-side but flushed on blur/navigation — also
  // flush when the tab is hidden (closing the browser mid-section).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flush]);

  const sections = definition.sections;
  const section = sections[Math.min(sectionIndex, sections.length - 1)];
  const allowBack = definition.settings.allowBack;

  async function goTo(nextIndex: number, nextPhase: Phase = 'sections') {
    const flushed = await flush();
    if (!flushed) return; // autosave failure blocks navigation (spec 07)
    setGateMessage(null);
    setPhase(nextPhase);
    setSectionIndex(nextIndex);
    const target = sections[nextIndex];
    if (target && nextPhase === 'sections') {
      // Resume position is best-effort; a failure here never blocks the flow.
      void savePositionAction(target.key).catch(() => undefined);
    }
    window.scrollTo({ top: 0 });
  }

  async function goNext() {
    if (!section) return;
    const missing = unansweredRequired(section, answersRef.current);
    if (missing.length > 0) {
      setGateMessage(
        `Please answer all required questions in this section before continuing (${missing.length} remaining).`
      );
      return;
    }
    if (sectionIndex >= sections.length - 1) {
      const flushed = await flush();
      if (!flushed) return;
      setPhase('review');
      window.scrollTo({ top: 0 });
      return;
    }
    await goTo(sectionIndex + 1);
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const flushed = await flush();
      if (!flushed) return;
      const result = await submitAction();
      if (result.ok || result.error.code === 'questionnaire/already_submitted') {
        setPhase('done');
        return;
      }
      if (SESSION_EXPIRED_CODES.has(result.error.code)) {
        setSessionExpired(true);
        return;
      }
      if (result.error.code === 'questionnaire/incomplete') {
        const detail = (result.error.detail ?? {}) as {
          missing?: string[];
          invalid?: Record<string, string[]>;
        };
        setSubmitMissing([...(detail.missing ?? []), ...Object.keys(detail.invalid ?? {})]);
        return;
      }
      setSaveError(result.error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionExpired) {
    return (
      <RendererShell title={labelFromKey(definition.titleKey)}>
        <div role="alert" className="rounded-md border border-amber/30 bg-amber-tint px-4 py-3 text-sm text-amber">
          Your session has expired. Your answers so far are saved — re-enter your PIN to continue
          where you left off.
        </div>
        <Button asChild className="mt-4">
          <a href={`/a/${token}`}>Re-enter PIN</a>
        </Button>
      </RendererShell>
    );
  }

  if (phase === 'done') {
    return (
      <RendererShell title={labelFromKey(definition.titleKey)}>
        <Card>
          <CardHeader>
            <CardTitle>Thank you — your answers have been submitted</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-body">
              Your responses are locked in and can no longer be changed. You can close this window.
            </p>
          </CardContent>
        </Card>
      </RendererShell>
    );
  }

  if (phase === 'review') {
    return (
      <RendererShell
        title={labelFromKey(definition.titleKey)}
        progress={definition.settings.progressBar ? progress : null}
      >
        <Card>
          <CardHeader>
            <CardTitle>Ready to submit?</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-body">
              You have answered {progress.answeredCount} of {progress.totalCount} required
              questions. Once submitted, your answers cannot be changed.
            </p>
            {submitMissing.length > 0 ? (
              <div role="alert" className="rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm text-red">
                <p className="font-medium">Some questions still need attention:</p>
                <ul className="mt-1 list-inside list-disc">
                  {submitMissing.map((key) => (
                    <li key={key}>{labelFromKey(key)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {saveError ? <SaveErrorBanner message={saveError} saving={saving} onRetry={() => void flush()} /> : null}
            <div className="flex items-center justify-between gap-3">
              {allowBack ? (
                <Button type="button" variant="outline" onClick={() => void goTo(sections.length - 1)}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              <Button type="button" onClick={() => void handleSubmit()} disabled={submitting || saving}>
                {submitting ? 'Submitting…' : 'Submit answers'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </RendererShell>
    );
  }

  if (!section) return null;

  return (
    <RendererShell
      title={labelFromKey(definition.titleKey)}
      progress={definition.settings.progressBar ? progress : null}
      stepper={{ sections, current: sectionIndex }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{section.titleKey ? labelFromKey(section.titleKey) : `Section ${sectionIndex + 1}`}</CardTitle>
          {section.instructionsKey ? (
            <p className="text-sm text-muted">{labelFromKey(section.instructionsKey)}</p>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          {section.questions.map((question) => (
            <div key={question.key} className="flex flex-col gap-3">
              {question.type !== 'content' ? (
                <p className="text-base font-medium text-ink">
                  {labelFromKey(question.textKey)}
                  {question.required ? (
                    <span aria-hidden="true" className="text-red">
                      {' '}
                      *
                    </span>
                  ) : null}
                </p>
              ) : null}
              {question.type !== 'content' && question.helpKey ? (
                <p className="text-sm text-muted">{labelFromKey(question.helpKey)}</p>
              ) : null}
              <QuestionInput question={question} record={answers[question.key]} onAnswer={handleAnswer} />
            </div>
          ))}

          {gateMessage ? (
            <div role="alert" className="rounded-md border border-amber/30 bg-amber-tint px-4 py-3 text-sm text-amber">
              {gateMessage}
            </div>
          ) : null}
          {saveError ? <SaveErrorBanner message={saveError} saving={saving} onRetry={() => void flush()} /> : null}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            {allowBack && sectionIndex > 0 ? (
              <Button type="button" variant="outline" onClick={() => void goTo(sectionIndex - 1)}>
                Back
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <span aria-live="polite" className="text-xs text-muted">
                {saving ? 'Saving…' : saveError ? 'Not saved' : 'Saved'}
              </span>
              <Button type="button" onClick={() => void goNext()} disabled={saving || saveError !== null}>
                {sectionIndex >= sections.length - 1 ? 'Review & submit' : 'Next'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </RendererShell>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function SaveErrorBanner({
  message,
  saving,
  onRetry,
}: {
  message: string;
  saving: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red/30 bg-red-tint px-4 py-3 text-sm text-red">
      <span>{message}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={saving}>
        {saving ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}

function RendererShell({
  title,
  progress = null,
  stepper,
  children,
}: {
  title: string;
  progress?: ResponseProgress | null;
  stepper?: { sections: Definition['sections']; current: number };
  children: React.ReactNode;
}) {
  const pct =
    progress && progress.totalCount > 0
      ? Math.round((progress.answeredCount / progress.totalCount) * 100)
      : 0;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {progress ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.totalCount}
            aria-valuenow={progress.answeredCount}
            aria-valuetext={`${progress.answeredCount} of ${progress.totalCount} questions answered`}
            className="h-2 w-full overflow-hidden rounded-full bg-border"
          >
            <div className="h-full rounded-full bg-primary-bright transition-all duration-150 ease-out" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {stepper ? (
          <ol className="flex flex-wrap gap-2 text-xs text-muted" aria-label="Sections">
            {stepper.sections.map((s, i) => (
              <li
                key={s.key}
                aria-current={i === stepper.current ? 'step' : undefined}
                className={`rounded-full border px-2.5 py-1 ${
                  i === stepper.current
                    ? 'border-primary bg-primary-tint font-medium text-primary-tint-ink'
                    : i < stepper.current
                      ? 'border-border text-teal'
                      : 'border-border'
                }`}
              >
                {i + 1}. {s.titleKey ? labelFromKey(s.titleKey) : `Section ${i + 1}`}
              </li>
            ))}
          </ol>
        ) : null}
      </header>
      {children}
    </main>
  );
}
