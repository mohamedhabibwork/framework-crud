import type { CrudTable, SelectOf } from '@framework/database';
import type { FrameworkEnv } from '@framework/http';
import { Hono } from 'hono';
import type { BlankEnv, BlankSchema, Env, Schema } from 'hono/types';
import { type ResourceOptions, resourceRoutes } from './resource-routes';

declare module 'hono/hono-base' {
  interface HonoBase<
    E extends Env = Env,
    S extends Schema = BlankSchema,
    BasePath extends string = '/',
    CurrentPath extends string = BasePath,
  > {
    resource<TTable extends CrudTable, TCreate = unknown, TUpdate = unknown, TResponse = SelectOf<TTable>>(
      path: string,
      table: TTable,
      serviceOrOptions?: unknown,
      options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>,
    ): this;
  }
}

declare module 'hono' {
  interface Hono<E extends Env = BlankEnv, S extends Schema = BlankSchema, BasePath extends string = '/'> {
    resource<TTable extends CrudTable, TCreate = unknown, TUpdate = unknown, TResponse = SelectOf<TTable>>(
      path: string,
      table: TTable,
      serviceOrOptions?: unknown,
      options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>,
    ): this;
  }
}

/**
 * Hono router extension providing `.resource()` method for mounting
 * convention-over-configuration CRUD resource endpoints.
 */
export class ResourceRouter<E extends Env = FrameworkEnv> extends Hono<E> {
  override resource<TTable extends CrudTable, TCreate = unknown, TUpdate = unknown, TResponse = SelectOf<TTable>>(
    path: string,
    table: TTable,
    serviceOrOptions?: unknown,
    options?: ResourceOptions<TTable, TCreate, TUpdate, TResponse>,
  ): this {
    const subApp = resourceRoutes(table, serviceOrOptions, options);
    this.route(path, subApp);
    return this;
  }
}

/**
 * Creates a new ResourceRouter instance supporting `.resource()`.
 */
export function createRouter<E extends Env = FrameworkEnv>(): ResourceRouter<E> {
  return new ResourceRouter<E>();
}

// Augment Hono.prototype for fluent chaining across all Hono instances
(Hono.prototype as unknown as { resource: unknown }).resource = function (
  path: string,
  table: CrudTable,
  serviceOrOptions?: unknown,
  options?: ResourceOptions,
) {
  const subApp = resourceRoutes(table, serviceOrOptions, options);
  return (this as unknown as { route: (p: string, app: unknown) => unknown }).route(path, subApp);
};
