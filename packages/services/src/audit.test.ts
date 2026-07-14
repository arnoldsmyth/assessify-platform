import { describe, expect, it, vi } from 'vitest';
import type { AuditActor, AuditEntityRef, AuditEvent } from '@assessify/domain';
import type { AuditLogRepository } from '@assessify/repositories';
import { createAuditService } from './audit';

const actor: AuditActor = { kind: 'user', id: 'usr_123' };
const entityRef: AuditEntityRef = {
  type: 'order',
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
};

function persisted(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '01890a5d-ac96-774b-bcce-b302099a8058',
    actor,
    action: 'order.status_changed',
    entityRef,
    detail: { from: 'draft', to: 'active' },
    createdAt: new Date('2026-07-14T10:00:00Z'),
    ...overrides,
  };
}

function mockRepository(overrides: Partial<AuditLogRepository> = {}): AuditLogRepository {
  return {
    insert: vi.fn().mockResolvedValue(persisted()),
    listByEntity: vi.fn().mockResolvedValue({ items: [persisted()], hasMore: false }),
    listByActor: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    ...overrides,
  };
}

describe('auditService.record', () => {
  it('validates then persists and returns the stored event', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.record(actor, 'order.status_changed', entityRef, {
      from: 'draft',
      to: 'active',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('01890a5d-ac96-774b-bcce-b302099a8058');
      expect(result.value.action).toBe('order.status_changed');
    }
    expect(repo.insert).toHaveBeenCalledExactlyOnceWith({
      actor,
      action: 'order.status_changed',
      entityRef,
      detail: { from: 'draft', to: 'active' },
    });
  });

  it('rejects a non-namespaced action without touching the repository', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.record(actor, 'statuschanged', entityRef);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_event_invalid');
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects a non-system actor without an id', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.record(
      { kind: 'user', id: null },
      'order.status_changed',
      entityRef
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_event_invalid');
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('allows a system actor with a null id', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.record(
      { kind: 'system', id: null },
      'order.expired',
      entityRef
    );

    expect(result.ok).toBe(true);
  });

  it('maps a repository failure to an error result instead of throwing', async () => {
    const repo = mockRepository({
      insert: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.record(actor, 'order.status_changed', entityRef);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('audit_write_failed');
      expect(result.error.detail).toEqual({ cause: 'connection refused' });
    }
  });
});

describe('auditService.listByEntity', () => {
  it('returns the page from the repository', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.listByEntity(entityRef, { limit: 10, offset: 0 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.hasMore).toBe(false);
    }
    expect(repo.listByEntity).toHaveBeenCalledExactlyOnceWith(entityRef, {
      limit: 10,
      offset: 0,
    });
  });

  it('rejects an invalid entity ref', async () => {
    const repo = mockRepository();
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.listByEntity({ type: 'order', id: 'not-a-uuid' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_entity_ref_invalid');
    expect(repo.listByEntity).not.toHaveBeenCalled();
  });

  it('maps a repository failure to an error result', async () => {
    const repo = mockRepository({
      listByEntity: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const service = createAuditService({ auditLogRepository: repo });

    const result = await service.listByEntity(entityRef);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_read_failed');
  });
});
