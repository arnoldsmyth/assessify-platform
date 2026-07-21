'use client';

import { TriangleAlert } from 'lucide-react';

import type { AnswerRecord } from '@assessify/domain';

/**
 * Shared plumbing for the per-type question components (C3).
 *
 * The questionnaire renderer owns the question text (label) and help copy —
 * it renders them with stable element ids and passes those ids down so every
 * component can wire `aria-labelledby` / `aria-describedby` correctly. Each
 * component adds its own hint/error ids on top via `describedBy`.
 */

/** A11y + state props every question component receives from the router. */
export interface QuestionA11y {
  /** Element id of the rendered question text (labelled-by target). */
  labelId: string;
  /** Element id of the rendered help text, when the question has help. */
  helpId?: string;
  /** Disable all inputs (used while the submission is in flight). */
  disabled?: boolean;
  /** External error for this question (e.g. required-gate feedback). */
  error?: string;
}

export type OnAnswer = (questionKey: string, record: AnswerRecord) => void;

/** Build an AnswerRecord with the value shape checked against the type. */
export function stamp<T extends AnswerRecord['type']>(
  type: T,
  value: Extract<AnswerRecord, { type: T }>['value']
): AnswerRecord {
  return { type, value, answeredAt: new Date().toISOString() } as AnswerRecord;
}

/** Join defined ids into an `aria-describedby` value (undefined when empty). */
export function describedBy(...ids: (string | undefined | false)[]): string | undefined {
  const joined = ids.filter((id): id is string => typeof id === 'string' && id !== '').join(' ');
  return joined === '' ? undefined : joined;
}

/**
 * Inline error slot — assertive because it appears in response to a blocked
 * user action (spec 15: errors say what happened and what to do next).
 */
export function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm text-red">
      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** Muted hint line (limits, ranges, selection rules). */
export function FieldHint({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted">
      {children}
    </p>
  );
}

/**
 * Styling for a selectable option card wrapping a native input. The focus
 * ring tracks the (visually hidden or native) input via `:has(:focus-visible)`
 * so keyboard focus is always visible on the 44px+ touch target (spec 15).
 */
export function optionCardClass(selected: boolean, disabled?: boolean): string {
  return [
    'flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm',
    'transition-colors duration-150 ease-out',
    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-1',
    selected
      ? 'border-primary bg-primary-tint font-medium text-primary-tint-ink'
      : 'border-border text-body',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-page',
    selected && !disabled ? 'hover:bg-primary-tint' : '',
  ].join(' ');
}

/** Native radio/checkbox control styling (Ember accent, no double focus ring). */
export const nativeControlClass = 'size-4 shrink-0 accent-primary focus-visible:outline-none';
