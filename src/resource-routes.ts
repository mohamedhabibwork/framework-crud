import { type JsonObject, type ServiceValue, type Token, token } from '@framework/core';
import { type CrudTable, DATA_CONTEXT, type DataContext, type PageRequest, type SelectOf } from '@framework/database';
import { EVENT_BUS, type EventBus } from '@framework/events';
import { badRequest, type FrameworkEnv, notFound } from '@framework/http';
import { validate } from '@framework/validation';
import { getTableName } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { type Context, Hono } from 'hono';
import { baseService } from './base-service';
import type { CrudRepository } from './contracts';
import { ResourceController } from './controller';
import { type ResourceSchemaOptions, resolveResourceSchemas } from './schema-resolver';
import { DEFAULT_SERVICE_CONTEXT, ResourceService } from './service';

export interface ResourceOptions<
  TTable extends CrudTable = CrudTable,
  TCreate = unknown,
  TUpdate = unknown,
  TResponse = SelectOf<TTable>,
> extends ResourceSchemaOptions<TCreate, TUpdate> {
  readonly service?:
    | ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>
    | CrudRepository<SelectOf<TTable>, JsonObject, Partial<JsonObject>>
    | Token<ServiceValue>
    | ((context?: DataContext) => unknown)
    | unknown;
  readonly serviceToken?: Token<ServiceValue>;
  readonly transform?: (entity: SelectOf<TTable>) => TResponse;
  readonly serialize?: (entity: SelectOf<TTable>) => TResponse;
  readonly toResponse?: (entity: SelectOf<TTable>) => TResponse;
  readonly softDeleteColumn?: AnyPgColumn;
}

const TOKEN_REGISTRY = new Map<string, Token<ServiceValue>>();

/**
 * Returns or creates the convention DI token for a table's resource service (`<tableName>.service`).
 */
export function resourceServiceToken<T extends ServiceValue = ServiceValue>(table: CrudTable | string): Token<T> {
  const name = typeof table === 'string' ? table : getTableName(table);
  const tokenName = `${name}.service`;
  let tok = TOKEN_REGISTRY.get(tokenName) as Token<T> | undefined;
  if (!tok) {
    tok = token<T>(tokenName);
    TOKEN_REGISTRY.set(tokenName, tok as Token<ServiceValue>);
  }
  return tok;
}

/** Checks whether a value is a DI Token. */
export function isToken(value: unknown): value is Token<ServiceValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof (value as { key?: unknown }).key === 'symbol' &&
    'name' in value &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function isService(val: unknown): boolean {
  if (!val) return false;
  if (isToken(val)) return false;
  if (val instanceof ResourceService) return true;
  if (typeof val === 'function') return true;
  if (typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.get === 'function' ||
    typeof obj.list === 'function' ||
    typeof obj.create === 'function' ||
    typeof obj.findById === 'function'
  );
}

function parseResourceArgs<TTable extends CrudTable>(
  _table: TTable,
  serviceOrOptions?: unknown,
  schemasOrOptions?: unknown,
): {
  explicitService?: unknown;
  serviceToken?: Token<ServiceValue>;
  options: ResourceOptions<TTable>;
} {
  let explicitService: unknown;
  let serviceToken: Token<ServiceValue> | undefined;
  let options: ResourceOptions<TTable> = {};

  if (serviceOrOptions !== undefined && serviceOrOptions !== null) {
    if (isToken(serviceOrOptions)) {
      serviceToken = serviceOrOptions;
      if (schemasOrOptions && typeof schemasOrOptions === 'object') {
        options = schemasOrOptions as ResourceOptions<TTable>;
      }
    } else if (isService(serviceOrOptions)) {
      explicitService = serviceOrOptions;
      if (schemasOrOptions && typeof schemasOrOptions === 'object') {
        options = schemasOrOptions as ResourceOptions<TTable>;
      }
    } else if (typeof serviceOrOptions === 'object') {
      options = {
        ...(serviceOrOptions as ResourceOptions<TTable>),
        ...((schemasOrOptions as ResourceOptions<TTable>) ?? {}),
      };
    }
  } else if (schemasOrOptions && typeof schemasOrOptions === 'object') {
    options = schemasOrOptions as ResourceOptions<TTable>;
  }

  if (!explicitService && options.service) {
    if (isToken(options.service)) {
      serviceToken = options.service;
    } else {
      explicitService = options.service;
    }
  }
  if (!serviceToken && options.serviceToken && isToken(options.serviceToken)) {
    serviceToken = options.serviceToken;
  }

  return { explicitService, serviceToken, options };
}

/**
 * Creates a Hono sub-application mounting the 8 REST + lifecycle CRUD endpoints
 * (9 methods) for a given table, with schema validation, DTO transforms,
 * 3-tier DI resolution, and soft-delete support.
 *
 * Route Priority: Static `/deleted` routes (`GET /deleted`, `GET /deleted/:id`)
 * are registered before parameterized `/:id` routes to prevent Hono's RegExpRouter
 * from capturing `/deleted` as `:id`.
 */
export function resourceRoutes<
  TTable extends CrudTable,
  TCreate = unknown,
  TUpdate = unknown,
  TResponse = SelectOf<TTable>,
>(table: TTable, options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>): Hono<FrameworkEnv>;

export function resourceRoutes<
  TTable extends CrudTable,
  TCreate = unknown,
  TUpdate = unknown,
  TResponse = SelectOf<TTable>,
>(
  table: TTable,
  service:
    | ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>
    | CrudRepository<SelectOf<TTable>, JsonObject, Partial<JsonObject>>
    | Token<ServiceValue>
    | ((context?: DataContext) => unknown)
    | unknown,
  options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>,
): Hono<FrameworkEnv>;

export function resourceRoutes<
  TTable extends CrudTable,
  TCreate = unknown,
  TUpdate = unknown,
  TResponse = SelectOf<TTable>,
>(
  table: TTable,
  token: Token<ServiceValue>,
  options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>,
): Hono<FrameworkEnv>;

export function resourceRoutes<
  TTable extends CrudTable,
  _TCreate = unknown,
  _TUpdate = unknown,
  TResponse = SelectOf<TTable>,
>(table: TTable, serviceOrOptions?: unknown, schemasOrOptions?: unknown): Hono<FrameworkEnv> {
  const {
    explicitService: initialService,
    serviceToken,
    options,
  } = parseResourceArgs(table, serviceOrOptions, schemasOrOptions);

  let explicitService = initialService;
  if (
    explicitService &&
    typeof explicitService === 'object' &&
    typeof (explicitService as Record<string, unknown>).findById === 'function' &&
    typeof (explicitService as Record<string, unknown>).get !== 'function'
  ) {
    explicitService = new ResourceService(
      explicitService as CrudRepository<SelectOf<TTable>, JsonObject, Partial<JsonObject>>,
      DEFAULT_SERVICE_CONTEXT,
    );
  }

  const schemas = resolveResourceSchemas(table, options);
  const serializer = (options.transform ?? options.serialize ?? options.toResponse) as
    | ((entity: SelectOf<TTable>) => TResponse)
    | undefined;

  const hasSoftDelete =
    Boolean(options.softDeleteColumn) || ('deletedAt' in table && (table as Record<string, unknown>).deletedAt != null);

  function getService(c: Context<FrameworkEnv>): ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>> {
    // Tier 1: Explicit service
    if (explicitService) {
      if (typeof explicitService === 'function') {
        const scope = c.get('scope');
        const dataContext = scope?.has?.(DATA_CONTEXT) ? scope.resolve(DATA_CONTEXT) : undefined;
        return (explicitService as (ctx?: DataContext) => unknown)(dataContext) as ResourceService<
          SelectOf<TTable>,
          JsonObject,
          Partial<JsonObject>
        >;
      }
      return explicitService as ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>;
    }

    const scope = c.get('scope');

    // Tier 2: Token resolution (explicit or convention)
    if (serviceToken) {
      if (scope && typeof scope.resolve === 'function') {
        return scope.resolve(serviceToken) as ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>;
      }
      throw new Error(`Cannot resolve service token "${serviceToken.name}": request scope is missing`);
    }

    const conventionToken = resourceServiceToken(table);
    if (scope && typeof scope.has === 'function' && scope.has(conventionToken)) {
      return scope.resolve(conventionToken) as ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>;
    }

    // Tier 3: Fallback baseService
    if (scope && typeof scope.resolve === 'function') {
      const dataContext = scope.resolve(DATA_CONTEXT);
      let bus: EventBus | undefined;
      if (scope.has(EVENT_BUS)) {
        bus = scope.resolve(EVENT_BUS);
      }
      return baseService(table as CrudTable, dataContext, {
        bus,
        repositoryOptions: options.softDeleteColumn ? { softDeleteColumn: options.softDeleteColumn } : undefined,
        container: scope as unknown as { has: (t: unknown) => boolean; resolve: <T>(t: unknown) => T },
      }) as unknown as ResourceService<SelectOf<TTable>, JsonObject, Partial<JsonObject>>;
    }

    throw new Error(
      `Cannot resolve service for table "${getTableName(table)}": no explicit service provided and request scope is missing`,
    );
  }

  function getController(
    c: Context<FrameworkEnv>,
  ): ResourceController<SelectOf<TTable>, JsonObject, Partial<JsonObject>, TResponse> {
    const service = getService(c);
    return new ResourceController(service, serializer);
  }

  const app = new Hono<FrameworkEnv>();

  // 1. GET / (paginated active items)
  app.get('/', validate('query', schemas.querySchema), async (c) => {
    const query = c.req.valid('query') as Record<string, unknown>;
    const { page = 1, limit = 20, ...filters } = query;
    const pageRequest: PageRequest = { page: Number(page), limit: Number(limit) };
    const controller = getController(c);
    const result = await controller.list(pageRequest, filters);
    return c.json(result, 200);
  });

  // 2. POST / (create item)
  app.post('/', validate('json', schemas.createSchema), async (c) => {
    const body = c.req.valid('json');
    const controller = getController(c);
    const result = await controller.store(body as JsonObject);
    return c.json(result, 201);
  });

  // 3. GET /deleted (paginated soft-deleted items) — MUST be registered before /:id
  app.get('/deleted', validate('query', schemas.querySchema), async (c) => {
    if (!hasSoftDelete) {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const service = getService(c);
    if (typeof (service as { listDeleted?: unknown }).listDeleted !== 'function') {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const query = c.req.valid('query') as Record<string, unknown>;
    const { page = 1, limit = 20, ...filters } = query;
    const pageRequest: PageRequest = { page: Number(page), limit: Number(limit) };
    const controller = new ResourceController(service, serializer);
    const result = await controller.deleted(pageRequest, filters);
    return c.json(result, 200);
  });

  // 4. GET /deleted/:id (single soft-deleted item) — MUST be registered before /:id
  app.get('/deleted/:id', validate('param', schemas.paramSchema), async (c) => {
    if (!hasSoftDelete) {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const service = getService(c);
    if (typeof (service as { getDeleted?: unknown }).getDeleted !== 'function') {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const { id } = c.req.valid('param');
    const controller = new ResourceController(service, serializer);
    const result = await controller.showDeleted(id);
    if (result == null) {
      throw notFound('Resource not found');
    }
    return c.json(result, 200);
  });

  // 5. GET /:id (single active item)
  app.get('/:id', validate('param', schemas.paramSchema), async (c) => {
    const { id } = c.req.valid('param');
    const controller = getController(c);
    const result = await controller.show(id);
    if (result == null) {
      throw notFound('Resource not found');
    }
    return c.json(result, 200);
  });

  // 6. PATCH /:id (update item)
  app.patch('/:id', validate('param', schemas.paramSchema), validate('json', schemas.updateSchema), async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const controller = getController(c);
    const result = await controller.update(id, body as Partial<JsonObject>);
    if (result == null) {
      throw notFound('Resource not found');
    }
    return c.json(result, 200);
  });

  // 7. DELETE /:id (delete item)
  app.delete('/:id', validate('param', schemas.paramSchema), async (c) => {
    const { id } = c.req.valid('param');
    const controller = getController(c);
    await controller.destroy(id);
    return c.body(null, 204);
  });

  // 8 & 9. POST /:id/restore & PATCH /:id/restore (restore soft-deleted item)
  app.post('/:id/restore', validate('param', schemas.paramSchema), async (c) => {
    if (!hasSoftDelete) {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const service = getService(c);
    if (typeof (service as { restore?: unknown }).restore !== 'function') {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const { id } = c.req.valid('param');
    const controller = new ResourceController(service, serializer);
    const result = await controller.restore(id);
    if (result == null) {
      throw notFound('Resource not found');
    }
    return c.json(result, 200);
  });

  app.patch('/:id/restore', validate('param', schemas.paramSchema), async (c) => {
    if (!hasSoftDelete) {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const service = getService(c);
    if (typeof (service as { restore?: unknown }).restore !== 'function') {
      throw badRequest('Soft delete is not supported for this resource');
    }
    const { id } = c.req.valid('param');
    const controller = new ResourceController(service, serializer);
    const result = await controller.restore(id);
    if (result == null) {
      throw notFound('Resource not found');
    }
    return c.json(result, 200);
  });

  return app;
}
