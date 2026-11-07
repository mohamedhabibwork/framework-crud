import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@framework/core';
import type { Page, PageRequest, QueryOptions } from '@framework/database';
import { integer, pgTable, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { z } from 'zod/v4';
import {
  type ResolvedResourceSchemas,
  ResourceController,
  type ResourceSchemaOptions,
  resolveResourceSchemas,
} from '../src';
import type { ResourceService } from '../src/service';

// --- Test Tables ---

const productsTable = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  sku: text('sku'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const uuidItemsTable = pgTable('uuid_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const simpleTagsTable = pgTable('simple_tags', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
});

describe('Feature F5: Schema resolution via Drizzle-Zod (resolveResourceSchemas)', () => {
  describe('Auto-derivation for numeric/serial primary key tables', () => {
    const schemas: ResolvedResourceSchemas = resolveResourceSchemas(productsTable);

    test('derives createSchema: accepts valid payload and strips system columns', () => {
      const validPayload = { name: 'Keyboard', price: 99, sku: 'KB-1' };
      const parsed = schemas.createSchema.safeParse(validPayload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(validPayload);
      }
    });

    test('derives createSchema: enforces required fields', () => {
      const invalidMissingPrice = { name: 'Keyboard' };
      const parsed = schemas.createSchema.safeParse(invalidMissingPrice);
      expect(parsed.success).toBe(false);
    });

    test('derives createSchema: rejects auto-managed system columns due to .strict()', () => {
      const withId = { name: 'Keyboard', price: 99, id: 1 };
      const withCreatedAt = { name: 'Keyboard', price: 99, createdAt: '2026-01-01T00:00:00Z' };
      const withUpdatedAt = { name: 'Keyboard', price: 99, updatedAt: '2026-01-01T00:00:00Z' };
      const withDeletedAt = { name: 'Keyboard', price: 99, deletedAt: '2026-01-01T00:00:00Z' };

      expect(schemas.createSchema.safeParse(withId).success).toBe(false);
      expect(schemas.createSchema.safeParse(withCreatedAt).success).toBe(false);
      expect(schemas.createSchema.safeParse(withUpdatedAt).success).toBe(false);
      expect(schemas.createSchema.safeParse(withDeletedAt).success).toBe(false);
    });

    test('derives createSchema: rejects unknown extra fields due to .strict()', () => {
      const withExtra = { name: 'Keyboard', price: 99, extraneous: 'invalid' };
      expect(schemas.createSchema.safeParse(withExtra).success).toBe(false);
    });

    test('derives updateSchema: accepts partial updates', () => {
      const updateName = { name: 'Updated Keyboard' };
      const updatePrice = { price: 120 };
      const updateBoth = { name: 'Updated Keyboard', price: 120 };

      expect(schemas.updateSchema.safeParse(updateName).success).toBe(true);
      expect(schemas.updateSchema.safeParse(updatePrice).success).toBe(true);
      expect(schemas.updateSchema.safeParse(updateBoth).success).toBe(true);
    });

    test('derives updateSchema: rejects empty payload with specific error message', () => {
      const emptyPayload = {};
      const parsed = schemas.updateSchema.safeParse(emptyPayload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const customIssue = parsed.error.issues.find(
          (issue) => issue.message === 'At least one writable field is required',
        );
        expect(customIssue).toBeDefined();
        expect(customIssue?.message).toBe('At least one writable field is required');
      }
    });

    test('derives updateSchema: rejects system columns and unknown fields', () => {
      const withId = { name: 'New Name', id: 10 };
      const withCreatedAt = { name: 'New Name', createdAt: '2026-01-01' };
      const withUnknown = { name: 'New Name', unknownField: true };

      expect(schemas.updateSchema.safeParse(withId).success).toBe(false);
      expect(schemas.updateSchema.safeParse(withCreatedAt).success).toBe(false);
      expect(schemas.updateSchema.safeParse(withUnknown).success).toBe(false);
    });

    test('derives paramSchema: coerces string numeric ID to integer number', () => {
      const parsedString = schemas.paramSchema.safeParse({ id: '42' });
      expect(parsedString.success).toBe(true);
      if (parsedString.success) {
        expect(parsedString.data.id).toBe(42);
        expect(typeof parsedString.data.id).toBe('number');
      }

      const parsedNumber = schemas.paramSchema.safeParse({ id: 42 });
      expect(parsedNumber.success).toBe(true);
      if (parsedNumber.success) {
        expect(parsedNumber.data.id).toBe(42);
      }
    });

    test('derives paramSchema: rejects non-numeric string for numeric ID', () => {
      const parsedInvalid = schemas.paramSchema.safeParse({ id: 'abc-not-a-number' });
      expect(parsedInvalid.success).toBe(false);
    });

    test('derives paramSchema: rejects extra parameters due to .strict()', () => {
      const parsedExtra = schemas.paramSchema.safeParse({ id: '42', other: 'test' });
      expect(parsedExtra.success).toBe(false);
    });

    test('derives querySchema: validates pagination and rejects unknown query params', () => {
      const validQuery = { page: 2, limit: 50 };
      const parsedValid = schemas.querySchema.safeParse(validQuery);
      expect(parsedValid.success).toBe(true);

      const defaultQuery = {};
      const parsedDefault = schemas.querySchema.safeParse(defaultQuery);
      expect(parsedDefault.success).toBe(true);
      if (parsedDefault.success) {
        expect(parsedDefault.data).toEqual({ page: 1, limit: 20 });
      }

      const extraQuery = { page: 1, limit: 20, unexpectedParam: 'bad' };
      const parsedExtra = schemas.querySchema.safeParse(extraQuery);
      expect(parsedExtra.success).toBe(false);
    });
  });

  describe('Auto-derivation for UUID primary key tables', () => {
    const schemas: ResolvedResourceSchemas = resolveResourceSchemas(uuidItemsTable);

    test('derives paramSchema: validates valid UUID without numeric coercion', () => {
      const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const parsed = schemas.paramSchema.safeParse({ id: validUuid });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.id).toBe(validUuid);
        expect(typeof parsed.data.id).toBe('string');
      }
    });

    test('derives paramSchema: rejects invalid UUID string', () => {
      const invalidUuid = 'not-a-valid-uuid-123';
      const parsed = schemas.paramSchema.safeParse({ id: invalidUuid });
      expect(parsed.success).toBe(false);
    });

    test('derives paramSchema: rejects extra properties due to .strict()', () => {
      const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const parsed = schemas.paramSchema.safeParse({ id: validUuid, extra: 1 });
      expect(parsed.success).toBe(false);
    });

    test('derives createSchema & updateSchema: strips id and deletedAt', () => {
      const createParsed = schemas.createSchema.safeParse({ title: 'Item 1', description: 'Desc' });
      expect(createParsed.success).toBe(true);

      const createWithId = schemas.createSchema.safeParse({
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        title: 'Item 1',
      });
      expect(createWithId.success).toBe(false);

      const updateEmpty = schemas.updateSchema.safeParse({});
      expect(updateEmpty.success).toBe(false);
    });
  });

  describe('Table without timestamp or soft-delete columns', () => {
    test('does not throw when system columns are missing from table shape', () => {
      expect(() => resolveResourceSchemas(simpleTagsTable)).not.toThrow();
      const schemas = resolveResourceSchemas(simpleTagsTable);

      const createParsed = schemas.createSchema.safeParse({ slug: 'news' });
      expect(createParsed.success).toBe(true);

      const updateParsed = schemas.updateSchema.safeParse({ slug: 'tech' });
      expect(updateParsed.success).toBe(true);

      const updateEmpty = schemas.updateSchema.safeParse({});
      expect(updateEmpty.success).toBe(false);
    });
  });

  describe('Custom schemas overriding auto-derivation', () => {
    test('uses explicitly provided createSchema', () => {
      const customCreate = z.object({ customField: z.string().min(5) }).strict();
      const schemas = resolveResourceSchemas(productsTable, { createSchema: customCreate });

      expect(schemas.createSchema).toBe(customCreate);
      expect(schemas.createSchema.safeParse({ customField: 'valid string' }).success).toBe(true);
      expect(schemas.createSchema.safeParse({ customField: 'shrt' }).success).toBe(false);
      expect(schemas.createSchema.safeParse({ name: 'Keyboard', price: 99 }).success).toBe(false);
    });

    test('uses explicitly provided updateSchema', () => {
      const customUpdate = z.object({ allowAny: z.boolean() }).strict();
      const schemas = resolveResourceSchemas(productsTable, { updateSchema: customUpdate });

      expect(schemas.updateSchema).toBe(customUpdate);
      expect(schemas.updateSchema.safeParse({ allowAny: true }).success).toBe(true);
      expect(schemas.updateSchema.safeParse({ name: 'Keyboard' }).success).toBe(false);
    });

    test('uses explicitly provided paramSchema', () => {
      const customParam = z.object({ id: z.string().regex(/^SKU-[0-9]+$/) }).strict();
      const schemas = resolveResourceSchemas(productsTable, { paramSchema: customParam });

      expect(schemas.paramSchema).toBe(customParam);
      expect(schemas.paramSchema.safeParse({ id: 'SKU-100' }).success).toBe(true);
      expect(schemas.paramSchema.safeParse({ id: '42' }).success).toBe(false);
    });

    test('uses explicitly provided querySchema', () => {
      const customQuery = z.object({ filter: z.string(), sort: z.enum(['asc', 'desc']) }).strict();
      const schemas = resolveResourceSchemas(productsTable, { querySchema: customQuery });

      expect(schemas.querySchema).toBe(customQuery);
      expect(schemas.querySchema.safeParse({ filter: 'all', sort: 'asc' }).success).toBe(true);
      expect(schemas.querySchema.safeParse({ page: 1, limit: 10 }).success).toBe(false);
    });

    test('falls back to auto-derivation when options contain null or undefined', () => {
      const nullOptions: ResourceSchemaOptions = {
        createSchema: null,
        updateSchema: null,
        paramSchema: null,
        querySchema: null,
      };
      const schemas = resolveResourceSchemas(productsTable, nullOptions);

      expect(schemas.createSchema.safeParse({ name: 'Mouse', price: 25 }).success).toBe(true);
      expect(schemas.createSchema.safeParse({ id: 1, name: 'Mouse', price: 25 }).success).toBe(false);
      expect(schemas.updateSchema.safeParse({}).success).toBe(false);
      expect(schemas.paramSchema.safeParse({ id: '123' }).success).toBe(true);
      expect(schemas.querySchema.safeParse({}).success).toBe(true);
    });
  });
});

describe('Feature F6: ResourceController deleted, showDeleted & Custom DTO Transforms', () => {
  interface ProductEntity {
    id: number;
    name: string;
    price: number;
    deletedAt: string | null;
  }

  type ProductCreateInput = JsonObject & {
    readonly name: string;
    readonly price: number;
    readonly sku?: string;
  };

  type ProductUpdateInput = Partial<ProductCreateInput>;

  interface TransformedProductDto {
    readonly id: string;
    readonly displayName: string;
    readonly isAvailable: boolean;
  }

  const sampleProduct1: ProductEntity = { id: 1, name: 'Laptop', price: 1200, deletedAt: null };
  const sampleProduct2: ProductEntity = { id: 2, name: 'Mouse', price: 30, deletedAt: null };
  const sampleProducts: ProductEntity[] = [sampleProduct1, sampleProduct2];

  const sampleDeleted1: ProductEntity = {
    id: 3,
    name: 'Old Monitor',
    price: 150,
    deletedAt: '2026-01-15T10:00:00Z',
  };
  const sampleDeleted2: ProductEntity = {
    id: 4,
    name: 'Old Keyboard',
    price: 40,
    deletedAt: '2026-02-20T12:00:00Z',
  };
  const sampleDeletedProducts: ProductEntity[] = [sampleDeleted1, sampleDeleted2];

  function createMockService(): ResourceService<ProductEntity, ProductCreateInput, ProductUpdateInput> {
    return {
      list: async (request: PageRequest, _query: QueryOptions = {}): Promise<Page<ProductEntity>> => ({
        items: sampleProducts,
        meta: { page: request.page, limit: request.limit, total: sampleProducts.length, totalPages: 1 },
      }),
      listDeleted: async (request: PageRequest, _query: QueryOptions = {}): Promise<Page<ProductEntity>> => ({
        items: sampleDeletedProducts,
        meta: { page: request.page, limit: request.limit, total: sampleDeletedProducts.length, totalPages: 1 },
      }),
      get: async (id: number): Promise<ProductEntity> => {
        const found = sampleProducts.find((p) => p.id === id);
        if (!found) throw new Error(`Product ${id} not found`);
        return found;
      },
      getDeleted: async (id: number): Promise<ProductEntity> => {
        const found = sampleDeletedProducts.find((p) => p.id === id);
        if (!found) throw new Error(`Deleted product ${id} not found`);
        return found;
      },
      create: async (input: ProductCreateInput): Promise<ProductEntity> => ({
        id: 5,
        name: input.name,
        price: input.price,
        deletedAt: null,
      }),
      update: async (id: number, input: ProductUpdateInput): Promise<ProductEntity> => ({
        id,
        name: input.name ?? 'Laptop',
        price: input.price ?? 1200,
        deletedAt: null,
      }),
      delete: async (_id: number): Promise<void> => {},
      restore: async (id: number): Promise<ProductEntity> => {
        const found = sampleDeletedProducts.find((p) => p.id === id);
        if (!found) throw new Error(`Product ${id} not found`);
        return { ...found, deletedAt: null };
      },
    } as unknown as ResourceService<ProductEntity, ProductCreateInput, ProductUpdateInput>;
  }

  describe('Default serialization (identity)', () => {
    test('initializes with default identity serialization when omitted', async () => {
      const service = createMockService();
      const controller = new ResourceController(service);

      const single = await controller.show(1);
      expect(single).toEqual(sampleProduct1);

      const deletedPage = await controller.deleted({ page: 1, limit: 10 });
      expect(deletedPage.items).toEqual(sampleDeletedProducts);
      expect(deletedPage.meta.total).toBe(2);

      const deletedSingle = await controller.showDeleted(3);
      expect(deletedSingle).toEqual(sampleDeleted1);
    });
  });

  describe('Custom DTO transforms', () => {
    const productDtoTransform = (entity: ProductEntity): TransformedProductDto => ({
      id: `prod_${entity.id}`,
      displayName: entity.name.toUpperCase(),
      isAvailable: entity.deletedAt === null,
    });

    test('transforms single entity via showDeleted', async () => {
      const service = createMockService();
      const controller = new ResourceController<
        ProductEntity,
        ProductCreateInput,
        ProductUpdateInput,
        TransformedProductDto
      >(service, productDtoTransform);

      const transformed = await controller.showDeleted(3);
      expect(transformed).toEqual({
        id: 'prod_3',
        displayName: 'OLD MONITOR',
        isAvailable: false,
      });
    });

    test('transforms paginated items via deleted', async () => {
      const service = createMockService();
      const controller = new ResourceController<
        ProductEntity,
        ProductCreateInput,
        ProductUpdateInput,
        TransformedProductDto
      >(service, productDtoTransform);

      const page = await controller.deleted({ page: 1, limit: 10 });
      expect(page.items).toEqual([
        { id: 'prod_3', displayName: 'OLD MONITOR', isAvailable: false },
        { id: 'prod_4', displayName: 'OLD KEYBOARD', isAvailable: false },
      ]);
      expect(page.meta).toEqual({ page: 1, limit: 10, total: 2, totalPages: 1 });
    });

    test('transforms active endpoints (list, show, store, update, restore)', async () => {
      const service = createMockService();
      const controller = new ResourceController<
        ProductEntity,
        ProductCreateInput,
        ProductUpdateInput,
        TransformedProductDto
      >(service, productDtoTransform);

      const listPage = await controller.list({ page: 1, limit: 10 });
      expect(listPage.items).toEqual([
        { id: 'prod_1', displayName: 'LAPTOP', isAvailable: true },
        { id: 'prod_2', displayName: 'MOUSE', isAvailable: true },
      ]);

      const shown = await controller.show(1);
      expect(shown).toEqual({ id: 'prod_1', displayName: 'LAPTOP', isAvailable: true });

      const stored = await controller.store({ name: 'Dock', price: 200 });
      expect(stored).toEqual({ id: 'prod_5', displayName: 'DOCK', isAvailable: true });

      const updated = await controller.update(1, { name: 'Super Laptop' });
      expect(updated).toEqual({ id: 'prod_1', displayName: 'SUPER LAPTOP', isAvailable: true });

      const restored = await controller.restore(3);
      expect(restored).toEqual({ id: 'prod_3', displayName: 'OLD MONITOR', isAvailable: true });
    });

    test('propagates service errors from deleted and showDeleted', async () => {
      const service = createMockService();
      const controller = new ResourceController(service);

      await expect(controller.showDeleted(999)).rejects.toThrow('Deleted product 999 not found');
    });
  });
});
