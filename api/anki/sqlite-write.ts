/**
 * A minimal SQLite file writer, enough for Anki's schema.
 *
 * Exporting a deck means producing a real `collection.anki2` that Anki (and the
 * `sqlite3` CLI) can open: a file header, `sqlite_master` on page 1, one table
 * b-tree per table — a leaf root when the rows fit, leaf plus interior levels
 * when they do not — overflow pages for records larger than a page, and the
 * `ix_*` indexes Anki's schema defines. Records use SQLite's serial types, so
 * nulls, integers of every width, floats, text and blobs all round trip through
 * the reader in `sqlite-read.ts` and through SQLite itself.
 *
 * Deliberately conservative: page size 4096, no WAL, no freelist, no
 * auto-vacuum, no WITHOUT ROWID and no zip-style compression. Everything is
 * written from scratch on every call; nothing here reads the filesystem.
 */

import { concatBytes } from './zip';

/** A value that can be stored. `undefined` and booleans are normalised. */
export type SqlValueIn = null | undefined | boolean | number | string | Uint8Array;

/** One table to write. */
export interface SqliteWriteTable {
    name: string;
    /** The CREATE TABLE statement stored in `sqlite_master`. */
    sql: string;
    /** Column names, in the order the row arrays list them. */
    columns: readonly string[];
    /** Rows, each an array matching `columns`. */
    rows: readonly (readonly SqlValueIn[])[];
    /** Optional explicit rowids; defaults to the `id` column, then 1, 2, 3… */
    rowids?: readonly number[];
}

/** One index to write. */
export interface SqliteWriteIndex {
    name: string;
    /** The CREATE INDEX statement stored in `sqlite_master`. */
    sql: string;
    /** The table the index belongs to. */
    table: string;
    /** Zero-based column positions that make up the key, in key order. */
    columns: readonly number[];
}

export interface SqliteWriteSpec {
    /** Defaults to 4096, like Anki's own collections. */
    pageSize?: number;
    /** Header schema cookie; any value is valid, so the default is 1. */
    schemaCookie?: number;
    tables: readonly SqliteWriteTable[];
    indexes?: readonly SqliteWriteIndex[];
}

const DEFAULT_PAGE_SIZE = 4096;
/** Schema format 4: what every modern SQLite writes. */
const SCHEMA_FORMAT = 4;
/** 1 = UTF-8. */
const TEXT_ENCODING = 1;
/** Reported as the library version in the header. */
const SQLITE_VERSION = 3045000;

interface EncodedCell {
    bytes: Uint8Array;
    /** The key of the cell itself. */
    key: readonly SqlValueIn[];
    /** The largest key in the cell's subtree once the tree is built. */
    maxKey: readonly SqlValueIn[];
    /** The rowid of the cell (table b-trees) or of its index entry. */
    rowid: number;
    /** The largest rowid in the cell's subtree once the tree is built. */
    maxRowid: number;
}

interface BuiltPage {
    pageNo: number;
    /** The largest key anywhere in this page's subtree. */
    max: EncodedCell;
}

/* ------------------------------------------------------------- primitives */

function varintLength(value: number): number {
    let length = 1;
    let rest = value;
    while (rest > 0x7f && length < 9) {
        rest = Math.floor(rest / 128);
        length++;
    }
    return length;
}

/** SQLite's varint: 7 bits per byte, most significant group first. */
export function sqliteVarint(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`sqlite: varint needs a non-negative integer, got ${value}`);
    }
    if (value >= Math.pow(2, 56)) {
        // Nine-byte varints need the final byte to carry eight bits; nothing we
        // write (rowids, payload sizes, Anki ids) comes close.
        throw new Error('sqlite: value is too large for a nine-byte varint');
    }
    const groups: number[] = [];
    let rest = value;
    while (rest > 0x7f) {
        groups.push(rest % 128);
        rest = Math.floor(rest / 128);
    }
    groups.push(rest);
    groups.reverse();
    const out = new Uint8Array(groups.length);
    for (let i = 0; i < groups.length - 1; i++) {
        out[i] = groups[i] | 0x80;
    }
    out[groups.length - 1] = groups[groups.length - 1];
    return out;
}

/** Big-endian two's-complement integer bytes of the given width. */
function intBytes(value: number, width: number): Uint8Array {
    const out = new Uint8Array(width);
    let rest = Math.round(value);
    for (let i = width - 1; i >= 0; i--) {
        out[i] = rest & 0xff;
        rest = Math.floor(rest / 256);
    }
    return out;
}

const INT1_MAX = 127;
const INT2_MAX = 32767;
const INT3_MAX = 8388607;
const INT4_MAX = 2147483647;
const INT4_MIN = -2147483648;
const INT6_MAX = 140737488355327; // 2^47 - 1

interface EncodedValue {
    serial: number;
    bytes: Uint8Array;
}

function encodeValue(value: SqlValueIn): EncodedValue {
    if (value === null || value === undefined) {
        return { serial: 0, bytes: new Uint8Array(0) };
    }
    if (typeof value === 'boolean') {
        return encodeValue(value ? 1 : 0);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('sqlite: cannot store NaN or Infinity');
        }
        if (Number.isInteger(value)) {
            if (value === 0) {
                // Serial type 8 is the constant 0 and takes no bytes at all.
                return { serial: 8, bytes: new Uint8Array(0) };
            }
            if (value >= INT4_MIN && value <= INT4_MAX) {
                const width = Math.abs(value) <= INT1_MAX ? 1 : Math.abs(value) <= INT2_MAX ? 2 : Math.abs(value) <= INT3_MAX ? 3 : 4;
                return { serial: width, bytes: intBytes(value, width) };
            }
            if (value >= -INT6_MAX - 1 && value <= INT6_MAX) {
                return { serial: 5, bytes: intBytes(value, 6) };
            }
            if (Number.isSafeInteger(value)) {
                return { serial: 6, bytes: intBytes(value, 8) };
            }
        }
        const out = new Uint8Array(8);
        new DataView(out.buffer).setFloat64(0, value, false);
        return { serial: 7, bytes: out };
    }
    if (typeof value === 'string') {
        const bytes = new TextEncoder().encode(value);
        return { serial: 13 + 2 * bytes.length, bytes };
    }
    if (value instanceof Uint8Array) {
        return { serial: 12 + 2 * value.length, bytes: value };
    }
    throw new Error(`sqlite: cannot store a ${typeof value} value`);
}

/** A record: header of serial types, then the values. */
export function encodeRecord(values: readonly SqlValueIn[]): Uint8Array {
    const encoded = values.map(encodeValue);
    let body = 0;
    let serials = 0;
    for (const entry of encoded) {
        body += entry.bytes.length;
        serials += varintLength(entry.serial);
    }
    let headerLength = serials + 1;
    for (;;) {
        const width = varintLength(headerLength);
        if (width === 1 || headerLength === serials + width) {
            break;
        }
        headerLength = serials + width;
    }
    const parts: Uint8Array[] = [sqliteVarint(headerLength)];
    for (const entry of encoded) {
        parts.push(sqliteVarint(entry.serial));
    }
    for (const entry of encoded) {
        if (entry.bytes.length > 0) {
            parts.push(entry.bytes);
        }
    }
    return concatBytes(parts, headerLength + body);
}

/* ------------------------------------------------------------ page writer */

class PageWriter {
    readonly pageSize: number;
    readonly usableSize: number;
    private readonly pages: (Uint8Array | null)[] = [];
    private readonly used: boolean[] = [];

    constructor(pageSize: number) {
        this.pageSize = pageSize;
        this.usableSize = pageSize;
    }

    ensure(pageNo: number): void {
        while (this.pages.length < pageNo) {
            this.pages.push(null);
            this.used.push(false);
        }
    }

    /** Marks pages 1..count as taken without writing them yet. */
    reserve(count: number): void {
        this.ensure(count);
        for (let i = 0; i < count; i++) {
            this.used[i] = true;
        }
    }

    allocate(): number {
        let pageNo = 1;
        for (;;) {
            this.ensure(pageNo);
            if (!this.used[pageNo - 1]) {
                break;
            }
            pageNo++;
        }
        this.used[pageNo - 1] = true;
        this.pages[pageNo - 1] = new Uint8Array(this.pageSize);
        return pageNo;
    }

    write(pageNo: number, page: Uint8Array): void {
        this.ensure(pageNo);
        this.used[pageNo - 1] = true;
        this.pages[pageNo - 1] = page;
    }

    /** Every page must be written: a hole in the file is a corrupt database. */
    toBuffer(schemaCookie: number): Uint8Array {
        const pages: Uint8Array[] = [];
        for (let i = 0; i < this.pages.length; i++) {
            const page = this.pages[i];
            if (page === null) {
                throw new Error(`sqlite: page ${i + 1} was never written`);
            }
            pages.push(page);
        }
        if (pages.length === 0) {
            throw new Error('sqlite: nothing was written');
        }
        // Page 1 *is* the file header plus a b-tree page: the header is written
        // into the same 4096 bytes, not prepended to the file.
        const header = new Uint8Array(100);
        const magic = 'SQLite format 3\0';
        for (let i = 0; i < magic.length; i++) {
            header[i] = magic.charCodeAt(i);
        }
        const view = new DataView(header.buffer);
        view.setUint16(16, this.pageSize === 65536 ? 1 : this.pageSize, false);
        header[18] = 1; // legacy (rollback journal) write format
        header[19] = 1;
        header[20] = 0; // no reserved space per page
        header[21] = 64; // maximum embedded payload fraction
        header[22] = 32; // minimum embedded payload fraction
        header[23] = 32; // leaf payload fraction
        view.setUint32(24, 1, false); // file change counter
        view.setUint32(28, pages.length, false);
        view.setUint32(32, 0, false); // no freelist
        view.setUint32(36, 0, false);
        view.setUint32(40, schemaCookie >>> 0, false);
        view.setUint32(44, SCHEMA_FORMAT, false);
        view.setUint32(48, 0, false); // default cache size
        view.setUint32(52, 0, false); // no auto-vacuum, no WITHOUT ROWID table
        view.setUint32(56, TEXT_ENCODING, false);
        view.setUint32(60, 0, false); // user version
        view.setUint32(64, 0, false); // incremental vacuum off
        view.setUint32(68, 0, false); // application id
        view.setUint32(92, 1, false); // version-valid-for
        view.setUint32(96, SQLITE_VERSION, false);
        pages[0].set(header, 0);
        return concatBytes(pages, pages.length * this.pageSize);
    }
}

/* ----------------------------------------------------------------- cells */

function setU16(bytes: Uint8Array, at: number, value: number): void {
    // SQLite's on-disk integers are big-endian.
    bytes[at] = (value >>> 8) & 0xff;
    bytes[at + 1] = value & 0xff;
}

function setU32(bytes: Uint8Array, at: number, value: number): void {
    bytes[at] = (value >>> 24) & 0xff;
    bytes[at + 1] = (value >>> 16) & 0xff;
    bytes[at + 2] = (value >>> 8) & 0xff;
    bytes[at + 3] = value & 0xff;
}

/** Bytes of a record that stay on the page; the rest goes to overflow pages. */
function localPayloadSize(size: number, usableSize: number, limit: number): number {
    if (size <= limit) {
        return size;
    }
    const m = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const k = m + ((size - m) % (usableSize - 4));
    return k <= limit ? k : m;
}

class CellWriter {
    private readonly pages: PageWriter;
    private readonly tableLeafLimit: number;
    private readonly indexLimit: number;

    constructor(pages: PageWriter) {
        this.pages = pages;
        this.tableLeafLimit = pages.usableSize - 35;
        this.indexLimit = Math.floor(((pages.usableSize - 12) * 64) / 255) - 23;
    }

    private get overflowPerPage(): number {
        return this.pages.usableSize - 4;
    }

    /** Writes the overflow chain for a payload and returns its first page. */
    private writeOverflow(payload: Uint8Array, from: number): number {
        const perPage = this.overflowPerPage;
        const numbers: number[] = [];
        for (let at = from; at < payload.length; at += perPage) {
            numbers.push(this.pages.allocate());
        }
        for (let i = 0; i < numbers.length; i++) {
            const page = new Uint8Array(this.pages.pageSize);
            setU32(page, 0, i + 1 < numbers.length ? numbers[i + 1] : 0);
            const start = from + i * perPage;
            page.set(payload.subarray(start, Math.min(start + perPage, payload.length)), 4);
            this.pages.write(numbers[i], page);
        }
        return numbers[0];
    }

    private split(payload: Uint8Array, limit: number): { local: Uint8Array; overflow: number } {
        const local = localPayloadSize(payload.length, this.pages.usableSize, limit);
        if (local === payload.length) {
            return { local: payload, overflow: 0 };
        }
        return { local: payload.subarray(0, local), overflow: this.writeOverflow(payload, local) };
    }

    private pointer(pageNo: number): Uint8Array {
        const out = new Uint8Array(4);
        setU32(out, 0, pageNo);
        return out;
    }

    /** The cell for a table b-tree leaf: size, rowid, record (plus overflow). */
    tableLeafCell(values: readonly SqlValueIn[], rowid: number): EncodedCell {
        const payload = encodeRecord(values);
        const { local, overflow } = this.split(payload, this.tableLeafLimit);
        const parts = [sqliteVarint(payload.length), sqliteVarint(rowid)];
        if (overflow > 0) {
            parts.push(local, this.pointer(overflow));
        } else {
            parts.push(local);
        }
        return { bytes: concatBytes(parts), key: values, maxKey: values, rowid, maxRowid: rowid };
    }

    /** The cell for an index b-tree leaf: size, record (keys then rowid). */
    indexLeafCell(key: readonly SqlValueIn[], rowid: number): EncodedCell {
        const values = [...key, rowid];
        const payload = encodeRecord(values);
        const { local, overflow } = this.split(payload, this.indexLimit);
        const parts = [sqliteVarint(payload.length)];
        if (overflow > 0) {
            parts.push(local, this.pointer(overflow));
        } else {
            parts.push(local);
        }
        return { bytes: concatBytes(parts), key: values, maxKey: values, rowid, maxRowid: rowid };
    }

    /** The cell size a parent would need for this child, without writing it. */
    separatorCellSize(child: BuiltPage, index: boolean): number {
        if (!index) {
            return 4 + varintLength(child.max.maxRowid);
        }
        const payload = encodeRecord(child.max.maxKey);
        const local = localPayloadSize(payload.length, this.pages.usableSize, this.indexLimit);
        return 4 + varintLength(payload.length) + local + (local === payload.length ? 0 : 4);
    }

    /** The cell a parent page stores for a child: child pointer plus separator. */
    separatorCell(child: BuiltPage, index: boolean): Uint8Array {
        const parts: Uint8Array[] = [this.pointer(child.pageNo)];
        if (!index) {
            // Table interior cells carry only the child and its largest rowid.
            return concatBytes([parts[0], sqliteVarint(child.max.maxRowid)]);
        }
        const payload = encodeRecord(child.max.maxKey);
        const { local, overflow } = this.split(payload, this.indexLimit);
        parts.push(sqliteVarint(payload.length), local);
        if (overflow > 0) {
            parts.push(this.pointer(overflow));
        }
        return concatBytes(parts);
    }
}

/* ----------------------------------------------------------------- pages */

function headerSize(pageNo: number): number {
    return pageNo === 1 ? 100 : 0;
}

function writeLeafPage(pageSize: number, pageNo: number, cells: readonly Uint8Array[], index: boolean): Uint8Array {
    const header = headerSize(pageNo);
    const page = new Uint8Array(pageSize);
    page[header] = index ? 10 : 13;
    setU16(page, header + 1, 0); // no freeblocks
    setU16(page, header + 3, cells.length);
    page[header + 7] = 0; // no fragmented free bytes
    let contentStart = pageSize;
    for (const cell of cells) {
        contentStart -= cell.length;
    }
    setU16(page, header + 5, contentStart === 65536 ? 0 : contentStart);
    let at = pageSize;
    for (let i = 0; i < cells.length; i++) {
        at -= cells[i].length;
        page.set(cells[i], at);
        setU16(page, header + 8 + 2 * i, at);
    }
    return page;
}

function writeInteriorPage(pageSize: number, pageNo: number, cells: readonly Uint8Array[], rightmost: number, index: boolean): Uint8Array {
    const header = headerSize(pageNo);
    const page = new Uint8Array(pageSize);
    page[header] = index ? 2 : 5;
    setU16(page, header + 1, 0);
    setU16(page, header + 3, cells.length);
    page[header + 7] = 0;
    setU32(page, header + 8, rightmost);
    let contentStart = pageSize;
    for (const cell of cells) {
        contentStart -= cell.length;
    }
    setU16(page, header + 5, contentStart === 65536 ? 0 : contentStart);
    let at = pageSize;
    for (let i = 0; i < cells.length; i++) {
        at -= cells[i].length;
        page.set(cells[i], at);
        setU16(page, header + 12 + 2 * i, at);
    }
    return page;
}

/* ----------------------------------------------------------------- trees */

class TreeWriter {
    private readonly pages: PageWriter;
    private readonly cells: CellWriter;

    constructor(pages: PageWriter) {
        this.pages = pages;
        this.cells = new CellWriter(pages);
    }

    /** True when one more cell of `extra` bytes still fits a leaf page. */
    private fitsLeaf(pageNo: number, count: number, total: number, extra: number): boolean {
        return headerSize(pageNo) + 8 + 2 * (count + 1) + total + extra <= this.pages.pageSize;
    }

    private fitsInterior(pageNo: number, count: number, total: number, extra: number): boolean {
        return headerSize(pageNo) + 12 + 4 + 2 * (count + 1) + total + extra <= this.pages.pageSize;
    }

    /** True when all these children fit on a single interior page. */
    private levelFitsOnePage(level: readonly BuiltPage[], index: boolean, pageNo: number): boolean {
        let total = 0;
        for (let i = 0; i < level.length - 1; i++) {
            total += this.cells.separatorCellSize(level[i], index);
        }
        return this.fitsInterior(pageNo, level.length - 1, total, 0);
    }

    private buildLeafLevel(leafCells: readonly EncodedCell[], index: boolean): BuiltPage[] {
        const built: BuiltPage[] = [];
        let i = 0;
        while (i < leafCells.length) {
            const pageNo = this.pages.allocate();
            const inPage: EncodedCell[] = [];
            let total = 0;
            let j = i;
            while (j < leafCells.length) {
                const size = leafCells[j].bytes.length;
                if (inPage.length > 0 && !this.fitsLeaf(pageNo, inPage.length, total, size)) {
                    break;
                }
                inPage.push(leafCells[j]);
                total += size;
                j++;
            }
            let max = inPage[inPage.length - 1] as EncodedCell;
            if (j < leafCells.length && index) {
                // An index b-tree stores every key exactly once, so a divider
                // moves up into the parent. (A table row's key lives in the
                // leaf and is only *copied* to the parent, otherwise the row's
                // data would be unreachable.) When a page only has room for
                // one cell, the divider is taken from the start of the next
                // page instead, so a page is never left empty.
                if (inPage.length === 1) {
                    max = leafCells[j];
                    j++;
                } else {
                    max = inPage.pop() as EncodedCell;
                }
            }
            this.pages.write(pageNo, writeLeafPage(this.pages.pageSize, pageNo, inPage.map((cell) => cell.bytes), index));
            built.push({ pageNo, max });
            i = j;
        }
        return built;
    }

    private buildInteriorLevel(level: readonly BuiltPage[], index: boolean): BuiltPage[] {
        const built: BuiltPage[] = [];
        let i = 0;
        while (i < level.length) {
            const pageNo = this.pages.allocate();
            const children: BuiltPage[] = [];
            const cells: Uint8Array[] = [];
            let total = 0;
            let j = i;
            while (j < level.length) {
                const size = this.cells.separatorCellSize(level[j], index);
                if (children.length > 1 && !this.fitsInterior(pageNo, cells.length, total, size)) {
                    break;
                }
                children.push(level[j]);
                cells.push(this.cells.separatorCell(level[j], index));
                total += size;
                j++;
            }
            // The last child becomes the page's rightmost pointer, so its cell
            // is not written here; its key becomes the page's own largest key.
            const rightmost = children.pop() as BuiltPage;
            cells.pop();
            this.pages.write(pageNo, writeInteriorPage(this.pages.pageSize, pageNo, cells, rightmost.pageNo, index));
            built.push({ pageNo, max: rightmost.max });
            i = j;
        }
        return built;
    }

    /**
     * Writes a b-tree for the given cells and returns its root page number.
     * `forcedRootPage` pins the root, which is how `sqlite_master` stays on
     * page 1: its leaves and interior levels are written first, then the top of
     * the tree is placed on the reserved page.
     */
    build(leafCells: readonly EncodedCell[], index: boolean, forcedRootPage: number | null): number {
        if (leafCells.length === 0) {
            const pageNo = forcedRootPage ?? this.pages.allocate();
            this.pages.write(pageNo, writeLeafPage(this.pages.pageSize, pageNo, [], index));
            return pageNo;
        }
        let level = this.buildLeafLevel(leafCells, index);
        if (forcedRootPage !== null) {
            while (level.length > 1) {
                if (this.levelFitsOnePage(level, index, forcedRootPage)) {
                    const cells: Uint8Array[] = [];
                    for (let i = 0; i < level.length - 1; i++) {
                        cells.push(this.cells.separatorCell(level[i], index));
                    }
                    const rightmost = level[level.length - 1];
                    this.pages.write(forcedRootPage, writeInteriorPage(this.pages.pageSize, forcedRootPage, cells, rightmost.pageNo, index));
                    return forcedRootPage;
                }
                level = this.buildInteriorLevel(level, index);
            }
            throw new Error('sqlite: the schema does not fit on the root page');
        }
        while (level.length > 1) {
            level = this.buildInteriorLevel(level, index);
        }
        return level[0].pageNo;
    }
}

/* ------------------------------------------------------------------ keys */

function valueRank(value: SqlValueIn): number {
    if (value === null || value === undefined) {
        return 0;
    }
    if (typeof value === 'string') {
        return 2;
    }
    if (value instanceof Uint8Array) {
        return 3;
    }
    return 1;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    return a.length - b.length;
}

/** SQLite's BINARY ordering across the types we store. */
function compareValues(a: SqlValueIn, b: SqlValueIn): number {
    const rankA = valueRank(a);
    const rankB = valueRank(b);
    if (rankA !== rankB) {
        return rankA - rankB;
    }
    if (rankA === 1) {
        const numberA = typeof a === 'boolean' ? (a ? 1 : 0) : (a as number);
        const numberB = typeof b === 'boolean' ? (b ? 1 : 0) : (b as number);
        return numberA === numberB ? 0 : numberA < numberB ? -1 : 1;
    }
    if (rankA === 2) {
        const encoder = new TextEncoder();
        return compareBytes(encoder.encode(a as string), encoder.encode(b as string));
    }
    if (rankA === 3) {
        return compareBytes(a as Uint8Array, b as Uint8Array);
    }
    return 0;
}

/* ---------------------------------------------------------------- write */

function normaliseRows(table: SqliteWriteTable): { rows: SqlValueIn[][]; rowids: number[] } {
    const rows: SqlValueIn[][] = [];
    const rowids: number[] = [];
    const seen = new Set<number>();
    const idColumn = table.columns.indexOf('id');
    for (let i = 0; i < table.rows.length; i++) {
        const row = [...table.rows[i]];
        if (row.length !== table.columns.length) {
            throw new Error(`sqlite: table ${table.name} row ${i} has ${row.length} values, expected ${table.columns.length}`);
        }
        let rowid = table.rowids ? table.rowids[i] : 0;
        if (rowid === undefined || rowid === 0) {
            const candidate = idColumn >= 0 ? row[idColumn] : undefined;
            if (typeof candidate === 'number' && Number.isInteger(candidate)) {
                rowid = candidate;
            } else if (typeof candidate === 'string' && /^-?\d+$/.test(candidate)) {
                rowid = Number(candidate);
            } else {
                rowid = i + 1;
            }
        }
        if (seen.has(rowid)) {
            throw new Error(`sqlite: table ${table.name} has a duplicate rowid ${rowid}`);
        }
        seen.add(rowid);
        rowids.push(rowid);
        rows.push(row);
    }
    return { rows, rowids };
}

/** Builds a complete SQLite database file. */
export function writeSqlite(spec: SqliteWriteSpec): Uint8Array {
    const pageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
    const pages = new PageWriter(pageSize);
    const cells = new CellWriter(pages);
    const trees = new TreeWriter(pages);
    pages.reserve(1); // sqlite_master lives on page 1

    const schemaRows: SqlValueIn[][] = [];
    const tableData = new Map<string, { rows: SqlValueIn[][]; rowids: number[] }>();

    for (const table of spec.tables) {
        const { rows, rowids } = normaliseRows(table);
        tableData.set(table.name, { rows, rowids });
        const order = rowids.map((rowid, i) => ({ rowid, i })).sort((a, b) => a.rowid - b.rowid);
        const rootPage = trees.build(order.map(({ rowid, i }) => cells.tableLeafCell(rows[i], rowid)), false, null);
        schemaRows.push(['table', table.name, table.name, rootPage, table.sql]);
    }

    for (const index of spec.indexes ?? []) {
        const data = tableData.get(index.table);
        if (!data) {
            throw new Error(`sqlite: index ${index.name} refers to unknown table ${index.table}`);
        }
        const entries = data.rows.map((row, i) => ({ rowid: data.rowids[i], key: index.columns.map((column) => row[column]) }));
        entries.sort((a, b) => {
            for (let i = 0; i < index.columns.length; i++) {
                const order = compareValues(a.key[i], b.key[i]);
                if (order !== 0) {
                    return order;
                }
            }
            return a.rowid - b.rowid;
        });
        const rootPage = trees.build(entries.map((entry) => cells.indexLeafCell(entry.key, entry.rowid)), true, null);
        schemaRows.push(['index', index.name, index.table, rootPage, index.sql]);
    }

    // sqlite_master is an ordinary table b-tree whose root must be page 1, and
    // its rowids are the root page numbers, exactly as SQLite writes them.
    const masterRows = schemaRows.map((values) => ({ values, rowid: values[3] as number })).sort((a, b) => a.rowid - b.rowid);
    const masterCells = masterRows.map(({ values, rowid }) => cells.tableLeafCell(values, rowid));
    let total = 0;
    for (const cell of masterCells) {
        total += cell.bytes.length;
    }
    if (100 + 8 + 2 * masterCells.length + total <= pageSize) {
        pages.write(1, writeLeafPage(pageSize, 1, masterCells.map((cell) => cell.bytes), false));
    } else {
        trees.build(masterCells, false, 1);
    }

    return pages.toBuffer(spec.schemaCookie ?? 1);
}
