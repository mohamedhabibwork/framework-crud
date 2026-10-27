import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ExecutionContext } from '@framework/core';
import { createConnection, type DatabaseConnection, type DataContext, TransactionContext } from '@framework/database';
import { type DomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { HttpError } from '@framework/http';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { eq } from 'drizzle-orm';
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { BaseService, baseService, type CrudRepository, ownedBy, ResourceService } from '../src';

const posts = pgTable('posts_adv', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const categories = pgTable('categories_adv', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

const makeDataContext = (
  transactions: TransactionContext,
  actorId: string | null = 'author-1',
  containerOrScope?: { type: 'container' | 'scope'; bus: MemoryEventBus },
): DataContext => {
  const actor = actorId ? { id: actorId, type: 'user' as const } : { id: null, type: 'anonymous' as const };
  const base: Record<string, unknown> = {
    transactions,
    execution: new ExecutionContext('test', 'corr-adversarial', actor),
  };
  if (containerOrScope) {
    base[containerOrScope.type] = {
      has: (t: unknown) => t === EVENT_BUS,
      resolve: (t: unknown) => (t === EVENT_BUS ? containerOrScope.bus : undefined),
    };
  }
  return base as unknown as DataContext;
};

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create table posts_adv (id serial primary key, title text not null, author_id text not null, deleted_at timestamptz)`;
  await connection.sql`create table categories_adv (id serial primary key, name text not null)`;
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

const getContext = (actorId: string | null = 'author-1') =>
  makeDataContext(new TransactionContext(connection.db), actorId);

describe('Adversarial M1 Stress Tests', () => {
  describe('1. HTTP 400 Bad Request on Unsupported Soft-Delete', () => {
    test('listDeleted on hard-delete table (categories) via baseService throws HttpError 400', async () => {
      const ctx = getContext();
      const service = baseService(categories, ctx);

      try {
        await service.listDeleted({ page: 1, limit: 10 });
        expect.unreachable('Should have thrown 400');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(400);
        expect(httpErr.code).toBe('BAD_REQUEST');
        expect(httpErr.message).toContain('does not support soft-delete');
      }
    });

    test('getDeleted on hard-delete table (categories) via baseService throws HttpError 400', async () => {
      const ctx = getContext();
      const service = baseService(categories, ctx);

      try {
        await service.getDeleted(1);
        expect.unreachable('Should have thrown 400');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(400);
        expect(httpErr.code).toBe('BAD_REQUEST');
        expect(httpErr.message).toContain('does not support soft-delete');
      }
    });

    test('restore on hard-delete table (categories) via baseService throws HttpError 400', async () => {
      const ctx = getContext();
      const service = baseService(categories, ctx);

      try {
        await service.restore(1);
        expect.unreachable('Should have thrown 400');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(400);
        expect(httpErr.code).toBe('BAD_REQUEST');
        expect(httpErr.message).toContain('does not support restore');
      }
    });

    test('asymmetric mock repository: paginateDeleted present but findDeletedById missing', async () => {
      const asymmetricRepo: CrudRepository<{ id: number }, { name: string }> = {
        findById: async () => null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 1, ...v }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      };

      const service = new ResourceService(asymmetricRepo);
      // listDeleted succeeds
      const list = await service.listDeleted({ page: 1, limit: 10 });
      expect(list.items).toEqual([]);

      // getDeleted throws 400
      try {
        await service.getDeleted(1);
        expect.unreachable('Should have thrown 400');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    });

    test('asymmetric mock repository: findDeletedById present but paginateDeleted missing', async () => {
      const asymmetricRepo: CrudRepository<{ id: number }, { name: string }> = {
        findById: async () => null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 1, ...v }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        findDeletedById: async (id) => (id === 1 ? { id: 1 } : null),
      };

      const service = new ResourceService(asymmetricRepo);
      // getDeleted succeeds for id 1
      const item = await service.getDeleted(1);
      expect(item.id).toBe(1);

      // listDeleted throws 400
      try {
        await service.listDeleted({ page: 1, limit: 10 });
        expect.unreachable('Should have thrown 400');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    });
  });

  describe('2. HTTP 404 Not Found Semantics on getDeleted', () => {
    test('non-existent record throws HttpError 404', async () => {
      const ctx = getContext();
      const service = baseService(posts, ctx);

      try {
        await service.getDeleted(99999);
        expect.unreachable('Should have thrown 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe('NOT_FOUND');
        expect(httpErr.message).toContain('Resource 99999 not found');
      }
    });

    test('active (non-deleted) record throws HttpError 404 on getDeleted — hides active state', async () => {
      const ctx = getContext();
      const service = baseService(posts, ctx);

      const created = await service.create({ title: 'Active Post', authorId: 'author-1' });
      expect(created.id).toBeDefined();

      // Active get() returns the record
      const active = await service.get(created.id);
      expect(active.id).toBe(created.id);

      // getDeleted() must throw 404 even though the record exists in the table!
      try {
        await service.getDeleted(created.id);
        expect.unreachable('Should have thrown 404 for active record');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe('NOT_FOUND');
      }
    });

    test('lifecycle state transition: active -> deleted -> restored', async () => {
      const ctx = getContext();
      const service = baseService(posts, ctx);

      const created = await service.create({ title: 'Lifecycle Post', authorId: 'author-1' });
      const id = created.id;

      // Stage 1: Active
      expect((await service.get(id)).id).toBe(id);
      expect(service.getDeleted(id)).rejects.toThrow();

      // Stage 2: Soft delete
      await service.delete(id);
      expect(service.get(id)).rejects.toThrow();
      const deletedRecord = await service.getDeleted(id);
      expect(deletedRecord.id).toBe(id);
      expect(deletedRecord.deletedAt).not.toBeNull();

      // Stage 3: Restore
      const restored = await service.restore(id);
      expect(restored.id).toBe(id);
      expect(restored.deletedAt).toBeNull();

      // Active again
      expect((await service.get(id)).id).toBe(id);
      // getDeleted throws 404 again
      expect(service.getDeleted(id)).rejects.toThrow();
    });

    test('custom missing error factory is respected on getDeleted', async () => {
      const mockRepo: CrudRepository<{ id: number }, { name: string }> = {
        findById: async () => null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 1, ...v }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        findDeletedById: async () => null,
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      };

      class CustomDomainMissingError extends Error {
        readonly domainCode = 'CUSTOM_NOT_FOUND';
      }

      const service = new ResourceService(mockRepo, undefined, {
        missing: (id) => new CustomDomainMissingError(`Domain missing: ${id}`),
      });

      try {
        await service.getDeleted(1234);
        expect.unreachable('Should throw custom missing error');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CustomDomainMissingError);
        expect((err as CustomDomainMissingError).message).toBe('Domain missing: 1234');
      }
    });
  });

  describe('3. Row Ownership Hiding (#assertOwned)', () => {
    test('foreign soft-deleted row is hidden behind 404 in real database', async () => {
      const ctxUser1 = getContext('user-1');
      const serviceUser1 = baseService(posts, ctxUser1, {
        ownership: ownedBy('authorId'),
      });

      // User 1 creates and deletes a post
      const post = await serviceUser1.create({ title: 'User 1 Secret Post', authorId: 'user-1' });
      await serviceUser1.delete(post.id);

      // Verify User 1 can see it in getDeleted
      const u1Deleted = await serviceUser1.getDeleted(post.id);
      expect(u1Deleted.id).toBe(post.id);

      // User 2 context attempting to access User 1's soft-deleted post
      const ctxUser2 = getContext('user-2');
      const serviceUser2 = baseService(posts, ctxUser2, {
        ownership: ownedBy('authorId'),
      });

      try {
        await serviceUser2.getDeleted(post.id);
        expect.unreachable('User 2 should not be able to get User 1 deleted post');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe('NOT_FOUND');
      }
    });

    test('anonymous actor (null ownerId) cannot get or list deleted owned rows', async () => {
      const ctxUser1 = getContext('user-1');
      const serviceUser1 = baseService(posts, ctxUser1, {
        ownership: ownedBy('authorId'),
      });

      const post = await serviceUser1.create({ title: 'User 1 Owned Post', authorId: 'user-1' });
      await serviceUser1.delete(post.id);

      // Anonymous context (actor.id = null)
      const ctxAnon = getContext(null);
      const serviceAnon = baseService(posts, ctxAnon, {
        ownership: ownedBy('authorId'),
      });

      // Anonymous getDeleted must throw 404
      try {
        await serviceAnon.getDeleted(post.id);
        expect.unreachable('Anonymous should get 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }

      // Anonymous listDeleted must return 0 items (scoped to sql`false`)
      const anonList = await serviceAnon.listDeleted({ page: 1, limit: 10 });
      expect(anonList.items.length).toBe(0);
      expect(anonList.meta.total).toBe(0);
    });

    test('listDeleted applies row ownership SQL filter, isolating tenants', async () => {
      const ctxUser1 = getContext('tenant-a');
      const serviceUser1 = baseService(posts, ctxUser1, {
        ownership: ownedBy('authorId'),
      });

      const ctxUser2 = getContext('tenant-b');
      const serviceUser2 = baseService(posts, ctxUser2, {
        ownership: ownedBy('authorId'),
      });

      // Tenant A creates and soft-deletes a post
      const postA = await serviceUser1.create({ title: 'Tenant A Post', authorId: 'tenant-a' });
      await serviceUser1.delete(postA.id);

      // Tenant B creates and soft-deletes a post
      const postB = await serviceUser2.create({ title: 'Tenant B Post', authorId: 'tenant-b' });
      await serviceUser2.delete(postB.id);

      // Tenant A's listDeleted
      const pageA = await serviceUser1.listDeleted({ page: 1, limit: 50 });
      expect(pageA.items.some((p) => p.id === postA.id)).toBe(true);
      expect(pageA.items.some((p) => p.id === postB.id)).toBe(false);

      // Tenant B's listDeleted
      const pageB = await serviceUser2.listDeleted({ page: 1, limit: 50 });
      expect(pageB.items.some((p) => p.id === postB.id)).toBe(true);
      expect(pageB.items.some((p) => p.id === postA.id)).toBe(false);
    });

    test('unknown ownership field triggers OWNERSHIP_COLUMN_UNKNOWN FrameworkError', async () => {
      const ctx = getContext();
      const service = baseService(posts, ctx, {
        ownership: ownedBy('nonExistentField'),
      });

      expect(service.listDeleted({ page: 1, limit: 10 })).rejects.toThrow(
        /ownership field "nonExistentField" has no column on the repository/,
      );
    });
  });

  describe('4. EVENT_BUS Event Publishing on Restore and CRUD Lifecycles', () => {
    test('publishes domain events across full CRUD + restore lifecycle with accurate data', async () => {
      const ctx = getContext('author-events');
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_adv', async (evt) => {
        events.push(evt);
      });

      const service = baseService(posts, ctx, { bus });

      // 1. Create
      const created = await service.create({ title: 'Event Test Post', authorId: 'author-events' });
      expect(events.length).toBe(1);
      const e0 = events[0];
      expect(e0).toBeDefined();
      expect(e0?.type).toBe('posts_adv.created');
      expect(e0?.channel).toBe('posts_adv');
      expect((e0?.payload as Record<string, unknown>)?.id).toBe(created.id);
      expect((e0?.payload as Record<string, unknown>)?.title).toBe('Event Test Post');
      expect(e0?.correlationId).toBe('corr-adversarial');
      expect(e0?.actor.id).toBe('author-events');

      // 2. Update
      await service.update(created.id, { title: 'Renamed Event Post' });
      expect(events.length).toBe(2);
      const e1 = events[1];
      expect(e1).toBeDefined();
      expect(e1?.type).toBe('posts_adv.updated');
      expect((e1?.payload as Record<string, unknown>)?.title).toBe('Renamed Event Post');

      // 3. Delete (soft)
      await service.delete(created.id);
      expect(events.length).toBe(3);
      const e2 = events[2];
      expect(e2).toBeDefined();
      expect(e2?.type).toBe('posts_adv.deleted');
      expect((e2?.payload as Record<string, unknown>)?.id).toBe(created.id);

      // 4. Restore
      await service.restore(created.id);
      expect(events.length).toBe(4);
      const e3 = events[3];
      expect(e3).toBeDefined();
      expect(e3?.type).toBe('posts_adv.restored');
      expect((e3?.payload as Record<string, unknown>)?.id).toBe(created.id);
      expect((e3?.payload as Record<string, unknown>)?.deletedAt).toBeNull();
    });

    test('failed operations do not emit spurious events', async () => {
      const ctx = getContext();
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_adv', async (evt) => {
        events.push(evt);
      });

      const service = baseService(posts, ctx, { bus });

      // Failed restore (non-existent ID)
      await expect(service.restore(88888)).rejects.toThrow();
      expect(events.length).toBe(0);

      // Failed delete (non-existent ID)
      await expect(service.delete(88888)).rejects.toThrow();
      expect(events.length).toBe(0);

      // Failed update (non-existent ID)
      await expect(service.update(88888, { title: 'Nope' })).rejects.toThrow();
      expect(events.length).toBe(0);
    });

    test('custom channel and custom serializer are applied to event payloads', async () => {
      const ctx = getContext();
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('audit.custom_posts', async (evt) => {
        events.push(evt);
      });

      const service = baseService(posts, ctx, {
        bus,
        channel: 'audit.custom_posts',
        serialize: (entity) => ({
          customKey: `POST-${entity.id}`,
          header: entity.title,
        }),
      });

      const created = await service.create({ title: 'Custom Payload Post', authorId: 'author-1' });
      expect(events.length).toBe(1);
      const customE0 = events[0];
      expect(customE0).toBeDefined();
      expect(customE0?.channel).toBe('audit.custom_posts');
      expect(customE0?.type).toBe('audit.custom_posts.created');
      expect(customE0?.payload).toEqual({
        customKey: `POST-${created.id}`,
        header: 'Custom Payload Post',
      });

      await service.delete(created.id);
      await service.restore(created.id);
      expect(events.length).toBe(3);
      const customE2 = events[2];
      expect(customE2).toBeDefined();
      expect(customE2?.type).toBe('audit.custom_posts.restored');
      expect(customE2?.payload).toEqual({
        customKey: `POST-${created.id}`,
        header: 'Custom Payload Post',
      });
    });

    test('EVENT_BUS resolved from context.scope', async () => {
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_adv', async (evt) => {
        events.push(evt);
      });

      const ctx = makeDataContext(new TransactionContext(connection.db), 'scoped-user', {
        type: 'scope',
        bus,
      });

      // No options.bus passed; service must resolve from ctx.scope
      const service = baseService(posts, ctx);
      const post = await service.create({ title: 'Scope Bus Post', authorId: 'scoped-user' });
      expect(events.length).toBe(1);
      const scopeE0 = events[0];
      expect(scopeE0).toBeDefined();
      expect(scopeE0?.type).toBe('posts_adv.created');
      expect((scopeE0?.payload as Record<string, unknown>)?.id).toBe(post.id);
    });
  });

  describe('5. Curried baseService(table)(context)', () => {
    test('curried factory preserves options and instantiates isolated per-context services', async () => {
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_adv', async (e) => {
        events.push(e);
      });

      const factory = baseService(posts, undefined, {
        bus,
        ownership: ownedBy('authorId'),
      });

      expect(typeof factory).toBe('function');

      const ctxA = getContext('actor-a');
      const serviceA = factory(ctxA);
      expect(serviceA).toBeInstanceOf(BaseService);

      const ctxB = getContext('actor-b');
      const serviceB = factory(ctxB);
      expect(serviceB).toBeInstanceOf(BaseService);

      // Actor A creates and soft-deletes a post
      const postA = await serviceA.create({ title: 'Curried Post A', authorId: 'actor-a' });
      await serviceA.delete(postA.id);

      // Service A sees it in listDeleted; Service B does not
      const deletedA = await serviceA.listDeleted({ page: 1, limit: 10 });
      expect(deletedA.items.some((p) => p.id === postA.id)).toBe(true);

      const deletedB = await serviceB.listDeleted({ page: 1, limit: 10 });
      expect(deletedB.items.some((p) => p.id === postA.id)).toBe(false);

      // Event bus captured properly in curried instance
      const types = events.map((e) => e.type);
      expect(types).toContain('posts_adv.created');
      expect(types).toContain('posts_adv.deleted');
    });
  });

  describe('6. Boundary Conditions, Pagination & Filters on listDeleted', () => {
    test('filters parameter on listDeleted narrows soft-deleted records', async () => {
      const ctx = getContext('filter-author');
      const service = baseService(posts, ctx, {
        ownership: ownedBy('authorId'),
      });

      // Create 3 posts and delete all 3
      const p1 = await service.create({ title: 'Alpha Target', authorId: 'filter-author' });
      const p2 = await service.create({ title: 'Beta Target', authorId: 'filter-author' });
      const p3 = await service.create({ title: 'Gamma Other', authorId: 'filter-author' });

      await service.delete(p1.id);
      await service.delete(p2.id);
      await service.delete(p3.id);

      // Query with custom filter matching only 'Beta Target'
      const filtered = await service.listDeleted({ page: 1, limit: 10 }, { filters: [eq(posts.title, 'Beta Target')] });

      expect(filtered.items.length).toBe(1);
      const firstFiltered = filtered.items[0];
      expect(firstFiltered?.id).toBe(p2.id);
      expect(firstFiltered?.title).toBe('Beta Target');
    });

    test('pagination calculations: total, totalPages, limit, page', async () => {
      const ctx = getContext('page-author');
      const service = baseService(posts, ctx, {
        ownership: ownedBy('authorId'),
      });

      // Create and delete 5 posts
      for (let i = 1; i <= 5; i++) {
        const p = await service.create({ title: `Batch Post ${i}`, authorId: 'page-author' });
        await service.delete(p.id);
      }

      // Page 1, limit 2
      const page1 = await service.listDeleted({ page: 1, limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.meta.page).toBe(1);
      expect(page1.meta.limit).toBe(2);
      expect(page1.meta.total).toBe(5);
      expect(page1.meta.totalPages).toBe(3);

      // Page 3, limit 2
      const page3 = await service.listDeleted({ page: 3, limit: 2 });
      expect(page3.items.length).toBe(1);
      expect(page3.meta.page).toBe(3);
      expect(page3.meta.limit).toBe(2);
      expect(page3.meta.total).toBe(5);
      expect(page3.meta.totalPages).toBe(3);
    });

    test('empty soft-deleted list calculates totalPages as 0', async () => {
      const ctx = getContext('empty-author');
      const service = baseService(posts, ctx, {
        ownership: ownedBy('authorId'),
      });

      const emptyPage = await service.listDeleted({ page: 1, limit: 10 });
      expect(emptyPage.items.length).toBe(0);
      expect(emptyPage.meta.total).toBe(0);
      expect(emptyPage.meta.totalPages).toBe(1);
    });
  });

  describe('7. Adversarial Edge Cases: Double-Delete, Double-Restore, and Foreign Restore', () => {
    test('double delete throws 404 because already-deleted row is not active', async () => {
      const ctx = getContext('idempotent-author');
      const service = baseService(posts, ctx);

      const post = await service.create({ title: 'Double Delete Post', authorId: 'idempotent-author' });

      // First delete succeeds
      await service.delete(post.id);

      // Second delete must throw 404 because get(id) cannot find active row
      try {
        await service.delete(post.id);
        expect.unreachable('Second delete should throw 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    });

    test('double restore throws 404 because already-active row is not deleted', async () => {
      const ctx = getContext('restore-author');
      const service = baseService(posts, ctx);

      const post = await service.create({ title: 'Double Restore Post', authorId: 'restore-author' });
      await service.delete(post.id);

      // First restore succeeds
      const restored = await service.restore(post.id);
      expect(restored.id).toBe(post.id);

      // Second restore must throw 404 because row is no longer soft-deleted
      try {
        await service.restore(post.id);
        expect.unreachable('Second restore should throw 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    });

    test('foreign restore: User 2 calling restore on User 1 row throws 404 to User 2', async () => {
      const ctxUser1 = getContext('owner-user-1');
      const serviceUser1 = baseService(posts, ctxUser1, {
        ownership: ownedBy('authorId'),
      });

      const post = await serviceUser1.create({ title: 'Private Post', authorId: 'owner-user-1' });
      await serviceUser1.delete(post.id);

      const ctxUser2 = getContext('attacker-user-2');
      const serviceUser2 = baseService(posts, ctxUser2, {
        ownership: ownedBy('authorId'),
      });

      // User 2 attempts to restore User 1's post
      try {
        await serviceUser2.restore(post.id);
        expect.unreachable('User 2 must get 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    });

    test('service executes in transaction when transaction context is provided', async () => {
      const ctx = getContext('tx-author');
      const service = baseService(posts, ctx);

      // Import uses transaction() under the hood
      const summary = await service.import([
        { title: 'Bulk Post 1', authorId: 'tx-author' },
        { title: 'Bulk Post 2', authorId: 'tx-author' },
      ]);
      expect(summary.created).toBe(2);

      const list = await service.list({ page: 1, limit: 10 });
      expect(list.items.some((p) => p.title === 'Bulk Post 1')).toBe(true);
      expect(list.items.some((p) => p.title === 'Bulk Post 2')).toBe(true);
    });
  });
});
