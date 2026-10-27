import { ANONYMOUS_ACTOR, ExecutionContext, FrameworkError, type JsonObject } from '@framework/core';
import type { Page, PageRequest, QueryOptions, TransactionContext } from '@framework/database';
import { createDomainEvent, type EventBus } from '@framework/events';
import { badRequest, notFound } from '@framework/http';
import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CrudRepository, EntityId, ResourceEntity } from './contracts';

/**
 * The shared request context every service receives — the same instance its
 * repositories hold, so controller -> service -> repository see one actor and
 * one transaction chain. `transactions` is optional so plain services run
 * without infrastructure; `DataContext` from `@framework/database` satisfies
 * this structurally.
 */
export interface ServiceContext {
  readonly execution: ExecutionContext;
  readonly transactions?: TransactionContext;
}

/** Context used when none is injected (scripts, tests, standalone use). */
export const DEFAULT_SERVICE_CONTEXT: ServiceContext = {
  execution: new ExecutionContext('command', 'standalone', ANONYMOUS_ACTOR),
};

/** Row-level ownership configuration produced by {@link ownedBy}. */
export interface OwnershipConfig {
  /** Entity property carrying the owner's actor id (e.g. `userId`). */
  readonly field: string;
}

/**
 * Declares row-level ownership for a resource: rows carry their owner's
 * actor id in `field`. Every list/get/update/delete/restore/import on the
 * service is then scoped to the acting user — cross-owner access surfaces
 * as 404 (existence is never disclosed), and writes stamp the acting user
 * as the owner.
 *
 * ```ts
 * class DocumentService extends ResourceService<Document, DocumentCreate> {
 *   // via options: { ownership: ownedBy('userId') }
 * }
 * ```
 */
export const ownedBy = (field: string): OwnershipConfig => ({ field });

export interface ResourceServiceOptions<TEntity extends ResourceEntity> {
  /**
   * Event channel (usually the resource name). Entity events
   * (`<channel>.created|updated|deleted|restored|imported`) are published
   * after every write when `channel`, `bus` and `serialize` are provided.
   */
  readonly channel?: string;
  readonly bus?: EventBus;
  /** Projects an entity onto its public JSON shape for event payloads. */
  readonly serialize?: (entity: TEntity) => JsonObject;
  /** Error thrown when an id has no visible row (default: 404 NOT_FOUND). */
  readonly missing?: (id: EntityId) => Error;
  /** Row-level ownership scope (see {@link ownedBy}). */
  readonly ownership?: OwnershipConfig;
}

export interface ImportSummary {
  readonly created: number;
}

/**
 * Generic service base over a CRUD repository: lifecycle hooks around every
 * operation, optional entity events after the write committed, transaction
 * orchestration through the shared context, and a shared not-found
 * translation. Subclasses override hooks or methods to add business rules;
 * the defaults run as-is.
 *
 * The repository owns its own transactions and audit rows; hooks here run
 * outside the repository's transaction, so they observe committed state —
 * use {@link transaction} to run several writes atomically.
 */
export class ResourceService<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> {
  constructor(
    protected readonly repository: CrudRepository<TEntity, TCreate, TUpdate>,
    /** Shared actor + transaction scope; defaults when omitted, injected per scope in apps. */
    protected readonly context: ServiceContext = DEFAULT_SERVICE_CONTEXT,
    protected readonly options: ResourceServiceOptions<TEntity> = {},
  ) {}

  /** The acting identity and correlation id of the current scope. */
  protected get execution(): ExecutionContext {
    return this.context.execution;
  }

  /**
   * Runs `work` atomically: joins the scope's open transaction or opens one.
   * Without a transaction context (standalone use) `work` simply runs.
   */
  protected transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.context.transactions ? this.context.transactions.transaction(work) : work();
  }

  // -- Ownership scoping --------------------------------------------------------

  /** The owner field when ownership is configured; checked once, cached. */
  #ownerColumn(): { readonly field: string; readonly column: AnyPgColumn } | null {
    const field = this.options.ownership?.field;
    if (!field) return null;
    const column = this.repository.column?.(field);
    if (!column) {
      throw new FrameworkError(
        'OWNERSHIP_COLUMN_UNKNOWN',
        `ownership field "${field}" has no column on the repository — add it to the table / repository`,
      );
    }
    return { field, column };
  }

  /** Acting user id, or null when the scope has no user (jobs, CLI). */
  protected get ownerId(): string | null {
    return this.execution.actor.id;
  }

  /**
   * Query-side scope: `field = <actor>` for user scopes, `false` when the
   * acting scope has no user id — an anonymous/scope-less caller must see
   * nothing, never everything.
   */
  #scopeFilters(): readonly SQL[] {
    const owner = this.#ownerColumn();
    if (!owner) return [];
    const id = this.ownerId;
    return id ? [sql`${owner.column} = ${id}`] : [sql`false`];
  }

  /** Row-side check for single-row operations: a foreign row is "missing". */
  #assertOwned(entity: TEntity): TEntity {
    const owner = this.#ownerColumn();
    if (!owner) return entity;
    const id = this.ownerId;
    if (id !== null && (entity as Record<string, unknown>)[owner.field] === id) return entity;
    // Foreign or owner-less scope: hide the row's existence behind 404.
    this.#missing(entity.id);
  }

  /** Stamps the acting user as the owner of values about to be inserted. */
  #stampOwner<TValues extends JsonObject>(values: TValues): TValues {
    const owner = this.#ownerColumn();
    if (!owner) return values;
    const id = this.ownerId;
    if (id === null) {
      throw new FrameworkError('OWNERSHIP_ACTOR_MISSING', 'cannot create an owned row without an acting user');
    }
    return { ...values, [owner.field]: id } as TValues;
  }

  async list(request: PageRequest, query: QueryOptions = {}): Promise<Page<TEntity>> {
    const page = await this.repository.paginate(request, {
      ...query,
      filters: [...this.#scopeFilters(), ...(query.filters ?? [])],
    });
    return {
      items: page.items,
      meta: {
        page: page.meta.page,
        limit: page.meta.limit,
        total: page.meta.total,
        totalPages: page.meta.totalPages ?? Math.ceil(page.meta.total / (page.meta.limit || 1)),
      },
    };
  }

  async listDeleted(request: PageRequest, query: QueryOptions = {}): Promise<Page<TEntity>> {
    if (!this.repository.paginateDeleted) {
      throw badRequest('This resource does not support soft-delete');
    }
    const page = await this.repository.paginateDeleted(request, {
      ...query,
      filters: [...this.#scopeFilters(), ...(query.filters ?? [])],
    });
    return {
      items: page.items,
      meta: {
        page: page.meta.page,
        limit: page.meta.limit,
        total: page.meta.total,
        totalPages: page.meta.totalPages ?? Math.ceil(page.meta.total / (page.meta.limit || 1)),
      },
    };
  }

  async get(id: TEntity['id']): Promise<TEntity> {
    const entity = await this.repository.findById(id);
    if (!entity) this.#missing(id);
    return this.#assertOwned(entity);
  }

  async getDeleted(id: TEntity['id']): Promise<TEntity> {
    if (!this.repository.findDeletedById) {
      throw badRequest('This resource does not support soft-delete');
    }
    const entity = await this.repository.findDeletedById(id);
    if (!entity) this.#missing(id);
    return this.#assertOwned(entity);
  }

  async create(input: TCreate): Promise<TEntity> {
    const values = this.#stampOwner(await this.beforeCreate(input));
    const entity = await this.repository.create(values);
    await this.afterCreate(entity);
    await this.#publish('created', entity);
    return entity;
  }

  async update(id: TEntity['id'], changes: TUpdate): Promise<TEntity> {
    // Existence + ownership first: a foreign id is 404, and the write below
    // can then only hit the row we just verified.
    await this.get(id);
    const applied = await this.beforeUpdate(id, changes);
    const entity = (await this.repository.update(id, applied)) ?? this.#missing(id);
    await this.afterUpdate(entity);
    await this.#publish('updated', entity);
    return entity;
  }

  async delete(id: TEntity['id']): Promise<void> {
    const entity = await this.get(id);
    await this.beforeDelete(id);
    if (!(await this.repository.delete(id))) this.#missing(id);
    await this.afterDelete(id);
    await this.#publish('deleted', entity);
  }

  async restore(id: TEntity['id']): Promise<TEntity> {
    if (!this.repository.restore) throw badRequest('This resource does not support restore');
    if (this.repository.findDeletedById) {
      await this.getDeleted(id);
    }
    return this.transaction(async () => {
      await this.beforeRestore(id);
      if (!this.repository.restore || !(await this.repository.restore(id))) this.#missing(id);
      const entity = await this.get(id);
      await this.afterRestore(entity);
      await this.#publish('restored', entity);
      return entity;
    });
  }

  /** Bulk insert used by the import pipeline; publishes one event per row. */
  async import(rows: readonly TCreate[]): Promise<ImportSummary> {
    const prepared = await this.beforeImport(rows);
    const values = prepared.map((row) => this.#stampOwner(row));
    if (values.length === 0) return { created: 0 };
    const entities = await this.transaction(() => this.repository.createMany(values));
    await this.afterImport(entities);
    for (const entity of entities) await this.#publish('imported', entity);
    return { created: entities.length };
  }

  // -- Lifecycle hooks (override in subclasses; defaults are no-ops)

  protected beforeCreate(input: TCreate): Promise<TCreate> | TCreate {
    return input;
  }

  protected afterCreate(_entity: TEntity): Promise<void> | void {}

  protected beforeUpdate(_id: TEntity['id'], changes: TUpdate): Promise<TUpdate> | TUpdate {
    return changes;
  }

  protected afterUpdate(_entity: TEntity): Promise<void> | void {}

  protected beforeDelete(_id: TEntity['id']): Promise<void> | void {}

  protected afterDelete(_id: TEntity['id']): Promise<void> | void {}

  protected beforeRestore(_id: TEntity['id']): Promise<void> | void {}

  protected afterRestore(_entity: TEntity): Promise<void> | void {}

  protected beforeImport(rows: readonly TCreate[]): Promise<readonly TCreate[]> | readonly TCreate[] {
    return rows;
  }

  protected afterImport(_entities: readonly TEntity[]): Promise<void> | void {}

  #missing(id: unknown): never {
    throw this.options.missing ? this.options.missing(id as EntityId) : notFound(`Resource ${String(id)} not found`);
  }

  async #publish(verb: string, entity: TEntity): Promise<void> {
    const { bus, channel, serialize } = this.options;
    if (!bus || !channel || !serialize) return;
    await bus.publish(createDomainEvent(channel, verb, serialize(entity), this.context.execution));
  }
}
