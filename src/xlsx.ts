import { FrameworkError, type JsonObject, type JsonValue } from '@framework/core';
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { type CsvTable, MAX_CSV_FIELDS } from './csv';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const MAX_SHEET_NAME = 31;
const MAX_CELL_CHARS = 32_767;
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
/** Decompressed bytes a workbook may hold; a small upload can declare far more. */
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Compressed bytes inflated between checks of the limit; deflate expands about 1000:1 at most. */
const INFLATE_STEP_BYTES = 16 * 1024;
const MAX_XML_DEPTH = 32;
/** Excel's own limit on a number format; a longer one isn't a real format. */
const MAX_FORMAT_CODE_CHARS = 255;
const COMPRESSION_LEVEL = 6;
// oxlint-disable-next-line no-control-regex -- matching these characters is the point
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\p{Cs}]/gu;
const LETTERS_IN_ALPHABET = 26;
const CHAR_CODE_A = 65;
const MS_PER_DAY = 86_400_000;
const EXCEL_EPOCH_SERIAL = 25_569;
const DATE1904_OFFSET_DAYS = 1_462;
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const xmlEscape = (value: string): string =>
  value
    .replace(INVALID_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function columnLetter(index: number): string {
  let remaining = index + 1;
  let letters = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % LETTERS_IN_ALPHABET;
    letters = String.fromCharCode(CHAR_CODE_A + digit) + letters;
    remaining = Math.floor((remaining - 1) / LETTERS_IN_ALPHABET);
  }
  return letters;
}

/** Strings are always inline text, so a value starting with `=` can never become a formula. */
function cellXml(reference: string, value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text.length > MAX_CELL_CHARS) {
    throw new FrameworkError('EXPORT_CELL_TOO_LONG', `A cell in ${reference} exceeds ${MAX_CELL_CHARS} characters`);
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

const rowXml = (rowNumber: number, columns: readonly string[], values: (column: string) => JsonValue | undefined) =>
  `<row r="${rowNumber}">${columns
    .map((column, index) => cellXml(`${columnLetter(index)}${rowNumber}`, values(column)))
    .join('')}</row>`;

const staticParts = (title: string): readonly [string, string][] => {
  const name = xmlEscape(title.replace(/[[\]:*?/\\]/g, ' ').slice(0, MAX_SHEET_NAME)) || 'Sheet1';
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return [
    [
      '[Content_Types].xml',
      `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/${SHEET_PATH}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `${header}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
  ];
};

/**
 * Writes a one-sheet workbook as it goes: each row is compressed and yielded
 * before the next is read, so memory doesn't grow with the row count.
 */
export async function* xlsxChunks(
  title: string,
  columns: readonly string[],
  rows: AsyncIterable<JsonObject>,
): AsyncGenerator<Uint8Array> {
  const pending: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    pending.push(chunk);
  });
  for (const [path, content] of staticParts(title)) {
    const part = new ZipDeflate(path, { level: COMPRESSION_LEVEL });
    zip.add(part);
    part.push(strToU8(content), true);
  }
  const sheet = new ZipDeflate(SHEET_PATH, { level: COMPRESSION_LEVEL });
  zip.add(sheet);
  sheet.push(
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml(1, columns, (column) => column)}`,
    ),
  );
  yield* pending.splice(0);

  let rowNumber = 1;
  for await (const row of rows) {
    rowNumber += 1;
    if (rowNumber > MAX_ROWS) {
      throw new FrameworkError('EXPORT_TOO_MANY_ROWS', `A worksheet holds at most ${MAX_ROWS} rows`);
    }
    sheet.push(strToU8(rowXml(rowNumber, columns, (column) => row[column])));
    yield* pending.splice(0);
  }
  sheet.push(strToU8('</sheetData></worksheet>'), true);
  zip.end();
  yield* pending.splice(0);
}

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/**
 * Runs the handlers over one part. A DOCTYPE is refused, so entities are never
 * defined or expanded, and depth is capped because the parser's tag stack costs
 * far more memory than the compressed input it comes from.
 */
function readXml(
  bytes: Uint8Array,
  handlers: {
    readonly open?: (name: string, tag: SaxesTagPlain) => void;
    readonly close?: (name: string) => void;
    readonly text?: (text: string) => void;
  },
): void {
  const parser = new SaxesParser();
  let depth = 0;
  parser.on('doctype', () => {
    throw new FrameworkError('IMPORT_INVALID', 'The workbook contains a DOCTYPE');
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth > MAX_XML_DEPTH) throw new FrameworkError('IMPORT_INVALID', 'The workbook nests too deeply');
    handlers.open?.(localName(tag.name), tag as SaxesTagPlain);
  });
  parser.on('closetag', (tag) => {
    depth -= 1;
    handlers.close?.(localName(tag.name));
  });
  if (handlers.text) parser.on('text', handlers.text);
  parser.write(strFromU8(bytes)).close();
}

const attribute = (tag: SaxesTagPlain, name: string): string | undefined => {
  const match = Object.entries(tag.attributes).find(([key]) => localName(key) === name);
  return match ? String(match[1]) : undefined;
};

const WANTED_PART =
  /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/;

/**
 * Unzips by counting what actually comes out. The sizes and entry count a zip
 * declares are the client's to choose, so this reads entries in order rather
 * than trusting the central directory, and feeds the inflater in small steps so
 * the limit stops a bomb early.
 */
function readParts(bytes: Uint8Array): Readonly<Record<string, Uint8Array>> {
  const parts: Record<string, Uint8Array> = {};
  let inflated = 0;
  const unzip = new Unzip((file) => {
    if (!WANTED_PART.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      inflated += chunk.length;
      if (inflated > MAX_UNCOMPRESSED_BYTES) {
        throw new FrameworkError('IMPORT_TOO_LARGE', `The workbook expands past ${MAX_UNCOMPRESSED_BYTES} bytes`);
      }
      chunks.push(chunk);
      if (final) parts[file.name] = new Uint8Array(Buffer.concat(chunks));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += INFLATE_STEP_BYTES) {
    const end = offset + INFLATE_STEP_BYTES;
    unzip.push(bytes.subarray(offset, end), end >= bytes.length);
  }
  return parts;
}

function readFirstSheetPath(parts: Readonly<Record<string, Uint8Array>>): { path: string; date1904: boolean } {
  const workbook = parts['xl/workbook.xml'];
  const relationships = parts['xl/_rels/workbook.xml.rels'];
  if (!workbook || !relationships) throw new FrameworkError('IMPORT_INVALID', 'The file is not a workbook');
  let sheetId: string | undefined;
  let date1904 = false;
  readXml(workbook, {
    open(name, tag) {
      if (name === 'sheet') sheetId ??= attribute(tag, 'id');
      if (name === 'workbookPr') date1904 = ['1', 'true'].includes(attribute(tag, 'date1904') ?? '');
    },
  });
  let target: string | undefined;
  readXml(relationships, {
    open(name, tag) {
      if (name === 'Relationship' && attribute(tag, 'Id') === sheetId) target = attribute(tag, 'Target');
    },
  });
  if (!target) throw new FrameworkError('IMPORT_INVALID', 'The workbook has no worksheet');
  return { path: target.startsWith('/') ? target.slice(1) : `xl/${target}`, date1904 };
}

function readSharedStrings(bytes: Uint8Array | undefined): readonly string[] {
  if (!bytes) return [];
  const strings: string[] = [];
  let current = '';
  let inText = false;
  let inPhonetic = false;
  readXml(bytes, {
    open(name) {
      if (name === 'si') current = '';
      if (name === 'rPh') inPhonetic = true;
      if (name === 't') inText = !inPhonetic;
    },
    text(text) {
      if (inText) current += text;
    },
    close(name) {
      if (name === 't') inText = false;
      if (name === 'rPh') inPhonetic = false;
      if (name === 'si') strings.push(current);
    },
  });
  return strings;
}

const looksLikeDateFormat = (code: string): boolean =>
  code.length <= MAX_FORMAT_CODE_CHARS && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** Which cell style indexes display a date, since dates are stored as plain numbers. */
function readDateStyles(bytes: Uint8Array | undefined): ReadonlySet<number> {
  if (!bytes) return new Set();
  const customFormats = new Map<number, string>();
  const dateStyles = new Set<number>();
  let inCellXfs = false;
  let index = 0;
  readXml(bytes, {
    open(name, tag) {
      if (name === 'numFmt') {
        customFormats.set(Number(attribute(tag, 'numFmtId')), attribute(tag, 'formatCode') ?? '');
      }
      if (name === 'cellXfs') inCellXfs = true;
      if (name === 'xf' && inCellXfs) {
        const id = Number(attribute(tag, 'numFmtId') ?? 0);
        if (BUILT_IN_DATE_FORMATS.has(id) || looksLikeDateFormat(customFormats.get(id) ?? '')) dateStyles.add(index);
        index += 1;
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return dateStyles;
}

function columnIndex(reference: string | undefined, fallback: number): number {
  const letters = reference?.match(/^[A-Z]+/)?.[0];
  if (!letters) return fallback;
  let index = 0;
  for (const letter of letters) index = index * LETTERS_IN_ALPHABET + (letter.charCodeAt(0) - CHAR_CODE_A + 1);
  if (index > MAX_COLUMNS) throw new FrameworkError('IMPORT_INVALID', `Cell ${reference} is outside the worksheet`);
  return index - 1;
}

interface SheetContext {
  readonly strings: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  readonly date1904: boolean;
}

function cellValue(type: string, style: number, raw: string, context: SheetContext): string {
  if (type === 's') {
    const shared = context.strings[Number(raw)];
    if (shared === undefined) throw new FrameworkError('IMPORT_INVALID', 'A cell points at a missing shared string');
    return shared;
  }
  if (type === 'b') return raw === '1' ? 'true' : 'false';
  if (raw !== '' && (type === 'n' || type === '') && context.dateStyles.has(style)) {
    const days = Number(raw) + (context.date1904 ? DATE1904_OFFSET_DAYS : 0) - EXCEL_EPOCH_SERIAL;
    return new Date(Math.round(days * MS_PER_DAY)).toISOString();
  }
  return raw;
}

function readSheet(bytes: Uint8Array, context: SheetContext): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let fields = 0;
  let column = 0;
  let type = '';
  let style = 0;
  let raw = '';
  let collecting = false;
  let inPhonetic = false;
  readXml(bytes, {
    open(name, tag) {
      if (name === 'row') {
        row = [];
        column = 0;
      } else if (name === 'c') {
        column = columnIndex(attribute(tag, 'r'), column);
        type = attribute(tag, 't') ?? '';
        style = Number(attribute(tag, 's') ?? 0);
        raw = '';
      } else if (name === 'rPh') {
        inPhonetic = true;
      } else if (name === 'v' || name === 't') {
        collecting = !inPhonetic;
      }
    },
    text(text) {
      if (collecting) raw += text;
    },
    close(name) {
      if (name === 'v' || name === 't') {
        collecting = false;
      } else if (name === 'rPh') {
        inPhonetic = false;
      } else if (name === 'c') {
        while (row.length < column) row.push('');
        row[column] = cellValue(type, style, raw, context);
        column += 1;
        fields += 1;
        if (fields > MAX_CSV_FIELDS) {
          throw new FrameworkError('CSV_TOO_LARGE', `The worksheet exceeds ${MAX_CSV_FIELDS} fields`);
        }
      } else if (name === 'row' && row.some((value) => value !== '')) {
        fields += row.length;
        if (fields > MAX_CSV_FIELDS) {
          throw new FrameworkError('CSV_TOO_LARGE', `The worksheet exceeds ${MAX_CSV_FIELDS} fields`);
        }
        rows.push(row);
      }
    },
  });
  return rows;
}

/**
 * Reads a workbook's first sheet into the same shape as `parseCsv`: values are
 * strings for the row schema to coerce, and dates become ISO timestamps. Rows
 * with no values are skipped. Bounded by decompressed size and field count, and
 * refuses a DOCTYPE, because the file comes from a client.
 */
export function parseXlsx(bytes: Uint8Array): CsvTable {
  try {
    const parts = readParts(bytes);
    const { path, date1904 } = readFirstSheetPath(parts);
    const sheet = Object.hasOwn(parts, path) ? parts[path] : undefined;
    if (!sheet) throw new FrameworkError('IMPORT_INVALID', 'The workbook has no worksheet');
    const [columns, ...rows] = readSheet(sheet, {
      strings: readSharedStrings(parts['xl/sharedStrings.xml']),
      dateStyles: readDateStyles(parts['xl/styles.xml']),
      date1904,
    });
    if (!columns) throw new FrameworkError('IMPORT_INVALID', 'The worksheet has no header row');
    return { columns, rows };
  } catch (error) {
    if (error instanceof FrameworkError) throw error;
    throw new FrameworkError('IMPORT_INVALID', 'The file is not a readable workbook', { cause: error });
  }
}
