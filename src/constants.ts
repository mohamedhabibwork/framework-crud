/** Constants of `@framework/crud`: fixed limits of the data pipeline. */
/** Hard cap on fields per CSV input (hostile-payload protection). */
export const MAX_CSV_FIELDS = 100_000;

/** Maximum import payload size in bytes. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** Upper bound of per-row errors reported by one import run. */
export const MAX_ERRORS_REPORTED = 50;

/** Rows per import transaction (batch). */
export const DEFAULT_IMPORT_BATCH = 100;

/** Rows per export batch (keyset iteration). */
export const DEFAULT_EXPORT_BATCH = 500;
