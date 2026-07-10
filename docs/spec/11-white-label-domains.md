# 11 — White-Label Custom Domains

The requirement that shapes hosting: a client/product points a domain they own (e.g. `questionnaire.pro-d.com`) at Assessify via CNAME, and all respondent-facing traffic for that product serves under that hostname with valid TLS and the product's branding. Respondents must never see assessify.ie.

## Hostname → tenant resolution (hosting-independent core)

Next.js middleware on every request:

```
host = request.headers.host (normalised, strip port)
1. host == app.assessify.ie            → admin surface
2. host == assessify.ie / www          → platform marketing/public
3. host ends with .assessify.ie       → product by slug ({slug}.assessify.ie)
4. else                                → custom_domains lookup (status='active') → product (+client) context
   no match → 404 page (unbranded, minimal)
```

- Resolution result (`productId`, `clientId?`, branding config) is attached via request headers to server components; cached in-memory + Valkey (5-min TTL, busted on domain/product update).
- On a white-label host, **only** `(respondent)` and `(public)` route groups are servable; admin routes 404. Absolute URLs in respondent emails are built from the order's product domain (custom domain if active, else slug subdomain) — email links must land on the white-label host.
- Cookies (respondent session JWT) scoped per-host, never cross-domain. No shared auth across hosts is needed because respondent access is token-based.

## Domain lifecycle

1. Super admin adds hostname to a product (`custom_domains`, status `pending_dns`, random `verification_token`).
2. Instructions shown: create `CNAME questionnaire.pro-d.com → <do-app-hostname>` and `TXT _assessify-challenge.questionnaire.pro-d.com = {verification_token}`.
3. "Verify" action (+ background re-check job): DNS lookup confirms both records → status `verifying` → call DigitalOcean API to append the domain to the App Platform app spec (`domains` array) → DO provisions the Let's Encrypt cert → poll until active → status `active`. Failures → `failed` with reason shown.
4. Disable/remove reverses the API call.

**DO App Platform specifics:** custom domains are added via the Apps API (update app spec / `CREATE_DOMAIN`); DO manages certificate issuance and renewal per domain. This is fine for the expected scale (tens of domains, admin-assisted). **Escape hatch if this ever needs to be self-serve at hundreds of domains:** put Cloudflare for SaaS (custom hostnames) in front — the middleware resolution logic above is unchanged; only certificate provisioning moves. Implement the DO calls behind a small `DomainProvisioner` adapter so this swap is contained.

## Branding application

- `products.branding` jsonb → validated Zod shape `{ logoUrl, faviconUrl?, colors: { primary, primaryDark, accent, surfaceTint, ink }, fontFamily?, emailFrom: { name, address } }`.
- Server layout for respondent/public surfaces injects colors as CSS variables (`--brand-primary` etc.) and the logo; components use only these variables — no product-specific styling in code.
- Email sending uses the product's `emailFrom` (sender domains must be verified in SendGrid; platform default sender as fallback until verified — surface verification status in product admin).
- PDF reports use the same branding tokens (`09`).
- Client-specific overrides (same product, different client domain) resolve `custom_domains.client_id` → client-level branding overlay — schema supports it; UI for it is phase 2.
