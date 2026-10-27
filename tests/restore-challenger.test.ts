import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ExecutionContext } from '@framework/core';
import {
  baseRepository,
  createConnection,
  type DatabaseConnection,
  type DataContext,
  TransactionContext,
} from '@framework/database';
import { type DomainEvent, type EventBus, MemoryEventBus } from '@framework/events';
import { HttpError } from '@framework/http';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { sql } from 'drizzle-orm';
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { baseService, type CrudRepository, ownedBy, ResourceService } from '../src';

const postsTable = pgTable('posts_challenger', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

interface PostRow {
  readonly id: number;
  readonly title: string;
  readonly authorId: string;
  readonly deletedAt: string | null;
}

const makeDataContext = (transactions: TransactionContext, actorId: string | null = 'author-1'): DataContext => {
  const actor = actorId ? { id: actorId, type: 'user' as const } : { id: null, type: 'anonymous' as const };
  return {
    transactions,
    execution: new ExecutionContext('test', 'corr-challenger', actor),
  } as unknown as DataContext;
};

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create table posts_challenger (id serial primary key, title text not null, author_id text not null, deleted_at timestamptz)`;
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

const getContext = (actorId: string | null = 'author-1') =>
  makeDataContext(new TransactionContext(connection.db), actorId);

describe('Challenger Adversarial Stress Tests: ResourceService.restore', () => {
  describe('Requirement 1: Unauthorized restore calls never call repository.restore', () => {
    test('foreign tenant restore does not invoke repository.restore', async () => {
      let restoreCallCount = 0;
      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async () => null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 101, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          restoreCallCount++;
          return true;
        },
        findDeletedById: async (id) =>
          id === 101 ? { id: 101, title: 'Secret Doc', authorId: 'owner-a', deletedAt: '2026-10-26T12:00:00Z' } : null,
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const attackerService = new ResourceService(mockRepo, getContext('attacker-b'), {
        ownership: ownedBy('authorId'),
      });

      try {
        await attackerService.restore(101);
        expect.unreachable('Should throw 404 for foreign record');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
        expect((err as HttpError).message).toContain('Resource 101 not found');
      }

      expect(restoreCallCount).toBe(0);
    });

    test('anonymous actor (null ownerId) restore does not invoke repository.restore', async () => {
      let restoreCallCount = 0;
      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async () => null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 102, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          restoreCallCount++;
          return true;
        },
        findDeletedById: async (id) =>
          id === 102 ? { id: 102, title: 'Secret Doc', authorId: 'owner-a', deletedAt: '2026-10-26T12:00:00Z' } : null,
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const anonService = new ResourceService(mockRepo, getContext(null), {
        ownership: ownedBy('authorId'),
      });

      try {
        await anonService.restore(102);
        expect.unreachable('Should throw 404 for anonymous actor');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }

      expect(restoreCallCount).toBe(0);
    });

    test('authorized owner DOES invoke repository.restore and completes successfully', async () => {
      let restoreCallCount = 0;
      let isRestored = false;

      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async (id) =>
          id === 103 && isRestored ? { id: 103, title: 'My Post', authorId: 'owner-a', deletedAt: null } : null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 103, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          restoreCallCount++;
          isRestored = true;
          return true;
        },
        findDeletedById: async (id) =>
          id === 103 && !isRestored
            ? { id: 103, title: 'My Post', authorId: 'owner-a', deletedAt: '2026-10-26T12:00:00Z' }
            : null,
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const ownerService = new ResourceService(mockRepo, getContext('owner-a'), {
        ownership: ownedBy('authorId'),
      });

      const restored = await ownerService.restore(103);
      expect(restored.id).toBe(103);
      expect(restored.deletedAt).toBeNull();
      expect(restoreCallCount).toBe(1);
    });
  });

  describe('Requirement 2: Cross-tenant restore attempts leave deleted_at intact in PostgreSQL', () => {
    test('cross-tenant restore rejection preserves deleted_at timestamp in database', async () => {
      const svcA = baseService(postsTable, getContext('tenant-alpha'), { ownership: ownedBy('authorId') });
      const svcB = baseService(postsTable, getContext('tenant-beta'), { ownership: ownedBy('authorId') });
      const svcC = baseService(postsTable, getContext(null), { ownership: ownedBy('authorId') });

      // Tenant Alpha creates and deletes a record
      const post = await svcA.create({ title: 'Confidential Strategy', authorId: 'tenant-alpha' });
      await svcA.delete(post.id);

      // Verify row is soft-deleted in DB
      const [initialState] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(initialState).toBeDefined();
      if (!initialState) throw new Error('Post not found in DB');
      expect(initialState.deleted_at).not.toBeNull();
      const initialTimestamp = initialState.deleted_at;

      // Tenant Beta attempts single restore
      await expect(svcB.restore(post.id)).rejects.toThrow(`Resource ${post.id} not found`);

      // Verify DB was unaffected
      const [afterBetaAttempt] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterBetaAttempt?.deleted_at).toBe(initialTimestamp);

      // Anonymous actor attempts restore
      await expect(svcC.restore(post.id)).rejects.toThrow(`Resource ${post.id} not found`);

      // Verify DB was unaffected
      const [afterAnonAttempt] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterAnonAttempt?.deleted_at).toBe(initialTimestamp);

      // 5 Concurrent unauthorized restore attempts
      const concurrentAttempts = await Promise.allSettled([
        svcB.restore(post.id),
        svcB.restore(post.id),
        svcC.restore(post.id),
        svcB.restore(post.id),
        svcC.restore(post.id),
      ]);
      for (const res of concurrentAttempts) {
        expect(res.status).toBe('rejected');
      }

      // Verify DB still intact
      const [afterConcurrent] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterConcurrent?.deleted_at).toBe(initialTimestamp);

      // Authorized Tenant Alpha can legitimately restore
      const restored = await svcA.restore(post.id);
      expect(restored.id).toBe(post.id);
      expect(restored.deletedAt).toBeNull();

      const [afterLegitRestore] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterLegitRestore?.deleted_at).toBeNull();
    });
  });

  describe('Requirement 3: Double restore cleanly returns 404', () => {
    test('restoring an active record (never deleted) returns 404', async () => {
      const service = baseService(postsTable, getContext('author-active'));
      const post = await service.create({ title: 'Active Post', authorId: 'author-active' });

      try {
        await service.restore(post.id);
        expect.unreachable('Should have thrown 404 for already active record');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe('NOT_FOUND');
        expect(httpErr.message).toContain(`Resource ${post.id} not found`);
      }
    });

    test('restoring an already restored record returns 404 on second call', async () => {
      const service = baseService(postsTable, getContext('author-double'));
      const post = await service.create({ title: 'Double Restore Target', authorId: 'author-double' });
      await service.delete(post.id);

      // First restore succeeds
      const first = await service.restore(post.id);
      expect(first.id).toBe(post.id);
      expect(first.deletedAt).toBeNull();

      // Second restore must throw 404
      try {
        await service.restore(post.id);
        expect.unreachable('Second restore should have thrown 404');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe('NOT_FOUND');
        expect(httpErr.message).toContain(`Resource ${post.id} not found`);
      }
    });

    test('repository without findDeletedById returning false on restore throws 404', async () => {
      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async () => ({ id: 201, title: 'Active Post', authorId: 'author-1', deletedAt: null }),
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 201, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        // restore returns false because row was not in deleted state (0 rows affected)
        restore: async () => false,
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const service = new ResourceService(mockRepo, getContext('author-1'));

      try {
        await service.restore(201);
        expect.unreachable('Should throw 404 when restore returns false');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    });
  });

  describe('Requirement 4: Mock & custom repositories without findDeletedById work and roll back if ownership check fails', () => {
    test('authorized restore on repository without findDeletedById succeeds', async () => {
      let repoRestoreCalled = false;
      let restoredInRepo = false;

      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async (id) =>
          id === 301 && restoredInRepo
            ? { id: 301, title: 'No FindDeleted Post', authorId: 'author-x', deletedAt: null }
            : null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 301, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          repoRestoreCalled = true;
          restoredInRepo = true;
          return true;
        },
        // Intentionally omit findDeletedById and paginateDeleted
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const service = new ResourceService(mockRepo, getContext('author-x'), {
        ownership: ownedBy('authorId'),
      });

      const result = await service.restore(301);
      expect(result.id).toBe(301);
      expect(result.authorId).toBe('author-x');
      expect(repoRestoreCalled).toBe(true);
    });

    test('unauthorized restore on repository without findDeletedById throws 404 and rolls back changes', async () => {
      // In this test, the repository lacks findDeletedById.
      // When restore is called, the repository restores the row in memory, but findById returns
      // a row with a foreign authorId. The ownership check (#assertOwned) in get(id) must fail,
      // and the surrounding transaction must abort/rollback.
      let rolledBack = false;

      const customDataContext: DataContext = {
        execution: new ExecutionContext('test', 'corr-rollback', { id: 'attacker', type: 'user' }),
        transactions: {
          database: connection.db,
          executor: connection.db,
          inTransaction: false,
          transaction: async <T>(work: () => Promise<T>): Promise<T> => {
            try {
              return await work();
            } catch (err) {
              rolledBack = true;
              throw err;
            }
          },
        } as unknown as TransactionContext,
      } as unknown as DataContext;

      let repoStateRestored = false;

      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async (id) =>
          id === 302
            ? {
                id: 302,
                title: 'Foreign Secret',
                authorId: 'victim',
                deletedAt: repoStateRestored ? null : '2026-10-26T00:00:00Z',
              }
            : null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 302, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          repoStateRestored = true;
          return true;
        },
        // Intentionally omit findDeletedById
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const service = new ResourceService(mockRepo, customDataContext, {
        ownership: ownedBy('authorId'),
      });

      try {
        await service.restore(302);
        expect.unreachable('Should fail ownership check');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }

      // Verify that the transaction block caught the failure and triggered rollback
      expect(rolledBack).toBe(true);
    });

    test('PostgreSQL transaction rollback on repository without findDeletedById leaves row deleted in DB', async () => {
      // Directly test PostgreSQL transaction semantics:
      // Insert a deleted row in PostgreSQL.
      // Create a repository WITHOUT findDeletedById that performs `UPDATE posts_challenger SET deleted_at = NULL` inside the transaction.
      // But findById returns the row whose author is 'victim'.
      // Attacker attempts restore. The #assertOwned failure throws 404.
      // Drizzle/pg transaction rolls back.
      // Direct SQL check confirms deleted_at is STILL set in PostgreSQL.

      const [inserted] = (await connection.sql`
        insert into posts_challenger (title, author_id, deleted_at)
        values ('Transactional Secret', 'victim-user', now())
        returning id, deleted_at
      `) as { id: number; deleted_at: string }[];
      expect(inserted).toBeDefined();
      if (!inserted) throw new Error('Failed to insert test row');
      const targetId = inserted.id;
      const originalDeletedAt = inserted.deleted_at;

      const attackerCtx = getContext('attacker-user');

      // Custom repository without findDeletedById bound to attackerCtx.transactions.executor
      const txRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async (id) => {
          const result = await attackerCtx.transactions.executor.execute<{
            id: number;
            title: string;
            authorId: string;
            deletedAt: string | null;
          }>(
            sql`select id, title, author_id as "authorId", deleted_at as "deletedAt" from posts_challenger where id = ${id}`,
          );
          const row = result[0];
          return row ?? null;
        },
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: targetId, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async (id) => {
          // Mutate the row in the DB within the current transaction executor
          await attackerCtx.transactions.executor.execute(
            sql`update posts_challenger set deleted_at = null where id = ${id}`,
          );
          return true;
        },
        // Intentionally omit findDeletedById
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const service = new ResourceService(txRepo, attackerCtx, {
        ownership: ownedBy('authorId'),
      });

      // Attacker calls restore -> fails ownership check with 404
      await expect(service.restore(targetId)).rejects.toThrow(`Resource ${targetId} not found`);

      // PostgreSQL check: Because the transaction rolled back, deleted_at must STILL be non-null!
      const [afterAttempt] = (await connection.sql`
        select id, deleted_at from posts_challenger where id = ${targetId}
      `) as { id: number; deleted_at: string | null }[];
      expect(afterAttempt).toBeDefined();
      if (!afterAttempt) throw new Error('Target row missing after attempt');
      expect(afterAttempt.deleted_at).not.toBeNull();
      if (!afterAttempt.deleted_at) throw new Error('deleted_at should not be null');
      expect(new Date(afterAttempt.deleted_at).getTime()).toBe(new Date(originalDeletedAt).getTime());
    });
  });

  describe('Requirement 5: Transaction handling side-effects', () => {
    test('outer transaction rollback cleanly rolls back restore()', async () => {
      const ctx = getContext('tx-owner');
      const service = baseService(postsTable, ctx, { ownership: ownedBy('authorId') });

      const post = await service.create({ title: 'Outer Tx Post', authorId: 'tx-owner' });
      await service.delete(post.id);

      const [deletedState] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(deletedState?.deleted_at).not.toBeNull();

      try {
        await ctx.transactions.transaction(async () => {
          const restored = await service.restore(post.id);
          expect(restored.deletedAt).toBeNull();
          throw new Error('INTENTIONAL_OUTER_ABORT');
        });
      } catch (err: unknown) {
        expect((err as Error).message).toBe('INTENTIONAL_OUTER_ABORT');
      }

      // Verify row remains deleted in PostgreSQL
      const [afterRollback] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterRollback?.deleted_at).not.toBeNull();
      expect(afterRollback?.deleted_at).toBe(deletedState?.deleted_at);
    });

    test('afterRestore hook error rolls back transaction', async () => {
      class HookFailingService extends ResourceService<PostRow, { title: string; authorId: string }> {
        protected override async afterRestore(): Promise<void> {
          throw new Error('AFTER_RESTORE_HOOK_FAILED');
        }
      }

      const ctx = getContext('hook-owner');
      const repo = baseRepository(postsTable, ctx);
      const service = new HookFailingService(repo, ctx, { ownership: ownedBy('authorId') });

      const post = await service.create({ title: 'Hook Post', authorId: 'hook-owner' });
      await service.delete(post.id);

      await expect(service.restore(post.id)).rejects.toThrow('AFTER_RESTORE_HOOK_FAILED');

      // Verify database row remains soft-deleted
      const [afterHookFailure] =
        (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
          id: number;
          deleted_at: string | null;
        }[];
      expect(afterHookFailure?.deleted_at).not.toBeNull();
    });

    test('execution without TransactionContext succeeds cleanly for services with standalone repos', async () => {
      let restoredInMock = false;
      const mockRepo: CrudRepository<PostRow, { title: string; authorId: string }> = {
        findById: async (id) =>
          id === 401 && restoredInMock
            ? { id: 401, title: 'NoTx Post', authorId: 'notx-owner', deletedAt: null }
            : null,
        findDeletedById: async (id) =>
          id === 401 && !restoredInMock
            ? { id: 401, title: 'NoTx Post', authorId: 'notx-owner', deletedAt: '2026-10-26T00:00:00Z' }
            : null,
        paginate: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        paginateDeleted: async () => ({ items: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }),
        create: async (v) => ({ id: 401, ...v, deletedAt: null }),
        createMany: async () => [],
        update: async () => null,
        delete: async () => true,
        restore: async () => {
          restoredInMock = true;
          return true;
        },
        column: (field) => (postsTable as unknown as Record<string, unknown>)[field] as never,
      };

      const ctxNoTx: DataContext = {
        execution: new ExecutionContext('test', 'corr-notx', { id: 'notx-owner', type: 'user' }),
      } as unknown as DataContext;

      const service = new ResourceService(mockRepo, ctxNoTx, { ownership: ownedBy('authorId') });

      const restored = await service.restore(401);
      expect(restored.id).toBe(401);
      expect(restored.deletedAt).toBeNull();
      expect(restoredInMock).toBe(true);
    });
  });

  describe('Requirement 6: Event publishing side-effects', () => {
    test('authorized restore publishes domain event with correct payload, actor, and correlationId', async () => {
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_challenger', (evt) => {
        events.push(evt);
      });

      const ctx = getContext('event-owner');
      const service = baseService(postsTable, ctx, {
        ownership: ownedBy('authorId'),
        bus,
        channel: 'posts_challenger',
      });

      const post = await service.create({ title: 'Event Post', authorId: 'event-owner' });
      await service.delete(post.id);
      events.length = 0; // Clear create and delete events

      const restored = await service.restore(post.id);
      expect(restored.deletedAt).toBeNull();

      expect(events.length).toBe(1);
      const [event] = events;
      expect(event?.channel).toBe('posts_challenger');
      expect(event?.type).toBe('posts_challenger.restored');
      const payload = event?.payload as Record<string, unknown>;
      expect(payload?.id).toBe(post.id);
      expect(payload?.deletedAt).toBeNull();
      expect(event?.actor.id).toBe('event-owner');
      expect(event?.correlationId).toBe('corr-challenger');
    });

    test('failing/unauthorized restore emits zero domain events', async () => {
      const bus = new MemoryEventBus();
      const events: DomainEvent[] = [];
      bus.subscribe('posts_challenger', (evt) => {
        events.push(evt);
      });

      const ctxOwner = getContext('owner-user');
      const ctxAttacker = getContext('attacker-user');

      const svcOwner = baseService(postsTable, ctxOwner, {
        ownership: ownedBy('authorId'),
        bus,
        channel: 'posts_challenger',
      });
      const svcAttacker = baseService(postsTable, ctxAttacker, {
        ownership: ownedBy('authorId'),
        bus,
        channel: 'posts_challenger',
      });

      const post = await svcOwner.create({ title: 'Secret Post', authorId: 'owner-user' });
      await svcOwner.delete(post.id);
      events.length = 0;

      await expect(svcAttacker.restore(post.id)).rejects.toThrow(`Resource ${post.id} not found`);
      expect(events.length).toBe(0);
    });

    test('event publishing failure safely rolls back database restore', async () => {
      let shouldFail = false;
      const faultyBus: EventBus = {
        publish: async (evt: DomainEvent) => {
          if (shouldFail && evt.type === 'posts_challenger.restored') {
            throw new Error('EVENT_BUS_NETWORK_FAILURE');
          }
        },
        subscribe: async () => async () => {},
        close: async () => {},
      };

      const ctx = getContext('bus-failure-owner');
      const service = baseService(postsTable, ctx, {
        ownership: ownedBy('authorId'),
        bus: faultyBus,
        channel: 'posts_challenger',
      });

      const post = await service.create({ title: 'Bus Failure Post', authorId: 'bus-failure-owner' });
      await service.delete(post.id);

      shouldFail = true;
      await expect(service.restore(post.id)).rejects.toThrow('EVENT_BUS_NETWORK_FAILURE');

      // Verify row is still deleted in database
      const [row] = (await connection.sql`select id, deleted_at from posts_challenger where id = ${post.id}`) as {
        id: number;
        deleted_at: string | null;
      }[];
      expect(row?.deleted_at).not.toBeNull();
    });
  });
});
