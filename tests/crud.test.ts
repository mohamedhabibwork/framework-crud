import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, defineProvider, EXECUTION_CONTEXT, ExecutionContext, token } from '@framework/core';
import {
  AUDIT_READER,
  Auditable,
  type AuditLogRow,
  AuditReader,
  Creatable,
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  type DatabaseConnection,
  type DataContext,
  Deletable,
  Readable,
  RepositoryCore,
  SoftDeletable,
  TRANSACTION_CONTEXT,
  TransactionContext,
  Updatable,
} from '@framework/database';
import { type DomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { createHttpKernel, type FrameworkEnv, forbidden, resolve } from '@framework/http';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Hono } from 'hono';
import { z } from 'zod/v4';
import { auditRoutes } from '../src/audit-routes';
import { ResourceController } from '../src/controller';
import { csvToObjects, parseCsv } from '../src/csv';
import {
  DataPorter,
  DiskExportStore,
  defineExportJob,
  defineImportJob,
  importExportRoutes,
  LocalExportStore,
  type PorterQueue,
} from '../src/import-export';
import { ownedBy, ResourceService, type ServiceContext } from '../src/service';

const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  price: integer('price').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

type Item = {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly deletedAt: string | null;
};

class ItemRepository extends Auditable(
  SoftDeletable(Updatable(Creatable(Readable(RepositoryCore<typeof items>)))),
  'items',
) {}

const itemCreateSchema = z.object({ name: z.string().min(1), price: z.coerce.number().int().min(0) }).strict();
type ItemCreate = z.output<typeof itemCreateSchema>;

const ITEMS_REPOSITORY = token<ItemRepository>('crud.items-repository');
const ITEMS_SERVICE = token<ItemsService>('crud.items-service');
const ACTOR = { id: 'user-1', type: 'user' } as const;
const bus = new MemoryEventBus();
let events: readonly DomainEvent[] = [];

class ItemsService extends ResourceService<Item, ItemCreate> {
  created: readonly string[] = [];

  /** Exposes the protected transaction orchestration for tests. */
  runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.transaction(work);
  }

  /** Exposes the shared context for wiring assertions. */
  get sharedContext(): ServiceContext {
    return this.context;
  }

  protected override beforeCreate(input: ItemCreate): ItemCreate {
    return { ...input, name: input.name.trim() };
  }

  protected override afterCreate(entity: Item): void {
    this.created = [...this.created, entity.name];
  }

  protected override beforeUpdate(_id: string, changes: Partial<ItemCreate>): Partial<ItemCreate> {
    return changes.name === undefined ? changes : { ...changes, name: changes.name.trim() };
  }
}

let database: TestDatabase;
let connection: DatabaseConnection;
let application: Application<object>;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create extension if not exists "pgcrypto"`;
  await connection.sql`create table items (id uuid primary key default gen_random_uuid(), name text not null, price integer not null default 0, deleted_at timestamptz)`;
  await connection.sql`create table docs (id uuid primary key default gen_random_uuid(), user_id uuid not null, title text not null)`;
  await connection.sql`create table audit_logs (
    id bigserial primary key, resource text not null, resource_id text not null, action text not null,
    actor_id text, actor_type text not null, correlation_id text not null, changes jsonb not null,
    created_at timestamptz not null default now())`;

  const provider = defineProvider<object>({
    name: 'crud-test',
    register({ container }) {
      container.value(DATABASE, connection);
      container.value(EVENT_BUS, bus);
      container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
      container.scoped(DATA_CONTEXT, (r) => ({
        transactions: r.resolve(TRANSACTION_CONTEXT),
        execution: r.resolve(EXECUTION_CONTEXT),
      }));
      container.scoped(AUDIT_READER, (r) => new AuditReader(r.resolve(TRANSACTION_CONTEXT).executor));
      container.scoped(
        ITEMS_REPOSITORY,
        (r) => new ItemRepository(items, r.resolve(DATA_CONTEXT) as DataContext, { softDeleteColumn: items.deletedAt }),
      );
      container.scoped(
        ITEMS_SERVICE,
        (r) =>
          new ItemsService(r.resolve(ITEMS_REPOSITORY), r.resolve(DATA_CONTEXT), {
            channel: 'items',
            bus,
            serialize: (entity) => ({ id: entity.id, name: entity.name, price: entity.price }),
          }),
      );
    },
  });
  application = await new Application({ config: {}, providers: [provider] }).boot();
  await bus.subscribe('items', (event) => {
    events = [...events, event];
  });
});

afterAll(async () => {
  await application?.shutdown().catch(() => undefined);
  await connection?.close();
  await database?.drop();
});

function scope() {
  const created = application.createScope('test');
  created.override(EXECUTION_CONTEXT, new ExecutionContext('test', 'corr-crud', ACTOR));
  return created;
}

describe('ResourceService', () => {
  test('hooks run around operations and entity events are published after commit', async () => {
    events = [];
    const svc = scope().resolve(ITEMS_SERVICE);
    const created = await svc.create({ name: '  gear  ', price: 10 });
    expect(created.name).toBe('gear');
    expect(svc.created).toEqual(['gear']);

    const updated = await svc.update(created.id, { name: ' sprocket ' });
    expect(updated.name).toBe('sprocket');

    await svc.delete(created.id);
    const restored = await svc.restore(created.id);
    expect(restored.name).toBe('sprocket');

    expect(events.map((event) => event.type)).toEqual([
      'items.created',
      'items.updated',
      'items.deleted',
      'items.restored',
    ]);
    const first = events[0];
    expect(first?.payload).toEqual({ id: created.id, name: 'gear', price: 10 });
    expect(events.every((event) => event.correlationId === 'corr-crud' && event.actor.id === 'user-1')).toBe(true);
  });

  test('unknown ids translate to 404 and audit rows are attributed to the actor', async () => {
    const svc = scope().resolve(ITEMS_SERVICE);
    await expect(svc.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const entity = await svc.create({ name: 'audited', price: 1 });
    await svc.update(entity.id, { name: 'audited-2' });
    const reader = scope().resolve(AUDIT_READER);
    const trail = await reader.page({ page: 1, limit: 10 }, { resource: 'items', resourceId: entity.id });
    expect(trail.items.map((row) => row.action)).toEqual(['updated', 'created']);
    expect(trail.items.every((row: AuditLogRow) => row.actorId === 'user-1')).toBe(true);
  });

  test('the shared context flows to the service: actor, correlation id and transactions', async () => {
    const requestScope = scope();
    const svc = requestScope.resolve(ITEMS_SERVICE);
    // Same context object the repository holds: one actor/transaction per scope.
    expect(svc.sharedContext.execution.actor).toEqual(ACTOR);
    expect(svc.sharedContext.execution.correlationId).toBe('corr-crud');
    expect(svc.sharedContext.transactions).toBe(requestScope.resolve(TRANSACTION_CONTEXT));
  });

  test('transaction() joins the scope chain and rolls back on failure', async () => {
    const svc = scope().resolve(ITEMS_SERVICE);
    await svc.create({ name: 'kept', price: 1 });

    await expect(
      svc.runInTransaction(async () => {
        await svc.create({ name: 'rolled-back', price: 2 });
        throw new Error('boom');
      }),
    ).rejects.toMatchObject({ message: 'boom' });

    const page = await svc.list({ page: 1, limit: 100 });
    const names = page.items.map((item) => item.name);
    expect(names).toContain('kept');
    expect(names).not.toContain('rolled-back');
  });

  test('ResourceController serializes items and pages', async () => {
    const svc = scope().resolve(ITEMS_SERVICE);
    const controller = new ResourceController<Item, ItemCreate, Partial<ItemCreate>, { id: string; name: string }>(
      svc,
      (entity) => ({
        id: entity.id,
        name: entity.name,
      }),
    );
    await svc.create({ name: 'one', price: 1 });
    await svc.create({ name: 'two', price: 2 });
    const page = await controller.list({ page: 1, limit: 2 });
    expect(page.items.every((item) => !('price' in item))).toBe(true);
    expect(page.meta.limit).toBe(2);
    const head = page.items[0];
    expect(head).toBeDefined();
    const shown = await controller.show((head as { id: string }).id);
    expect(Object.keys(shown).sort()).toEqual(['id', 'name']);
  });
});

describe('CSV codec', () => {
  test('round-trips quotes, commas, newlines and CRLF', () => {
    const table = parseCsv('name,note\r\n"du,de","say ""hi""\r\nok"\r\nplain,');
    expect(table.columns).toEqual(['name', 'note']);
    expect(table.rows[0]).toEqual(['du,de', 'say "hi"\r\nok']);
    expect(table.rows[1]).toEqual(['plain', '']);
    expect(csvToObjects(table)[0]?.name).toBe('du,de');
  });

  test('rejects unterminated quotes and empty input', () => {
    expect(() => parseCsv('a,b\n"broken')).toThrow();
    expect(() => parseCsv('')).toThrow();
  });
});

describe('import/export jobs', () => {
  const CSV = 'name,price\ngear,10\n,\nbroken,not-a-number';
  const exportDir = join(tmpdir(), `fw-crud-export-${process.pid}-${Date.now()}`);
  const store = new LocalExportStore(exportDir);
  const importJob = defineImportJob({
    resource: 'items',
    repository: ITEMS_REPOSITORY,
    rowSchema: itemCreateSchema,
    columns: ['name', 'price'],
    batchSize: 2,
  });
  const exportJob = defineExportJob({
    resource: 'items',
    repository: ITEMS_REPOSITORY,
    columns: ['id', 'name', 'price'],
    serialize: (entity) => ({ id: entity.id, name: entity.name, price: entity.price }),
    store,
  });

  afterAll(async () => {
    await rm(exportDir, { recursive: true, force: true });
  });

  function jobContext(jobId: string) {
    const created = scope();
    return {
      jobId,
      attempt: 1,
      scope: created,
      execution: created.resolve(EXECUTION_CONTEXT),
      signal: new AbortController().signal,
      progress: async (_percent: number) => {},
    };
  }

  test('import validates rows, inserts valid batches and reports failures', async () => {
    events = [];
    const outcome = await importJob.handle({ resource: 'items', format: 'csv', content: CSV }, jobContext('import-1'));
    expect(outcome.created).toBe(1);
    expect(outcome.failed).toBe(2);
    expect(outcome.errors[0]).toContain('row 3');
    const types = events.map((event) => event.type);
    expect(types).toContain('items.import.started');
    expect(types).toContain('items.import.completed');
  });

  test('import rejects unexpected CSV headers without touching the table', async () => {
    const before = await scope().resolve(ITEMS_REPOSITORY).paginate({ page: 1, limit: 1 });
    await expect(
      importJob.handle({ resource: 'items', format: 'csv', content: 'wrong,header\nx,1' }, jobContext('import-2')),
    ).rejects.toMatchObject({ code: 'IMPORT_HEADER_MISMATCH' });
    const after = await scope().resolve(ITEMS_REPOSITORY).paginate({ page: 1, limit: 1 });
    expect(after.meta.total).toBe(before.meta.total);
  });

  test('export streams batches into CSV and JSON artifacts held by the store', async () => {
    const csvOutcome = await exportJob.handle({ resource: 'items', format: 'csv' }, jobContext('export-1'));
    expect(csvOutcome.rows).toBeGreaterThanOrEqual(1);
    const csv = await store.fetch('export-1');
    expect(csv?.name.endsWith('.csv')).toBe(true);
    const table = parseCsv(csv?.content ?? '');
    expect(table.columns).toEqual(['id', 'name', 'price']);
    expect(table.rows.length).toBe(csvOutcome.rows);

    const jsonOutcome = await exportJob.handle({ resource: 'items', format: 'json' }, jobContext('export-2'));
    const json = await store.fetch('export-2');
    expect(JSON.parse(json?.content ?? '[]')).toHaveLength(jsonOutcome.rows);
  });
});

describe('audit and data endpoints over HTTP', () => {
  const refusingQueue: PorterQueue = {
    // Never reached in these tests: every dispatch path fails earlier (404/422).
    async dispatch() {
      throw new Error('dispatch must not be called by these tests');
    },
    async status() {
      return null;
    },
  };

  test('audit trail list, filters, entry lookup and validation', async () => {
    const http: Hono<FrameworkEnv> = createHttpKernel(application, { exposeInternalErrors: false }).route(
      '/audit',
      auditRoutes({ authorize: 'public' }),
    );
    expect((await http.request('/audit?resource=items&limit=5')).status).toBe(200);
    expect((await http.request('/audit?resource=items&action=updated')).status).toBe(200);
    expect((await http.request('/audit?resource=')).status).toBe(422);
    expect((await http.request('/audit?action=nonsense')).status).toBe(422);
    expect((await http.request('/audit/99999999')).status).toBe(404);

    const entry = (await scope().resolve(AUDIT_READER).page({ page: 1, limit: 1 }, { resource: 'items' })).items[0];
    expect(entry).toBeDefined();
    expect((await http.request(`/audit/${(entry as AuditLogRow).id}`)).status).toBe(200);
  });

  test('data endpoints validate input, refuse unknown resources/artifacts', async () => {
    const porter = new DataPorter({
      queue: refusingQueue,
      store: new LocalExportStore(join(tmpdir(), 'fw-crud-none')),
      imports: [],
      exports: [],
    });
    const http: Hono<FrameworkEnv> = createHttpKernel(application, { exposeInternalErrors: false }).route(
      '/data',
      importExportRoutes({
        porter: () => porter,
        execution: (c) => resolve(c, EXECUTION_CONTEXT),
        authorize: 'public',
      }),
    );
    expect(
      (
        await http.request('/data/import', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await http.request('/data/import', {
          method: 'POST',
          body: JSON.stringify({ resource: 'items', format: 'csv', content: 'a\n1' }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(404);
    expect((await http.request('/data/export/download/unknown-job')).status).toBe(404);
    expect((await http.request('/data/import/status/bad id!')).status).toBe(422);
    await rm(join(tmpdir(), 'fw-crud-none'), { recursive: true, force: true });
  });

  test('mount-time guards deny before validation (403 beats 422) and allow on pass', async () => {
    const deny = () => {
      throw forbidden('denied by test guard');
    };
    const porter = new DataPorter({
      queue: refusingQueue,
      store: new LocalExportStore(join(tmpdir(), 'fw-crud-guard')),
      imports: [],
      exports: [],
    });
    const http: Hono<FrameworkEnv> = createHttpKernel(application, { exposeInternalErrors: false })
      .route('/audit', auditRoutes({ authorize: deny }))
      .route(
        '/data',
        importExportRoutes({
          porter: () => porter,
          execution: (c) => resolve(c, EXECUTION_CONTEXT),
          authorize: deny,
        }),
      );
    // Guard runs before validation, so these would be 422/404 unguarded.
    expect((await http.request('/audit?resource=')).status).toBe(403);
    expect((await http.request('/audit/99999999')).status).toBe(403);
    expect((await http.request('/data/export/download/whatever')).status).toBe(403);
    expect(
      (
        await http.request('/data/import', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(403);

    const allowed = createHttpKernel(application, { exposeInternalErrors: false })
      .route('/audit', auditRoutes({ authorize: () => {} }))
      .route(
        '/data',
        importExportRoutes({
          porter: () => porter,
          execution: (c) => resolve(c, EXECUTION_CONTEXT),
          authorize: () => {},
        }),
      );
    expect((await allowed.request('/audit?resource=items&limit=1')).status).toBe(200);
    expect((await allowed.request('/data/export/download/unknown-job')).status).toBe(404);
    await rm(join(tmpdir(), 'fw-crud-guard'), { recursive: true, force: true });
  });
});

describe('ownership (ownedBy row scoping)', () => {
  const docs = pgTable('docs', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
  });

  type Doc = {
    readonly id: string;
    readonly userId: string;
    readonly title: string;
  };

  type DocCreate = {
    readonly title: string;
  };

  class DocsRepository extends Deletable(Updatable(Creatable(Readable(RepositoryCore<typeof docs>)))) {}
  class DocsService extends ResourceService<Doc, DocCreate> {}

  const ALICE_ID = '11111111-1111-4111-8111-111111111111';
  // Lazily built: `connection` only exists after beforeAll.
  const asUser = (id: string | null) => ({
    execution: new ExecutionContext('request', 'corr-own', { id, type: id ? 'user' : 'anonymous' }),
    transactions: new TransactionContext(connection.db),
  });

  const ownedService = (id: string | null) => {
    const scope = asUser(id);
    return new DocsService(new DocsRepository(docs, scope), scope, { ownership: ownedBy('userId') });
  };

  test('creates stamp the acting user as the owner; listings only show their rows', async () => {
    const aliceDocs = ownedService(ALICE_ID);
    const bobDocs = ownedService('22222222-2222-4222-8222-222222222222');

    const mine = await aliceDocs.create({ title: 'alice doc' });
    expect(mine.userId).toBe(ALICE_ID);
    await aliceDocs.create({ title: 'alice doc 2' });

    const alicePage = await aliceDocs.list({ page: 1, limit: 10 });
    expect(alicePage.items.length).toBe(2);
    expect(alicePage.items.every((doc) => doc.userId === ALICE_ID)).toBe(true);
    expect((await bobDocs.list({ page: 1, limit: 10 })).items).toEqual([]);
  });

  test("another owner's row is 404 for get, update and delete", async () => {
    const aliceDocs = ownedService(ALICE_ID);
    const bobDocs = ownedService('22222222-2222-4222-8222-222222222222');
    const foreign = (await aliceDocs.list({ page: 1, limit: 1 })).items[0];
    if (!foreign) throw new Error('expected a seeded row');
    const foreignId = foreign.id;

    await expect(bobDocs.get(foreignId)).rejects.toMatchObject({ status: 404 });
    await expect(bobDocs.update(foreignId, { title: 'hijacked' })).rejects.toMatchObject({ status: 404 });
    await expect(bobDocs.delete(foreignId)).rejects.toMatchObject({ status: 404 });
    // The row survived all three attempts untouched.
    expect((await aliceDocs.get(foreignId)).title).not.toBe('hijacked');
  });

  test('a scope without a user id sees nothing and cannot create owned rows', async () => {
    const anonymous = ownedService(null);
    expect((await anonymous.list({ page: 1, limit: 10 })).items).toEqual([]);
    await expect(anonymous.create({ title: 'ghost' })).rejects.toMatchObject({ code: 'OWNERSHIP_ACTOR_MISSING' });
  });

  test('import stamps every row with the acting user', async () => {
    const aliceDocs = ownedService(ALICE_ID);
    const summary = await aliceDocs.import([{ title: 'imported 1' }, { title: 'imported 2' }]);
    expect(summary.created).toBe(2);
    const page = await aliceDocs.list({ page: 1, limit: 10 });
    expect(page.items.filter((doc) => doc.title.startsWith('imported'))).toHaveLength(2);
  });
});

describe('DiskExportStore (multi-node artifacts)', () => {
  /** In-memory stand-in for any @framework/storage disk. */
  const memoryDisk = () => {
    const objects = new Map<string, string>();
    return {
      objects,
      put: async (path: string, data: string | Uint8Array) => {
        objects.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      get: async (path: string) => ({ content: new TextEncoder().encode(objects.get(path) ?? '') }),
      exists: async (path: string) => objects.has(path),
    };
  };

  test('write then fetch round-trips through one object key; unknown ids are null', async () => {
    const disk = memoryDisk();
    const store = new DiskExportStore(disk);
    await store.write('export-9', 'products.csv', 'id,name\n1,thing');

    expect(disk.objects.size).toBe(1); // one key: name rides inside the artifact
    expect(await store.fetch('export-9')).toEqual({ name: 'products.csv', content: 'id,name\n1,thing' });
    expect(await store.fetch('export-unknown')).toBeNull();
  });

  test('a malformed artifact fails with a catalogued error', async () => {
    const disk = memoryDisk();
    await disk.put('exports/broken.json', '{not json');
    await expect(new DiskExportStore(disk).fetch('broken')).rejects.toMatchObject({ code: 'EXPORT_ARTIFACT_INVALID' });
  });
});
