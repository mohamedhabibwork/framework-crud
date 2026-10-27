import { pageSchema } from '@framework/database';
import { defineOperations, type ErrorStatusCode, type Operation } from '@framework/openapi';
import { jobStatusSchema } from '@framework/queue';
import { z } from 'zod/v4';
import { exportRequestSchema, importRequestSchema, jobIdParamSchema } from './import-export';

/** `202 Accepted` body shared by import/export dispatch endpoints. */
export const dispatchResponseSchema = z.object({ jobId: z.string(), status: z.literal('dispatched') }).strict();

export interface DataOperationsInput {
  /** Mount prefix of the import/export routes, e.g. `/api/v1/data`. */
  readonly mount: string;
  /** Configured resources; when set, request schemas enumerate them. */
  readonly resources?: readonly string[];
  /** `public` is explicit; otherwise list security scheme names (default `public`). */
  readonly security?: 'public' | readonly string[];
}

/**
 * OpenAPI operations for the queued import/export endpoints served by
 * {@link importExportRoutes} — derived from the same schemas the routes
 * validate, so documentation cannot drift from behavior.
 */
export function dataOperations(input: DataOperationsInput): Operation[] {
  const security = input.security ?? 'public';
  const resources = input.resources;
  const importBody =
    resources && resources.length > 0
      ? importRequestSchema.extend({ resource: z.enum(resources) }).strict()
      : importRequestSchema;
  const exportBody =
    resources && resources.length > 0
      ? exportRequestSchema.extend({ resource: z.enum(resources) }).strict()
      : exportRequestSchema;
  const spec = (operation: Omit<Operation, 'fullPath' | 'tag'>): Omit<Operation, 'fullPath' | 'tag'> => operation;
  const dispatchErrors: readonly ErrorStatusCode[] = [404, 422];
  const statusErrors: readonly ErrorStatusCode[] = [404, 422];

  return defineOperations(input.mount, 'Data', [
    spec({
      method: 'post',
      path: '/import',
      operationId: 'dispatchImport',
      summary: 'Queue an import (CSV or JSON rows) for a resource',
      security,
      request: { body: importBody },
      responses: { 202: { description: 'Import dispatched', schema: dispatchResponseSchema } },
      errors: dispatchErrors,
    }),
    spec({
      method: 'get',
      path: '/import/status/:jobId',
      operationId: 'importStatus',
      summary: 'Import job state, progress and row errors',
      security,
      request: { params: jobIdParamSchema },
      responses: { 200: { description: 'The job status', schema: jobStatusSchema } },
      errors: statusErrors,
    }),
    spec({
      method: 'post',
      path: '/export',
      operationId: 'dispatchExport',
      summary: 'Queue an export (CSV or JSON artifact) for a resource',
      security,
      request: { body: exportBody },
      responses: { 202: { description: 'Export dispatched', schema: dispatchResponseSchema } },
      errors: dispatchErrors,
    }),
    spec({
      method: 'get',
      path: '/export/status/:jobId',
      operationId: 'exportStatus',
      summary: 'Export job state and progress',
      security,
      request: { params: jobIdParamSchema },
      responses: { 200: { description: 'The job status', schema: jobStatusSchema } },
      errors: statusErrors,
    }),
    spec({
      method: 'get',
      path: '/export/download/:jobId',
      operationId: 'downloadExport',
      summary: 'Download the finished export artifact',
      security,
      request: { params: jobIdParamSchema },
      responses: { 200: { description: 'The artifact (text/csv or application/json attachment)' } },
      errors: [400, 404, 422],
    }),
  ]);
}

export interface ResourceOperationsInput {
  /** Mount prefix of the module routes, e.g. `/api/v1/products`. */
  readonly mount: string;
  /** Singular PascalCase resource name (e.g. `Product`); operationIds derive from it. */
  readonly resource: string;
  readonly schemas: {
    /** Body the controller's `store` accepts. */
    readonly create: z.ZodType;
    /** Body the controller's `update` accepts. */
    readonly update: z.ZodType;
    /** Public projection every success response returns. */
    readonly response: z.ZodType;
    /** List query (pagination/filter bounds). */
    readonly query?: z.ZodObject;
    /** Primary-key parameter schema. */
    readonly param?: z.ZodObject;
  };
  /** `public` is explicit; otherwise list security scheme names (default `public`). */
  readonly security?: 'public' | readonly string[];
  /** Override the OpenAPI tag (default: the English plural of `resource`). */
  readonly tag?: string;
  /** Whether to document soft-delete endpoints (/deleted, /deleted/:id, /:id/restore). */
  readonly softDelete?: boolean;
}

/** Minimal English pluralization for tags ('Product' -> 'Products', 'Category' -> 'Categories'). */
export function pluralizeResource(resource: string): string {
  if (/(s|x|z|ch|sh)$/i.test(resource)) return `${resource}es`;
  if (/[^aeiou]y$/i.test(resource)) return `${resource.slice(0, -1)}ies`;
  return `${resource}s`;
}

const camelOf = (pascal: string): string => pascal.charAt(0).toLowerCase() + pascal.slice(1);

/**
 * Derives the standard CRUD operations documented for every resource
 * controller — the five endpoints its `list/show/store/update/destroy`
 * handlers serve — from the controller's data contract (the same schemas its
 * routes validate and its responses serialize). Hand-writing per-operation
 * metadata is unnecessary unless an operation deviates; build a custom
 * `OperationSpec` list with `defineOperations` for those.
 */
export function resourceOperations(input: ResourceOperationsInput): Operation[] {
  const { mount, resource, schemas, softDelete } = input;
  const security = input.security ?? 'public';
  const tag = input.tag ?? pluralizeResource(resource);
  const camel = camelOf(resource);
  const plural = camelOf(tag);
  const spec = (operation: Omit<Operation, 'fullPath' | 'tag'>): Omit<Operation, 'fullPath' | 'tag'> => operation;

  const operations: Omit<Operation, 'fullPath' | 'tag'>[] = [
    spec({
      method: 'get',
      path: '/',
      operationId: `list${tag}`,
      summary: `List ${plural}`,
      security,
      ...(schemas.query ? { request: { query: schemas.query } } : {}),
      responses: { 200: { description: `A page of ${plural}`, schema: pageSchema(schemas.response) } },
      errors: [422],
    }),
    spec({
      method: 'post',
      path: '/',
      operationId: `create${resource}`,
      summary: `Create a ${camel}`,
      security,
      request: { body: schemas.create },
      responses: { 201: { description: `The created ${camel}`, schema: schemas.response } },
      errors: [400, 409, 422],
    }),
  ];

  if (softDelete) {
    operations.push(
      spec({
        method: 'get',
        path: '/deleted',
        operationId: `listDeleted${tag}`,
        summary: `List soft-deleted ${plural}`,
        security,
        ...(schemas.query ? { request: { query: schemas.query } } : {}),
        responses: { 200: { description: `A page of soft-deleted ${plural}`, schema: pageSchema(schemas.response) } },
        errors: [400, 422],
      }),
      spec({
        method: 'get',
        path: '/deleted/:id',
        operationId: `showDeleted${resource}`,
        summary: `Show a soft-deleted ${camel}`,
        security,
        ...(schemas.param ? { request: { params: schemas.param } } : {}),
        responses: { 200: { description: `The soft-deleted ${camel}`, schema: schemas.response } },
        errors: [400, 404, 422],
      }),
    );
  }

  operations.push(
    spec({
      method: 'get',
      path: '/:id',
      operationId: `show${resource}`,
      summary: `Show a ${camel}`,
      security,
      ...(schemas.param ? { request: { params: schemas.param } } : {}),
      responses: { 200: { description: `The ${camel}`, schema: schemas.response } },
      errors: [404, 422],
    }),
    spec({
      method: 'patch',
      path: '/:id',
      operationId: `update${resource}`,
      summary: `Update a ${camel}`,
      security,
      request: {
        ...(schemas.param ? { params: schemas.param } : {}),
        body: schemas.update,
      },
      responses: { 200: { description: `The updated ${camel}`, schema: schemas.response } },
      errors: [400, 404, 409, 422],
    }),
    spec({
      method: 'delete',
      path: '/:id',
      operationId: `delete${resource}`,
      summary: `Delete a ${camel}`,
      security,
      ...(schemas.param ? { request: { params: schemas.param } } : {}),
      responses: { 204: { description: 'Deleted' } },
      errors: [404, 422],
    }),
  );

  if (softDelete) {
    operations.push(
      spec({
        method: 'post',
        path: '/:id/restore',
        operationId: `restore${resource}`,
        summary: `Restore a soft-deleted ${camel}`,
        security,
        ...(schemas.param ? { request: { params: schemas.param } } : {}),
        responses: { 200: { description: `The restored ${camel}`, schema: schemas.response } },
        errors: [400, 404, 422],
      }),
    );
  }

  return defineOperations(mount, tag, operations);
}
