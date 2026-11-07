import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ANONYMOUS_ACTOR, Application, defineProvider, EXECUTION_CONTEXT } from '@framework/core';
import {
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  type DatabaseConnection,
  TRANSACTION_CONTEXT,
  TransactionContext,
} from '@framework/database';
import { EVENT_BUS, MemoryEventBus } from '@framework/events';
import { defineApp, denyAll, listRoutes } from '@framework/http';
import { checkOperations, generateOpenApiDocument, type Operation } from '@framework/openapi';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hc } from 'hono/client';
import { z } from 'zod/v4';
import { defineResource, ResourceService } from '../src';

const notes = pgTable('define_resource_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  secret: text('secret').notNull().default('hidden'),
  ownerId: text('owner_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

const drafts = pgTable('define_resource_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const counters = pgTable('define_resource_counters', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

let database: TestDatabase;
let connection: DatabaseConnection;

const dataProvider = defineProvider<object>({
  name: 'database',
  register({ container }) {
    container.singleton(DATABASE, () => connection);
    container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
    container.scoped(DATA_CONTEXT, (r) => ({
      transactions: r.resolve(TRANSACTION_CONTEXT),
      execution: r.resolve(EXECUTION_CONTEXT),
    }));
  },
});

const notesResource = defineResource(notes, { access: 'public', hidden: ['secret'] });

/** Boots an app around one module, acting as whoever the `x-actor` header names. */
async function serve(
  module: Parameters<typeof defineApp<object, Operation>>[0]['modules'],
  abilities?: readonly string[],
) {
  const app = defineApp<object, Operation>({
    http: () => ({
      exposeInternalErrors: false,
      resolveActor: (c) => {
        const id = c.req.header('x-actor');
        return id ? { id, type: 'user' } : ANONYMOUS_ACTOR;
      },
    }),
    ...(abilities
      ? {
          middleware: () => [
            async (c, next) => {
              c.set('principal', { id: 'tester', abilities });
              await next();
            },
          ],
        }
      : {}),
    providers: [dataProvider],
    modules: module ?? [],
  });
  const application = await new Application<object>({ config: {}, providers: app.providers }).boot();
  return { app, application, http: app.createHttp(application) };
}

const json = (method: string, body: object, headers: Record<string, string> = {}) => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create table define_resource_notes (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    secret text not null default 'hidden',
    owner_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await connection.sql`create table define_resource_counters (
    id integer primary key generated always as identity,
    label text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await connection.sql`create table define_resource_drafts (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  )`;
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

describe('defineResource', () => {
  test('one call serves the full lifecycle, through a typed RPC client', async () => {
    const { application, http } = await serve([notesResource]);
    const client = hc<typeof notesResource.routes.app>('http://in-process.test/api/v1/define-resource-notes', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        http.request(input instanceof Request ? input : String(input), init),
    });

    const created = await client.index.$post({ json: { title: 'first' } });
    expect(created.status).toBe(201);
    if (created.status !== 201) throw new Error('unreachable');
    const note = await created.json();
    const title: string = note.title;
    expect(title).toBe('first');

    expect((await client[':id'].$get({ param: { id: note.id } })).status).toBe(200);

    const updated = await client[':id'].$patch({ param: { id: note.id }, json: { title: 'second' } });
    expect((await updated.json()).title).toBe('second');

    const page = await (await client.index.$get({ query: { limit: '5' } })).json();
    expect(page.items.map((item) => item.id)).toContain(note.id);

    expect((await client[':id'].$delete({ param: { id: note.id } })).status).toBe(204);
    const gone: number = (await client[':id'].$get({ param: { id: note.id } })).status;
    expect(gone).toBe(404);

    // Compile-time evidence: inputs and outputs come from the table.
    // @ts-expect-error title is required
    await client.index.$post({ json: {} }).catch(() => undefined);
    // @ts-expect-error hidden columns are not in the response type
    expect(note.secret).toBeUndefined();

    await application.shutdown();
  });

  test('validation rejects unknown keys, bad ids and empty updates', async () => {
    const { application, http } = await serve([notesResource]);
    const base = '/api/v1/define-resource-notes';

    expect((await http.request(base, json('POST', { title: 'x', secret: 'nope' }))).status).toBe(422);
    expect((await http.request(`${base}?unknown=1`)).status).toBe(422);
    expect((await http.request(`${base}/not-a-uuid`)).status).toBe(422);
    const created = (await (await http.request(base, json('POST', { title: 'x' }))).json()) as { id: string };
    expect((await http.request(`${base}/${created.id}`, json('PATCH', {}))).status).toBe(422);

    await application.shutdown();
  });

  test('its operations match its routes and build a document', async () => {
    const { app, application, http } = await serve([notesResource]);

    const apiRoutes = listRoutes(http).filter((route) => route.path.startsWith('/api/'));
    expect(checkOperations(apiRoutes, app.operations)).toEqual([]);
    const document = generateOpenApiDocument({ title: 't', version: '1', operations: app.operations });
    expect(document.openapi).toBe('3.1.0');

    await application.shutdown();
  });

  test('soft-delete tables get the deleted and restore routes', async () => {
    const resource = defineResource(drafts, { access: 'public' });
    const { app, application, http } = await serve([resource]);
    const base = '/api/v1/define-resource-drafts';

    const { id } = (await (await http.request(base, json('POST', { title: 'd' }))).json()) as { id: string };
    expect((await http.request(`${base}/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http.request(`${base}/${id}`)).status).toBe(404);
    expect((await http.request(`${base}/deleted/${id}`)).status).toBe(200);
    expect((await http.request(`${base}/${id}/restore`, { method: 'POST' })).status).toBe(200);
    expect((await http.request(`${base}/${id}`)).status).toBe(200);

    const apiRoutes = listRoutes(http).filter((route) => route.path.startsWith('/api/'));
    expect(checkOperations(apiRoutes, app.operations)).toEqual([]);

    await application.shutdown();
  });

  test("access: 'authenticated' answers 401 to anonymous callers; a policy answers 403", async () => {
    const guarded = defineResource(notes, { access: 'authenticated', name: 'GuardedNote', path: '/guarded' });
    const denied = defineResource(notes, { access: denyAll, name: 'DeniedNote', path: '/denied' });
    const { application, http } = await serve([guarded, denied]);

    expect((await http.request('/api/v1/guarded')).status).toBe(401);
    expect((await http.request('/api/v1/denied')).status).toBe(403);

    await application.shutdown();
  });

  test("access: 'authenticated' honours token abilities, per resource", async () => {
    const guarded = defineResource(notes, { access: 'authenticated', name: 'ScopedNote', path: '/scoped' });

    const limited = await serve([guarded], ['orders.view']);
    expect((await limited.http.request('/api/v1/scoped')).status).toBe(403);
    await limited.application.shutdown();

    const scoped = await serve([guarded], ['defineResourceNotes.viewAny']);
    expect((await scoped.http.request('/api/v1/scoped')).status).toBe(200);
    expect((await scoped.http.request('/api/v1/scoped', json('POST', { title: 'x' }))).status).toBe(403);
    await scoped.application.shutdown();

    const session = await serve([guarded], ['*']);
    expect((await session.http.request('/api/v1/scoped')).status).toBe(200);
    await session.application.shutdown();
  });

  test('integer primary keys are coerced from the path', async () => {
    const { application, http } = await serve([defineResource(counters, { access: 'public' })]);
    const base = '/api/v1/define-resource-counters';

    const { id } = (await (await http.request(base, json('POST', { label: 'c' }))).json()) as { id: number };
    expect(id).toBeNumber();
    expect((await http.request(`${base}/${id}`)).status).toBe(200);
    expect((await http.request(`${base}/${id}`, json('PATCH', { label: 'd' }))).status).toBe(200);
    expect((await http.request(`${base}/not-a-number`)).status).toBe(422);
    expect((await http.request(`${base}/${id}`, { method: 'DELETE' })).status).toBe(204);

    await application.shutdown();
  });

  test('softDelete: false leaves the lifecycle routes out', async () => {
    const resource = defineResource(drafts, {
      access: 'public',
      name: 'PlainDraft',
      path: '/plain',
      softDelete: false,
    });
    const { application, http } = await serve([resource]);
    expect(listRoutes(http).map((route) => route.path)).not.toContain('/api/v1/plain/deleted');
    await application.shutdown();
  });

  test('every part can be replaced', async () => {
    class ShoutingService extends ResourceService<
      typeof notes.$inferSelect,
      { title: string },
      Partial<{ title: string }>
    > {
      protected override beforeCreate(input: { title: string }) {
        return { ...input, title: input.title.toUpperCase() };
      }
    }
    const resource = defineResource(notes, {
      access: 'public',
      name: 'CustomNote',
      path: '/custom',
      service: ShoutingService,
      schemas: {
        create: z.object({ title: z.string().min(3) }).strict(),
        response: z.object({ id: z.string(), title: z.string() }),
      },
    });
    const { application, http } = await serve([resource]);

    expect((await http.request('/api/v1/custom', json('POST', { title: 'no' }))).status).toBe(422);
    const created = await (await http.request('/api/v1/custom', json('POST', { title: 'loud' }))).json();
    expect(created).toEqual({ id: expect.any(String), title: 'LOUD' });

    await application.shutdown();
  });

  test('overriding a token replaces that part without touching the routes', async () => {
    const { application, http } = await serve([notesResource]);
    application.container.override(notesResource.tokens.controller, () => {
      throw new Error('replaced');
    });

    const response = await http.request('/api/v1/define-resource-notes');
    expect(response.status).toBe(500);

    await application.shutdown();
  });

  test('ownedBy scopes rows to the actor and only accepts real columns', async () => {
    const resource = defineResource(notes, { access: 'public', name: 'OwnedNote', path: '/owned', ownedBy: 'ownerId' });
    const { application, http } = await serve([resource]);

    const created = (await (
      await http.request('/api/v1/owned', json('POST', { title: 'mine' }, { 'x-actor': 'alice' }))
    ).json()) as { id: string; ownerId: string };
    expect(created.ownerId).toBe('alice');
    expect((await http.request(`/api/v1/owned/${created.id}`, { headers: { 'x-actor': 'alice' } })).status).toBe(200);
    expect((await http.request(`/api/v1/owned/${created.id}`, { headers: { 'x-actor': 'bob' } })).status).toBe(404);

    // @ts-expect-error not a column
    defineResource(notes, { access: 'public', ownedBy: 'typo' });

    await application.shutdown();
  });

  test('entity events publish on the bus with the public projection', async () => {
    const bus = new MemoryEventBus();
    const seen: unknown[] = [];
    await bus.subscribe('define_resource_notes', (event) => void seen.push(event.payload));
    const { application, http } = await serve([notesResource]);
    application.container.override(EVENT_BUS, () => bus);

    await http.request('/api/v1/define-resource-notes', json('POST', { title: 'evented' }));
    const deadline = Date.now() + 2_000;
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(5);

    expect(seen[0]).toMatchObject({ title: 'evented' });
    expect(seen[0]).not.toHaveProperty('secret');

    await application.shutdown();
    await bus.close();
  });
});
