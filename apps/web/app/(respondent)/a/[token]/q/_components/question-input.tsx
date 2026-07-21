'use client';

import { useState } from 'react';

import { Button } from '@assessify/ui';
import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../_lib/renderer';
import { ContentBlock } from './questions/content-block';
import { FreeTextQuestion } from './questions/free-text-question';
import { LikertQuestion } from './questions/likert-question';
import { MatrixQuestion } from './questions/matrix-question';
import { MultipleChoiceQuestion } from './questions/multiple-choice-question';
import { NumericQuestion } from './questions/numeric-question';
import { stamp, type OnAnswer } from './questions/shared';

/**
 * Per-type question router (C3). The six C3 types delegate to the polished
 * accessible components in `./questions/`; ranking and ipsative_most_least
 * keep the minimal C2 fallbacks below until C4 replaces them. The value
 * shapes emitted everywhere match the normative table in spec 07, so the
 * autosave path is type-agnostic.
 */

interface QuestionInputProps {
  question: Question;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
  /** Id of the question-text element the renderer draws above the input. */
  labelId: string;
  /** Id of the help-text element, when the question has help copy. */
  helpId?: string;
  /** Disable all inputs (submission in flight). */
  disabled?: boolean;
  /** External per-question error (e.g. section required-gate feedback). */
  error?: string;
}

export function QuestionInput({
  question,
  record,
  onAnswer,
  labelId,
  helpId,
  disabled,
  error,
}: QuestionInputProps) {
  const a11y = { labelId, helpId, disabled, error };
  switch (question.type) {
    case 'content':
      return <ContentBlock question={question} />;
    case 'likert':
      return <LikertQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
    case 'multiple_choice':
      return (
        <MultipleChoiceQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />
      );
    case 'matrix':
      return <MatrixQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
    case 'numeric':
      return <NumericQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
    case 'free_text':
      return <FreeTextQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
    case 'ranking':
      return <RankingFallback question={question} record={record} onAnswer={onAnswer} />;
    case 'ipsative_most_least':
      return <IpsativeFallback question={question} record={record} onAnswer={onAnswer} />;
  }
}

// ---------------------------------------------------------------------------
// C2 fallbacks — ranking + ipsative stay minimal until C4 lands.
// ---------------------------------------------------------------------------

interface FallbackProps<T extends Question['type']> {
  question: Extract<Question, { type: T }>;
  record: AnswerRecord | undefined;
  onAnswer: OnAnswer;
}

function RankingFallback({ question, record, onAnswer }: FallbackProps<'ranking'>) {
  const order =
    record?.type === 'ranking' && record.value.length === question.options.length
      ? record.value
      : question.options.map((o) => o.key);
  const labels = new Map(question.options.map((o) => [o.key, labelFromKey(o.labelKey)]));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const item = next[index];
    if (item === undefined) return;
    next.splice(index, 1);
    next.splice(target, 0, item);
    onAnswer(question.key, stamp('ranking', next));
  };
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1">
        {order.map((key, index) => (
          <li
            key={key}
            className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-body"
          >
            <span>
              {index + 1}. {labels.get(key) ?? key}
            </span>
            <span className="flex gap-1">
              {/* Keyboard-operable reorder controls (spec 07 accessibility). */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Move ${labels.get(key) ?? key} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Move ${labels.get(key) ?? key} down`}
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
            </span>
          </li>
        ))}
      </ol>
      {record?.type !== 'ranking' ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onAnswer(question.key, stamp('ranking', order))}
        >
          Keep this order
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Minimal ipsative most/least block. Same-row conflict resolution follows
 * spec 07 (choosing Most on the current Least row clears Least, and vice
 * versa); an answer is only recorded once BOTH columns are chosen, because a
 * partial pair is not a valid answer record. C4 owns the full component with
 * its mandated test coverage.
 */
function IpsativeFallback({ question, record, onAnswer }: FallbackProps<'ipsative_most_least'>) {
  const saved = record?.type === 'ipsative_most_least' ? record.value : null;
  const [most, setMost] = useState<string | null>(saved?.most ?? null);
  const [least, setLeast] = useState<string | null>(saved?.least ?? null);

  const choose = (column: 'most' | 'least', itemKey: string) => {
    let nextMost = most;
    let nextLeast = least;
    if (column === 'most') {
      nextMost = itemKey;
      if (nextLeast === itemKey) nextLeast = null; // never both on one row
    } else {
      nextLeast = itemKey;
      if (nextMost === itemKey) nextMost = null;
    }
    setMost(nextMost);
    setLeast(nextLeast);
    if (nextMost !== null && nextLeast !== null) {
      onAnswer(question.key, stamp('ipsative_most_least', { most: nextMost, least: nextLeast }));
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="p-2 text-left font-medium text-muted">&nbsp;</th>
            <th className="p-2 text-center font-medium text-muted">Most like me</th>
            <th className="p-2 text-center font-medium text-muted">Least like me</th>
          </tr>
        </thead>
        <tbody>
          {question.items.map((item) => (
            <tr key={item.key} className="border-t border-border">
              <td className="p-2 text-body" id={`${question.key}-${item.key}-label`}>
                {labelFromKey(item.labelKey)}
              </td>
              <td className="p-2 text-center">
                <input
                  type="radio"
                  name={`${question.key}.most`}
                  aria-labelledby={`${question.key}-${item.key}-label`}
                  checked={most === item.key}
                  onChange={() => choose('most', item.key)}
                />
              </td>
              <td className="p-2 text-center">
                <input
                  type="radio"
                  name={`${question.key}.least`}
                  aria-labelledby={`${question.key}-${item.key}-label`}
                  checked={least === item.key}
                  onChange={() => choose('least', item.key)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {most === null || least === null ? (
        <p className="mt-1 text-xs text-muted">
          {most === null && least === null
            ? 'Choose one “Most” and one “Least”.'
            : most === null
              ? 'Choose one “Most like me”.'
              : 'Choose one “Least like me”.'}
        </p>
      ) : null}
    </div>
  );
}
