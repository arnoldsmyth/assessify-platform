'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../../_lib/renderer';
import { moveItem, normalizeRankingOrder } from '../../_lib/question-logic';
import { describedBy, FieldError, FieldHint, stamp, type OnAnswer, type QuestionA11y } from './shared';

/**
 * Ranking (spec 07): order ALL options from 1..n. Keyboard-first per the spec's
 * accessibility rule — every item has explicit Up/Down buttons (≥44px touch
 * targets), so there is no drag-only interaction; the buttons ARE the
 * interaction on every input modality.
 *
 * Partial-state handling: the server (`answer-validation.ts`) only accepts a
 * FULL permutation of the option keys (`not_a_permutation_of_options`), so
 * "partially ranked" is not a savable state. The component therefore always
 * works on a complete order — it starts from the definition order (or the
 * saved answer) and every move emits the full permutation. Because the initial
 * order is itself a valid answer the respondent may genuinely want, an
 * explicit "Confirm this order" affordance records it without any move
 * (preserving the C2 fallback's semantics); until then the question counts as
 * unanswered.
 *
 * A11y: each move is announced via a polite `aria-live` region ("X moved to
 * position 2 of 5"); position numbers are visible on every item; when a moved
 * item reaches the top/bottom its now-disabled button hands focus to its
 * sibling so keyboard users are never dropped to the page body.
 */

interface RankingQuestionProps extends QuestionA11y {
  question: Extract<Question, { type: 'ranking' }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

export function RankingQuestion({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: RankingQuestionProps) {
  const confirmed = record?.type === 'ranking';
  const order = normalizeRankingOrder(
    question.options.map((o) => o.key),
    record?.type === 'ranking' ? record.value : undefined
  );
  const labels = new Map(question.options.map((o) => [o.key, labelFromKey(o.labelKey)]));
  const total = order.length;

  const hintId = `${question.key}-hint`;
  const liveId = `${question.key}-live`;
  const errorId = error ? `${question.key}-error` : undefined;

  /** Last-move announcement for the live region. */
  const [announcement, setAnnouncement] = useState('');
  /** Focus hand-off target after a move lands the item on a boundary. */
  const pendingFocus = useRef<string | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const button = buttonRefs.current.get(target);
    if (button !== null && button !== undefined && !button.disabled) button.focus();
  });

  const move = (index: number, delta: number) => {
    const result = moveItem(order, index, delta);
    if (!result.moved) return;
    const key = order[index];
    if (key === undefined) return;
    const direction = delta < 0 ? 'up' : 'down';
    // If the item just hit the boundary, its clicked button is about to become
    // disabled — hand focus to the opposite button on the same item.
    const atBoundary = delta < 0 ? result.to === 0 : result.to === total - 1;
    pendingFocus.current = `${key}:${atBoundary ? (direction === 'up' ? 'down' : 'up') : direction}`;
    setAnnouncement(`${labels.get(key) ?? key} moved to position ${result.to + 1} of ${total}.`);
    onAnswer(question.key, stamp('ranking', result.next));
  };

  const moveButtonClass = (buttonDisabled: boolean) =>
    [
      'flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border text-body',
      'transition-colors duration-150 ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
      buttonDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-surface-page',
    ].join(' ');

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy(helpId, hintId, errorId)}
      className="flex flex-col gap-2"
    >
      <FieldHint id={hintId}>
        Use the up and down buttons to order the items, 1 = highest.
      </FieldHint>
      <ol className="flex flex-col gap-1.5">
        {order.map((key, index) => {
          const label = labels.get(key) ?? key;
          return (
            <li
              key={key}
              className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-1.5 text-sm text-body"
            >
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary-tint-ink"
              >
                {index + 1}
              </span>
              <span className="flex-1">
                <span className="sr-only">Position {index + 1} of {total}: </span>
                {label}
              </span>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  ref={(el) => {
                    buttonRefs.current.set(`${key}:up`, el);
                  }}
                  aria-label={`Move ${label} up to position ${index}`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  className={moveButtonClass(Boolean(disabled) || index === 0)}
                >
                  <ChevronUp size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  ref={(el) => {
                    buttonRefs.current.set(`${key}:down`, el);
                  }}
                  aria-label={`Move ${label} down to position ${index + 2}`}
                  disabled={disabled || index === total - 1}
                  onClick={() => move(index, 1)}
                  className={moveButtonClass(Boolean(disabled) || index === total - 1)}
                >
                  <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      {/* Move announcements — sr-only so sighted users rely on the visible
          position numbers instead of a flickering status line. */}
      <p id={liveId} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {confirmed ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Check size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-teal" />
          Order recorded — keep adjusting if you want to change it.
        </p>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAnswer(question.key, stamp('ranking', order))}
          className={[
            'self-start rounded-md border border-border px-3 py-2 text-sm font-medium text-body',
            'min-h-11 transition-colors duration-150 ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-page',
          ].join(' ')}
        >
          Confirm this order
        </button>
      )}
      {error && errorId ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
