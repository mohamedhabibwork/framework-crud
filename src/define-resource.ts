import { defineProvider, type JsonObject, type ServiceProvider, type Token, token } from '@framework/core';
import {
  baseRepository,
  type CrudTable,
  createSelectSchema,
  DATA_CONTEXT,
  type DataContext,
  type InsertOf,
  type Page,
  type SelectOf,
  toJsonRow,
} from '@framework/database';
import { EVENT_BUS } from '@framework/events';
import {
  type AppModule,
  authenticatedPolicy,
  authorize,
  denyAll,
  type FrameworkEnv,
  type ResourcePolicy,
  requireAuth,
  resolve,
} from '@framework/http';
import type { Operation } from '@framework/openapi';
import { validate } from '@framework/validation';
import { getTableName } from 'drizzle-orm';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JSONParsed } from 'hono/utils/types';
import { z } from 'zod/v4';
import type { CrudRepository, ResourceEntity } from './contracts';
import { ResourceController } from './controller';
import { resourceOperations } from './openapi';
import { resolveResourceSchemas } from './schema-resolver';
import { ownedBy, ResourceService, type ResourceServiceOptions, type ServiceContext } from './service';

type SystemColumn = 'id' | 'createdAt' | 'updatedAt' | 'deletedAt';
type Row<TTable extends CrudTable> = SelectOf<TTable>;
type WritableColumns<TTable extends CrudTable, TReadOnly extends string> = Omit<
  InsertOf<TTable>,
  SystemColumn | TReadOnly
>;

/** The JSON-object schema every default falls back to; `create` and `update` must produce objects. */
type ObjectSchema<TOutput extends object> = z.ZodType<TOutput, TOutput>;

/** An endpoint in Hono's route schema, so `hc<typeof routes>` infers it. */
type Endpoint<TInput, TOutput, TStatus extends ContentfulStatusCode> = {
  input: TInput;
  output: JSONParsed<TOutput>;
  outputFormat: 'json';
  status: TStatus;
};

type IdParam = { param: { id: string } };

/** Query values arrive as strings; the query schema coerces them. */
type QueryInput<TQuery extends z.ZodType> = {
  query: { [K in keyof z.input<TQuery>]?: string };
};

type ResourceSchema<
  TQuery extends z.ZodType,
  TCreate extends z.ZodType,
  TUpdate extends z.ZodType,
  TResponse extends z.ZodType,
> = {
  '/': {
    $get: Endpoint<QueryInput<TQuery>, Page<z.output<TResponse>>, 200>;
    $post: Endpoint<{ json: z.input<TCreate> }, z.output<TResponse>, 201>;
  };
  '/:id': {
    $get: Endpoint<IdParam, z.output<TResponse>, 200>;
    $patch: Endpoint<IdParam & { json: z.input<TUpdate> }, z.output<TResponse>, 200>;
    $delete: { input: IdParam; output: null; outputFormat: 'body'; status: 204 };
  };
};

/** The resource's Hono app, carrying its route types for RPC clients. */
export type ResourceRoutes<
  TQuery extends z.ZodType,
  TCreate extends z.ZodType,
  TUpdate extends z.ZodType,
  TResponse extends z.ZodType,
> = Hono<FrameworkEnv, ResourceSchema<TQuery, TCreate, TUpdate, TResponse>, '/'>;

type RepositoryClass<TTable extends CrudTable> = new (
  table: TTable,
  context: DataContext,
) => CrudRepository<Row<TTable>, JsonObject, Partial<JsonObject>>;

/** Written against the schema's output in practice; the resource hands it validated input. */
// oxlint-disable-next-line typescript/no-explicit-any -- subclasses narrow TCreate/TUpdate to their own DTOs
type AnyResourceService<TEntity extends ResourceEntity> = ResourceService<TEntity, any, any>;

type ServiceClass<TEntity extends ResourceEntity> = new (
  // oxlint-disable-next-line typescript/no-explicit-any -- matches AnyResourceService
  repository: CrudRepository<TEntity, any, any>,
  context: ServiceContext,
  options: ResourceServiceOptions<TEntity>,
) => AnyResourceService<TEntity>;

type ControllerClass<TEntity extends ResourceEntity, TOutput> = new (
  service: AnyResourceService<TEntity>,
  serialize: (entity: TEntity) => TOutput,
  // oxlint-disable-next-line typescript/no-explicit-any -- matches AnyResourceService
) => ResourceController<TEntity, any, any, TOutput>;

export interface DefineResourceOptions<
  TTable extends CrudTable,
  THidden extends string,
  TOwner extends string,
  TQuery extends z.ZodType,
  TCreate extends z.ZodType,
  TUpdate extends z.ZodType,
  TResponse extends z.ZodType,
> {
  /** `public`, `authenticated` (401 for anonymous callers), or your own policy. */
  readonly access: 'public' | 'authenticated' | ResourcePolicy;
  /** The singular resource name in OpenAPI. Defaults to the table's name, singular and in PascalCase. */
  readonly name?: string;
  /** Mount path under the app's API prefix. Defaults to the table's name in kebab-case. */
  readonly path?: string;
  /** Prefix the documented paths assume. Defaults to `/api/v1`, like `defineApp`. */
  readonly apiPrefix?: string;
  /** Scopes every operation to the acting user, who is stamped as owner on create. */
  readonly ownedBy?: TOwner & keyof Row<TTable>;
  /**
   * Columns left out of the default response and of what clients may write.
   * New columns are public unless listed here or `schemas.response` is set.
   */
  readonly hidden?: readonly (THidden & keyof Row<TTable>)[];
  /** Each defaults to one derived from the table. `response` is an allowlist: only its keys reach clients. */
  readonly schemas?: {
    readonly query?: TQuery;
    readonly create?: TCreate;
    readonly update?: TUpdate;
    readonly response?: TResponse;
  };
  /** Replaces the default projection of `schemas.response`'s keys. */
  readonly toResponse?: (row: Row<TTable>) => z.output<TResponse>;
  readonly repository?: RepositoryClass<TTable>;
  readonly service?: ServiceClass<Row<TTable>>;
  readonly controller?: ControllerClass<Row<TTable>, z.output<TResponse>>;
}

export interface Resource<
  TTable extends CrudTable,
  TQuery extends z.ZodType,
  TCreate extends z.ZodType,
  TUpdate extends z.ZodType,
  TResponse extends z.ZodType,
> extends AppModule<object, Operation> {
  readonly providers: readonly ServiceProvider<object>[];
  readonly routes: { readonly path: string; readonly app: ResourceRoutes<TQuery, TCreate, TUpdate, TResponse> };
  readonly operations: readonly Operation[];
  readonly policy: ResourcePolicy;
  readonly schemas: {
    readonly query: TQuery;
    readonly create: TCreate;
    readonly update: TUpdate;
    readonly response: TResponse;
    readonly param: z.ZodObject<{ id: z.ZodType }>;
  };
  readonly toResponse: (row: Row<TTable>) => z.output<TResponse>;
  /** Bindings the provider registers; replace one with `container.override`. */
  readonly tokens: {
    readonly repository: Token<CrudRepository<Row<TTable>, JsonObject, Partial<JsonObject>>>;
    readonly service: Token<AnyResourceService<Row<TTable>>>;
    readonly controller: Token<ResourceController<Row<TTable>, JsonObject, Partial<JsonObject>, z.output<TResponse>>>;
  };
}

const allow = (): boolean => true;

/** The abilities a resource routes are open; every other ability keeps the deny-all default. */
const publicPolicy: ResourcePolicy = {
  ...denyAll,
  viewAny: allow,
  view: allow,
  create: allow,
  update: allow,
  delete: allow,
  restore: allow,
};

const pascalSingular = (table: string): string => {
  const words = table.split(/[_-]/).map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  const last = (words.at(-1) as string)
    .replace(/ies$/, 'y')
    .replace(/(s|x|z|ch|sh)es$/, '$1')
    .replace(/([^s])s$/, '$1');
  return [...words.slice(0, -1), last].join('');
};

/**
 * One table, one call: the repository, service, controller, routes, policy and
 * OpenAPI operations of a CRUD resource, as a module for `defineApp`. Every
 * part can be replaced through these options, or per binding with
 * `container.override` and {@link Resource.tokens}.
 *
 * ```ts
 * export const notes = defineResource(notesTable, { access: 'authenticated', ownedBy: 'authorId' });
 * // hc<typeof notes.routes.app>('/api/v1/notes') is fully typed
 * ```
 */
export function defineResource<
  TTable extends CrudTable,
  const THidden extends string = never,
  const TOwner extends string = never,
  TQuery extends z.ZodType = ObjectSchema<{ page?: number; limit?: number }>,
  TCreate extends z.ZodType = ObjectSchema<WritableColumns<TTable, THidden | TOwner>>,
  TUpdate extends z.ZodType = ObjectSchema<Partial<WritableColumns<TTable, THidden | TOwner>>>,
  TResponse extends z.ZodType = ObjectSchema<Omit<Row<TTable>, 'deletedAt' | THidden>>,
>(
  table: TTable,
  options: DefineResourceOptions<TTable, THidden, TOwner, TQuery, TCreate, TUpdate, TResponse>,
): Resource<TTable, TQuery, TCreate, TUpdate, TResponse> {
  const tableName = getTableName(table);
  const resource = options.name ?? pascalSingular(tableName);
  const path = options.path ?? `/${tableName.replaceAll('_', '-')}`;
  const softDelete = 'deletedAt' in table;
  const { access, schemas: given = {} } = options;

  const derived = resolveResourceSchemas(table, {
    readOnly: [...(options.hidden ?? []), ...(options.ownedBy ? [options.ownedBy] : [])],
    ...(given.create ? { createSchema: given.create } : {}),
    ...(given.update ? { updateSchema: given.update } : {}),
    ...(given.query ? { querySchema: given.query as unknown as z.ZodObject<z.ZodRawShape> } : {}),
  });
  const hidden = ['deletedAt', ...(options.hidden ?? [])];
  const response =
    given.response ??
    (createSelectSchema(table) as unknown as z.ZodObject<z.ZodRawShape>).omit(
      Object.fromEntries(hidden.filter((key) => key in table).map((key) => [key, true])) as never,
    );
  const responseKeys = response instanceof z.ZodObject ? Object.keys(response.shape) : undefined;
  const toResponse =
    options.toResponse ??
    ((row: Row<TTable>) => {
      const json = toJsonRow(row as object);
      return (
        responseKeys
          ? Object.fromEntries(responseKeys.filter((key) => key in json).map((key) => [key, json[key]]))
          : json
      ) as z.output<TResponse>;
    });

  const policy: ResourcePolicy =
    access === 'public' ? publicPolicy : access === 'authenticated' ? authenticatedPolicy : access;
  const tokens = {
    repository: token<CrudRepository<Row<TTable>, JsonObject, Partial<JsonObject>>>(
      `${tableName}.${resource}.repository`,
    ),
    service: token<AnyResourceService<Row<TTable>>>(`${tableName}.${resource}.service`),
    controller: token<ResourceController<Row<TTable>, JsonObject, Partial<JsonObject>, z.output<TResponse>>>(
      `${tableName}.${resource}.controller`,
    ),
  };

  const provider = defineProvider<object>({
    // Scoped bindings resolve per request, so nothing here constrains boot order.
    name: `${tableName}.${resource}`,
    register({ container }) {
      const Repository = options.repository;
      container.scoped(tokens.repository, (r) => {
        const context = r.resolve(DATA_CONTEXT);
        return (Repository ? new Repository(table, context) : baseRepository(table, context)) as CrudRepository<
          Row<TTable>,
          JsonObject,
          Partial<JsonObject>
        >;
      });
      const Service = options.service ?? (ResourceService as unknown as ServiceClass<Row<TTable>>);
      container.scoped(
        tokens.service,
        (r) =>
          new Service(r.resolve(tokens.repository), r.resolve(DATA_CONTEXT), {
            channel: tableName,
            ...(r.has(EVENT_BUS)
              ? { bus: r.resolve(EVENT_BUS), serialize: (entity: Row<TTable>) => toResponse(entity) as JsonObject }
              : {}),
            ...(options.ownedBy ? { ownership: ownedBy(options.ownedBy) } : {}),
          }),
      );
      const Controller =
        options.controller ?? (ResourceController as unknown as ControllerClass<Row<TTable>, z.output<TResponse>>);
      container.scoped(
        tokens.controller,
        (r) =>
          new Controller(r.resolve(tokens.service), toResponse) as ResourceController<
            Row<TTable>,
            JsonObject,
            Partial<JsonObject>,
            z.output<TResponse>
          >,
      );
    },
  });

  const controller = (c: Context<FrameworkEnv>) => resolve(c, tokens.controller);
  const check = (target: 'json' | 'query' | 'param', schema: z.ZodType) =>
    validate(target, schema) as unknown as MiddlewareHandler<FrameworkEnv>;
  const param = check('param', derived.paramSchema);
  const query = check('query', derived.querySchema);
  const pathId = (c: Context<FrameworkEnv>) => c.req.param('id') as string;
  const valid = <T>(c: Context<FrameworkEnv>, target: 'json' | 'query'): T =>
    (c.req as unknown as { valid(target: string): T }).valid(target);

  const app = new Hono<FrameworkEnv>();
  // Per-route order, as in generated modules: validation -> authentication -> authorization -> handler.
  const route = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    routePath: string,
    ability: keyof ResourcePolicy,
    validators: readonly MiddlewareHandler<FrameworkEnv>[],
    handler: (c: Context<FrameworkEnv>) => Promise<Response>,
  ) =>
    app.on(
      method,
      [routePath],
      ...validators,
      ...(access === 'authenticated' ? [requireAuth()] : []),
      authorize(policy, ability),
      handler,
    );

  route('GET', '/', 'viewAny', [query], async (c) => c.json(await controller(c).list(valid(c, 'query')), 200));
  route('POST', '/', 'create', [check('json', derived.createSchema)], async (c) =>
    c.json(await controller(c).store(valid(c, 'json')), 201),
  );
  if (softDelete) {
    // Static segments first, so `/deleted` is never captured as an id.
    route('GET', '/deleted', 'restore', [query], async (c) =>
      c.json(await controller(c).deleted(valid(c, 'query')), 200),
    );
    route('GET', '/deleted/:id', 'restore', [param], async (c) =>
      c.json(await controller(c).showDeleted(pathId(c)), 200),
    );
    route('POST', '/:id/restore', 'restore', [param], async (c) => c.json(await controller(c).restore(pathId(c)), 200));
  }
  route('GET', '/:id', 'view', [param], async (c) => c.json(await controller(c).show(pathId(c)), 200));
  route('PATCH', '/:id', 'update', [param, check('json', derived.updateSchema)], async (c) =>
    c.json(await controller(c).update(pathId(c), valid(c, 'json')), 200),
  );
  route('DELETE', '/:id', 'delete', [param], async (c) => {
    await controller(c).destroy(pathId(c));
    return c.body(null, 204);
  });

  const schemas = {
    query: derived.querySchema as unknown as TQuery,
    create: derived.createSchema as unknown as TCreate,
    update: derived.updateSchema as unknown as TUpdate,
    response: response as unknown as TResponse,
    param: derived.paramSchema,
  };

  return {
    name: `${tableName}.${resource}`,
    providers: [provider],
    routes: { path, app: app as unknown as ResourceRoutes<TQuery, TCreate, TUpdate, TResponse> },
    operations: resourceOperations({
      mount: `${options.apiPrefix ?? '/api/v1'}${path}`,
      resource,
      security: access === 'public' ? 'public' : ['sessionCookie', 'bearerAuth'],
      softDelete,
      schemas: {
        create: derived.createSchema,
        update: derived.updateSchema,
        response,
        query: derived.querySchema,
        param: derived.paramSchema,
      },
    } as Parameters<typeof resourceOperations>[0]),
    policy,
    schemas,
    toResponse,
    tokens,
  };
}
