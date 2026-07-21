/**
 * Invitation link construction (D5 — spec 05 entry URLs on white-label
 * hosts, spec 11 hostname model). Pure functions, no I/O: the invitation
 * service feeds them the product's active custom domains and the platform's
 * slug base domain; unit tests need no database.
 *
 * Host preference mirrors what tenant resolution (F1) will serve:
 *   1. an active custom domain scoped to the order's client;
 *   2. an active product-generic custom domain;
 *   3. the `{slug}.<base domain>` subdomain.
 * All three resolve to the same product surface, so a link built here always
 * lands on a host F1 recognises.
 */

/** The slice of an active custom-domain row the link builder needs. */
export interface InvitationCustomDomain {
  hostname: string;
  /** Non-null when the domain is client-specific (spec 11 phase 2). */
  clientId: string | null;
}

export interface ResolveInvitationHostInput {
  productSlug: string;
  /** Primary base domain serving `{slug}.` subdomains (e.g. `assessify.ie`). */
  slugBaseDomain: string;
  /** Active custom domains for the product (any order). */
  customDomains: readonly InvitationCustomDomain[];
  /** The order's client — selects a client-specific domain when one exists. */
  clientId: string | null;
}

export function resolveInvitationHost(input: ResolveInvitationHostInput): string {
  const clientDomain =
    input.clientId === null
      ? undefined
      : input.customDomains.find((domain) => domain.clientId === input.clientId);
  const productDomain = input.customDomains.find((domain) => domain.clientId === null);
  return (
    (clientDomain ?? productDomain)?.hostname ?? `${input.productSlug}.${input.slugBaseDomain}`
  );
}

/**
 * Respondent entry URL for patterns 1/2/4 (spec 05): `https://{host}/a/{token}`.
 * Always https — white-label hosts are TLS-terminated in every environment
 * the platform emails links for. The token is the only URL secret; no PII.
 */
export function buildRespondentEntryUrl(host: string, token: string): string {
  return `https://${host}/a/${token}`;
}
