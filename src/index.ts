// Public API of @framework/crud.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (classes, functions, schemas) stay in their modules.

export { BaseRepository, BaseSoftDeletableRepository, baseRepository } from '@framework/database';
export { auditRoutes } from './audit-routes';
export { BaseService, type BaseServiceOptions, baseService } from './base-service';
export {
  DEFAULT_EXPORT_BATCH,
  DEFAULT_IMPORT_BATCH,
  MAX_CSV_FIELDS,
  MAX_ERRORS_REPORTED,
  MAX_IMPORT_BYTES,
} from './constants';
export { ResourceController } from './controller';
export { csvField, csvToObjects, parseCsv, toCsv, toCsvLine } from './csv';
export {
  DataPorter,
  DiskExportStore,
  defineExportJob,
  defineImportJob,
  exportRequestSchema,
  importExportRoutes,
  importRequestSchema,
  jobIdParamSchema,
  LocalExportStore,
} from './import-export';
export { dataOperations, dispatchResponseSchema, pluralizeResource, resourceOperations } from './openapi';
export { type ResourceOptions, resourceRoutes, resourceServiceToken } from './resource-routes';
export { createRouter, ResourceRouter } from './router';
export {
  type ResolvedResourceSchemas,
  type ResourceSchemaOptions,
  resolveResourceSchemas,
} from './schema-resolver';
export { DEFAULT_SERVICE_CONTEXT, ownedBy, ResourceService } from './service';
// Grouped conventions: every type in ./types, every constant in ./constants.
export type {
  ArtifactDisk,
  AuditRoutesOptions,
  CrudRepository,
  CsvTable,
  DataFormat,
  DataOperationsInput,
  DataPorterOptions,
  DataRoutesOptions,
  EntityId,
  ExportJobSpec,
  ExportOutcome,
  ExportPayload,
  ExportRow,
  ExportStore,
  ImportJobSpec,
  ImportOutcome,
  ImportPayload,
  ImportRow,
  JsonRecord,
  OwnershipConfig,
  Page,
  PageMeta,
  PageRequest,
  PageResponse,
  PorterQueue,
  QueryOptions,
  ResourceEntity,
  ResourceOperationsInput,
  ResourceServiceOptions,
  ServiceContext,
  StoredExport,
} from './types';
