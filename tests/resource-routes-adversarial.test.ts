import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Application, defineProvider, EXECUTION_CONTEXT, token } from '@framework/core';
import {
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  type DatabaseConnection,
  type DataContext,
  type PageRequest,
  type QueryOptions,
  TRANSACTION_CONTEXT,
  TransactionContext,
} from '@framework/database';
import { type DomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { createHttpKernel, type FrameworkEnv, installErrorHandling } from '@framework/http';
import { createTestDatabase, type TestDatabase } from '@framework/testing';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import {
  type CrudRepository,
  createRouter,
  DEFAULT_SERVICE_CONTEXT,
  ResourceRouter,
  ResourceService,
  resourceRoutes,
  resourceServiceToken,
} from '../src';

// ============================================================================
// Test Tables Definition
// ============================================================================

const tableAlpha = pgTable('adv_alpha', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type AlphaEntity = {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly deletedAt?: string | null;
};

type AlphaCreate = {
  readonly title: string;
  readonly author: string;
};

type AlphaUpdate = Partial<AlphaCreate>;

const tableBeta = pgTable('adv_beta', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  label: text('label').notNull(),
  score: integer('score').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

type BetaEntity = {
  readonly id: number;
  readonly label: string;
  readonly score: number;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
};

type BetaCreate = {
  readonly label: string;
  readonly score?: number;
};

type BetaUpdate = Partial<BetaCreate>;

const tableGamma = pgTable('adv_gamma', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

// ============================================================================
// Mock Repositories
// ============================================================================

class MockAlphaRepository implements CrudRepository<AlphaEntity, AlphaCreate, AlphaUpdate> {
  records = new Map<string, AlphaEntity>();

  async findById(id: string): Promise<AlphaEntity | null> {
    const r = this.records.get(id);
    if (!r || r.deletedAt) return null;
    return r;
  }

  async findDeletedById(id: string): Promise<AlphaEntity | null> {
    const r = this.records.get(id);
    if (!r?.deletedAt) return null;
    return r;
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

  async create(values: AlphaCreate): Promise<AlphaEntity> {
    const id = crypto.randomUUID();
    const entity: AlphaEntity = {
      id,
      title: values.title,
      author: values.author,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly AlphaCreate[]): Promise<AlphaEntity[]> {
    const res: AlphaEntity[] = [];
    for (const v of values) res.push(await this.create(v));
    return res;
  }

  async update(id: string, changes: AlphaUpdate): Promise<AlphaEntity | null> {
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

class MockBetaRepository implements CrudRepository<BetaEntity, BetaCreate, BetaUpdate> {
  records = new Map<number, BetaEntity>();
  nextId = 1;

  async findById(id: number): Promise<BetaEntity | null> {
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

  async create(values: BetaCreate): Promise<BetaEntity> {
    const id = this.nextId++;
    const entity: BetaEntity = {
      id,
      label: values.label,
      score: values.score ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, entity);
    return entity;
  }

  async createMany(values: readonly BetaCreate[]): Promise<BetaEntity[]> {
    const res: BetaEntity[] = [];
    for (const v of values) res.push(await this.create(v));
    return res;
  }

  async update(id: number, changes: BetaUpdate): Promise<BetaEntity | null> {
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

// --- Custom Service with Tracing ---

class CustomInstrumentedAlphaService extends ResourceService<AlphaEntity, AlphaCreate, AlphaUpdate> {
  calls: string[] = [];

  protected override beforeCreate(input: AlphaCreate): AlphaCreate {
    this.calls.push('beforeCreate');
    return { ...input, title: `[Instrumented] ${input.title}` };
  }

  protected override afterCreate(entity: AlphaEntity): void {
    this.calls.push(`afterCreate:${entity.id}`);
  }

  protected override beforeUpdate(id: string, changes: AlphaUpdate): AlphaUpdate {
    this.calls.push(`beforeUpdate:${id}`);
    return changes;
  }

  protected override beforeDelete(id: string): void {
    this.calls.push(`beforeDelete:${id}`);
  }

  protected override beforeRestore(id: string): void {
    this.calls.push(`beforeRestore:${id}`);
  }
}

function createTestHono() {
  const app = new Hono<FrameworkEnv>();
  return installErrorHandling(app, { exposeInternalErrors: true });
}

// ============================================================================
// Real DB Setup (Optional / Graceful Fallback)
// ============================================================================

let testDb: TestDatabase | undefined;
let dbConn: DatabaseConnection | undefined;
let testApp: Application<object>;
let memoryBus: MemoryEventBus;

beforeAll(async () => {
  memoryBus = new MemoryEventBus();
  const adminUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

  try {
    testDb = await createTestDatabase({ adminUrl });
    dbConn = createConnection({ url: testDb.url, maxConnections: 4 });
    await dbConn.sql`create extension if not exists "pgcrypto"`;
    await dbConn.sql`create table if not exists adv_alpha (
      id uuid primary key default gen_random_uuid(),
      title text not null,
      author text not null,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      deleted_at timestamptz
    )`;
    await dbConn.sql`create table if not exists adv_beta (
      id integer primary key generated always as identity,
      label text not null,
      score integer not null default 0,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    )`;
  } catch (_e) {
    // If real Postgres is unavailable, DB tests gracefully skip
  }

  const testProvider = defineProvider<object>({
    name: 'adversarial-m3-provider',
    register({ container }) {
      if (dbConn) {
        container.value(DATABASE, dbConn);
        container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
        container.scoped(DATA_CONTEXT, (r) => ({
          transactions: r.resolve(TRANSACTION_CONTEXT),
          execution: r.resolve(EXECUTION_CONTEXT),
        }));
      }
      container.value(EVENT_BUS, memoryBus);
    },
  });

  testApp = await new Application({ config: {}, providers: [testProvider] }).boot();
});

afterAll(async () => {
  await testApp?.shutdown().catch(() => undefined);
  await dbConn?.close().catch(() => undefined);
  await testDb?.drop().catch(() => undefined);
});

// ============================================================================
// ADVERSARIAL TEST SUITE
// ============================================================================

describe('Adversarial Test Suite: DI Resolution, Router Chaining & Serializer Aliases', () => {
  // --------------------------------------------------------------------------
  // 1. TIER 1: Explicit Service Resolution
  // --------------------------------------------------------------------------
  describe('1. Tier 1: Explicit Service Instance & Factory Resolution', () => {
    test('1.1. Explicit service passed as 2nd positional argument triggers custom service logic', async () => {
      const repo = new MockAlphaRepository();
      const svc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, svc));

      const res = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Positional Service', author: 'Author A' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as AlphaEntity;
      expect(data.title).toBe('[Instrumented] Positional Service');
      expect(svc.calls).toContain('beforeCreate');
      expect(svc.calls).toContain(`afterCreate:${data.id}`);
    });

    test('1.2. Explicit service passed in options object { service } triggers custom logic', async () => {
      const repo = new MockAlphaRepository();
      const svc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, { service: svc }));

      const res = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Options Service', author: 'Author B' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as AlphaEntity;
      expect(data.title).toBe('[Instrumented] Options Service');
      expect(svc.calls).toContain('beforeCreate');
    });

    test('1.3. Positional service argument takes precedence over options.service if both provided', async () => {
      const repo1 = new MockAlphaRepository();
      const svcPositional = new CustomInstrumentedAlphaService(repo1, DEFAULT_SERVICE_CONTEXT);
      const repo2 = new MockAlphaRepository();
      const svcOptions = new CustomInstrumentedAlphaService(repo2, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, svcPositional, { service: svcOptions }));

      await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Conflict Test', author: 'Tester' }),
      });

      expect(svcPositional.calls).toContain('beforeCreate');
      expect(svcOptions.calls.length).toBe(0);
    });

    test('1.4. Raw CrudRepository instance passed as 2nd argument is automatically wrapped in ResourceService', async () => {
      const repo = new MockAlphaRepository();
      // Pass the raw repository directly, NOT wrapped in ResourceService
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, repo));

      const postRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'From Repo', author: 'Author C' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as AlphaEntity;
      expect(created.title).toBe('From Repo');

      const getRes = await app.request(`/alpha/${created.id}`);
      expect(getRes.status).toBe(200);
      expect(((await getRes.json()) as AlphaEntity).id).toBe(created.id);
    });

    test('1.5. Raw CrudRepository instance passed in { service } is automatically wrapped in ResourceService', async () => {
      const repo = new MockAlphaRepository();
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, { service: repo }));

      const postRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'From Repo Option', author: 'Author D' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as AlphaEntity;

      const delRes = await app.request(`/alpha/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      const getDeletedRes = await app.request(`/alpha/deleted/${created.id}`);
      expect(getDeletedRes.status).toBe(200);
    });

    test('1.6. Factory function (dataContext) => service receives request scope dataContext', async () => {
      const repo = new MockAlphaRepository();
      let capturedContext: DataContext | undefined;
      const factory = (ctx?: DataContext) => {
        capturedContext = ctx;
        return new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      };

      const kernel = createHttpKernel(testApp, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha, factory));

      const res = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Factory Post', author: 'Factory Author' }),
      });

      expect(res.status).toBe(201);
      if (dbConn) {
        expect(capturedContext).toBeDefined();
      }
    });

    test('1.7. Service lifecycle hooks invoked across full CRUD and restore operations', async () => {
      const repo = new MockAlphaRepository();
      const svc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, svc));

      // 1. Create -> beforeCreate + afterCreate
      const createRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Lifecycle Alpha', author: 'Author L' }),
      });
      const created = (await createRes.json()) as AlphaEntity;
      expect(svc.calls).toContain('beforeCreate');
      expect(svc.calls).toContain(`afterCreate:${created.id}`);

      // 2. Update -> beforeUpdate
      await app.request(`/alpha/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Lifecycle Renamed' }),
      });
      expect(svc.calls).toContain(`beforeUpdate:${created.id}`);

      // 3. Delete -> beforeDelete
      await app.request(`/alpha/${created.id}`, { method: 'DELETE' });
      expect(svc.calls).toContain(`beforeDelete:${created.id}`);

      // 4. Restore -> beforeRestore
      await app.request(`/alpha/${created.id}/restore`, { method: 'POST' });
      expect(svc.calls).toContain(`beforeRestore:${created.id}`);
    });
  });

  // --------------------------------------------------------------------------
  // 2. TIER 2: DI Token Service Resolution
  // --------------------------------------------------------------------------
  describe('2. Tier 2: DI Token Service Resolution', () => {
    test('2.1. DI Token passed as 2nd positional argument resolves from request container', async () => {
      const repo = new MockAlphaRepository();
      const customSvc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const ALPHA_TOKEN = token<CustomInstrumentedAlphaService>('custom.alpha.service');

      const customProvider = defineProvider<object>({
        name: 'token-tier2-pos',
        register({ container }) {
          container.scoped(ALPHA_TOKEN, () => customSvc);
        },
      });

      const appInstance = await new Application({ config: {}, providers: [customProvider] }).boot();
      const kernel = createHttpKernel(appInstance, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha, ALPHA_TOKEN));

      const res = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Token Post', author: 'Token Author' }),
      });

      expect(res.status).toBe(201);
      expect(customSvc.calls).toContain('beforeCreate');
      await appInstance.shutdown();
    });

    test('2.2. DI Token passed in { serviceToken } options resolves from request container', async () => {
      const repo = new MockAlphaRepository();
      const customSvc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const ALPHA_TOKEN = token<CustomInstrumentedAlphaService>('custom.alpha.service.opt');

      const customProvider = defineProvider<object>({
        name: 'token-tier2-opt',
        register({ container }) {
          container.scoped(ALPHA_TOKEN, () => customSvc);
        },
      });

      const appInstance = await new Application({ config: {}, providers: [customProvider] }).boot();
      const kernel = createHttpKernel(appInstance, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha, { serviceToken: ALPHA_TOKEN }));

      const res = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ServiceToken Post', author: 'Option Author' }),
      });

      expect(res.status).toBe(201);
      expect(customSvc.calls).toContain('beforeCreate');
      await appInstance.shutdown();
    });

    test('2.3. DI Token passed in { service: TOKEN } options is recognized as token and resolves', async () => {
      const repo = new MockAlphaRepository();
      const customSvc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const ALPHA_TOKEN = token<CustomInstrumentedAlphaService>('custom.alpha.service.in.service');

      const customProvider = defineProvider<object>({
        name: 'token-tier2-in-svc',
        register({ container }) {
          container.scoped(ALPHA_TOKEN, () => customSvc);
        },
      });

      const appInstance = await new Application({ config: {}, providers: [customProvider] }).boot();
      const kernel = createHttpKernel(appInstance, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha, { service: ALPHA_TOKEN }));

      const res = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Service Field Token Post', author: 'Author' }),
      });

      expect(res.status).toBe(201);
      expect(customSvc.calls).toContain('beforeCreate');
      await appInstance.shutdown();
    });

    test('2.4. Convention token <tableName>.service is resolved when registered in scope', async () => {
      const repo = new MockAlphaRepository();
      const conventionSvc = new CustomInstrumentedAlphaService(repo, DEFAULT_SERVICE_CONTEXT);
      const convTok = resourceServiceToken(tableAlpha);

      const conventionProvider = defineProvider<object>({
        name: 'convention-token-test',
        register({ container }) {
          container.scoped(convTok, () => conventionSvc);
        },
      });

      const appInstance = await new Application({ config: {}, providers: [conventionProvider] }).boot();
      const kernel = createHttpKernel(appInstance, { exposeInternalErrors: true });
      // Neither service nor token provided: router must auto-resolve convTok
      kernel.route('/alpha', resourceRoutes(tableAlpha));

      const res = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Convention Resolved', author: 'Conv Author' }),
      });

      expect(res.status).toBe(201);
      expect(conventionSvc.calls).toContain('beforeCreate');
      await appInstance.shutdown();
    });

    test('2.5. Explicit service (Tier 1) overrides convention token (Tier 2)', async () => {
      const repo1 = new MockAlphaRepository();
      const explicitSvc = new CustomInstrumentedAlphaService(repo1, DEFAULT_SERVICE_CONTEXT);
      const repo2 = new MockAlphaRepository();
      const conventionSvc = new CustomInstrumentedAlphaService(repo2, DEFAULT_SERVICE_CONTEXT);
      const convTok = resourceServiceToken(tableAlpha);

      const provider = defineProvider<object>({
        name: 'priority-test-provider',
        register({ container }) {
          container.scoped(convTok, () => conventionSvc);
        },
      });

      const appInstance = await new Application({ config: {}, providers: [provider] }).boot();
      const kernel = createHttpKernel(appInstance, { exposeInternalErrors: true });
      // Explicit service provided: must override convention token
      kernel.route('/alpha', resourceRoutes(tableAlpha, explicitSvc));

      await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Override Test', author: 'Tester' }),
      });

      expect(explicitSvc.calls).toContain('beforeCreate');
      expect(conventionSvc.calls.length).toBe(0);
      await appInstance.shutdown();
    });

    test('2.6. Request missing scope when resolving token throws descriptive error', async () => {
      const MY_TOKEN = token<object>('unresolvable.token');
      const plainHono = createTestHono();
      plainHono.route('/alpha', resourceRoutes(tableAlpha, MY_TOKEN));

      // Plain Hono does NOT set c.get('scope'), so resolving MY_TOKEN must throw
      const res = await plainHono.request('/alpha');
      expect(res.status).toBe(500);
      const err = await res.json();
      expect(JSON.stringify(err)).toContain('request scope is missing');
    });
  });

  // --------------------------------------------------------------------------
  // 3. TIER 3: Fallback to baseService
  // --------------------------------------------------------------------------
  describe('3. Tier 3: Fallback to baseService with DATA_CONTEXT & EVENT_BUS', () => {
    test('3.1. When no service provided, falls back to baseService and queries real Postgres', async () => {
      if (!dbConn) {
        return;
      }

      const kernel = createHttpKernel(testApp, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha));

      // 1. POST /alpha creates row in real Postgres via baseService
      const postRes = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'DB Fallback Post', author: 'Postgres' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as AlphaEntity;
      expect(created.id).toBeDefined();
      expect(created.title).toBe('DB Fallback Post');

      // 2. GET /alpha retrieves paginated records
      const listRes = await kernel.request('/alpha');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: AlphaEntity[] };
      expect(list.items.some((i) => i.id === created.id)).toBe(true);

      // 3. GET /alpha/:id retrieves single item
      const showRes = await kernel.request(`/alpha/${created.id}`);
      expect(showRes.status).toBe(200);
      expect(((await showRes.json()) as AlphaEntity).id).toBe(created.id);

      // 4. PATCH /alpha/:id updates row
      const patchRes = await kernel.request(`/alpha/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'DB Fallback Updated' }),
      });
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as AlphaEntity).title).toBe('DB Fallback Updated');

      // 5. DELETE /alpha/:id soft-deletes row
      const delRes = await kernel.request(`/alpha/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      // 6. GET /alpha/deleted shows soft-deleted row
      const delListRes = await kernel.request('/alpha/deleted');
      expect(delListRes.status).toBe(200);
      const delList = (await delListRes.json()) as { items: AlphaEntity[] };
      expect(delList.items.some((i) => i.id === created.id)).toBe(true);

      // 7. POST /alpha/:id/restore restores row
      const restoreRes = await kernel.request(`/alpha/${created.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      expect(((await restoreRes.json()) as AlphaEntity).deletedAt).toBeNull();
    });

    test('3.2. baseService emits domain events to EVENT_BUS resolved from request scope', async () => {
      if (!dbConn) {
        return;
      }

      const events: DomainEvent[] = [];
      memoryBus.subscribe('adv_alpha', async (e) => {
        events.push(e);
      });

      const kernel = createHttpKernel(testApp, { exposeInternalErrors: true });
      kernel.route('/alpha', resourceRoutes(tableAlpha));

      const postRes = await kernel.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Event Emission Test', author: 'Bus Tester' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as AlphaEntity;

      // Verify created event was emitted
      expect(
        events.some((e) => e.type === 'adv_alpha.created' && (e.payload as Record<string, unknown>).id === created.id),
      ).toBe(true);

      // Update event
      await kernel.request(`/alpha/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Emitted Update' }),
      });
      expect(events.some((e) => e.type === 'adv_alpha.updated')).toBe(true);

      // Delete event
      await kernel.request(`/alpha/${created.id}`, { method: 'DELETE' });
      expect(events.some((e) => e.type === 'adv_alpha.deleted')).toBe(true);

      // Restore event
      await kernel.request(`/alpha/${created.id}/restore`, { method: 'POST' });
      expect(events.some((e) => e.type === 'adv_alpha.restored')).toBe(true);
    });

    test('3.3. When request scope is completely missing and no explicit service provided, throws 500', async () => {
      const plainHono = createTestHono();
      plainHono.route('/alpha', resourceRoutes(tableAlpha));

      const res = await plainHono.request('/alpha');
      expect(res.status).toBe(500);
      const err = await res.json();
      expect(JSON.stringify(err)).toContain('no explicit service provided and request scope is missing');
    });
  });

  // --------------------------------------------------------------------------
  // 4. FLUENT CHAINING: ResourceRouter, createRouter & Hono.prototype.resource
  // --------------------------------------------------------------------------
  describe('4. Fluent Chaining & Multi-Resource Isolation', () => {
    test('4.1. createRouter().resource().resource() chains multiple resources fluently', async () => {
      const repoA = new MockAlphaRepository();
      const repoB = new MockBetaRepository();
      const svcA = new ResourceService(repoA, DEFAULT_SERVICE_CONTEXT);
      const svcB = new ResourceService(repoB, DEFAULT_SERVICE_CONTEXT);

      const router = createRouter().resource('/alphas', tableAlpha, svcA).resource('/betas', tableBeta, svcB);

      expect(router instanceof ResourceRouter).toBe(true);
      expect(router instanceof Hono).toBe(true);

      const app = createTestHono().route('/api', router);

      // Both respond at their respective sub-paths
      const resA = await app.request('/api/alphas');
      expect(resA.status).toBe(200);

      const resB = await app.request('/api/betas');
      expect(resB.status).toBe(200);
    });

    test('4.2. Hono.prototype.resource allows fluent chaining directly on new Hono()', async () => {
      const repoA = new MockAlphaRepository();
      const repoB = new MockBetaRepository();
      const svcA = new ResourceService(repoA, DEFAULT_SERVICE_CONTEXT);
      const svcB = new ResourceService(repoB, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono().resource('/alphas', tableAlpha, svcA).resource('/betas', tableBeta, svcB);

      // POST to /alphas (UUID PK)
      const postA = await app.request('/alphas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Chained A', author: 'Author 1' }),
      });
      expect(postA.status).toBe(201);
      const a = (await postA.json()) as AlphaEntity;

      // POST to /betas (Integer PK)
      const postB = await app.request('/betas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Chained B', score: 42 }),
      });
      expect(postB.status).toBe(201);
      const b = (await postB.json()) as BetaEntity;

      // Verify routing isolation
      expect((await app.request(`/alphas/${a.id}`)).status).toBe(200);
      expect((await app.request(`/betas/${b.id}`)).status).toBe(200);

      // Cross-checking PK formats
      expect((await app.request(`/alphas/${b.id}`)).status).toBe(422); // integer ID invalid for UUID table
      expect((await app.request(`/betas/${a.id}`)).status).toBe(422); // UUID ID invalid for integer table
    });

    test('4.3. Multi-resource soft-delete endpoint isolation: /a/deleted vs /b/deleted', async () => {
      const repoA = new MockAlphaRepository(); // soft-deletable
      const repoB = new MockBetaRepository(); // hard-delete only
      const svcA = new ResourceService(repoA, DEFAULT_SERVICE_CONTEXT);
      const svcB = new ResourceService(repoB, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono().resource('/alphas', tableAlpha, svcA).resource('/betas', tableBeta, svcB);

      // Alpha supports soft delete
      const delA = await app.request('/alphas/deleted');
      expect(delA.status).toBe(200);

      // Beta does NOT support soft delete -> 400 Bad Request
      const delB = await app.request('/betas/deleted');
      expect(delB.status).toBe(400);
    });

    test('4.4. Chaining 3 resources with mixed options and serializers', async () => {
      const repoA = new MockAlphaRepository();
      const repoB = new MockBetaRepository();
      const repoG = new MockAlphaRepository(); // using as gamma mock
      const svcA = new ResourceService(repoA, DEFAULT_SERVICE_CONTEXT);
      const svcB = new ResourceService(repoB, DEFAULT_SERVICE_CONTEXT);
      const svcG = new ResourceService(repoG, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono()
        .resource('/a', tableAlpha, svcA, { transform: (a) => ({ customA: a.id }) })
        .resource('/b', tableBeta, svcB, { serialize: (b) => ({ customB: b.id }) })
        .resource('/c', tableGamma, svcG, { toResponse: (g) => ({ customC: g.id }) });

      const itemA = await repoA.create({ title: 'Item A', author: 'A' });
      const itemB = await repoB.create({ label: 'Item B' });
      const itemG = await repoG.create({ title: 'Item G', author: 'G' });

      const resA = await app.request(`/a/${itemA.id}`);
      expect(resA.status).toBe(200);
      expect(((await resA.json()) as { customA: string }).customA).toBe(itemA.id);

      const resB = await app.request(`/b/${itemB.id}`);
      expect(resB.status).toBe(200);
      expect(((await resB.json()) as { customB: number }).customB).toBe(itemB.id);

      const resC = await app.request(`/c/${itemG.id}`);
      expect(resC.status).toBe(200);
      expect(((await resC.json()) as { customC: string }).customC).toBe(itemG.id);
    });

    test('4.5. Fluent chaining continues to accept standard Hono route handlers', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);

      const app = createTestHono()
        .resource('/alphas', tableAlpha, svc)
        .get('/custom-endpoint', (c) => c.text('Hello World'));

      expect((await app.request('/alphas')).status).toBe(200);
      const customRes = await app.request('/custom-endpoint');
      expect(customRes.status).toBe(200);
      expect(await customRes.text()).toBe('Hello World');
    });
  });

  // --------------------------------------------------------------------------
  // 5. CUSTOM SERIALIZER ALIASES: transform, serialize, toResponse
  // --------------------------------------------------------------------------
  describe('5. Custom Serializer Aliases (transform, serialize, toResponse)', () => {
    test('5.1. "transform" projects single items and paginated collections across all endpoints', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route(
        '/alpha',
        resourceRoutes(tableAlpha, svc, {
          transform: (row) => ({
            transformedId: row.id,
            displayTitle: `Transformed: ${row.title}`,
          }),
        }),
      );

      // 1. POST / (create)
      const postRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Original Title', author: 'Author' }),
      });
      expect(postRes.status).toBe(201);
      const created = (await postRes.json()) as { transformedId: string; displayTitle: string };
      expect(created.displayTitle).toBe('Transformed: Original Title');
      expect(created.transformedId).toBeDefined();

      // 2. GET / (list active)
      const listRes = await app.request('/alpha');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { items: Array<{ displayTitle: string }> };
      expect(list.items[0]?.displayTitle).toBe('Transformed: Original Title');

      // 3. GET /:id (show active)
      const showRes = await app.request(`/alpha/${created.transformedId}`);
      expect(showRes.status).toBe(200);
      expect(((await showRes.json()) as { displayTitle: string }).displayTitle).toBe('Transformed: Original Title');

      // 4. PATCH /:id (update)
      const patchRes = await app.request(`/alpha/${created.transformedId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as { displayTitle: string }).displayTitle).toBe('Transformed: Updated Title');

      // 5. DELETE /:id (delete soft)
      await app.request(`/alpha/${created.transformedId}`, { method: 'DELETE' });

      // 6. GET /deleted (list deleted)
      const delListRes = await app.request('/alpha/deleted');
      expect(delListRes.status).toBe(200);
      const delList = (await delListRes.json()) as { items: Array<{ displayTitle: string }> };
      expect(delList.items[0]?.displayTitle).toBe('Transformed: Updated Title');

      // 7. GET /deleted/:id (show deleted)
      const delShowRes = await app.request(`/alpha/deleted/${created.transformedId}`);
      expect(delShowRes.status).toBe(200);
      expect(((await delShowRes.json()) as { displayTitle: string }).displayTitle).toBe('Transformed: Updated Title');

      // 8. POST /:id/restore
      const restoreRes = await app.request(`/alpha/${created.transformedId}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      expect(((await restoreRes.json()) as { displayTitle: string }).displayTitle).toBe('Transformed: Updated Title');

      // 9. PATCH /:id/restore (alias)
      await app.request(`/alpha/${created.transformedId}`, { method: 'DELETE' });
      const patchRestoreRes = await app.request(`/alpha/${created.transformedId}/restore`, { method: 'PATCH' });
      expect(patchRestoreRes.status).toBe(200);
      expect(((await patchRestoreRes.json()) as { displayTitle: string }).displayTitle).toBe(
        'Transformed: Updated Title',
      );
    });

    test('5.2. "serialize" alias works across endpoints', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route(
        '/alpha',
        resourceRoutes(tableAlpha, svc, {
          serialize: (row) => ({
            serializedTag: `TAG-${row.id}`,
            authorUpper: row.author.toUpperCase(),
          }),
        }),
      );

      const postRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Serialize Test', author: 'sarah' }),
      });
      expect(postRes.status).toBe(201);
      const body = (await postRes.json()) as { serializedTag: string; authorUpper: string };
      expect(body.authorUpper).toBe('SARAH');
      expect(body.serializedTag).toContain('TAG-');
    });

    test('5.3. "toResponse" alias works across endpoints', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route(
        '/alpha',
        resourceRoutes(tableAlpha, svc, {
          toResponse: (row) => ({
            responseKey: row.id,
            fixedStatus: 'OK',
          }),
        }),
      );

      const postRes = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'toResponse Test', author: 'tim' }),
      });
      expect(postRes.status).toBe(201);
      const body = (await postRes.json()) as { responseKey: string; fixedStatus: string };
      expect(body.fixedStatus).toBe('OK');
      expect(body.responseKey).toBeDefined();
    });

    test('5.4. Precedence: "transform" takes priority over "serialize"', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route(
        '/alpha',
        resourceRoutes(tableAlpha, svc, {
          transform: () => ({ winner: 'transform' }),
          serialize: () => ({ winner: 'serialize' }),
        }),
      );

      const res = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Precedence 1', author: 'A' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { winner: string };
      expect(body.winner).toBe('transform');
    });

    test('5.5. Precedence: "serialize" takes priority over "toResponse"', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route(
        '/alpha',
        resourceRoutes(tableAlpha, svc, {
          serialize: () => ({ winner: 'serialize' }),
          toResponse: () => ({ winner: 'toResponse' }),
        }),
      );

      const res = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Precedence 2', author: 'B' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { winner: string };
      expect(body.winner).toBe('serialize');
    });

    test('5.6. Default identity serialization returns untransformed full entity when aliases omitted', async () => {
      const repo = new MockAlphaRepository();
      const svc = new ResourceService(repo, DEFAULT_SERVICE_CONTEXT);
      const app = createTestHono().route('/alpha', resourceRoutes(tableAlpha, svc));

      const res = await app.request('/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Identity Test', author: 'Clean' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as AlphaEntity;
      expect(body.id).toBeDefined();
      expect(body.title).toBe('Identity Test');
      expect(body.author).toBe('Clean');
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
      expect(body.deletedAt).toBeNull();
    });
  });
});
