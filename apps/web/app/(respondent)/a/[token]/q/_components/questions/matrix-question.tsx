'use client';

import { Check } from 'lucide-react';

import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { matrixCompletion, scalePoints } from '../../_lib/question-logic';
import { describedBy, FieldError, stamp, type OnAnswer, type QuestionA11y } from './shared';

/**
 * Matrix (rows × shared scale, spec 07). Two responsive layouts:
 *
 *  - ≥sm: a real `<table>` — `<th scope="col">` for scale points and
 *    `<th scope="row">` for statements, so screen readers announce both axes
 *    while navigating cells. One native radio group per row.
 *  - <sm: stacked per-row radio groups (likert-style point cells) — a 12-row
 *    × 7-point table cannot work on a phone.
 *
 * Both layouts are in the DOM (CSS-toggled) and share the controlled answer
 * state; radio `name`s are suffixed per layout so the hidden copy never
 * interferes with keyboard navigation. Per-row completion shows as a teal
 * check (plus sr-only text) and an aria-live "n of m" summary.
 */

interface MatrixQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'matrix' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function MatrixQuestion({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: MatrixQuestionProps) {
  const values = record?.type === 'matrix' ? record.value : {};
  const points = scalePoints(question.scale.min, question.scale.max);
  const completion = matrixCompletion(question.rows, values);
  const statusId = `${question.key}-status`;
  const errorId = error ? `${question.key}-error` : undefined;

  const pointLabel = (point: number): string | undefined => {
    const key = question.scale.labelKeys[String(point)];
    return key === undefined ? undefined : labelFromKey(key);
  };

  const answer = (rowKey: string, point: number) =>
    onAnswer(question.key, stamp('matrix', { ...values, [rowKey]: point }));

  /** Accessible name for one radio: "Delegation: 3 — Sometimes". */
  const cellLabel = (rowLabel: string, point: number): string => {
    const label = pointLabel(point);
    return label === undefined ? `${rowLabel}: ${point}` : `${rowLabel}: ${point} — ${label}`;
  };

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy(helpId, statusId, errorId)}
      className="flex flex-col gap-2"
    >
      {/* Wide layout: real table semantics. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="p-2 text-left font-medium text-muted">
                <span className="sr-only">Statement</span>
              </th>
              {points.map((point) => {
                const label = pointLabel(point);
                return (
                  <th key={point} scope="col" className="p-2 text-center font-medium text-muted">
                    <span className="block">{point}</span>
                    {label !== undefined ? (
                      <span className="block text-xs font-normal leading-tight">{label}</span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {question.rows.map((row) => {
              const rowLabel = labelFromKey(row.labelKey);
              const answered = values[row.key] !== undefined;
              return (
                <tr key={row.key} className="border-t border-border">
                  <th scope="row" className="p-2 text-left font-normal text-body">
                    <span className="flex items-center gap-1.5">
                      {rowLabel}
                      {answered ? <RowDone /> : null}
                    </span>
                  </th>
                  {points.map((point) => (
                    <td key={point} className="p-1 text-center">
                      <label
                        className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors duration-150 ease-out has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-1 ${
                          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-page'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`${question.key}.${row.key}.grid`}
                          aria-label={cellLabel(rowLabel, point)}
                          checked={values[row.key] === point}
                          disabled={disabled}
                          onChange={() => answer(row.key, point)}
                          className="size-4 accent-primary focus-visible:outline-none"
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Narrow layout: one stacked radio group per row. */}
      <div className="flex flex-col gap-4 sm:hidden">
        {question.rows.map((row) => {
          const rowLabel = labelFromKey(row.labelKey);
          const answered = values[row.key] !== undefined;
          const rowLabelId = `${question.key}-${row.key}-rowlabel`;
          return (
            <div key={row.key} className="flex flex-col gap-1.5">
              <p id={rowLabelId} className="flex items-center gap-1.5 text-sm text-body">
                {rowLabel}
                {answered ? <RowDone /> : null}
              </p>
              <div role="radiogroup" aria-labelledby={rowLabelId} className="flex gap-1.5">
                {points.map((point) => {
                  const selected = values[row.key] === point;
                  return (
                    <label
                      key={point}
                      className={[
                        'flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-md border text-sm',
                        'transition-colors duration-150 ease-out',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-1',
                        selected
                          ? 'border-primary bg-primary-tint font-semibold text-primary-tint-ink'
                          : 'border-border text-body',
                        disabled
                          ? 'cursor-not-allowed opacity-50'
                          : 'cursor-pointer hover:bg-surface-page',
                        selected && !disabled ? 'hover:bg-primary-tint' : '',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name={`${question.key}.${row.key}.stack`}
                        aria-label={cellLabel(rowLabel, point)}
                        checked={selected}
                        disabled={disabled}
                        onChange={() => answer(row.key, point)}
                        className="sr-only"
                      />
                      {point}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p id={statusId} role="status" aria-live="polite" className="text-xs text-muted">
        {completion.complete
          ? `All ${completion.totalCount} rows answered`
          : `${completion.answeredCount} of ${completion.totalCount} rows answered`}
      </p>
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}

/** Teal completion check for an answered row (icon + sr-only text). */
function RowDone() {
  return (
    <>
      <Check size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-teal" />
      <span className="sr-only">(answered)</span>
    </>
  );
}
