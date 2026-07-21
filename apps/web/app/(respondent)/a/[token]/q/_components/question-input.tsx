'use client';

import type { AnswerRecord } from '@assessify/domain';

import type { Question } from '../_lib/renderer';
import { ContentBlock } from './questions/content-block';
import { FreeTextQuestion } from './questions/free-text-question';
import { IpsativeQuestion } from './questions/ipsative-question';
import { LikertQuestion } from './questions/likert-question';
import { MatrixQuestion } from './questions/matrix-question';
import { MultipleChoiceQuestion } from './questions/multiple-choice-question';
import { NumericQuestion } from './questions/numeric-question';
import { RankingQuestion } from './questions/ranking-question';
import type { OnAnswer } from './questions/shared';

/**
 * Per-type question router. All eight question types delegate to the polished
 * accessible components in `./questions/` (six from C3, ranking + ipsative
 * from C4). The value shapes emitted everywhere match the normative table in
 * spec 07, so the autosave path is type-agnostic.
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
      return <RankingQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
    case 'ipsative_most_least':
      return <IpsativeQuestion question={question} record={record} onAnswer={onAnswer} {...a11y} />;
  }
}
