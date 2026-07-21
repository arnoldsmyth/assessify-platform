'use client';

import { useState } from 'react';

import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { toggleSelection } from '../../_lib/question-logic';
import {
  describedBy,
  FieldError,
  FieldHint,
  nativeControlClass,
  optionCardClass,
  stamp,
  type OnAnswer,
  type QuestionA11y,
} from './shared';

/**
 * Multiple choice (spec 07): single-select renders a radio group, multi-select
 * a checkbox group. `maxSelections` is enforced client-side — the server
 * rejects `too_many_selections` on autosave, so the component never emits an
 * over-limit value. Feedback is twofold: unchecked boxes disable at the limit
 * (visually obvious) AND a polite live region explains why, so keyboard and
 * screen-reader users are told rather than left guessing.
 */

interface MultipleChoiceQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'multiple_choice' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function MultipleChoiceQuestion(props: MultipleChoiceQuestionProps) {
  return props.question.multi ? <MultiSelect {...props} /> : <SingleSelect {...props} />;
}

function SingleSelect({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: MultipleChoiceQuestionProps) {
  const selected =
    record?.type === 'multiple_choice' && !Array.isArray(record.value) ? record.value : null;
  const errorId = error ? `${question.key}-error` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy(helpId, errorId)}
        className="flex flex-col gap-2"
      >
        {question.options.map((option) => {
          const isSelected = selected === option.key;
          return (
            <label key={option.key} className={optionCardClass(isSelected, disabled)}>
              <input
                type="radio"
                name={question.key}
                value={option.key}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onAnswer(question.key, stamp('multiple_choice', option.key))}
                className={nativeControlClass}
              />
              <span>{labelFromKey(option.labelKey)}</span>
            </label>
          );
        })}
      </div>
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}

function MultiSelect({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: MultipleChoiceQuestionProps) {
  const selected =
    record?.type === 'multiple_choice' && Array.isArray(record.value) ? record.value : [];
  const { minSelections, maxSelections } = question;
  const atLimit = maxSelections !== undefined && selected.length >= maxSelections;
  const [limitNotice, setLimitNotice] = useState(false);

  const hintId = `${question.key}-hint`;
  const statusId = `${question.key}-status`;
  const errorId = error ? `${question.key}-error` : undefined;

  const selectionRule = (() => {
    if (minSelections !== undefined && maxSelections !== undefined) {
      return minSelections === maxSelections
        ? `Choose exactly ${maxSelections}.`
        : `Choose between ${minSelections} and ${maxSelections}.`;
    }
    if (maxSelections !== undefined) return `Choose up to ${maxSelections}.`;
    if (minSelections !== undefined) return `Choose at least ${minSelections}.`;
    return 'Choose all that apply.';
  })();

  const toggle = (optionKey: string) => {
    const result = toggleSelection(selected, optionKey, maxSelections);
    setLimitNotice(result.blocked);
    if (!result.blocked) {
      onAnswer(question.key, stamp('multiple_choice', result.next));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <FieldHint id={hintId}>{selectionRule}</FieldHint>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={describedBy(helpId, hintId, statusId, errorId)}
        className="flex flex-col gap-2"
      >
        {question.options.map((option) => {
          const isSelected = selected.includes(option.key);
          const isBlocked = !isSelected && atLimit;
          return (
            <label
              key={option.key}
              className={optionCardClass(isSelected, disabled || isBlocked)}
            >
              <input
                type="checkbox"
                name={question.key}
                value={option.key}
                checked={isSelected}
                disabled={disabled || isBlocked}
                onChange={() => toggle(option.key)}
                className={nativeControlClass}
              />
              <span>{labelFromKey(option.labelKey)}</span>
            </label>
          );
        })}
      </div>
      {/* Live selection status; also announces the limit when it is reached. */}
      <p id={statusId} role="status" aria-live="polite" className="text-xs text-muted">
        {selected.length} selected
        {atLimit || limitNotice
          ? ` — that's the maximum of ${maxSelections}. Unselect one to change your answer.`
          : ''}
      </p>
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
