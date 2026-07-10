# 05 — Roles & Respondent Access

## Staff/client roles (session-authenticated via Better Auth)

| Role | Scope columns on `role_assignments` | Can do |
|---|---|---|
| `super_admin` | none | Everything: all products, clients, orders; place orders as any client or retail; manage domains, API keys, settlements; override entitlement blocks; retry error states |
| `assessment_admin` | `product_id` (one row per product) | Read-only owner dashboard for their product(s): orders, completions, revenue split, royalty statements; manage questionnaire/report versions and translations for their product |
| `client_admin` | `client_id` | Place orders (subject to entitlement), manage client users and groups, view all client orders/results, trigger/suppress reminders, configure client notification overrides |
| `client_user` | `client_id` + `permissions` jsonb | Subset of client_admin per permissions: `{products: [uuid...] \| "all", groups: [uuid...] \| "all", canPlaceOrders: bool, canViewResults: bool, canReleaseReports: bool}` |
| `assessment_taker` | via `respondents.user_id` | Optional account (retail Pattern 4): view own report history, reorder. Most respondents never have an account |

Authorisation lives in the **service layer**: every service method takes a `CallerContext { kind: 'user'|'api_key'|'respondent'|'system', id, roles[] }` and checks scope before acting. Controllers only authenticate and construct the context. A user can hold multiple role assignments (e.g. client_admin of two clients).

**Session policy:** 1-hour idle timeout with warning (carried from legacy), 30-day refresh max. Magic link + email/password both enabled for staff/client users.

## Respondent access (token-based, deliberately NOT auth accounts)

All five patterns resolve to a `respondent_session` row. The token is the URL secret; verification differs per pattern.

| Pattern | Entry URL (on white-label host) | Verification | Identity |
|---|---|---|---|
| 1. Named invitation | `/a/{token}` | 6-digit PIN from invitation email | Known at order time |
| 2. Bulk named | `/a/{token}` (one per person) | PIN per person | Known at order time |
| 3. Group/team link | `/g/{groupToken}` | Shared PIN + self-registration (name+email) → creates respondent + session | Collected at start |
| 4. Retail | `/a/{token}` | PIN from post-checkout email | From checkout |
| 5. Batch code | `/redeem` (public page) | The code itself + self-registration | Collected at redemption |

### Verification flow (patterns 1/2/4)
1. GET `/a/{token}` → look up session by token. Unknown/void → generic "link not valid" (no detail leakage).
2. Respondent enters PIN → bcrypt compare against `pin_hash`. **5 failed attempts → 15-minute lockout** on the session (store counters in Valkey). PIN re-entry required when the signed session cookie (below) is absent/expired.
3. Success → set an HttpOnly signed cookie scoped to the session (`resp_session={sessionId, exp}` JWT, 24h) so page reloads don't re-prompt; proceed to questionnaire (or report if already completed and released).

### Group flow (pattern 3)
1. GET `/g/{groupToken}` → validate `group_tokens` (not expired, `max_respondents` not reached counting sessions on the order).
2. Shared PIN check → self-registration form (first name, last name, email) → find-or-create `respondents` by email → create `respondent_session` (`is_focal` true) → continue as above.

### Redemption flow (pattern 5)
1. `/redeem` (also reachable on white-label hosts) → enter code → `UPDATE redemption_codes SET status='redeemed' ... WHERE code=$1 AND status='issued' AND (expires_at IS NULL OR expires_at > now())` — atomic single-use guarantee.
2. Self-registration → create respondent + session, link `redeemed_session_id`. Code shown as used in the client dashboard.

### Token/PIN rules
- Tokens: UUIDv4 random (not v7 — no time ordering leakage), never reused, no PII in URL.
- Named-invitation tokens do not expire by default; group tokens and codes support optional expiry.
- PINs: 6 numeric digits, generated per session (per group for pattern 3), bcrypt-hashed, sent only in the invitation email, never logged or displayed in admin UI (admins can *regenerate*, not view).
- Resend: admin/client can trigger re-send of invitation (same token, regenerated PIN allowed) — logged to `audit_log` + `notification_log`.
- Report access post-completion uses the same token+PIN gate; separately, time-limited `report_access_links` allow external sharing (`09`).

## Permission matrix (service-level checks, non-exhaustive but normative)

| Action | super_admin | assessment_admin | client_admin | client_user | respondent |
|---|---|---|---|---|---|
| Create order (own client) | ✔ any client | ✖ | ✔ | if `canPlaceOrders` | ✖ |
| View order results | ✔ | ✔ own product, read-only | ✔ own client | if `canViewResults` + scope | own session only |
| Release/hold reports | ✔ | ✖ | ✔ | if `canReleaseReports` | ✖ |
| Manage questionnaire versions | ✔ | ✔ own product | ✖ | ✖ | ✖ |
| Manage entitlements/invoices | ✔ | ✖ | view own | ✖ | ✖ |
| Royalty statements | ✔ | ✔ own product | ✖ | ✖ | ✖ |
| Retry error-state orders | ✔ | ✖ | ✖ | ✖ | ✖ |
| Manage custom domains / API keys | ✔ | ✖ | ✖ | ✖ | ✖ |
| Trigger/suppress reminders | ✔ | ✖ | ✔ | scope | ✖ |

Every check failure returns a typed `Forbidden` domain error; API surfaces it as 403, web as a friendly message. **UUID knowledge is never sufficient** — every lookup re-verifies scope.
