import { describe, expect, test } from 'bun:test';
import { listRoutes } from '@framework/http';
import { checkOperations, generateOpenApiDocument, type Operation } from '@framework/openapi';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import { pluralizeResource, resourceOperations } from '../src/openapi';
import { resourceRoutes } from '../src/resource-routes';

const testSchemas = {
  create: z.object({ name: z.string().min(1) }).strict(),
  update: z.object({ name: z.string().min(1).optional() }).strict(),
  response: z.object({ id: z.string().uuid(), name: z.string(), deletedAt: z.string().nullable().optional() }).strict(),
  query: z.object({ page: z.coerce.number().optional(), limit: z.coerce.number().optional() }).strict(),
  param: z.object({ id: z.string().uuid() }).strict(),
};

function requireOperation(operations: readonly Operation[], id: string): Operation {
  const op = operations.find((o) => o.operationId === id);
  if (!op) throw new Error(`Expected operationId "${id}" to exist`);
  return op;
}

describe('Adversarial OpenAPI Operations Testing', () => {
  describe('1. softDelete: true vs softDelete: false vs undefined', () => {
    test('softDelete: false yields exactly 5 standard CRUD operations', () => {
      const ops = resourceOperations({
        mount: '/api/v1/items',
        resource: 'Item',
        schemas: testSchemas,
        softDelete: false,
      });

      expect(ops.length).toBe(5);
      expect(ops.map((o) => `${o.method.toUpperCase()} ${o.fullPath}`)).toEqual([
        'GET /api/v1/items',
        'POST /api/v1/items',
        'GET /api/v1/items/:id',
        'PATCH /api/v1/items/:id',
        'DELETE /api/v1/items/:id',
      ]);
      expect(ops.map((o) => o.operationId)).toEqual([
        'listItems',
        'createItem',
        'showItem',
        'updateItem',
        'deleteItem',
      ]);
    });

    test('softDelete: undefined defaults to false (5 operations)', () => {
      const ops = resourceOperations({
        mount: '/api/v1/items',
        resource: 'Item',
        schemas: testSchemas,
      });

      expect(ops.length).toBe(5);
      expect(ops.map((o) => o.operationId)).toEqual([
        'listItems',
        'createItem',
        'showItem',
        'updateItem',
        'deleteItem',
      ]);
    });

    test('softDelete: true yields exactly 8 operations in strict route priority order', () => {
      const ops = resourceOperations({
        mount: '/api/v1/items',
        resource: 'Item',
        schemas: testSchemas,
        softDelete: true,
      });

      expect(ops.length).toBe(8);
      // Static routes (/deleted, /deleted/:id) MUST precede parameterized (/:id) routes
      expect(ops.map((o) => `${o.method.toUpperCase()} ${o.fullPath}`)).toEqual([
        'GET /api/v1/items',
        'POST /api/v1/items',
        'GET /api/v1/items/deleted',
        'GET /api/v1/items/deleted/:id',
        'GET /api/v1/items/:id',
        'PATCH /api/v1/items/:id',
        'DELETE /api/v1/items/:id',
        'POST /api/v1/items/:id/restore',
      ]);

      expect(ops.map((o) => o.operationId)).toEqual([
        'listItems',
        'createItem',
        'listDeletedItems',
        'showDeletedItem',
        'showItem',
        'updateItem',
        'deleteItem',
        'restoreItem',
      ]);
    });
  });

  describe('2. OperationIds, paths, summaries, parameter schemas, responses, error codes', () => {
    test('OperationIds follow strict singular/plural convention', () => {
      const ops = resourceOperations({
        mount: '/api/v1/categories',
        resource: 'Category',
        schemas: testSchemas,
        softDelete: true,
      });

      // Collections use plural tag; individual entities use singular resource
      expect(ops.find((o) => o.fullPath === '/api/v1/categories' && o.method === 'get')?.operationId).toBe(
        'listCategories',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories' && o.method === 'post')?.operationId).toBe(
        'createCategory',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/deleted' && o.method === 'get')?.operationId).toBe(
        'listDeletedCategories',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/deleted/:id' && o.method === 'get')?.operationId).toBe(
        'showDeletedCategory',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/:id' && o.method === 'get')?.operationId).toBe(
        'showCategory',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/:id' && o.method === 'patch')?.operationId).toBe(
        'updateCategory',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/:id' && o.method === 'delete')?.operationId).toBe(
        'deleteCategory',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/categories/:id/restore' && o.method === 'post')?.operationId).toBe(
        'restoreCategory',
      );
    });

    test('Custom tag overrides collection operationIds and operation tags', () => {
      const ops = resourceOperations({
        mount: '/api/v1/people',
        resource: 'Person',
        tag: 'Humans',
        schemas: testSchemas,
        softDelete: true,
      });

      expect(ops.every((o) => o.tag === 'Humans')).toBe(true);
      expect(ops.find((o) => o.fullPath === '/api/v1/people' && o.method === 'get')?.operationId).toBe('listHumans');
      expect(ops.find((o) => o.fullPath === '/api/v1/people/deleted' && o.method === 'get')?.operationId).toBe(
        'listDeletedHumans',
      );
      // Single item operations still use the resource name
      expect(ops.find((o) => o.fullPath === '/api/v1/people' && o.method === 'post')?.operationId).toBe('createPerson');
      expect(ops.find((o) => o.fullPath === '/api/v1/people/deleted/:id' && o.method === 'get')?.operationId).toBe(
        'showDeletedPerson',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/people/:id' && o.method === 'get')?.operationId).toBe(
        'showPerson',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/people/:id' && o.method === 'patch')?.operationId).toBe(
        'updatePerson',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/people/:id' && o.method === 'delete')?.operationId).toBe(
        'deletePerson',
      );
      expect(ops.find((o) => o.fullPath === '/api/v1/people/:id/restore' && o.method === 'post')?.operationId).toBe(
        'restorePerson',
      );
    });

    test('Summaries match English casing and resource/plural tags', () => {
      const ops = resourceOperations({
        mount: '/api/v1/widgets',
        resource: 'Widget',
        schemas: testSchemas,
        softDelete: true,
      });

      const summaries = Object.fromEntries(ops.map((o) => [o.operationId, o.summary]));
      expect(summaries).toEqual({
        listWidgets: 'List widgets',
        createWidget: 'Create a widget',
        listDeletedWidgets: 'List soft-deleted widgets',
        showDeletedWidget: 'Show a soft-deleted widget',
        showWidget: 'Show a widget',
        updateWidget: 'Update a widget',
        deleteWidget: 'Delete a widget',
        restoreWidget: 'Restore a soft-deleted widget',
      });
    });

    test('All parameter schemas, request bodies, responses, and error codes match runtime behavior', () => {
      const ops = resourceOperations({
        mount: '/api/v1/products',
        resource: 'Product',
        schemas: testSchemas,
        softDelete: true,
      });

      // 1. list
      const list = requireOperation(ops, 'listProducts');
      expect(list.request?.query).toBe(testSchemas.query);
      expect(list.request?.params).toBeUndefined();
      expect(list.request?.body).toBeUndefined();
      expect(list.responses[200]).toBeDefined();
      expect(list.errors).toEqual([422]);

      // 2. create
      const create = requireOperation(ops, 'createProduct');
      expect(create.request?.body).toBe(testSchemas.create);
      expect(create.request?.query).toBeUndefined();
      expect(create.request?.params).toBeUndefined();
      expect(create.responses[201]?.schema).toBe(testSchemas.response);
      expect(create.errors).toEqual([400, 409, 422]);

      // 3. listDeleted
      const listDel = requireOperation(ops, 'listDeletedProducts');
      expect(listDel.request?.query).toBe(testSchemas.query);
      expect(listDel.request?.params).toBeUndefined();
      expect(listDel.request?.body).toBeUndefined();
      expect(listDel.responses[200]).toBeDefined();
      expect(listDel.errors).toEqual([400, 422]);

      // 4. showDeleted
      const showDel = requireOperation(ops, 'showDeletedProduct');
      expect(showDel.request?.params).toBe(testSchemas.param);
      expect(showDel.request?.query).toBeUndefined();
      expect(showDel.request?.body).toBeUndefined();
      expect(showDel.responses[200]?.schema).toBe(testSchemas.response);
      expect(showDel.errors).toEqual([400, 404, 422]);

      // 5. show
      const show = requireOperation(ops, 'showProduct');
      expect(show.request?.params).toBe(testSchemas.param);
      expect(show.request?.query).toBeUndefined();
      expect(show.request?.body).toBeUndefined();
      expect(show.responses[200]?.schema).toBe(testSchemas.response);
      expect(show.errors).toEqual([404, 422]);

      // 6. update
      const update = requireOperation(ops, 'updateProduct');
      expect(update.request?.params).toBe(testSchemas.param);
      expect(update.request?.body).toBe(testSchemas.update);
      expect(update.request?.query).toBeUndefined();
      expect(update.responses[200]?.schema).toBe(testSchemas.response);
      expect(update.errors).toEqual([400, 404, 409, 422]);

      // 7. delete
      const del = requireOperation(ops, 'deleteProduct');
      expect(del.request?.params).toBe(testSchemas.param);
      expect(del.request?.body).toBeUndefined();
      expect(del.responses[204]).toEqual({ description: 'Deleted' });
      expect(del.errors).toEqual([404, 422]);

      // 8. restore
      const restore = requireOperation(ops, 'restoreProduct');
      expect(restore.request?.params).toBe(testSchemas.param);
      expect(restore.request?.body).toBeUndefined();
      expect(restore.responses[200]?.schema).toBe(testSchemas.response);
      expect(restore.errors).toEqual([400, 404, 422]);
    });

    test('Omitting optional query and param schemas cleanly removes them from OpenAPI request specs', () => {
      const ops = resourceOperations({
        mount: '/api/v1/minimal',
        resource: 'Minimal',
        schemas: {
          create: testSchemas.create,
          update: testSchemas.update,
          response: testSchemas.response,
        },
        softDelete: true,
      });

      for (const op of ops) {
        expect(op.request?.query).toBeUndefined();
        if (op.method !== 'post' && op.method !== 'patch') {
          expect(op.request?.params).toBeUndefined();
        }
      }
    });
  });

  describe('3. Custom security schemes propagation', () => {
    test('Default security is public on all operations', () => {
      const ops = resourceOperations({
        mount: '/api/v1/public-items',
        resource: 'PublicItem',
        schemas: testSchemas,
        softDelete: true,
      });

      for (const op of ops) {
        expect(op.security).toBe('public');
      }
    });

    test('Single custom security scheme propagates to all 8 operations including soft delete', () => {
      const ops = resourceOperations({
        mount: '/api/v1/secured',
        resource: 'Secured',
        security: ['bearerAuth'],
        schemas: testSchemas,
        softDelete: true,
      });

      expect(ops.length).toBe(8);
      for (const op of ops) {
        expect(op.security).toEqual(['bearerAuth']);
      }
    });

    test('Multiple security schemes propagate to all 8 operations including soft delete', () => {
      const schemes = ['bearerAuth', 'apiKey', 'oauth2'] as const;
      const ops = resourceOperations({
        mount: '/api/v1/multi-auth',
        resource: 'MultiAuth',
        security: schemes,
        schemas: testSchemas,
        softDelete: true,
      });

      expect(ops.length).toBe(8);
      for (const op of ops) {
        expect(op.security).toEqual(schemes);
      }
    });
  });

  describe('4. OpenAPI 3.1 Document generation and path formatting', () => {
    test('generateOpenApiDocument succeeds without duplicate operationIds and produces valid 3.1 spec', () => {
      const ops = resourceOperations({
        mount: '/api/v1/documents',
        resource: 'Document',
        security: ['bearerAuth'],
        schemas: testSchemas,
        softDelete: true,
      });

      const doc = generateOpenApiDocument({
        title: 'Test API',
        version: '1.0.0',
        operations: ops,
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      });

      expect(doc.openapi).toBe('3.1.0');
      expect(doc.info.title).toBe('Test API');

      // Verify path parameter syntax conversion: :id -> {id}
      expect(doc.paths['/api/v1/documents']).toBeDefined();
      expect(doc.paths['/api/v1/documents/deleted']).toBeDefined();
      expect(doc.paths['/api/v1/documents/deleted/{id}']).toBeDefined();
      expect(doc.paths['/api/v1/documents/{id}']).toBeDefined();
      expect(doc.paths['/api/v1/documents/{id}/restore']).toBeDefined();

      // Verify methods on paths
      const paths = doc.paths as Record<string, Record<string, { operationId?: string; security?: unknown }>>;
      expect(paths['/api/v1/documents']?.get?.operationId).toBe('listDocuments');
      expect(paths['/api/v1/documents']?.post?.operationId).toBe('createDocument');
      expect(paths['/api/v1/documents/deleted']?.get?.operationId).toBe('listDeletedDocuments');
      expect(paths['/api/v1/documents/deleted/{id}']?.get?.operationId).toBe('showDeletedDocument');
      expect(paths['/api/v1/documents/{id}']?.get?.operationId).toBe('showDocument');
      expect(paths['/api/v1/documents/{id}']?.patch?.operationId).toBe('updateDocument');
      expect(paths['/api/v1/documents/{id}']?.delete?.operationId).toBe('deleteDocument');
      expect(paths['/api/v1/documents/{id}/restore']?.post?.operationId).toBe('restoreDocument');

      // Verify security in document
      expect(paths['/api/v1/documents/deleted/{id}']?.get?.security).toEqual([{ bearerAuth: [] }]);
      expect(paths['/api/v1/documents/{id}/restore']?.post?.security).toEqual([{ bearerAuth: [] }]);

      // Verify error schemas generated
      expect(doc.components.schemas.ErrorEnvelope400).toBeDefined();
      expect(doc.components.schemas.ErrorEnvelope404).toBeDefined();
      expect(doc.components.schemas.ErrorEnvelope409).toBeDefined();
      expect(doc.components.schemas.ErrorEnvelope422).toBeDefined();
    });
  });

  describe('5. Pluralization edge cases', () => {
    test('Pluralizes s, x, z, ch, sh, y correctly', () => {
      expect(pluralizeResource('Box')).toBe('Boxes');
      expect(pluralizeResource('Tax')).toBe('Taxes');
      expect(pluralizeResource('Bus')).toBe('Buses');
      expect(pluralizeResource('Address')).toBe('Addresses');
      expect(pluralizeResource('Match')).toBe('Matches');
      expect(pluralizeResource('Wish')).toBe('Wishes');
      expect(pluralizeResource('Category')).toBe('Categories');
      expect(pluralizeResource('Company')).toBe('Companies');
      expect(pluralizeResource('Boy')).toBe('Boys');
      expect(pluralizeResource('Day')).toBe('Days');
      expect(pluralizeResource('Key')).toBe('Keys');
      expect(pluralizeResource('Guy')).toBe('Guys');
    });
  });

  describe('6. Route drift verification against Hono routers', () => {
    test('CLI-style generator route set matches OpenAPI operations exactly', () => {
      const softDeleteRoutes = [
        { method: 'GET', path: '/api/v1/products' },
        { method: 'POST', path: '/api/v1/products' },
        { method: 'GET', path: '/api/v1/products/deleted' },
        { method: 'GET', path: '/api/v1/products/deleted/:id' },
        { method: 'GET', path: '/api/v1/products/:id' },
        { method: 'PATCH', path: '/api/v1/products/:id' },
        { method: 'DELETE', path: '/api/v1/products/:id' },
        { method: 'POST', path: '/api/v1/products/:id/restore' },
      ];

      const ops = resourceOperations({
        mount: '/api/v1/products',
        resource: 'Product',
        schemas: testSchemas,
        softDelete: true,
      });

      const problems = checkOperations(softDeleteRoutes, ops);
      expect(problems).toEqual([]);
    });

    test('Non-soft-delete CLI route set matches OpenAPI operations exactly', () => {
      const nonSoftDeleteRoutes = [
        { method: 'GET', path: '/api/v1/products' },
        { method: 'POST', path: '/api/v1/products' },
        { method: 'GET', path: '/api/v1/products/:id' },
        { method: 'PATCH', path: '/api/v1/products/:id' },
        { method: 'DELETE', path: '/api/v1/products/:id' },
      ];

      const ops = resourceOperations({
        mount: '/api/v1/products',
        resource: 'Product',
        schemas: testSchemas,
        softDelete: false,
      });

      const problems = checkOperations(nonSoftDeleteRoutes, ops);
      expect(problems).toEqual([]);
    });

    test('resourceRoutes mounts POST /:id/restore and PATCH /:id/restore, while OpenAPI documents canonical POST', () => {
      const table = pgTable('items', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
      });

      const app = resourceRoutes(table);
      const root = new Hono().route('/api/v1/items', app);
      const routes = listRoutes(root);

      const ops = resourceOperations({
        mount: '/api/v1/items',
        resource: 'Item',
        schemas: testSchemas,
        softDelete: true,
      });

      // The 8 canonical OpenAPI operations map 1:1 to the 8 primary router endpoints
      for (const op of ops) {
        const matchingRoute = routes.find((r) => r.method === op.method.toUpperCase() && r.path === op.fullPath);
        expect(matchingRoute).toBeDefined();
      }

      // Router also provides convenience PATCH /:id/restore alias as specified in R3
      const patchRestore = routes.find((r) => r.method === 'PATCH' && r.path === '/api/v1/items/:id/restore');
      expect(patchRestore).toBeDefined();
    });
  });
});
