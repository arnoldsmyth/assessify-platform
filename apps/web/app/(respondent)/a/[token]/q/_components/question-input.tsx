'use client';

import { useState } from 'react';

import { Button, Input } from '@assessify/ui';
import type { AnswerRecord } from '@assessify/domain';

import { labelFromKey, type Question } from '../_lib/renderer';

/**
 * Minimal generic answer inputs (C2) — just enough for the renderer flow to
 * work end-to-end for ANY valid definition. C3/C4 replace this per question
 * type with the full accessible components (slider presentations, drag
 * ranking, the complete ipsative block, ...). The value shapes emitted here
 * already match the normative table in spec 07, so swapping components in
 * does not touch the save path.
 */

interface QuestionInputProps {
  question: Question;
  record: AnswerRecord | undefined;
  onAnswer: (questionKey: string, record: AnswerRecord) => void;
}

function stamp<T extends AnswerRecord['type']>(
  type: T,
  value: Extract<AnswerRecord, { type: T }>['value']
): AnswerRecord {
  return { type, value, answeredAt: new Date().toISOString() } as AnswerRecord;
}

function scalePoints(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export function QuestionInput({ question, record, onAnswer }: QuestionInputProps) {
  switch (question.type) {
    case 'content':
      return <p className="text-sm text-body">{labelFromKey(question.bodyKey)}</p>;

    case 'likert': {
      const value = record?.type === 'likert' ? record.value : null;
      return (
        <div role="radiogroup" aria-label={labelFromKey(question.textKey)} className="flex flex-wrap gap-2">
          {scalePoints(question.scale.min, question.scale.max).map((point) => {
            const pointLabel = question.scale.labelKeys[String(point)];
            return (
              <label
                key={point}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  value === point ? 'border-primary bg-primary-tint text-primary-tint-ink' : 'border-border text-body'
                }`}
              >
                <input
                  type="radio"
                  name={question.key}
                  checked={value === point}
                  onChange={() => onAnswer(question.key, stamp('likert', point))}
                />
                <span>
                  {point}
                  {pointLabel ? ` — ${labelFromKey(pointLabel)}` : ''}
                </span>
              </label>
            );
          })}
        </div>
      );
    }

    case 'numeric': {
      const value = record?.type === 'numeric' ? record.value : '';
      return (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            className="max-w-40"
            min={question.min}
            max={question.max}
            step={question.step}
            value={value}
            aria-label={labelFromKey(question.textKey)}
            onChange={(e) => {
              const next = e.target.valueAsNumber;
              if (!Number.isNaN(next)) onAnswer(question.key, stamp('numeric', next));
            }}
          />
          {question.unitKey ? <span className="text-sm text-muted">{labelFromKey(question.unitKey)}</span> : null}
        </div>
      );
    }

    case 'multiple_choice': {
      if (question.multi) {
        const selected = record?.type === 'multiple_choice' && Array.isArray(record.value) ? record.value : [];
        return (
          <div className="flex flex-col gap-2">
            {question.options.map((option) => (
              <label key={option.key} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-body">
                <input
                  type="checkbox"
                  checked={selected.includes(option.key)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, option.key]
                      : selected.filter((k) => k !== option.key);
                    onAnswer(question.key, stamp('multiple_choice', next));
                  }}
                />
                {labelFromKey(option.labelKey)}
              </label>
            ))}
          </div>
        );
      }
      const selected = record?.type === 'multiple_choice' && !Array.isArray(record.value) ? record.value : null;
      return (
        <div role="radiogroup" aria-label={labelFromKey(question.textKey)} className="flex flex-col gap-2">
          {question.options.map((option) => (
            <label key={option.key} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-body">
              <input
                type="radio"
                name={question.key}
                checked={selected === option.key}
                onChange={() => onAnswer(question.key, stamp('multiple_choice', option.key))}
              />
              {labelFromKey(option.labelKey)}
            </label>
          ))}
        </div>
      );
    }

    case 'matrix': {
      const values = record?.type === 'matrix' ? record.value : {};
      const points = scalePoints(question.scale.min, question.scale.max);
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium text-muted">&nbsp;</th>
                {points.map((point) => (
                  <th key={point} className="p-2 text-center font-medium text-muted">
                    {point}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {question.rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="p-2 text-body">{labelFromKey(row.labelKey)}</td>
                  {points.map((point) => (
                    <td key={point} className="p-2 text-center">
                      <input
                        type="radio"
                        name={`${question.key}.${row.key}`}
                        aria-label={`${labelFromKey(row.labelKey)}: ${point}`}
                        checked={values[row.key] === point}
                        onChange={() =>
                          onAnswer(question.key, stamp('matrix', { ...values, [row.key]: point }))
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'ranking': {
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
                  <Button type="button" variant="secondary" size="sm" aria-label={`Move ${labels.get(key) ?? key} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </Button>
                  <Button type="button" variant="secondary" size="sm" aria-label={`Move ${labels.get(key) ?? key} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>
                    ↓
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          {record?.type !== 'ranking' ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => onAnswer(question.key, stamp('ranking', order))}>
              Keep this order
            </Button>
          ) : null}
        </div>
      );
    }

    case 'free_text': {
      const value = record?.type === 'free_text' ? record.value : '';
      const commonProps = {
        value,
        maxLength: question.maxChars,
        'aria-label': labelFromKey(question.textKey),
      };
      if (question.multiline) {
        return (
          <textarea
            {...commonProps}
            rows={4}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-body focus:outline-2 focus:outline-primary"
            onChange={(e) => onAnswer(question.key, stamp('free_text', e.target.value))}
          />
        );
      }
      return <Input {...commonProps} onChange={(e) => onAnswer(question.key, stamp('free_text', e.target.value))} />;
    }

    case 'ipsative_most_least':
      return <IpsativeInput question={question} record={record} onAnswer={onAnswer} />;
  }
}

/**
 * Minimal ipsative most/least block. Same-row conflict resolution follows
 * spec 07 (choosing Most on the current Least row clears Least, and vice
 * versa); an answer is only recorded once BOTH columns are chosen, because a
 * partial pair is not a valid answer record. C3 owns the full component with
 * its mandated test coverage.
 */
function IpsativeInput({
  question,
  record,
  onAnswer,
}: QuestionInputProps & { question: Extract<Question, { type: 'ipsative_most_least' }> }) {
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
