import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext, JsonObject, Scope, Token } from '@framework/core';
import { FrameworkError } from '@framework/core';
import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import { Hono } from 'hono';
import { z } from 'zod/v4';
import {
  type ArtifactDisk,
  type CrudRepository,
  DataPorter,
  DiskExportStore,
  defineExportJob,
  defineImportJob,
  type ExportStore,
  importExportRoutes,
  LocalExportStore,
  parseXlsx,
  type PdfRenderer,
  xlsxChunks,
} from '../src';

interface Row extends JsonObject {
  readonly id: string;
  readonly name: string;
}

const REPOSITORY = { key: Symbol('repo'), name: 'test.repo' } as unknown as Token<CrudRepository<Row, Row>>;

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fw-xlsx-'));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function* rowsOf(rows: readonly JsonObject[]): AsyncGenerator<JsonObject> {
  yield* rows;
}

const collect = async (chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
};

const written = (columns: readonly string[], rows: readonly JsonObject[]) =>
  collect(xlsxChunks('Sheet', columns, rowsOf(rows)));

const openWithExcelJs = async (bytes: Uint8Array) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  return workbook.worksheets[0] as ExcelJS.Worksheet;
};

const buildWithExcelJs = async (fill: (sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> => {
  const workbook = new ExcelJS.Workbook();
  fill(workbook.addWorksheet('Data'));
  return new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
};

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof FrameworkError ? error.code : 'other';
  }
};

describe('xlsxChunks', () => {
  test('writes a workbook another implementation can read', async () => {
    const sheet = await openWithExcelJs(
      await written(
        ['id', 'name', 'price', 'active', 'note'],
        [
          { id: 'a', name: 'Plain', price: 12.5, active: true, note: null },
          { id: 'b', name: 'Tom & <Jerry> "q"', price: 0, active: false, note: { nested: 1 } },
        ],
      ),
    );

    expect(sheet.getRow(1).values).toEqual([undefined, 'id', 'name', 'price', 'active', 'note']);
    expect(sheet.getCell('B3').value).toBe('Tom & <Jerry> "q"');
    expect(sheet.getCell('C2').value).toBe(12.5);
    expect(sheet.getCell('D2').value).toBe(true);
    expect(sheet.getCell('E2').value).toBeNull();
    expect(sheet.getCell('E3').value).toBe('{"nested":1}');
  });

  test('a value that looks like a formula stays text', async () => {
    const sheet = await openWithExcelJs(await written(['v'], [{ v: '=HYPERLINK("http://evil","x")' }]));

    expect(sheet.getCell('A2').value).toBe('=HYPERLINK("http://evil","x")');
    expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.String);
  });

  test('characters XML cannot hold are dropped, and whitespace survives', async () => {
    const sheet = await openWithExcelJs(await written(['v'], [{ v: ' a\u0001\uD800b\n ' }]));

    expect(sheet.getCell('A2').value).toBe(' ab\n ');
  });

  test('columns past Z get correct references', async () => {
    const columns = Array.from({ length: 28 }, (_, index) => `c${index}`);
    const sheet = await openWithExcelJs(await written(columns, [{ c26: 'AA', c27: 'AB' }]));

    expect(sheet.getCell('AA2').value).toBe('AA');
    expect(sheet.getCell('AB2').value).toBe('AB');
  });

  test('emits output before the rows end, rather than buffering everything', async () => {
    async function* many(): AsyncGenerator<JsonObject> {
      for (let index = 0; index < 500; index += 1)
        yield { v: `${index}${Buffer.from(crypto.getRandomValues(new Uint8Array(5_000))).toString('hex')}` };
    }
    let chunks = 0;
    let produced = 0;
    async function* counting(): AsyncGenerator<JsonObject> {
      for await (const row of many()) {
        produced += 1;
        yield row;
      }
    }
    let producedAtFirstSheetChunk = -1;
    for await (const chunk of xlsxChunks('Sheet', ['v'], counting())) {
      chunks += chunk.length > 0 ? 1 : 0;
      if (produced > 0 && producedAtFirstSheetChunk < 0) producedAtFirstSheetChunk = produced;
    }

    expect(produced).toBe(500);
    expect(chunks).toBeGreaterThan(10);
    expect(producedAtFirstSheetChunk).toBeLessThan(500);
  });

  test('a cell over the format limit fails rather than producing a corrupt file', async () => {
    await expect(written(['v'], [{ v: 'x'.repeat(32_768) }])).rejects.toMatchObject({ code: 'EXPORT_CELL_TOO_LONG' });
  });
});

describe('parseXlsx', () => {
  test('reads what we write, as strings like CSV', async () => {
    const table = parseXlsx(await written(['id', 'n', 'ok'], [{ id: 'a & b', n: 1.5, ok: true }]));

    expect(table).toEqual({ columns: ['id', 'n', 'ok'], rows: [['a & b', '1.5', 'true']] });
  });

  test('reads shared strings, gaps, dates, formulas and rich text from another implementation', async () => {
    const bytes = await buildWithExcelJs((sheet) => {
      sheet.getCell('A1').value = 'name';
      sheet.getCell('B1').value = 'when';
      sheet.getCell('C1').value = 'total';
      sheet.getCell('D1').value = 'note';
      sheet.getCell('A2').value = 'Ada';
      sheet.getCell('B2').value = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
      sheet.getCell('C2').value = { formula: '1+1', result: 2 } as ExcelJS.CellFormulaValue;
      sheet.getCell('D2').value = { richText: [{ text: 'bo' }, { text: 'ld', font: { bold: true } }] };
      sheet.getCell('A3').value = 'Grace';
      sheet.getCell('D3').value = 'skipped two';
    });

    const table = parseXlsx(bytes);

    expect(table.columns).toEqual(['name', 'when', 'total', 'note']);
    expect(table.rows[0]).toEqual(['Ada', '2026-01-31T12:00:00.000Z', '2', 'bold']);
    expect(table.rows[1]).toEqual(['Grace', '', '', 'skipped two']);
  });

  test('reads the first sheet by the workbook, not by file name', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('First').getCell('A1').value = 'first';
    workbook.addWorksheet('Second').getCell('A1').value = 'second';

    const table = parseXlsx(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    expect(table.columns).toEqual(['first']);
  });

  test('anything that is not a workbook is IMPORT_INVALID', () => {
    expect(codeOf(() => parseXlsx(strToU8('not a zip')))).toBe('IMPORT_INVALID');
    expect(codeOf(() => parseXlsx(zipSync({ 'hello.txt': strToU8('hi') })))).toBe('IMPORT_INVALID');
  });

  test('refuses a zip bomb from its declared size, before inflating', () => {
    const bomb = zipSync({
      '[Content_Types].xml': strToU8('<x/>'),
      'xl/workbook.xml': new Uint8Array(200 * 1024 * 1024),
    });

    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(codeOf(() => parseXlsx(bomb))).toBe('IMPORT_TOO_LARGE');
  });

  test('a part that lies about its size cannot inflate past what it declared', () => {
    const bytes = zipSync({
      'xl/workbook.xml': new Uint8Array(50 * 1024 * 1024),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>'),
    });
    // Rewrite the uncompressed size in the central directory to claim 10 bytes.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 10, true);
    }

    expect(codeOf(() => parseXlsx(bytes))).toBe('IMPORT_INVALID');
  });

  const workbookWith = (sheet: string, extra: Record<string, Uint8Array> = {}) =>
    zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      ...extra,
    });

  test('refuses a DOCTYPE, so entity expansion and external entities never run', () => {
    const laughs = workbookWith(
      '<!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>',
    );
    const external = workbookWith(
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>',
    );

    expect(codeOf(() => parseXlsx(laughs))).toBe('IMPORT_INVALID');
    expect(codeOf(() => parseXlsx(external))).toBe('IMPORT_INVALID');
  });

  test('a zip that lies about its entry count fails fast', () => {
    // A zip64 end record claiming 4 billion entries, in under 100 bytes.
    const record = new Uint8Array(56 + 20 + 22);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06064b50, true);
    view.setUint32(32, 0xffffffff, true);
    view.setUint32(40, 0xffffffff, true);
    view.setUint32(56, 0x07064b50, true);
    view.setUint32(76, 0x06054b50, true);
    view.setUint16(86, 0xffff, true);
    const started = performance.now();

    expect(codeOf(() => parseXlsx(record))).toBe('IMPORT_INVALID');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a part that really inflates past the limit stops at the limit, whatever it declared', () => {
    const bytes = zipSync({ 'xl/workbook.xml': new Uint8Array(300 * 1024 * 1024) });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length - 4; offset += 1) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x02014b50) view.setUint32(offset + 24, 1000, true);
      if (signature === 0x04034b50) view.setUint32(offset + 22, 1000, true);
    }
    const started = performance.now();

    expect(codeOf(() => parseXlsx(bytes))).toBe('IMPORT_TOO_LARGE');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('deeply nested XML is refused before it costs memory', () => {
    expect(codeOf(() => parseXlsx(workbookWith(`<worksheet>${'<a>'.repeat(1_000_000)}`)))).toBe('IMPORT_INVALID');
  });

  test('a format code built to backtrack costs nothing', () => {
    const styles = `<styleSheet><numFmts><numFmt numFmtId="200" formatCode="${'['.repeat(1_000_000)}"/></numFmts><cellXfs><xf numFmtId="200"/></cellXfs></styleSheet>`;
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row></sheetData></worksheet>';
    const started = performance.now();

    expect(parseXlsx(workbookWith(sheet, { 'xl/styles.xml': strToU8(styles) })).columns).toEqual(['a']);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a custom date format is still recognised', () => {
    const styles =
      '<styleSheet><numFmts><numFmt numFmtId="200" formatCode="[$-409]yyyy-mm-dd;@"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="200"/></cellXfs></styleSheet>';
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>when</t></is></c></row><row r="2"><c r="A2" s="1"><v>25569</v></c></row></sheetData></worksheet>';

    expect(parseXlsx(workbookWith(sheet, { 'xl/styles.xml': strToU8(styles) })).rows).toEqual([
      ['1970-01-01T00:00:00.000Z'],
    ]);
  });

  test('malformed XML, or a shared string index out of range, is IMPORT_INVALID', () => {
    expect(codeOf(() => parseXlsx(workbookWith('<worksheet><sheetData><row>')))).toBe('IMPORT_INVALID');
    expect(
      codeOf(() =>
        parseXlsx(
          workbookWith('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>9</v></c></row></sheetData></worksheet>'),
        ),
      ),
    ).toBe('IMPORT_INVALID');
  });

  test('a path outside the archive root is not followed', () => {
    const escaping = zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="../../../etc/passwd"/></Relationships>',
      ),
    });

    expect(codeOf(() => parseXlsx(escaping))).toBe('IMPORT_INVALID');
  });

  test('a huge cell count fails with CSV_TOO_LARGE, like CSV', () => {
    const cells = Array.from({ length: 100_001 }, (_, index) => `<c r="A${index + 1}"><v>1</v></c>`);
    const sheet = `<worksheet><sheetData><row r="1">${cells.join('')}</row></sheetData></worksheet>`;

    expect(codeOf(() => parseXlsx(workbookWith(sheet)))).toBe('CSV_TOO_LARGE');
  });
});

const scopeWith = (repository: Partial<CrudRepository<Row, Row>>) =>
  ({
    has: () => false,
    resolve: () => repository,
  }) as unknown as Scope;

const jobContext = (repository: Partial<CrudRepository<Row, Row>>) =>
  ({
    jobId: 'job-1',
    attempt: 1,
    scope: scopeWith(repository),
    execution: {} as ExecutionContext,
    signal: new AbortController().signal,
    progress: async () => {},
  }) as never;

const seeded = (rows: readonly Row[]): Partial<CrudRepository<Row, Row>> => ({
  async *batches() {
    yield rows;
  },
});

const ROWS: readonly Row[] = [
  { id: '1', name: 'One' },
  { id: '2', name: 'Two' },
];

const exportJob = (store: ExportStore, pdf?: PdfRenderer) =>
  defineExportJob<Row, Row>({
    resource: 'items',
    repository: REPOSITORY,
    columns: ['id', 'name'],
    serialize: (row) => row,
    store,
    ...(pdf ? { pdf } : {}),
  });

describe('export job', () => {
  test('writes an xlsx artifact to the local store and reads it back', async () => {
    const store = new LocalExportStore(await tempDir());

    const outcome = await exportJob(store).handle({ resource: 'items', format: 'xlsx' }, jobContext(seeded(ROWS)));
    const stored = await store.fetch('job-1');

    expect(outcome.rows).toBe(2);
    expect(outcome.artifact).toEndWith('.xlsx');
    expect(parseXlsx(stored?.content as Uint8Array).rows).toEqual([
      ['1', 'One'],
      ['2', 'Two'],
    ]);
  });

  test('csv and json still come back as text from the local store', async () => {
    const store = new LocalExportStore(await tempDir());

    await exportJob(store).handle({ resource: 'items', format: 'csv' }, jobContext(seeded(ROWS)));
    expect((await store.fetch('job-1'))?.content).toBe('id,name\r\n1,One\r\n2,Two\r\n');

    await exportJob(store).handle({ resource: 'items', format: 'json' }, jobContext(seeded(ROWS)));
    expect(JSON.parse((await store.fetch('job-1'))?.content as string)).toEqual(ROWS);
  });

  test('a failure mid-export leaves no partial artifact behind', async () => {
    const dir = await tempDir();
    const store = new LocalExportStore(dir);
    const failing: Partial<CrudRepository<Row, Row>> = {
      async *batches() {
        yield ROWS;
        throw new Error('database went away');
      },
    };

    await expect(exportJob(store).handle({ resource: 'items', format: 'xlsx' }, jobContext(failing))).rejects.toThrow(
      'database went away',
    );

    expect(await store.fetch('job-1')).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test('two overlapping writes of one job publish one whole artifact', async () => {
    const dir = await tempDir();
    const store = new LocalExportStore(dir);
    const slowly = async function* (text: string) {
      for (let index = 0; index < 5; index += 1) {
        yield new TextEncoder().encode(text);
        await Bun.sleep(5);
      }
    };

    await Promise.all([
      store.writeStream('job-1', 'a.csv', slowly('a')),
      store.writeStream('job-1', 'b.csv', slowly('b')),
    ]);

    expect(['aaaaa', 'bbbbb']).toContain((await store.fetch('job-1'))?.content as string);
    expect((await readdir(dir)).filter((name) => name.includes('partial'))).toEqual([]);
  });

  test('a disk store keeps binary artifacts intact and still reads old text ones', async () => {
    const files = new Map<string, Uint8Array>();
    const disk: ArtifactDisk = {
      put: async (path, data) => {
        files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
      get: async (path) => ({ content: files.get(path) as Uint8Array }),
      exists: async (path) => files.has(path),
    };
    const store = new DiskExportStore(disk);

    await exportJob(store).handle({ resource: 'items', format: 'xlsx' }, jobContext(seeded(ROWS)));
    expect(parseXlsx((await store.fetch('job-1'))?.content as Uint8Array).rows).toHaveLength(2);

    await exportJob(store).handle({ resource: 'items', format: 'csv' }, jobContext(seeded(ROWS)));
    expect((await store.fetch('job-1'))?.content).toStartWith('id,name');

    await disk.put('exports/old.json', JSON.stringify({ name: 'old.csv', content: 'a,b' }));
    expect((await store.fetch('old'))?.content).toBe('a,b');
  });

  test('pdf goes through the renderer, with every row', async () => {
    const seen: JsonObject[] = [];
    const renderer: PdfRenderer = {
      async *render({ title, columns, rows }) {
        for await (const row of rows) seen.push(row);
        yield new TextEncoder().encode(`%PDF ${title} ${columns.join(',')}`);
      },
    };
    const store = new LocalExportStore(await tempDir());

    const outcome = await exportJob(store, renderer).handle(
      { resource: 'items', format: 'pdf' },
      jobContext(seeded(ROWS)),
    );

    expect(outcome.artifact).toEndWith('.pdf');
    expect(outcome.rows).toBe(2);
    expect(seen).toEqual([...ROWS]);
    expect(new TextDecoder().decode((await store.fetch('job-1'))?.content as Uint8Array)).toBe('%PDF items id,name');
  });

  test('pdf is refused without a renderer', () => {
    const job = exportJob(new LocalExportStore('unused'));

    expect(job.payload.safeParse({ resource: 'items', format: 'pdf' }).success).toBe(false);
    expect(job.payload.safeParse({ resource: 'items', format: 'xlsx' }).success).toBe(true);
  });
});

describe('import job', () => {
  const importJob = () =>
    defineImportJob<Row, Row>({
      resource: 'items',
      repository: REPOSITORY,
      rowSchema: z.object({ id: z.string().min(1), name: z.string().min(2) }),
      columns: ['id', 'name'],
    });
  const creating = (created: Row[]): Partial<CrudRepository<Row, Row>> => ({
    createMany: async (rows) => {
      created.push(...(rows as Row[]));
      return rows as Row[];
    },
  });
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  test('imports base64 xlsx content, reporting bad rows', async () => {
    const created: Row[] = [];
    const content = base64(
      await written(
        ['id', 'name'],
        [
          { id: '1', name: 'One' },
          { id: '2', name: 'x' },
        ],
      ),
    );

    const outcome = await importJob().handle(
      { resource: 'items', format: 'xlsx', content },
      jobContext(creating(created)),
    );

    expect(created).toEqual([{ id: '1', name: 'One' }]);
    expect(outcome.failed).toBe(1);
    expect(outcome.errors[0]).toStartWith('row 3:');
  });

  test('checks the header like CSV', async () => {
    const content = base64(await written(['wrong', 'name'], [{ wrong: '1', name: 'One' }]));

    await expect(
      importJob().handle({ resource: 'items', format: 'xlsx', content }, jobContext(creating([]))),
    ).rejects.toMatchObject({ code: 'IMPORT_HEADER_MISMATCH' });
  });

  test('invalid base64 is IMPORT_INVALID', async () => {
    await expect(
      importJob().handle({ resource: 'items', format: 'xlsx', content: '!!!not base64!!!' }, jobContext(creating([]))),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
  });
});

describe('routes', () => {
  const appFor = async (renderer?: PdfRenderer) => {
    const store = new LocalExportStore(await tempDir());
    const job = exportJob(store, renderer);
    const queue = {
      dispatch: async (definition: typeof job, payload: { resource: string; format: string }) => {
        const parsed = definition.payload.safeParse(payload);
        if (!parsed.success) throw new FrameworkError('JOB_PAYLOAD_INVALID', 'invalid');
        await definition.handle(parsed.data, jobContext(seeded(ROWS)));
        return { id: 'job-1' };
      },
      status: async () => null,
    };
    const porter = new DataPorter({ queue: queue as never, store, imports: [], exports: [job] });
    return new Hono()
      .onError((error, c) => c.json({}, (error as unknown as { status: 422 }).status ?? 500))
      .route(
        '/',
        importExportRoutes({ porter: () => porter, execution: () => ({}) as ExecutionContext, authorize: 'public' }),
      );
  };
  const post = (body: object) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('downloads an xlsx with the right type and intact bytes', async () => {
    const app = await appFor();

    expect((await app.request('/export', post({ resource: 'items', format: 'xlsx' }))).status).toBe(202);
    const response = await app.request('/export/download/job-1');

    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers.get('content-disposition')).toContain('.xlsx');
    expect(parseXlsx(new Uint8Array(await response.arrayBuffer())).rows).toHaveLength(2);
  });

  test('asking for pdf without a renderer is a 422, not a 500', async () => {
    const app = await appFor();

    expect((await app.request('/export', post({ resource: 'items', format: 'pdf' }))).status).toBe(422);
  });

  test('downloads a rendered pdf', async () => {
    const app = await appFor({
      render: async () => new TextEncoder().encode('%PDF-1.7'),
    });

    await app.request('/export', post({ resource: 'items', format: 'pdf' }));
    const response = await app.request('/export/download/job-1');

    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF-1.7');
  });
});
