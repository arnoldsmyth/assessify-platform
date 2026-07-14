import { err, ok, type DomainError, type Result } from '@assessify/domain';
import { questionnaireDefinitionSchema, type QuestionnaireDefinition } from './schema';
import { checkSemantics } from './semantic';

export interface ValidationIssue {
  /** Human-readable JSON path, e.g. `sections[0].questions[2].showIf`. */
  path: string;
  message: string;
}

export interface QuestionnaireValidationError extends DomainError {
  readonly code: 'questionnaire_definition_invalid';
  readonly issues: ValidationIssue[];
}

export function formatPath(segments: (string | number)[]): string {
  if (segments.length === 0) return '(root)';
  return segments.reduce<string>(
    (acc, segment) =>
      typeof segment === 'number'
        ? `${acc}[${segment}]`
        : acc === ''
          ? segment
          : `${acc}.${segment}`,
    ''
  );
}

function invalid(issues: ValidationIssue[]): Result<never, QuestionnaireValidationError> {
  return err({
    code: 'questionnaire_definition_invalid',
    message: `questionnaire definition is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    issues,
    detail: { issues },
  });
}

/**
 * Validate an untrusted value (parsed JSON) as a questionnaire definition:
 * shape (Zod) first, then the semantic rules from spec 07. Returns the parsed
 * definition (with defaults applied, e.g. `required: true`) on success.
 */
export function validateDefinition(
  input: unknown
): Result<QuestionnaireDefinition, QuestionnaireValidationError> {
  const parsed = questionnaireDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      }))
    );
  }

  const semanticIssues = checkSemantics(parsed.data);
  if (semanticIssues.length > 0) {
    return invalid(
      semanticIssues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      }))
    );
  }

  return ok(parsed.data);
}
