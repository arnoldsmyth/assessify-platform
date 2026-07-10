# 15 — Brand & Design System ("Ember")

The Assessify platform brand. Applies to the admin surface, platform emails, invoices, and marketing pages. Respondent-facing surfaces use per-product branding (`11`) built on the same token structure — Ember is also the default theme for products without custom branding.

## Palette (decided — "Ember": warm orange + deep teal)

| Token | Hex | Use |
|---|---|---|
| `--color-primary` | `#C2410C` | Primary actions, links, active nav, focus rings |
| `--color-primary-bright` | `#F97316` | Hover/active emphasis, progress bars, small accents (not large fills) |
| `--color-primary-tint` | `#FFF7ED` | Selected rows, callout backgrounds, badge tints |
| `--color-ink` | `#292524` | Headings, app topbar/sidebar background |
| `--color-body` | `#44403C` | Body text |
| `--color-muted` | `#78716C` | Secondary text, placeholders |
| `--color-teal` | `#0F766E` | Success, `completed` status, positive deltas |
| `--color-teal-tint` | `#E1F5F2` | Success/completed badge backgrounds |
| `--color-amber` | `#B45309` on `#FEF3C7` | Warning states (`on_hold`, `pending`, low balance) |
| `--color-red` | `#B91C1C` on `#FEE2E2` | Error states (`payment_error`, `email_error`, `scoring_error`) |
| `--color-surface` | `#FFFFFF` / page `#FAFAF9` | Cards / page background |
| `--color-border` | `#E7E5E4` | Hairlines, dividers, input borders |

Rules: text on tinted badges always uses the dark shade of the same family (e.g. `#9A3412` on `#FFF7ED`). `#F97316` never carries body text (contrast); use `#C2410C` for text-sized elements. All pairings must pass WCAG AA (4.5:1 body, 3:1 large text) — CI includes a token contrast test.

Order-status → colour mapping: `completed`=teal, `sent`/`processing_report`=orange tint, `draft`/`pending`=neutral, `on_hold`/`resend_email`=amber, `cancelled`/`refunded`=neutral-muted, `*_error`=red.

## Typography

- UI: **Inter** (variable), self-hosted. Weights 400/500/600 only.
- Reports/PDF default: **Source Serif 4** for narrative + Inter for labels (per-product brand fonts may override; fonts must be embeddable — licence check per product).
- Scale: 13/14/16/18/22/28. Base 14 in admin (dense tables), 16 respondent-facing.

## Iconography

**lucide** (lucide.dev) exclusively — `lucide-react` package, outline style, `strokeWidth={1.75}`, sizes 16/20/24. Never mix icon sets; never use emoji as UI icons. Common mappings: orders `clipboard-list`, clients `building-2`, respondents `users`, reports `file-chart-column`, questionnaires `list-checks`, billing `receipt`, settings `settings-2`, domains `globe`, error queue `triangle-alert`, release `send`.

## Components & layout

- Base: **shadcn/ui** (Radix primitives) themed with the tokens above via CSS variables — accessible primitives for free, full styling control, no runtime dependency on a component SaaS.
- Admin layout: dark-ink left sidebar (`--color-ink` bg, orange active indicator), white content area, breadcrumb + page actions header. Dense data tables with sticky headers, status badges, row actions.
- Respondent questionnaire: single-column, max-width 720px, one section per screen, large touch targets (≥44px), calm neutral background with product-brand primary for progress + actions. No sidebar, no chrome — the questionnaire is the page.
- Forms: labels above inputs; inline validation on blur; error summary block on submit for a11y.
- Motion: 150–200ms ease-out transitions only; respect `prefers-reduced-motion`.

## Accessibility (binding)

WCAG 2.1 AA across all surfaces; the questionnaire renderer is the critical path (`07` details ipsative/ranking/matrix interaction requirements). Keyboard-first testing is part of the definition of done for every respondent-facing component; automated axe checks in CI on questionnaire and report pages.

## Voice

Respondent-facing copy: plain, warm, second person, no jargon ("You're about halfway there", not "Section 4 of 9 incomplete"). Admin copy: terse and factual. Sentence case everywhere. Error messages say what happened and what to do next.
