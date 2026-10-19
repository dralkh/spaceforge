/**
 * A self-contained, read-only SQLite file reader.
 *
 * Anki's collection lives in a SQLite database, and the plugin cannot ship a
 * SQLite build: Obsidian runs the same bundle on desktop, mobile and in the
 * webview, so the database has to be parsed here in plain TypeScript. This is
 * the read half — header, `sqlite_master`, table b-trees (interior and leaf),
 * overflow chains, varints and every serial type — and it is deliberately
 * read-only: nothing in this file writes to the buffer it is handed.
 *
 * The caller's buffer is held, not copied, so a large collection costs one copy
 * of the file plus whatever rows are actually read.
 */

/** A value as SQLite stores it. */
export type SqlValue = null | number | string | Uint8Array;

/** One row, keyed by column name (column order is preserved by `columns`). */
export interface SqlRow {
    [column: string]: SqlValue;
}

/** A table found in `sqlite_master`. */
export interface SqliteTable {
    name: string;
    /** `sqlite_master.type`, normally "table". */
    kind: string;
    /** The page the table's b-tree starts on. */
    rootPage: number;
    /** The original CREATE statement, as stored. */
    sql: string;
    /** Column names, in declaration order, parsed from the CREATE statement. */
    columns: string[];
    /**
     * The column that aliases the rowid (`INTEGER PRIMARY KEY`), or -1. SQLite
     * stores NULL in that column and substitutes the rowid when reading, so the
     * reader has to do the same.
     */
    rowidColumn: number;
}

/** An opened database: the buffer plus the schema read from it. */
export interface SqliteDatabase {
    bytes: Uint8Array;
    pageSize: number;
    reservedSpace: number;
    /** pageSize - reservedSpace. */
    usableSize: number;
    encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
    pageCount: number;
    schemaCookie: number;
    /** Tables and views in `sqlite_master`, in schema order. */
    tables: SqliteTable[];
}

/** The rows of one table. */
export interface SqliteTableData {
    name: string;
    columns: string[];
    rows: SqlRow[];
}

const MAGIC = 'SQLite format 3\0';

/** Hard ceilings, so a corrupt header cannot make us allocate wildly. */
const MAX_PAGE_SIZE = 65536;
const MIN_PAGE_SIZE = 512;

interface TablePage {
    type: number;
    /** Absolute offsets of the cells, in key order. */
    cells: number[];
    rightmost: number;
}

function fail(message: string): never {
    throw new Error(`sqlite: ${message}`);
}

function u16(bytes: Uint8Array, at: number): number {
    // Everything SQLite writes on disk — file header, b-tree page headers,
    // cell pointers, overflow pointers — is big-endian.
    return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** Reads a SQLite varint (1–9 bytes, little-endian 7-bit groups). */
export function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
    let value = 0;
    for (let i = 0; i < 8; i++) {
        const byte = bytes[at + i];
        if (byte === undefined) {
            return fail('varint runs past the end of the file');
        }
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            return { value, next: at + i + 1 };
        }
    }
    const last = bytes[at + 8];
    if (last === undefined) {
        return fail('varint runs past the end of the file');
    }
    // The ninth byte contributes all eight of its bits.
    value = value * 256 + last;
    return { value, next: at + 9 };
}

/* ------------------------------------------------------------------ open */

function readHeader(bytes: Uint8Array): {
    pageSize: number;
    reservedSpace: number;
    usableSize: number;
    encoding: SqliteDatabase['encoding'];
    pageCount: number;
    schemaCookie: number;
} {
    if (bytes.length < 100) {
        return fail('file is too short to be a database');
    }
    let magic = '';
    for (let i = 0; i < MAGIC.length; i++) {
        magic += String.fromCharCode(bytes[i]);
    }
    if (magic !== MAGIC) {
        return fail('missing the SQLite file header');
    }
    let pageSize = u16(bytes, 16);
    if (pageSize === 1) {
        pageSize = 65536;
    }
    if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE || (pageSize & (pageSize - 1)) !== 0) {
        return fail(`invalid page size ${pageSize}`);
    }
    const reservedSpace = bytes[20];
    const usableSize = pageSize - reservedSpace;
    const encodingByte = bytes[56];
    const encoding: SqliteDatabase['encoding'] =
        encodingByte === 2 ? 'utf-16le' : encodingByte === 3 ? 'utf-16be' : 'utf-8';
    const declaredPages = u32(bytes, 28);
    const pageCount = declaredPages > 0 ? declaredPages : Math.floor(bytes.length / pageSize);
    return { pageSize, reservedSpace, usableSize, encoding, pageCount, schemaCookie: u32(bytes, 40) };
}

/** Opens a database buffer and reads its schema. */
export function openSqlite(bytes: Uint8Array): SqliteDatabase {
    const header = readHeader(bytes);
    const db: SqliteDatabase = {
        bytes,
        pageSize: header.pageSize,
        reservedSpace: header.reservedSpace,
        usableSize: header.usableSize,
        encoding: header.encoding,
        pageCount: header.pageCount,
        schemaCookie: header.schemaCookie,
        tables: [],
    };
    db.tables = readSchema(db);
    return db;
}

/* ----------------------------------------------------------------- pages */

function pageOffset(db: SqliteDatabase, pageNo: number): number {
    return (pageNo - 1) * db.pageSize;
}

function parseTablePage(db: SqliteDatabase, pageNo: number): TablePage {
    const { bytes, pageSize } = db;
    if (pageNo < 1 || pageNo > db.pageCount) {
        return fail(`page ${pageNo} is outside the database`);
    }
    const offset = pageOffset(db, pageNo);
    if (offset + pageSize > bytes.length) {
        return fail(`page ${pageNo} runs past the end of the file`);
    }
    const header = pageNo === 1 ? 100 : 0;
    const type = bytes[offset + header];
    if (type !== 2 && type !== 5 && type !== 10 && type !== 13) {
        return fail(`page ${pageNo} is not a b-tree page (type ${type})`);
    }
    const nCell = u16(bytes, offset + header + 3);
    const interior = type === 2 || type === 5;
    const pointerArray = offset + header + (interior ? 12 : 8);
    if (pointerArray + 2 * nCell > offset + pageSize) {
        return fail(`page ${pageNo} has a corrupt cell pointer array`);
    }
    const cells: number[] = [];
    for (let i = 0; i < nCell; i++) {
        const cellOffset = u16(bytes, pointerArray + 2 * i);
        if (cellOffset < 1 || cellOffset >= pageSize) {
            return fail(`page ${pageNo} points its cell ${i} outside the page`);
        }
        cells.push(offset + cellOffset);
    }
    return { type, cells, rightmost: interior ? u32(bytes, offset + header + 8) : 0 };
}

/**
 * Walks a table b-tree, yielding every leaf cell in rowid order.
 *
 * `index` pages are walked the same way but their cells are records without a
 * rowid in front; Anki's newer schema keeps `fields`, `templates` and `config`
 * in WITHOUT ROWID tables, which are stored as index b-trees.
 */
function* walkTablePages(db: SqliteDatabase, rootPage: number, index: boolean): Generator<number> {
    const stack: number[] = [rootPage];
    const seen = new Set<number>();
    while (stack.length > 0) {
        const pageNo = stack.pop() as number;
        if (seen.has(pageNo)) {
            fail(`page ${pageNo} is visited twice; the b-tree has a cycle`);
        }
        seen.add(pageNo);
        const page = parseTablePage(db, pageNo);
        if (page.type === 13 || page.type === 10) {
            for (const cell of page.cells) {
                yield cell;
            }
            continue;
        }
        if (page.type !== 5 && page.type !== 2) {
            fail(`page ${pageNo} is not part of a b-tree`);
        }
        if ((page.type === 2) !== index) {
            fail(`page ${pageNo} mixes table and index pages`);
        }
        // Children are visited left to right, so push them right to left.
        stack.push(page.rightmost);
        for (let i = page.cells.length - 1; i >= 0; i--) {
            stack.push(u32(db.bytes, page.cells[i]));
        }
    }
}

/**
 * The bytes a table leaf cell stored, following any overflow chain.
 *
 * SQLite keeps at least `localSize` of a record on the page; the rest lives in
 * a linked list of overflow pages that each start with the next page number.
 */
function readPayload(db: SqliteDatabase, start: number, size: number, usableSize: number, localLimit: number): Uint8Array {
    const { bytes } = db;
    if (size <= localLimit) {
        if (start + size > bytes.length) {
            return fail('record runs past the end of the file');
        }
        return bytes.subarray(start, start + size);
    }
    // How much of the record stays on the page (SQLite's "spill" rule).
    const m = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const k = m + ((size - m) % (usableSize - 4));
    const local = k <= localLimit ? k : m;
    const out = new Uint8Array(size);
    if (start + local > bytes.length) {
        return fail('record runs past the end of the file');
    }
    out.set(bytes.subarray(start, start + local), 0);
    let next = u32(bytes, start + local);
    let at = local;
    while (at < size) {
        if (next < 1 || next > db.pageCount) {
            return fail('overflow chain leaves the database');
        }
        const pageStart = pageOffset(db, next) + 4;
        const take = Math.min(usableSize - 4, size - at);
        if (pageStart + take > bytes.length) {
            return fail('overflow page runs past the end of the file');
        }
        out.set(bytes.subarray(pageStart, pageStart + take), at);
        at += take;
        next = u32(bytes, pageOffset(db, next));
    }
    return out;
}

/** Table leaf cells are limited to usableSize - 35 bytes of local payload. */
function tableLeafLimit(usableSize: number): number {
    return usableSize - 35;
}

/** Decodes one serial value out of a record body. */
function decodeValue(db: SqliteDatabase, record: Uint8Array, serial: number, at: number): { value: SqlValue; next: number } {
    if (serial === 0) {
        return { value: null, next: at };
    }
    if (serial >= 1 && serial <= 6) {
        const width = [0, 1, 2, 3, 4, 6, 8][serial];
        if (at + width > record.length) {
            return fail('integer runs past the end of the record');
        }
        let value = 0;
        for (let i = 0; i < width; i++) {
            value = value * 256 + record[at + i];
        }
        const limit = Math.pow(2, width * 8 - 1);
        if (value >= limit) {
            value -= limit * 2;
        }
        return { value, next: at + width };
    }
    if (serial === 7) {
        if (at + 8 > record.length) {
            return fail('float runs past the end of the record');
        }
        const view = new DataView(record.buffer, record.byteOffset + at, 8);
        return { value: view.getFloat64(0, false), next: at + 8 };
    }
    if (serial === 8 || serial === 9) {
        return { value: serial - 8, next: at };
    }
    if (serial === 10 || serial === 11) {
        // Reserved for internal use; nothing Anki writes uses them.
        return { value: null, next: at };
    }
    const isText = serial % 2 === 1;
    const length = Math.floor((serial - (isText ? 13 : 12)) / 2);
    if (at + length > record.length) {
        return fail(`${isText ? 'text' : 'blob'} runs past the end of the record`);
    }
    const raw = record.subarray(at, at + length);
    return { value: isText ? decodeText(db, raw) : raw.slice(), next: at + length };
}

function decodeText(db: SqliteDatabase, raw: Uint8Array): string {
    if (db.encoding === 'utf-8') {
        return new TextDecoder('utf-8').decode(raw);
    }
    if (db.encoding === 'utf-16le') {
        return new TextDecoder('utf-16le').decode(raw);
    }
    // TextDecoder has no big-endian UTF-16, so swap the pairs first.
    const swapped = raw.slice();
    for (let i = 0; i + 1 < swapped.length; i += 2) {
        const byte = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = byte;
    }
    return new TextDecoder('utf-16le').decode(swapped);
}

/** Splits a record into its values (header of serial types, then the body). */
export function parseRecord(db: SqliteDatabase, payload: Uint8Array): SqlValue[] {
    const headerSize = readVarint(payload, 0);
    let at = headerSize.next;
    const serials: number[] = [];
    while (at < headerSize.value) {
        const serial = readVarint(payload, at);
        serials.push(serial.value);
        at = serial.next;
    }
    const values: SqlValue[] = [];
    let body = headerSize.value;
    for (const serial of serials) {
        const decoded = decodeValue(db, payload, serial, body);
        values.push(decoded.value);
        body = decoded.next;
    }
    return values;
}

/** Index pages hold less of a record on the page than table leaves do. */
function indexLeafLimit(usableSize: number): number {
    return Math.floor(((usableSize - 12) * 64) / 255) - 23;
}

/** Reads one table leaf cell: its rowid and its record. */
function readLeafCell(db: SqliteDatabase, cell: number): { rowid: number; values: SqlValue[] } {
    const { bytes } = db;
    const size = readVarint(bytes, cell);
    const rowid = readVarint(bytes, size.next);
    const start = rowid.next;
    const payload = readPayload(db, start, size.value, db.usableSize, tableLeafLimit(db.usableSize));
    return { rowid: rowid.value, values: parseRecord(db, payload) };
}

/** Reads one index leaf cell: just the record (WITHOUT ROWID tables live here). */
function readIndexLeafCell(db: SqliteDatabase, cell: number): SqlValue[] {
    const size = readVarint(db.bytes, cell);
    const payload = readPayload(db, size.next, size.value, db.usableSize, indexLeafLimit(db.usableSize));
    return parseRecord(db, payload);
}

/** The page type a b-tree starts on, so the right cell shape is used. */
function rootPageType(db: SqliteDatabase, rootPage: number): number {
    const offset = (rootPage - 1) * db.pageSize + (rootPage === 1 ? 100 : 0);
    return db.bytes[offset];
}

/* ---------------------------------------------------------------- schema */

/**
 * SQL with its comments removed.
 *
 * Anki's own `notes` and `cards` tables were declared with a comment after every
 * column (`id integer primary key,   /* 0 *\/`), and those comments land at the
 * *start* of the next comma-separated definition — so a parser that does not
 * drop them reads one column and then finds no more identifiers at all, which
 * is exactly what a real deck from Anki did to this reader. Quoted runs are left
 * alone: a `--` or `/*` inside a string is part of the string.
 */
export function stripSqlComments(sql: string): string {
    let out = '';
    let at = 0;
    while (at < sql.length) {
        const char = sql[at];
        if (char === '"' || char === '`' || char === "'" || char === '[') {
            const closing = char === '[' ? ']' : char;
            out += char;
            at++;
            while (at < sql.length) {
                const inner = sql[at];
                out += inner;
                at++;
                if (inner === closing) {
                    if (sql[at] === closing && closing !== ']') {
                        out += closing;
                        at++;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        if (char === '-' && sql[at + 1] === '-') {
            while (at < sql.length && sql[at] !== '\n') at++;
            continue;
        }
        if (char === '/' && sql[at + 1] === '*') {
            at += 2;
            while (at < sql.length && !(sql[at] === '*' && sql[at + 1] === '/')) at++;
            at += 2;
            out += ' ';
            continue;
        }
        out += char;
        at++;
    }
    return out;
}

/**
 * Column names from a CREATE TABLE statement.
 *
 * SQLite does not store column names in the records, so they are recovered from
 * the statement: top-level comma separated definitions, quoted or bare
 * identifiers, table constraints skipped. Comments are stripped first — see
 * {@link stripSqlComments}.
 */
export function parseCreateTableColumns(sql: string): string[] {
    sql = stripSqlComments(sql);
    const open = sql.indexOf('(');
    if (open < 0) {
        return [];
    }
    const columns: string[] = [];
    let at = open + 1;
    let depth = 0;
    let part = '';
    const parts: string[] = [];
    while (at < sql.length) {
        const char = sql[at];
        if (char === '"' || char === '`' || char === "'") {
            // Copy quoted runs verbatim so commas inside them are ignored.
            const quote = char;
            let run = char;
            at++;
            while (at < sql.length) {
                const inner = sql[at];
                run += inner;
                at++;
                if (inner === quote) {
                    if (sql[at] === quote) {
                        run += quote;
                        at++;
                        continue;
                    }
                    break;
                }
            }
            part += run;
            continue;
        }
        if (char === '[') {
            let run = char;
            at++;
            while (at < sql.length && sql[at] !== ']') {
                run += sql[at];
                at++;
            }
            run += ']';
            at++;
            part += run;
            continue;
        }
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            if (depth === 0) {
                break;
            }
            depth--;
        } else if (char === ',' && depth === 0) {
            parts.push(part);
            part = '';
            at++;
            continue;
        }
        part += char;
        at++;
    }
    if (part.trim().length > 0) {
        parts.push(part);
    }

    const constraints = new Set(['primary', 'unique', 'check', 'foreign', 'constraint']);
    for (const definition of parts) {
        const name = leadingIdentifier(definition.trim());
        if (!name) {
            continue;
        }
        if (constraints.has(name.toLowerCase())) {
            continue;
        }
        columns.push(name);
    }
    return columns;
}

/** The column an `INTEGER PRIMARY KEY` declaration aliases the rowid with. */
export function parseRowidAlias(sql: string, columns: readonly string[]): number {
    sql = stripSqlComments(sql);
    if (/\bwithout\s+rowid\b/i.test(sql)) {
        // WITHOUT ROWID tables have no rowid for a column to alias.
        return -1;
    }
    const open = sql.indexOf('(');
    if (open < 0) {
        return -1;
    }
    let depth = 0;
    let part = '';
    const parts: string[] = [];
    let at = open + 1;
    while (at < sql.length) {
        const char = sql[at];
        if (char === '"' || char === '`' || char === "'" || char === '[') {
            const closing = char === '[' ? ']' : char;
            at++;
            while (at < sql.length && sql[at] !== closing) {
                at++;
            }
            at++;
            continue;
        }
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            if (depth === 0) {
                break;
            }
            depth--;
        } else if (char === ',' && depth === 0) {
            parts.push(part);
            part = '';
            at++;
            continue;
        }
        part += char;
        at++;
    }
    if (part.trim() !== '') {
        parts.push(part);
    }

    const declarations = new Map<string, string>();
    for (const definition of parts) {
        const trimmed = definition.trim();
        const identifier = identifierAt(trimmed);
        if (!identifier) {
            continue;
        }
        const name = identifier.name;
        if (['primary', 'unique', 'check', 'foreign', 'constraint'].includes(name.toLowerCase())) {
            continue;
        }
        declarations.set(name, trimmed.slice(identifier.length).trim());
    }

    // The declared type has to be exactly INTEGER: `int primary key` is an
    // ordinary unique column to SQLite, not a rowid alias.
    const isInteger = (name: string): boolean => {
        const rest = declarations.get(name);
        if (rest === undefined) {
            return false;
        }
        return /^integer\b/i.test(rest);
    };

    for (const [name, rest] of declarations) {
        // The column form, with any other column constraints around the key.
        if (isInteger(name) && /\bprimary\s+key\b/i.test(rest) && !/\bprimary\s+key\s+desc\b/i.test(rest)) {
            const index = columns.indexOf(name);
            if (index >= 0) {
                return index;
            }
        }
    }
    for (const definition of parts) {
        // The table-constraint form: `primary key (id)`, with an INTEGER column.
        const constraint = /^primary\s+key\s*\(\s*(["`[]?)([A-Za-z_][A-Za-z0-9_$]*)\1\s*(?:asc\s*)?\)$/i.exec(definition.trim());
        if (constraint && isInteger(constraint[2])) {
            const index = columns.indexOf(constraint[2]);
            if (index >= 0) {
                return index;
            }
        }
    }
    return -1;
}

/** The leading identifier of a statement fragment, and how much text it took. */
function identifierAt(text: string): { name: string; length: number } | null {
    const first = text[0];
    if (first === '"' || first === '`' || first === "'") {
        let out = '';
        let at = 1;
        while (at < text.length) {
            if (text[at] === first) {
                if (text[at + 1] === first) {
                    out += first;
                    at += 2;
                    continue;
                }
                return { name: out, length: at + 1 };
            }
            out += text[at];
            at++;
        }
        return { name: out, length: text.length };
    }
    if (first === '[') {
        const end = text.indexOf(']');
        return end > 0 ? { name: text.slice(1, end), length: end + 1 } : null;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text);
    return match ? { name: match[0], length: match[0].length } : null;
}

function leadingIdentifier(text: string): string | null {
    return identifierAt(text)?.name ?? null;
}

function readSchema(db: SqliteDatabase): SqliteTable[] {
    const tables: SqliteTable[] = [];
    for (const cell of walkTablePages(db, 1, false)) {
        const { values } = readLeafCell(db, cell);
        const [kind, name, , rootPage, sql] = values;
        if (typeof name !== 'string' || typeof rootPage !== 'number') {
            continue;
        }
        const statement = typeof sql === 'string' ? sql : '';
        const isTable = /^\s*create\s+(?:temp\s+)?table/i.test(statement);
        const columns = isTable ? parseCreateTableColumns(statement) : [];
        tables.push({
            name,
            kind: typeof kind === 'string' ? kind : '',
            rootPage,
            sql: statement,
            columns,
            rowidColumn: isTable ? parseRowidAlias(statement, columns) : -1,
        });
    }
    return tables;
}

/* --------------------------------------------------------------- reading */

/** Every table in the schema (indexes and triggers are left out). */
export function listTables(db: SqliteDatabase): SqliteTable[] {
    return db.tables.filter((table) => table.kind === 'table' || table.kind === 'virtual table');
}

/** Looks a table up by name, or returns undefined. */
export function tableInfo(db: SqliteDatabase, name: string): SqliteTable | undefined {
    return db.tables.find((table) => table.name === name);
}

/** True when the database has a table with this name. */
export function hasTable(db: SqliteDatabase, name: string): boolean {
    return tableInfo(db, name) !== undefined;
}

/**
 * Reads a whole table. Rows come back as objects keyed by column name, in
 * rowid order, with `columns` giving the declaration order.
 */
export function readTable(db: SqliteDatabase, name: string): SqliteTableData {
    const table = tableInfo(db, name);
    if (!table) {
        fail(`no table named "${name}"`);
    }
    return readTableAt(db, name, table.rootPage, table.columns, table.rowidColumn);
}

/** Reads a table whose root page is already known. */
export function readTableAt(db: SqliteDatabase, name: string, rootPage: number, columns: string[], rowidColumn = -1): SqliteTableData {
    const rows: SqlRow[] = [];
    const index = rootPageType(db, rootPage) === 2 || rootPageType(db, rootPage) === 10;
    for (const cell of walkTablePages(db, rootPage, index)) {
        // A WITHOUT ROWID table is an index b-tree: its cells have no rowid.
        let rowid = 0;
        let values: SqlValue[];
        if (index) {
            values = readIndexLeafCell(db, cell);
        } else {
            const leaf = readLeafCell(db, cell);
            rowid = leaf.rowid;
            values = leaf.values;
        }
        const row: SqlRow = {};
        for (let i = 0; i < columns.length; i++) {
            row[columns[i]] = i < values.length ? values[i] : null;
        }
        // A rowid alias column is stored as NULL and read back as the rowid,
        // exactly as SQLite (and every other client) presents it.
        if (rowidColumn >= 0 && row[columns[rowidColumn]] === null) {
            row[columns[rowidColumn]] = rowid;
        }
        rows.push(row);
    }
    return { name, columns, rows };
}
