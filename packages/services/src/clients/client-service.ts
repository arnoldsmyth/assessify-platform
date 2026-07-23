import {
  createClientSchema,
  err,
  isSuperAdmin,
  ok,
  orgScopeIds,
  updateClientSchema,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type Client,
  type DomainError,
  type Result,
} from '@assessify/domain';
import type {
  ClientPatch,
  ClientRepository,
  ClientSummary,
  OrganizationRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';

/**
 * Client lifecycle management (O1 — create/edit clients under an org; spec 04
 * parties; owner decisions 2026-07-21: clients belong to exactly one
 * organization). Deliberately separate from {@link ../clients/client-directory-service}
 * (`ClientDirectoryService`), which only answers "which clients may this
 * caller browse/order for" for the ordering surfaces — this service is the
 * write side (create/update) plus the management read paths (get/list) that
 * back the admin clients UI.
 *
 * Authorization model (spec 05, M2 org re-scope): super_admin may create/edit
 * clients in any organization; an org admin (assessment_admin scoped to the
 * organization) may create/edit clients in THEIR organization only; client
 * roles (client_admin / client_user) have no access to this management
 * surface at all.
 */

export interface ClientService {
  create(caller: CallerContext, input: unknown): Promise<Result<Client>>;
  update(caller: CallerContext, id: string, input: unknown): Promise<Result<Client>>;
  /** Full entity (edit-form prefill). super_admin, or an org admin of the client's organization. */
  get(caller: CallerContext, id: string): Promise<Result<Client>>;
  /**
   * Clients the caller may manage: super_admin sees all, an org admin sees
   * every client of their organization(s). Client roles get `client/forbidden`
   * — this is the management surface, not the ordering directory.
   */
  list(caller: CallerContext): Promise<Result<ClientSummary[]>>;
}

export interface ClientServiceDeps {
  clients: ClientRepository;
  organizations: OrganizationRepository;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validationError(
  issues: { path: string; message: string }[],
  message = 'Client payload failed validation'
): DomainError {
  return { code: 'client/validation', message, detail: { issues } };
}

function zodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function notFound(id: string): DomainError {
  return { code: 'client/not_found', message: 'Client not found', detail: { id } };
}

function organizationNotFound(organizationId: string): DomainError {
  return {
    code: 'client/organization_not_found',
    message: 'Organization not found',
    detail: { organizationId },
  };
}

function forbidden(caller: CallerContext, message: string): DomainError {
  return {
    code: 'client/forbidden',
    message,
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

/** Org admin (assessment_admin of the org) or super_admin — same rule as OrganizationService.canManageOrg. */
function canManageOrg(caller: CallerContext, organizationId: string): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(organizationId);
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

/** Drop keys whose value is undefined so a patch never clobbers with undefined. */
function definedFields<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

export function createClientService(deps: ClientServiceDeps): ClientService {
  const { clients, organizations, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  // As in organization-service/product-service: the state change and its
  // audit entry are not yet one transaction; a failed audit write surfaces
  // as the operation's error.
  return {
    async create(caller, input) {
      const parsed = createClientSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));

      if (!canManageOrg(caller, parsed.data.organizationId)) {
        return err(
          forbidden(
            caller,
            'Only super admins or the organization’s own admins can create clients in it'
          )
        );
      }

      // Friendly pre-check before the FK backstop (mirrors product-service).
      const organization = await organizations.findById(parsed.data.organizationId);
      if (!organization) return err(organizationNotFound(parsed.data.organizationId));

      const timestamp = now();
      const client: Omit<Client, 'clientNumber'> = {
        id: generateId(),
        organizationId: parsed.data.organizationId,
        name: parsed.data.name,
        billingEmail: parsed.data.billingEmail ?? null,
        billingAddress: parsed.data.billingAddress ?? null,
        defaultCurrency: parsed.data.defaultCurrency,
        xeroContactId: null,
        timezone: parsed.data.timezone,
        notificationOverrides: parsed.data.notificationOverrides ?? null,
        source: 'native',
        legacyId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const created = await clients.insert(client);
      const audited = await audit.record(
        auditActor(caller),
        'client.created',
        { type: 'client', id: created.id },
        { organizationId: created.organizationId, clientNumber: created.clientNumber }
      );
      if (!audited.ok) return err(audited.error);
      return ok(created);
    },

    async update(caller, id, input) {
      if (!UUID_RE.test(id)) return err(notFound(id));

      const existing = await clients.findById(id);
      if (!existing) return err(notFound(id));

      if (!canManageOrg(caller, existing.organizationId)) {
        return err(
          forbidden(
            caller,
            'Only super admins or the organization’s own admins can edit this client'
          )
        );
      }

      const parsed = updateClientSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const patch = definedFields(parsed.data) as ClientPatch;

      const updated = await clients.update(id, { ...patch, updatedAt: now() });
      if (!updated) return err(notFound(id));
      const audited = await audit.record(
        auditActor(caller),
        'client.updated',
        { type: 'client', id },
        { changedFields: Object.keys(patch) }
      );
      if (!audited.ok) return err(audited.error);
      return ok(updated);
    },

    async get(caller, id) {
      if (!UUID_RE.test(id)) return err(notFound(id));
      const client = await clients.findById(id);
      if (!client) return err(notFound(id));
      if (!canManageOrg(caller, client.organizationId)) {
        return err(
          forbidden(caller, 'Only super admins or the organization’s own admins can view this client')
        );
      }
      return ok(client);
    },

    async list(caller) {
      if (isSuperAdmin(caller)) return ok(await clients.listAll());
      if (caller.kind !== 'user') {
        return err(forbidden(caller, 'You do not have permission to manage clients'));
      }
      const orgIds = orgScopeIds(caller);
      if (orgIds.length === 0) {
        return err(forbidden(caller, 'You do not have permission to manage clients'));
      }
      return ok(await clients.listByOrganizationIds(orgIds));
    },
  };
}
