'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';

import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { chooseIpsative, ipsativeStatus, type IpsativePair } from '../../_lib/question-logic';
import { describedBy, FieldError, optionCardClass, stamp, type OnAnswer, type QuestionA11y } from './shared';

/**
 * Ipsative most/least forced choice (spec 07 — "distinct type, get this
 * right"). N statements × two radio columns (Most like me / Least like me).
 *
 * Semantics (same as the C2 fallback it replaces):
 *  - each column is one radio group across the rows;
 *  - choosing Most on the row that currently holds Least clears the Least
 *    (and vice versa) — an invalid same-row pair can never exist;
 *  - an answer record is only emitted once BOTH columns are chosen, because a
 *    partial pair is not a valid record (the domain Zod refine requires
 *    most !== least and both present). Partial picks live in local state so
 *    the respondent never loses them while completing the pair.
 *
 * A11y: row labels are associated with both radios via `aria-labelledby`
 * (spec 07 requirement) together with the column header; native radios give
 * the radio-group arrow-key contract per column. A polite `aria-live` status
 * announces row-level changes including auto-clears, and distinct hint
 * messages cover "choose one Most" / "choose one Least". Two CSS-toggled
 * layouts (like the matrix component): a real `<table>` from `sm` up, stacked
 * per-row cards below it — radio `name`s are suffixed per layout so the
 * hidden copy never interferes with keyboard navigation.
 */

interface IpsativeQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'ipsative_most_least' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function IpsativeQuestion({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: IpsativeQuestionProps) {
  const saved = record?.type === 'ipsative_most_least' ? record.value : null;
  const [pair, setPair] = useState<IpsativePair>({
    most: saved?.most ?? null,
    least: saved?.least ?? null,
  });
  /** Cleared-column notice for the live status ("Least like me was cleared"). */
  const [clearedNotice, setClearedNotice] = useState<'most' | 'least' | null>(null);

  const labels = new Map(question.items.map((i) => [i.key, labelFromKey(i.labelKey)]));
  const status = ipsativeStatus(pair);
  const statusId = `${question.key}-status`;
  const errorId = error ? `${question.key}-error` : undefined;
  const mostHeaderId = `${question.key}-most-header`;
  const leastHeaderId = `${question.key}-least-header`;

  const choose = (column: 'most' | 'least', itemKey: string) => {
    const result = chooseIpsative(pair, column, itemKey);
    setPair(result.next);
    setClearedNotice(result.cleared);
    if (result.complete && result.next.most !== null && result.next.least !== null) {
      onAnswer(
        question.key,
        stamp('ipsative_most_least', { most: result.next.most, least: result.next.least })
      );
    }
  };

  const columnName = (column: 'most' | 'least') =>
    column === 'most' ? 'Most like me' : 'Least like me';

  const statusText = [
    clearedNotice !== null
      ? `“${columnName(clearedNotice)}” was cleared — it was the same statement.`
      : null,
    `Most like me: ${pair.most !== null ? (labels.get(pair.most) ?? pair.most) : 'not chosen'}.`,
    `Least like me: ${pair.least !== null ? (labels.get(pair.least) ?? pair.least) : 'not chosen'}.`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  const hint =
    status === 'empty'
      ? 'Choose one “Most like me” and one “Least like me”.'
      : status === 'need_most'
        ? 'Choose one “Most like me”.'
        : status === 'need_least'
          ? 'Choose one “Least like me”.'
          : null;

  /** True when the row holds one of the two selections. */
  const rowDone = (itemKey: string) => pair.most === itemKey || pair.least === itemKey;

  const gridCellClass = [
    'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md',
    'transition-colors duration-150 ease-out',
    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-1',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-page',
  ].join(' ');

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy(helpId, statusId, errorId)}
      className="flex flex-col gap-2"
    >
      {/* Wide layout: real table, one radio group per column. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="p-2 text-left font-medium text-muted">
                <span className="sr-only">Statement</span>
              </th>
              <th id={mostHeaderId} scope="col" className="p-2 text-center font-medium text-muted">
                Most like me
              </th>
              <th id={leastHeaderId} scope="col" className="p-2 text-center font-medium text-muted">
                Least like me
              </th>
            </tr>
          </thead>
          <tbody>
            {question.items.map((item) => {
              const rowLabelId = `${question.key}-${item.key}-gridlabel`;
              return (
                <tr key={item.key} className="border-t border-border">
                  <th scope="row" className="p-2 text-left font-normal text-body">
                    <span id={rowLabelId} className="flex items-center gap-1.5">
                      {labels.get(item.key)}
                      {rowDone(item.key) ? <RowDone /> : null}
                    </span>
                  </th>
                  {(['most', 'least'] as const).map((column) => (
                    <td key={column} className="p-1 text-center">
                      <label className={gridCellClass}>
                        <input
                          type="radio"
                          name={`${question.key}.${column}.grid`}
                          aria-labelledby={`${column === 'most' ? mostHeaderId : leastHeaderId} ${rowLabelId}`}
                          checked={pair[column] === item.key}
                          disabled={disabled}
                          onChange={() => choose(column, item.key)}
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

      {/* Narrow layout: stacked per-statement cards; the two columns remain
          cross-row radio groups via shared names. */}
      <div className="flex flex-col gap-4 sm:hidden">
        {question.items.map((item) => {
          const rowLabelId = `${question.key}-${item.key}-stacklabel`;
          return (
            <div key={item.key} className="flex flex-col gap-1.5">
              <p id={rowLabelId} className="flex items-center gap-1.5 text-sm text-body">
                {labels.get(item.key)}
                {rowDone(item.key) ? <RowDone /> : null}
              </p>
              <div className="flex gap-1.5">
                {(['most', 'least'] as const).map((column) => {
                  const selected = pair[column] === item.key;
                  const columnLabelId = `${question.key}-${item.key}-${column}-stackcol`;
                  return (
                    <label
                      key={column}
                      className={`flex-1 justify-center ${optionCardClass(selected, disabled)}`}
                    >
                      <input
                        type="radio"
                        name={`${question.key}.${column}.stack`}
                        aria-labelledby={`${columnLabelId} ${rowLabelId}`}
                        checked={selected}
                        disabled={disabled}
                        onChange={() => choose(column, item.key)}
                        className="sr-only"
                      />
                      <span id={columnLabelId}>{columnName(column)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p id={statusId} role="status" aria-live="polite" className="text-xs text-muted">
        {statusText}
      </p>
      {hint !== null ? <p className="text-xs text-muted">{hint}</p> : null}
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}

/** Teal per-row indicator that the row holds a Most or Least selection. */
function RowDone() {
  return (
    <>
      <Check size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-teal" />
      <span className="sr-only">(selected)</span>
    </>
  );
}
