'use client';

import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { scalePoints } from '../../_lib/question-logic';
import { describedBy, FieldError, stamp, type OnAnswer, type QuestionA11y } from './shared';

/**
 * Likert scale as a horizontal radio group (spec 07). Native radios (visually
 * hidden, still focusable) give the WAI-ARIA radio-group keyboard contract
 * for free: Tab into the group, arrow keys move + select, Tab leaves. Each
 * point is a ≥44px touch target; endpoint labels always show and per-point
 * labels render under their point when the definition provides them.
 *
 * Definitions may declare `presentation: 'slider'`; we deliberately render
 * the radio group for both presentations — a discrete labelled radio scale is
 * the accessible baseline and never misrepresents an unanswered state the way
 * a slider thumb does. (Flagged as a spec ambiguity in the C3 report.)
 */

interface LikertQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'likert' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function LikertQuestion({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: LikertQuestionProps) {
  const value = record?.type === 'likert' ? record.value : null;
  const { min, max, labelKeys } = question.scale;
  const points = scalePoints(min, max);
  const errorId = error ? `${question.key}-error` : undefined;

  const pointLabel = (point: number): string | undefined => {
    const key = labelKeys[String(point)];
    return key === undefined ? undefined : labelFromKey(key);
  };
  const minLabel = pointLabel(min);
  const maxLabel = pointLabel(max);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy(helpId, errorId)}
        className="flex flex-wrap gap-1.5 sm:flex-nowrap"
      >
        {points.map((point) => {
          const selected = value === point;
          const label = pointLabel(point);
          return (
            <label
              key={point}
              className={[
                'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border px-2 py-2 text-center',
                'transition-colors duration-150 ease-out',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-1',
                selected
                  ? 'border-primary bg-primary-tint text-primary-tint-ink'
                  : 'border-border text-body',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-page',
                selected && !disabled ? 'hover:bg-primary-tint' : '',
              ].join(' ')}
            >
              <input
                type="radio"
                name={question.key}
                value={point}
                checked={selected}
                disabled={disabled}
                onChange={() => onAnswer(question.key, stamp('likert', point))}
                className="sr-only"
              />
              <span className={`text-base ${selected ? 'font-semibold' : 'font-medium'}`}>
                {point}
              </span>
              {label !== undefined ? (
                <span className="text-xs leading-tight">{label}</span>
              ) : null}
            </label>
          );
        })}
      </div>
      {/* Endpoint reminder row — redundant with per-point labels for sighted
          users on wide screens, essential when points wrap on small screens. */}
      {minLabel !== undefined || maxLabel !== undefined ? (
        <div aria-hidden="true" className="flex justify-between gap-4 text-xs text-muted">
          <span>{minLabel !== undefined ? `${min} = ${minLabel}` : ''}</span>
          <span className="text-right">{maxLabel !== undefined ? `${max} = ${maxLabel}` : ''}</span>
        </div>
      ) : null}
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
