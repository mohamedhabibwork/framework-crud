import type { JsonObject } from '@framework/core';
import {
  baseRepository,
  type CrudTable,
  type DataContext,
  type InsertOf,
  type RepositoryOptions,
  type SelectOf,
  toJsonRow,
} from '@framework/database';
import { EVENT_BUS, type EventBus } from '@framework/events';
import { getTableName } from 'drizzle-orm';
import type { CrudRepository, ResourceEntity } from './contracts';
import { DEFAULT_SERVICE_CONTEXT, ResourceService, type ResourceServiceOptions, type ServiceContext } from './service';

export interface BaseServiceOptions<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject = JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> extends ResourceServiceOptions<TEntity> {
  readonly repository?: CrudRepository<TEntity, TCreate, TUpdate>;
  readonly repositoryOptions?: RepositoryOptions;
  readonly container?: { has: (token: unknown) => boolean; resolve: <T>(token: unknown) => T };
}

/**
 * Generic CRUD service extending `ResourceService` over any Drizzle `CrudTable`.
 */
export class BaseService<
  TTable extends CrudTable,
  TCreate extends JsonObject = InsertOf<TTable> & JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> extends ResourceService<SelectOf<TTable>, TCreate, TUpdate> {
  readonly table: TTable;

  constructor(
    table: TTable,
    repository: CrudRepository<SelectOf<TTable>, TCreate, TUpdate>,
    context: ServiceContext = DEFAULT_SERVICE_CONTEXT,
    options: ResourceServiceOptions<SelectOf<TTable>> = {},
  ) {
    super(repository, context, options);
    this.table = table;
  }
}

/**
 * Initializes a default CRUD service over `TTable`.
 * Automatically wires `baseRepository(table, context)` when no repository is passed,
 * and attaches `EVENT_BUS` with channel `getTableName(table)` and JSON serializer if available.
 */
export function baseService<
  TTable extends CrudTable,
  TCreate extends JsonObject = InsertOf<TTable> & JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(
  table: TTable,
  context: DataContext,
  options?: BaseServiceOptions<SelectOf<TTable>, TCreate, TUpdate>,
): BaseService<TTable, TCreate, TUpdate>;

export function baseService<
  TTable extends CrudTable,
  TCreate extends JsonObject = InsertOf<TTable> & JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(
  table: TTable,
  context?: undefined,
  options?: BaseServiceOptions<SelectOf<TTable>, TCreate, TUpdate>,
): (context: DataContext) => BaseService<TTable, TCreate, TUpdate>;

export function baseService<
  TTable extends CrudTable,
  TCreate extends JsonObject = InsertOf<TTable> & JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(
  table: TTable,
  context?: DataContext,
  options?: BaseServiceOptions<SelectOf<TTable>, TCreate, TUpdate>,
): BaseService<TTable, TCreate, TUpdate> | ((context: DataContext) => BaseService<TTable, TCreate, TUpdate>) {
  const create = (ctx: DataContext): BaseService<TTable, TCreate, TUpdate> => {
    const repo =
      options?.repository ??
      (baseRepository(table, ctx, options?.repositoryOptions) as unknown as CrudRepository<
        SelectOf<TTable>,
        TCreate,
        TUpdate
      >);

    let bus: EventBus | undefined = options?.bus;
    if (!bus) {
      const container =
        options?.container ??
        ('container' in ctx ? (ctx as Record<string, unknown>).container : undefined) ??
        ('scope' in ctx ? (ctx as Record<string, unknown>).scope : undefined);
      if (container && typeof container === 'object' && 'has' in container && typeof container.has === 'function') {
        if (container.has(EVENT_BUS)) {
          bus = (container as unknown as { resolve: (token: unknown) => EventBus }).resolve(EVENT_BUS);
        }
      }
    }

    const channel = options?.channel ?? getTableName(table);
    const serialize = options?.serialize ?? ((entity: SelectOf<TTable>) => toJsonRow(entity as object));

    const serviceOptions: ResourceServiceOptions<SelectOf<TTable>> = {
      ...options,
      channel,
      ...(bus ? { bus, serialize } : options?.serialize ? { serialize: options.serialize } : {}),
    };

    return new BaseService<TTable, TCreate, TUpdate>(table, repo, ctx, serviceOptions);
  };

  if (context) {
    return create(context);
  }
  return create;
}
