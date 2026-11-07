import { describe, expect, test } from 'bun:test';
import { Application, defineProvider, token } from '@framework/core';
import { createHttpKernel, type FrameworkEnv, installErrorHandling } from '@framework/http';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import {
  type CrudRepository,
  createRouter,
  DEFAULT_SERVICE_CONTEXT,
  type PageRequest,
  type QueryOptions,
  ResourceRouter,
  ResourceService,
  resourceRoutes,
  resourceServiceToken,
} from '../src';

// --- Test Tables ---

const usersTable = pgTable('mock_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type MockUser = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly deletedAt?: string | null;
};

type MockUserCreate = {
  readonly name: string;
  readonly email: string;
};

type MockUserUpdate = Partial<MockUserCreate>;

const itemsTable = pgTable('mock_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  price: integer('price').notNull().default(0),
});

type MockItem = {
  readonly id: number;
  readonly title: string;
  readonly price: number;
};

type MockItemCreate = {
  readonly title: string;
  readonly price?: number;
};

type MockItemUpdate = Partial<MockItemCreate>;

// --- Mock Repositories ---

class InMemoryUserRepository implements CrudRepository<MockUser, MockUserCreate, MockUserUpdate> {
  records = new Map<string, MockUser>();

  async findById(id: string): Promise<MockUser | null> {
    const item = this.records.get(id);
    if (!item || item.deletedAt) return null;
    return item;
  }

  async findDeletedById(id: string): Promise<MockUser | null> {
    const item = this.records.get(id);
    if (!item?.deletedAt) return null;
    return item;
  }

  async paginate(request: PageRequest, _query?: QueryOptions) {
    const active = [...this.records.values()].filter((item) => !item.deletedAt);
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
  }

  async paginateDeleted(request: PageRequest, _query?: QueryOptions) {
    const deleted = [...this.records.values()].filter((item) => !!item.deletedAt);
    const start = (request.page - 1) * request.limit;
    return {
      items: deleted.slice(start, start + request.limit),
      meta: {
        page: request.page,
        limit: request.limit,
        total: deleted.length,
        totalPages: Math.ceil(deleted.length / request.limit) || 1,
      },
    };
  }

  async create(values: MockUserCreate): Promise<MockUser> {
    const id = crypto.randomUUID();
    const entity: MockUser = {
      id,
      name: values.name,
      email: values.email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly MockUserCreate[]): Promise<MockUser[]> {
    const res: MockUser[] = [];
    for (const v of values) res.push(await this.create(v));
    return res;
  }

  async update(id: string, changes: MockUserUpdate): Promise<MockUser | null> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt) return null;
    const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt) return false;
    this.records.set(id, { ...existing, deletedAt: new Date().toISOString() });
    return true;
  }

  async restore(id: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing?.deletedAt) return false;
    this.records.set(id, { ...existing, deletedAt: null });
    return true;
  }
}

class InMemoryItemRepository implements CrudRepository<MockItem, MockItemCreate, MockItemUpdate> {
  records = new Map<number, MockItem>();
  nextId = 1;

  async findById(id: number): Promise<MockItem | null> {
    return this.records.get(id) ?? null;
  }

  async paginate(request: PageRequest, _query?: QueryOptions) {
    const items = [...this.records.values()];
    const start = (request.page - 1) * request.limit;
    return {
      items: items.slice(start, start + request.limit),
      meta: {
        page: request.page,
        limit: request.limit,
        total: items.length,
        totalPages: Math.ceil(items.length / request.limit) || 1,
      },
    };
  }

  async create(values: MockItemCreate): Promise<MockItem> {
    const id = this.nextId++;
    const entity: MockItem = {
      id,
      title: values.title,
      price: values.price ?? 0,
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly MockItemCreate[]): Promise<MockItem[]> {
    const res: MockItem[] = [];
    for (const v of values) res.push(await this.create(v));
    return res;
  }

  async update(id: number, changes: MockItemUpdate): Promise<MockItem | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: number): Promise<boolean> {
    return this.records.delete(id);
  }
}

// --- Custom Service with Hooks ---

class HookedUserService extends ResourceService<MockUser, MockUserCreate, MockUserUpdate> {
  beforeCreateInvoked = false;

  protected override beforeCreate(input: MockUserCreate): MockUserCreate {
    this.beforeCreateInvoked = true;
    return { ...input, name: input.name.trim() };
  }
}

function createTestApp() {
  const app = new Hono<FrameworkEnv>();
  return installErrorHandling(app, { exposeInternalErrors: false });
}

describe('Feature F7, F8, F9: resourceRoutes & router.resource', () => {
  describe('Endpoint Registration & Lifecycle Operations', () => {
    test('POST / creates a resource returning 201 Created', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as MockUser;
      expect(data.id).toBeDefined();
      expect(data.name).toBe('Alice');
      expect(data.email).toBe('alice@example.com');
    });

    test('GET / returns 200 with paginated items', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      await repo.create({ name: 'User 1', email: 'u1@example.com' });
      await repo.create({ name: 'User 2', email: 'u2@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: MockUser[]; meta: { total: number; page: number } };
      expect(body.items).toHaveLength(2);
      expect(body.meta.total).toBe(2);
      expect(body.meta.page).toBe(1);
    });

    test('GET /:id returns 200 with matching entity or 404 if not found', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Bob', email: 'bob@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const foundRes = await app.request(`/users/${created.id}`);
      expect(foundRes.status).toBe(200);
      const user = (await foundRes.json()) as MockUser;
      expect(user.id).toBe(created.id);
      expect(user.name).toBe('Bob');

      const notFoundRes = await app.request('/users/00000000-0000-0000-0000-000000000000');
      expect(notFoundRes.status).toBe(404);
    });

    test('PATCH /:id updates resource and returns 200 or 404 if not found', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Carol', email: 'carol@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const updateRes = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Caroline' }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as MockUser;
      expect(updated.name).toBe('Caroline');
      expect(updated.email).toBe('carol@example.com');

      const missingRes = await app.request('/users/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody' }),
      });
      expect(missingRes.status).toBe(404);
    });

    test('DELETE /:id deletes resource and returns 204 No Content', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Dan', email: 'dan@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const delRes = await app.request(`/users/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);
      expect(await delRes.text()).toBe('');

      // Subsequent GET returns 404
      const getRes = await app.request(`/users/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    test('Soft-Delete Lifecycle: /deleted, /deleted/:id, and :id/restore (POST & PATCH)', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Eve', email: 'eve@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      // 1. Soft-delete via DELETE /:id
      await app.request(`/users/${created.id}`, { method: 'DELETE' });

      // 2. GET /deleted contains the item
      const delListRes = await app.request('/users/deleted');
      expect(delListRes.status).toBe(200);
      const delList = (await delListRes.json()) as { items: MockUser[] };
      expect(delList.items.some((u) => u.id === created.id)).toBe(true);

      // 3. GET /deleted/:id returns single deleted item
      const delShowRes = await app.request(`/users/deleted/${created.id}`);
      expect(delShowRes.status).toBe(200);
      expect(((await delShowRes.json()) as MockUser).id).toBe(created.id);

      // 4. POST /:id/restore restores item
      const restoreRes = await app.request(`/users/${created.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      expect(((await restoreRes.json()) as MockUser).id).toBe(created.id);

      // 5. Active again
      expect((await app.request(`/users/${created.id}`)).status).toBe(200);

      // 6. Delete again and restore via PATCH /:id/restore
      await app.request(`/users/${created.id}`, { method: 'DELETE' });
      const patchRestoreRes = await app.request(`/users/${created.id}/restore`, { method: 'PATCH' });
      expect(patchRestoreRes.status).toBe(200);
      expect(((await patchRestoreRes.json()) as MockUser).id).toBe(created.id);
    });

    test('Non-soft-deletable table returns 400 Bad Request on soft-delete endpoints', async () => {
      const repo = new InMemoryItemRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/items', resourceRoutes(itemsTable, svc));

      expect((await app.request('/items/deleted')).status).toBe(400);
      expect((await app.request('/items/deleted/1')).status).toBe(400);
      expect((await app.request('/items/1/restore', { method: 'POST' })).status).toBe(400);
      expect((await app.request('/items/1/restore', { method: 'PATCH' })).status).toBe(400);
    });
  });

  describe('Route Priority', () => {
    test('static /deleted is registered BEFORE /:id so RegExpRouter does not capture "deleted" as :id', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users/deleted');
      expect(res.status).toBe(200);
      const data = (await res.json()) as { items: MockUser[] };
      expect(Array.isArray(data.items)).toBe(true);
    });
  });

  describe('Validation & Parameter Coercion', () => {
    test('coerces string integer PK to number for integer-ID tables', async () => {
      const repo = new InMemoryItemRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ title: 'Gadget', price: 50 });
      const app = createTestApp().route('/items', resourceRoutes(itemsTable, svc));

      const res = await app.request(`/items/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MockItem;
      expect(body.id).toBe(1);
    });

    test('rejects non-numeric ID for integer-ID tables with 422', async () => {
      const repo = new InMemoryItemRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/items', resourceRoutes(itemsTable, svc));

      const res = await app.request('/items/not-a-number');
      expect(res.status).toBe(422);
    });

    test('rejects non-UUID string for UUID-ID tables with 422', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users/invalid-uuid');
      expect(res.status).toBe(422);
    });

    test('rejects empty payload on POST / with 422', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(422);
    });

    test('rejects empty payload on PATCH /:id with 422 (requires >= 1 writable field)', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Frank', email: 'frank@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(422);
    });

    test('rejects system columns on POST / and PATCH /:id due to .strict() schema', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Grace', email: 'grace@example.com' });
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const postRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), name: 'Hacked', email: 'hacked@example.com' }),
      });
      expect(postRes.status).toBe(422);

      const patchRes = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deletedAt: null }),
      });
      expect(patchRes.status).toBe(422);
    });

    test('rejects unexpected query parameters on GET / with 422', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc));

      const res = await app.request('/users?page=1&limit=10&injected=true');
      expect(res.status).toBe(422);
    });
  });

  describe('Custom Schemas & Overrides', () => {
    test('explicit createSchema and updateSchema override auto-generation', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const customCreate = z.object({
        name: z.string().min(5),
        email: z.string().email(),
      });
      const customUpdate = z.object({
        name: z.string().min(10),
      });

      const app = createTestApp().route(
        '/users',
        resourceRoutes(usersTable, svc, {
          createSchema: customCreate,
          updateSchema: customUpdate,
        }),
      );

      // Short name rejected by custom createSchema
      const failCreate = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bob', email: 'bob@example.com' }),
      });
      expect(failCreate.status).toBe(422);

      // Valid name accepted
      const passCreate = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Robert', email: 'bob@example.com' }),
      });
      expect(passCreate.status).toBe(201);
      const created = (await passCreate.json()) as MockUser;

      // Update name < 10 chars rejected
      const failUpdate = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'TooShort' }),
      });
      expect(failUpdate.status).toBe(422);

      // Update name >= 10 chars accepted
      const passUpdate = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'LongEnoughName' }),
      });
      expect(passUpdate.status).toBe(200);
    });
  });

  describe('Custom DTO Response Transforms', () => {
    test('transform option projects items across all endpoints', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const transform = (u: MockUser) => ({
        accountIdentifier: u.id,
        upperName: u.name.toUpperCase(),
      });

      const app = createTestApp().route('/users', resourceRoutes(usersTable, svc, { transform }));

      const createRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Henry', email: 'henry@example.com' }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { accountIdentifier: string; upperName: string };
      expect(created.upperName).toBe('HENRY');
      expect(created.accountIdentifier).toBeDefined();

      const listRes = await app.request('/users');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: Array<{ upperName: string }> };
      expect(list.items[0]?.upperName).toBe('HENRY');

      const showRes = await app.request(`/users/${created.accountIdentifier}`);
      expect(showRes.status).toBe(200);
      expect(((await showRes.json()) as { upperName: string }).upperName).toBe('HENRY');
    });

    test('supports serialize and toResponse as transform aliases', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ name: 'Iris', email: 'iris@example.com' });

      const app1 = createTestApp().route(
        '/users',
        resourceRoutes(usersTable, svc, {
          serialize: (u: MockUser) => ({ customKey: u.id }),
        }),
      );
      const res1 = await app1.request(`/users/${created.id}`);
      expect(((await res1.json()) as { customKey: string }).customKey).toBe(created.id);

      const app2 = createTestApp().route(
        '/users',
        resourceRoutes(usersTable, svc, {
          toResponse: (u: MockUser) => ({ aliasKey: u.email }),
        }),
      );
      const res2 = await app2.request(`/users/${created.id}`);
      expect(((await res2.json()) as { aliasKey: string }).aliasKey).toBe('iris@example.com');
    });
  });

  describe('3-Tier DI Resolution', () => {
    test('Tier 1: Explicit service instance passed as 2nd argument or options.service', async () => {
      const repo = new InMemoryUserRepository();
      const hookedSvc = new HookedUserService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp().route('/users', resourceRoutes(usersTable, hookedSvc));

      await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Untrimmed  ', email: 'untrimmed@example.com' }),
      });
      expect(hookedSvc.beforeCreateInvoked).toBe(true);

      const hookedSvc2 = new HookedUserService(repo, DEFAULT_SERVICE_CONTEXT);
      const app2 = createTestApp().route('/users', resourceRoutes(usersTable, { service: hookedSvc2 }));
      await app2.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Options Untrimmed  ', email: 'opt@example.com' }),
      });
      expect(hookedSvc2.beforeCreateInvoked).toBe(true);
    });

    test('Tier 2: DI Token passed as argument or options.serviceToken', async () => {
      const repo = new InMemoryUserRepository();
      const customSvc = new HookedUserService(repo, DEFAULT_SERVICE_CONTEXT);
      const USER_SVC = token<HookedUserService>('test.user.service');

      const provider = defineProvider<object>({
        name: 'test-token-provider',
        register({ container }) {
          container.scoped(USER_SVC, () => customSvc);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });
      kernel.route('/users', resourceRoutes(usersTable, USER_SVC));

      await kernel.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Token Trim  ', email: 'tok@example.com' }),
      });
      expect(customSvc.beforeCreateInvoked).toBe(true);

      await application.shutdown();
    });

    test('Tier 2: Convention token <tableName>.service resolved from request scope', async () => {
      const repo = new InMemoryUserRepository();
      const conventionSvc = new HookedUserService(repo, DEFAULT_SERVICE_CONTEXT);
      const convToken = resourceServiceToken(usersTable);

      const provider = defineProvider<object>({
        name: 'convention-token-provider',
        register({ container }) {
          container.scoped(convToken, () => conventionSvc);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });
      kernel.route('/users', resourceRoutes(usersTable));

      await kernel.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Convention Trim  ', email: 'conv@example.com' }),
      });
      expect(conventionSvc.beforeCreateInvoked).toBe(true);

      await application.shutdown();
    });
  });

  describe('ResourceRouter, createRouter & Hono.prototype.resource Fluent Chaining', () => {
    test('createRouter() creates ResourceRouter instance with .resource()', async () => {
      const repo = new InMemoryUserRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);

      const router = createRouter();
      expect(router instanceof ResourceRouter).toBe(true);
      expect(router instanceof Hono).toBe(true);

      router.resource('/users', usersTable, svc);

      const app = createTestApp().route('', router);
      const res = await app.request('/users');
      expect(res.status).toBe(200);
    });

    test('Hono.prototype.resource allows fluent chaining on new Hono()', async () => {
      const userRepo = new InMemoryUserRepository();
      const itemRepo = new InMemoryItemRepository();
      const userSvc = new ResourceService(userRepo, DEFAULT_SERVICE_CONTEXT);
      const itemSvc = new ResourceService(itemRepo, DEFAULT_SERVICE_CONTEXT);

      const app = createTestApp().resource('/users', usersTable, userSvc).resource('/items', itemsTable, itemSvc);

      expect((await app.request('/users')).status).toBe(200);
      expect((await app.request('/items')).status).toBe(200);
    });
  });
});
