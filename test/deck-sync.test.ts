/**
 * The per-device answer log: encoding, decoding, folding into a deck, and the
 * `mod` stamp travelling through the document and the package.
 *
 * The log exists because a deck is one file. These cases pin the two
 * properties that makes the design work: an entry is the *whole* card (so a
 * merge never needs a scheduler replay), and applying two devices' logs picks
 * the newest stamp per card without resurrecting cards the document dropped.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readApkg } from '../api/anki/apkg';
import { writeApkg } from '../api/anki/apkg-write';
import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    DeckBundle,
    DEFAULT_DECK_OPTIONS,
} from '../models/anki';
import {
    applySyncEntries,
    decodeSyncEntries,
    encodeSyncEntry,
    syncFolderName,
} from '../models/deck-sync';
import { parseDeckWithWarnings, serializeDeck, updateCardStateLine } from '../models/deck-document';
import { DeckSyncService } from '../services/deck-sync-service';

const NOW = 1_700_000_000_000;
const DECK_ID = '1700000000000';

function card(id: string, overrides: Partial<AnkiCard> = {}): AnkiCard {
    return {
        id,
        noteId: `note-${id}`,
        deckId: DECK_ID,
        ord: 0,
        type: AnkiCardType.Review,
        queue: AnkiCardQueue.Review,
        interval: 4,
        easeFactor: 2500,
        reviews: 3,
        lapses: 0,
        due: NOW + 4 * 86_400_000,
        newPosition: null,
        flag: 0,
        ...overrides,
    };
}

function bundle(cards: AnkiCard[]): DeckBundle {
    return {
        deck: { id: DECK_ID, name: 'Biology', modified: NOW, options: DEFAULT_DECK_OPTIONS },
        notes: cards.map(entry => ({
            id: entry.noteId,
            modelName: 'Basic',
            fields: ['Front', 'Back'],
            values: [`Q ${entry.id}`, `A ${entry.id}`],
            tags: [],
            cardIds: [entry.id],
            mediaFiles: [],
        })),
        cards,
        media: [],
    };
}

// --------------------------------------------------------------- the format

test('an entry is the whole card, and decodes back to it', () => {
    const written = card('a', { interval: 9, mod: NOW });
    const line = encodeSyncEntry(written);

    assert.ok(line.endsWith('\n'), 'one entry per line');
    const entries = decodeSyncEntries(line, 'phone', []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].device, 'phone');
    assert.equal(entries[0].mod, NOW);
    assert.deepEqual(entries[0].card, written);
});

test('a torn line is reported and skipped, the rest of the log still reads', () => {
    const good = encodeSyncEntry(card('a', { mod: NOW }));
    const warnings: string[] = [];
    const entries = decodeSyncEntries(`{"mod": 1, "card": {"id": "a"}\n${good}{"mod": 3, "card": null}\n`, 'desktop', warnings);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].card.id, 'a');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /line 1 is not valid JSON/);
    assert.match(warnings[1], /line 3 is not a card state/);
});

test('the folder name survives a deck id that is not a plain number', () => {
    assert.equal(syncFolderName('1700000000000'), '1700000000000');
    assert.equal(syncFolderName('deck/with:odd chars'), 'deck_with_odd_chars');
    assert.equal(syncFolderName(''), 'deck');
});

// --------------------------------------------------------------- applying

test('the newest entry per card wins, across devices', () => {
    const document = [card('a', { interval: 4, mod: NOW }), card('b', { interval: 4, mod: NOW })];
    const entries = [
        { device: 'phone', mod: NOW + 1_000, card: card('a', { interval: 20, mod: NOW + 1_000 }) },
        { device: 'desktop', mod: NOW + 2_000, card: card('a', { interval: 30, mod: NOW + 2_000 }) },
        { device: 'phone', mod: NOW - 1_000, card: card('b', { interval: 1, mod: NOW - 1_000 }) },
    ];

    const result = applySyncEntries(document, entries);

    assert.equal(result.cards.find(entry => entry.id === 'a')?.interval, 30, 'the later of the two devices');
    assert.equal(result.cards.find(entry => entry.id === 'b')?.interval, 4, 'an older entry never wins');
    assert.equal(result.applied, 1);
});

test('an entry for a card the document no longer has is ignored, not resurrected', () => {
    const result = applySyncEntries([card('a')], [
        { device: 'phone', mod: NOW + 1_000, card: card('gone', { interval: 30, mod: NOW + 1_000 }) },
    ]);

    assert.deepEqual(result.cards.map(entry => entry.id), ['a']);
    assert.equal(result.orphaned, 1);
    assert.equal(result.applied, 0);
});

test('an identical entry changes nothing and does not count as applied', () => {
    const state = card('a', { interval: 7, mod: NOW });
    const result = applySyncEntries([state], [{ device: 'phone', mod: NOW, card: { ...state } }]);

    assert.equal(result.applied, 0);
    assert.equal(result.cards[0], state, 'the document card is kept by identity');
});

test('an applied entry keeps the card in the document deck', () => {
    const document = [card('a')];
    const foreign = card('a', { deckId: 'other-deck', interval: 12, mod: NOW + 1_000 });

    const result = applySyncEntries(document, [{ device: 'phone', mod: NOW + 1_000, card: foreign }]);

    assert.equal(result.cards[0].deckId, DECK_ID);
    assert.equal(result.cards[0].interval, 12);
});

// --------------------------------------------------------------- the service

/** Enough of the vault's adapter and local storage to drive the service. */
function syncPlugin(deviceId: string) {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const adapter = {
        exists: async (path: string): Promise<boolean> => files.has(path) || folders.has(path),
        read: async (path: string): Promise<string> => {
            const text = files.get(path);
            if (text === undefined) throw new Error(`no such file: ${path}`);
            return text;
        },
        write: async (path: string, data: string): Promise<void> => {
            files.set(path, data);
        },
        append: async (path: string, data: string): Promise<void> => {
            files.set(path, `${files.get(path) ?? ''}${data}`);
        },
        mkdir: async (path: string): Promise<void> => {
            folders.add(path);
        },
        list: async (path: string): Promise<{ files: string[]; folders: string[] }> => ({
            files: Array.from(files.keys()).filter(entry => entry.startsWith(`${path}/`)),
            folders: Array.from(folders).filter(entry => entry.startsWith(`${path}/`)),
        }),
        stat: async (path: string): Promise<{ size: number }> => ({ size: files.get(path)?.length ?? 0 }),
    };
    const app = {
        vault: { adapter },
        loadLocalStorage: () => deviceId,
        saveLocalStorage: () => undefined,
    };
    return { plugin: { app } as unknown as ConstructorParameters<typeof DeckSyncService>[0], files, folders };
}

test('the service writes one line per answer into this device\'s own file', async () => {
    const { plugin, files } = syncPlugin('phone');
    const service = new DeckSyncService(plugin);
    const original = bundle([card('a', { interval: 4, mod: NOW })]);

    assert.equal(service.logPath(DECK_ID), `spaceforge/sync/decks/${DECK_ID}/phone.jsonl`);
    assert.equal(service.deviceId(), 'phone');

    await service.record(original, card('a', { interval: 9, mod: NOW + 1_000 }));

    const text = files.get(service.logPath(DECK_ID)) ?? '';
    assert.equal(text.trim().split('\n').filter(Boolean).length, 1, 'one line, one answer');
    const entries = await service.read(DECK_ID);
    assert.equal(entries.entries.length, 1);
    assert.equal(entries.entries[0].device, 'phone');
    assert.deepEqual(entries.warnings, []);
});

test('a deck read through the service carries every device\'s newest answer', async () => {
    const { plugin, files } = syncPlugin('phone');
    const service = new DeckSyncService(plugin);
    const original = bundle([card('a', { interval: 4, mod: NOW })]);

    await service.record(original, card('a', { interval: 9, mod: NOW + 1_000 }));
    assert.equal((await service.mergeInto(original)).cards[0].interval, 9, 'this device\'s answer comes back');

    // The other device's file, synced into the vault later and newer still.
    files.set(
        `spaceforge/sync/decks/${DECK_ID}/desktop.jsonl`,
        encodeSyncEntry(card('a', { interval: 30, mod: NOW + 2_000 }))
    );
    assert.equal((await service.mergeInto(original)).cards[0].interval, 30, 'the newest wins across devices');
});

test('a card state line carries mod through a document round trip', () => {
    const original = bundle([card('a', { mod: NOW, interval: 6 })]);
    const text = serializeDeck(original);

    assert.match(text, /"mod":1700000000000/);

    const { bundle: parsed } = parseDeckWithWarnings(text, 'spaceforge/decks/Biology.md');
    assert.equal(parsed.cards[0].mod, NOW);
});

test('a state line without mod stays without one', () => {
    const text = serializeDeck(bundle([card('a')]));
    assert.doesNotMatch(text, /"mod"/);
    const { bundle: parsed } = parseDeckWithWarnings(text, 'spaceforge/decks/Biology.md');
    assert.equal(parsed.cards[0].mod, undefined);
});

test('rewriting a state line in place updates mod and keeps unknown keys', () => {
    const original = bundle([card('a', { mod: NOW })]);
    const text = serializeDeck(original);
    const line = text.split('\n').find(entry => entry.includes('sf-card')) ?? '';
    const withExtra = line.replace('"id"', '"zCustom":"kept","id"');

    const updated = updateCardStateLine(withExtra, card('a', { mod: NOW + 5_000, interval: 11 }), DECK_ID);

    assert.ok(updated !== null);
    assert.match(updated, /"mod":1700000005000/);
    assert.match(updated, /"ivl":11/);
    assert.match(updated, /"zCustom":"kept"/);
});

// --------------------------------------------------------------- the stamp in the package

test('a package round trip preserves each card\'s own mod instead of stamping the export time', async () => {
    const older = NOW - 30 * 86_400_000;
    const newer = NOW - 86_400_000;
    // Numeric ids: a package can only carry Anki's own ids, so a reader gets
    // those back — a hand-written "a"/"b" would be renumbered on the way out.
    const source = bundle([
        card('1700000000101', { noteId: '1700000000201', mod: older, interval: 3 }),
        card('1700000000102', { noteId: '1700000000202', mod: newer, interval: 40, due: NOW + 40 * 86_400_000 }),
    ]);

    // `now` is deliberately far ahead: the old writer stamped every row with
    // it, which is exactly the bug this test exists to keep fixed.
    const written = await writeApkg(source, { now: NOW });
    const pkg = await readApkg(written.bytes);

    const byId = new Map(pkg.cards.map(entry => [entry.id, entry]));
    assert.equal(byId.get('1700000000101')?.mod, Math.floor(older / 1000) * 1000, 'seconds precision, same instant');
    assert.equal(byId.get('1700000000102')?.mod, Math.floor(newer / 1000) * 1000);
    assert.notEqual(
        byId.get('1700000000101')?.mod,
        byId.get('1700000000102')?.mod,
        'two cards no longer share a stamp'
    );
    assert.equal(byId.get('1700000000101')?.interval, 3);
});

test('a note with no stamp of its own is stamped with the deck, so repeated pushes are stable', async () => {
    const source = bundle([card('1700000000104', { noteId: '1700000000204', mod: NOW })]);
    source.deck.modified = NOW - 86_400_000;
    source.notes[0].modified = undefined;

    const first = await readApkg((await writeApkg(source, { now: NOW })).bytes);
    const second = await readApkg((await writeApkg(source, { now: NOW + 60_000 })).bytes);

    assert.equal(first.notes[0].modified, Math.floor((NOW - 86_400_000) / 1000) * 1000);
    assert.equal(first.notes[0].modified, second.notes[0].modified, 'the same deck exports the same note stamp');
});

test('a note\'s modified stamp rides through the package too', async () => {
    const source = bundle([card('1700000000103', { noteId: '1700000000203', mod: NOW })]);
    source.notes[0].modified = NOW - 5 * 86_400_000;

    const pkg = await readApkg((await writeApkg(source, { now: NOW })).bytes);
    assert.equal(pkg.notes[0].modified, Math.floor((NOW - 5 * 86_400_000) / 1000) * 1000);
});
