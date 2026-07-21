'use client';

import { useState } from 'react';

import type { AnswerRecord } from '@assessify/domain';
import { Input } from '@assessify/ui';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { numericStatus } from '../../_lib/question-logic';
import {
  describedBy,
  FieldError,
  FieldHint,
  stamp,
  type OnAnswer,
  type QuestionA11y,
} from './shared';

/**
 * Numeric (spec 07): `presentation: 'input'` renders a number field with
 * min/max/step, a unit label and a mobile-appropriate `inputMode`;
 * `presentation: 'slider'` renders a native range input with an always-visible
 * value readout and `aria-valuetext` including the unit (spec 07 a11y).
 *
 * The field keeps a local draft so typing is unconstrained, but an answer is
 * only EMITTED when the value parses and sits inside [min, max] — the server
 * rejects `value_out_of_range` on autosave, which would fail the whole patch.
 * Out-of-range/unparseable drafts show inline feedback instead.
 */

interface NumericQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'numeric' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function NumericQuestion(props: NumericQuestionProps) {
  return props.question.presentation === 'slider' ? (
    <NumericSlider {...props} />
  ) : (
    <NumericField {...props} />
  );
}

function unitText(question: NumericQuestionProps['question']): string {
  return question.unitKey === undefined ? '' : labelFromKey(question.unitKey);
}

function rangeHint(question: NumericQuestionProps['question']): string {
  const unit = unitText(question);
  return `Between ${question.min} and ${question.max}${unit === '' ? '' : ` ${unit}`}`;
}

function NumericField({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: NumericQuestionProps) {
  const saved = record?.type === 'numeric' ? record.value : null;
  const [draft, setDraft] = useState<string>(saved === null ? '' : String(saved));
  const [rangeIssue, setRangeIssue] = useState<string | null>(null);

  const hintId = `${question.key}-hint`;
  const rangeErrorId = `${question.key}-range-error`;
  const errorId = error ? `${question.key}-error` : undefined;
  const unit = unitText(question);

  // Whole, non-negative scales get the plain numeric keypad on mobile;
  // decimal steps/bounds (and negative ranges, for the minus key) need the
  // full decimal keyboard.
  const inputMode =
    Number.isInteger(question.step) && Number.isInteger(question.min) && question.min >= 0
      ? 'numeric'
      : 'decimal';

  const handleChange = (raw: string, parsed: number) => {
    setDraft(raw);
    if (raw.trim() === '') {
      // Cleared: keep the last saved answer (there is no unanswer path) but
      // drop any stale range feedback.
      setRangeIssue(null);
      return;
    }
    const status = numericStatus(parsed, question.min, question.max);
    switch (status) {
      case 'ok':
        setRangeIssue(null);
        onAnswer(question.key, stamp('numeric', parsed));
        break;
      case 'not_a_number':
        setRangeIssue('Enter a number.');
        break;
      case 'below_min':
        setRangeIssue(`Too low — ${rangeHint(question).toLowerCase()}.`);
        break;
      case 'above_max':
        setRangeIssue(`Too high — ${rangeHint(question).toLowerCase()}.`);
        break;
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="h-11 max-w-40 text-base"
          inputMode={inputMode}
          min={question.min}
          max={question.max}
          step={question.step}
          value={draft}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-invalid={rangeIssue !== null || undefined}
          aria-describedby={describedBy(
            helpId,
            hintId,
            rangeIssue !== null && rangeErrorId,
            errorId
          )}
          onChange={(e) => handleChange(e.target.value, e.target.valueAsNumber)}
        />
        {unit !== '' ? <span className="text-sm text-muted">{unit}</span> : null}
      </div>
      <FieldHint id={hintId}>{rangeHint(question)}</FieldHint>
      {rangeIssue !== null ? <FieldError id={rangeErrorId} message={rangeIssue} /> : null}
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}

function NumericSlider({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: NumericQuestionProps) {
  const saved = record?.type === 'numeric' ? record.value : null;
  const current = saved ?? question.min;
  const hintId = `${question.key}-hint`;
  const errorId = error ? `${question.key}-error` : undefined;
  const unit = unitText(question);
  const valueText = unit === '' ? String(current) : `${current} ${unit}`;

  const commit = (value: number) => {
    if (numericStatus(value, question.min, question.max) === 'ok') {
      onAnswer(question.key, stamp('numeric', value));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={question.min}
          max={question.max}
          step={question.step}
          value={current}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={describedBy(helpId, hintId, errorId)}
          aria-valuetext={valueText}
          onChange={(e) => commit(e.target.valueAsNumber)}
          // A slider sitting at its minimum fires no change event when the
          // respondent's answer IS the minimum — commit on click so choosing
          // the starting position still records an answer.
          onClick={saved === null ? () => commit(current) : undefined}
          className="h-11 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <output
          aria-hidden="true"
          className="min-w-16 whitespace-nowrap text-right text-sm font-medium text-body"
        >
          {saved === null ? '—' : valueText}
        </output>
      </div>
      <FieldHint id={hintId}>
        {saved === null ? `Move the slider to answer — ${rangeHint(question).toLowerCase()}` : rangeHint(question)}
      </FieldHint>
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
