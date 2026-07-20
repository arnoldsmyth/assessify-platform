import {
  clientScopeIds,
  isSuperAdmin,
  ok,
  err,
  type CallerContext,
  type DomainError,
  type Result,
} from '@assessify/domain';
import type { ClientRepository, ClientSummary } from '@assessify/repositories';

/**
 * Read-only client directory for the ordering surfaces (D2 — spec 06 wizard
 * step 1 "Choose client (super admin)"; spec 05 scoping). Client lifecycle
 * management (create/update/users) lands with its own epic — this service
 * only answers "which clients may this caller see / order for?".
 */

export interface ClientDirectoryService {
  /**
   * Clients the caller may place orders for (spec 05: super_admin = any
   * client; client_admin / client_user with canPlaceOrders = their own).
   * An empty list means the caller holds ordering-capable roles nowhere.
   */
  listPlaceable(caller: CallerContext): Promise<Result<ClientSummary[]>>;
  /**
   * Clients visible to the caller for display/filtering (orders list):
   * super_admin sees all, client-scoped roles see their own clients.
   */
  listVisible(caller: CallerContext): Promise<Result<ClientSummary[]>>;
}

export interface ClientDirectoryServiceDeps {
  clients: ClientRepository;
}

function forbidden(caller: CallerContext): DomainError {
  return {
    code: 'client/forbidden',
    message: 'You do not have permission to browse clients',
    detail: { kind: caller.kind },
  };
}

export function createClientDirectoryService(
  deps: ClientDirectoryServiceDeps
): ClientDirectoryService {
  const { clients } = deps;

  async function scoped(
    caller: CallerContext,
    placeableOnly: boolean
  ): Promise<Result<ClientSummary[]>> {
    if (caller.kind !== 'user') return err(forbidden(caller));
    if (isSuperAdmin(caller)) return ok(await clients.listAll());

    const ids = placeableOnly
      ? [
          ...new Set(
            caller.roles
              .filter(
                (a) =>
                  a.clientId !== null &&
                  (a.role === 'client_admin' ||
                    (a.role === 'client_user' && a.permissions.canPlaceOrders))
              )
              .map((a) => a.clientId as string)
          ),
        ]
      : clientScopeIds(caller);
    return ok(await clients.findByIds(ids));
  }

  return {
    listPlaceable(caller) {
      return scoped(caller, true);
    },
    listVisible(caller) {
      return scoped(caller, false);
    },
  };
}
