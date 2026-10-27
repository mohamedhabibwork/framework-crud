import { describe, expect, test } from 'bun:test';
import { z } from 'zod/v4';
import { dataOperations, resourceOperations } from '../src/openapi';

describe('dataOperations', () => {
  const operations = dataOperations({ mount: '/api/v1/data', resources: ['products'] });
  const ids = operations.map((operation) => operation.operationId);

  test('documents the five import/export endpoints', () => {
    expect(ids).toEqual(['dispatchImport', 'importStatus', 'dispatchExport', 'exportStatus', 'downloadExport']);
    expect(operations.map((operation) => `${operation.method.toUpperCase()} ${operation.fullPath}`)).toEqual([
      'POST /api/v1/data/import',
      'GET /api/v1/data/import/status/:jobId',
      'POST /api/v1/data/export',
      'GET /api/v1/data/export/status/:jobId',
      'GET /api/v1/data/export/download/:jobId',
    ]);
    expect(operations.every((operation) => operation.tag === 'Data')).toBe(true);
  });

  test('request schemas enumerate the configured resources', () => {
    const importOp = operations[0];
    const body = importOp?.request?.body;
    expect(body).toBeDefined();
    // The resource field is an enum restricted to configured resources; other
    // fields keep their validation. Parse-level check through the schema.
    const parsed = body?.safeParse({ resource: 'unknown', format: 'csv', content: 'x' });
    expect(parsed?.success).toBe(false);
    const ok = body?.safeParse({ resource: 'products', format: 'csv', content: 'name,price\nx,1' });
    expect(ok?.success).toBe(true);
  });

  test('status responses use the job status schema; without resources the enum stays open', () => {
    const statusOp = operations[1];
    expect(statusOp?.responses[200]?.schema).toBeDefined();
    const open = dataOperations({ mount: '/data' });
    const anyResource = open[0]?.request?.body?.safeParse({ resource: 'anything', format: 'json', content: 'x' });
    expect(anyResource?.success).toBe(true);
  });

  test('resourceOperations stays unaffected', () => {
    const crud = resourceOperations({
      mount: '/api/v1/items',
      resource: 'Item',
      schemas: {
        create: z.object({ name: z.string() }).strict(),
        update: z.object({}).strict(),
        response: z.object({ id: z.string() }).strict(),
      },
    });
    expect(crud).toHaveLength(5);
  });
});
