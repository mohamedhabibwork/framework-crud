import { FrameworkError } from '@framework/core';
import type { CrudTable } from '@framework/database';
import { createInsertSchema, createSelectSchema, createUpdateSchema, paginationQuerySchema } from '@framework/database';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod/v4';

const SYSTEM_COLUMNS = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'created_at', 'updated_at', 'deleted_at'] as const;

interface OmittableStrictSchema {
  omit(mask: Record<string, true>): OmittableStrictSchema;
  strict(): z.ZodObject<z.ZodRawShape>;
}

export interface ResourceSchemaOptions<TCreate = unknown, TUpdate = unknown> {
  readonly createSchema?: z.ZodType<TCreate> | null;
  readonly updateSchema?: z.ZodType<TUpdate> | null;
  readonly paramSchema?: z.ZodObject<{ id: z.ZodTypeAny }> | null;
  readonly querySchema?: z.ZodObject<z.ZodRawShape> | null;
  readonly softDeleteColumn?: AnyPgColumn;
  /** Columns clients may not set, beyond the system ones. Applies to derived schemas only. */
  readonly readOnly?: readonly string[];
  /** Replaces a column's derived schema, e.g. the shape of a `jsonb` column. Optionality still follows the table. */
  readonly columns?: Readonly<Record<string, z.ZodType>>;
}

export interface ResolvedResourceSchemas<TCreate = unknown, TUpdate = unknown> {
  readonly createSchema: z.ZodType<TCreate>;
  readonly updateSchema: z.ZodType<TUpdate>;
  readonly paramSchema: z.ZodObject<{ id: z.ZodTypeAny }>;
  readonly querySchema: z.ZodObject<z.ZodRawShape>;
}

type SchemaMode = 'insert' | 'update' | 'select';

/** Applies the column's own nullability and optionality to a schema that replaces its derived one. */
function columnField(column: AnyPgColumn, schema: z.ZodType, mode: SchemaMode): z.ZodType {
  const typed = column.notNull ? schema : schema.nullable();
  if (mode === 'select') return typed;
  if (mode === 'update') return typed.optional();
  return column.notNull && !column.hasDefault ? typed : typed.optional();
}

/** A derived schema with the `columns` option applied. */
export function withColumnSchemas<TSchema>(
  table: CrudTable,
  schema: TSchema,
  columns: Readonly<Record<string, z.ZodType>> | undefined,
  mode: SchemaMode,
): TSchema {
  if (!columns) return schema;
  const fields = Object.entries(columns).map(([name, field]): [string, z.ZodType] => {
    const column = Object.hasOwn(table, name) ? (table as unknown as Record<string, AnyPgColumn>)[name] : undefined;
    if (!column)
      throw new FrameworkError('RESOURCE_COLUMN_UNKNOWN', `columns: "${name}" is not a column of this table`);
    return [name, columnField(column, field, mode)];
  });
  return (schema as unknown as z.ZodObject<z.ZodRawShape>).extend(Object.fromEntries(fields)) as unknown as TSchema;
}

/**
 * Resolves or auto-derives CRUD validation schemas for a given table.
 * Strips auto-managed system columns (id, createdAt, updatedAt, deletedAt)
 * from create and update schemas, applies .strict(), and enforces at least one
 * writable field for updates. Derives primary-key :id parameter schema
 * (with string-to-number coercion for serial/integer IDs) and pagination query schema.
 */
export function resolveResourceSchemas<TTable extends CrudTable>(
  table: TTable,
  options?: ResourceSchemaOptions,
): ResolvedResourceSchemas {
  // 1. Param schema
  const paramSchema: z.ZodObject<{ id: z.ZodTypeAny }> =
    options?.paramSchema ??
    (() => {
      const select = createSelectSchema(table);
      const selectShape = select.shape as Record<string, z.ZodTypeAny>;
      const idCol = (table as unknown as { id?: { dataType?: string } }).id;
      const isNumber = idCol?.dataType === 'number' || selectShape.id?.safeParse(1).success;
      const rawIdField = selectShape.id ?? z.union([z.string(), z.number()]);
      const idField: z.ZodTypeAny = isNumber
        ? z.coerce.number().pipe(rawIdField as z.ZodType<unknown, number>)
        : rawIdField;
      return z.object({ id: idField }).strict();
    })();

  // 2. Query schema
  const querySchema: z.ZodObject<z.ZodRawShape> =
    options?.querySchema ?? (paginationQuerySchema().strict() as z.ZodObject<z.ZodRawShape>);

  const customCols: string[] = [...(options?.readOnly ?? [])];
  if (options?.softDeleteColumn) {
    const col = options.softDeleteColumn;
    const entry = Object.entries(table).find(([, value]) => value === col);
    if (entry) {
      customCols.push(entry[0]);
    }
    if ('name' in col && typeof col.name === 'string' && !customCols.includes(col.name)) {
      customCols.push(col.name);
    }
  }
  const systemCols = [...SYSTEM_COLUMNS, ...customCols];

  // 3. Create schema
  const createSchema: z.ZodType<unknown> =
    options?.createSchema ??
    (() => {
      const insert = withColumnSchemas(table, createInsertSchema(table), options?.columns, 'insert');
      const insertShape = insert.shape as Record<string, unknown>;
      const omitKeys = systemCols.filter((col) => col in insertShape);
      const omitMap: Record<string, true> = Object.fromEntries(omitKeys.map((col) => [col, true]));
      const omittable = insert as unknown as OmittableStrictSchema;
      return (omitKeys.length > 0 ? omittable.omit(omitMap) : omittable).strict();
    })();

  // 4. Update schema
  const updateSchema: z.ZodType<unknown> =
    options?.updateSchema ??
    (() => {
      const update = withColumnSchemas(table, createUpdateSchema(table), options?.columns, 'update');
      const updateShape = update.shape as Record<string, unknown>;
      const omitKeys = systemCols.filter((col) => col in updateShape);
      const omitMap: Record<string, true> = Object.fromEntries(omitKeys.map((col) => [col, true]));
      const omittable = update as unknown as OmittableStrictSchema;
      return (omitKeys.length > 0 ? omittable.omit(omitMap) : omittable)
        .strict()
        .refine((val: Record<string, unknown>) => Object.keys(val).length > 0, {
          message: 'At least one writable field is required',
        });
    })();

  return {
    createSchema,
    updateSchema,
    paramSchema,
    querySchema,
  };
}
