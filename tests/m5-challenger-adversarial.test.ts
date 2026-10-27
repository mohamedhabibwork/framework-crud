import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Container, ExecutionContext, type JsonObject } from '@framework/core';
import {
  baseRepository,
  Creatable,
  createConnection,
  DATA_CONTEXT,
  type DatabaseConnection,
  type DataContext,
  RepositoryCore,
  type SelectOf,
  SoftDeletable,
  TransactionContext,
} from '@framework/database';
import { type FrameworkEnv, installErrorHandling } from '@framework/http';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { eq } from 'drizzle-orm';
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { resolveDefinition } from '../../cli/src/generators/crud/generate';
import { ResourceService, resourceRoutes } from '../src';

// 1. Table with custom soft-delete column (archived_at instead of deleted_at)
const customDocsTable = pgTable('adv_custom_docs', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
});

// 2. Table with composite primary key (tenant_id + item_id, NO column named 'id')
const compositeTable = pgTable('adv_composite_items', {
  tenantId: integer('tenant_id').notNull(),
  itemId: integer('item_id').notNull(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

// 3. Table for concurrent restore testing
const raceTable = pgTable('adv_race_items', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 6 });
  await connection.sql`create table adv_custom_docs (id serial primary key, title text not null, archived_at timestamptz)`;
  await connection.sql`create table adv_composite_items (tenant_id int not null, item_id int not null, name text not null, deleted_at timestamptz, primary key (tenant_id, item_id))`;
  await connection.sql`create table adv_race_items (id serial primary key, name text not null, deleted_at timestamptz)`;
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

const makeDataContext = (actorId = 'user-1'): DataContext => ({
  transactions: new TransactionContext(connection.db),
  execution: new ExecutionContext('test', 'corr-adversarial', { id: actorId, type: 'user' }),
});

function createHonoWithScope(setupRoutes: (app: Hono<FrameworkEnv>, container: Container) => void) {
  const container = new Container();
  const ctx = makeDataContext();
  container.value(DATA_CONTEXT, ctx);

  const server = new Hono<FrameworkEnv>();
  installErrorHandling(server, { exposeInternalErrors: true });
  server.use('*', async (c, next) => {
    const scope = container.createScope('request');
    c.set('scope', scope);
    await next();
  });

  setupRoutes(server, container);
  return { server, container, ctx };
}

describe('Challenger M5 Adversarial Coverage & Boundary Suite', () => {
  // =========================================================================
  // ATTACK SURFACE 1: Custom soft-delete column with router.resource / resourceRoutes
  // =========================================================================
  describe('Custom soft-delete column name (archivedAt) via router.resource / resourceRoutes', () => {
    test('resourceRoutes mounts soft-delete endpoints when softDeleteColumn is passed', async () => {
      const { server } = createHonoWithScope((app) => {
        app.route('/docs', resourceRoutes(customDocsTable, { softDeleteColumn: customDocsTable.archivedAt }));
      });

      // Create a doc directly in DB
      const [doc] = await connection.db.insert(customDocsTable).values({ title: 'Active Doc 1' }).returning();
      if (!doc) throw new Error('Failed to insert doc');

      // Soft-delete it by setting archived_at
      await connection.db
        .update(customDocsTable)
        .set({ archivedAt: new Date().toISOString() })
        .where(eq(customDocsTable.id, doc.id));

      // Because resourceRoutes forwards options.softDeleteColumn to baseService,
      // baseService initializes BaseSoftDeletableRepository with custom soft-delete column!
      // Thus GET /docs/deleted succeeds with 200:
      const listRes = await server.request('/docs/deleted');
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { items: Array<{ id: number; title: string }> };
      expect(listBody.items.length).toBeGreaterThanOrEqual(1);

      // And POST /docs/:id/restore succeeds with 200:
      const restoreRes = await server.request(`/docs/${doc.id}/restore`, { method: 'POST' });
      expect(restoreRes.status).toBe(200);
      const restoreBody = (await restoreRes.json()) as { id: number; title: string; archivedAt: string | null };
      expect(restoreBody.id).toBe(doc.id);
      expect(restoreBody.archivedAt).toBeNull();
    });

    test('DELETE /:id on custom softDeleteColumn performs soft delete instead of physical hard delete', async () => {
      const { server } = createHonoWithScope((app) => {
        app.route('/docs', resourceRoutes(customDocsTable, { softDeleteColumn: customDocsTable.archivedAt }));
      });

      const [doc] = await connection.db.insert(customDocsTable).values({ title: 'To Soft Delete' }).returning();
      if (!doc) throw new Error('Failed to insert doc');

      // Call DELETE /docs/:id
      const delRes = await server.request(`/docs/${doc.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      // The row was soft-deleted: retained in PostgreSQL with archived_at populated!
      const rawRows = (await connection.sql`select * from adv_custom_docs where id = ${doc.id}`) as Array<{
        id: number;
        title: string;
        archived_at: string | null;
      }>;
      expect(rawRows.length).toBe(1);
      expect(rawRows[0]?.archived_at).not.toBeNull();
    });
  });

  // =========================================================================
  // ATTACK SURFACE 2: Composite Primary Keys or Tables without 'id'
  // =========================================================================
  describe('Composite primary keys / Tables without standard single-column id', () => {
    test('SoftDeletable repository throws or fails cleanly on table without id column', async () => {
      const ctx = makeDataContext();

      class CompositeRepo extends SoftDeletable(RepositoryCore<typeof customDocsTable>) {}
      const repo = new CompositeRepo(compositeTable as unknown as typeof customDocsTable, ctx, {
        softDeleteColumn: compositeTable.deletedAt,
      });

      let error: unknown;
      try {
        await repo.delete(1);
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
    });
  });

  // =========================================================================
  // ATTACK SURFACE 3: Auditing & Change Tracking in restoreMany
  // =========================================================================
  describe('Auditing and Change Tracking in restoreMany vs deleteMany', () => {
    test('Track afterWrite invocations on deleteMany vs restoreMany', async () => {
      const ctx = makeDataContext();
      const afterWriteEvents: Array<{ action: string; id: unknown }> = [];

      class AuditedSoftRepo extends SoftDeletable(Creatable(RepositoryCore<typeof raceTable>)) {
        protected override get tracksChanges(): boolean {
          return true;
        }
        protected override async afterWrite(change: { action: string; id: unknown }): Promise<void> {
          afterWriteEvents.push(change);
        }
      }

      const repo = new AuditedSoftRepo(raceTable, ctx, { softDeleteColumn: raceTable.deletedAt });

      const r1 = await repo.create({ name: 'Tracked 1' });
      await repo.create({ name: 'Tracked 2' });

      // deleteMany triggers afterWrite for each deleted row
      await repo.deleteMany({ filters: [eq(raceTable.name, 'Tracked 1')] });
      const deleteEvents = afterWriteEvents.filter((e) => e.action === 'deleted');
      expect(deleteEvents.length).toBe(1);
      expect(deleteEvents[0]?.id).toBe(r1.id);

      // Now restoreMany invokes afterWrite for each restored row
      await repo.restoreMany({ filters: [eq(raceTable.name, 'Tracked 1')] });
      const restoreEvents = afterWriteEvents.filter((e) => e.action === 'restored');
      expect(restoreEvents.length).toBe(1);
      expect(restoreEvents[0]?.id).toBe(r1.id);
    });
  });

  // =========================================================================
  // ATTACK SURFACE 4: Concurrent restore and transaction safety
  // =========================================================================
  describe('Concurrent restore and transaction safety', () => {
    test('Two concurrent restore calls on the same soft-deleted row: exactly one 200, one 404', async () => {
      const { server } = createHonoWithScope((app) => {
        app.route('/race', resourceRoutes(raceTable));
      });

      // Create and soft-delete a row
      const [item] = await connection.db
        .insert(raceTable)
        .values({ name: 'Race Item', deletedAt: new Date().toISOString() })
        .returning();
      if (!item) throw new Error('Failed to insert race item');

      // Fire 2 concurrent restore requests simultaneously
      const [res1, res2] = await Promise.all([
        server.request(`/race/${item.id}/restore`, { method: 'POST' }),
        server.request(`/race/${item.id}/restore`, { method: 'POST' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 404]);

      const successRes = res1.status === 200 ? res1 : res2;
      const failedRes = res1.status === 404 ? res1 : res2;

      const successBody = (await successRes.json()) as { id: number; deletedAt: string | null };
      expect(successBody.id).toBe(item.id);
      expect(successBody.deletedAt).toBeNull();

      const failedBody = (await failedRes.json()) as { error: { code: string } };
      expect(failedBody.error.code).toBe('NOT_FOUND');
    });

    test('Restore transaction rollback when an error occurs during restore pipeline', async () => {
      const ctx = makeDataContext();
      const repo = baseRepository(raceTable, ctx);

      // Create and delete item
      const item = await repo.create({ name: 'Rollback Item' });
      await repo.delete(item.id);
      expect(await (repo as { findDeletedById(id: number): Promise<unknown> }).findDeletedById(item.id)).not.toBeNull();

      // Custom service that fails after restore
      type RaceRow = SelectOf<typeof raceTable>;
      class FailingService extends ResourceService<RaceRow, JsonObject, Partial<JsonObject>> {
        protected override async afterRestore(): Promise<void> {
          throw new Error('Simulated failure during afterRestore');
        }
      }

      const service = new FailingService(repo, ctx);

      // Attempt restore — must fail and roll back
      await expect(service.restore(item.id)).rejects.toThrow('Simulated failure during afterRestore');

      // The item MUST still be soft-deleted in the database!
      const stillDeleted = await (repo as { findDeletedById(id: number): Promise<RaceRow | null> }).findDeletedById(
        item.id,
      );
      expect(stillDeleted).not.toBeNull();
      expect(stillDeleted?.deletedAt).not.toBeNull();
      expect(await repo.findById(item.id)).toBeNull();
    });
  });

  // =========================================================================
  // ATTACK SURFACE 5: CLI Generator under combinations of options
  // =========================================================================
  describe('CLI generator option combinations & constraints', () => {
    const fakeContext = {
      root: '/fake/root',
      project: {
        apiPrefix: '/api/v1',
        paths: {
          modules: 'app/modules',
          schemaDir: 'database/schema',
          schemaIndex: 'database/schema/index.ts',
          factories: 'tests/factories',
          migrations: 'database/migrations',
          apiRoutes: 'bootstrap/routes.ts',
          providers: 'bootstrap/providers.ts',
          middleware: 'bootstrap/middleware.ts',
          openapi: 'bootstrap/openapi.ts',
          config: 'config/index.ts',
          testSupport: 'tests/support.ts',
        },
      },
      prompt: () => Promise.resolve('mocked'),
      print: () => {},
    } as unknown as Parameters<typeof resolveDefinition>[0];

    test('CLI rejects --primary-key when not "id"', async () => {
      await expect(
        resolveDefinition(fakeContext, {
          resource: 'Widget',
          fields: 'name:text:required',
          softDelete: false,
          access: 'public',
          primaryKey: 'uuid',
        }),
      ).rejects.toThrow('Only a primary key named "id" is supported');

      await expect(
        resolveDefinition(fakeContext, {
          resource: 'Widget',
          fields: 'name:text:required',
          softDelete: false,
          access: 'public',
          primaryKey: 'number',
        }),
      ).rejects.toThrow('Only a primary key named "id" is supported');
    });

    test('CLI accepts --primary-key="id"', async () => {
      const def = await resolveDefinition(fakeContext, {
        resource: 'Widget',
        fields: 'name:text:required',
        softDelete: true,
        access: 'public',
        primaryKey: 'id',
      });
      expect(def.primaryKey).toBe('uuid');
      expect(def.softDelete).toBe(true);
      expect(def.access).toBe('public');
    });
  });
});
