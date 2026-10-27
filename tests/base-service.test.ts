import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ExecutionContext } from '@framework/core';
import { createConnection, type DatabaseConnection, type DataContext, TransactionContext } from '@framework/database';
import { type DomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { BaseService, baseService, type CrudRepository, ownedBy, ResourceService } from '../src';

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

interface PostEntity {
  readonly id: number;
  readonly title: string;
  readonly authorId: string;
  readonly deletedAt: string | null;
}

const makeDataContext = (transactions: TransactionContext, actorId = 'author-1'): DataContext => ({
  transactions,
  execution: new ExecutionContext('test', 'corr-base-service', { id: actorId, type: 'user' }),
});

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create table posts (id serial primary key, title text not null, author_id text not null, deleted_at timestamptz)`;
  await connection.sql`create table categories (id serial primary key, name text not null)`;
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

const getContext = (actorId = 'author-1') => makeDataContext(new TransactionContext(connection.db), actorId);

describe('ResourceService soft-delete extensions', () => {
  test('listDeleted throws 400 when repository does not support soft-delete', async () => {
    const mockRepo: CrudRepository<{ id: number }, { name: string }> = {
      findById: async () => null,
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
    };

    const service = new ResourceService(mockRepo);
    expect(service.listDeleted({ page: 1, limit: 10 })).rejects.toThrow('This resource does not support soft-delete');
  });

  test('getDeleted throws 400 when repository does not support soft-delete', async () => {
    const mockRepo: CrudRepository<{ id: number }, { name: string }> = {
      findById: async () => null,
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
    };

    const service = new ResourceService(mockRepo);
    expect(service.getDeleted(1)).rejects.toThrow('This resource does not support soft-delete');
  });

  test('getDeleted throws 404 when deleted record does not exist', async () => {
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

    const service = new ResourceService(mockRepo);
    expect(service.getDeleted(999)).rejects.toThrow('Resource 999 not found');
  });

  test('getDeleted enforces row ownership scoping', async () => {
    const mockRepo: CrudRepository<PostEntity, { title: string; authorId: string }> = {
      findById: async () => null,
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v, deletedAt: null }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
      findDeletedById: async (id) =>
        id === 1 ? { id: 1, title: 'Foreign Post', authorId: 'other-user', deletedAt: '2026-01-01T00:00:00Z' } : null,
      paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      column: (field) => (posts as unknown as Record<string, unknown>)[field] as never,
    };

    const service = new ResourceService(mockRepo, getContext('author-1'), {
      ownership: ownedBy('authorId'),
    });

    // Foreign row should be hidden behind 404
    expect(service.getDeleted(1)).rejects.toThrow('Resource 1 not found');
  });

  test('restore throws 400 when restore is not supported, 404 when missing, and returns entity on success', async () => {
    const mockRepoNoRestore: CrudRepository<{ id: number }, { name: string }> = {
      findById: async () => null,
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
    };
    const svc1 = new ResourceService(mockRepoNoRestore);
    expect(svc1.restore(1)).rejects.toThrow('This resource does not support restore');

    const mockRepoWithRestore: CrudRepository<{ id: number; name: string }, { name: string }> = {
      findById: async (id) => (id === 1 ? { id: 1, name: 'Restored Item' } : null),
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
      restore: async (id) => id === 1,
    };
    const svc2 = new ResourceService(mockRepoWithRestore);
    expect(svc2.restore(999)).rejects.toThrow('Resource 999 not found');

    const restored = await svc2.restore(1);
    expect(restored).toEqual({ id: 1, name: 'Restored Item' });
  });

  test('restore enforces row ownership scoping and does not call repository.restore for foreign rows', async () => {
    let repoRestoreCalled = false;
    const mockRepo: CrudRepository<PostEntity, { title: string; authorId: string }> = {
      findById: async () => null,
      paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      create: async (v) => ({ id: 1, ...v, deletedAt: null }),
      createMany: async () => [],
      update: async () => null,
      delete: async () => true,
      restore: async () => {
        repoRestoreCalled = true;
        return true;
      },
      findDeletedById: async (id) =>
        id === 1 ? { id: 1, title: 'Foreign Post', authorId: 'other-user', deletedAt: '2026-01-01T00:00:00Z' } : null,
      paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
      column: (field) => (posts as unknown as Record<string, unknown>)[field] as never,
    };

    const service = new ResourceService(mockRepo, getContext('author-1'), {
      ownership: ownedBy('authorId'),
    });

    await expect(service.restore(1)).rejects.toThrow('Resource 1 not found');
    expect(repoRestoreCalled).toBe(false);
  });
});

describe('BaseService & baseService factory', () => {
  test('baseService initializes BaseService over hard-delete table', async () => {
    const ctx = getContext();
    const service = baseService(categories, ctx);
    expect(service).toBeInstanceOf(BaseService);

    const cat = await service.create({ name: 'Tech' });
    expect(cat.id).toBeDefined();
    expect(cat.name).toBe('Tech');

    const fetched = await service.get(cat.id);
    expect(fetched.name).toBe('Tech');

    const updated = await service.update(cat.id, { name: 'Technology' });
    expect(updated.name).toBe('Technology');

    const list = await service.list({ page: 1, limit: 10 });
    expect(list.items.some((c) => c.id === cat.id)).toBe(true);
    expect(list.meta.totalPages).toBeGreaterThanOrEqual(1);

    await service.delete(cat.id);
    expect(service.get(cat.id)).rejects.toThrow();
  });

  test('baseService connects EVENT_BUS and publishes domain events for soft-delete lifecycle', async () => {
    const ctx = getContext('author-1');
    const bus = new MemoryEventBus();
    const published: DomainEvent[] = [];
    bus.subscribe('posts', async (event) => {
      published.push(event);
    });

    const service = baseService(posts, ctx, { bus });
    expect(service).toBeInstanceOf(BaseService);

    // Create
    const post = await service.create({ title: 'Event Bus Article', authorId: 'author-1' });
    expect(post.id).toBeDefined();

    // Update
    await service.update(post.id, { title: 'Updated Event Bus Article' });

    // Soft delete
    await service.delete(post.id);

    // Verify it is in listDeleted and getDeleted
    const deletedPage = await service.listDeleted({ page: 1, limit: 10 });
    expect(deletedPage.items.some((p) => p.id === post.id)).toBe(true);
    expect(deletedPage.meta.totalPages).toBeGreaterThanOrEqual(1);

    const deletedItem = await service.getDeleted(post.id);
    expect(deletedItem.id).toBe(post.id);
    expect(deletedItem.deletedAt).not.toBeNull();

    // Active get should throw 404
    expect(service.get(post.id)).rejects.toThrow();

    // Restore
    const restored = await service.restore(post.id);
    expect(restored.id).toBe(post.id);
    expect(restored.deletedAt).toBeNull();

    // Verify events were published on channel 'posts'
    const types = published.map((e) => e.type);
    expect(types).toContain('posts.created');
    expect(types).toContain('posts.updated');
    expect(types).toContain('posts.deleted');
    expect(types).toContain('posts.restored');

    for (const e of published) {
      expect(e.channel).toBe('posts');
    }
  });

  test('baseService resolves EVENT_BUS from container when available', async () => {
    const ctx = getContext('author-1');
    const bus = new MemoryEventBus();
    const published: DomainEvent[] = [];
    bus.subscribe('posts', async (event) => {
      published.push(event);
    });

    const mockContainer = {
      has: (t: unknown) => t === EVENT_BUS,
      resolve: (t: unknown) => (t === EVENT_BUS ? bus : undefined) as never,
    };

    const service = baseService(posts, ctx, { container: mockContainer });
    const post = await service.create({ title: 'Container Bus Post', authorId: 'author-1' });
    expect(post.id).toBeDefined();

    expect(published.some((e) => e.type === 'posts.created' && e.channel === 'posts')).toBe(true);
  });

  test('baseService currying (context: DataContext) => BaseService', () => {
    const curried = baseService(posts);
    expect(typeof curried).toBe('function');
    const service = curried(getContext());
    expect(service).toBeInstanceOf(BaseService);
  });

  test('restore prevents cross-tenant state mutation on foreign-owned records', async () => {
    const ctxA = getContext('tenant-a');
    const ctxB = getContext('tenant-b');
    const svcA = baseService(posts, ctxA, { ownership: ownedBy('authorId') });
    const svcB = baseService(posts, ctxB, { ownership: ownedBy('authorId') });

    // Tenant A creates and soft-deletes a post
    const post = await svcA.create({ title: 'Tenant A Secret', authorId: 'tenant-a' });
    await svcA.delete(post.id);

    // Verify row is soft-deleted in DB
    const [beforeAttempt] = (await connection.sql`select id, deleted_at from posts where id = ${post.id}`) as {
      id: number;
      deleted_at: string | null;
    }[];
    expect(beforeAttempt).toBeDefined();
    if (!beforeAttempt) throw new Error('Expected post to exist before attempt');
    expect(beforeAttempt.deleted_at).not.toBeNull();

    // Tenant B attempts to restore Tenant A's post
    await expect(svcB.restore(post.id)).rejects.toThrow(`Resource ${post.id} not found`);

    // CRITICAL: Verify row in DB was NOT restored — deleted_at remains untouched
    const [afterAttempt] = (await connection.sql`select id, deleted_at from posts where id = ${post.id}`) as {
      id: number;
      deleted_at: string | null;
    }[];
    expect(afterAttempt).toBeDefined();
    if (!afterAttempt) throw new Error('Expected post to exist after attempt');
    expect(afterAttempt.deleted_at).not.toBeNull();
    expect(afterAttempt.deleted_at).toBe(beforeAttempt.deleted_at);

    // Tenant A can successfully restore their own post
    const restored = await svcA.restore(post.id);
    expect(restored.id).toBe(post.id);
    expect(restored.deletedAt).toBeNull();
  });
});
