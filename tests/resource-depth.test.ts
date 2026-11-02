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
import { defineApp } from '@framework/http';
import { generateOpenApiDocument, type Operation } from '@framework/openapi';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { boolean, date, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { hc } from 'hono/client';
import { z } from 'zod/v4';
import { belongsTo, defineListQuery, defineResource, hasMany } from '../src';

const articleStatus = pgEnum('depth_article_status', ['draft', 'published']);

const authors = pgTable('depth_authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
});

const articles = pgTable('depth_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  status: articleStatus('status').notNull().default('draft'),
  views: integer('views').notNull().default(0),
  featured: boolean('featured').notNull().default(false),
  meta: jsonb('meta').$type<{ readonly tags: readonly string[] }>(),
  secret: text('secret').notNull().default('hidden'),
  ownerId: text('owner_id'),
  authorId: uuid('author_id').references(() => authors.id),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  stampedAt: timestamp('stamped_at', { withTimezone: true }),
  day: date('day'),
  score: real('score'),
  rank: integer('rank').notNull().default(7),
});

const comments = pgTable('depth_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  articleId: uuid('article_id')
    .notNull()
    .references(() => articles.id),
  body: text('body').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

/** Two foreign keys to authors: which one a relation means can't be guessed. */
const reviews = pgTable('depth_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  writerId: uuid('writer_id').references(() => authors.id),
  editorId: uuid('editor_id').references(() => authors.id),
});

const metaSchema = z.object({ tags: z.array(z.string()) }).strict();

const articlesResource = defineResource(articles, {
  access: 'public',
  hidden: ['secret'],
  columns: { meta: metaSchema },
  filterable: {
    title: ['contains', 'eq'],
    status: true,
    views: ['gte', 'lte', 'in'],
    featured: true,
    authorId: ['eq'],
    publishedAt: ['gte'],
    stampedAt: ['gte'],
    day: ['eq'],
    score: ['gte', 'in'],
  },
  sortable: ['views', 'title'],
  relations: {
    author: belongsTo(authors, { columns: ['id', 'name'] }),
    comments: hasMany(comments, { columns: ['id', 'body'], limit: 2 }),
  },
});

let database: TestDatabase;
let connection: DatabaseConnection;
let adaId: string;
let graceId: string;

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

async function serve(modules: Parameters<typeof defineApp<object, Operation>>[0]['modules']) {
  const app = defineApp<object, Operation>({
    http: () => ({
      exposeInternalErrors: false,
      resolveActor: (c) => {
        const id = c.req.header('x-actor');
        return id ? { id, type: 'user' } : ANONYMOUS_ACTOR;
      },
    }),
    providers: [dataProvider],
    modules: modules ?? [],
  });
  const application = await new Application<object>({ config: {}, providers: app.providers }).boot();
  return { app, application, http: app.createHttp(application) };
}

type ArticleJson = { id: string; title: string; views: number; author?: unknown; comments?: unknown; secret?: string };
type PageJson = { items: ArticleJson[]; meta: { total: number } };

const BASE = '/api/v1/depth-articles';
const post = (body: object) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let http: Awaited<ReturnType<typeof serve>>['http'];
let shutdown: () => Promise<unknown>;
let first: ArticleJson;

const list = async (query: string): Promise<PageJson> => {
  const response = await http.request(`${BASE}?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PageJson;
};
const titles = (page: PageJson) => page.items.map((item) => item.title);
const status = async (query: string) => (await http.request(`${BASE}?${query}`)).status;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create type depth_article_status as enum ('draft', 'published')`;
  await connection.sql`create table depth_authors (
    id uuid primary key default gen_random_uuid(),
    name text not null, email text not null, password_hash text not null)`;
  await connection.sql`create table depth_articles (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    status depth_article_status not null default 'draft',
    views integer not null default 0,
    featured boolean not null default false,
    meta jsonb,
    secret text not null default 'hidden',
    owner_id text,
    author_id uuid references depth_authors(id),
    published_at timestamptz,
    stamped_at timestamptz,
    day date,
    score real,
    rank integer not null default 7)`;
  await connection.sql`create table depth_comments (
    id uuid primary key default gen_random_uuid(),
    article_id uuid not null references depth_articles(id),
    body text not null,
    deleted_at timestamptz)`;
  const rows = await connection.sql<{ id: string }[]>`
    insert into depth_authors (name, email, password_hash)
    values ('Ada', 'ada@example.com', 'hash-a'), ('Grace', 'grace@example.com', 'hash-g') returning id`;
  adaId = rows[0]?.id as string;
  graceId = rows[1]?.id as string;

  const served = await serve([articlesResource]);
  http = served.http;
  shutdown = () => served.application.shutdown();

  const seed = [
    { title: 'Alpha', status: 'draft', views: 10, authorId: adaId },
    { title: 'Beta', status: 'published', views: 30, authorId: graceId, featured: true },
    { title: 'Gamma 100%', status: 'published', views: 20 },
  ];
  const created: ArticleJson[] = [];
  for (const body of seed) {
    const response = await http.request(BASE, post(body));
    expect(response.status).toBe(201);
    created.push((await response.json()) as ArticleJson);
  }
  first = created[0] as ArticleJson;
  const second = created[1] as ArticleJson;
  await connection.sql`insert into depth_comments (article_id, body, deleted_at) values
    (${first.id}, 'one', null), (${first.id}, 'two', null), (${first.id}, 'three', null),
    (${second.id}, 'gone', now()), (${second.id}, 'kept', null)`;
});

afterAll(async () => {
  await shutdown();
  await connection.close();
  await database.drop();
});

describe('enum and jsonb columns', () => {
  test('a pgEnum column only accepts its values', async () => {
    expect((await http.request(BASE, post({ title: 'x', status: 'archived' }))).status).toBe(422);
  });

  test('the columns option validates jsonb on create and update', async () => {
    expect((await http.request(BASE, post({ title: 'x', meta: { nope: 1 } }))).status).toBe(422);

    const created = await http.request(BASE, post({ title: 'With meta', meta: { tags: ['a'] } }));
    expect(created.status).toBe(201);
    const { id, meta } = (await created.json()) as { id: string; meta: unknown };
    expect(meta).toEqual({ tags: ['a'] });

    const patch = (body: object) => ({ ...post(body), method: 'PATCH' });
    expect((await http.request(`${BASE}/${id}`, patch({ meta: { nope: 1 } }))).status).toBe(422);
    // The column stays optional and nullable, as the table declares it.
    expect((await http.request(`${BASE}/${id}`, patch({ title: 'Renamed' }))).status).toBe(200);
    expect((await http.request(`${BASE}/${id}`, patch({ meta: null }))).status).toBe(200);
    expect((await http.request(`${BASE}/${id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('filtering', () => {
  test('by enum, range, list and boolean', async () => {
    expect(titles(await list('filter[status][eq]=draft'))).toEqual(['Alpha']);
    expect(titles(await list('filter[views][gte]=20&sort=views'))).toEqual(['Gamma 100%', 'Beta']);
    expect(titles(await list('filter[views][in]=10,30&sort=views'))).toEqual(['Alpha', 'Beta']);
    expect(titles(await list('filter[featured][eq]=true'))).toEqual(['Beta']);
    expect(titles(await list(`filter[authorId][eq]=${adaId}`))).toEqual(['Alpha']);
  });

  test('page totals count the filtered rows', async () => {
    expect((await list('filter[status][eq]=published')).meta.total).toBe(2);
  });

  test('contains matches case-insensitively and treats wildcards as text', async () => {
    expect(titles(await list('filter[title][contains]=ALPH'))).toEqual(['Alpha']);
    expect(titles(await list('filter[title][contains]=100%25'))).toEqual(['Gamma 100%']);
    expect(titles(await list('filter[title][contains]=%25'))).toEqual(['Gamma 100%']);
    expect(titles(await list('filter[title][contains]=_lpha'))).toEqual([]);
  });

  test('anything outside the allowlist is a 422', async () => {
    expect(await status('filter[secret][eq]=hidden')).toBe(422);
    expect(await status('filter[views][eq]=10')).toBe(422);
    expect(await status('filter[ownerId][eq]=x')).toBe(422);
    expect(await status('nope=1')).toBe(422);
  });

  test('a value the column could not hold is a 422, never a database error', async () => {
    expect(await status('filter[views][gte]=abc')).toBe(422);
    expect(await status('filter[views][gte]=1.5')).toBe(422);
    expect(await status('filter[views][gte]=99999999999')).toBe(422);
    expect(await status('filter[views][gte]=')).toBe(422);
    expect(await status('filter[views][in]=1,x')).toBe(422);
    expect(await status('filter[status][eq]=archived')).toBe(422);
    expect(await status('filter[authorId][eq]=not-a-uuid')).toBe(422);
    expect(await status('filter[publishedAt][gte]=yesterday')).toBe(422);
    expect(await status('filter[featured][eq]=maybe')).toBe(422);
  });

  test('values Postgres would refuse are a 422', async () => {
    expect(await status('filter[title][eq]=a%00b')).toBe(422);
    expect(await status('filter[title][contains]=%00')).toBe(422);
    expect(await status('filter[publishedAt][gte]=0000-01-01T00:00:00Z')).toBe(422);
    expect(await status('filter[stampedAt][gte]=0000-01-01T00:00:00Z')).toBe(422);
    expect(await status('filter[publishedAt][gte]=0001-01-01T00:00:00%2B01:00')).toBe(422);
    expect(await status('filter[publishedAt][gte]=2026-01-01T00:00:00%2B23:00')).toBe(422);
    expect(await status('filter[day][eq]=0000-01-01')).toBe(422);
    expect(await status(`filter[score][gte]=${'9'.repeat(40)}`)).toBe(422);
    expect(await status(`filter[score][in]=1,${'9'.repeat(40)}`)).toBe(422);
  });

  test('ordinary dates and numbers still work', async () => {
    expect(await status('filter[publishedAt][gte]=2026-01-01T00:00:00%2B02:00')).toBe(200);
    expect(await status('filter[stampedAt][gte]=2026-01-01T00:00:00Z')).toBe(200);
    expect(await status('filter[day][eq]=2026-01-31')).toBe(200);
    expect(await status('filter[score][gte]=1.5')).toBe(200);
  });

  test('a filter never widens the ownership scope', async () => {
    const owned = defineResource(articles, {
      access: 'public',
      name: 'OwnedArticle',
      path: '/owned-articles',
      ownedBy: 'ownerId',
      filterable: { ownerId: ['eq'] },
    });
    const served = await serve([owned]);
    await served.http.request('/api/v1/owned-articles', {
      ...post({ title: 'Mine' }),
      headers: { 'content-type': 'application/json', 'x-actor': 'alice' },
    });

    const response = await served.http.request('/api/v1/owned-articles?filter[ownerId][eq]=alice', {
      headers: { 'x-actor': 'bob' },
    });

    expect(((await response.json()) as PageJson).items).toEqual([]);
    await served.application.shutdown();
    await connection.sql`delete from depth_articles where owner_id = 'alice'`;
  });
});

describe('sorting', () => {
  test('ascending, descending and by several columns', async () => {
    expect(titles(await list('sort=views'))).toEqual(['Alpha', 'Gamma 100%', 'Beta']);
    expect(titles(await list('sort=-views'))).toEqual(['Beta', 'Gamma 100%', 'Alpha']);
    expect(titles(await list('sort=-title,views'))).toEqual(['Gamma 100%', 'Beta', 'Alpha']);
  });

  test('a column outside the allowlist is a 422', async () => {
    expect(await status('sort=secret')).toBe(422);
    expect(await status('sort=status')).toBe(422);
    expect(await status('sort=views,')).toBe(422);
    expect(await status('sort=views;drop')).toBe(422);
  });
});

describe('soft-deleted rows', () => {
  test('filters and includes apply to the deleted list too', async () => {
    const resource = defineResource(comments, {
      access: 'public',
      filterable: { body: ['eq'] },
      relations: { article: belongsTo(articles, { columns: ['title'] }) },
    });
    const served = await serve([resource]);
    const deleted = async (query: string) => {
      const response = await served.http.request(`/api/v1/depth-comments/deleted?${query}`);
      return ((await response.json()) as { items: { body: string; article?: unknown }[] }).items;
    };

    expect(await deleted('filter[body][eq]=kept')).toEqual([]);
    expect(await deleted('filter[body][eq]=gone&include=article')).toMatchObject([
      { body: 'gone', article: { title: 'Beta' } },
    ]);
    await served.application.shutdown();
  });
});

describe('definition checks', () => {
  test('a hidden column can be neither filtered nor sorted', () => {
    expect(() =>
      defineResource(articles, { access: 'public', hidden: ['secret'], filterable: { secret: true } }),
    ).toThrow(/secret/);
    expect(() => defineResource(articles, { access: 'public', hidden: ['secret'], sortable: ['secret'] })).toThrow(
      /secret/,
    );
  });

  test('rejects unknown columns and operators a column cannot support', () => {
    // @ts-expect-error not a column
    expect(() => defineResource(articles, { access: 'public', filterable: { nope: true } })).toThrow(/nope/);
    // @ts-expect-error not a column
    expect(() => defineResource(articles, { access: 'public', sortable: ['nope'] })).toThrow(/nope/);
    expect(() => defineResource(articles, { access: 'public', filterable: { status: ['gte'] } })).toThrow(/gte/);
    expect(() => defineResource(articles, { access: 'public', filterable: { views: ['contains'] } })).toThrow(
      /contains/,
    );
    expect(() => defineResource(articles, { access: 'public', filterable: { meta: true } })).toThrow(/meta/);
  });

  test('a custom query schema cannot be combined with the generated one', () => {
    expect(() =>
      defineResource(articles, {
        access: 'public',
        sortable: ['views'],
        schemas: { query: z.object({ page: z.coerce.number() }) },
      }),
    ).toThrow(/schemas\.query/);
  });

  test('a relation needs one unambiguous foreign key', () => {
    expect(() =>
      defineResource(reviews, {
        access: 'public',
        relations: { author: belongsTo(authors, { columns: ['name'] }) },
      }),
    ).toThrow(/foreignKey/);
    expect(
      defineResource(reviews, {
        access: 'public',
        relations: { author: belongsTo(authors, { columns: ['name'], foreignKey: 'writerId' }) },
      }),
    ).toBeDefined();
    expect(() =>
      defineResource(authors, {
        access: 'public',
        relations: { comments: hasMany(comments, { columns: ['body'] }) },
      }),
    ).toThrow(/foreign key/i);
  });

  test('a relation cannot select a column that does not exist', () => {
    expect(() =>
      defineResource(articles, {
        access: 'public',
        // @ts-expect-error not a column of authors
        relations: { author: belongsTo(authors, { columns: ['nope'] }) },
      }),
    ).toThrow(/nope/);
  });

  test('relations need an id in the response', () => {
    expect(() =>
      defineResource(articles, {
        access: 'public',
        schemas: { response: z.object({ title: z.string() }) },
        relations: { author: belongsTo(authors, { columns: ['name'] }) },
      }),
    ).toThrow(/id/);
  });
});

describe('include', () => {
  test('nothing is included unless asked for', async () => {
    const page = await list('sort=views');

    expect(page.items[0]).not.toHaveProperty('author');
    expect(page.items[0]).not.toHaveProperty('comments');
    expect(page.items[0]).not.toHaveProperty('secret');
  });

  test('belongsTo returns only the allowlisted columns, and null without a row', async () => {
    const page = await list('sort=views&include=author');

    expect(page.items.map((item) => item.author)).toEqual([
      { id: adaId, name: 'Ada' },
      null,
      { id: graceId, name: 'Grace' },
    ]);
  });

  test('hasMany groups per row, skips soft-deleted rows and caps each parent', async () => {
    const page = await list('sort=views&include=comments');
    const bodies = (item: ArticleJson | undefined) =>
      ((item?.comments ?? []) as { body: string }[]).map(({ body }) => body);

    expect(bodies(page.items[0]).length).toBe(2);
    expect(bodies(page.items[1])).toEqual([]);
    expect(bodies(page.items[2])).toEqual(['kept']);
    expect(page.items[2]?.comments).toEqual([{ id: expect.any(String), body: 'kept' }]);
  });

  test('where scopes the included rows to the caller', async () => {
    const mine = defineResource(articles, {
      access: 'public',
      name: 'ScopedArticle',
      path: '/scoped-articles',
      relations: {
        author: belongsTo(authors, {
          columns: ['name'],
          where: ({ execution }) => eq(authors.name, execution.actor.id ?? ''),
        }),
        comments: hasMany(comments, {
          columns: ['body'],
          where: ({ execution }) => eq(comments.body, execution.actor.id ?? ''),
        }),
      },
    });
    const served = await serve([mine]);
    const included = async (actor: string) => {
      const response = await served.http.request(`/api/v1/scoped-articles/${first.id}?include=author,comments`, {
        headers: { 'x-actor': actor },
      });
      return (await response.json()) as ArticleJson;
    };

    expect(await included('Ada')).toMatchObject({ author: { name: 'Ada' }, comments: [] });
    expect(await included('one')).toMatchObject({ author: null, comments: [{ body: 'one' }] });
    await served.application.shutdown();
  });

  test('a related column may share a name with the query internals', async () => {
    const ranked = defineResource(comments, {
      access: 'public',
      name: 'RankedComment',
      path: '/ranked-comments',
      relations: { article: belongsTo(articles, { columns: ['rank'] }) },
    });
    const parent = defineResource(authors, {
      access: 'public',
      name: 'RankedAuthor',
      path: '/ranked-authors',
      hidden: ['passwordHash'],
      relations: { articles: hasMany(articles, { columns: ['rank'] }) },
    });
    const served = await serve([ranked, parent]);

    const response = await served.http.request(`/api/v1/ranked-authors/${adaId}?include=articles`);

    expect(((await response.json()) as { articles: unknown }).articles).toEqual([{ rank: 7 }]);
    await served.application.shutdown();
  });

  test('several relations at once, combined with filters', async () => {
    const page = await list('include=author,comments&filter[status][eq]=draft');

    expect(page.items[0]?.author).toEqual({ id: adaId, name: 'Ada' });
    expect(page.items[0]?.comments).toHaveLength(2);
  });

  test('works on a single row', async () => {
    const response = await http.request(`${BASE}/${first.id}?include=author`);

    expect(((await response.json()) as ArticleJson).author).toEqual({ id: adaId, name: 'Ada' });
  });

  test('an unknown relation is a 422', async () => {
    expect(await status('include=secrets')).toBe(422);
    expect((await http.request(`${BASE}/${first.id}?include=secrets`)).status).toBe(422);
    expect((await http.request(`${BASE}/${first.id}?nope=1`)).status).toBe(422);
  });
});

describe('types and documentation', () => {
  test('the RPC client knows the filters, sort, include and included rows', async () => {
    const client = hc<typeof articlesResource.routes.app>(`http://local${BASE}`, {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => http.request(input as string, init),
    });

    const page = await (
      await client.index.$get({ query: { 'filter[status][eq]': 'draft', sort: '-views', include: 'author,comments' } })
    ).json();
    const name: string | undefined = page.items[0]?.author?.name;
    const body: string | undefined = page.items[0]?.comments?.[0]?.body;

    expect(name).toBe('Ada');
    expect(body).toBeString();

    // @ts-expect-error not an allowlisted column of authors
    expect(page.items[0]?.author?.email).toBeUndefined();
    // @ts-expect-error not an allowlisted filter
    await client.index.$get({ query: { 'filter[secret][eq]': 'x' } }).catch(() => undefined);

    const one = await (await client[':id'].$get({ param: { id: first.id }, query: { include: 'author' } })).json();
    expect(one.author?.name).toBe('Ada');
  });

  test('OpenAPI documents enums, filters, sort and include', () => {
    const document = generateOpenApiDocument({
      title: 'Depth',
      version: '1.0.0',
      operations: articlesResource.operations,
    });
    const path = document.paths[BASE] as unknown as {
      get: { parameters: { name: string; schema: { enum?: string[] } }[] };
    };
    const parameters = path.get.parameters;
    const names = parameters.map((parameter) => parameter.name);

    expect(names).toContain('filter[status][eq]');
    expect(names).toContain('filter[views][gte]');
    expect(names).toContain('sort');
    expect(names).toContain('include');
    expect(names).not.toContain('filter[secret][eq]');
    expect(parameters.find((parameter) => parameter.name === 'filter[status][eq]')?.schema.enum).toEqual([
      'draft',
      'published',
    ]);
  });
});

describe('defineListQuery', () => {
  test('hand-written modules get the same schema and query options', () => {
    const query = defineListQuery(articles, { filterable: { views: ['gte'] }, sortable: ['views'] });

    const parsed = query.schema.parse({ 'filter[views][gte]': '5', sort: '-views', limit: '10' });
    const options = query.toOptions(parsed);

    expect(parsed).toMatchObject({ page: 1, limit: 10 });
    expect(options.filters).toHaveLength(1);
    expect(options.sort).toEqual([{ column: articles.views, direction: 'desc' }]);
    expect(query.schema.safeParse({ 'filter[views][lte]': '5' }).success).toBe(false);
  });
});
