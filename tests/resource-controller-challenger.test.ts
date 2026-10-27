import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@framework/core';
import type { Page, PageRequest, QueryOptions } from '@framework/database';
import { ResourceController } from '../src/controller';
import type { ResourceService } from '../src/service';

interface TestEntity {
  id: number;
  name: string;
  secret: string;
  metadata?: { tags: string[]; nested: { active: boolean } };
  createdAt?: Date;
  deletedAt?: Date | null;
}

type TestCreate = JsonObject & {
  name: string;
  secret: string;
};

type TestUpdate = Partial<TestCreate>;

interface TestDto {
  id: string;
  publicName: string;
  hasMetadata: boolean;
}

function createMockService(initialItems: TestEntity[] = []): ResourceService<TestEntity, TestCreate, TestUpdate> & {
  calls: Record<string, unknown[]>;
} {
  const calls: {
    list: unknown[];
    listDeleted: unknown[];
    get: unknown[];
    getDeleted: unknown[];
    create: unknown[];
    update: unknown[];
    delete: unknown[];
    restore: unknown[];
  } = {
    list: [],
    listDeleted: [],
    get: [],
    getDeleted: [],
    create: [],
    update: [],
    delete: [],
    restore: [],
  };

  const activeItems = [...initialItems];
  const deletedItems: TestEntity[] = [];

  const service = {
    calls,
    list: async (request: PageRequest, query: QueryOptions = {}): Promise<Page<TestEntity>> => {
      calls.list.push({ request, query });
      return {
        items: activeItems,
        meta: {
          page: request.page,
          limit: request.limit,
          total: activeItems.length,
          totalPages: Math.max(1, Math.ceil(activeItems.length / request.limit)),
        },
      };
    },
    listDeleted: async (request: PageRequest, query: QueryOptions = {}): Promise<Page<TestEntity>> => {
      calls.listDeleted.push({ request, query });
      return {
        items: deletedItems,
        meta: {
          page: request.page,
          limit: request.limit,
          total: deletedItems.length,
          totalPages: Math.max(1, Math.ceil(deletedItems.length / request.limit)),
        },
      };
    },
    get: async (id: number): Promise<TestEntity> => {
      calls.get.push(id);
      const found = activeItems.find((i) => i.id === id);
      if (!found) throw new Error(`Entity ${id} not found`);
      return found;
    },
    getDeleted: async (id: number): Promise<TestEntity> => {
      calls.getDeleted.push(id);
      const found = deletedItems.find((i) => i.id === id);
      if (!found) throw new Error(`Deleted entity ${id} not found`);
      return found;
    },
    create: async (input: TestCreate): Promise<TestEntity> => {
      calls.create.push(input);
      const created: TestEntity = { id: 100, ...input };
      activeItems.push(created);
      return created;
    },
    update: async (id: number, input: TestUpdate): Promise<TestEntity> => {
      calls.update.push({ id, input });
      const found = activeItems.find((i) => i.id === id);
      if (!found) throw new Error(`Entity ${id} not found for update`);
      const updated = { ...found, ...input };
      return updated;
    },
    delete: async (id: number): Promise<void> => {
      calls.delete.push(id);
      const idx = activeItems.findIndex((i) => i.id === id);
      if (idx >= 0) {
        const removed = activeItems[idx];
        if (removed) {
          activeItems.splice(idx, 1);
          deletedItems.push({ ...removed, deletedAt: new Date() });
        }
      }
    },
    restore: async (id: number): Promise<TestEntity> => {
      calls.restore.push(id);
      const idx = deletedItems.findIndex((i) => i.id === id);
      if (idx < 0) throw new Error(`Deleted entity ${id} not found to restore`);
      const removed = deletedItems[idx];
      if (!removed) throw new Error(`Deleted entity ${id} not found to restore`);
      deletedItems.splice(idx, 1);
      const activeRestored: TestEntity = { ...removed, deletedAt: null };
      activeItems.push(activeRestored);
      return activeRestored;
    },
  };

  return service as unknown as ResourceService<TestEntity, TestCreate, TestUpdate> & {
    calls: Record<string, unknown[]>;
  };
}

describe('Empirical Challenger: ResourceController & DTO Transforms Stress Harness', () => {
  const entity1: TestEntity = {
    id: 1,
    name: 'Item One',
    secret: 'sensitive_token_123',
    metadata: { tags: ['alpha', 'beta'], nested: { active: true } },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const entity2: TestEntity = {
    id: 2,
    name: 'Item Two',
    secret: 'sensitive_token_456',
    metadata: { tags: ['gamma'], nested: { active: false } },
    createdAt: new Date('2026-01-02T00:00:00Z'),
    deletedAt: null,
  };

  const serializeToDto = (entity: TestEntity): TestDto => ({
    id: `dto_${entity.id}`,
    publicName: entity.name.toUpperCase(),
    hasMetadata: Boolean(entity.metadata?.tags?.length),
  });

  describe('Dimension 1: DTO Projection through serialize across ALL controller endpoints', () => {
    test('1.1: list (index) projects every item through serialize', async () => {
      const service = createMockService([entity1, entity2]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.list({ page: 1, limit: 10 });
      expect(result.items).toEqual([
        { id: 'dto_1', publicName: 'ITEM ONE', hasMetadata: true },
        { id: 'dto_2', publicName: 'ITEM TWO', hasMetadata: true },
      ]);
      expect(result.items.some((item) => 'secret' in item)).toBe(false);
    });

    test('1.2: show projects single entity through serialize', async () => {
      const service = createMockService([entity1]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.show(1);
      expect(result).toEqual({ id: 'dto_1', publicName: 'ITEM ONE', hasMetadata: true });
      expect('secret' in (result as unknown as Record<string, unknown>)).toBe(false);
    });

    test('1.3: store (create) projects newly created entity through serialize', async () => {
      const service = createMockService([]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.store({ name: 'Fresh Item', secret: 'hide_me' });
      expect(result).toEqual({ id: 'dto_100', publicName: 'FRESH ITEM', hasMetadata: false });
      expect('secret' in (result as unknown as Record<string, unknown>)).toBe(false);
    });

    test('1.4: update projects updated entity through serialize', async () => {
      const service = createMockService([entity1]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.update(1, { name: 'Updated Item' });
      expect(result).toEqual({ id: 'dto_1', publicName: 'UPDATED ITEM', hasMetadata: true });
    });

    test('1.5: deleted projects soft-deleted items through serialize', async () => {
      const service = createMockService([entity1, entity2]);
      await service.delete(1);
      await service.delete(2);

      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.deleted({ page: 1, limit: 10 });
      expect(result.items).toHaveLength(2);
      expect(result.items).toEqual([
        { id: 'dto_1', publicName: 'ITEM ONE', hasMetadata: true },
        { id: 'dto_2', publicName: 'ITEM TWO', hasMetadata: true },
      ]);
    });

    test('1.6: showDeleted projects single soft-deleted entity through serialize', async () => {
      const service = createMockService([entity1]);
      await service.delete(1);

      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.showDeleted(1);
      expect(result).toEqual({ id: 'dto_1', publicName: 'ITEM ONE', hasMetadata: true });
    });

    test('1.7: restore projects restored entity through serialize', async () => {
      const service = createMockService([entity1]);
      await service.delete(1);

      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.restore(1);
      expect(result).toEqual({ id: 'dto_1', publicName: 'ITEM ONE', hasMetadata: true });
    });

    test('1.8: destroy does not invoke serialize and returns void', async () => {
      let serializeInvoked = false;
      const service = createMockService([entity1]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, (entity) => {
        serializeInvoked = true;
        return serializeToDto(entity);
      });

      const result = await controller.destroy(1);
      expect(result).toBeUndefined();
      expect(serializeInvoked).toBe(false);
    });

    test('1.9: error handling: service rejection bypasses serialize and propagates verbatim', async () => {
      let serializeInvoked = false;
      const service = createMockService([]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, (entity) => {
        serializeInvoked = true;
        return serializeToDto(entity);
      });

      await expect(controller.show(999)).rejects.toThrow('Entity 999 not found');
      expect(serializeInvoked).toBe(false);

      await expect(controller.showDeleted(999)).rejects.toThrow('Deleted entity 999 not found');
      expect(serializeInvoked).toBe(false);
    });

    test('1.10: error handling: thrown exception inside serialize propagates cleanly', async () => {
      const service = createMockService([entity1]);
      const explodingSerializer = () => {
        throw new Error('Serializer exploded');
      };
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, unknown>(
        service,
        explodingSerializer,
      );

      await expect(controller.show(1)).rejects.toThrow('Serializer exploded');
      await expect(controller.list({ page: 1, limit: 10 })).rejects.toThrow('Serializer exploded');
    });
  });

  describe('Dimension 2: Paginated endpoints (list, deleted) preserve total, page, limit', () => {
    test('2.1: list preserves page, limit, total, totalPages exactly', async () => {
      const service = createMockService([entity1, entity2]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.list({ page: 3, limit: 50 });
      expect(result.meta).toEqual({
        page: 3,
        limit: 50,
        total: 2,
        totalPages: 1,
      });
    });

    test('2.2: deleted preserves page, limit, total, totalPages exactly', async () => {
      const service = createMockService([entity1, entity2]);
      await service.delete(1);

      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const result = await controller.deleted({ page: 2, limit: 10 });
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
    });

    test('2.3: empty page returns items: [] and preserves 0 total', async () => {
      const service = createMockService([]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const listResult = await controller.list({ page: 1, limit: 20 });
      expect(listResult.items).toEqual([]);
      expect(listResult.meta.total).toBe(0);
      expect(listResult.meta.page).toBe(1);
      expect(listResult.meta.limit).toBe(20);

      const deletedResult = await controller.deleted({ page: 1, limit: 20 });
      expect(deletedResult.items).toEqual([]);
      expect(deletedResult.meta.total).toBe(0);
    });

    test('2.4: stress test: large page (5,000 items) transforms all items without loss or mutation', async () => {
      const largeItems: TestEntity[] = Array.from({ length: 5000 }, (_, idx) => ({
        id: idx + 1,
        name: `Item ${idx + 1}`,
        secret: `secret_${idx + 1}`,
      }));

      const service = createMockService(largeItems);
      let transformCount = 0;
      const countingSerializer = (e: TestEntity): TestDto => {
        transformCount++;
        return serializeToDto(e);
      };

      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(
        service,
        countingSerializer,
      );

      const result = await controller.list({ page: 1, limit: 5000 });
      expect(result.items).toHaveLength(5000);
      expect(transformCount).toBe(5000);
      expect(result.meta.total).toBe(5000);
      expect(result.meta.totalPages).toBe(1);
      expect(result.items[0]).toEqual({ id: 'dto_1', publicName: 'ITEM 1', hasMetadata: false });
      expect(result.items[4999]).toEqual({
        id: 'dto_5000',
        publicName: 'ITEM 5000',
        hasMetadata: false,
      });
    });

    test('2.5: immutability: mapPage does not mutate original page items array', async () => {
      const service = createMockService([entity1]);
      const controller = new ResourceController<TestEntity, TestCreate, TestUpdate, TestDto>(service, serializeToDto);

      const rawPage = await service.list({ page: 1, limit: 10 });
      const originalItemsCopy = [...rawPage.items];

      await controller.list({ page: 1, limit: 10 });
      expect(rawPage.items).toEqual(originalItemsCopy);
      expect(rawPage.items[0]?.secret).toBe('sensitive_token_123');
    });
  });

  describe('Dimension 3: Default Serialization & Constructor Behaviors', () => {
    test('3.1: single-argument constructor defaults serialize to identity (reference equality)', async () => {
      const service = createMockService([entity1, entity2]);
      // Called with ONLY service (0 serialize arguments provided)
      const controller = new ResourceController(service);

      const shown = await controller.show(1);
      expect(shown).toBe(entity1); // strict reference equality
      expect(shown.id).toBe(1);
      expect(shown.name).toBe('Item One');
      expect(shown.secret).toBe('sensitive_token_123');
      expect(shown.metadata).toEqual({ tags: ['alpha', 'beta'], nested: { active: true } });
      expect(shown.createdAt).toBe(entity1.createdAt);

      const listed = await controller.list({ page: 1, limit: 10 });
      expect(listed.items[0]).toBe(entity1);
      expect(listed.items[1]).toBe(entity2);
    });

    test('3.2: default serialize preserves complex entity attributes without alteration', async () => {
      const complexEntity: TestEntity = {
        id: 42,
        name: 'Complex Object',
        secret: 'nested-secret',
        metadata: {
          tags: ['special', 'unicode-🔥', 'symbols_!@#$%^&*()'],
          nested: { active: true },
        },
        createdAt: new Date('2026-10-26T12:34:56.789Z'),
        deletedAt: null,
      };

      const service = createMockService([complexEntity]);
      const controller = new ResourceController(service);

      const shown = await controller.show(42);
      expect(shown).toBe(complexEntity);
      expect(Object.keys(shown).sort()).toEqual(Object.keys(complexEntity).sort());
      expect(shown.metadata?.tags).toEqual(['special', 'unicode-🔥', 'symbols_!@#$%^&*()']);
      expect(shown.createdAt?.toISOString()).toBe('2026-10-26T12:34:56.789Z');
    });

    test('3.3: zero-argument constructor instantiation behavior', () => {
      // Calling constructor with literally ZERO arguments
      const controller = new (ResourceController as unknown as new () => ResourceController<
        TestEntity,
        TestCreate,
        TestUpdate,
        TestEntity
      >)();
      expect(controller).toBeInstanceOf(ResourceController);

      // Verify that default serialize property is initialized to identity
      const defaultSerialize = (controller as unknown as Record<string, (e: unknown) => unknown>).serialize;
      expect(typeof defaultSerialize).toBe('function');

      const testObj = { id: 99, anyField: 'hello', date: new Date() };
      const serialized = defaultSerialize?.(testObj);
      expect(serialized).toBe(testObj); // identity

      // Invoking methods without service throws TypeError as expected because service is undefined
      expect(controller.show(1)).rejects.toThrow(TypeError);
    });

    test('3.4: method naming inspection: ResourceController provides list/store rather than index/create', () => {
      const service = createMockService([entity1]);
      const controller = new ResourceController(service);

      // Canonical methods
      expect(typeof controller.list).toBe('function');
      expect(typeof controller.show).toBe('function');
      expect(typeof controller.store).toBe('function');
      expect(typeof controller.update).toBe('function');
      expect(typeof controller.destroy).toBe('function');
      expect(typeof controller.deleted).toBe('function');
      expect(typeof controller.showDeleted).toBe('function');
      expect(typeof controller.restore).toBe('function');

      // REST aliases index/create are not declared directly on ResourceController
      const record = controller as unknown as Record<string, unknown>;
      expect(record.index).toBeUndefined();
      expect(record.create).toBeUndefined();
    });
  });
});
