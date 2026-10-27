import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@framework/core';
import type { Page, PageRequest, QueryOptions } from '@framework/database';
import { type FrameworkEnv, installErrorHandling } from '@framework/http';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { type CrudRepository, createRouter, DEFAULT_SERVICE_CONTEXT, ResourceService, resourceRoutes } from '../src';

// ============================================================================
// Schemas for Testing
// ============================================================================

// 1. UUID Table with Soft Delete
const uuidUsersTable = pgTable('mock_uuid_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type UuidUser = {
  id: string;
  name: string;
  email: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
};

// 2. Integer Table with Soft Delete
const intProductsTable = pgTable('mock_int_products', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  price: integer('price').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type IntProduct = {
  id: number;
  title: string;
  price: number;
  createdAt?: string | null;
  deletedAt?: string | null;
};

// 3. String / Text PK Table with Soft Delete (crucial for testing "deleted" as a valid ID string)
const textItemsTable = pgTable('mock_text_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type TextItem = {
  id: string;
  name: string;
  deletedAt?: string | null;
};

// 4. Non-Soft-Deletable Table (Hard-delete only)
const nonSoftDeleteTable = pgTable('mock_hard_delete_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
});

type HardDeleteItem = {
  id: number;
  name: string;
};

// ============================================================================
// Instrumented Mock Service & Repositories
// ============================================================================

interface ServiceCallLog {
  list: Array<{ request: PageRequest; filters: unknown }>;
  listDeleted: Array<{ request: PageRequest; filters: unknown }>;
  get: unknown[];
  getDeleted: unknown[];
  create: unknown[];
  update: Array<{ id: unknown; changes: unknown }>;
  delete: unknown[];
  restore: unknown[];
}

function createInstrumentedMockService<
  TEntity extends { id: string | number; deletedAt?: string | null },
  TCreate extends JsonObject = JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(items: TEntity[], supportsSoftDelete = true) {
  const calls: ServiceCallLog = {
    list: [],
    listDeleted: [],
    get: [],
    getDeleted: [],
    create: [],
    update: [],
    delete: [],
    restore: [],
  };

  const store = new Map<string | number, TEntity>();
  for (const item of items) {
    store.set(item.id, { ...item });
  }

  const repo: CrudRepository<TEntity, TCreate, TUpdate> = {
    async findById(id: string | number) {
      const it = store.get(id);
      if (!it || it.deletedAt) return null;
      return it;
    },
    async findDeletedById(id: string | number) {
      if (!supportsSoftDelete) return null;
      const it = store.get(id);
      if (!it?.deletedAt) return null;
      return it;
    },
    async paginate(request: PageRequest, _q?: QueryOptions) {
      const active = [...store.values()].filter((it) => !it.deletedAt);
      const start = (request.page - 1) * request.limit;
      return {
        items: active.slice(start, start + request.limit),
        meta: {
          page: request.page,
          limit: request.limit,
          total: active.length,
          totalPages: Math.ceil(active.length / request.limit) || 1,
        },
      };
    },
    async paginateDeleted(request: PageRequest, _q?: QueryOptions) {
      if (!supportsSoftDelete) {
        return {
          items: [],
          meta: { page: request.page, limit: request.limit, total: 0, totalPages: 1 },
        };
      }
      const del = [...store.values()].filter((it) => Boolean(it.deletedAt));
      const start = (request.page - 1) * request.limit;
      return {
        items: del.slice(start, start + request.limit),
        meta: {
          page: request.page,
          limit: request.limit,
          total: del.length,
          totalPages: Math.ceil(del.length / request.limit) || 1,
        },
      };
    },
    async create(val: TCreate) {
      const entity = { ...val } as unknown as TEntity;
      store.set(entity.id, entity);
      return entity;
    },
    async createMany(vals: readonly TCreate[]) {
      const res: TEntity[] = [];
      for (const v of vals) res.push(await repo.create(v));
      return res;
    },
    async update(id: string | number, changes: TUpdate) {
      const it = store.get(id);
      if (!it || it.deletedAt) return null;
      const updated = { ...it, ...changes };
      store.set(id, updated);
      return updated;
    },
    async delete(id: string | number) {
      const it = store.get(id);
      if (!it || it.deletedAt) return false;
      if (supportsSoftDelete) {
        store.set(id, { ...it, deletedAt: new Date().toISOString() });
      } else {
        store.delete(id);
      }
      return true;
    },
    async restore(id: string | number) {
      if (!supportsSoftDelete) return false;
      const it = store.get(id);
      if (!it?.deletedAt) return false;
      store.set(id, { ...it, deletedAt: null });
      return true;
    },
  };

  class InstrumentedService extends ResourceService<TEntity, TCreate, TUpdate> {
    override async list(request: PageRequest, filters?: unknown): Promise<Page<TEntity>> {
      calls.list.push({ request, filters });
      return super.list(request, filters as QueryOptions);
    }
    override async listDeleted(request: PageRequest, filters?: unknown): Promise<Page<TEntity>> {
      calls.listDeleted.push({ request, filters });
      return super.listDeleted(request, filters as QueryOptions);
    }
    override async get(id: string | number): Promise<TEntity> {
      calls.get.push(id);
      return super.get(id);
    }
    override async getDeleted(id: string | number): Promise<TEntity> {
      calls.getDeleted.push(id);
      return super.getDeleted(id);
    }
    override async create(val: TCreate): Promise<TEntity> {
      calls.create.push(val);
      return super.create(val);
    }
    override async update(id: string | number, changes: TUpdate): Promise<TEntity> {
      calls.update.push({ id, changes });
      return super.update(id, changes);
    }
    override async delete(id: string | number): Promise<void> {
      calls.delete.push(id);
      return super.delete(id);
    }
    override async restore(id: string | number): Promise<TEntity> {
      calls.restore.push(id);
      return super.restore(id);
    }
  }

  const service = new InstrumentedService(repo, DEFAULT_SERVICE_CONTEXT);
  return { service, calls, store };
}

function createTestApp() {
  const app = new Hono<FrameworkEnv>();
  return installErrorHandling(app, { exposeInternalErrors: false });
}

// ============================================================================
// Adversarial Challenger Test Suite
// ============================================================================

describe('Adversarial Test Suite: route priority and matching in resource-routes.ts', () => {
  // --------------------------------------------------------------------------
  // Requirement 1: GET /deleted does NOT trigger GET /:id with id="deleted"
  // --------------------------------------------------------------------------
  describe('1. Route Priority: GET /deleted vs GET /:id', () => {
    test('String PK table: GET /deleted routes to listDeleted and NOT to GET /:id with id="deleted"', async () => {
      // Seed an item whose actual id is "deleted" to verify GET /deleted matches static route, not /:id
      const activeItemWithDeletedId: TextItem = {
        id: 'deleted',
        name: 'Item Named Deleted',
        deletedAt: null,
      };
      const softDeletedItem: TextItem = {
        id: 'del-item-1',
        name: 'Soft Deleted Item 1',
        deletedAt: new Date().toISOString(),
      };

      const { service, calls } = createInstrumentedMockService<TextItem>([activeItemWithDeletedId, softDeletedItem]);

      const app = createTestApp().route('/items', resourceRoutes(textItemsTable, service));

      const res = await app.request('/items/deleted');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: TextItem[]; meta: { total: number } };
      // Verify body is the paginated deleted items list, NOT the single active item with id "deleted"
      expect(body.items).toBeDefined();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.some((i) => i.id === 'del-item-1')).toBe(true);
      expect(body.items.some((i) => i.id === 'deleted')).toBe(false);

      // EMPIRICAL PROOF: service.get was NEVER called, and service.listDeleted WAS called
      expect(calls.get).toHaveLength(0);
      expect(calls.listDeleted).toHaveLength(1);
    });

    test('UUID PK table: GET /deleted does NOT trigger GET /:id (which would fail with 422)', async () => {
      const validUuid = crypto.randomUUID();
      const softDeletedUser: UuidUser = {
        id: validUuid,
        name: 'Deleted Alice',
        email: 'alice@example.com',
        deletedAt: new Date().toISOString(),
      };

      const { service, calls } = createInstrumentedMockService<UuidUser>([softDeletedUser]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const res = await app.request('/users/deleted');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: UuidUser[]; meta: { total: number } };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(validUuid);

      expect(calls.get).toHaveLength(0);
      expect(calls.listDeleted).toHaveLength(1);
    });

    test('Integer PK table: GET /deleted does NOT trigger GET /:id (which would fail with 422)', async () => {
      const softDeletedProduct: IntProduct = {
        id: 101,
        title: 'Deleted Gadget',
        price: 99,
        deletedAt: new Date().toISOString(),
      };

      const { service, calls } = createInstrumentedMockService<IntProduct>([softDeletedProduct]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/deleted');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: IntProduct[]; meta: { total: number } };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(101);

      expect(calls.get).toHaveLength(0);
      expect(calls.listDeleted).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 2: GET /deleted/123 routes to showDeleted(123) and not a catch-all
  // --------------------------------------------------------------------------
  describe('2. Route Priority: GET /deleted/:id routes to showDeleted(:id)', () => {
    test('Integer PK table: GET /deleted/123 routes to showDeleted(123) with number coercion', async () => {
      const deletedProduct: IntProduct = {
        id: 123,
        title: 'Deleted Product 123',
        price: 20,
        deletedAt: new Date().toISOString(),
      };

      const { service, calls } = createInstrumentedMockService<IntProduct>([deletedProduct]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/deleted/123');
      expect(res.status).toBe(200);

      const body = (await res.json()) as IntProduct;
      expect(body.id).toBe(123);
      expect(body.title).toBe('Deleted Product 123');

      // EMPIRICAL PROOF: getDeleted was called with number 123, NOT string "123", NOT catch-all
      expect(calls.getDeleted).toHaveLength(1);
      expect(calls.getDeleted[0]).toBe(123);
      expect(typeof calls.getDeleted[0]).toBe('number');

      // get(active) and listDeleted were NOT called
      expect(calls.get).toHaveLength(0);
      expect(calls.listDeleted).toHaveLength(0);
    });

    test('GET /deleted/123 returns 404 when deleted record does not exist', async () => {
      const { service, calls } = createInstrumentedMockService<IntProduct>([]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/deleted/999');
      expect(res.status).toBe(404);
      expect(calls.getDeleted).toHaveLength(1);
      expect(calls.getDeleted[0]).toBe(999);
    });

    test('UUID PK table: GET /deleted/:id routes to showDeleted(:id) with valid UUID', async () => {
      const targetUuid = crypto.randomUUID();
      const deletedUser: UuidUser = {
        id: targetUuid,
        name: 'Deleted User',
        email: 'deleted@example.com',
        deletedAt: new Date().toISOString(),
      };

      const { service, calls } = createInstrumentedMockService<UuidUser>([deletedUser]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const res = await app.request(`/users/deleted/${targetUuid}`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as UuidUser;
      expect(body.id).toBe(targetUuid);
      expect(calls.getDeleted).toHaveLength(1);
      expect(calls.getDeleted[0]).toBe(targetUuid);
      expect(calls.get).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 3: Non-soft-deletable table returns status 400
  // --------------------------------------------------------------------------
  describe('3. Non-soft-deletable table returns status 400 on soft-delete endpoints', () => {
    test('GET /deleted returns 400 Bad Request on hard-delete table', async () => {
      const { service } = createInstrumentedMockService<HardDeleteItem>([], false);
      const app = createTestApp().route('/items', resourceRoutes(nonSoftDeleteTable, service));

      const res = await app.request('/items/deleted');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { message: string } };
      expect(body.error?.message).toMatch(/soft delete is not supported/i);
    });

    test('GET /deleted/:id returns 400 Bad Request on hard-delete table', async () => {
      const { service } = createInstrumentedMockService<HardDeleteItem>([], false);
      const app = createTestApp().route('/items', resourceRoutes(nonSoftDeleteTable, service));

      const res = await app.request('/items/deleted/123');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { message: string } };
      expect(body.error?.message).toMatch(/soft delete is not supported/i);
    });

    test('POST /:id/restore returns 400 Bad Request on hard-delete table', async () => {
      const { service } = createInstrumentedMockService<HardDeleteItem>([], false);
      const app = createTestApp().route('/items', resourceRoutes(nonSoftDeleteTable, service));

      const res = await app.request('/items/123/restore', { method: 'POST' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { message: string } };
      expect(body.error?.message).toMatch(/soft delete is not supported/i);
    });

    test('PATCH /:id/restore returns 400 Bad Request on hard-delete table', async () => {
      const { service } = createInstrumentedMockService<HardDeleteItem>([], false);
      const app = createTestApp().route('/items', resourceRoutes(nonSoftDeleteTable, service));

      const res = await app.request('/items/123/restore', { method: 'PATCH' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { message: string } };
      expect(body.error?.message).toMatch(/soft delete is not supported/i);
    });

    test('Service lacking soft-delete methods returns 400 even if table schema has deletedAt', async () => {
      // Minimal service that omits listDeleted, getDeleted, restore
      const rawService = {
        get: async () => null,
        list: async () => ({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 1 } }),
        create: async () => ({}),
        update: async () => null,
        delete: async () => {},
      };

      const app = createTestApp().route(
        '/users',
        resourceRoutes(
          uuidUsersTable,
          rawService as unknown as ResourceService<UuidUser, JsonObject, Partial<JsonObject>>,
        ),
      );

      expect((await app.request('/users/deleted')).status).toBe(400);
      expect((await app.request(`/users/deleted/${crypto.randomUUID()}`)).status).toBe(400);
      expect((await app.request(`/users/${crypto.randomUUID()}/restore`, { method: 'POST' })).status).toBe(400);
      expect((await app.request(`/users/${crypto.randomUUID()}/restore`, { method: 'PATCH' })).status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4: Integer primary key coercion (coerces to 42, non-numeric -> 422)
  // --------------------------------------------------------------------------
  describe('4. Integer Primary Key Coercion & Validation', () => {
    test('GET /42 coerces string "42" to numeric 42', async () => {
      const product: IntProduct = {
        id: 42,
        title: 'The Answer',
        price: 42,
        deletedAt: null,
      };
      const { service, calls } = createInstrumentedMockService<IntProduct>([product]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/42');
      expect(res.status).toBe(200);

      const body = (await res.json()) as IntProduct;
      expect(body.id).toBe(42);

      // Verify coerced type in service call
      expect(calls.get).toHaveLength(1);
      expect(calls.get[0]).toBe(42);
      expect(typeof calls.get[0]).toBe('number');
    });

    test('coerces zero "0" to numeric 0', async () => {
      const product: IntProduct = {
        id: 0,
        title: 'Zero Product',
        price: 0,
        deletedAt: null,
      };
      const { service, calls } = createInstrumentedMockService<IntProduct>([product]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/0');
      expect(res.status).toBe(200);
      expect(calls.get[0]).toBe(0);
      expect(typeof calls.get[0]).toBe('number');
    });

    test('coerces integer in restore endpoints', async () => {
      const product: IntProduct = {
        id: 42,
        title: 'Deleted Product',
        price: 42,
        deletedAt: new Date().toISOString(),
      };
      const { service, calls } = createInstrumentedMockService<IntProduct>([product]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const res = await app.request('/products/42/restore', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(calls.restore[0]).toBe(42);
      expect(typeof calls.restore[0]).toBe('number');
    });

    test('non-numeric strings return 422 Unprocessable Entity', async () => {
      const { service, calls } = createInstrumentedMockService<IntProduct>([]);
      const app = createTestApp().route('/products', resourceRoutes(intProductsTable, service));

      const invalidIds = ['not-a-number', '42abc', 'abc42', 'NaN', 'undefined', 'null', '3.14159', 'true'];

      for (const invalidId of invalidIds) {
        // Test GET /:id
        const getRes = await app.request(`/products/${invalidId}`);
        expect(getRes.status).toBe(422);

        // Test GET /deleted/:id
        const getDelRes = await app.request(`/products/deleted/${invalidId}`);
        expect(getDelRes.status).toBe(422);

        // Test POST /:id/restore
        const postRestoreRes = await app.request(`/products/${invalidId}/restore`, { method: 'POST' });
        expect(postRestoreRes.status).toBe(422);

        // Test DELETE /:id
        const deleteRes = await app.request(`/products/${invalidId}`, { method: 'DELETE' });
        expect(deleteRes.status).toBe(422);

        // Test PATCH /:id
        const patchRes = await app.request(`/products/${invalidId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'New' }),
        });
        expect(patchRes.status).toBe(422);
      }

      // Ensure service methods were never called with invalid IDs
      expect(calls.get).toHaveLength(0);
      expect(calls.getDeleted).toHaveLength(0);
      expect(calls.restore).toHaveLength(0);
      expect(calls.delete).toHaveLength(0);
      expect(calls.update).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 5: UUID primary key (valid UUID returns 200, invalid returns 422)
  // --------------------------------------------------------------------------
  describe('5. UUID Primary Key Validation', () => {
    test('valid UUID returns 200 for existing entity', async () => {
      const validId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const user: UuidUser = {
        id: validId,
        name: 'Valid User',
        email: 'valid@example.com',
        deletedAt: null,
      };

      const { service, calls } = createInstrumentedMockService<UuidUser>([user]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const res = await app.request(`/users/${validId}`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as UuidUser;
      expect(body.id).toBe(validId);
      expect(calls.get).toHaveLength(1);
      expect(calls.get[0]).toBe(validId);
    });

    test('valid UUID returns 404 when entity not found', async () => {
      const missingUuid = '00000000-0000-0000-0000-000000000000';
      const { service, calls } = createInstrumentedMockService<UuidUser>([]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const res = await app.request(`/users/${missingUuid}`);
      expect(res.status).toBe(404);
      expect(calls.get).toHaveLength(1);
      expect(calls.get[0]).toBe(missingUuid);
    });

    test('invalid UUID formats return 422 Unprocessable Entity', async () => {
      const { service, calls } = createInstrumentedMockService<UuidUser>([]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const invalidUuids = [
        'invalid-uuid',
        '12345',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1', // 35 chars (one short)
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a111', // 37 chars (one long)
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1z', // non-hex character 'z'
        'not_a_uuid',
        '%20',
      ];

      for (const badUuid of invalidUuids) {
        // Test GET /:id
        const getRes = await app.request(`/users/${badUuid}`);
        expect(getRes.status).toBe(422);

        // Test GET /deleted/:id
        const getDelRes = await app.request(`/users/deleted/${badUuid}`);
        expect(getDelRes.status).toBe(422);

        // Test POST /:id/restore
        const postRestoreRes = await app.request(`/users/${badUuid}/restore`, { method: 'POST' });
        expect(postRestoreRes.status).toBe(422);

        // Test DELETE /:id
        const delRes = await app.request(`/users/${badUuid}`, { method: 'DELETE' });
        expect(delRes.status).toBe(422);

        // Test PATCH /:id
        const patchRes = await app.request(`/users/${badUuid}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Valid Name' }),
        });
        expect(patchRes.status).toBe(422);
      }

      // Verify no service calls were dispatched with invalid UUIDs
      expect(calls.get).toHaveLength(0);
      expect(calls.getDeleted).toHaveLength(0);
      expect(calls.restore).toHaveLength(0);
      expect(calls.delete).toHaveLength(0);
      expect(calls.update).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Additional Adversarial Edge Cases
  // --------------------------------------------------------------------------
  describe('Adversarial Boundary & Edge Cases', () => {
    test('Prefix nesting: router.resource under sub-path maintains route priority', async () => {
      const deletedUser: UuidUser = {
        id: crypto.randomUUID(),
        name: 'Nested Deleted',
        email: 'nested@example.com',
        deletedAt: new Date().toISOString(),
      };
      const { service, calls } = createInstrumentedMockService<UuidUser>([deletedUser]);

      const subRouter = createRouter();
      subRouter.resource('/users', uuidUsersTable, service);

      const mainApp = createTestApp().route('/api/v1', subRouter);

      // GET /api/v1/users/deleted must hit listDeleted
      const res = await mainApp.request('/api/v1/users/deleted');
      expect(res.status).toBe(200);
      expect(calls.listDeleted).toHaveLength(1);
      expect(calls.get).toHaveLength(0);

      // GET /api/v1/users/deleted/:id must hit getDeleted
      const showDelRes = await mainApp.request(`/api/v1/users/deleted/${deletedUser.id}`);
      expect(showDelRes.status).toBe(200);
      expect(calls.getDeleted).toHaveLength(1);
      expect(calls.get).toHaveLength(0);
    });

    test('Query parameter validation on GET /deleted enforces pagination schema and rejects unexpected query params', async () => {
      const { service } = createInstrumentedMockService<UuidUser>([]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      // Negative page rejected with 422
      const negRes = await app.request('/users/deleted?page=-1');
      expect(negRes.status).toBe(422);

      // Extra unknown query parameters rejected with 422 (.strict())
      const injectedRes = await app.request('/users/deleted?page=1&limit=10&admin_override=true');
      expect(injectedRes.status).toBe(422);
    });

    test('PATCH /:id rejects empty bodies with 422', async () => {
      const user: UuidUser = {
        id: crypto.randomUUID(),
        name: 'Active User',
        email: 'user@example.com',
        deletedAt: null,
      };
      const { service } = createInstrumentedMockService<UuidUser>([user]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      const res = await app.request(`/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(422);
    });

    test('POST / and PATCH /:id reject auto-managed system columns (id, createdAt, deletedAt) with 422', async () => {
      const user: UuidUser = {
        id: crypto.randomUUID(),
        name: 'Existing User',
        email: 'exist@example.com',
        deletedAt: null,
      };
      const { service } = createInstrumentedMockService<UuidUser>([user]);
      const app = createTestApp().route('/users', resourceRoutes(uuidUsersTable, service));

      // Attempt to inject id or deletedAt during POST
      const postRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          name: 'Hacker',
          email: 'hacker@example.com',
          deletedAt: '2026-01-01T00:00:00Z',
        }),
      });
      expect(postRes.status).toBe(422);

      // Attempt to modify deletedAt during PATCH
      const patchRes = await app.request(`/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deletedAt: null,
        }),
      });
      expect(patchRes.status).toBe(422);
    });
  });
});
