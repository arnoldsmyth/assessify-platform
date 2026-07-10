# 07 — Questionnaire Engine

Questionnaires are **versioned JSON definitions** attached to a product (`questionnaire_versions.definition`), authored with AI assistance against a formal Zod schema (`packages/questionnaire-schema`), reviewed and imported by an admin. There is no UI builder. The schema is therefore a first-class, versioned, documented artefact — it is the instruction target for AI authoring agents.

## Definition schema (normative shape)

```ts
// packages/questionnaire-schema — Zod; JSON Schema auto-exported for AI authoring prompts
type QuestionnaireDefinition = {
  schemaVersion: 1;
  key: string;                    // e.g. 'pro-d-core'
  titleKey: string;               // ALL user-facing text = translation string keys (translation_strings)
  settings: {
    progressBar: boolean;
    allowBack: boolean;
    randomizeSections?: string[]; // section keys eligible for shuffling
  };
  sections: Section[];
};

type Section = {
  key: string;                    // stable, unique within definition; answers are keyed under it
  titleKey?: string; instructionsKey?: string;
  showIf?: Condition;             // section-level branching
  questions: Question[];
};

type QuestionBase = {
  key: string;                    // stable unique key — NEVER renamed across versions (scoring depends on it)
  textKey: string; helpKey?: string;
  required: boolean;              // default true
  showIf?: Condition;
};

type Question = QuestionBase & (
  | { type: 'likert'; scale: { min: number; max: number; labelKeys: Record<number,string>; presentation: 'radio'|'slider' } }
  | { type: 'multiple_choice'; options: Option[]; multi: boolean; minSelections?: number; maxSelections?: number }
  | { type: 'matrix'; rows: Option[]; scale: { min: number; max: number; labelKeys: Record<number,string> } }
  | { type: 'numeric'; min: number; max: number; step: number; unitKey?: string; presentation: 'slider'|'input' }
  | { type: 'ranking'; options: Option[] }                       // drag-to-order all items
  | { type: 'free_text'; multiline: boolean; minWords?: number; maxWords?: number; maxChars?: number }
  | { type: 'ipsative_most_least'; items: Option[] }             // block of N (typically 4) — see below
  | { type: 'content'; bodyKey: string; mediaUrl?: string }      // non-response section content
);

type Option = { key: string; labelKey: string };                 // answers store option KEYS only

type Condition =                                                  // structured branching logic
  | { op: 'answered'; question: string }
  | { op: 'eq'|'neq'; question: string; value: string|number }
  | { op: 'in'; question: string; values: (string|number)[] }
  | { op: 'gt'|'gte'|'lt'|'lte'; question: string; value: number }
  | { op: 'and'|'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };
```

Validator rules (CLI `pnpm qdef validate <file>` + enforced on admin import): unique keys; every `*Key` present in `translation_strings` for the product's default language (warn for other languages — fallback applies); `showIf` references only questions **earlier** in document order (no forward/circular refs); ipsative blocks have ≥3 items; ranking ≤10 options; matrix ≤12 rows.

## Answer value shapes (stored in Firestore `answers[questionKey].value`)

| type | value |
|---|---|
| likert / numeric | `number` |
| multiple_choice (single) | `optionKey: string`; (multi) `string[]` |
| matrix | `{ [rowKey]: number }` |
| ranking | `string[]` (option keys in ranked order) |
| free_text | `string` |
| ipsative_most_least | `{ most: itemKey, least: itemKey }` |
| content | never answered |

## Ipsative forced-choice (distinct type — get this right)

A block of N items with two radio columns: **Most like me** and **Least like me**.

- Exactly one Most AND one Least per block; they must be different rows. Selecting Most on a row that is currently Least clears the Least (and vice versa) — never allow both on one row, never silently keep an invalid pair.
- Keyboard accessible: each column is a radio group (`role="radiogroup"`, arrow-key navigation); row labels are associated with both radios via `aria-labelledby`.
- Validation message when incomplete: distinct messages for "choose one Most", "choose one Least", "Most and Least can't be the same statement".
- Component test coverage is mandatory for: same-row conflict resolution, partial completion block, keyboard-only completion.

## Rendering & flow

- One route: `/(respondent)/a/[token]/q` — server loads session + pinned `questionnaire_versions.definition` + translations for the active language; client renders section-by-section.
- **Branching**: evaluate `showIf` against current answers on every answer change (pure function in `packages/domain`, shared by renderer and validator; unit-test the condition evaluator exhaustively). Hidden questions are not required and their answers are **retained but flagged** `hidden: true` at submit (scoring adapters decide whether to use them; default: excluded from scoring payload).
- **Progress save**: every answer writes through a server action to Firestore (`answers[key]`), debounced client-side but flushed on blur/navigation; `progress` recomputed server-side. Respondent can close the browser and resume via the same link+PIN. Progress bar shows answered/total of currently-visible required questions.
- **Language switching**: switcher lists `products.available_languages`; changes `respondent_sessions.language` and re-renders labels. Answers are language-agnostic (option keys), so switching mid-flight is lossless.
- **Completion**: submit validates all visible required questions server-side (same Zod-driven rules as client); sets Firestore `completedAt`, session `status='completed'`, fires `scoring.dispatch` job (`08`). Answers become immutable.
- **Accessibility**: WCAG 2.1 AA. All question types keyboard-operable; ranking requires a keyboard alternative (up/down reorder buttons per item, not drag-only); sliders expose `aria-valuetext` with the label of the current value; error summaries linked to fields; visible focus states; touch targets ≥44px.
- Autosave failures show a retry banner and block navigation to the next section (never lose answers silently).

## Versioning rules

- Orders pin `questionnaire_version_id` at creation; in-flight sessions are never migrated to newer versions.
- A new upload for a product = new `version` (immutable once `active`). Editing a `draft` version is allowed.
- Question `key` stability across versions is a convention the AI-authoring prompt must state (scoring configs reference keys); the validator warns when an active version's keys disappear in the next version.
- Rater variants: separate rows (`variant='manager'` etc.) sharing the version number; `multi_rater` orders resolve the right variant per session's `rater_relationship`.
