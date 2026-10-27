import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Application, defineProvider, EXECUTION_CONTEXT, token } from '@framework/core';
import {
  type CrudTable,
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  type DatabaseConnection,
  TRANSACTION_CONTEXT,
  TransactionContext,
} from '@framework/database';
import { EVENT_BUS, MemoryEventBus } from '@framework/events';
import { createHttpKernel, type FrameworkEnv } from '@framework/http';
import { createTestDatabase, type TestDatabase } from '@framework/testing';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import * as crud from '../src';
import type { CrudRepository } from '../src/contracts';
import { DEFAULT_SERVICE_CONTEXT, ResourceService } from '../src/service';

// --- Types & Interfaces ---

interface ResourceRouterApi {
  resourceRoutes?: (table: CrudTable, serviceOrOptions?: unknown, schemasOrOptions?: unknown) => Hono<FrameworkEnv>;
  createRouter?: () => Hono<FrameworkEnv> & {
    resource: (path: string, table: CrudTable, service?: unknown, options?: unknown) => unknown;
  };
}

interface ResourceCapableHono extends Hono<FrameworkEnv> {
  resource: (path: string, table: CrudTable, service?: unknown, options?: unknown) => this;
}

const crudApi = crud as unknown as ResourceRouterApi;

function getResourceRoutes() {
  const routes = crudApi.resourceRoutes;
  if (!routes) {
    throw new Error('resourceRoutes is not yet implemented');
  }
  return routes;
}

// --- Test Tables ---

const e2eUsers = pgTable('e2e_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type E2eUser = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly deletedAt?: string | null;
};

type UserCreate = {
  readonly name: string;
  readonly email: string;
  readonly role?: string;
};

type UserUpdate = Partial<UserCreate>;

const e2eProducts = pgTable('e2e_products', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  price: integer('price').notNull().default(0),
  sku: text('sku').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

type E2eProduct = {
  readonly id: number;
  readonly title: string;
  readonly price: number;
  readonly sku: string;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
};

type ProductCreate = {
  readonly title: string;
  readonly price?: number;
  readonly sku: string;
};

type ProductUpdate = Partial<ProductCreate>;

// --- In-Memory Mock Repositories ---

class MockUserRepository implements CrudRepository<E2eUser, UserCreate, UserUpdate> {
  records = new Map<string, E2eUser>();

  async findById(id: string): Promise<E2eUser | null> {
    const item = this.records.get(id);
    if (!item || item.deletedAt) return null;
    return item;
  }

  async findDeletedById(id: string): Promise<E2eUser | null> {
    const item = this.records.get(id);
    if (!item?.deletedAt) return null;
    return item;
  }

  async paginate(request: { page: number; limit: number }) {
    const active = [...this.records.values()].filter((item) => !item.deletedAt);
    const start = (request.page - 1) * request.limit;
    return {
      items: active.slice(start, start + request.limit),
      meta: { page: request.page, limit: request.limit, total: active.length },
    };
  }

  async paginateDeleted(request: { page: number; limit: number }) {
    const deleted = [...this.records.values()].filter((item) => !!item.deletedAt);
    const start = (request.page - 1) * request.limit;
    return {
      items: deleted.slice(start, start + request.limit),
      meta: { page: request.page, limit: request.limit, total: deleted.length },
    };
  }

  async create(values: UserCreate): Promise<E2eUser> {
    const id = crypto.randomUUID();
    const entity: E2eUser = {
      id,
      name: values.name,
      email: values.email,
      role: values.role ?? 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly UserCreate[]): Promise<E2eUser[]> {
    const results: E2eUser[] = [];
    for (const v of values) {
      results.push(await this.create(v));
    }
    return results;
  }

  async update(id: string, changes: UserUpdate): Promise<E2eUser | null> {
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

class MockProductRepository implements CrudRepository<E2eProduct, ProductCreate, ProductUpdate> {
  records = new Map<number, E2eProduct>();
  nextId = 1;

  async findById(id: number): Promise<E2eProduct | null> {
    return this.records.get(id) ?? null;
  }

  async paginate(request: { page: number; limit: number }) {
    const items = [...this.records.values()];
    const start = (request.page - 1) * request.limit;
    return {
      items: items.slice(start, start + request.limit),
      meta: { page: request.page, limit: request.limit, total: items.length },
    };
  }

  async create(values: ProductCreate): Promise<E2eProduct> {
    const id = this.nextId++;
    const entity: E2eProduct = {
      id,
      title: values.title,
      price: values.price ?? 0,
      sku: values.sku,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly ProductCreate[]): Promise<E2eProduct[]> {
    const results: E2eProduct[] = [];
    for (const v of values) {
      results.push(await this.create(v));
    }
    return results;
  }

  async update(id: number, changes: ProductUpdate): Promise<E2eProduct | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: number): Promise<boolean> {
    return this.records.delete(id);
  }
}

class TestCustomUserService extends ResourceService<E2eUser, UserCreate, UserUpdate> {
  hooksInvoked: string[] = [];

  protected override beforeCreate(input: UserCreate): UserCreate {
    this.hooksInvoked.push('beforeCreate');
    return { ...input, name: input.name.trim() };
  }

  protected override afterCreate(entity: E2eUser): void {
    this.hooksInvoked.push(`afterCreate:${entity.id}`);
  }
}

// --- Setup & Teardown ---

let database: TestDatabase | undefined;
let connection: DatabaseConnection | undefined;
let application: Application<object>;
let bus: MemoryEventBus;

const isImplemented = typeof crudApi.resourceRoutes === 'function';

beforeAll(async () => {
  bus = new MemoryEventBus();
  const adminUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

  try {
    database = await createTestDatabase({ adminUrl });
    connection = createConnection({ url: database.url, maxConnections: 4 });
    await connection.sql`create extension if not exists "pgcrypto"`;
    await connection.sql`create table if not exists e2e_users (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      email text not null,
      role text not null default 'user',
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      deleted_at timestamptz
    )`;
    await connection.sql`create table if not exists e2e_products (
      id integer primary key generated always as identity,
      title text not null,
      price integer not null default 0,
      sku text not null,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    )`;
  } catch (_e) {
    // Falls back gracefully if test database cannot be initialized
  }

  const provider = defineProvider<object>({
    name: 'crud-e2e-test',
    register({ container }) {
      if (connection) {
        container.value(DATABASE, connection);
        container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
        container.scoped(DATA_CONTEXT, (r) => ({
          transactions: r.resolve(TRANSACTION_CONTEXT),
          execution: r.resolve(EXECUTION_CONTEXT),
        }));
      }
      container.value(EVENT_BUS, bus);
    },
  });

  application = await new Application({ config: {}, providers: [provider] }).boot();
});

afterAll(async () => {
  await application?.shutdown().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await database?.drop().catch(() => undefined);
});

function createTestApp() {
  return createHttpKernel(application, { exposeInternalErrors: false });
}

// ============================================================================
// TIER 1: Feature Coverage (>=5 tests per feature for happy path)
// ============================================================================

describe('Tier 1: Feature Coverage', () => {
  describe('F-Core: Core CRUD HTTP Endpoints', () => {
    test.skipIf(!isImplemented)('POST / creates resource with 201 Created and persists entity', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp();
      const routes = getResourceRoutes()(e2eUsers, mockSvc);
      app.route('/users', routes);

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice Smith', email: 'alice@example.com' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as E2eUser;
      expect(body.name).toBe('Alice Smith');
      expect(body.email).toBe('alice@example.com');
      expect(body.id).toBeDefined();
    });

    test.skipIf(!isImplemented)('GET / returns 200 with paginated active items and metadata', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      await mockRepo.create({ name: 'Alice', email: 'alice@example.com' });
      await mockRepo.create({ name: 'Bob', email: 'bob@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request('/users');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: E2eUser[]; meta: { page: number; total: number } };
      expect(body.items).toHaveLength(2);
      expect(body.meta.page).toBe(1);
      expect(body.meta.total).toBe(2);
    });

    test.skipIf(!isImplemented)('GET /:id returns 200 with matching single entity', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Charlie', email: 'charlie@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eUser;
      expect(body.id).toBe(created.id);
      expect(body.name).toBe('Charlie');
    });

    test.skipIf(!isImplemented)('PATCH /:id updates resource fields and returns 200', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Dave', email: 'dave@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'David' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eUser;
      expect(body.name).toBe('David');
      expect(body.email).toBe('dave@example.com');
    });

    test.skipIf(!isImplemented)('DELETE /:id deletes resource and returns 204 No Content', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Eve', email: 'eve@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
    });

    test.skipIf(!isImplemented)('GET /?page=2&limit=1 honors custom pagination parameters', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      await mockRepo.create({ name: 'User 1', email: 'u1@example.com' });
      await mockRepo.create({ name: 'User 2', email: 'u2@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request('/users?page=2&limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: E2eUser[]; meta: { page: number; limit: number } };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.name).toBe('User 2');
      expect(body.meta.page).toBe(2);
      expect(body.meta.limit).toBe(1);
    });
  });

  describe('F-SoftDelete: Soft-Delete Lifecycle (deleted and restore)', () => {
    test.skipIf(!isImplemented)('DELETE /:id soft-deletes and removes from active GET /', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Frank', email: 'frank@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      await app.request(`/users/${created.id}`, { method: 'DELETE' });

      const listRes = await app.request('/users');
      const list = (await listRes.json()) as { items: E2eUser[] };
      expect(list.items.find((u) => u.id === created.id)).toBeUndefined();
    });

    test.skipIf(!isImplemented)('GET /deleted returns 200 with soft-deleted records', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Grace', email: 'grace@example.com' });
      await mockRepo.delete(created.id);

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request('/users/deleted');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: E2eUser[] };
      expect(body.items.some((u) => u.id === created.id)).toBe(true);
    });

    test.skipIf(!isImplemented)('GET /deleted/:id returns 200 with the single soft-deleted record', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Heidi', email: 'heidi@example.com' });
      await mockRepo.delete(created.id);

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/deleted/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eUser;
      expect(body.id).toBe(created.id);
      expect(body.name).toBe('Heidi');
    });

    test.skipIf(!isImplemented)('POST /:id/restore restores record and returns 200', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Ivan', email: 'ivan@example.com' });
      await mockRepo.delete(created.id);

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const restoreRes = await app.request(`/users/${created.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      const restored = (await restoreRes.json()) as E2eUser;
      expect(restored.id).toBe(created.id);

      const activeRes = await app.request(`/users/${created.id}`);
      expect(activeRes.status).toBe(200);
    });

    test.skipIf(!isImplemented)('PATCH /:id/restore alias also restores soft-deleted record', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Judy', email: 'judy@example.com' });
      await mockRepo.delete(created.id);

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}/restore`, { method: 'PATCH' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eUser;
      expect(body.id).toBe(created.id);
    });
  });

  describe('F-Schema: Schema Auto-Generation and Resolution', () => {
    test.skipIf(!isImplemented)(
      'auto-derives createSchema stripping system columns (id, createdAt, updatedAt, deletedAt)',
      async () => {
        const mockRepo = new MockUserRepository();
        const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
        const app = createTestApp();
        app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

        const res = await app.request('/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Auto Schema', email: 'auto@example.com' }),
        });
        expect(res.status).toBe(201);
      },
    );

    test.skipIf(!isImplemented)('auto-derives updateSchema allowing partial fields', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Karl', email: 'karl@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'karl-new@example.com' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eUser;
      expect(body.email).toBe('karl-new@example.com');
    });

    test.skipIf(!isImplemented)('custom createSchema overrides auto-generation', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const customSchema = z.object({
        name: z.string().min(5),
        email: z.string().email(),
      });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { createSchema: customSchema }));

      const failRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bob', email: 'bob@example.com' }),
      });
      expect(failRes.status).toBe(422);

      const passRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Robert', email: 'bob@example.com' }),
      });
      expect(passRes.status).toBe(201);
    });

    test.skipIf(!isImplemented)('custom updateSchema overrides auto-generation', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Leo', email: 'leo@example.com' });
      const customUpdate = z.object({
        role: z.enum(['admin', 'moderator']),
      });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { updateSchema: customUpdate }));

      const failRes = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'superadmin' }),
      });
      expect(failRes.status).toBe(422);

      const passRes = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(passRes.status).toBe(200);
    });

    test.skipIf(!isImplemented)('auto-derives integer PK parameter validation and coercion', async () => {
      const mockRepo = new MockProductRepository();
      const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ title: 'Widget', sku: 'WDG-1' });

      const app = createTestApp();
      app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

      const res = await app.request(`/products/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as E2eProduct;
      expect(body.id).toBe(created.id);
    });
  });

  describe('F-DTO: Custom DTO Response Transforms', () => {
    const transform = (entity: E2eUser) => ({
      userId: entity.id,
      displayName: entity.name.toUpperCase(),
      contactEmail: entity.email,
    });

    test.skipIf(!isImplemented)('transform applies to paginated items on GET /', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      await mockRepo.create({ name: 'Mona', email: 'mona@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

      const res = await app.request('/users');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ userId: string; displayName: string; contactEmail: string; id?: string }>;
      };
      expect(body.items[0]).toEqual({
        userId: expect.any(String),
        displayName: 'MONA',
        contactEmail: 'mona@example.com',
      });
      expect(body.items[0]?.id).toBeUndefined();
    });

    test.skipIf(!isImplemented)('transform applies to single entity on GET /:id', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Nina', email: 'nina@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

      const res = await app.request(`/users/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string; displayName: string };
      expect(body.displayName).toBe('NINA');
      expect(body.userId).toBe(created.id);
    });

    test.skipIf(!isImplemented)('transform applies to created entity on POST /', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Oscar', email: 'oscar@example.com' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { userId: string; displayName: string };
      expect(body.displayName).toBe('OSCAR');
      expect(body.userId).toBeDefined();
    });

    test.skipIf(!isImplemented)('transform applies to updated entity on PATCH /:id', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Paul', email: 'paul@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

      const res = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pauly' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { displayName: string };
      expect(body.displayName).toBe('PAULY');
    });

    test.skipIf(!isImplemented)('transform applies to restored entity on POST /:id/restore', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Quinn', email: 'quinn@example.com' });
      await mockRepo.delete(created.id);

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

      const res = await app.request(`/users/${created.id}/restore`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string; displayName: string };
      expect(body.displayName).toBe('QUINN');
      expect(body.userId).toBe(created.id);
    });

    test.skipIf(!isImplemented)('accepts serialize and toResponse as transform aliases', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Rosa', email: 'rosa@example.com' });

      const app = createTestApp();
      app.route(
        '/users',
        getResourceRoutes()(e2eUsers, mockSvc, {
          serialize: (u: E2eUser) => ({ id: u.id, custom: 'serialized' }),
        }),
      );

      const res = await app.request(`/users/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { custom: string };
      expect(body.custom).toBe('serialized');
    });
  });

  describe('F-DI: Service & Dependency Injection Resolution', () => {
    test.skipIf(!isImplemented)('resolves explicit service instance passed as 2nd or 3rd argument', async () => {
      const mockRepo = new MockUserRepository();
      const customSvc = new TestCustomUserService(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, customSvc));

      await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Trimmed Name  ', email: 'trim@example.com' }),
      });

      expect(customSvc.hooksInvoked).toContain('beforeCreate');
    });

    test.skipIf(!isImplemented)('resolves explicit service passed in options object', async () => {
      const mockRepo = new MockUserRepository();
      const customSvc = new TestCustomUserService(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, { service: customSvc }));

      await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Options Svc  ', email: 'opt@example.com' }),
      });

      expect(customSvc.hooksInvoked).toContain('beforeCreate');
    });

    test.skipIf(!isImplemented)('resolves service by DI Token passed as argument', async () => {
      const mockRepo = new MockUserRepository();
      const customSvc = new TestCustomUserService(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const USER_SVC_TOKEN = token<TestCustomUserService>('e2e_users.service');

      const customProvider = defineProvider<object>({
        name: 'custom-token-provider',
        register({ container }) {
          container.scoped(USER_SVC_TOKEN, () => customSvc);
        },
      });
      const localApp = await new Application({ config: {}, providers: [customProvider] }).boot();
      const http = createHttpKernel(localApp, { exposeInternalErrors: false });

      http.route('/users', getResourceRoutes()(e2eUsers, USER_SVC_TOKEN));

      await http.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Token Resolved', email: 'tok@example.com' }),
      });

      expect(customSvc.hooksInvoked).toContain('beforeCreate');
      await localApp.shutdown();
    });
  });

  describe('F-Router: Router API Integration (resourceRoutes & router.resource)', () => {
    test.skipIf(!isImplemented)('standalone resourceRoutes() creates sub-app mounted at root', async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const routes = getResourceRoutes()(e2eUsers, mockSvc);
      expect(routes).toBeDefined();

      const app = createTestApp();
      app.route('/api/users', routes);

      const res = await app.request('/api/users');
      expect(res.status).toBe(200);
    });

    test.skipIf(!isImplemented)('createRouter() returns a router with .resource() support', async () => {
      if (typeof crudApi.createRouter !== 'function') {
        throw new Error('createRouter not exported');
      }
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const router = crudApi.createRouter();
      router.resource('/users', e2eUsers, mockSvc);

      const app = createTestApp();
      app.route('', router);

      const res = await app.request('/users');
      expect(res.status).toBe(200);
    });

    test.skipIf(!isImplemented)('Hono.prototype.resource augmentation supports fluent registration', async () => {
      const mockUserRepo = new MockUserRepository();
      const mockProdRepo = new MockProductRepository();
      const userSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockUserRepo, DEFAULT_SERVICE_CONTEXT);
      const prodSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(
        mockProdRepo,
        DEFAULT_SERVICE_CONTEXT,
      );

      const hono = new Hono<FrameworkEnv>() as ResourceCapableHono;
      if (typeof hono.resource !== 'function') {
        throw new Error('Hono.prototype.resource is not augmented');
      }
      hono.resource('/users', e2eUsers, userSvc).resource('/products', e2eProducts, prodSvc);

      const app = createTestApp();
      app.route('', hono);

      expect((await app.request('/users')).status).toBe(200);
      expect((await app.request('/products')).status).toBe(200);
    });
  });
});

// ============================================================================
// TIER 2: Boundary & Corner Cases
// ============================================================================

describe('Tier 2: Boundary & Corner Cases', () => {
  test.skipIf(!isImplemented)('POST / with empty body rejects with 422 VALIDATION_FAILED', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)(
    'PATCH /:id with empty body {} rejects with 422 (requires >= 1 writable field)',
    async () => {
      const mockRepo = new MockUserRepository();
      const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const created = await mockRepo.create({ name: 'Sam', email: 'sam@example.com' });

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

      const res = await app.request(`/users/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(422);
    },
  );

  test.skipIf(!isImplemented)('POST / rejecting system columns with 422 (strict schema)', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        name: 'Injected ID',
        email: 'injected@example.com',
      }),
    });
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)('PATCH /:id rejecting system columns with 422', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const created = await mockRepo.create({ name: 'Tom', email: 'tom@example.com' });

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request(`/users/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deletedAt: null }),
    });
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)('GET /:id with unknown ID returns 404 Not Found', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test.skipIf(!isImplemented)('PATCH /:id with unknown ID returns 404 Not Found', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Missing' }),
    });
    expect(res.status).toBe(404);
  });

  test.skipIf(!isImplemented)('DELETE /:id with unknown ID returns 404 Not Found', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  test.skipIf(!isImplemented)('GET /deleted/:id for active (non-deleted) record returns 404', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const created = await mockRepo.create({ name: 'Active User', email: 'act@example.com' });

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request(`/users/deleted/${created.id}`);
    expect(res.status).toBe(404);
  });

  test.skipIf(!isImplemented)('POST /:id/restore for active (non-deleted) record returns 404', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const created = await mockRepo.create({ name: 'Already Active', email: 'aa@example.com' });

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request(`/users/${created.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test.skipIf(!isImplemented)('GET /deleted on non-soft-deletable table returns 400 Bad Request', async () => {
    const mockRepo = new MockProductRepository();
    const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

    const res = await app.request('/products/deleted');
    expect(res.status).toBe(400);
  });

  test.skipIf(!isImplemented)('GET /deleted/:id on non-soft-deletable table returns 400 Bad Request', async () => {
    const mockRepo = new MockProductRepository();
    const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

    const res = await app.request('/products/deleted/1');
    expect(res.status).toBe(400);
  });

  test.skipIf(!isImplemented)('POST /:id/restore on non-soft-deletable table returns 400 Bad Request', async () => {
    const mockRepo = new MockProductRepository();
    const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

    const res = await app.request('/products/1/restore', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test.skipIf(!isImplemented)('GET /products/not-a-number rejects with 422 for integer PK', async () => {
    const mockRepo = new MockProductRepository();
    const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

    const res = await app.request('/products/abc');
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)('GET /users/not-a-uuid rejects with 422 for UUID PK', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users/invalid-uuid-string');
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)('GET /users with unknown query parameter rejects with 422', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users?page=1&limit=10&unexpected_flag=true');
    expect(res.status).toBe(422);
  });

  test.skipIf(!isImplemented)('GET /users with invalid pagination bounds rejects with 422', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    expect((await app.request('/users?page=0')).status).toBe(422);
    expect((await app.request('/users?limit=-1')).status).toBe(422);
    expect((await app.request('/users?limit=9999999')).status).toBe(422);
  });

  test.skipIf(!isImplemented)('route priority: static /deleted is NOT captured by /:id as id="deleted"', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users/deleted');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: E2eUser[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test.skipIf(!isImplemented)('POST / with malformed JSON body returns 400 Bad Request', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc));

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json-string',
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// TIER 3: Cross-Feature Combinations
// ============================================================================

describe('Tier 3: Cross-Feature Combinations', () => {
  test.skipIf(!isImplemented)('soft-delete + custom DTO transform applies across all 7 endpoints', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const transform = (u: E2eUser) => ({
      uid: u.id,
      nameFormatted: `[User] ${u.name}`,
    });

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

    // 1. Create
    const createRes = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Combo', email: 'combo@example.com' }),
    });
    const created = (await createRes.json()) as { uid: string; nameFormatted: string };
    expect(created.nameFormatted).toBe('[User] Combo');

    // 2. Active List
    const listRes = await app.request('/users');
    const list = (await listRes.json()) as { items: Array<{ nameFormatted: string }> };
    expect(list.items[0]?.nameFormatted).toBe('[User] Combo');

    // 3. Active Show
    const showRes = await app.request(`/users/${created.uid}`);
    const show = (await showRes.json()) as { nameFormatted: string };
    expect(show.nameFormatted).toBe('[User] Combo');

    // 4. Update
    const updateRes = await app.request(`/users/${created.uid}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Combo Updated' }),
    });
    const updated = (await updateRes.json()) as { nameFormatted: string };
    expect(updated.nameFormatted).toBe('[User] Combo Updated');

    // 5. Delete (soft)
    await app.request(`/users/${created.uid}`, { method: 'DELETE' });

    // 6. Deleted List & Show
    const delListRes = await app.request('/users/deleted');
    const delList = (await delListRes.json()) as { items: Array<{ nameFormatted: string }> };
    expect(delList.items[0]?.nameFormatted).toBe('[User] Combo Updated');

    const delShowRes = await app.request(`/users/deleted/${created.uid}`);
    const delShow = (await delShowRes.json()) as { nameFormatted: string };
    expect(delShow.nameFormatted).toBe('[User] Combo Updated');

    // 7. Restore
    const restoreRes = await app.request(`/users/${created.uid}/restore`, { method: 'POST' });
    const restored = (await restoreRes.json()) as { nameFormatted: string };
    expect(restored.nameFormatted).toBe('[User] Combo Updated');
  });

  test.skipIf(!isImplemented)('custom service hooks execute alongside auto-generated strict schemas', async () => {
    const mockRepo = new MockUserRepository();
    const customSvc = new TestCustomUserService(mockRepo, DEFAULT_SERVICE_CONTEXT);

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, customSvc));

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Hooked Alice  ', email: 'hook@example.com' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as E2eUser;
    expect(body.name).toBe('Hooked Alice');
    expect(customSvc.hooksInvoked).toContain('beforeCreate');
  });

  test.skipIf(!isImplemented)('integer PK + DTO transform + hard-delete resource', async () => {
    const mockRepo = new MockProductRepository();
    const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const transform = (p: E2eProduct) => ({
      itemNo: p.id,
      label: `${p.sku} - ${p.title}`,
      formattedPrice: `$${(p.price / 100).toFixed(2)}`,
    });

    const app = createTestApp();
    app.route('/products', getResourceRoutes()(e2eProducts, mockSvc, { transform }));

    const createRes = await app.request('/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Keyboard', price: 9999, sku: 'KB-01' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { itemNo: number; label: string; formattedPrice: string };
    expect(created.itemNo).toBe(1);
    expect(created.label).toBe('KB-01 - Keyboard');
    expect(created.formattedPrice).toBe('$99.99');

    const readRes = await app.request('/products/1');
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { itemNo: number };
    expect(read.itemNo).toBe(1);

    const delRes = await app.request('/products/1', { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    expect((await app.request('/products/1')).status).toBe(404);
  });

  test.skipIf(!isImplemented)(
    'multi-resource mounting: multiple resources on single Hono app do not collide',
    async () => {
      const mockUserRepo = new MockUserRepository();
      const mockProdRepo = new MockProductRepository();
      const userSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockUserRepo, DEFAULT_SERVICE_CONTEXT);
      const prodSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(
        mockProdRepo,
        DEFAULT_SERVICE_CONTEXT,
      );

      const app = createTestApp();
      app.route('/users', getResourceRoutes()(e2eUsers, userSvc));
      app.route('/products', getResourceRoutes()(e2eProducts, prodSvc));

      const u = await userSvc.create({ name: 'User In Multi', email: 'm@example.com' });
      const p = await prodSvc.create({ title: 'Prod In Multi', sku: 'PRD-M' });

      expect((await app.request(`/users/${u.id}`)).status).toBe(200);
      expect((await app.request(`/products/${p.id}`)).status).toBe(200);
      expect((await app.request('/users/deleted')).status).toBe(200);
      expect((await app.request('/products/deleted')).status).toBe(400);
    },
  );
});

// ============================================================================
// TIER 4: Real-World Application Scenarios
// ============================================================================

describe('Tier 4: Real-World Application Scenarios', () => {
  test.skipIf(!isImplemented)('Scenario 1: Complete multi-step User Management lifecycle', async () => {
    const mockRepo = new MockUserRepository();
    const mockSvc = new ResourceService<E2eUser, UserCreate, UserUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
    const transform = (u: E2eUser) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
    });

    const app = createTestApp();
    app.route('/users', getResourceRoutes()(e2eUsers, mockSvc, { transform }));

    // Step 1: Create User
    const createRes = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Zack Taylor', email: 'zack@example.com', role: 'member' }),
    });
    expect(createRes.status).toBe(201);
    const user = (await createRes.json()) as E2eUser;
    const userId = user.id;
    expect(userId).toBeDefined();
    expect(user.role).toBe('member');

    // Step 2: List Users (active)
    const list1Res = await app.request('/users');
    expect(list1Res.status).toBe(200);
    const list1 = (await list1Res.json()) as { items: E2eUser[] };
    expect(list1.items.some((u) => u.id === userId)).toBe(true);

    // Step 3: Read User
    const read1Res = await app.request(`/users/${userId}`);
    expect(read1Res.status).toBe(200);
    expect(((await read1Res.json()) as E2eUser).name).toBe('Zack Taylor');

    // Step 4: Update User
    const updateRes = await app.request(`/users/${userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as E2eUser).role).toBe('admin');

    // Step 5: Soft-Delete User
    const deleteRes = await app.request(`/users/${userId}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    // Step 6: Verify User is absent from active list & show returns 404
    const list2Res = await app.request('/users');
    const list2 = (await list2Res.json()) as { items: E2eUser[] };
    expect(list2.items.some((u) => u.id === userId)).toBe(false);
    expect((await app.request(`/users/${userId}`)).status).toBe(404);

    // Step 7: Verify User is in deleted list & showDeleted returns 200
    const delListRes = await app.request('/users/deleted');
    expect(delListRes.status).toBe(200);
    const delList = (await delListRes.json()) as { items: E2eUser[] };
    expect(delList.items.some((u) => u.id === userId)).toBe(true);

    const delShowRes = await app.request(`/users/deleted/${userId}`);
    expect(delShowRes.status).toBe(200);
    expect(((await delShowRes.json()) as E2eUser).id).toBe(userId);

    // Step 8: Restore User
    const restoreRes = await app.request(`/users/${userId}/restore`, { method: 'POST' });
    expect(restoreRes.status).toBe(200);
    expect(((await restoreRes.json()) as E2eUser).id).toBe(userId);

    // Step 9: Verify User is active again and gone from deleted list
    const list3Res = await app.request('/users');
    const list3 = (await list3Res.json()) as { items: E2eUser[] };
    expect(list3.items.some((u) => u.id === userId)).toBe(true);
    expect((await app.request(`/users/${userId}`)).status).toBe(200);

    const delList2Res = await app.request('/users/deleted');
    const delList2 = (await delList2Res.json()) as { items: E2eUser[] };
    expect(delList2.items.some((u) => u.id === userId)).toBe(false);
  });

  test.skipIf(!isImplemented)(
    'Scenario 2: E-Commerce Product Catalog lifecycle (Integer PK, Hard-Delete)',
    async () => {
      const mockRepo = new MockProductRepository();
      const mockSvc = new ResourceService<E2eProduct, ProductCreate, ProductUpdate>(mockRepo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestApp();
      app.route('/products', getResourceRoutes()(e2eProducts, mockSvc));

      // Step 1: Create product
      const createRes = await app.request('/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Gaming Laptop', price: 149999, sku: 'LAP-001' }),
      });
      expect(createRes.status).toBe(201);
      const prod = (await createRes.json()) as E2eProduct;
      const prodId = prod.id;
      expect(typeof prodId).toBe('number');

      // Step 2: Read product by integer ID
      const readRes = await app.request(`/products/${prodId}`);
      expect(readRes.status).toBe(200);
      expect(((await readRes.json()) as E2eProduct).title).toBe('Gaming Laptop');

      // Step 3: Update product price
      const updateRes = await app.request(`/products/${prodId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ price: 139999 }),
      });
      expect(updateRes.status).toBe(200);
      expect(((await updateRes.json()) as E2eProduct).price).toBe(139999);

      // Step 4: Verify soft-delete endpoints fail with 400
      expect((await app.request('/products/deleted')).status).toBe(400);
      expect((await app.request(`/products/deleted/${prodId}`)).status).toBe(400);
      expect((await app.request(`/products/${prodId}/restore`, { method: 'POST' })).status).toBe(400);

      // Step 5: Hard delete product
      const delRes = await app.request(`/products/${prodId}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      // Step 6: Verify permanently gone
      expect((await app.request(`/products/${prodId}`)).status).toBe(404);
    },
  );
});
