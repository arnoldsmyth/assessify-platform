'use client';

import type { AnswerRecord } from '@assessify/domain';
import { Input } from '@assessify/ui';

import type { Question } from '../../_lib/renderer';
import { clampFreeText, freeTextCounts } from '../../_lib/question-logic';
import {
  describedBy,
  FieldError,
  stamp,
  type OnAnswer,
  type QuestionA11y,
} from './shared';

/**
 * Free text (spec 07): textarea (multiline) or single-line input with live
 * character/word counters against maxChars/maxWords.
 *
 * Over-limit PREVENTION matches the server's counting in
 * answer-validation.ts exactly (UTF-16 `length` for chars — same unit as the
 * DOM `maxLength` attribute — and trim+`/\s+/`-split for words): input is
 * clamped through `clampFreeText` before it is stored or saved, so autosave
 * can never be rejected with `too_many_chars`/`too_many_words`. `minWords` is
 * a submit-time rule; here it is a gentle progress hint, not an error.
 */

interface FreeTextQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'free_text' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function FreeTextQuestion({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: FreeTextQuestionProps) {
  const value = record?.type === 'free_text' ? record.value : '';
  const { maxChars, maxWords, minWords } = question;
  const counts = freeTextCounts(value, { maxChars, maxWords, minWords });

  const counterId = `${question.key}-counter`;
  const errorId = error ? `${question.key}-error` : undefined;

  const handleChange = (raw: string) => {
    const next = clampFreeText(raw, { maxChars, maxWords });
    onAnswer(question.key, stamp('free_text', next));
  };

  const sharedProps = {
    value,
    disabled,
    maxLength: maxChars,
    'aria-labelledby': labelId,
    'aria-describedby': describedBy(helpId, counterId, errorId),
  };

  const atLimit = counts.atCharLimit || counts.atWordLimit;

  return (
    <div className="flex flex-col gap-1.5">
      {question.multiline ? (
        <textarea
          {...sharedProps}
          rows={5}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-base text-body shadow-sm transition-colors duration-150 ease-out placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => handleChange(e.target.value)}
        />
      ) : (
        <Input
          {...sharedProps}
          type="text"
          className="h-11 text-base"
          onChange={(e) => handleChange(e.target.value)}
        />
      )}

      {/* Live counters + minWords progress. Polite live region: announced
          between keystrokes, so limit-reached feedback reaches AT users
          without interrupting typing. */}
      <div
        id={counterId}
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs"
      >
        <span className="text-muted">
          {minWords !== undefined && counts.wordsNeeded > 0
            ? `At least ${minWords} words — ${counts.wordsNeeded} more to go`
            : atLimit
              ? counts.atWordLimit && !counts.atCharLimit
                ? 'Word limit reached'
                : 'Character limit reached'
              : ''}
        </span>
        <span className="flex gap-3">
          {maxWords !== undefined ? (
            <span className={counts.atWordLimit ? 'font-medium text-red' : 'text-muted'}>
              {counts.words}/{maxWords} words
            </span>
          ) : minWords !== undefined ? (
            <span className="text-muted">{counts.words} words</span>
          ) : null}
          {maxChars !== undefined ? (
            <span className={counts.atCharLimit ? 'font-medium text-red' : 'text-muted'}>
              {counts.chars}/{maxChars} characters
            </span>
          ) : null}
        </span>
      </div>
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
