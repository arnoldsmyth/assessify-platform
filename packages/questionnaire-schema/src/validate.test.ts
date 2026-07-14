import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures';
import { formatPath, validateDefinition, type ValidationIssue } from './validate';

function expectInvalid(fixture: string): ValidationIssue[] {
  const result = validateDefinition(loadFixture(`invalid/${fixture}`));
  expect(result.ok, `${fixture} should be rejected`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.error.code).toBe('questionnaire_definition_invalid');
  expect(result.error.issues.length).toBeGreaterThan(0);
  return result.error.issues;
}

function issueMatching(issues: ValidationIssue[], pattern: RegExp): ValidationIssue | undefined {
  return issues.find((i) => pattern.test(`${i.path}: ${i.message}`));
}

describe('validateDefinition — valid fixtures', () => {
  it('accepts the full fixture covering all 9 question types', () => {
    const result = validateDefinition(loadFixture('valid/full.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const types = result.value.sections.flatMap((s) => s.questions.map((q) => q.type));
    expect(new Set(types)).toEqual(
      new Set([
        'likert',
        'multiple_choice',
        'matrix',
        'numeric',
        'ranking',
        'free_text',
        'ipsative_most_least',
        'content',
      ])
    );
  });

  it('applies the required=true default', () => {
    const result = validateDefinition(loadFixture('valid/minimal.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.sections[0]?.questions[0]?.required).toBe(true);
  });
});

describe('validateDefinition — shape errors per question type', () => {
  it('rejects likert with scale.max <= scale.min', () => {
    const issues = expectInvalid('likert-bad-scale.json');
    expect(issueMatching(issues, /scale\.max must be greater than scale\.min/)).toBeDefined();
  });

  it('rejects likert with an unknown presentation', () => {
    const issues = expectInvalid('likert-bad-presentation.json');
    expect(issueMatching(issues, /presentation/)).toBeDefined();
  });

  it('rejects multiple_choice with no options', () => {
    const issues = expectInvalid('multiple-choice-empty-options.json');
    expect(issueMatching(issues, /options/)).toBeDefined();
  });

  it('rejects multiple_choice with minSelections > maxSelections', () => {
    const issues = expectInvalid('multiple-choice-min-gt-max.json');
    expect(
      issueMatching(issues, /minSelections must be less than or equal to maxSelections/)
    ).toBeDefined();
  });

  it('rejects matrix with more than 12 rows', () => {
    const issues = expectInvalid('matrix-too-many-rows.json');
    expect(issueMatching(issues, /at most 12 rows/)).toBeDefined();
  });

  it('rejects numeric with a non-positive step', () => {
    const issues = expectInvalid('numeric-bad-step.json');
    expect(issueMatching(issues, /step must be a positive number/)).toBeDefined();
  });

  it('rejects numeric with max not greater than min', () => {
    const issues = expectInvalid('numeric-max-not-gt-min.json');
    expect(issueMatching(issues, /max must be greater than min/)).toBeDefined();
  });

  it('rejects ranking with more than 10 options', () => {
    const issues = expectInvalid('ranking-too-many-options.json');
    expect(issueMatching(issues, /at most 10 options/)).toBeDefined();
  });

  it('rejects free_text with minWords > maxWords', () => {
    const issues = expectInvalid('free-text-min-gt-max-words.json');
    expect(issueMatching(issues, /minWords must be less than or equal to maxWords/)).toBeDefined();
  });

  it('rejects ipsative blocks with fewer than 3 items', () => {
    const issues = expectInvalid('ipsative-too-few-items.json');
    expect(issueMatching(issues, /at least 3 items/)).toBeDefined();
  });

  it('rejects content without a bodyKey', () => {
    const issues = expectInvalid('content-missing-body.json');
    expect(issueMatching(issues, /bodyKey/)).toBeDefined();
  });

  it('rejects unknown question types', () => {
    const issues = expectInvalid('unknown-question-type.json');
    expect(issueMatching(issues, /type/)).toBeDefined();
  });

  it('rejects unknown condition ops', () => {
    const issues = expectInvalid('bad-condition-op.json');
    expect(issueMatching(issues, /showIf/)).toBeDefined();
  });

  it('rejects unsupported schemaVersion values', () => {
    const issues = expectInvalid('bad-schema-version.json');
    expect(issueMatching(issues, /schemaVersion/)).toBeDefined();
  });

  it('rejects non-object input', () => {
    const result = validateDefinition('not a questionnaire');
    expect(result.ok).toBe(false);
  });
});

describe('validateDefinition — semantic rules', () => {
  it('rejects forward showIf references', () => {
    const issues = expectInvalid('forward-reference.json');
    expect(issueMatching(issues, /does not come earlier in document order/)).toBeDefined();
    expect(issues[0]?.path).toBe('sections[0].questions[0].showIf');
  });

  it('rejects self references', () => {
    const issues = expectInvalid('self-reference.json');
    expect(issueMatching(issues, /does not come earlier in document order/)).toBeDefined();
  });

  it('rejects references to unknown questions (nested conditions)', () => {
    const issues = expectInvalid('unknown-reference.json');
    expect(issueMatching(issues, /unknown question "does_not_exist"/)).toBeDefined();
  });

  it('rejects section showIf referencing a question inside the section itself', () => {
    const issues = expectInvalid('section-showif-own-question.json');
    expect(issueMatching(issues, /sections\[1\]\.showIf/)).toBeDefined();
  });

  it('rejects showIf referencing a content block', () => {
    const issues = expectInvalid('content-reference.json');
    expect(issueMatching(issues, /content is never answered/)).toBeDefined();
  });

  it('rejects duplicate question keys across sections', () => {
    const issues = expectInvalid('duplicate-question-keys.json');
    expect(issueMatching(issues, /duplicate question key "q1"/)).toBeDefined();
    expect(issues[0]?.path).toBe('sections[1].questions[0].key');
  });

  it('rejects duplicate section keys', () => {
    const issues = expectInvalid('duplicate-section-keys.json');
    expect(issueMatching(issues, /duplicate section key "s1"/)).toBeDefined();
  });

  it('rejects duplicate option keys within a question', () => {
    const issues = expectInvalid('duplicate-option-keys.json');
    expect(issueMatching(issues, /duplicate option key "a"/)).toBeDefined();
  });

  it('rejects randomizeSections entries naming unknown sections', () => {
    const issues = expectInvalid('randomize-unknown-section.json');
    expect(issueMatching(issues, /unknown section key "nope"/)).toBeDefined();
    expect(issues[0]?.path).toBe('settings.randomizeSections[0]');
  });

  it('allows a question to reference an earlier question in the same section', () => {
    const result = validateDefinition(loadFixture('valid/full.json'));
    expect(result.ok).toBe(true);
  });
});

describe('formatPath', () => {
  it('renders dotted paths with array indices', () => {
    expect(formatPath(['sections', 0, 'questions', 2, 'showIf'])).toBe(
      'sections[0].questions[2].showIf'
    );
  });

  it('renders the root path', () => {
    expect(formatPath([])).toBe('(root)');
  });
});
