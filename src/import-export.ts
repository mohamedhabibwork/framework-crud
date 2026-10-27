import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type ExecutionContext, FrameworkError, type JsonObject, type JsonValue, type Token } from '@framework/core';
import { createDomainEvent, EVENT_BUS } from '@framework/events';
import {
  authorizationGuard,
  badRequest,
  type FrameworkEnv,
  type MountAuthorization,
  notFound,
  serviceUnavailable,
} from '@framework/http';
import { type DispatchOptions, defineJob, type JobContext, type JobDefinition, type JobStatus } from '@framework/queue';
import { validate } from '@framework/validation';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v4';
import type { CrudRepository, ExportRow, ImportRow, ResourceEntity } from './contracts';
import { csvToObjects, parseCsv, toCsvLine } from './csv';

export type DataFormat = 'csv' | 'json';

const RESOURCE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_ERRORS_REPORTED = 50;
const DEFAULT_IMPORT_BATCH = 100;
const DEFAULT_EXPORT_BATCH = 500;

// ---------------------------------------------------------------------------
// Import

export type ImportPayload = {
  readonly resource: string;
  readonly format: DataFormat;
  readonly content: string;
};

export type ImportOutcome = {
  readonly created: number;
  readonly failed: number;
  readonly errors: readonly string[];
};

export interface ImportJobSpec<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> {
  readonly resource: string;
  readonly repository: Token<CrudRepository<TEntity, TCreate, TUpdate>>;
  /** Validates (and coerces) each parsed row; rejected rows are reported. */
  readonly rowSchema: z.ZodType<TCreate>;
  /** Required CSV header, in order. Must match `rowSchema`'s shape. */
  readonly columns?: readonly string[];
  readonly batchSize?: number;
}

/** Parses `content` into row objects for validation by `rowSchema`. */
function parseImportContent(payload: ImportPayload, columns?: readonly string[]): readonly ImportRow[] {
  if (payload.content.length > MAX_IMPORT_BYTES) {
    throw new FrameworkError('IMPORT_TOO_LARGE', `Import content exceeds ${MAX_IMPORT_BYTES} bytes`);
  }
  if (payload.format === 'json') {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(payload.content) as JsonValue;
    } catch (error) {
      throw new FrameworkError(
        'IMPORT_INVALID',
        `Import JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed))
      throw new FrameworkError('IMPORT_INVALID', 'Import JSON must be an array of row objects');
    return parsed.filter((row): row is JsonObject => typeof row === 'object' && row !== null && !Array.isArray(row));
  }
  const table = parseCsv(payload.content);
  if (columns && table.columns.join(',') !== columns.join(',')) {
    throw new FrameworkError(
      'IMPORT_HEADER_MISMATCH',
      `CSV header must be "${columns.join(',')}" but got "${table.columns.join(',')}"`,
    );
  }
  return csvToObjects(table);
}

/**
 * Queued import: every row is validated with `rowSchema`; valid rows are
 * inserted in batches (one transaction per batch, so one bad batch does not
 * roll back the others — partial success is reported). Attempts are fixed at
 * 1 because re-running would duplicate earlier batches.
 */
export function defineImportJob<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(spec: ImportJobSpec<TEntity, TCreate, TUpdate>): JobDefinition<ImportPayload, ImportOutcome> {
  return defineJob({
    name: `${spec.resource}.import`,
    version: 1,
    attempts: 1,
    payload: z
      .object({ resource: z.literal(spec.resource), format: z.enum(['csv', 'json']), content: z.string().min(1) })
      .strict(),
    async handle(payload, context: JobContext): Promise<ImportOutcome> {
      const rows = parseImportContent(payload, spec.columns);
      await report(spec.resource, 'import.started', { total: rows.length }, context);
      const repository = context.scope.resolve(spec.repository);
      const valid: TCreate[] = [];
      const errors: string[] = [];
      rows.forEach((row, index) => {
        const parsed = spec.rowSchema.safeParse(row);
        if (parsed.success) valid.push(parsed.data);
        else if (errors.length < MAX_ERRORS_REPORTED) {
          errors.push(`row ${index + 2}: ${parsed.error.issues[0]?.message ?? 'invalid row'}`);
        }
      });

      const size = spec.batchSize ?? DEFAULT_IMPORT_BATCH;
      let created = 0;
      for (let start = 0; start < valid.length; start += size) {
        const batch = valid.slice(start, start + size);
        try {
          const entities = await repository.createMany(batch);
          created += entities.length;
        } catch (error) {
          if (errors.length < MAX_ERRORS_REPORTED) {
            errors.push(
              `rows ${start + 1}-${start + batch.length}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        await report(
          spec.resource,
          'import.progress',
          { done: Math.min(start + size, valid.length), total: valid.length },
          context,
        );
      }
      const outcome: ImportOutcome = { created, failed: rows.length - created, errors };
      await report(spec.resource, 'import.completed', { created, failed: outcome.failed }, context);
      return outcome;
    },
  });
}

// ---------------------------------------------------------------------------
// Export

export type ExportPayload = {
  readonly resource: string;
  readonly format: DataFormat;
};

export type ExportOutcome = {
  readonly rows: number;
  readonly artifact: string;
};

export interface StoredExport {
  readonly name: string;
  readonly content: string;
}

/** Where finished export artifacts land; must be shared with the download endpoint. */
export interface ExportStore {
  write(jobId: string, name: string, content: string): Promise<void>;
  fetch(jobId: string): Promise<StoredExport | null>;
}

/** Local-disk store (`storage/exports`); single-node deployments. */
export class LocalExportStore implements ExportStore {
  constructor(readonly dir: string) {}

  #path(jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new FrameworkError('EXPORT_ID_INVALID', 'Invalid export job id');
    return join(this.dir, `${jobId.replace(/[^A-Za-z0-9._-]/g, '_')}.artifact`);
  }

  async write(jobId: string, name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Bun.write(this.#path(jobId), content);
    await Bun.write(`${this.#path(jobId)}.name`, name);
  }

  async fetch(jobId: string): Promise<StoredExport | null> {
    const artifact = Bun.file(this.#path(jobId));
    if (!(await artifact.exists())) return null;
    const name = await Bun.file(`${this.#path(jobId)}.name`)
      .text()
      .catch(() => `${jobId}.txt`);
    return { name, content: await artifact.text() };
  }
}

/**
 * The slice of `@framework/storage`'s `StorageDisk` this store needs,
 * declared structurally so no package dependency is added: any disk (local,
 * s3, r2, minio, …) satisfies it.
 */
export interface ArtifactDisk {
  put(path: string, data: string | Uint8Array): Promise<void>;
  get(path: string): Promise<{ readonly content: Uint8Array }>;
  exists(path: string): Promise<boolean>;
}

/** Object name inside the disk for one export artifact (metadata rides in-object). */
const artifactPath = (jobId: string): string => {
  if (!JOB_ID.test(jobId)) throw new FrameworkError('EXPORT_ID_INVALID', 'Invalid export job id');
  return `exports/${jobId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
};

/**
 * Shared-store export artifacts for multi-node deployments: workers and web
 * nodes exchange exports through a `@framework/storage` disk (s3/r2/minio on
 * one node, read by another). The artifact name is stored alongside the
 * content in one JSON object, so a single key holds the whole export.
 */
export class DiskExportStore implements ExportStore {
  constructor(private readonly disk: ArtifactDisk) {}

  async write(jobId: string, name: string, content: string): Promise<void> {
    await this.disk.put(artifactPath(jobId), JSON.stringify({ name, content } satisfies StoredExport));
  }

  async fetch(jobId: string): Promise<StoredExport | null> {
    const path = artifactPath(jobId);
    if (!(await this.disk.exists(path))) return null;
    const file = await this.disk.get(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(file.content));
    } catch {
      throw new FrameworkError('EXPORT_ARTIFACT_INVALID', `Export artifact ${jobId} is malformed`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredExport).name !== 'string' ||
      typeof (parsed as StoredExport).content !== 'string'
    ) {
      throw new FrameworkError('EXPORT_ARTIFACT_INVALID', `Export artifact ${jobId} is malformed`);
    }
    return parsed as StoredExport;
  }
}

export interface ExportJobSpec<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
> {
  readonly resource: string;
  readonly repository: Token<CrudRepository<TEntity, TCreate, TUpdate>>;
  /** Ordered public columns of the artifact. */
  readonly columns: readonly string[];
  readonly serialize: (entity: TEntity) => JsonObject;
  /** Concrete store, or a scope token resolved when the job runs (DI-friendly). */
  readonly store?: ExportStore;
  readonly storeToken?: Token<ExportStore>;
  readonly batchSize?: number;
}

/**
 * Queued export: streams the repository's keyset batches into a CSV or JSON
 * artifact held by the export store. Memory stays bounded by the batch size;
 * the artifact itself is assembled in memory before it is written.
 */
export function defineExportJob<
  TEntity extends ResourceEntity,
  TCreate extends JsonObject,
  TUpdate extends Partial<TCreate> = Partial<TCreate>,
>(spec: ExportJobSpec<TEntity, TCreate, TUpdate>): JobDefinition<ExportPayload, ExportOutcome> {
  return defineJob({
    name: `${spec.resource}.export`,
    version: 1,
    payload: z.object({ resource: z.literal(spec.resource), format: z.enum(['csv', 'json']) }).strict(),
    async handle(payload, context: JobContext): Promise<ExportOutcome> {
      const repository = context.scope.resolve(spec.repository);
      if (!repository.batches)
        throw new FrameworkError('EXPORT_UNSUPPORTED', 'Repository does not support batched reads');
      const store = spec.store ?? (spec.storeToken ? context.scope.resolve(spec.storeToken) : undefined);
      if (!store) throw new FrameworkError('EXPORT_STORE_MISSING', 'Export job needs `store` or `storeToken`');
      const size = spec.batchSize ?? DEFAULT_EXPORT_BATCH;
      const chunks: string[] = [];
      let rows = 0;
      if (payload.format === 'csv') chunks.push(`${toCsvLine(spec.columns)}\r\n`);
      else chunks.push('[\n');

      for await (const batch of repository.batches(size)) {
        const serialized = batch.map(spec.serialize) as ExportRow[];
        if (payload.format === 'csv') {
          for (const row of serialized) {
            chunks.push(`${toCsvLine(spec.columns.map((c) => String(row[c] ?? '')))}\r\n`);
            rows += 1;
          }
        } else {
          for (const row of serialized) {
            chunks.push(rows === 0 ? '' : ',\n', JSON.stringify(row));
            rows += 1;
          }
        }
        await report(spec.resource, 'export.progress', { rows }, context);
      }
      if (payload.format === 'json') chunks.push('\n]\n');

      const artifact = `${spec.resource}-${new Date().toISOString().slice(0, 10)}.${payload.format}`;
      await store.write(context.jobId, artifact, chunks.join(''));
      await report(spec.resource, 'export.completed', { rows, artifact }, context);
      return { rows, artifact };
    },
  });
}

/** Publishes a progress event when an event bus is bound in the job's scope. */
async function report(resource: string, verb: string, payload: JsonObject, context: JobContext): Promise<void> {
  if (!context.scope.has(EVENT_BUS)) return;
  const bus = context.scope.resolve(EVENT_BUS);
  await bus.publish(createDomainEvent(resource, verb, payload, context.execution));
}

// ---------------------------------------------------------------------------
// Coordinator and HTTP endpoints

/** The queue surface the porter needs; `QueueManager` satisfies it. */
export interface PorterQueue {
  dispatch<TPayload extends JsonObject, TResult extends JsonValue>(
    definition: JobDefinition<TPayload, TResult>,
    payload: TPayload,
    context: ExecutionContext,
    options?: DispatchOptions,
  ): Promise<{ readonly id: string }>;
  status(id: string): Promise<JobStatus | null>;
}

export interface DataPorterOptions {
  readonly queue: PorterQueue;
  readonly store: ExportStore;
  readonly imports: readonly JobDefinition<ImportPayload, ImportOutcome>[];
  readonly exports: readonly JobDefinition<ExportPayload, ExportOutcome>[];
}

/** Dispatches import/export jobs and serves their status and artifacts. */
export class DataPorter {
  readonly #imports: Map<string, JobDefinition<ImportPayload, ImportOutcome>>;
  readonly #exports: Map<string, JobDefinition<ExportPayload, ExportOutcome>>;

  constructor(private readonly options: DataPorterOptions) {
    this.#imports = new Map(DataPorter.index(this.options.imports));
    this.#exports = new Map(DataPorter.index(this.options.exports));
  }

  private static index<T extends { readonly name: string }>(jobs: readonly T[]): Map<string, T> {
    return new Map(jobs.map((job) => [job.name.split('.')[0] as string, job]));
  }

  async runImport(
    resource: string,
    format: DataFormat,
    content: string,
    execution: ExecutionContext,
  ): Promise<{ readonly jobId: string }> {
    const definition = this.#imports.get(resource);
    if (!definition) throw notFound(`No import is configured for "${resource}"`);
    const { id } = await this.options.queue.dispatch(definition, { resource, format, content }, execution);
    return { jobId: id };
  }

  async runExport(
    resource: string,
    format: DataFormat,
    execution: ExecutionContext,
  ): Promise<{ readonly jobId: string }> {
    const definition = this.#exports.get(resource);
    if (!definition) throw notFound(`No export is configured for "${resource}"`);
    const { id } = await this.options.queue.dispatch(definition, { resource, format }, execution);
    return { jobId: id };
  }

  status(jobId: string): Promise<JobStatus | null> {
    return this.options.queue.status(jobId);
  }

  async download(jobId: string): Promise<StoredExport> {
    const stored = await this.options.store.fetch(jobId);
    if (!stored) throw notFound(`No export artifact for job "${jobId}"`);
    return stored;
  }
}

/** Body of `POST /import` (shared by the routes and their OpenAPI schema). */
export const importRequestSchema = z
  .object({
    resource: z.string().regex(RESOURCE_NAME),
    format: z.enum(['csv', 'json']),
    content: z.string().min(1),
  })
  .strict();

/** Body of `POST /export` (shared by the routes and their OpenAPI schema). */
export const exportRequestSchema = z
  .object({
    resource: z.string().regex(RESOURCE_NAME),
    format: z.enum(['csv', 'json']),
  })
  .strict();

export const jobIdParamSchema = z.object({ jobId: z.string().regex(JOB_ID) }).strict();

export interface DataRoutesOptions {
  readonly porter: (c: Context<FrameworkEnv>) => DataPorter;
  readonly execution: (c: Context<FrameworkEnv>) => ExecutionContext;
  /**
   * Required mount-time authorization: a guard that throws an `HttpError`
   * (e.g. `forbidden()`) to deny, or the explicit `'public'` opt-out.
   * Typical guards: `requireAuth()` for any authenticated user or
   * `requireAbility('data.import')` for finer control (both from
   * `@framework/auth`).
   */
  readonly authorize: MountAuthorization;
}

/**
 * Import/export endpoints (mounted per API, e.g. under `/api/v1/data`):
 *
 * ```text
 * POST /import                 dispatch a queued import (CSV/JSON content)
 * GET  /import/status/:jobId   job state, progress and row errors
 * POST /export                 dispatch a queued export
 * GET  /export/status/:jobId   job state
 * GET  /export/download/:jobId the finished artifact
 * ```
 *
 * Authorization is required at mount time — pass a guard or the explicit
 * `'public'` opt-out; the guard runs before validation, so anonymous callers
 * get 401/403 and never observe schema details.
 */
export function importExportRoutes(options: DataRoutesOptions): Hono<FrameworkEnv> {
  const guard = authorizationGuard(options.authorize);
  return new Hono<FrameworkEnv>()
    .post('/import', guard, validate('json', importRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await options
        .porter(c)
        .runImport(body.resource, body.format, body.content, options.execution(c))
        .catch((error: Error) => {
          throw error instanceof FrameworkError && error.code === 'JOB_DISPATCH_FAILED'
            ? serviceUnavailable(error.message)
            : error;
        });
      return c.json({ jobId: result.jobId, status: 'dispatched' }, 202, { location: `/import/status/${result.jobId}` });
    })
    .get('/import/status/:jobId', guard, validate('param', jobIdParamSchema), async (c) => {
      const status = await options.porter(c).status(c.req.valid('param').jobId);
      if (!status) throw notFound('Unknown import job');
      return c.json(status, 200);
    })
    .post('/export', guard, validate('json', exportRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const result = await options
        .porter(c)
        .runExport(body.resource, body.format, options.execution(c))
        .catch((error: Error) => {
          throw error instanceof FrameworkError && error.code === 'JOB_DISPATCH_FAILED'
            ? serviceUnavailable(error.message)
            : error;
        });
      return c.json({ jobId: result.jobId, status: 'dispatched' }, 202, { location: `/export/status/${result.jobId}` });
    })
    .get('/export/status/:jobId', guard, validate('param', jobIdParamSchema), async (c) => {
      const status = await options.porter(c).status(c.req.valid('param').jobId);
      if (!status) throw notFound('Unknown export job');
      return c.json(status, 200);
    })
    .get('/export/download/:jobId', guard, validate('param', jobIdParamSchema), async (c) => {
      const stored = await options.porter(c).download(c.req.valid('param').jobId);
      if (!stored.name.endsWith('.csv') && !stored.name.endsWith('.json')) throw badRequest('Unsupported artifact');
      const type = stored.name.endsWith('.csv') ? 'text/csv' : 'application/json';
      return c.body(stored.content, 200, {
        'content-type': type,
        'content-disposition': `attachment; filename="${stored.name}"`,
      });
    });
}
