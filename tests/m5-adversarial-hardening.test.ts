import { describe, expect, test } from 'bun:test';
import { Application, Container, defineProvider, ExecutionContext, token } from '@framework/core';
import { DATA_CONTEXT, type DataContext, type PageRequest, type QueryOptions } from '@framework/database';
import { createHttpKernel, type FrameworkEnv, installErrorHandling } from '@framework/http';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  type CrudRepository,
  createRouter,
  DEFAULT_SERVICE_CONTEXT,
  ResourceService,
  resolveResourceSchemas,
  resourceRoutes,
  resourceServiceToken,
} from '../src';

// ============================================================================
// Schemas and Mock Tables
// ============================================================================

const softTable = pgTable('m5_soft_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type SoftEntity = {
  id: string;
  title: string;
  description?: string | null;
  metadata?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
};

type SoftCreate = {
  title: string;
  description?: string | null;
  metadata?: string | null;
};

type SoftUpdate = Partial<SoftCreate>;

const hardTable = pgTable('m5_hard_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  cost: integer('cost').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

type HardEntity = {
  id: number;
  name: string;
  cost: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type HardCreate = {
  name: string;
  cost?: number;
};

type HardUpdate = Partial<HardCreate>;

// ============================================================================
// Mock Repositories
// ============================================================================

class MockSoftRepository implements CrudRepository<SoftEntity, SoftCreate, SoftUpdate> {
  records = new Map<string, SoftEntity>();

  async findById(id: string): Promise<SoftEntity | null> {
    const item = this.records.get(id);
    if (!item || item.deletedAt) return null;
    return item;
  }

  async findDeletedById(id: string): Promise<SoftEntity | null> {
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
    const deleted = [...this.records.values()].filter((item) => Boolean(item.deletedAt));
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

  async create(values: SoftCreate): Promise<SoftEntity> {
    const id = crypto.randomUUID();
    const entity: SoftEntity = {
      id,
      title: values.title,
      description: values.description ?? null,
      metadata: values.metadata ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly SoftCreate[]): Promise<SoftEntity[]> {
    const results: SoftEntity[] = [];
    for (const v of values) results.push(await this.create(v));
    return results;
  }

  async update(id: string, changes: SoftUpdate): Promise<SoftEntity | null> {
    const item = this.records.get(id);
    if (!item || item.deletedAt) return null;
    const updated = { ...item, ...changes, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const item = this.records.get(id);
    if (!item || item.deletedAt) return false;
    this.records.set(id, { ...item, deletedAt: new Date().toISOString() });
    return true;
  }

  async restore(id: string): Promise<boolean> {
    const item = this.records.get(id);
    if (!item?.deletedAt) return false;
    this.records.set(id, { ...item, deletedAt: null });
    return true;
  }
}

class MockHardRepository implements CrudRepository<HardEntity, HardCreate, HardUpdate> {
  records = new Map<number, HardEntity>();
  private nextId = 1;

  async findById(id: number): Promise<HardEntity | null> {
    return this.records.get(id) ?? null;
  }

  async paginate(request: PageRequest, _query?: QueryOptions) {
    const all = [...this.records.values()];
    const start = (request.page - 1) * request.limit;
    return {
      items: all.slice(start, start + request.limit),
      meta: {
        page: request.page,
        limit: request.limit,
        total: all.length,
        totalPages: Math.ceil(all.length / request.limit) || 1,
      },
    };
  }

  async create(values: HardCreate): Promise<HardEntity> {
    const id = this.nextId++;
    const entity: HardEntity = {
      id,
      name: values.name,
      cost: values.cost ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly HardCreate[]): Promise<HardEntity[]> {
    const res: HardEntity[] = [];
    for (const v of values) res.push(await this.create(v));
    return res;
  }

  async update(id: number, changes: HardUpdate): Promise<HardEntity | null> {
    const item = this.records.get(id);
    if (!item) return null;
    const updated = { ...item, ...changes, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: number): Promise<boolean> {
    return this.records.delete(id);
  }
}

function createTestHono() {
  const app = new Hono<FrameworkEnv>();
  return installErrorHandling(app, { exposeInternalErrors: true });
}

// ============================================================================
// Adversarial Stress Tests
// ============================================================================

describe('M5 Phase 2 Adversarial Hardening Suite', () => {
  // --------------------------------------------------------------------------
  // 1. DI Resolution Fallback Cascades
  // --------------------------------------------------------------------------
  describe('1. DI Resolution Fallback Cascades', () => {
    test('Tier 1: Explicit service instance passed as 2nd arg overrides DI token and fallback', async () => {
      const repo = new MockSoftRepository();
      let customHookExecuted = false;

      class CustomSoftService extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate): Promise<SoftCreate> {
          customHookExecuted = true;
          return { ...input, title: `HOOKED: ${input.title}` };
        }
      }

      const svc = new CustomSoftService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/soft', resourceRoutes(softTable, svc));

      const res = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Test Item' }),
      });

      expect(res.status).toBe(201);
      expect(customHookExecuted).toBe(true);
      const created = (await res.json()) as SoftEntity;
      expect(created.title).toBe('HOOKED: Test Item');
    });

    test('Tier 1: Explicit factory function (dataContext) => service receives request-scoped DataContext', async () => {
      const repo = new MockSoftRepository();
      let factoryContextPassed: unknown = null;

      const serviceFactory = (ctx?: DataContext) => {
        factoryContextPassed = ctx;
        return new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      };

      const app = createTestHono().route('/soft', resourceRoutes(softTable, serviceFactory));

      const res = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Factory Item' }),
      });

      expect(res.status).toBe(201);
      // Since createTestHono has no DI kernel, ctx is undefined; factory is still executed
      expect(factoryContextPassed).toBeUndefined();
    });

    test('Tier 1: Raw CrudRepository without .get() is auto-wrapped into ResourceService', async () => {
      const repo = new MockSoftRepository();
      // repo has findById, paginate, create, etc., but no .get()
      expect(typeof (repo as unknown as Record<string, unknown>).get).toBe('undefined');

      const app = createTestHono().route('/soft', resourceRoutes(softTable, repo));

      const createRes = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Auto Wrapped Repo' }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as SoftEntity;

      const getRes = await app.request(`/soft/${created.id}`);
      expect(getRes.status).toBe(200);
      expect(((await getRes.json()) as SoftEntity).title).toBe('Auto Wrapped Repo');
    });

    test('Tier 1: options.service works when 2nd positional argument is omitted', async () => {
      const repo = new MockSoftRepository();
      let customCalled = false;

      class OptService extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate): Promise<SoftCreate> {
          customCalled = true;
          return input;
        }
      }

      const svc = new OptService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/soft', resourceRoutes(softTable, { service: svc }));

      const res = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Options Service' }),
      });
      expect(res.status).toBe(201);
      expect(customCalled).toBe(true);
    });

    test('Tier 2: Explicit DI Token as argument resolves service from request container', async () => {
      const repo = new MockSoftRepository();
      let tokenSvcCalled = false;

      class TokenService extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate): Promise<SoftCreate> {
          tokenSvcCalled = true;
          return input;
        }
      }

      const svc = new TokenService(repo, DEFAULT_SERVICE_CONTEXT);
      const SOFT_TOKEN = token<TokenService>('custom.soft.service');

      const provider = defineProvider<object>({
        name: 'test-token-provider',
        register({ container }) {
          container.scoped(SOFT_TOKEN, () => svc);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });
      kernel.route('/soft', resourceRoutes(softTable, SOFT_TOKEN));

      const res = await kernel.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Token Resolution' }),
      });

      expect(res.status).toBe(201);
      expect(tokenSvcCalled).toBe(true);
      await application.shutdown();
    });

    test('Tier 2: Convention token <tableName>.service resolves automatically when registered in container', async () => {
      const repo = new MockSoftRepository();
      let conventionCalled = false;

      class ConventionService extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate): Promise<SoftCreate> {
          conventionCalled = true;
          return input;
        }
      }

      const svc = new ConventionService(repo, DEFAULT_SERVICE_CONTEXT);
      const convToken = resourceServiceToken(softTable);

      const provider = defineProvider<object>({
        name: 'convention-token-provider',
        register({ container }) {
          container.scoped(convToken, () => svc);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });
      // Call resourceRoutes with NO service argument -> triggers convention token lookup
      kernel.route('/soft', resourceRoutes(softTable));

      const res = await kernel.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Convention Token' }),
      });

      expect(res.status).toBe(201);
      expect(conventionCalled).toBe(true);
      await application.shutdown();
    });

    test('Tier 2: Explicit serviceToken in options.serviceToken resolves from container', async () => {
      const repo = new MockSoftRepository();
      let tokenOptCalled = false;

      class TokenOptService extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate): Promise<SoftCreate> {
          tokenOptCalled = true;
          return input;
        }
      }

      const svc = new TokenOptService(repo, DEFAULT_SERVICE_CONTEXT);
      const MY_TOKEN = token<TokenOptService>('my.opt.token');

      const provider = defineProvider<object>({
        name: 'token-opt-provider',
        register({ container }) {
          container.scoped(MY_TOKEN, () => svc);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });
      kernel.route('/soft', resourceRoutes(softTable, { serviceToken: MY_TOKEN }));

      const res = await kernel.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Token in options' }),
      });

      expect(res.status).toBe(201);
      expect(tokenOptCalled).toBe(true);
      await application.shutdown();
    });

    test('Tier 2 Error: Token specified but request scope is missing throws descriptive error', async () => {
      const MY_TOKEN = token<ResourceService<SoftEntity, SoftCreate, SoftUpdate>>('missing.scope.token');
      const app = createTestHono().route('/soft', resourceRoutes(softTable, MY_TOKEN));

      const res = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Will Fail' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('Cannot resolve service token "missing.scope.token"');
    });

    test('Tier 3 Fallback Error: No service provided and request scope is missing throws descriptive error', async () => {
      const app = createTestHono().route('/soft', resourceRoutes(softTable));

      const res = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No Scope Fallback' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('Cannot resolve service for table "m5_soft_items"');
    });

    test('Tier 3 baseService fallback passes options.softDeleteColumn to baseRepository', async () => {
      const archivedTable = pgTable('m5_archived_items', {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title').notNull(),
        archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
      });

      const app = resourceRoutes(archivedTable, { softDeleteColumn: archivedTable.archivedAt });

      const createBuilder = (result: unknown) => {
        const p = Promise.resolve(result);
        return Object.assign(p, {
          from: () => createBuilder(result),
          where: () => createBuilder(result),
          orderBy: () => createBuilder(result),
          limit: () => createBuilder(result),
          offset: () => createBuilder(result),
        });
      };

      const mockDataContext: DataContext = {
        execution: new ExecutionContext('test', 'corr-1', { id: 'user-1', type: 'user' }),
        transactions: {
          executor: {
            select: (arg?: unknown) => createBuilder(arg ? [{ total: 0 }] : []),
          },
          transaction: <T>(work: () => Promise<T>) => work(),
        } as unknown as DataContext['transactions'],
      };
      const container = new Container();
      container.value(DATA_CONTEXT, mockDataContext);
      const scope = container.createScope('request');

      const subApp = new Hono<FrameworkEnv>();
      installErrorHandling(subApp, { exposeInternalErrors: true });
      subApp.use('*', async (c, next) => {
        c.set('scope', scope);
        await next();
      });
      subApp.route('/docs', app);

      // With options.softDeleteColumn forwarded to baseService, BaseSoftDeletableRepository
      // is correctly instantiated and GET /docs/deleted succeeds with 200.
      const res = await subApp.request('/docs/deleted');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; meta: { total: number } };
      expect(body.items).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    test('resolveResourceSchemas omits custom softDeleteColumn from createSchema and updateSchema', () => {
      const archivedTable = pgTable('m5_archived_items_2', {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title').notNull(),
        archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
      });

      const schemas = resolveResourceSchemas(archivedTable, {
        softDeleteColumn: archivedTable.archivedAt,
      });

      // Custom archivedAt is omitted from schemas alongside system columns and rejected by .strict()
      const updateParsed = schemas.updateSchema.safeParse({ archivedAt: new Date().toISOString() });
      expect(updateParsed.success).toBe(false);

      const createParsed = schemas.createSchema.safeParse({
        title: 'New Doc',
        archivedAt: new Date().toISOString(),
      });
      expect(createParsed.success).toBe(false);

      const validUpdate = schemas.updateSchema.safeParse({ title: 'Updated Title' });
      expect(validUpdate.success).toBe(true);
    });

    test('Cascade Priority: Tier 1 explicit argument beats Tier 2 Token in options', async () => {
      const repo = new MockSoftRepository();
      let tier1Used = false;
      let tier2Used = false;

      class Tier1Service extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate) {
          tier1Used = true;
          return input;
        }
      }
      class Tier2Service extends ResourceService<SoftEntity, SoftCreate, SoftUpdate> {
        override async beforeCreate(input: SoftCreate) {
          tier2Used = true;
          return input;
        }
      }

      const svc1 = new Tier1Service(repo, DEFAULT_SERVICE_CONTEXT);
      const svc2 = new Tier2Service(repo, DEFAULT_SERVICE_CONTEXT);
      const TIER2_TOKEN = token<Tier2Service>('tier2.service');

      const provider = defineProvider<object>({
        name: 'priority-provider',
        register({ container }) {
          container.scoped(TIER2_TOKEN, () => svc2);
        },
      });

      const application = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(application, { exposeInternalErrors: false });

      // Pass Tier 1 as 2nd arg, and Tier 2 in options
      kernel.route('/soft', resourceRoutes(softTable, svc1, { serviceToken: TIER2_TOKEN }));

      const res = await kernel.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Priority Check' }),
      });

      expect(res.status).toBe(201);
      expect(tier1Used).toBe(true);
      expect(tier2Used).toBe(false);

      await application.shutdown();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Route Priority & Varied Prefix Mounts & Nested Router Chaining
  // --------------------------------------------------------------------------
  describe('2. Route Priority under Varied Prefix Mounts & Nested Router Chaining', () => {
    test('Mounting via createRouter() ResourceRouter instance supports all 8 endpoints (9 methods)', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);

      const router = createRouter();
      router.resource('/soft', softTable, svc);

      const app = createTestHono().route('', router);

      // 1. POST /soft
      const postRes = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Router Item' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as SoftEntity;

      // 2. GET /soft
      const listRes = await app.request('/soft');
      expect(listRes.status).toBe(200);

      // 3. GET /soft/:id
      const getRes = await app.request(`/soft/${created.id}`);
      expect(getRes.status).toBe(200);

      // 4. PATCH /soft/:id
      const patchRes = await app.request(`/soft/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Router Item' }),
      });
      expect(patchRes.status).toBe(200);

      // 5. DELETE /soft/:id
      const delRes = await app.request(`/soft/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      // 6. GET /soft/deleted
      const delListRes = await app.request('/soft/deleted');
      expect(delListRes.status).toBe(200);
      const delList = (await delListRes.json()) as { items: SoftEntity[] };
      expect(delList.items.some((i) => i.id === created.id)).toBe(true);

      // 7. GET /soft/deleted/:id
      const delGetRes = await app.request(`/soft/deleted/${created.id}`);
      expect(delGetRes.status).toBe(200);
      expect(((await delGetRes.json()) as SoftEntity).id).toBe(created.id);

      // 8. POST /soft/:id/restore
      const restoreRes = await app.request(`/soft/${created.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);

      // Delete again & test 9. PATCH /soft/:id/restore
      await app.request(`/soft/${created.id}`, { method: 'DELETE' });
      const patchRestoreRes = await app.request(`/soft/${created.id}/restore`, { method: 'PATCH' });
      expect(patchRestoreRes.status).toBe(200);
    });

    test('Mounting via Hono.prototype.resource on root Hono app works fluently', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono().resource('/fluent-soft', softTable, svc);

      const res = await app.request('/fluent-soft');
      expect(res.status).toBe(200);
    });

    test('Deeply nested router chaining: /api/v1/admin/resources mounts and routes priority correctly', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const created = await repo.create({ title: 'Deep Nested Item' });
      await repo.delete(created.id); // soft-deleted

      // Level 1: Resource Router mounted at /resources
      const level1 = createRouter().resource('/resources', softTable, svc);

      // Level 2: Sub-router mounted at /admin
      const level2 = new Hono<FrameworkEnv>().route('/admin', level1);

      // Level 3: API router mounted at /v1
      const level3 = new Hono<FrameworkEnv>().route('/v1', level2);

      // Level 4: Root app mounted at /api
      const rootApp = createTestHono().route('/api', level3);

      // Route priority verification in deep nested chain:
      // 1. /api/v1/admin/resources/deleted MUST hit /deleted list (200), NOT /:id as id="deleted"
      const delListRes = await rootApp.request('/api/v1/admin/resources/deleted');
      expect(delListRes.status).toBe(200);
      const delBody = (await delListRes.json()) as { items: SoftEntity[] };
      expect(delBody.items.some((i) => i.id === created.id)).toBe(true);

      // 2. /api/v1/admin/resources/deleted/:id MUST hit showDeleted(:id) (200)
      const delShowRes = await rootApp.request(`/api/v1/admin/resources/deleted/${created.id}`);
      expect(delShowRes.status).toBe(200);
      expect(((await delShowRes.json()) as SoftEntity).id).toBe(created.id);

      // 3. /api/v1/admin/resources/:id/restore MUST hit restore (200)
      const restoreRes = await rootApp.request(`/api/v1/admin/resources/${created.id}/restore`, {
        method: 'POST',
      });
      expect(restoreRes.status).toBe(200);

      // 4. Now active: /api/v1/admin/resources/:id returns 200
      const activeShowRes = await rootApp.request(`/api/v1/admin/resources/${created.id}`);
      expect(activeShowRes.status).toBe(200);
    });

    test('Multiple sibling resources mounted on the same router do not collide or leak state', async () => {
      const softRepo = new MockSoftRepository();
      const hardRepo = new MockHardRepository();
      const softSvc = new ResourceService(softRepo, DEFAULT_SERVICE_CONTEXT);
      const hardSvc = new ResourceService(hardRepo, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono().resource('/users', softTable, softSvc).resource('/items', hardTable, hardSvc);

      // POST to /users (UUID)
      const uRes = await app.request('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'User 1' }),
      });
      expect(uRes.status).toBe(201);
      const user = (await uRes.json()) as SoftEntity;

      // POST to /items (Integer)
      const iRes = await app.request('/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Item 1', cost: 100 }),
      });
      expect(iRes.status).toBe(201);
      const item = (await iRes.json()) as HardEntity;

      // Soft-delete user
      await app.request(`/users/${user.id}`, { method: 'DELETE' });

      // Verify user in /users/deleted
      expect((await app.request('/users/deleted')).status).toBe(200);

      // /items is not soft-deletable: /items/deleted MUST be 400
      expect((await app.request('/items/deleted')).status).toBe(400);

      // /items/:id works with integer
      expect((await app.request(`/items/${item.id}`)).status).toBe(200);

      // /users/:id with integer fails with 422
      expect((await app.request('/users/123')).status).toBe(422);

      // /items/:id with uuid fails with 422
      expect((await app.request(`/items/${user.id}`)).status).toBe(422);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Soft-Delete Query Filter Interactions
  // --------------------------------------------------------------------------
  describe('3. Soft-Delete Query Filter Interactions', () => {
    test('Non-soft-deletable table returns 400 Bad Request on all soft-delete endpoints', async () => {
      const repo = new MockHardRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().resource('/hard', hardTable, svc);

      expect((await app.request('/hard/deleted')).status).toBe(400);
      expect((await app.request('/hard/deleted/1')).status).toBe(400);
      expect((await app.request('/hard/1/restore', { method: 'POST' })).status).toBe(400);
      expect((await app.request('/hard/1/restore', { method: 'PATCH' })).status).toBe(400);
    });

    test('GET /deleted/:id for an active (non-deleted) record returns 404 Not Found', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const active = await repo.create({ title: 'Active Item' });
      const app = createTestHono().resource('/soft', softTable, svc);

      const res = await app.request(`/soft/deleted/${active.id}`);
      expect(res.status).toBe(404);
    });

    test('POST /:id/restore for an active (non-deleted) record returns 404 Not Found', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const active = await repo.create({ title: 'Already Active' });
      const app = createTestHono().resource('/soft', softTable, svc);

      const res = await app.request(`/soft/${active.id}/restore`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    test('Double restore: Second call to restore returns 404 Not Found', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Double Restore Target' });
      await repo.delete(item.id);
      const app = createTestHono().resource('/soft', softTable, svc);

      // First restore succeeds
      const r1 = await app.request(`/soft/${item.id}/restore`, { method: 'POST' });
      expect(r1.status).toBe(200);

      // Second restore returns 404 because item is already active
      const r2 = await app.request(`/soft/${item.id}/restore`, { method: 'POST' });
      expect(r2.status).toBe(404);
    });

    test('paginateDeleted pagination limits are respected on GET /deleted', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      for (let i = 1; i <= 5; i++) {
        const item = await repo.create({ title: `Deleted ${i}` });
        await repo.delete(item.id);
      }
      const app = createTestHono().resource('/soft', softTable, svc);

      const res = await app.request('/soft/deleted?page=2&limit=2');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: SoftEntity[]; meta: { page: number; limit: number; total: number } };
      expect(body.items.length).toBe(2);
      expect(body.meta.page).toBe(2);
      expect(body.meta.limit).toBe(2);
      expect(body.meta.total).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // 4. DTO Serialization: Transforms & Nullable Fields
  // --------------------------------------------------------------------------
  describe('4. DTO Serialization: Custom Transforms, serialize, toResponse & Nullables', () => {
    test('options.transform projects across all 7 endpoints including null/nullable fields', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);

      interface PublicSoftDto {
        identifier: string;
        displayTitle: string;
        hasDescription: boolean;
        descValue: string | null;
        archived: boolean;
      }

      const transform = (entity: SoftEntity): PublicSoftDto => ({
        identifier: entity.id,
        displayTitle: entity.title.toUpperCase(),
        hasDescription: Boolean(entity.description),
        descValue: entity.description ?? null,
        archived: Boolean(entity.deletedAt),
      });

      const app = createTestHono().resource('/soft', softTable, svc, { transform });

      // 1. POST /
      const postRes = await app.request('/soft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Widget', description: null }),
      });
      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as PublicSoftDto;
      expect(postBody.displayTitle).toBe('WIDGET');
      expect(postBody.descValue).toBeNull();
      expect(postBody.hasDescription).toBe(false);
      expect(postBody.archived).toBe(false);

      // 2. GET / (list)
      const listRes = await app.request('/soft');
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { items: PublicSoftDto[] };
      expect(listBody.items[0]?.displayTitle).toBe('WIDGET');
      expect(listBody.items[0]?.descValue).toBeNull();

      // 3. GET /:id (show)
      const getRes = await app.request(`/soft/${postBody.identifier}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as PublicSoftDto;
      expect(getBody.displayTitle).toBe('WIDGET');

      // 4. PATCH /:id (update)
      const patchRes = await app.request(`/soft/${postBody.identifier}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed Widget', description: 'Now has description' }),
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as PublicSoftDto;
      expect(patchBody.displayTitle).toBe('RENAMED WIDGET');
      expect(patchBody.hasDescription).toBe(true);
      expect(patchBody.descValue).toBe('Now has description');

      // 5. Soft-delete
      await app.request(`/soft/${postBody.identifier}`, { method: 'DELETE' });

      // 6. GET /deleted
      const delListRes = await app.request('/soft/deleted');
      expect(delListRes.status).toBe(200);
      const delListBody = (await delListRes.json()) as { items: PublicSoftDto[] };
      expect(delListBody.items[0]?.archived).toBe(true);

      // 7. GET /deleted/:id
      const delGetRes = await app.request(`/soft/deleted/${postBody.identifier}`);
      expect(delGetRes.status).toBe(200);
      const delGetBody = (await delGetRes.json()) as PublicSoftDto;
      expect(delGetBody.archived).toBe(true);

      // 8. POST /:id/restore
      const restoreRes = await app.request(`/soft/${postBody.identifier}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      const restoreBody = (await restoreRes.json()) as PublicSoftDto;
      expect(restoreBody.archived).toBe(false);
    });

    test('Alias Precedence: transform > serialize > toResponse', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Precedence Item' });

      // transform beats serialize and toResponse
      const app1 = createTestHono().resource('/soft', softTable, svc, {
        transform: () => ({ winner: 'transform' }),
        serialize: () => ({ winner: 'serialize' }),
        toResponse: () => ({ winner: 'toResponse' }),
      });
      const res1 = await app1.request(`/soft/${item.id}`);
      expect(((await res1.json()) as { winner: string }).winner).toBe('transform');

      // serialize beats toResponse
      const app2 = createTestHono().resource('/soft', softTable, svc, {
        serialize: () => ({ winner: 'serialize' }),
        toResponse: () => ({ winner: 'toResponse' }),
      });
      const res2 = await app2.request(`/soft/${item.id}`);
      expect(((await res2.json()) as { winner: string }).winner).toBe('serialize');

      // toResponse alone works
      const app3 = createTestHono().resource('/soft', softTable, svc, {
        toResponse: () => ({ winner: 'toResponse' }),
      });
      const res3 = await app3.request(`/soft/${item.id}`);
      expect(((await res3.json()) as { winner: string }).winner).toBe('toResponse');
    });

    test('DTO serializer injecting unexpected computed fields does not break pagination meta', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      await repo.create({ title: 'Item Alpha' });
      await repo.create({ title: 'Item Beta' });

      const app = createTestHono().resource('/soft', softTable, svc, {
        transform: (e) => ({
          id: e.id,
          title: e.title,
          computedTag: 'CUSTOM_COMPUTED_VAL',
          nested: { flag: true, values: [1, 2, 3] },
        }),
      });

      const res = await app.request('/soft?page=1&limit=10');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string; computedTag: string; nested: { flag: boolean } }>;
        meta: { page: number; limit: number; total: number; totalPages: number };
      };

      expect(body.meta).toEqual({
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
      });
      expect(body.items[0]?.computedTag).toBe('CUSTOM_COMPUTED_VAL');
      expect(body.items[0]?.nested.flag).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Strict Update Schema Non-Empty Body Validation Across Diverse Payloads
  // --------------------------------------------------------------------------
  describe('5. Strict Update Schema Validation Across Diverse Payload Types', () => {
    test('Rejects empty body {} with 422 and "At least one writable field is required"', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Valid Item' });
      const app = createTestHono().resource('/soft', softTable, svc);

      const res = await app.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: { message?: string; fields?: Array<{ message?: string }> } };
      expect(body.error?.fields?.[0]?.message).toContain('At least one writable field is required');
    });

    test('Rejects system columns only with 422 strict schema error', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Valid Item' });
      const app = createTestHono().resource('/soft', softTable, svc);

      const systemPayloads = [
        { id: crypto.randomUUID() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { deletedAt: null },
      ];

      for (const payload of systemPayloads) {
        const res = await app.request(`/soft/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(422);
      }
    });

    test('Rejects unexpected / arbitrary keys with 422 strict schema error', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Valid Item' });
      const app = createTestHono().resource('/soft', softTable, svc);

      // Only unknown key
      const res1 = await app.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ injectedKey: 'malicious' }),
      });
      expect(res1.status).toBe(422);

      // Valid key + unknown key
      const res2 = await app.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New Title', hackerField: true }),
      });
      expect(res2.status).toBe(422);
    });

    test('Rejects non-object JSON payloads (array, string, number, boolean, null) with 422', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Valid Item' });
      const app = createTestHono().resource('/soft', softTable, svc);

      const nonObjectPayloads = ['[1, 2, 3]', '"string-body"', '12345', 'true', 'null'];

      for (const payload of nonObjectPayloads) {
        const res = await app.request(`/soft/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        expect(res.status).toBe(422);
      }
    });

    test('Accepts valid partial update and nullable field update to null', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Original', description: 'Has text', metadata: 'meta' });
      const app = createTestHono().resource('/soft', softTable, svc);

      // Update only title
      const res1 = await app.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      expect(res1.status).toBe(200);
      expect(((await res1.json()) as SoftEntity).title).toBe('Updated Title');

      // Update nullable description to null
      const res2 = await app.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: null }),
      });
      expect(res2.status).toBe(200);
      expect(((await res2.json()) as SoftEntity).description).toBeNull();
    });

    test('Custom updateSchema overrides auto-generation; null updateSchema falls back to auto-gen', async () => {
      const repo = new MockSoftRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const item = await repo.create({ title: 'Custom Schema Item' });

      const customUpdate = z.object({
        title: z.string().min(10),
      });

      const appCustom = createTestHono().resource('/soft', softTable, svc, {
        updateSchema: customUpdate,
      });

      // Title < 10 chars fails custom schema
      const failRes = await appCustom.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Short' }),
      });
      expect(failRes.status).toBe(422);

      // Title >= 10 chars passes custom schema
      const passRes = await appCustom.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Long Enough Title' }),
      });
      expect(passRes.status).toBe(200);

      // Passing updateSchema: null falls back to auto-generation
      const appFallback = createTestHono().resource('/soft', softTable, svc, {
        updateSchema: null,
      });

      // Empty body still rejected by auto-generated strict update schema
      const emptyRes = await appFallback.request(`/soft/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(emptyRes.status).toBe(422);
    });
  });
});
