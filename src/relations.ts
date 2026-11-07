import { FrameworkError, type JsonObject } from '@framework/core';
import { type CrudTable, type DataContext, type SelectOf, toJsonRow } from '@framework/database';
import { and, asc, eq, inArray, isNull, lte, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

const DEFAULT_PER_PARENT_LIMIT = 100;

/** A related table a resource can `?include=`. Build one with {@link belongsTo} or {@link hasMany}. */
export interface Relation<TResult = unknown> {
  readonly kind: 'one' | 'many';
  readonly table: CrudTable;
  readonly columns: readonly string[];
  readonly foreignKey?: string;
  readonly limit?: number;
  readonly where?: RelationScope;
  /** Type-level only: what the relation adds to a response. */
  readonly result?: TResult;
}

/** Narrows which related rows a caller gets, e.g. to those they own. Undefined applies no condition. */
export type RelationScope = (context: DataContext) => SQL | undefined;

export type Relations = Readonly<Record<string, Relation>>;

/** The optional keys `?include=` can add to a response. */
export type Included<TRelations> = {
  [K in keyof TRelations]?: TRelations[K] extends Relation<infer TResult> ? TResult : never;
};

type RelatedColumn<TTarget extends CrudTable> = keyof SelectOf<TTarget> & string;

export interface BelongsToOptions<TColumn extends string> {
  /** The columns clients see. Required: a related table's other columns stay private. */
  readonly columns: readonly TColumn[];
  /** The column on this table holding the key. Needed only when several reference the target. */
  readonly foreignKey?: string;
  /**
   * Scopes the included rows. The related table's own policy and `ownedBy` don't
   * apply here, and clients can often write a foreign key, so set this when the
   * target's rows belong to someone.
   */
  readonly where?: RelationScope;
}

export interface HasManyOptions<TColumn extends string> extends BelongsToOptions<TColumn> {
  /** Most rows included per parent, lowest ids first. Defaults to 100. */
  readonly limit?: number;
}

/** This table's row references one row of `table`; `?include=` adds that row, or null. */
export const belongsTo = <TTarget extends CrudTable, const TColumn extends RelatedColumn<TTarget>>(
  table: TTarget,
  options: BelongsToOptions<TColumn>,
): Relation<Pick<SelectOf<TTarget>, TColumn> | null> => ({ kind: 'one', table, ...options });

/** Rows of `table` reference this table's row; `?include=` adds them as a list. */
export const hasMany = <TTarget extends CrudTable, const TColumn extends RelatedColumn<TTarget>>(
  table: TTarget,
  options: HasManyOptions<TColumn>,
): Relation<Pick<SelectOf<TTarget>, TColumn>[]> => ({ kind: 'many', table, ...options });

interface ResolvedRelation {
  readonly kind: 'one' | 'many';
  readonly target: CrudTable;
  readonly fields: Readonly<Record<string, AnyPgColumn>>;
  /** Column holding the reference, on this table for `one` and on the target for `many`. */
  readonly referencing: AnyPgColumn;
  /** Column it references. */
  readonly referenced: AnyPgColumn;
  readonly limit: number;
  readonly where?: RelationScope;
}

const columnsOf = (table: CrudTable): Readonly<Record<string, AnyPgColumn>> =>
  table as unknown as Readonly<Record<string, AnyPgColumn>>;

/** Finds the single-column foreign key from `from` to `to`, or fails with what to do about it. */
function foreignKeyBetween(
  name: string,
  from: CrudTable,
  to: CrudTable,
  explicit: string | undefined,
): { readonly referencing: AnyPgColumn; readonly referenced: AnyPgColumn } {
  if (explicit) {
    const referencing = Object.hasOwn(from, explicit) ? columnsOf(from)[explicit] : undefined;
    if (!referencing) {
      throw new FrameworkError('RELATION_INVALID', `Relation "${name}": foreignKey "${explicit}" is not a column`);
    }
    return { referencing, referenced: to.id };
  }
  const candidates = getTableConfig(from as PgTable)
    .foreignKeys.map((key) => key.reference())
    .filter((key) => key.foreignTable === (to as PgTable) && key.columns.length === 1);
  const [only, second] = candidates;
  if (!only) {
    throw new FrameworkError('RELATION_INVALID', `Relation "${name}": no foreign key connects these tables`);
  }
  if (second) {
    throw new FrameworkError(
      'RELATION_INVALID',
      `Relation "${name}": several foreign keys connect these tables; name one with foreignKey`,
    );
  }
  return { referencing: only.columns[0] as AnyPgColumn, referenced: only.foreignColumns[0] as AnyPgColumn };
}

/** Checks every relation when the resource is defined, so a wrong one fails at startup. */
export function resolveRelations(source: CrudTable, relations: Relations): ReadonlyMap<string, ResolvedRelation> {
  return new Map(
    Object.entries(relations).map(([name, relation]) => {
      const fields = Object.fromEntries(
        relation.columns.map((column) => {
          const field = Object.hasOwn(relation.table, column) ? columnsOf(relation.table)[column] : undefined;
          if (!field) throw new FrameworkError('RELATION_INVALID', `Relation "${name}": "${column}" is not a column`);
          return [column, field];
        }),
      );
      const key =
        relation.kind === 'one'
          ? foreignKeyBetween(name, source, relation.table, relation.foreignKey)
          : foreignKeyBetween(name, relation.table, source, relation.foreignKey);
      return [
        name,
        {
          kind: relation.kind,
          target: relation.table,
          fields,
          ...key,
          limit: relation.limit ?? DEFAULT_PER_PARENT_LIMIT,
          ...(relation.where ? { where: relation.where } : {}),
        },
      ];
    }),
  );
}

const SOURCE_KEY = '__source';
const RANK_KEY = '__rank';

const notDeleted = (table: CrudTable): SQL | undefined =>
  'deletedAt' in table ? isNull((table as unknown as { deletedAt: AnyPgColumn }).deletedAt) : undefined;

type LoadedRow = Record<string, unknown> & { readonly [SOURCE_KEY]: unknown };

async function loadOne(
  context: DataContext,
  source: CrudTable,
  relation: ResolvedRelation,
  ids: readonly unknown[],
): Promise<readonly LoadedRow[]> {
  const rows = await context.transactions.executor
    .select({ [SOURCE_KEY]: source.id, ...relation.fields })
    .from(source as PgTable)
    .innerJoin(relation.target as PgTable, eq(relation.referencing, relation.referenced))
    .where(and(inArray(source.id, [...ids]), notDeleted(relation.target), relation.where?.(context)));
  return rows as LoadedRow[];
}

/** One query for all parents, ranked per parent so one busy row can't crowd out the rest. */
async function loadMany(
  context: DataContext,
  relation: ResolvedRelation,
  ids: readonly unknown[],
): Promise<readonly LoadedRow[]> {
  const db = context.transactions.executor;
  const ranked = db
    .select({
      ...relation.fields,
      [SOURCE_KEY]: sql`${relation.referencing}`.as(SOURCE_KEY),
      [RANK_KEY]:
        sql<number>`row_number() over (partition by ${relation.referencing} order by ${relation.target.id})`.as(
          RANK_KEY,
        ),
    })
    .from(relation.target as PgTable)
    .where(and(inArray(relation.referencing, [...ids]), notDeleted(relation.target), relation.where?.(context)))
    .as('__ranked');
  const rank = (ranked as unknown as Record<string, SQL.Aliased<number>>)[RANK_KEY] as SQL.Aliased<number>;
  const rows = await db.select().from(ranked).where(lte(rank, relation.limit)).orderBy(asc(rank));
  return rows as unknown as LoadedRow[];
}

/**
 * Adds the requested relations to serialized rows, with one query per relation
 * however many rows there are. Only a relation's listed columns are read.
 */
export async function attachIncluded<TItem extends object>(
  context: DataContext,
  source: CrudTable,
  relations: ReadonlyMap<string, ResolvedRelation>,
  requested: readonly string[],
  items: readonly TItem[],
): Promise<readonly TItem[]> {
  const ids = items.map((item) => (item as { id?: unknown }).id);
  if (requested.length === 0 || ids.length === 0) return items;
  const loaded = await Promise.all(
    [...new Set(requested)].map(async (name) => {
      const relation = relations.get(name) as ResolvedRelation;
      const rows =
        relation.kind === 'one'
          ? await loadOne(context, source, relation, ids)
          : await loadMany(context, relation, ids);
      const byParent = new Map<string, JsonObject[]>();
      for (const row of rows) {
        const key = String(row[SOURCE_KEY]);
        const projected = toJsonRow(
          Object.fromEntries(Object.keys(relation.fields).map((field) => [field, row[field]])),
        );
        byParent.set(key, [...(byParent.get(key) ?? []), projected]);
      }
      return { name, kind: relation.kind, byParent };
    }),
  );
  return items.map((item) => {
    const key = String((item as { id?: unknown }).id);
    const additions = loaded.map(({ name, kind, byParent }) => [
      name,
      kind === 'one' ? (byParent.get(key)?.[0] ?? null) : (byParent.get(key) ?? []),
    ]);
    return { ...item, ...Object.fromEntries(additions) };
  });
}
