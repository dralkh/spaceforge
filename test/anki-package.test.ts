/**
 * The Anki package layer, exercised against real files.
 *
 * Everything here runs the shipping code: the ZIP reader/writer, the SQLite
 * reader and writer, and the .apkg facade. Two fixtures are used throughout —
 * `sample-basic.apkg` (a plain SQLite `collection.anki2`) and
 * `sample-zstd.apkg` (a zstd-compressed `collection.anki21b`, the format Anki
 * writes since 2.1.50) — plus the bare databases the fixture builder left in
 * `test/fixtures/anki/build/`.
 *
 * Where a check can be made against something other than our own code it is:
 * the `sqlite3` CLI verifies what we write (and the test skips cleanly when the
 * binary is absent), and Python's zipfile verifies the archive structure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { decompress } from 'fzstd';
import crypto from 'node:crypto';

import { crc32, isZip, readZip, readZipDirectory, writeZip, ZipWriteEntry } from '../api/anki/zip';
import { hasTable, listTables, openSqlite, parseRowidAlias, readTable, SqliteDatabase, SqlValue } from '../api/anki/sqlite-read';
import { SqliteWriteIndex, SqliteWriteTable, writeSqlite } from '../api/anki/sqlite-write';
import { AnkiPackageMedia, deckOptionsFromAnki, deckOptionsToAnki, readApkg } from '../api/anki/apkg';
import { ankiBase91, ankiBase91FromParts, guidForNote, noteChecksum, noteSortField, sha1, stripHtmlPreservingMedia, writeApkg } from '../api/anki/apkg-write';
import { DeckBundle, DEFAULT_DECK_OPTIONS, LeechAction, DECKS_MEDIA_FOLDER } from '../models/anki';

/** The revlog columns, for handing raw rows back through `extra`. */
const REVLOG_COLUMNS = ['id', 'cid', 'usn', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type'];

/* ------------------------------------------------------------------ helpers */

const fixturePath = (name: string) => new URL(`../test/fixtures/anki/${name}`, import.meta.url);

function fixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(fixturePath(name)));
}

function binary(len: number, seed = 1): Uint8Array {
    const out = new Uint8Array(len);
    let state = seed >>> 0;
    for (let i = 0; i < len; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        out[i] = state >>> 24;
    }
    return out;
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
    assert.equal(actual.length, expected.length, `${message}: length`);
    for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) {
            assert.fail(`${message}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
        }
    }
}

function bytes(value: SqlValue): Uint8Array {
    assert.ok(value instanceof Uint8Array, 'expected a blob');
    return value;
}

function text(value: SqlValue): string {
    assert.equal(typeof value, 'string');
    return value as string;
}

function num(value: SqlValue): number {
    assert.equal(typeof value, 'number');
    return value as number;
}

/** True when the sqlite3 CLI is on PATH; the tests that need it skip otherwise. */
function hasSqlite3(): boolean {
    try {
        execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const sqlite3Available = hasSqlite3();

/** Runs SQL against a file with the sqlite3 CLI and returns the text output. */
function sqlite3Query(file: string, sql: string): string {
    return execFileSync('sqlite3', [file, sql], { encoding: 'utf8' }).trim();
}

/** True when python3 is on PATH; used to check our ZIPs with a foreign reader. */
function hasPython(): boolean {
    try {
        execFileSync('python3', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const pythonAvailable = hasPython();

function withTempDir<T>(name: string, body: (dir: string) => T): T {
    const dir = mkdtempSync(path.join(tmpdir(), `spaceforge-${name}-`));
    try {
        return body(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/* ---------------------------------------------------------------------- zip */

test('crc32 matches the standard check value', () => {
    const check = new TextEncoder().encode('123456789');
    assert.equal(crc32(check), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip round trip: stored, deflated and multi-block entries', async () => {
    const incompressible = binary(400000, 7);
    const compressible = new TextEncoder().encode('spaceforge anki package '.repeat(20000)); // ~0.5 MB
    const entries: ZipWriteEntry[] = [
        { name: 'collection.anki2', data: new Uint8Array([1, 2, 3, 4, 5]) },
        { name: 'media', data: new TextEncoder().encode('{"0": "nucleus.png"}') },
        { name: '0', data: incompressible, store: true },
        { name: '1', data: compressible },
        { name: 'empty', data: new Uint8Array(0) },
    ];

    const archive = await writeZip(entries);
    const directory = readZipDirectory(archive);
    assert.deepEqual(
        directory.entries.map((entry) => entry.name),
        ['collection.anki2', 'media', '0', '1', 'empty'],
    );
    assert.equal(directory.entries[2].method, 0, 'stored entry stays stored');
    assert.equal(directory.entries[3].method, 8, 'compressible entry is deflated');
    // Sizes and CRC live in the local header: no data descriptor is used.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint16(6, true), 0x0800, 'UTF-8 name flag');
    assert.equal(view.getUint16(8, true), 0, 'first entry is stored');
    assert.equal(view.getUint32(14, true), crc32(new Uint8Array([1, 2, 3, 4, 5])), 'CRC in the local header');
    assert.equal(view.getUint32(18, true), 5, 'compressed size in the local header');
    assert.equal(view.getUint32(22, true), 5, 'uncompressed size in the local header');
    let descriptorSeen = false;
    for (let at = 0; at + 3 < archive.length; at++) {
        if (archive[at] === 0x50 && archive[at + 1] === 0x4b && archive[at + 2] === 0x07 && archive[at + 3] === 0x08) {
            descriptorSeen = true;
        }
    }
    assert.equal(descriptorSeen, false, 'no data descriptor signature');

    assert.equal(isZip(archive), true);
    const files = await readZip(archive);
    assert.equal(files.size, 5);
    equalBytes(files.get('0') as Uint8Array, incompressible, 'stored entry');
    equalBytes(files.get('1') as Uint8Array, compressible, 'deflated entry across many blocks');
    equalBytes(files.get('media') as Uint8Array, entries[1].data, 'JSON entry');
    assert.equal((files.get('empty') as Uint8Array).length, 0);
});

test('a foreign zip reader accepts the archive we write', { skip: !pythonAvailable }, async () => {
    const archive = await writeZip([
        { name: 'collection.anki2', data: binary(5000, 11) },
        { name: 'meta', data: new TextEncoder().encode('{"ver": {"major": 2, "minor": 1}, "mod": 1}') },
        { name: '0', data: new TextEncoder().encode('hello 世界'), store: true },
    ]);
    withTempDir('zip', (dir) => {
        const file = path.join(dir, 'deck.apkg');
        writeFileSync(file, archive);
        const script = [
            'import json, sys, zipfile',
            'z = zipfile.ZipFile(sys.argv[1])',
            'assert z.testzip() is None, "crc failure"',
            'print(json.dumps({"names": z.namelist(), "text": z.read("0").decode("utf-8"), "len": len(z.read("collection.anki2"))}))',
        ].join('\n');
        const out = execFileSync('python3', ['-c', script, file], { encoding: 'utf8' });
        const parsed = JSON.parse(out) as { names: string[]; text: string; len: number };
        assert.deepEqual(parsed.names, ['collection.anki2', 'meta', '0']);
        assert.equal(parsed.text, 'hello 世界');
        assert.equal(parsed.len, 5000);
    });
});

test('zip reading rejects a file that is not an archive', async () => {
    await assert.rejects(() => readZip(new TextEncoder().encode('not a zip at all')), /end-of-central-directory/);
});

/* ------------------------------------------------------------------- sqlite */

/**
 * A table covering every serial type: null, the five integer widths, the
 * constant zero, a float, text, blob — plus a string long enough to need
 * overflow pages.
 */
function serialTypeTable(): SqliteWriteTable {
    const long = `long:${'x'.repeat(9000)}:end`;
    const blob = binary(6000, 3);
    const names = ['id', 'null_col', 'zero', 'one_byte', 'two_byte', 'four_byte', 'six_byte', 'eight_byte', 'float_col', 'text_col', 'blob_col', 'long_col'];
    const rows: SqlValue[][] = [
        [1, null, 0, -128, -32768, -2147483648, 140737488355327, Number.MAX_SAFE_INTEGER, 0.1, '', new Uint8Array(0), long],
        [2, null, 0, 127, 32767, 2147483647, -140737488355328, -1, -0.25, 'unicode ✓ 日本語', blob, 'short'],
        [3, null, 0, 0, 0, 0, 0, 0, 1e300, 'x', new Uint8Array([0, 255]), ''],
    ];
    return {
        name: 'types',
        sql: `CREATE TABLE types (${names.join(', ')})`,
        columns: names,
        rows,
    };
}

const CARDS_TABLE: SqliteWriteTable = {
    name: 'cards',
    sql: 'CREATE TABLE cards (\n  id integer PRIMARY KEY,\n  nid integer NOT NULL,\n  did integer NOT NULL,\n  ord integer NOT NULL,\n  mod integer NOT NULL,\n  usn integer NOT NULL,\n  type integer NOT NULL,\n  queue integer NOT NULL,\n  due integer NOT NULL,\n  ivl integer NOT NULL,\n  factor integer NOT NULL,\n  reps integer NOT NULL,\n  lapses integer NOT NULL,\n  left integer NOT NULL,\n  odue integer NOT NULL,\n  odid integer NOT NULL,\n  flags integer NOT NULL,\n  data text NOT NULL\n)',
    columns: ['id', 'nid', 'did', 'ord', 'mod', 'usn', 'type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odue', 'odid', 'flags', 'data'],
    rows: [],
};

/** One card row in `CARDS_TABLE`'s column order. */
function cardRow(id: number, due: number, data = `card ${id}`): SqlValue[] {
    return [id, 1700000000000 + id, 1700000000000, id % 4, 1792220529, 0, id % 4 === 0 ? 0 : 2, id % 4 === 0 ? 0 : 2, due, id % 4 === 0 ? 0 : id, 2500, id % 4 === 0 ? 0 : 3, id % 7 === 0 ? 1 : 0, 0, 0, 0, 0, data];
}

test('sqlite writer output is readable by our own reader', () => {
    const db = writeSqlite({ tables: [serialTypeTable()], schemaCookie: 9 });
    const parsed = openSqlite(db);
    assert.equal(parsed.pageSize, 4096);
    assert.equal(parsed.schemaCookie, 9);
    assert.equal(parsed.encoding, 'utf-8');
    assert.deepEqual(
        listTables(parsed).map((table) => table.name),
        ['types'],
    );
    assert.equal(hasTable(parsed, 'types'), true);
    assert.equal(hasTable(parsed, 'missing'), false);

    const { columns, rows } = readTable(parsed, 'types');
    assert.deepEqual(columns, serialTypeTable().columns);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].null_col, null);
    assert.equal(rows[0].zero, 0);
    assert.equal(num(rows[0].one_byte), -128);
    assert.equal(num(rows[0].two_byte), -32768);
    assert.equal(num(rows[0].four_byte), -2147483648);
    assert.equal(num(rows[0].six_byte), 140737488355327);
    assert.equal(num(rows[0].eight_byte), Number.MAX_SAFE_INTEGER);
    assert.equal(num(rows[0].float_col), 0.1);
    assert.equal(text(rows[0].text_col), '');
    equalBytes(bytes(rows[0].blob_col), new Uint8Array(0), 'empty blob');
    assert.ok(text(rows[0].long_col).length > 9000, 'long text survived');
    assert.match(text(rows[0].long_col), /^long:x+:end$/);
    assert.equal(num(rows[1].one_byte), 127);
    assert.equal(num(rows[1].two_byte), 32767);
    assert.equal(num(rows[1].four_byte), 2147483647);
    assert.equal(num(rows[1].six_byte), -140737488355328);
    assert.equal(num(rows[1].eight_byte), -1);
    assert.equal(num(rows[1].float_col), -0.25);
    assert.equal(text(rows[1].text_col), 'unicode ✓ 日本語');
    equalBytes(bytes(rows[1].blob_col), binary(6000, 3), 'blob through overflow pages');
    assert.equal(num(rows[2].float_col), 1e300);
    assert.equal(text(rows[2].text_col), 'x', 'a text value stays text');
    equalBytes(bytes(rows[2].blob_col), new Uint8Array([0, 255]), 'two-byte blob');
});

test('sqlite writer builds interior pages, overflow chains and indexes', () => {
    const rows: SqlValue[][] = [];
    for (let i = 1; i <= 2500; i++) {
        rows.push(cardRow(i, 19000 + i, i % 11 === 0 ? `note ${i} ${'y'.repeat(4000)}` : `note ${i}`));
    }
    const cards: SqliteWriteTable = { ...CARDS_TABLE, rows };
    const index: SqliteWriteIndex = {
        name: 'ix_cards_sched',
        sql: 'CREATE INDEX ix_cards_sched ON cards (did, queue, due)',
        table: 'cards',
        columns: [2, 7, 8],
    };
    const db = writeSqlite({ tables: [cards], indexes: [index] });
    const parsed = openSqlite(db);
    assert.ok(parsed.pageCount > 20, `expected a multi-page database, got ${parsed.pageCount}`);
    assert.deepEqual(
        listTables(parsed).map((table) => table.name),
        ['cards'],
    );
    assert.deepEqual(
        parsed.tables.map((table) => table.kind),
        ['table', 'index'],
    );

    const read = readTable(parsed, 'cards');
    assert.equal(read.rows.length, 2500);
    assert.equal(num(read.rows[0].id), 1);
    assert.equal(num(read.rows[2499].id), 2500);
    assert.equal(num(read.rows[109].due), 19110);
    assert.equal(num(read.rows[10].ivl), 11);
    assert.ok(text(read.rows[10].data).length > 4000, 'overflow record survived');
    assert.equal(text(read.rows[108].data), 'note 109');
    assert.ok(text(read.rows[109].data).length > 4000, 'the 110th row is the overflow one');

    // Reader order must match rowid order even across interior pages.
    for (let i = 0; i < read.rows.length; i++) {
        assert.equal(num(read.rows[i].id), i + 1, `row ${i} is out of order`);
    }
});

test('the sqlite3 CLI verifies what we write', { skip: !sqlite3Available }, () => {
    const rows: SqlValue[][] = [];
    for (let i = 1; i <= 900; i++) {
        rows.push(cardRow(i, 19000 + i, i % 5 === 0 ? 'z'.repeat(5000) : `row ${i}`));
    }
    const db = writeSqlite({
        tables: [
            { ...CARDS_TABLE, rows },
            serialTypeTable(),
            { name: 'graves', sql: 'CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL)', columns: ['usn', 'oid', 'type'], rows: [] },
        ],
        indexes: [
            { name: 'ix_cards_usn', sql: 'CREATE INDEX ix_cards_usn ON cards (usn)', table: 'cards', columns: [5] },
            { name: 'ix_cards_nid', sql: 'CREATE INDEX ix_cards_nid ON cards (nid)', table: 'cards', columns: [1] },
            { name: 'ix_cards_sched', sql: 'CREATE INDEX ix_cards_sched ON cards (did, queue, due)', table: 'cards', columns: [2, 7, 8] },
        ],
    });
    withTempDir('sqlite', (dir) => {
        const file = path.join(dir, 'collection.anki2');
        writeFileSync(file, db);
        assert.equal(sqlite3Query(file, 'PRAGMA integrity_check;'), 'ok');
        assert.equal(sqlite3Query(file, 'select count(*) from cards;'), '900');
        assert.equal(sqlite3Query(file, 'select count(*) from types;'), '3');
        assert.equal(sqlite3Query(file, 'select count(*) from graves;'), '0');
        assert.equal(sqlite3Query(file, 'select data from cards where id = 5;'), 'z'.repeat(5000));
        assert.equal(sqlite3Query(file, 'select length(long_col) from types where id = 1;'), '9009');
        assert.equal(sqlite3Query(file, 'select count(*) from cards indexed by ix_cards_sched where did = 1700000000000;'), '900');
        assert.deepEqual(
            sqlite3Query(file, "select name from sqlite_master where type = 'index';").split('\n').sort(),
            ['ix_cards_nid', 'ix_cards_sched', 'ix_cards_usn'],
        );
        assert.equal(sqlite3Query(file, 'PRAGMA index_list(cards);').split('\n').length, 3);
        assert.equal(sqlite3Query(file, "select count(*) from sqlite_master where type = 'table';"), '3');
        assert.equal(sqlite3Query(file, 'select count(*) from types where eight_byte = -1;'), '1');
        assert.equal(sqlite3Query(file, 'select count(*) from types where blob_col is not null;'), '3');
        assert.equal(sqlite3Query(file, 'select due from cards where id = 1;'), '19001');
        assert.equal(sqlite3Query(file, 'select count(*) from cards where lapses = 1;'), Math.floor(900 / 7).toString());
    });
});

/* ------------------------------------------------------- reading the fixtures */

test('sqlite reader reads a real Anki database', () => {
    const db = openSqlite(new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/collection.anki2', import.meta.url))));
    assert.equal(db.pageSize, 4096);
    assert.equal(db.encoding, 'utf-8');
    assert.deepEqual(
        listTables(db).map((table) => table.name).sort(),
        ['cards', 'col', 'graves', 'notes', 'revlog'],
    );
    const col = readTable(db, 'col');
    assert.equal(col.rows.length, 1);
    assert.deepEqual(col.columns, ['id', 'crt', 'mod', 'scm', 'ver', 'dty', 'usn', 'ls', 'conf', 'models', 'decks', 'dconf', 'tags']);
    assert.equal(num(col.rows[0].ver), 11);
    const models = JSON.parse(text(col.rows[0].models)) as Record<string, { name: string }>;
    assert.deepEqual(Object.values(models).map((model) => model.name).sort(), ['Basic', 'Basic (and reversed card)']);

    const notes = readTable(db, 'notes');
    assert.equal(notes.rows.length, 3);
    const fields = notes.rows.map((row) => text(row.flds));
    assert.deepEqual(fields[0].split('\x1f'), ['What organelle generates ATP?', 'The mitochondrion, via oxidative phosphorylation.']);
    assert.match(fields[1], /<img src="nucleus\.png">/);
    assert.equal(text(notes.rows[0].tags), ' biology organelle ');
    assert.deepEqual(text(notes.rows[0].tags).trim().split(/\s+/), ['biology', 'organelle']);
    assert.equal(text(notes.rows[0].guid), 'guidAAA');

    const cards = readTable(db, 'cards');
    assert.equal(cards.rows.length, 4);
    assert.deepEqual(
        cards.rows.map((row) => [num(row.type), num(row.queue), num(row.due), num(row.ivl), num(row.factor)]),
        [
            [2, 2, 19005, 5, 2500],
            [0, 0, 19001, 0, 0],
            [3, 1, 3, 0, 2500],
            [1, 1, 4, 0, 2500],
        ],
    );
    assert.equal(readTable(db, 'revlog').rows.length, 1);
    assert.equal(readTable(db, 'graves').rows.length, 0);
});

test('sqlite reader reports a missing table clearly', () => {
    const db = openSqlite(writeSqlite({ tables: [CARDS_TABLE] }));
    assert.throws(() => readTable(db, 'nope'), /no table named "nope"/);
});

test('sqlite reader rejects a file that is not a database', () => {
    assert.throws(() => openSqlite(binary(5000, 9)), /SQLite file header/);
});

/** Reads the two fixture databases straight out of their archives. */
async function fixtureDatabases(): Promise<{ basic: SqliteDatabase; zstd: SqliteDatabase }> {
    const basic = await readZip(fixture('sample-basic.apkg'));
    const zstd = await readZip(fixture('sample-zstd.apkg'));
    return {
        basic: openSqlite(basic.get('collection.anki2') as Uint8Array),
        zstd: openSqlite(decompress(zstd.get('collection.anki21b') as Uint8Array)),
    };
}

test('the zstd fixture decompresses to the same collection', async () => {
    const { basic, zstd } = await fixtureDatabases();
    const basicCards = readTable(basic, 'cards').rows;
    const zstdCards = readTable(zstd, 'cards').rows;
    assert.equal(zstdCards.length, basicCards.length);
    assert.deepEqual(
        zstdCards.map((row) => [num(row.due), num(row.ivl), num(row.factor), num(row.queue), num(row.type)]),
        basicCards.map((row) => [num(row.due), num(row.ivl), num(row.factor), num(row.queue), num(row.type)]),
    );
    assert.equal(text(readTable(zstd, 'notes').rows[1].guid), 'guidBBB');
});

/* ------------------------------------------------------------------- apkg */

test('apkg import reads the fixture package', async () => {
    const pkg = await readApkg(fixture('sample-basic.apkg'));
    assert.equal(pkg.notes.length, 3);
    assert.equal(pkg.cards.length, 4);
    assert.equal(pkg.warnings.length, 0);
    assert.equal(pkg.meta.container, 'zip');
    assert.equal(pkg.meta.collectionName, 'collection.anki2');
    assert.equal(pkg.meta.zstd, false);
    assert.equal(pkg.meta.schemaVersion, 11);
    assert.equal(pkg.meta.created, 1789628529);
    assert.deepEqual(pkg.meta.version, { major: 2, minor: 1 });

    // Decks and their presets.
    const deck = pkg.decks.find((candidate) => candidate.name === 'Cell Biology::Organelles');
    assert.ok(deck, 'the deck is there');
    assert.equal(deck.id, '1700000000000');
    assert.equal(pkg.deckPresetOf['1700000000000'], '1');
    assert.deepEqual(
        pkg.presets.map((preset) => preset.id),
        ['1'],
    );
    assert.equal(pkg.presets[0].options.newPerDay, 20);
    assert.deepEqual(pkg.presets[0].options.learningSteps, [1, 10]);

    // Notes: fields split on \x1f, names from the notetype, tags trimmed.
    const first = pkg.notes[0];
    assert.equal(first.id, '1700000000001');
    assert.equal(first.modelName, 'Basic');
    assert.deepEqual(first.fields, ['Front', 'Back']);
    assert.deepEqual(first.values, ['What organelle generates ATP?', 'The mitochondrion, via oxidative phosphorylation.']);
    assert.deepEqual(first.tags, ['biology', 'organelle']);
    assert.deepEqual(first.cardIds, ['1700000000011']);
    const second = pkg.notes[1];
    assert.equal(second.modelName, 'Basic (and reversed card)');
    assert.deepEqual(second.cardIds, ['1700000000012', '1700000000013']);
    assert.deepEqual(second.mediaFiles, ['nucleus.png']);
    assert.match(second.values[1], /<img src="nucleus\.png">/);
    assert.deepEqual(pkg.notes[2].tags, []);

    // Cards: type, queue, interval, ease and due date.
    assert.deepEqual(
        pkg.cards.map((card) => [card.id, card.type, card.queue, card.interval, card.easeFactor, card.reviews, card.lapses, card.flag]),
        [
            ['1700000000011', 2, 2, 5, 2500, 3, 1, 0],
            ['1700000000012', 0, 0, 0, 0, 0, 0, 0],
            ['1700000000013', 3, 1, 0, 2500, 4, 2, 0],
            ['1700000000014', 1, 1, 0, 2500, 1, 0, 0],
        ],
    );
    // A review card's due stays a day number: it counts from the collection's
    // own `crt` (`meta.created`), and re-basing it on another deck's day is the
    // importer's job, not the reader's.
    const review = pkg.cards[0];
    assert.equal(review.due, 19005);
    assert.equal(review.noteId, '1700000000001');
    assert.equal(review.deckId, '1700000000000');
    // The new card keeps its queue position rather than a date.
    assert.equal(pkg.cards[1].newPosition, 19001);
    assert.equal(pkg.cards[1].due, 0);
    // Learning cards are due at a second boundary.
    assert.equal(pkg.cards[2].due, 3000);
    assert.equal(pkg.cards[3].due, 4000);
    // One revlog row: 5432 ms on the first card.
    assert.equal(review.timeTakenMs, 5432);
});

test('apkg import reads media out of the archive', async () => {
    const pkg = await readApkg(fixture('sample-basic.apkg'));
    assert.equal(pkg.media.length, 1);
    const media = pkg.media[0];
    assert.equal(media.originalName, 'nucleus.png');
    assert.equal(media.packageName, '0');
    assert.equal(media.mime, 'image/png');
    assert.equal(media.path, `${DECKS_MEDIA_FOLDER}/nucleus.png`);
    assert.equal(media.size, media.bytes.length);
    // It really is the PNG the fixture put in the zip.
    assert.deepEqual([...media.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(media.bytes.length > 50, 'the image has content');
    const buildPng = new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/nucleus.png', import.meta.url)));
    equalBytes(media.bytes, buildPng, 'media bytes match the fixture file');
});

test('apkg import reads the zstd package too', async () => {
    const basic = await readApkg(fixture('sample-basic.apkg'));
    const zstd = await readApkg(fixture('sample-zstd.apkg'));
    assert.equal(zstd.meta.zstd, true);
    assert.equal(zstd.meta.collectionName, 'collection.anki21b');
    assert.equal(zstd.notes.length, basic.notes.length);
    assert.equal(zstd.cards.length, basic.cards.length);
    assert.deepEqual(zstd.notes.map((note) => note.values), basic.notes.map((note) => note.values));
    assert.deepEqual(
        zstd.cards.map((card) => [card.type, card.queue, card.due, card.interval, card.easeFactor]),
        basic.cards.map((card) => [card.type, card.queue, card.due, card.interval, card.easeFactor]),
    );
    assert.equal(zstd.media.length, 1);
    assert.deepEqual(zstd.decks.map((deck) => deck.name), basic.decks.map((deck) => deck.name));
});

test('apkg import accepts a bare database and warns about its missing media', async () => {
    const bare = new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/collection.anki2', import.meta.url)));
    const pkg = await readApkg(bare);
    assert.equal(pkg.meta.container, 'bare');
    assert.equal(pkg.notes.length, 3);
    assert.equal(pkg.cards.length, 4);
    assert.equal(pkg.media.length, 0);
    assert.ok(
        pkg.warnings.some((warning) => warning.includes('nucleus.png')),
        `expected a warning about the missing image, got ${JSON.stringify(pkg.warnings)}`,
    );
});

test('apkg import warns about media the package lists but does not contain', async () => {
    const archive = await writeZip([
        { name: 'collection.anki2', data: new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/collection.anki2', import.meta.url))) },
        { name: 'media', data: new TextEncoder().encode('{"0": "nucleus.png", "1": "gone.mp3"}') },
        { name: '0', data: new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/nucleus.png', import.meta.url))), store: true },
    ]);
    const pkg = await readApkg(archive);
    assert.equal(pkg.media.length, 1);
    assert.equal(pkg.media[0].originalName, 'nucleus.png');
    assert.ok(
        pkg.warnings.some((warning) => warning.includes('gone.mp3') && warning.includes('missing from the zip')),
        `expected a warning about gone.mp3, got ${JSON.stringify(pkg.warnings)}`,
    );
});

test('a package with no media map is reported as a collection package', async () => {
    const archive = await writeZip([
        { name: 'collection.anki2', data: new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/collection.anki2', import.meta.url))) },
    ]);
    const pkg = await readApkg(archive);
    assert.equal(pkg.meta.colpkg, true);
    assert.equal(pkg.meta.container, 'zip');
    assert.equal(pkg.cards.length, 4);
});

test('apkg import reports graves as a warning', async () => {
    const database = writeSqlite({
        tables: [
            {
                name: 'col',
                sql: 'CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL)',
                columns: ['id', 'crt', 'mod', 'scm', 'ver', 'dty', 'usn', 'ls', 'conf', 'models', 'decks', 'dconf', 'tags'],
                rows: [[1, 1789628529, 1792220529616, 1792220529616, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}']],
            },
            {
                name: 'graves',
                sql: 'CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL)',
                columns: ['usn', 'oid', 'type'],
                rows: [[0, 1, 0], [0, 2, 1], [0, 3, 0]],
            },
        ],
    });
    const pkg = await readApkg(await writeZip([{ name: 'collection.anki2', data: database }]));
    assert.deepEqual(pkg.meta.graves, { cards: 2, notes: 1, decks: 0 });
    assert.ok(
        pkg.warnings.some((warning) => warning.includes('2 deleted cards, 1 deleted note')),
        `expected a deletion warning, got ${JSON.stringify(pkg.warnings)}`,
    );
});

test('deck options survive a trip through Anki JSON', () => {
    const options = { ...DEFAULT_DECK_OPTIONS, learningSteps: [2, 15], relearningSteps: [20], maxAnswerSeconds: 30, leechAction: LeechAction.TagOnly };
    const json = deckOptionsToAnki(options, 7, 'Test');
    const back = deckOptionsFromAnki(json);
    assert.deepEqual(back.learningSteps, [2, 15]);
    assert.deepEqual(back.relearningSteps, [20]);
    assert.equal(back.maxAnswerSeconds, 30);
    assert.equal(back.leechAction, LeechAction.TagOnly);
    assert.equal(back.newPerDay, options.newPerDay);
    assert.equal(back.reviewsPerDay, options.reviewsPerDay);
    assert.equal(back.startingEase, options.startingEase);
    assert.equal(back.easyBonus, options.easyBonus);
    assert.equal(back.intervalMultiplier, options.intervalMultiplier);
    assert.equal(back.lapseMultiplier, options.lapseMultiplier);
    assert.equal(back.hardMultiplier, options.hardMultiplier);
    assert.equal(back.maximumInterval, options.maximumInterval);
    assert.equal(back.leechThreshold, options.leechThreshold);
    assert.equal(back.buryNewSiblings, options.buryNewSiblings);
    assert.equal(back.buryReviewSiblings, options.buryReviewSiblings);
    // The fixture's preset is Anki's own default deck config.
    const fixtureOptions = deckOptionsFromAnki({
        new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, bury: true, order: 1, perDay: 20 },
        rev: { perDay: 200, ease4: 1.3, ivlFct: 1.0, maxIvl: 36500, bury: false, hardFactor: 1.2, minSpace: 1 },
        lapse: { delays: [10], mult: 0.0, minInt: 1, leechFails: 8, leechAction: 0 },
        maxTaken: 60,
    });
    assert.deepEqual(fixtureOptions, { ...DEFAULT_DECK_OPTIONS, buryReviewSiblings: false, minimumInterval: 1 });
});

test('sha1 and the note checksum match the reference implementations', () => {
    assert.equal(Buffer.from(sha1(new TextEncoder().encode('abc'))).toString('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(Buffer.from(sha1(new Uint8Array(0))).toString('hex'), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    const long = new TextEncoder().encode('x'.repeat(1000));
    assert.equal(
        Buffer.from(sha1(long)).toString('hex'),
        crypto.createHash('sha1').update(long).digest('hex'),
    );
    const field = 'Nucleus <img src="nucleus.png"> &amp; friends';
    const expected = crypto.createHash('sha1').update(stripHtmlPreservingMedia(field)).digest().readUInt32BE(0);
    assert.equal(noteChecksum(field), expected);
});

test('guids are Anki-shaped base91 strings', () => {
    // Anki's own vectors for its base-91 encoder.
    assert.equal(ankiBase91(1), 'b');
    assert.equal(ankiBase91(1234567890), 'saAKk');
    assert.equal(ankiBase91FromParts(0xffffffff, 0xffffffff), 'Rj&Z5m[>Zp');
    const a = guidForNote('1700000000001');
    const b = guidForNote('1700000000002');
    assert.notEqual(a, b);
    assert.ok(a.length >= 10 && a.length <= 12, `guid is ${a.length} characters: ${a}`);
    for (const guid of [a, b]) {
        assert.match(guid, /^[a-zA-Z0-9!#$%&()*+,\-./:;<=>?@[\]^_`{|}~]+$/);
    }
    assert.equal(guidForNote('1700000000001'), a, 'guid generation is deterministic');
    assert.equal(noteSortField('42'), 42);
    assert.equal(noteSortField('<b>42</b>'), 42);
    assert.equal(noteSortField('  twelve '), 'twelve');
});

/* -------------------------------------------------------- writing packages */

/** The fixture read back as a bundle, the way the service layer would build one. */
async function fixtureBundle(): Promise<DeckBundle> {
    const pkg = await readApkg(fixture('sample-basic.apkg'));
    const deck = pkg.decks.find((candidate) => candidate.name === 'Cell Biology::Organelles');
    assert.ok(deck);
    const db = openSqlite((await readZip(fixture('sample-basic.apkg'))).get('collection.anki2') as Uint8Array);
    const revlog = readTable(db, 'revlog').rows.map((row) => REVLOG_COLUMNS.map((column) => row[column]));
    return {
        deck,
        notes: pkg.notes,
        cards: pkg.cards,
        presets: pkg.presets,
        deckPresetOf: pkg.deckPresetOf,
        media: pkg.media,
        extra: {
            crt: pkg.meta.created,
            mod: pkg.meta.collectionModified,
            scm: pkg.meta.collectionModified,
            models: pkg.meta.raw.models,
            decks: pkg.meta.raw.decks,
            dconf: pkg.meta.raw.dconf,
            conf: pkg.meta.raw.conf,
            revlog,
            media: { 'nucleus.png': (pkg.media[0] as AnkiPackageMedia).bytes },
        },
    };
}

test('writeApkg produces a package that reads back unchanged', async () => {
    const bundle = await fixtureBundle();
    const written = await writeApkg(bundle, { now: 1792220529616, meta: 'protobuf' });
    assert.equal(written.notes, 3);
    assert.equal(written.cards, 4);
    assert.equal(written.media, 1, `warnings: ${JSON.stringify(written.warnings)}`);

    const back = await readApkg(written.bytes);
    assert.equal(back.notes.length, 3);
    assert.equal(back.cards.length, 4);
    assert.equal(back.meta.schemaVersion, 11);
    // The protobuf marker says VERSION_LEGACY_1, which is the legacy .apkg shape.
    assert.deepEqual(back.meta.version, { major: 2, minor: 1 });
    assert.deepEqual(
        back.notes.map((note) => [note.modelName, note.values, note.tags, note.fields]),
        bundle.notes.map((note) => [note.modelName, note.values, note.tags, note.fields]),
    );
    // Scheduling state per card: queue, type, interval, ease, due.
    assert.deepEqual(
        back.cards.map((card) => [card.id, card.type, card.queue, card.interval, card.easeFactor, card.due]),
        bundle.cards.map((card) => [card.id, card.type, card.queue, card.interval, card.easeFactor, card.due]),
    );
    assert.deepEqual(
        back.cards.map((card) => [card.reviews, card.lapses, card.flag, card.ord, card.deckId, card.noteId]),
        bundle.cards.map((card) => [card.reviews, card.lapses, card.flag, card.ord, card.deckId, card.noteId]),
    );
    assert.equal(back.cards[0].timeTakenMs, 5432, 'the revlog row came across');
    // Deck and options.
    const deck = back.decks.find((candidate) => candidate.name === 'Cell Biology::Organelles');
    assert.ok(deck);
    assert.equal(deck.id, bundle.deck.id);
    assert.deepEqual(deck.options, bundle.deck.options);
    assert.equal(back.deckPresetOf[deck.id], '1');
    // Media, by its original name and with its bytes.
    assert.equal(back.media.length, 1);
    assert.equal(back.media[0].originalName, 'nucleus.png');
    assert.equal(back.media[0].path, `${DECKS_MEDIA_FOLDER}/nucleus.png`);
    equalBytes(back.media[0].bytes, bundle.media[0] ? new Uint8Array(readFileSync(new URL('../test/fixtures/anki/build/nucleus.png', import.meta.url))) : new Uint8Array(0), 'media round trip');
});

test('the exported package has the entries Anki expects', async () => {
    const bundle = await fixtureBundle();
    const written = await writeApkg(bundle, { now: 1792220529616 });
    const files = await readZip(written.bytes);
    assert.deepEqual([...files.keys()], ['collection.anki2', 'media', '0', 'meta']);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('media'))), { '0': 'nucleus.png' });
    // meta is PackageMetadata { version: VERSION_LEGACY_1 } — the protobuf marker
    // Anki decodes. See anki/rslib/src/import_export/package/meta.rs: a JSON meta
    // fails Message::decode and takes the whole import down with it.
    assert.deepEqual([...(files.get('meta') as Uint8Array)], [0x08, 0x01]);
    // The collection is a plain, uncompressed-format SQLite database.
    const db = openSqlite(files.get('collection.anki2') as Uint8Array);
    assert.equal(db.pageSize, 4096);
    assert.equal(db.schemaCookie, Math.floor(1792220529616 / 1000));
    const notes = readTable(db, 'notes');
    assert.equal(notes.rows.length, 3);
    assert.equal(num(notes.rows[0].csum), noteChecksum(bundle.notes[0].values[0]));
    assert.equal(notes.rows[0].sfld, bundle.notes[0].values[0]);
    assert.equal(text(notes.rows[0].tags), ' biology organelle ');
    assert.equal(text(notes.rows[0].flds), bundle.notes[0].values.join('\x1f'));
    assert.match(text(notes.rows[0].guid), /^[a-zA-Z0-9!#$%&()*+,\-./:;<=>?@[\]^_`{|}~]{10,12}$/);
});

test('an exported package with only a stored database has no meta when asked', async () => {
    const bundle = await fixtureBundle();
    const written = await writeApkg(bundle, { now: 1792220529616, meta: 'none' });
    const files = await readZip(written.bytes);
    assert.deepEqual([...files.keys()], ['collection.anki2', 'media', '0']);
    // No warning for the default path, and Anki infers legacy 1 from the file name.
    const withMeta = await writeApkg(bundle, { now: 1792220529616 });
    assert.deepEqual(withMeta.warnings.filter(w => /meta/i.test(w)), []);
});

test('the JSON meta is still available for reproducing an old package, and says why it is a bad idea', async () => {
    const bundle = await fixtureBundle();
    const written = await writeApkg(bundle, { now: 1792220529616, meta: 'json' });
    const files = await readZip(written.bytes);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('meta'))), { ver: { major: 2, minor: 1 }, mod: 1792220529616 });
    assert.equal(written.warnings.some(w => /protobuf-decodes/.test(w)), true);
});

test('writeApkg warns about media without bytes and still writes the package', async () => {
    const bundle = await fixtureBundle();
    const withoutBytes: DeckBundle = { ...bundle, extra: { ...bundle.extra, media: undefined }, media: [bundle.media[0]] };
    const written = await writeApkg(withoutBytes, { now: 1792220529616 });
    assert.equal(written.media, 1, 'the bytes are still reachable through bundle.media');
    const stripped = await writeApkg({ ...withoutBytes, media: [{ path: 'spaceforge/decks/media/x.mp3', originalName: 'x.mp3' }] }, { now: 1792220529616 });
    assert.equal(stripped.media, 0);
    assert.ok(
        stripped.warnings.some((warning) => warning.includes('x.mp3')),
        `expected a warning about x.mp3, got ${JSON.stringify(stripped.warnings)}`,
    );
});

test('the sqlite3 CLI verifies an exported collection', { skip: !sqlite3Available }, async () => {
    const bundle = await fixtureBundle();
    // Add a note long enough to need overflow pages, then export.
    const long = `long field ${'z'.repeat(6000)}`;
    const extended: DeckBundle = {
        ...bundle,
        notes: [...bundle.notes, { id: '1700000000004', modelName: 'Basic', fields: ['Front', 'Back'], values: [long, 'answer'], tags: ['bulk'], cardIds: ['1700000000015'] }],
        cards: [...bundle.cards, { id: '1700000000015', noteId: '1700000000004', deckId: bundle.deck.id, ord: 0, type: 0, queue: 0, interval: 0, easeFactor: 0, reviews: 0, lapses: 0, due: 0, newPosition: 19002, flag: 0 }],
    };
    const written = await writeApkg(extended, { now: 1792220529616, meta: 'protobuf' });
    const dir = mkdtempSync(path.join(tmpdir(), 'spaceforge-export-'));
    try {
        const files = await readZip(written.bytes);
        const collection = path.join(dir, 'collection.anki2');
        writeFileSync(collection, files.get('collection.anki2') as Uint8Array);
        assert.equal(sqlite3Query(collection, 'PRAGMA integrity_check;'), 'ok');
        assert.equal(sqlite3Query(collection, 'select count(*) from notes;'), '4');
        assert.equal(sqlite3Query(collection, 'select count(*) from cards;'), '5');
        assert.equal(sqlite3Query(collection, 'select count(*) from revlog;'), '1');
        assert.equal(sqlite3Query(collection, 'select length(flds) from notes where id = 1700000000004;'), String(long.length + 'answer'.length + 1));
        assert.equal(sqlite3Query(collection, 'select typeof(sfld) from notes where id = 1700000000001;'), 'text');
        assert.equal(sqlite3Query(collection, "select ver from col;"), '11');
        assert.equal(sqlite3Query(collection, "select count(*) from sqlite_master where type = 'index';"), '7');
        assert.equal(sqlite3Query(collection, "select count(*) from notes indexed by ix_notes_usn;"), '4');
        assert.equal(sqlite3Query(collection, "select count(*) from cards indexed by ix_cards_sched;"), '5');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('apkg import reads the newer Anki schema (notetypes/fields tables)', { skip: !pythonAvailable }, async () => {
    // A schema-15+ collection, built by real SQLite: notetypes and fields live
    // in their own tables, `fields` is a WITHOUT ROWID table (an index b-tree),
    // and col.models/decks/dconf are empty.
    const dir = mkdtempSync(path.join(tmpdir(), 'spaceforge-modern-'));
    try {
        const collection = path.join(dir, 'collection.anki2');
        const archivePath = path.join(dir, 'modern.apkg');
        const script = `
import json, sqlite3, sys, zipfile
col, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(col)
con.create_collation('unicase', lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
con.executescript("""
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE unicase, mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL);
CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE unicase, config blob NOT NULL, PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE unicase, mtime_secs integer NOT NULL, usn integer NOT NULL, common blob NOT NULL, kind blob NOT NULL);
""")
con.execute("insert into col values (1, 1789628529, 1792220529616, 1792220529616, 18, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')")
con.execute("insert into notetypes values (1690000000000, 'Basic', 0, 0, X'')")
con.execute("insert into fields values (1690000000000, 1, 'Back', X'')")
con.execute("insert into fields values (1690000000000, 0, 'Front', X'')")
con.execute("insert into decks values (1, 'Default', 0, 0, X'', X'')")
con.execute("insert into decks values (1700000000000, 'Cell Biology::Organelles', 0, 0, X'', X'')")
con.execute("insert into notes values (1700000000001, 'guidAAA', 1690000000000, 0, 0, ' biology ', 'What organelle generates ATP?' || char(31) || 'The mitochondrion.', 'What organelle generates ATP?', 111, 0, '')")
con.execute("insert into cards values (1700000000011, 1700000000001, 1700000000000, 0, 0, 0, 2, 2, 19005, 5, 2500, 3, 1, 0, 0, 0, 0, '')")
con.commit()
con.close()
z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)
z.write(col, 'collection.anki2')
z.writestr('media', json.dumps({'0': 'nucleus.png'}))
z.writestr('meta', json.dumps({'ver': {'major': 2, 'minor': 1}, 'mod': 1792220529616}))
z.close()
`;
        execFileSync('python3', ['-c', script, collection, archivePath]);
        const pkg = await readApkg(new Uint8Array(readFileSync(archivePath)));
        assert.equal(pkg.meta.schemaVersion, 18);
        assert.equal(pkg.notes.length, 1);
        assert.equal(pkg.cards.length, 1);
        // Field names come from the WITHOUT ROWID fields table, in ord order.
        assert.equal(pkg.notes[0].modelName, 'Basic');
        assert.deepEqual(pkg.notes[0].fields, ['Front', 'Back']);
        assert.deepEqual(pkg.notes[0].values, ['What organelle generates ATP?', 'The mitochondrion.']);
        assert.deepEqual(pkg.notes[0].tags, ['biology']);
        // Deck names come from the decks table.
        assert.deepEqual(
            pkg.decks.map((deck) => deck.name).sort(),
            ['Cell Biology::Organelles', 'Default'],
        );
        assert.equal(pkg.cards[0].deckId, '1700000000000');
        assert.equal(pkg.cards[0].interval, 5);
        assert.equal(pkg.cards[0].due, 19005);
        assert.ok(
            pkg.warnings.some((warning) => warning.includes('newer Anki schema')),
            `expected a newer-schema note, got ${JSON.stringify(pkg.warnings)}`,
        );
        assert.ok(
            pkg.warnings.some((warning) => warning.includes('nucleus.png')),
            'the media the map promises but does not carry is reported',
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rowid aliases are recognised in the declarations Anki uses', () => {
    const columns = (sql: string) => sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')')).split(/\n|,/).map((part) => (part.trim().split(/\s+/)[0] ?? '')).filter((name) => name !== '');
    const check = (sql: string, expected: string) => {
        const names = columns(sql);
        const index = parseRowidAlias(sql, names);
        assert.equal(index >= 0 ? names[index] : null, expected, sql.replace(/\s+/g, ' ').slice(0, 60));
    };
    // Anki's schema 11 tables.
    check('CREATE TABLE cards (\n  id integer PRIMARY KEY,\n  nid integer NOT NULL,\n  data text NOT NULL\n)', 'id');
    // Anki's schema 14/15 tables, where the constraints are written differently.
    check('CREATE TABLE deck_config (\n  id integer PRIMARY KEY NOT NULL,\n  name text NOT NULL\n)', 'id');
    check('CREATE TABLE notetypes (\n  id integer NOT NULL PRIMARY KEY,\n  name text NOT NULL\n)', 'id');
    check('CREATE TABLE notes (\n  id integer PRIMARY KEY AUTOINCREMENT,\n  guid text NOT NULL\n)', 'id');
    // Not aliases: a different declared type, a DESC key, a WITHOUT ROWID table.
    check('CREATE TABLE t (\n  id int PRIMARY KEY,\n  x text\n)', null);
    check('CREATE TABLE t (\n  id integer PRIMARY KEY DESC,\n  x text\n)', null);
    check('CREATE TABLE fields (\n  ntid integer NOT NULL,\n  ord integer NOT NULL,\n  PRIMARY KEY (ntid, ord)\n) WITHOUT ROWID', null);
    // A table constraint on a single INTEGER column does alias the rowid.
    check('CREATE TABLE t (\n  id integer NOT NULL,\n  PRIMARY KEY (id)\n)', 'id');
});

test('Anki’s own commented DDL reads every column, not just the first', async () => {
    // A real deck (Robbins Basic Pathology) exposed this: Anki declares notes and
    // cards with a /* N */ comment after each column, which lands at the start of
    // the next comma-separated definition. A parser that keeps those comments
    // recovers one column and silently reads every other field as undefined.
    const bytes = new Uint8Array(readFileSync(fixturePath('commented-ddl.anki2')));
    const pkg = await readApkg(bytes);

    assert.deepEqual(pkg.notes.map(note => note.fields), [['Text', 'Extra']]);
    assert.equal(pkg.notes[0].modelName, 'Cloze');
    assert.equal(pkg.notes[0].values[0].includes('{{c1::hypertrophy}}'), true, 'the text arrived');
    assert.equal(pkg.notes[0].values[1], 'Extra detail.');
    assert.equal(pkg.cards.length, 1);
    assert.equal(pkg.cards[0].easeFactor, 2500);
    assert.deepEqual(pkg.warnings, [], 'and nothing was guessed at');
});

// ------------------------------------- a package Anki will actually accept

/** The models row a written package carries, as Anki would decode it. */
async function modelsIn(bytes: Uint8Array): Promise<Array<Record<string, unknown>>> {
    const back = await readApkg(bytes);
    const models = back.meta.raw.models as Record<string, Record<string, unknown>>;
    return Object.values(models);
}

test('a note with fewer values than its model has fields is padded, not refused', async () => {
    const bundle = await fixtureBundle();
    // The document keeps eight field names but only two values — what a hand
    // edit, or an import that dropped empty trailing fields, leaves behind.
    const note = bundle.notes[0];
    const eight = ['Front', 'Back', 'Extra', 'Example', 'Hint', 'Source', 'Tag', 'Note'];
    note.fields = eight;
    note.values = ['only front', 'only back'];

    const written = await writeApkg(bundle, { now: 1792220529616 });
    const models = await modelsIn(written.bytes);
    const model = models.find(candidate => candidate.name === note.modelName);
    assert.ok(model, 'the notetype is there');
    assert.equal((model.flds as unknown[]).length, 2, 'the model is exactly as wide as the note');

    const back = await readApkg(written.bytes);
    const reread = back.notes.find(candidate => candidate.modelName === note.modelName);
    assert.deepEqual(reread?.values, ['only front', 'only back'], 'and the values are untouched');
});

test('a note narrower than its model is padded to the model’s width and reported', async () => {
    const bundle = await fixtureBundle();
    const note = bundle.notes[0];
    const modelId = String(bundle.deck.id);
    // A raw model of Anki's own: three fields, which the note must match.
    bundle.extra.models = {
        [modelId]: {
            id: Number(modelId),
            name: note.modelName,
            type: 0,
            flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }, { name: 'Source', ord: 2 }],
            tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
        },
    };
    note.fields = ['Front', 'Back', 'Source'];
    note.values = ['a', 'b'];

    const written = await writeApkg(bundle, { now: 1792220529616 });
    assert.match(written.warnings.join(' | '), /fewer values than their notetype has fields/);
    const back = await readApkg(written.bytes);
    const reread = back.notes.find(candidate => candidate.modelName === note.modelName);
    assert.deepEqual(reread?.values, ['a', 'b', ''], 'the missing field is written empty');
});

test('a template requirement points at a field the model actually has', async () => {
    const bundle = await fixtureBundle();
    // Cards with ordinals far past the field count: a merged or hand-edited
    // deck, which is what Anki refused with "missing template".
    const note = bundle.notes[0];
    bundle.cards.push({
        ...bundle.cards[0],
        id: '1792300999999',
        noteId: note.id,
        ord: 27,
    });

    const written = await writeApkg(bundle, { now: 1792220529616 });
    const models = await modelsIn(written.bytes);
    const model = models.find(candidate => candidate.name === note.modelName);
    assert.ok(model);
    const fieldCount = (model.flds as unknown[]).length;
    const req = model.req as Array<[number, string, number[]]>;
    for (const [, , fields] of req) {
        for (const index of fields) {
            assert.ok(index >= 0 && index < fieldCount, `requirement ${index} is inside 0..${fieldCount - 1}`);
        }
    }
    const templates = model.tmpls as Array<{ ord: number }>;
    const ords = new Set(templates.map(template => template.ord));
    assert.ok(
        ords.has(27),
        `and the new ordinal has a template of its own (note ${note.id}; cards: ${bundle.cards.map(c => c.noteId + '@' + c.ord).join(', ')}; models: ${models.map(candidate => `${candidate.name}: ${(candidate.tmpls as Array<{ ord: number }>).map(template => template.ord).join(',')}`).join(' | ')}; note model ${note.modelName})`
    );
});
