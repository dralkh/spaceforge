/**
 * The deck service: the seam between the Anki package layer and the vault
 * deck store, driven against the real fixtures.
 *
 * Two real packages go through the whole pipeline — `sample-basic.apkg` (plain
 * SQLite) and `sample-zstd.apkg` (a zstd `.anki21b`) — into an in-memory vault
 * adapter, then back out through `exportDeck()` and into a second vault, so
 * the round trip is exercised the way a command would drive it. The missing
 * media paths and the multi-deck decision are covered explicitly.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TFile, TFolder } from 'obsidian';

import { readApkg } from '../api/anki/apkg';
import { SCHEMA_SQL, writeApkg } from '../api/anki/apkg-write';
import { writeSqlite } from '../api/anki/sqlite-write';
import { writeZip } from '../api/anki/zip';
import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    AnkiDeck,
    DeckBundle,
    DEFAULT_DECK_OPTIONS,
    DECKS_FOLDER,
    DECKS_MEDIA_FOLDER,
} from '../models/anki';
import { isDeckDocumentPath } from '../models/deck-document';
import { DeckStore } from '../services/deck-store';
import { DeckService, chooseTopDeck } from '../services/deck-service';

const NOW = 1_700_000_000_000;
const DECK_PATH = `${DECKS_FOLDER}/Cell Biology - Organelles.md`;
const MEDIA_PATH = `${DECKS_MEDIA_FOLDER}/nucleus.png`;

// --------------------------------------------------------------- fixtures

const fixturePath = (name: string) => new URL(`../test/fixtures/anki/${name}`, import.meta.url);
const buildPath = (name: string) => new URL(`../test/fixtures/anki/build/${name}`, import.meta.url);

const BASIC = new Uint8Array(readFileSync(fixturePath('sample-basic.apkg')));
const ZSTD = new Uint8Array(readFileSync(fixturePath('sample-zstd.apkg')));
const NUCLEUS_PNG = new Uint8Array(readFileSync(buildPath('nucleus.png')));

/**
 * A one-card bundle, the way a command would hand one to `writeApkg()`. Used
 * where a real fixture cannot express the case (media without bytes, a deck
 * with a source URL).
 */
function tinyBundle(): DeckBundle {
    const deck: AnkiDeck = {
        id: '1700000000123',
        name: 'Shared deck',
        modified: NOW,
        options: DEFAULT_DECK_OPTIONS,
        parentId: null,
    };
    return {
        deck,
        notes: [{
            id: '1700000000221',
            modelName: 'Basic',
            fields: ['Front', 'Back'],
            values: ['Front text', 'Back text'],
            tags: [],
            cardIds: ['1700000000222'],
            mediaFiles: [],
        }],
        cards: [{
            id: '1700000000222',
            noteId: '1700000000221',
            deckId: deck.id,
            ord: 0,
            type: AnkiCardType.New,
            queue: AnkiCardQueue.New,
            interval: 0,
            easeFactor: 2500,
            reviews: 0,
            lapses: 0,
            due: NOW,
            newPosition: 1,
            flag: 0,
        }],
        media: [],
    };
}

// --------------------------------------------------------------- fake vault

/** Just enough of Obsidian's vault to drive the service, over a map. */
function fakeVault() {
    const files = new Map<string, { text?: string; bytes?: ArrayBuffer }>();
    const folders = new Set<string>();
    const trashed: string[] = [];
    const fileObjects = new Map<string, TFile>();
    const folderObjects = new Map<string, TFolder>();

    const fileAt = (path: string): TFile => {
        let file = fileObjects.get(path);
        if (!file) {
            file = new TFile();
            fileObjects.set(path, file);
        }
        const entry = files.get(path);
        file.path = path;
        file.name = path.split('/').pop() ?? path;
        file.basename = file.name.replace(/\.[^.]+$/, '');
        file.extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
        file.stat = { mtime: NOW, ctime: NOW, size: entry?.bytes?.byteLength ?? entry?.text?.length ?? 0 };
        return file;
    };

    const folderAt = (path: string): TFolder => {
        let folder = folderObjects.get(path);
        if (!folder) {
            folder = new TFolder();
            folderObjects.set(path, folder);
        }
        folder.path = path;
        folder.name = path.split('/').pop() ?? path;
        return folder;
    };

    const vault = {
        getFiles: (): TFile[] => Array.from(files.keys()).map(path => fileAt(path)),
        getAbstractFileByPath: (path: string): TFile | TFolder | null => {
            if (files.has(path)) return fileAt(path);
            if (folders.has(path)) return folderAt(path);
            return null;
        },
        create: async (path: string, data: string): Promise<TFile> => {
            if (files.has(path)) throw new Error(`File already exists: ${path}`);
            files.set(path, { text: data });
            return fileAt(path);
        },
        createBinary: async (path: string, data: ArrayBuffer): Promise<TFile> => {
            if (files.has(path)) throw new Error(`File already exists: ${path}`);
            files.set(path, { bytes: data });
            return fileAt(path);
        },
        createFolder: async (path: string): Promise<TFolder> => {
            folders.add(path);
            return folderAt(path);
        },
        read: async (file: TFile): Promise<string> => {
            const entry = files.get(file.path);
            if (!entry || entry.text === undefined) throw new Error(`no such file: ${file.path}`);
            return entry.text;
        },
        readBinary: async (file: TFile): Promise<ArrayBuffer> => {
            const entry = files.get(file.path);
            if (!entry || entry.bytes === undefined) throw new Error(`no such file: ${file.path}`);
            return entry.bytes;
        },
        modify: async (file: TFile, data: string): Promise<void> => {
            if (!files.has(file.path)) throw new Error(`no such file: ${file.path}`);
            files.set(file.path, { text: data });
        },
    };

    const fileManager = {
        renameFile: async (file: TFile, newPath: string): Promise<void> => {
            const entry = files.get(file.path);
            if (!entry) throw new Error(`no such file: ${file.path}`);
            files.delete(file.path);
            files.set(newPath, entry);
            fileObjects.delete(file.path);
        },
        trashFile: async (file: TFile): Promise<void> => {
            files.delete(file.path);
            trashed.push(file.path);
        },
    };

    const plugin = { app: { vault, fileManager } } as unknown as ConstructorParameters<typeof DeckService>[0];
    const store = new DeckStore(plugin);
    return { service: new DeckService(plugin, store), store, files, folders, trashed };
}

const deckFilesIn = (files: Map<string, unknown>): string[] =>
    Array.from(files.keys()).filter(path => isDeckDocumentPath(path)).sort();

// ------------------------------------------------------------ importing

test('importing sample-basic.apkg writes the deck, its media and rewrites the card text', async () => {
    const { service, store, files, folders } = fakeVault();
    const report = await service.importApkg(BASIC);

    assert.deepEqual(report, {
        deckPath: DECK_PATH,
        deckName: 'Cell Biology::Organelles',
        notesImported: 3,
        cardsImported: 4,
        mediaImported: 1,
        missingMedia: [],
        warnings: [],
        replaced: false,
    }, `the fixture imports cleanly: ${report.warnings.join(' | ')}`);
    assert.equal(folders.has(DECKS_FOLDER), true, 'the decks folder was made');
    assert.equal(files.has(DECK_PATH), true, 'the deck file exists at spaceforge/decks/<sanitized name>.md');
    assert.equal(files.has(MEDIA_PATH), true, 'the media was written under spaceforge/decks/media/');
    assert.deepEqual(new Uint8Array(files.get(MEDIA_PATH)?.bytes as ArrayBuffer), NUCLEUS_PNG, 'with its own bytes');

    const text = files.get(DECK_PATH)?.text ?? '';
    assert.match(text, /<img src="spaceforge\/decks\/media\/nucleus\.png">/, 'the card text points at the vault path');
    assert.equal(text.includes('<img src="nucleus.png">'), false, 'the package file name is gone');
    assert.match(text, /\nname: "Cell Biology::Organelles"\n/, 'the deck keeps its Anki name');

    const read = await store.readDeck(DECK_PATH);
    assert.equal(read.deck.id, '1700000000000');
    assert.deepEqual(read.cards.map(card => card.id), [
        '1700000000011',
        '1700000000012',
        '1700000000013',
        '1700000000014',
    ]);
    assert.deepEqual(read.notes[1].values, [
        'Nucleus',
        'Contains the genome <img src="spaceforge/decks/media/nucleus.png">',
    ], 'the note text came back rewritten');
    assert.deepEqual(read.notes[1].mediaFiles, ['spaceforge/decks/media/nucleus.png']);
    assert.deepEqual(read.media, [{ path: MEDIA_PATH, originalName: 'nucleus.png', mime: 'image/png', size: 95 }]);
    assert.ok(
        read.cards.every(card => card.deckId === read.deck.id),
        "Anki's own empty \"Default\" deck was not reported and no card points at it",
    );
});

test('the zstd package imports the same content', async () => {
    const { service, store, files } = fakeVault();
    const report = await service.importApkg(ZSTD);

    assert.equal(report.deckPath, DECK_PATH);
    assert.equal(report.notesImported, 3);
    assert.equal(report.cardsImported, 4);
    assert.equal(report.mediaImported, 1);
    assert.deepEqual(report.warnings, []);

    const read = await store.readDeck(DECK_PATH);
    assert.deepEqual(read.notes[0].values, [
        'What organelle generates ATP?',
        'The mitochondrion, via oxidative phosphorylation.',
    ]);
    assert.deepEqual(read.cards.map(card => [card.id, card.type, card.queue, card.due]), [
        ['1700000000011', 2, 2, (Math.floor(1789628529 / 86400) + 19005) * 86400000],
        ['1700000000012', 0, 0, 0],
        ['1700000000013', 3, 1, 3000],
        ['1700000000014', 1, 1, 4000],
    ]);
    assert.equal(files.has(MEDIA_PATH), true);
});

test('a bare collection database imports its cards and reports the media the notes expect', async () => {
    const { service } = fakeVault();
    const report = await service.importApkg(new Uint8Array(readFileSync(buildPath('collection.anki2'))));

    assert.equal(report.cardsImported, 4);
    assert.equal(report.mediaImported, 0);
    assert.deepEqual(report.missingMedia, ['nucleus.png'], 'the notes expect an image the database cannot carry');
    assert.ok(report.warnings.some(warning => warning.includes('nucleus.png')), `warnings: ${report.warnings.join(' | ')}`);
});

// ------------------------------------------------------- replacing

test('re-importing the same deck replaces its file instead of duplicating it', async () => {
    const { service, store, files } = fakeVault();
    const first = await service.importApkg(BASIC);
    assert.equal(first.replaced, false);

    const second = await service.importApkg(BASIC);
    assert.equal(second.replaced, true, 'the same Anki id replaced the earlier import');
    assert.equal(second.deckPath, first.deckPath, 'and it landed in the same file');
    assert.deepEqual(deckFilesIn(files), [first.deckPath], 'no second deck document');
    assert.equal(second.notesImported, 3);
    assert.equal(second.cardsImported, 4);

    const read = await store.readDeck(first.deckPath);
    assert.equal(read.cards.length, 4, 'and no duplicate cards');
    assert.equal(new Set(read.cards.map(card => card.id)).size, 4);
    assert.equal(read.notes.length, 3);

    // The store's media writer is collision-safe, so the earlier copy of the
    // image is still in the vault beside the fresh one. The service says so
    // rather than deleting a file another deck might share.
    assert.equal(second.mediaImported, 1);
    assert.equal(files.has(MEDIA_PATH), true, 'the first copy is untouched');
    assert.equal(files.has(`${DECKS_MEDIA_FOLDER}/nucleus-1.png`), true, 'the re-import wrote a fresh copy');
    assert.match(second.warnings.join(' '), /earlier import/, `warnings: ${second.warnings.join(' | ')}`);

    // A package of the same deck in the other container format replaces too.
    const third = await service.importApkg(ZSTD);
    assert.equal(third.replaced, true);
    assert.equal(third.deckPath, first.deckPath);
    assert.deepEqual(deckFilesIn(files), [first.deckPath]);
});

test('replaceExisting: false writes a second deck file beside the first', async () => {
    const { service, files } = fakeVault();
    const first = await service.importApkg(BASIC);
    const second = await service.importApkg(BASIC, { replaceExisting: false });

    assert.equal(second.replaced, false);
    assert.equal(second.deckPath, `${DECKS_FOLDER}/Cell Biology - Organelles 2.md`);
    assert.deepEqual(deckFilesIn(files), [first.deckPath, second.deckPath].sort());
});

test('an existing deck is replaced when its name, not its id, matches', async () => {
    const { service, store, files } = fakeVault();
    const hand = await store.createDeck('Cell Biology::Organelles');
    assert.equal(hand.path, DECK_PATH);

    const report = await service.importApkg(BASIC);
    assert.equal(report.replaced, true, 'matched by name');
    assert.equal(report.deckPath, DECK_PATH);
    assert.deepEqual(deckFilesIn(files), [DECK_PATH]);

    const read = await store.readDeck(DECK_PATH);
    assert.equal(read.deck.id, '1700000000000', 'the imported deck took the file over');
    assert.equal(read.cards.length, 4);
});

test('a deck is matched by the AnkiWeb id its package was shared under', async () => {
    const bundle = tinyBundle();
    bundle.deck.sourceUrl = 'https://ankiweb.net/shared/info/7654321';
    const pkg = await writeApkg(bundle, { now: NOW });

    const { service, files } = fakeVault();
    const path = `${DECKS_FOLDER}/Renamed shared deck.md`;
    files.set(path, {
        text: [
            '---',
            'sf-deck: 1',
            'id: "1700000099999"',
            'name: "Renamed shared deck"',
            'ankiWebId: "7654321"',
            'modified: 1700000000000',
            '---',
            '',
            '# Renamed shared deck',
            '',
        ].join('\n'),
    });

    const report = await service.importApkg(pkg.bytes);
    assert.equal(report.replaced, true, 'matched by the AnkiWeb id, with a different id and name');
    assert.equal(report.deckPath, path);
    assert.deepEqual(deckFilesIn(files), [path]);
});

// ------------------------------------------------------------ exporting

test('a deck exports to a package that imports back with the same notes, cards, media and schedule', async () => {
    const first = fakeVault();
    const imported = await first.service.importApkg(BASIC);

    const exported = await first.service.exportDeck(imported.deckPath, { now: NOW });
    assert.ok(exported.bytes.length > 0);
    assert.deepEqual(exported.report, {
        path: `${DECKS_FOLDER}/Cell Biology - Organelles.apkg`,
        notes: 3,
        cards: 4,
        media: 1,
        bytes: exported.bytes.length,
    });
    assert.deepEqual(exported.warnings, []);
    assert.equal(first.files.has(exported.report.path), false, 'exportDeck returns the bytes; the caller writes the file');

    // The package is a real one: the package layer reads it back, and its
    // media references are the original file names Anki understands.
    const pkg = await readApkg(exported.bytes);
    assert.equal(pkg.notes.length, 3);
    assert.equal(pkg.cards.length, 4);
    assert.equal(pkg.media.length, 1);
    assert.equal(pkg.media[0].originalName, 'nucleus.png');
    assert.deepEqual(new Uint8Array(pkg.media[0].bytes), NUCLEUS_PNG);
    assert.deepEqual(pkg.notes[1].values[1], 'Contains the genome <img src="nucleus.png">', 'the vault path was rewritten back to the package name');

    // And a fresh vault imports it as the same deck.
    const second = fakeVault();
    const again = await second.service.importApkg(exported.bytes);
    assert.equal(again.deckPath, DECK_PATH, 'same deck name, same file');
    assert.equal(again.notesImported, 3);
    assert.equal(again.cardsImported, 4);
    assert.equal(again.mediaImported, 1);
    assert.deepEqual(again.missingMedia, []);
    assert.deepEqual(again.warnings, []);

    const before = await first.store.readDeck(imported.deckPath);
    const after = await second.store.readDeck(again.deckPath);
    assert.deepEqual(
        after.cards.map(card => [card.id, card.noteId, card.ord, card.type, card.queue, card.due, card.interval, card.easeFactor, card.reviews, card.lapses, card.newPosition]),
        before.cards.map(card => [card.id, card.noteId, card.ord, card.type, card.queue, card.due, card.interval, card.easeFactor, card.reviews, card.lapses, card.newPosition]),
        'the scheduling state survived: due, interval, ease, reps and the new-queue position',
    );
    assert.deepEqual(after.notes.map(note => [note.id, note.modelName, note.values]), before.notes.map(note => [note.id, note.modelName, note.values]));
    // The package layer folds revlog rows into card.timeTakenMs and hands out
    // no raw rows, so an export rebuilds the deck but not the review log.
    assert.equal(before.cards[0].timeTakenMs, 5432);
    assert.equal(after.cards[0].timeTakenMs, undefined);

    // The vault path in the text is the fresh one, not the first vault's.
    const text = second.files.get(again.deckPath)?.text ?? '';
    assert.match(text, /<img src="spaceforge\/decks\/media\/nucleus\.png">/);
});

test('exporting a deck whose media has gone missing warns and still writes the package', async () => {
    const { service, store, files } = fakeVault();
    const imported = await service.importApkg(BASIC);
    await store.deleteMedia(MEDIA_PATH);

    const exported = await service.exportDeck(imported.deckPath);
    assert.equal(exported.report.cards, 4);
    assert.equal(exported.report.media, 0, 'no bytes to carry');
    assert.ok(
        exported.warnings.some(warning => warning.includes('nucleus.png')),
        `warnings: ${exported.warnings.join(' | ')}`,
    );
    const pkg = await readApkg(exported.bytes);
    assert.equal(pkg.cards.length, 4, 'the deck itself still exports');
    assert.equal(pkg.media.length, 0);
    assert.equal(files.has(exported.report.path), false);
});

// ------------------------------------------------------------ missing media

test('a package whose media map lists a file that is not inside still imports its cards, with a warning', async () => {
    const archive = await writeZip([
        { name: 'collection.anki2', data: new Uint8Array(readFileSync(buildPath('collection.anki2'))) },
        { name: 'media', data: new TextEncoder().encode(JSON.stringify({ '0': 'nucleus.png', '1': 'gone.mp3' })) },
        { name: '0', data: NUCLEUS_PNG, store: true },
    ]);

    const { service, store, files } = fakeVault();
    const report = await service.importApkg(archive);

    assert.equal(report.notesImported, 3);
    assert.equal(report.cardsImported, 4, 'the cards imported despite the missing media entry');
    assert.equal(report.mediaImported, 1, 'the file that was inside was written');
    assert.ok(
        report.warnings.some(warning => warning.includes('gone.mp3')),
        `expected a warning about gone.mp3, got ${JSON.stringify(report.warnings)}`,
    );
    assert.equal(files.has(MEDIA_PATH), true);
    const read = await store.readDeck(report.deckPath);
    assert.equal(read.cards.length, 4);
    assert.equal(read.media.length, 1);
});

test('media the notes reference but the package does not carry warns, and the cards still import', async () => {
    const bundle = tinyBundle();
    bundle.notes[0].values = ['Look: <img src="ghost.png">', 'answer'];
    bundle.notes[0].mediaFiles = ['ghost.png'];
    // The entry has no bytes, so `writeApkg()` leaves it out of the package.
    bundle.media = [{ path: `${DECKS_MEDIA_FOLDER}/ghost.png`, originalName: 'ghost.png' }];
    const pkg = await writeApkg(bundle, { now: NOW });
    assert.equal(pkg.media, 0);

    const { service, store, files } = fakeVault();
    const report = await service.importApkg(pkg.bytes);

    assert.equal(report.cardsImported, 1);
    assert.equal(report.mediaImported, 0);
    assert.deepEqual(report.missingMedia, ['ghost.png']);
    assert.ok(report.warnings.some(warning => warning.includes('ghost.png')), `warnings: ${report.warnings.join(' | ')}`);

    const text = files.get(report.deckPath)?.text ?? '';
    assert.match(text, /<img src="ghost\.png">/, 'nothing to point at: the reference stays as written');
    assert.equal((await store.readDeck(report.deckPath)).cards.length, 1);
});

// ------------------------------------------------------------- multi-deck

test('the deck chooser takes the deck with the most cards and reports the decks it folds in', () => {
    // A two-card-bearing-deck package cannot be built through `writeApkg()`:
    // the writer always emits Anki's own `Default` deck plus the bundle's one
    // deck, and re-homes any card that names a third. So the multi-deck
    // *decision* is checked on the chooser itself; the real fixture already
    // carries a second deck (`Default`, empty), and the import tests above
    // assert it produces no warning and catches no cards.
    const deck = (id: string, name: string): AnkiDeck => ({ id, name, modified: NOW, options: DEFAULT_DECK_OPTIONS, parentId: null });
    const card = (id: string, deckId: string): AnkiCard => ({
        id,
        noteId: `note-${id}`,
        deckId,
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: 0,
        flag: 0,
    });
    const decks = [deck('1', 'Default'), deck('2', 'Small'), deck('3', 'Big')];

    const choice = chooseTopDeck(decks, [card('a', '2'), card('b', '3'), card('c', '3'), card('d', '3')]);
    assert.equal(choice.deck?.name, 'Big');
    assert.deepEqual(choice.ignored, [{ name: 'Small', cards: 1 }], "the empty \"Default\" deck is not worth a warning");

    // A tie keeps the package's own order, so the choice is deterministic.
    assert.equal(chooseTopDeck(decks, [card('a', '2'), card('b', '3')]).deck?.name, 'Small');

    // Cards naming a deck the package does not define do not derail the choice.
    assert.equal(chooseTopDeck([deck('1', 'Only')], [card('a', 'ghost')]).deck?.name, 'Only');

    assert.deepEqual(chooseTopDeck([], [card('a', '1')]), { deck: null, ignored: [] });
    assert.deepEqual(chooseTopDeck([deck('1', 'Default')], []), { deck: decks[0], ignored: [] }, 'an empty package still imports as its deck');
});

// ------------------------------------------------------- multi-deck import

test('a package that names no deck of its own still imports, into a new one', async () => {
    // `writeApkg()` always names a deck, so this one is built by hand: a
    // collection whose `decks` JSON is empty (a database some other tool
    // wrote) is still worth importing.
    const database = writeSqlite({
        tables: [
            {
                name: 'col',
                sql: SCHEMA_SQL.col,
                columns: ['id', 'crt', 'mod', 'scm', 'ver', 'dty', 'usn', 'ls', 'conf', 'models', 'decks', 'dconf', 'tags'],
                rows: [[1, 1789628529, NOW, NOW, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}']],
            },
            {
                name: 'notes',
                sql: SCHEMA_SQL.notes,
                columns: ['id', 'guid', 'mid', 'mod', 'usn', 'tags', 'flds', 'sfld', 'csum', 'flags', 'data'],
                rows: [[1700000000001, 'guidAAA', 1690000000000, 0, 0, ' biology ', 'Front text\u001fBack text', 'Front text', 111, 0, '']],
            },
            {
                name: 'cards',
                sql: SCHEMA_SQL.cards,
                columns: ['id', 'nid', 'did', 'ord', 'mod', 'usn', 'type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odue', 'odid', 'flags', 'data'],
                rows: [[1700000000011, 1700000000001, 1, 0, 0, 0, 0, 0, 0, 0, 2500, 0, 0, 0, 0, 0, 0, '']],
            },
        ],
    });
    const archive = await writeZip([{ name: 'collection.anki2', data: database }]);

    const { service, store } = fakeVault();
    const report = await service.importApkg(archive, { name: 'Kept' });
    assert.equal(report.deckName, 'Kept');
    assert.equal(report.deckPath, `${DECKS_FOLDER}/Kept.md`);
    assert.equal(report.notesImported, 1);
    assert.equal(report.cardsImported, 1);
    assert.match(report.warnings.join(' '), /names no deck/);

    const read = await store.readDeck(report.deckPath);
    assert.equal(read.cards.length, 1);
    assert.equal(read.cards[0].deckId, read.deck.id, 'the card was placed in the new deck');
});

// --------------------------------------------------------------- helpers

test('the command helpers suggest a name, summarise a report and name the file extension', async () => {
    const { service } = fakeVault();
    assert.equal(service.deckFileExtension(), '.apkg');
    assert.equal(await service.suggestImportName(BASIC), 'Cell Biology - Organelles');
    assert.equal(await service.suggestImportName(ZSTD), 'Cell Biology - Organelles');
    assert.equal(await service.suggestImportName(new Uint8Array([1, 2, 3]), 'Mitosis / Meiosis'), 'Mitosis - Meiosis');
    assert.equal(await service.suggestImportName(new Uint8Array([1, 2, 3])), 'Imported deck');

    const base = {
        deckPath: DECK_PATH,
        deckName: 'Twice',
        notesImported: 1,
        cardsImported: 2,
        mediaImported: 0,
        missingMedia: [],
        warnings: [],
        replaced: false,
    };
    assert.equal(service.summarizeImport({ ...base }), 'Imported 1 note and 2 cards into "Twice".');
    assert.equal(
        service.summarizeImport({ ...base, mediaImported: 1, replaced: true }),
        'Imported 1 note and 2 cards into "Twice" (1 media file, replacing the earlier import).',
    );
    assert.equal(
        service.summarizeImport({ ...base, missingMedia: ['a.png'], warnings: ['one', 'two'] }),
        'Imported 1 note and 2 cards into "Twice" (1 referenced file missing, 2 warnings).',
    );

    // And on a real import, the suggested name is what the import produces.
    const suggested = await service.suggestImportName(BASIC);
    const report = await service.importApkg(BASIC, { name: suggested });
    assert.equal(report.deckName, suggested);
    assert.equal(report.deckPath, DECK_PATH);
    assert.equal(service.summarizeImport(report), 'Imported 3 notes and 4 cards into "Cell Biology - Organelles" (1 media file).');
});
