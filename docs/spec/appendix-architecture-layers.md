# Architecture: Layer Responsibilities & Boundaries

This document defines boundaries between layers to enforce **separation of responsibilities**.
Frontend and backend are distinct; each layer has a single, clear purpose.

---

## 1. SERVICE LAYER (Business Logic)

**Purpose:** Owns *what* the system does. This is the only layer that implements business rules.

**Allowed**
- Enforce business rules and invariants
- Perform transactional operations
- Coordinate multiple repositories
- Validate domain constraints
- Apply authorization (based on passed context)
- Return structured success/error results

**Forbidden**
- HTTP concepts (request, response, headers, status codes)
- Framework dependencies (Next.js, React, Express)
- Cookies, sessions, JWTs
- UI concerns (forms, fields, UX messages)
- Knowledge of caller (web, API, mobile)

**Inputs:** Plain objects (DTOs) + explicit context (caller identity)

**Outputs:** Domain results or typed errors — never HTML, never raw HTTP responses

**Rule:** If this layer changes, every surface (web, API, future clients) benefits.

---

## 2. REPOSITORY LAYER (Data Access)

**Purpose:** Abstract database operations. Services do not know how or where data is stored.

**Allowed**
- Execute database queries
- Map rows to domain entities
- Handle connection pooling
- Manage transactions (when delegated by Service)
- Provide typed query interfaces

**Forbidden**
- Business rules or validation
- Authorization decisions
- Knowledge of HTTP or UI
- Cross-aggregate coordination (Service’s job)

**Inputs:** Query parameters, entities to persist

**Outputs:** Domain entities or null — never raw rows in public interface

**Rule:** If the database changes (Postgres → Mongo), only this layer rewrites.

---

## 3. CONTROLLER LAYERS (Entry Points)

Controllers adapt external requests into service calls. They do **not** contain business logic.

### 3a. Server Actions (Web UI)

**Purpose:** Adapt web form submissions and UI interactions into service calls.

**Allowed**
- Accept form submissions
- Map FormData to service input
- Read session/cookie-based auth
- Call service layer
- Translate service errors into UI-friendly messages
- Trigger revalidation / redirects

**Forbidden**
- Business logic
- Database access
- Direct calls from APIs or external systems

**Rule:** If this layer disappears, only the web UI breaks.

### 3b. API Routes (External Clients)

**Purpose:** Expose stable capabilities to non-web clients (mobile, integrations, webhooks).

**Allowed**
- Authenticate external callers
- Validate request payloads
- Map JSON to service input
- Call service layer
- Return structured HTTP responses

**Forbidden**
- Business logic
- Session/cookie assumptions
- Web-only shortcuts

**Rule:** Once published, breaking changes require versioning.

### 3c. MCP Tools (Agent/Automation Clients)

**Purpose:** Adapt calls from Claude/agent tooling (e.g. `lib/mcp/tools/*`) into service calls —
this is a third controller surface alongside Server Actions and API Routes, not a shortcut around
either.

**Allowed**
- Validate tool-call input against a schema
- Call the service layer
- Translate service errors into tool-result messages

**Forbidden**
- Business logic
- Direct database/repository access
- Session/cookie assumptions

**Rule:** Same contract as API Routes — a stable, callable capability. If it needs to change
behavior, that's a service-layer change, not an MCP-tool-layer one.

---

## 4. INFRASTRUCTURE ADAPTERS (External Services)

**Purpose:** Abstract external integrations. Services do not know which provider is used.

These are “outbound” dependencies: storage, email, SMS, payments.

### Mailer Adapter
- **Interface:** `send(to, subject, body | template, data)`
- **Backends:** SendGrid, Resend, Postmark
- **Forbidden:** Deciding when to send (Service decides)

### SMS Adapter
- **Interface:** `sendSMS(to, message)`
- **Backends:** Twilio, Telnyx
- **Forbidden:** Deciding when to send (Service decides)

### Payment Adapter
- **Interface:** Create customer, save card, pre-auth, capture, refund
- **Backends:** Stripe
- **Forbidden:** Deciding what to charge (Service decides)
- **Webhooks:** Inbound webhooks go API Route → Adapter (parse/validate) → Service (handle)

### Storage Adapter (if needed)
- **Interface:** Upload, download, signed URLs
- **Backends:** S3, R2, local filesystem

**Rule:** If we switch from Twilio to Telnyx, only the SMS adapter changes.

---

## 5. VALIDATION SCHEMAS

**Purpose:** Define data shape and constraints in one place. Shared by controllers and services.

**Rule:** One schema definition, multiple consumers. Never duplicate validation logic.

---

## Dependency Direction

```
  Server Actions  ──→  Service Layer  ──→  Repository
  API Routes      ──→  Service Layer  ──→  Infrastructure Adapters
  MCP Tools       ──→  Service Layer  ──→  Infrastructure Adapters
```

**Never:**
- API calling Server Actions
- Service calling API, Server Actions, or MCP Tools
- Repository calling Service
- Controllers (Server Actions, API Routes, MCP Tools) calling Repository directly (must go
  through Service)

---

## Visual Architecture

```
  ┌─────────────────┐     ┌─────────────────┐
  │  Server Actions │     │   API Routes    │
  │   (Web only)    │     │ (Mobile/Webhook)│
  └────────┬────────┘     └────────┬────────┘
           │                       │
           └───────────┬───────────┘
                       ▼
                ┌─────────────┐
                │   Service   │
                │    Layer    │
                └──────┬──────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │Repository │  │  Mailer   │  │   SMS     │
  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
        │              │              │
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │  Neon DB  │  │ SendGrid  │  │  Twilio   │
  └───────────┘  └───────────┘  └───────────┘
```

---

## Quick Litmus Test

| Question | Answer |
|----------|--------|
| Can mobile call this? | API |
| Is this enforcing rules? | Service |
| Is this handling a form or button? | Server Action |
| Is this reading/writing the database? | Repository |
| Is this calling an external service? | Infrastructure Adapter |
| Is this handling a webhook? | API Route + Adapter + Service |
| Is this called by an MCP/agent tool? | MCP Tool → Service |
| Would this break if we changed databases? | Repository |
| Would this break if we changed email provider? | Mailer Adapter only |

---

## One-Line Summary

- **Repository** = Data access
- **Infrastructure Adapters** = External service abstraction
- **Service Layer** = Business truth
- **Server Actions** = Web convenience
- **API** = Long-term contract
