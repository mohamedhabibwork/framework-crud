import { describe, expect, test } from 'bun:test';
import type { Operation } from '@framework/openapi';
import { z } from 'zod/v4';
import { pluralizeResource, resourceOperations } from '../src/openapi';

const schemas = {
  create: z.object({ name: z.string() }).strict(),
  update: z.object({ name: z.string().optional() }).strict(),
  response: z.object({ id: z.string(), name: z.string() }).strict(),
  query: z.object({ page: z.number().optional(), limit: z.number().optional() }).strict(),
  param: z.object({ id: z.string().uuid() }).strict(),
};

describe('resourceOperations', () => {
  const operations = resourceOperations({ mount: '/api/v1/products', resource: 'Product', schemas });
  const op = (id: string): Operation => {
    const found = operations.find((operation) => operation.operationId === id);
    expect(found).toBeDefined();
    return found as Operation;
  };
  const list = op('listProducts');
  const create = op('createProduct');
  const show = op('showProduct');
  const update = op('updateProduct');
  const destroy = op('deleteProduct');

  test('derives the five controller endpoints with stable operation ids', () => {
    expect(operations.map((operation) => `${operation.method.toUpperCase()} ${operation.fullPath}`)).toEqual([
      'GET /api/v1/products',
      'POST /api/v1/products',
      'GET /api/v1/products/:id',
      'PATCH /api/v1/products/:id',
      'DELETE /api/v1/products/:id',
    ]);
    expect(operations.map((operation) => operation.operationId)).toEqual([
      'listProducts',
      'createProduct',
      'showProduct',
      'updateProduct',
      'deleteProduct',
    ]);
  });

  test('documents requests, responses and error statuses per operation', () => {
    expect(list.request?.query).toBe(schemas.query);
    expect(list.responses[200]?.schema).toBeDefined();
    expect(list.errors).toEqual([422]);

    expect(create.request?.body).toBe(schemas.create);
    expect(Object.keys(create.responses)).toEqual(['201']);
    expect(create.errors).toEqual([400, 409, 422]);

    expect(show.request?.params).toBe(schemas.param);
    expect(update.request?.params).toBe(schemas.param);
    expect(update.request?.body).toBe(schemas.update);
    expect(destroy.responses[204]).toEqual({ description: 'Deleted' });
    expect(destroy.errors).toEqual([404, 422]);
  });

  test('tags default to the English plural and security defaults to public', () => {
    expect(operations.every((operation) => operation.tag === 'Products' && operation.security === 'public')).toBe(true);
    expect(pluralizeResource('Category')).toBe('Categories');
    expect(pluralizeResource('Box')).toBe('Boxes');
  });

  test('security scheme names flow through to every operation', () => {
    const secured = resourceOperations({
      mount: '/api/v1/orders',
      resource: 'Order',
      security: ['bearerAuth'],
      schemas,
    });
    expect(
      secured.every((operation) => operation.security !== 'public' && operation.security.includes('bearerAuth')),
    ).toBe(true);
    expect(secured.every((operation) => operation.tag === 'Orders')).toBe(true);
  });
});

describe('resourceOperations with softDelete', () => {
  const operations = resourceOperations({
    mount: '/api/v1/products',
    resource: 'Product',
    schemas,
    softDelete: true,
  });
  const op = (id: string): Operation => {
    const found = operations.find((operation) => operation.operationId === id);
    expect(found).toBeDefined();
    return found as Operation;
  };
  const listDeleted = op('listDeletedProducts');
  const showDeleted = op('showDeletedProduct');
  const restore = op('restoreProduct');

  test('derives the eight controller endpoints in route-priority order', () => {
    expect(operations.map((operation) => `${operation.method.toUpperCase()} ${operation.fullPath}`)).toEqual([
      'GET /api/v1/products',
      'POST /api/v1/products',
      'GET /api/v1/products/deleted',
      'GET /api/v1/products/deleted/:id',
      'GET /api/v1/products/:id',
      'PATCH /api/v1/products/:id',
      'DELETE /api/v1/products/:id',
      'POST /api/v1/products/:id/restore',
    ]);
    expect(operations.map((operation) => operation.operationId)).toEqual([
      'listProducts',
      'createProduct',
      'listDeletedProducts',
      'showDeletedProduct',
      'showProduct',
      'updateProduct',
      'deleteProduct',
      'restoreProduct',
    ]);
  });

  test('documents requests, responses, summaries, and error statuses for soft-delete operations', () => {
    expect(listDeleted.summary).toBe('List soft-deleted products');
    expect(listDeleted.request?.query).toBe(schemas.query);
    expect(listDeleted.responses[200]?.schema).toBeDefined();
    expect(listDeleted.responses[200]?.description).toBe('A page of soft-deleted products');
    expect(listDeleted.errors).toEqual([400, 422]);

    expect(showDeleted.summary).toBe('Show a soft-deleted product');
    expect(showDeleted.request?.params).toBe(schemas.param);
    expect(showDeleted.responses[200]?.schema).toBe(schemas.response);
    expect(showDeleted.responses[200]?.description).toBe('The soft-deleted product');
    expect(showDeleted.errors).toEqual([400, 404, 422]);

    expect(restore.summary).toBe('Restore a soft-deleted product');
    expect(restore.request?.params).toBe(schemas.param);
    expect(restore.responses[200]?.schema).toBe(schemas.response);
    expect(restore.responses[200]?.description).toBe('The restored product');
    expect(restore.errors).toEqual([400, 404, 422]);
  });

  test('security scheme flows through to soft-delete operations', () => {
    const secured = resourceOperations({
      mount: '/api/v1/orders',
      resource: 'Order',
      security: ['bearerAuth'],
      schemas,
      softDelete: true,
    });
    expect(
      secured.every((operation) => operation.security !== 'public' && operation.security.includes('bearerAuth')),
    ).toBe(true);
    expect(secured.find((operation) => operation.operationId === 'restoreOrder')?.security).toEqual(['bearerAuth']);
    expect(secured.find((operation) => operation.operationId === 'listDeletedOrders')?.security).toEqual([
      'bearerAuth',
    ]);
    expect(secured.find((operation) => operation.operationId === 'showDeletedOrder')?.security).toEqual(['bearerAuth']);
  });
});
