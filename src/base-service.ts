import type { JsonObject, Resolver } from '@framework/core';
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
  /** Where to look for `EVENT_BUS`; defaults to a `container` or `scope` on the data context. */
  readonly container?: Resolver;
}

const isResolver = (value: unknown): value is Resolver =>
  typeof value === 'object' &&
  value !== null &&
  'has' in value &&
  typeof value.has === 'function' &&
  'resolve' in value &&
  typeof value.resolve === 'function';

/** A resolver some data contexts carry beyond the `DataContext` contract. */
function contextResolver(context: DataContext): Resolver | undefined {
  const { container, scope } = context as DataContext & { container?: unknown; scope?: unknown };
  return [container, scope].find(isResolver);
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
  context?: undefined,
  options?: BaseServiceOptions<SelectOf<TTable>, TCreate, TUpdate>,
): (context: DataContext) => BaseService<TTable, TCreate, TUpdate>;

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

    const resolver = options?.bus ? undefined : (options?.container ?? contextResolver(ctx));
    const bus: EventBus | undefined = resolver?.has(EVENT_BUS) ? resolver.resolve(EVENT_BUS) : options?.bus;

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
