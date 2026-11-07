import type { JsonObject } from '@framework/core';
import type { Page, PageRequest, QueryOptions } from '@framework/database';
import { mapPage } from '@framework/database';
import type { PageResponse, ResourceEntity } from './contracts';
import type { ResourceService } from './service';

/**
 * Generic controller: maps validated HTTP input to service calls and
 * serializes public output. Concrete modules keep their native Hono route
 * declarations (for RPC inference) and delegate to these handlers.
 */
export class ResourceController<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
  TResponse = TEntity,
> {
  constructor(
    protected readonly service: ResourceService<TEntity, TCreate, TUpdate>,
    private readonly serialize: (entity: TEntity) => TResponse = (entity) => entity as unknown as TResponse,
  ) {}

  list(request: PageRequest, query: QueryOptions = {}): Promise<PageResponse<TResponse>> {
    return this.service.list(request, query).then((page: Page<TEntity>) => mapPage(page, this.serialize));
  }

  deleted(request: PageRequest, query: QueryOptions = {}): Promise<PageResponse<TResponse>> {
    return this.service.listDeleted(request, query).then((page: Page<TEntity>) => mapPage(page, this.serialize));
  }

  async show(id: TEntity['id']): Promise<TResponse> {
    return this.serialize(await this.service.get(id));
  }

  showDeleted(id: TEntity['id']): Promise<TResponse> {
    return this.service.getDeleted(id).then((entity: TEntity) => this.serialize(entity));
  }

  async store(input: TCreate): Promise<TResponse> {
    return this.serialize(await this.service.create(input));
  }

  async update(id: TEntity['id'], input: TUpdate): Promise<TResponse> {
    return this.serialize(await this.service.update(id, input));
  }

  async destroy(id: TEntity['id']): Promise<void> {
    await this.service.delete(id);
  }

  async restore(id: TEntity['id']): Promise<TResponse> {
    return this.serialize(await this.service.restore(id));
  }
}
