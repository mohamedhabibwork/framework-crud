import type { JsonObject, JsonValue } from '@framework/core';
import type { FindManyOptions, Page, PageMeta, PageRequest, QueryOptions } from '@framework/database';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Primary keys the CRUD layer supports (single-column, string or number). */
export type EntityId = string | number;

/** Every entity driven through the generic CRUD layers carries its id. */
export interface ResourceEntity<TId = unknown> {
  readonly id: TId;
}

export type { FindManyOptions, Page, PageMeta, PageRequest, QueryOptions };

/** Page shape accepted from repositories (totalPages optional for custom/mock repos). */
export interface RepositoryPageMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages?: number;
}

export interface RepositoryPage<T> {
  readonly items: readonly T[];
  readonly meta: RepositoryPageMeta;
}

/** Serialized page shape returned by controllers (`items` + `meta`). */
export type PageResponse<T> = {
  readonly items: readonly T[];
  readonly meta: PageMeta;
};

/**
 * What the generic service needs from a repository. Repositories composed
 * from the framework mixins (`Readable`, `Creatable`, `Updatable`,
 * `Deletable`/`SoftDeletable`) satisfy this structurally; `restore` and
 * `batches` exist only on some compositions and are therefore optional.
 */
export interface CrudRepository<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> {
  findById(id: TEntity['id']): Promise<TEntity | null>;
  paginate(request: PageRequest, query?: QueryOptions): Promise<Page<TEntity> | RepositoryPage<TEntity>>;
  create(values: TCreate): Promise<TEntity>;
  createMany(values: readonly TCreate[]): Promise<TEntity[]>;
  update(id: TEntity['id'], changes: TUpdate): Promise<TEntity | null>;
  delete(id: TEntity['id']): Promise<boolean>;
  restore?(id: TEntity['id']): Promise<boolean>;
  paginateDeleted?(request: PageRequest, query?: QueryOptions): Promise<Page<TEntity> | RepositoryPage<TEntity>>;
  findDeletedById?(id: TEntity['id']): Promise<TEntity | null>;
  findManyDeleted?(query?: FindManyOptions): Promise<readonly TEntity[]>;
  batches?(size: number, query?: QueryOptions): AsyncGenerator<readonly TEntity[], void, undefined>;
  /**
   * Column reference for query-side scoping (ownership filters). Framework
   * mixin repositories provide it; optional so custom repositories without
   * it stay valid (they just cannot be ownership-scoped).
   */
  column?(field: string): AnyPgColumn | undefined;
}

/** Rows accepted by the CSV/JSON import pipeline. */
export type ImportRow = JsonObject;
export type ExportRow = JsonObject;
export type JsonRecord = Record<string, JsonValue>;
