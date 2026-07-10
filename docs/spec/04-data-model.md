# 04 — Data Model

Source of truth for persistence. Postgres (Neon) holds all structured/transactional data; Firestore holds response documents and in-progress questionnaire state. All DDL below is normative — implement via Drizzle schema producing equivalent SQL. Types: `uuid` = UUIDv7 (generated in app code), `money` columns are `bigint` minor units with a `currency char(3)`, all timestamps `timestamptz`.

## Identifier conventions (hard rules)

- UUID primary keys in **all URLs and API routes**. Human references are display/search only.
- `orders.reference`: `ORD-` + zero-padded seq (`ORD-00042`); line items displayed as `ORD-00042-1`.
- `invoices.reference`: `INV-` + `YYMM` + `-` + zero-padded 5-digit client number (`INV-2607-00123`).
- Redemption codes: 8 chars, uppercase, alphabet `ABCDEFGHJKLMNPQRTUVWXY346789` (no 0/O, 1/I, 2/Z, 5/S lookalikes).
- PINs: 6 digits, stored bcrypt-hashed, never logged.

## Enums

```sql
CREATE TYPE order_type AS ENUM ('named','bulk_named','multi_rater','group','retail','batch_code');
CREATE TYPE order_status AS ENUM ('draft','pending','approved','sent','processing_report','completed',
  'cancelled','payment_error','email_error','on_hold','refunded','resend_email','scoring_error');
CREATE TYPE session_status AS ENUM ('created','invited','started','completed','awaiting_scores','scored','report_ready');
CREATE TYPE payment_provider AS ENUM ('stripe','offline','gocardless');
CREATE TYPE payment_status AS ENUM ('requires_action','pending','succeeded','failed','refunded','partially_refunded');
CREATE TYPE plan_type AS ENUM ('prepay_credits','seat_licence','flat_access','postpay');
CREATE TYPE ledger_entry_type AS ENUM ('purchase','usage','adjustment','expiry','refund');
CREATE TYPE report_model AS ENUM ('individual','aggregate','both');
CREATE TYPE scoring_mode AS ENUM ('sync_internal','async_external');
CREATE TYPE royalty_method AS ENUM ('pct_net_revenue','fixed_per_completion','hybrid');
CREATE TYPE settlement_method AS ENUM ('stripe_connect','platform_invoice','manual');
CREATE TYPE domain_status AS ENUM ('pending_dns','verifying','active','failed','disabled');
CREATE TYPE role_name AS ENUM ('super_admin','assessment_admin','client_admin','client_user','assessment_taker');
```

## Tenancy & catalogue

```sql
CREATE TABLE products (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL,                -- used for {slug}.assessify.ie
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',    -- active | retired
  branding jsonb NOT NULL DEFAULT '{}',     -- {logoUrl, colors:{primary,accent,...}, fonts, emailFrom:{name,address}, faviconUrl}
  default_language text NOT NULL DEFAULT 'en',
  available_languages text[] NOT NULL DEFAULT '{en}',
  external_ids jsonb NOT NULL DEFAULT '{}', -- {"partner_system":"XYZ-001", ...}
  scoring_config jsonb NOT NULL,            -- see 08 (mode, endpoint ref, auth, payload/callback schema keys)
  notification_defaults jsonb NOT NULL DEFAULT '{}',  -- see 13
  report_page_size_default text NOT NULL DEFAULT 'a4',            -- 'a4' | 'letter'
  retail_enabled boolean NOT NULL DEFAULT false,
  retail_price bigint, retail_currency char(3),
  connected_stripe_account_id text,         -- Stripe Connect (day-one field, transfers in phase 2)
  revenue_split_pct numeric(5,2),
  royalty_policy jsonb,                     -- {method, pctNet?, fixedAmount?, hybrid?, settlement, period, externalIdKey}
  timezone text NOT NULL DEFAULT 'Europe/Dublin',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_versions (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  version int NOT NULL,
  variant text NOT NULL DEFAULT 'self',     -- 'self' | rater variant key (e.g. 'manager','peer')
  definition jsonb NOT NULL,                -- validated against questionnaire-schema (07)
  status text NOT NULL DEFAULT 'draft',     -- draft | active | retired
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version, variant)
);

CREATE TABLE report_template_versions (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  version int NOT NULL,
  component_key text NOT NULL,              -- maps to a React template component in code
  config jsonb NOT NULL,                    -- layout/config consumed by the component (09)
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);

CREATE TABLE translation_strings (
  product_id uuid NOT NULL REFERENCES products(id),
  string_key text NOT NULL,
  language text NOT NULL,                   -- BCP47 (en, fr, pt-BR, tl)
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, string_key, language)
);
```

## Parties

```sql
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  client_number int UNIQUE NOT NULL,        -- from sequence; used in INV reference
  name text NOT NULL,
  is_platform_retail boolean NOT NULL DEFAULT false, -- exactly one row true: the retail umbrella client
  billing_email text, billing_address jsonb,
  default_currency char(3) NOT NULL DEFAULT 'EUR',
  xero_contact_id text,
  timezone text NOT NULL DEFAULT 'Europe/Dublin',
  notification_overrides jsonb,             -- see 13
  source text NOT NULL DEFAULT 'native', legacy_id text,  -- 'legacy' for imports
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Better Auth manages its own user/session/account tables. This table extends its user:
CREATE TABLE user_profiles (
  user_id text PRIMARY KEY,                 -- FK to Better Auth user.id
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  role role_name NOT NULL,
  product_id uuid REFERENCES products(id),  -- required for assessment_admin
  client_id uuid REFERENCES clients(id),    -- required for client_admin / client_user
  permissions jsonb NOT NULL DEFAULT '{}',  -- client_user restrictions (05)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, product_id, client_id)
);

CREATE TABLE respondents (                  -- persistent identity across a lifetime of assessments
  id uuid PRIMARY KEY,
  email citext, first_name text, last_name text,
  user_id text,                             -- set if they created an account (retail Pattern 4)
  language text,
  source text NOT NULL DEFAULT 'native', legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX respondents_email_idx ON respondents (email);   -- dedupe anchor, NOT unique (PII deletion may null it)

CREATE TABLE client_groups (               -- projects / cohorts / tags
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL, kind text NOT NULL DEFAULT 'tag',   -- tag | project | team
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);
```

## Orders & fulfilment

```sql
CREATE SEQUENCE order_ref_seq; CREATE SEQUENCE client_number_seq;

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  reference text UNIQUE NOT NULL,           -- 'ORD-' || lpad(nextval,5,'0')
  type order_type NOT NULL,
  status order_status NOT NULL DEFAULT 'draft',
  client_id uuid NOT NULL REFERENCES clients(id),      -- retail orders use the platform retail client
  product_id uuid NOT NULL REFERENCES products(id),
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_versions(id),  -- pinned at creation
  report_template_version_id uuid REFERENCES report_template_versions(id),
  report_language text NOT NULL DEFAULT 'en',
  report_model report_model NOT NULL DEFAULT 'individual',
  currency char(3) NOT NULL,
  subtotal bigint NOT NULL DEFAULT 0, discount_total bigint NOT NULL DEFAULT 0, total bigint NOT NULL DEFAULT 0,
  payment_provider payment_provider,
  entitlement_id uuid,                      -- set when paid by entitlement draw-down
  notification_policy jsonb,                -- order-level override (13)
  suppress_notifications boolean NOT NULL DEFAULT false,  -- legacy 'silent mode' (partner API)
  expected_respondents int,                 -- group orders
  page_size text,                           -- report page size override
  is_test boolean NOT NULL DEFAULT false,
  related_order_id uuid REFERENCES orders(id),           -- legacy upgrades linkage
  placed_by_user_id text, placed_via text NOT NULL DEFAULT 'admin',  -- admin | client | retail | api
  error_detail jsonb,                       -- populated in *_error states
  source text NOT NULL DEFAULT 'native', legacy_id text,
  approved_at timestamptz, sent_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_client_idx ON orders (client_id, status);
CREATE INDEX orders_product_idx ON orders (product_id, status, created_at);

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  line_no int NOT NULL,
  description text NOT NULL,
  unit_price bigint NOT NULL, discount bigint NOT NULL DEFAULT 0, quantity int NOT NULL DEFAULT 1,
  UNIQUE (order_id, line_no)
);

CREATE TABLE order_group_links (
  order_id uuid NOT NULL REFERENCES orders(id),
  group_id uuid NOT NULL REFERENCES client_groups(id),
  PRIMARY KEY (order_id, group_id)
);

CREATE TABLE respondent_sessions (          -- THE central fulfilment record: one person × one assessment
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  respondent_id uuid REFERENCES respondents(id),        -- null until self-registration (patterns 3/5)
  token uuid UNIQUE NOT NULL,               -- the URL secret; distinct from id
  pin_hash text,                            -- bcrypt; null for batch-code sessions
  status session_status NOT NULL DEFAULT 'created',
  is_focal boolean NOT NULL DEFAULT true,   -- false for raters in 360 orders
  rater_relationship text,                  -- 'manager' | 'peer' | ... (per product config)
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_versions(id), -- may differ per rater variant
  language text,                            -- respondent's current display language
  invited_at timestamptz, started_at timestamptz, completed_at timestamptz,
  reminder_count int NOT NULL DEFAULT 0, last_reminder_at timestamptz, reminders_suppressed boolean NOT NULL DEFAULT false,
  scores jsonb,                             -- scored output (dimension scores, bands, narrative keys)
  scored_at timestamptz,
  source text NOT NULL DEFAULT 'native', legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_order_idx ON respondent_sessions (order_id);
CREATE INDEX sessions_status_idx ON respondent_sessions (status, last_reminder_at);

CREATE TABLE group_tokens (                 -- pattern 3: shared link
  id uuid PRIMARY KEY,
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
  token uuid UNIQUE NOT NULL,
  pin_hash text NOT NULL,
  expires_at timestamptz, max_respondents int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redemption_codes (             -- pattern 5: single-use codes
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  code text UNIQUE NOT NULL,                -- 8-char safe alphabet
  status text NOT NULL DEFAULT 'issued',    -- issued | redeemed | expired | void
  redeemed_session_id uuid REFERENCES respondent_sessions(id),
  redeemed_at timestamptz, expires_at timestamptz
);

CREATE TABLE scoring_jobs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES respondent_sessions(id),
  mode scoring_mode NOT NULL,
  status text NOT NULL DEFAULT 'queued',    -- queued | dispatched | awaiting_callback | completed | failed
  callback_token_hash text,                 -- HMAC key for async callback verification (08)
  request_payload jsonb, response_payload jsonb, error text,
  attempts int NOT NULL DEFAULT 0,
  dispatched_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  session_id uuid REFERENCES respondent_sessions(id),   -- null for aggregate reports
  template_version_id uuid NOT NULL REFERENCES report_template_versions(id),
  kind text NOT NULL DEFAULT 'individual',  -- individual | aggregate
  status text NOT NULL DEFAULT 'pending',   -- pending | ready | released
  released_at timestamptz, released_by text,
  legacy_pdf_path text,                     -- Firebase Storage path; set only for migrated reports
  data jsonb,                               -- assembled render data snapshot (09)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_access_links (          -- time-limited external sharing
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id),
  token uuid UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
```

## Billing

```sql
CREATE TABLE entitlements (                 -- one per client × product with a plan
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  product_id uuid NOT NULL REFERENCES products(id),
  plan_type plan_type NOT NULL,
  unit text NOT NULL DEFAULT 'credit',      -- credit | seat | period
  balance int NOT NULL DEFAULT 0,           -- cached; derived from ledger, checked in tx
  unit_price bigint, currency char(3),      -- contracted price per unit
  billing_cycle text,                       -- postpay: daily | weekly | monthly
  period_start date, period_end date,       -- licence/flat plans
  low_balance_threshold int DEFAULT 5,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, product_id, plan_type)
);

CREATE TABLE entitlement_ledger (           -- APPEND-ONLY. Never UPDATE or DELETE rows.
  id uuid PRIMARY KEY,
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  entry_type ledger_entry_type NOT NULL,
  delta int NOT NULL,                       -- +purchase, -usage
  order_id uuid REFERENCES orders(id),
  invoice_id uuid,
  note text, actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE invoice_ref_seq;
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  reference text UNIQUE NOT NULL,           -- INV-YYMM-#####  (##### = client_number)
  client_id uuid NOT NULL REFERENCES clients(id),
  status text NOT NULL DEFAULT 'draft',     -- draft | sent | paid | void
  currency char(3) NOT NULL, subtotal bigint NOT NULL, tax bigint NOT NULL DEFAULT 0, total bigint NOT NULL,
  lines jsonb NOT NULL,                     -- [{description, qty, unitPrice, orderIds[]}]
  xero_invoice_id text, pushed_to_xero_at timestamptz,
  due_date date, paid_at timestamptz, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  order_id uuid REFERENCES orders(id), invoice_id uuid REFERENCES invoices(id),
  provider payment_provider NOT NULL,
  provider_ref text,                        -- Stripe PaymentIntent id etc.
  method text,                              -- card | us_bank_account | offline
  status payment_status NOT NULL,
  amount bigint NOT NULL, currency char(3) NOT NULL,
  error jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE royalty_ledger (               -- APPEND-ONLY
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  session_id uuid REFERENCES respondent_sessions(id),
  basis text NOT NULL,                      -- 'pct_net_revenue' | 'fixed_per_completion'
  basis_amount bigint NOT NULL,             -- the net revenue or unit count basis
  amount bigint NOT NULL, currency char(3) NOT NULL,
  period text NOT NULL,                     -- '2026-07' etc.
  settlement_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE royalty_settlements (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  period_from date NOT NULL, period_to date NOT NULL,
  method settlement_method NOT NULL,
  total bigint NOT NULL, currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'open',      -- open | settled
  settled_at timestamptz, settled_by text, external_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## Platform / integration

```sql
CREATE TABLE custom_domains (
  id uuid PRIMARY KEY,
  hostname text UNIQUE NOT NULL,            -- 'questionnaire.pro-d.com'
  product_id uuid NOT NULL REFERENCES products(id),
  client_id uuid REFERENCES clients(id),    -- optional: client-specific domain
  status domain_status NOT NULL DEFAULT 'pending_dns',
  verification_token text NOT NULL,
  verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  key_hash text UNIQUE NOT NULL,            -- SHA-256 of 'ak_live_...' secret; prefix stored for display
  key_prefix text NOT NULL,
  client_id uuid REFERENCES clients(id), product_id uuid REFERENCES products(id),
  scopes text[] NOT NULL,                   -- ['orders:write','results:read',...]
  last_used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY,
  api_key_id uuid REFERENCES api_keys(id),
  client_id uuid REFERENCES clients(id), product_id uuid REFERENCES products(id),
  url text NOT NULL, secret text NOT NULL,  -- HMAC signing secret
  events text[] NOT NULL,                   -- ['order.completed','report.ready',...]
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id),
  event text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  http_status int, attempts int NOT NULL DEFAULT 0, next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);

CREATE TABLE notification_log (
  id uuid PRIMARY KEY,
  order_id uuid, session_id uuid,
  kind text NOT NULL,                       -- invitation | reminder | report_ready | completion_notice | invoice
  recipient text NOT NULL, template text NOT NULL, language text,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued',    -- queued | sent | delivered | opened | bounced | failed
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  actor_type text NOT NULL,                 -- user | respondent | system | api_key
  actor_id text,
  action text NOT NULL,                     -- 'order.status_changed', 'report.downloaded', ...
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, created_at);

CREATE TABLE platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
```

## PII separation & GDPR

`respondents` (and Better Auth users) are the **only** tables holding respondent PII. `respondent_sessions`, Firestore responses, `scores`, and `reports.data` reference `respondent_id`/`session_id` only. **Erasure request** = null out `respondents.email/first_name/last_name` (keep the row + id), delete Firestore PII fields, purge `notification_log.recipient` for that respondent — assessment/score data survives anonymised. Migration sets the same structure for legacy data.

## Firestore collections

```
responses/{sessionId}                 -- one doc per respondent session
  { orderId, productId, questionnaireVersionId, language,
    startedAt, updatedAt, completedAt,
    progress: { currentSectionKey, answeredCount, totalCount },
    answers: { [questionKey]: { type, value, answeredAt } } }
      -- value shape per question type is defined in 07; option KEYS stored, never display text

response_events/{sessionId}/events/{autoId}   -- append-only fine-grained events (optional, phase 1.5+)
```

Rules: Firestore is accessed **only** from the server (Admin SDK) via `repositories/firestore`; no client SDK access; security rules deny all non-admin access. Raw answers are written before scoring dispatch and are never mutated after `completedAt` is set (re-scoring reads them).

## Invariants (enforce in services + DB where possible)

1. Ledgers (`entitlement_ledger`, `royalty_ledger`, `audit_log`, `webhook_deliveries` payloads) are append-only — no UPDATE/DELETE (enforce via Postgres `REVOKE UPDATE, DELETE` from the app role).
2. `entitlements.balance` must equal `SUM(ledger.delta)`; recompute check in a nightly job; drawdown happens in one transaction with `SELECT ... FOR UPDATE` on the entitlement row.
3. A `redemption_code` transitions `issued → redeemed` exactly once (`UPDATE ... WHERE status='issued'` guarded).
4. `orders.status` transitions only along edges defined in `06`; service rejects anything else.
5. One `respondent_sessions.token` = one questionnaire run; tokens are never reissued (new invitation = new session or explicit resend of same token, logged).
6. Sequential references are generated inside the insert transaction from sequences — never computed client-side.
