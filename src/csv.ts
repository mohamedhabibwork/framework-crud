import type { JsonObject } from '@framework/core';
import { FrameworkError } from '@framework/core';

export interface CsvTable {
  readonly columns: readonly string[];
  readonly rows: readonly string[][];
}

const MAX_FIELDS = 100_000;

/**
 * RFC 4180 CSV: fields may be quoted, quotes are doubled, quoted fields may
 * contain commas and newlines. Bounded by field count so a hostile payload
 * cannot exhaust memory.
 */
export function parseCsv(text: string): CsvTable {
  if (text.includes('\0')) throw new FrameworkError('CSV_INVALID', 'CSV input contains NUL bytes');
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fields = 0;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
    fields += 1;
    if (fields > MAX_FIELDS) throw new FrameworkError('CSV_TOO_LARGE', `CSV input exceeds ${MAX_FIELDS} fields`);
  };
  const pushRow = () => {
    pushField();
    table.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (char === ',') {
      pushField();
      i += 1;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      if (row.length > 0 || field !== '' || table.length > 0) pushRow();
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }
  if (quoted) throw new FrameworkError('CSV_INVALID', 'CSV input ends inside a quoted field');
  if (row.length > 0 || field !== '') pushRow();

  const [columns, ...body] = table;
  if (!columns || columns.length === 0) throw new FrameworkError('CSV_INVALID', 'CSV input has no header row');
  return { columns, rows: body };
}

/** Encodes one CSV field, quoting when required. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsvLine(values: readonly string[]): string {
  return values.map(csvField).join(',');
}

/** Objects -> CSV text using `columns` (defaults to the first row's keys). */
export function toCsv(rows: readonly JsonObject[], columns?: readonly string[]): string {
  if (rows.length === 0) return '';
  const header = columns ?? Object.keys(rows[0] as JsonObject);
  const lines = [toCsvLine(header)];
  for (const row of rows) {
    lines.push(toCsvLine(header.map((column) => String(row[column] ?? ''))));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** CSV rows -> objects keyed by the header (values stay strings; schemas coerce). */
export function csvToObjects(table: CsvTable): JsonObject[] {
  return table.rows.map((row) => {
    const object: Record<string, string> = {};
    table.columns.forEach((column, index) => {
      object[column] = row[index] ?? '';
    });
    return object;
  });
}
