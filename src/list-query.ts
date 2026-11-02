import { FrameworkError } from '@framework/core';
import {
  type CrudTable,
  DEFAULT_PAGINATION,
  type PaginationLimits,
  paginationQuerySchema,
  type QueryOptions,
  type SelectOf,
} from '@framework/database';
import { eq, gt, gte, ilike, inArray, lt, lte, ne, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod/v4';

export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

/** Filterable columns: `true` allows what suits the column's type, a list narrows it. */
export type FilterableColumns<TColumn extends string = string> = {
  readonly [K in TColumn]?: true | readonly FilterOperator[];
};

export interface ListQueryOptions<TColumn extends string = string> {
  readonly filterable?: FilterableColumns<TColumn>;
  readonly sortable?: readonly TColumn[];
  readonly limits?: PaginationLimits;
}

/** A list endpoint's query: the validation schema, and how a parsed query becomes repository options. */
export interface ListQuery {
  readonly schema: z.ZodObject<z.ZodRawShape>;
  toOptions(query: Readonly<Record<string, unknown>>): QueryOptions;
}

type ColumnKind = 'text' | 'enum' | 'uuid' | 'integer' | 'bigint' | 'decimal' | 'boolean' | 'timestamp' | 'date';

const INT4_MAX = 2_147_483_647;
const INT2_MAX = 32_767;
const MAX_IN_VALUES = 100;
const MAX_FILTER_TEXT = 1_000;
const MAX_SORT_COLUMNS = 5;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const BIGINT = /^-?\d{1,18}$/;
const INTEGER = /^-?\d{1,10}$/;
const MAX_DECIMAL_LENGTH = 100;
/** Postgres has no year 0, and refuses a time zone displacement of 16 hours or more. */
const MIN_YEAR = 1;
const ZONE_OFFSET = /(Z|[+-](0\d|1[0-5]):[0-5]\d)$/;

const inPostgresRange = (value: string): boolean => new Date(value).getUTCFullYear() >= MIN_YEAR;

/** A float column's value must not overflow once converted: `real` holds far less than `double precision`. */
const fitsFloat = (column: ColumnInfo, value: string): boolean => {
  const parsed = Number(value);
  return Number.isFinite(column.columnType === 'PgReal' ? Math.fround(parsed) : parsed);
};

const RANGE: readonly FilterOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'];
const OPERATORS: Readonly<Record<ColumnKind, readonly FilterOperator[]>> = {
  text: ['eq', 'ne', 'in', 'contains'],
  enum: ['eq', 'ne', 'in'],
  uuid: ['eq', 'ne', 'in'],
  integer: RANGE,
  bigint: RANGE,
  decimal: RANGE,
  timestamp: RANGE,
  date: RANGE,
  boolean: ['eq', 'ne'],
};

type ColumnInfo = AnyPgColumn & { readonly enumValues?: readonly string[] };

function columnKind(column: ColumnInfo): ColumnKind | null {
  if (column.enumValues && column.enumValues.length > 0) return 'enum';
  switch (column.columnType) {
    case 'PgUUID':
      return 'uuid';
    case 'PgNumeric':
    case 'PgReal':
    case 'PgDoublePrecision':
      return 'decimal';
    case 'PgBigInt53':
    case 'PgBigInt64':
    case 'PgBigSerial53':
    case 'PgBigSerial64':
      return 'bigint';
    case 'PgTimestamp':
    case 'PgTimestampString':
      return 'timestamp';
    case 'PgDate':
    case 'PgDateString':
      return 'date';
    case 'PgBoolean':
      return 'boolean';
    case 'PgInteger':
    case 'PgSerial':
    case 'PgSmallInt':
    case 'PgSmallSerial':
      return 'integer';
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
      return 'text';
    default:
      return null;
  }
}

/** A value's schema: everything Postgres would refuse to compare fails here, as a 422. */
function valueSchema(column: ColumnInfo, kind: ColumnKind): z.ZodType<string> {
  switch (kind) {
    case 'enum':
      return z.enum(column.enumValues as [string, ...string[]]);
    case 'uuid':
      return z.guid();
    case 'integer': {
      const max = column.columnType === 'PgSmallInt' || column.columnType === 'PgSmallSerial' ? INT2_MAX : INT4_MAX;
      return z
        .string()
        .regex(INTEGER)
        .refine((value) => Math.abs(Number(value)) <= max, `Must be between -${max} and ${max}`);
    }
    case 'bigint':
      return z.string().regex(BIGINT);
    case 'decimal':
      return z
        .string()
        .max(MAX_DECIMAL_LENGTH)
        .regex(DECIMAL)
        .refine((value) => column.dataType !== 'number' || fitsFloat(column, value), 'Out of range');
    case 'boolean':
      return z.enum(['true', 'false']);
    case 'timestamp':
      return z.iso
        .datetime({ offset: true })
        .refine((value) => ZONE_OFFSET.test(value) && inPostgresRange(value), 'Out of range');
    case 'date':
      return z.iso.date().refine(inPostgresRange, 'Out of range');
    case 'text':
      return z
        .string()
        .min(1)
        .max(MAX_FILTER_TEXT)
        .refine((value) => !value.includes('\u0000'), 'Invalid character');
  }
}

/** Turns a validated query string value into what the column's driver mapping expects. */
function toColumnValue(column: ColumnInfo, kind: ColumnKind, value: string): unknown {
  if (kind === 'boolean') return value === 'true';
  if (kind === 'integer') return Number(value);
  if (kind === 'bigint') return column.dataType === 'bigint' ? BigInt(value) : Number(value);
  if (column.dataType === 'number') return Number(value);
  if (column.dataType === 'date') return new Date(value);
  return value;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

const CONDITIONS: Readonly<
  Record<Exclude<FilterOperator, 'in' | 'contains'>, (column: AnyPgColumn, value: unknown) => SQL>
> = { eq, ne, gt, gte, lt, lte };

function listSchema(item: z.ZodType<string>): z.ZodType<string> {
  return z.string().refine((value) => {
    const parts = value.split(',');
    return parts.length <= MAX_IN_VALUES && parts.every((part) => item.safeParse(part).success);
  }, `Must be a comma-separated list of at most ${MAX_IN_VALUES} valid values`);
}

const columnOf = (table: CrudTable, name: string, feature: string): ColumnInfo => {
  const column = Object.hasOwn(table, name) ? (table as unknown as Record<string, ColumnInfo>)[name] : undefined;
  if (!column) {
    throw new FrameworkError('LIST_QUERY_INVALID', `${feature}: "${name}" is not a column of this table`);
  }
  return column;
};

const filterKey = (column: string, operator: FilterOperator): string => `filter[${column}][${operator}]`;

/**
 * The `?filter[column][operator]=value&sort=-column,column` query for a list
 * endpoint. Only what is named here is accepted, and every value is validated
 * against its column, so a bad value is a 422 rather than a database error.
 * Operators and values are bound parameters; a `contains` value's `%` and `_`
 * match themselves. `in` splits on commas, so it can't match a value holding one.
 */
export function defineListQuery<TTable extends CrudTable>(
  table: TTable,
  options: ListQueryOptions<keyof SelectOf<TTable> & string>,
): ListQuery {
  const shape: Record<string, z.ZodType> = {};
  const readers = new Map<string, (value: string) => SQL>();

  for (const [name, allowed] of Object.entries(options.filterable ?? {}) as [
    string,
    true | readonly FilterOperator[],
  ][]) {
    const column = columnOf(table, name, 'filterable');
    const kind = columnKind(column);
    if (!kind) {
      throw new FrameworkError('LIST_QUERY_INVALID', `filterable: "${name}" has a type that can't be filtered`);
    }
    const supported = OPERATORS[kind];
    const operators = allowed === true ? supported : allowed;
    const item = valueSchema(column, kind);
    for (const operator of operators) {
      if (!supported.includes(operator)) {
        throw new FrameworkError(
          'LIST_QUERY_INVALID',
          `filterable: "${name}" doesn't support the ${operator} operator`,
        );
      }
      const key = filterKey(name, operator);
      shape[key] = (operator === 'in' ? listSchema(item) : item).optional();
      readers.set(key, (value) => {
        if (operator === 'in')
          return inArray(
            column,
            value.split(',').map((part) => toColumnValue(column, kind, part)),
          );
        if (operator === 'contains') return ilike(column, `%${escapeLike(value)}%`);
        return CONDITIONS[operator](column, toColumnValue(column, kind, value));
      });
    }
  }

  const sortable = new Map((options.sortable ?? []).map((name) => [name as string, columnOf(table, name, 'sortable')]));
  if (sortable.size > 0) {
    const names = [...sortable.keys()].join('|');
    shape.sort = z
      .string()
      .regex(new RegExp(`^-?(${names})(,-?(${names}))*$`), `Sortable columns: ${[...sortable.keys()].join(', ')}`)
      .refine((value) => value.split(',').length <= MAX_SORT_COLUMNS, `At most ${MAX_SORT_COLUMNS} sort columns`)
      .optional();
  }

  return {
    schema: paginationQuerySchema(options.limits ?? DEFAULT_PAGINATION)
      .extend(shape)
      .strict() as unknown as z.ZodObject<z.ZodRawShape>,
    toOptions(query) {
      const filters = [...readers].flatMap(([key, read]) => {
        const value = query[key];
        return typeof value === 'string' ? [read(value)] : [];
      });
      const sort =
        typeof query.sort === 'string'
          ? query.sort.split(',').map((part) => {
              const descending = part.startsWith('-');
              const name = descending ? part.slice(1) : part;
              return {
                column: sortable.get(name) as AnyPgColumn,
                direction: descending ? ('desc' as const) : ('asc' as const),
              };
            })
          : [];
      return { ...(filters.length > 0 ? { filters } : {}), ...(sort.length > 0 ? { sort } : {}) };
    },
  };
}
