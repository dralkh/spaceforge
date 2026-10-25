/**
 * The AnkiConnect bridge, driven against a scripted Anki.
 *
 * The transport is injected, so every case here is a real conversation with
 * something that answers like the add-on — `{action, version, params}` in,
 * `{result, error}` out — without a socket. What is asserted is the contract
 * that matters: which action is called with which deck, that the package is
 * read before it is deleted, and that one deck's failure does not stop the rest.
 *
 * The live path (a real Anki, a real add-on) is deliberately not claimed here:
 * it needs Anki installed, and the add-on's own file-path semantics are the one
 * thing a fake cannot prove.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../models/settings';
import { DEFAULT_DECK_OPTIONS } from '../models/anki';
import { Platform } from 'obsidian';
import { AnkiConnectService } from '../services/anki-connect-service';

const BASE = '/vault';


interface Calls {
    action: string;
    params: Record<string, unknown>;
    url: string;
}

/** An Anki that answers like the add-on, scripted per action. */
function fakeAnki(options: {
    decks?: Record<string, number>;
    version?: number;
    fail?: Record<string, string>;
    failExportDeck?: number;
    onExport?: (path: string, deckId: number) => void;
    /** The cards Anki holds, as `cardsInfo` would report them. */
    cards?: Array<{ cardId: number; type: number; queue: number; due: number; factor?: number }>;
    /** The collection's `crt`, in seconds: the frame its day numbers live in. */
    crt?: number;
    /** How many days Anki's own "today" lags the machine's (its rollover hour). */
    rolloverSkew?: number;
    /** A build without `setDueDate`, like the older add-on. */
    noSetDueDate?: boolean;
    /** A build that also refuses the `due` column, like the maintained one. */
    noDueColumn?: boolean;
}) {
    const calls: Calls[] = [];
    const cards = (options.cards ?? []).map(card => ({ factor: 2500, ...card }));
    const crtDay = options.crt === undefined ? null : Math.floor(options.crt / 86_400);
    /** What `setDueDate` did to a card, as Anki would now report its `due`. */
    const moved = new Map<number, number>();
    const answer = (body: unknown): unknown => {
        const request = body as { action: string; params: Record<string, unknown> };
        calls.push({ action: request.action, params: request.params, url: '' });
        const failure = options.fail?.[request.action];
        if (failure !== undefined) return { result: null, error: failure };
        switch (request.action) {
            case 'apiReflect': {
                // The action list the real add-on publishes; `setDueDate` is only
                // there on a fork that adds it.
                const actions = ['version', 'deckNamesAndIds', 'getMediaDirPath', 'findCards', 'cardsInfo',
                    'exportPackage', 'importPackage', 'setEaseFactors', 'setSpecificValueOfCard', 'answerCards'];
                if (!options.noSetDueDate) actions.push('setDueDate');
                if (options.noDueColumn) actions.splice(actions.indexOf('setSpecificValueOfCard'), 1);
                return { result: { scopes: ['actions'], actions }, error: null };
            }
            case 'version':
                return { result: options.version ?? 6, error: null };
            case 'getMediaDirPath':
                return { result: '/home/reader/.local/share/Anki2/User 1/collection.media', error: null };
            case 'deckNamesAndIds':
                return { result: options.decks ?? {}, error: null };
            case 'findCards':
                return { result: cards.map(card => card.cardId), error: null };
            case 'cardsInfo':
                return {
                    result: cards.map(card => ({
                        ...card,
                        due: moved.get(card.cardId) ?? card.due,
                    })),
                    error: null,
                };
            case 'setSpecificValueOfCard': {
                if (options.noDueColumn) return { result: null, error: 'use native scheduling commands for protected state' };
                const key = (request.params.keys as string[])[0];
                if (key !== 'due') return { result: false, error: null };
                const value = Number((request.params.newValues as unknown[])[0]);
                moved.set(Number(request.params.card), crtDay === null ? value : value);
                return { result: [true], error: null };
            }
            case 'setDueDate': {
                if (options.noSetDueDate) return { result: null, error: 'unsupported action' };
                // Anki's own scheduler: `today + days`, counted in its own frame.
                const todayOnAnki = Math.floor(Date.now() / 86_400_000) - (options.rolloverSkew ?? 0);
                for (const id of request.params.cards as number[]) {
                    const days = Number(request.params.days);
                    moved.set(id, crtDay === null ? days : todayOnAnki + days - crtDay);
                }
                return { result: true, error: null };
            }
            case 'setEaseFactors':
                return { result: (request.params.cards as number[]).map(() => true), error: null };
            case 'exportPackage': {
                const path = String(request.params.path);
                const deckId = request.params.deckId !== undefined
                    ? Number(request.params.deckId)
                    : (options.decks ?? {})[String(request.params.deck)];
                if (deckId === undefined) return { result: null, error: 'bad argument type' };
                if (options.failExportDeck === deckId) return { result: null, error: 'deck was not found' };
                options.onExport?.(path, deckId);
                return { result: null, error: null };
            }
            case 'importPackage':
                return { result: null, error: null };
            default:
                return { result: null, error: `unsupported action: ${request.action}` };
        }
    };
    const post = async (url: string, body: unknown): Promise<unknown> => {
        const result = answer(body);
        calls[calls.length - 1].url = url;
        return result;
    };
    return {
        post,
        calls,
        /** Where a card's `due` now sits, as Anki would report it. */
        dueOf: (cardId: number) => moved.get(cardId) ?? cards.find(card => card.cardId === cardId)?.due ?? null,
    };
}

/** A vault adapter over a map, with the desktop's absolute base path. */
function fakeVault() {
    const files = new Map<string, ArrayBuffer>();
    const folders = new Set<string>();
    // The adapter speaks vault-relative paths; Anki is given absolute ones.
    // On a real disk those are the same file, so the fake folds them together.
    const key = (path: string): string => (path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1) : path);
    const adapter = {
        getBasePath: () => BASE,
        exists: async (path: string): Promise<boolean> => files.has(key(path)) || folders.has(key(path)),
        mkdir: async (path: string): Promise<void> => {
            folders.add(key(path));
        },
        readBinary: async (path: string): Promise<ArrayBuffer> => {
            const bytes = files.get(key(path));
            if (!bytes) throw new Error(`no such file: ${path}`);
            return bytes;
        },
        writeBinary: async (path: string, bytes: ArrayBuffer): Promise<void> => {
            files.set(key(path), bytes);
        },
        remove: async (path: string): Promise<void> => {
            files.delete(key(path));
        },
    };
    return {
        adapter,
        files,
        folders,
        /** Write as Anki would: at the absolute path, folded onto the same file. */
        put: (path: string, bytes: ArrayBuffer): void => {
            files.set(key(path), bytes);
        },
    };
}

function makePlugin(options: {
    decks: { path: string; name: string; id: string }[];
    files?: Map<string, ArrayBuffer>;
    sitting?: boolean;
    enabled?: boolean;
    bundle?: Record<string, unknown>;
    /** The `crt` the pulled package carried, as Anki exports it. */
    pulledCrt?: number;
}) {
    const vault = fakeVault();
    if (options.files) for (const [path, bytes] of options.files) vault.files.set(path, bytes);
    const imported: { bytes: number; name?: string }[] = [];
    let saved = 0;
    const exported: string[] = [];
    const plugin = {
        settings: { ...DEFAULT_SETTINGS, ankiConnectEnabled: options.enabled ?? true },
        app: { vault: { adapter: vault.adapter } },
        deckStore: {
            listDecks: async () => options.decks,
            readDeck: async (path: string) => options.bundle ?? {
                deck: { id: options.decks[0]?.id ?? '', name: options.decks[0]?.name ?? '', modified: 0, options: DEFAULT_DECK_OPTIONS },
                notes: [],
                cards: [],
                media: [],
                extra: { crt: 1 },
                path,
            },
        },
        deckService: {
            importApkg: async (bytes: Uint8Array, settings?: { name?: string }) => {
                imported.push({ bytes: bytes.length, name: settings?.name });
                return {
                    deckPath: options.decks[0]?.path ?? '',
                    deckName: settings?.name ?? '',
                    notesImported: 0,
                    cardsImported: 0,
                    mediaImported: 0,
                    missingMedia: [],
                    warnings: [],
                    replaced: true,
                    crt: options.pulledCrt,
                };
            },
            exportDeck: async (path: string) => {
                exported.push(path);
                return { bytes: new Uint8Array([1, 2, 3, 4]), report: { path: `${path}.apkg`, notes: 0, cards: 0, media: 0, bytes: 4 }, warnings: [] };
            },
        },
        deckSessionController: { isActive: () => options.sitting ?? false },
        savePluginData: async () => { saved += 1; },
    };
    return {
        plugin: plugin as unknown as ConstructorParameters<typeof AnkiConnectService>[0],
        vault,
        imported,
        exported,
        saves: () => saved,
    };
}

const ONE_DECK = [{ path: 'spaceforge/decks/Biology.md', name: 'Biology', id: '1700000000000' }];

// --------------------------------------------------------------- status

test('status reports the add-on it found and the media folder', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({ version: 6 });
    const service = new AnkiConnectService(plugin, anki.post);

    const status = await service.status();

    assert.equal(status.reachable, true);
    assert.equal(status.version, 6);
    assert.match(String(status.mediaPath), /collection\.media$/);
});

test('a refused connection is reported, not thrown', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    const service = new AnkiConnectService(plugin, async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
    });

    const status = await service.status();

    assert.equal(status.reachable, false);
    assert.match(String(status.error), /ECONNREFUSED/);

    const summary = await service.syncAll();
    assert.equal(summary.ok, false);
    assert.match(summary.message, /Anki is not answering at http:\/\/127\.0\.0\.1:8765/);
    assert.match(summary.message, /ECONNREFUSED/, 'and says what the connection said');
});

test('an add-on that answers with an error is a failure, not a result', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({ fail: { deckNamesAndIds: 'collection is not open' } });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, false);
    assert.match(summary.errors[0], /collection is not open/);
});

// --------------------------------------------------------------- syncing

test('a deck Anki has is pulled, merged and pushed back, and the files are cleaned up', async () => {
    const { plugin, vault, imported, exported } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({
        decks: { Biology: 1234 },
        onExport: (path) => {
            // Anki writes the package itself, on disk, at the path it was given.
            vault.put(path, new Uint8Array([9, 9, 9]).buffer);
        },
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.decks[0], {
        path: ONE_DECK[0].path,
        name: 'Biology',
        pulled: true,
        pushed: true,
        fresh: false,
        note: null,
    });
    assert.equal(imported.length, 1, 'the package Anki exported was imported');
    assert.equal(imported[0].bytes, 3);
    assert.deepEqual(exported, [ONE_DECK[0].path], 'the merged deck was written back out');

    const exportCall = anki.calls.find(call => call.action === 'exportPackage');
    assert.equal(exportCall?.params.deck, 'Biology', 'pulled by the name Anki knows the deck by');
    assert.match(String(exportCall?.params.path), /^\/vault\/spaceforge\/sync\/anki\//, 'through an absolute path Anki can write');
    const importCall = anki.calls.find(call => call.action === 'importPackage');
    assert.match(String(importCall?.params.path), /-out\.apkg$/);

    assert.deepEqual([...vault.files.keys()], [], 'neither hand-off package is left behind');
    assert.match(summary.message, /^Anki: 1 of 1 deck pulled, 1 pushed\.$/);
});

test('a deck Anki does not have yet is pushed, not an error', async () => {
    const { plugin, imported } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({ decks: {} });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, true);
    assert.equal(summary.decks[0].pulled, false);
    assert.equal(summary.decks[0].pushed, true);
    assert.equal(summary.decks[0].fresh, true);
    assert.equal(summary.decks[0].note, 'new to Anki');
    assert.equal(imported.length, 0);
    assert.equal(anki.calls.some(call => call.action === 'exportPackage'), false);
    assert.match(summary.message, /1 new to Anki/);
});

test('a deck is matched by its id when the name has changed on either side', async () => {
    const deck = [{ path: 'spaceforge/decks/Renamed.md', name: 'Renamed', id: '1700000000000' }];
    const { plugin, vault } = makePlugin({ decks: deck });
    const anki = fakeAnki({
        decks: { 'Old name': 1700000000000 },
        onExport: path => vault.put(path, new Uint8Array([7]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    await service.syncAll();

    const exportCall = anki.calls.find(call => call.action === 'exportPackage');
    assert.equal(exportCall?.params.deck, 'Old name', 'the name Anki has, not the vault’s');
});

test('one deck failing does not stop the others, and the failure is named', async () => {
    const decks = [
        { path: 'spaceforge/decks/Bad.md', name: 'Bad', id: '1' },
        { path: 'spaceforge/decks/Good.md', name: 'Good', id: '2' },
    ];
    const { plugin, vault } = makePlugin({ decks });
    const anki = fakeAnki({
        decks: { Bad: 11, Good: 22 },
        failExportDeck: 11,
        onExport: path => vault.put(path, new Uint8Array([7]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, false);
    assert.equal(summary.decks.length, 2);
    assert.equal(summary.decks[0].pulled, false, 'the failed deck was not pulled');
    assert.equal(summary.decks[0].pushed, true, 'but its package still went to Anki');
    assert.equal(summary.decks[1].pulled, true, 'the other deck was unaffected');
    assert.equal(summary.decks[1].pushed, true);
    assert.match(summary.errors[0], /^Bad: deck was not found/);
    assert.match(summary.message, /Bad: deck was not found/);
});

test('a second sync while one is running is refused, not interleaved', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const anki = fakeAnki({ decks: {} });
    const service = new AnkiConnectService(plugin, async (url, body) => {
        await gate;
        return anki.post(url, body);
    });

    const first = service.syncAll();
    const second = await service.syncAll();
    assert.match(second.errors[0], /already running/);
    release?.();
    assert.equal((await first).ok, true);
});

// --------------------------------------------------------------- the setting

test('the timer does nothing while the setting is off or a sitting is running', async () => {
    const off = makePlugin({ decks: ONE_DECK, enabled: false });
    const offAnki = fakeAnki({ decks: {} });
    assert.equal(await new AnkiConnectService(off.plugin, offAnki.post).syncIfEnabled(), null);
    assert.equal(offAnki.calls.length, 0, 'a switched-off bridge never dials');

    const busy = makePlugin({ decks: ONE_DECK, sitting: true });
    const busyAnki = fakeAnki({ decks: {} });
    assert.equal(await new AnkiConnectService(busy.plugin, busyAnki.post).syncIfEnabled(), null);
    assert.equal(busyAnki.calls.length, 0, 'a background merge never moves the queue under a sitting');
});

test('the timer is a whole sync when nothing holds it back', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({ decks: {} });
    const summary = await new AnkiConnectService(plugin, anki.post).syncIfEnabled();

    assert.ok(summary !== null);
    assert.equal(summary.ok, true);
    assert.ok(anki.calls.some(call => call.action === 'importPackage'));
});

// --------------------------------------------------------- schedule carry

/** A deck mid-flight: one card the vault moved, one both sides agree on. */
function carriedBundle() {
    const deck = { id: '1700000000000', name: 'Biology', modified: 1, options: DEFAULT_DECK_OPTIONS };
    const card = (id: string, type: number, queue: number, due: number, easeFactor = 2500) => ({
        id,
        noteId: '1700000000001',
        deckId: deck.id,
        ord: 0,
        type,
        queue,
        interval: 5,
        easeFactor,
        reviews: 3,
        lapses: 0,
        due,
        newPosition: null,
        flag: 0,
    });
    return {
        deck,
        notes: [],
        media: [],
        // The deck counts from 1789628529, so a day number is that day + due.
        extra: { crt: 1789628529 },
        cards: [
            card('11', 2, 2, 36),   // the vault reviewed it: due on day 20749
            card('12', 2, 2, 33),   // untouched: due on day 20746, as Anki has it
            card('13', 1, 1, 4000), // a learning step: Anki's own business
        ],
    };
}

test('a due date the vault moved is carried to Anki, and the rest is left alone', async () => {
    const bundle = carriedBundle();
    // Anki's collection was created 33 days after the deck's, so Anki's day 0 is
    // the vault's day 20746; card 12 sits there on both sides.
    const anki = fakeAnki({
        decks: { Biology: 1700000000000 },
        crt: 1789628529 + 33 * 86400,
        cards: [
            { cardId: 11, type: 2, queue: 2, due: 0 },
            { cardId: 12, type: 2, queue: 2, due: 0 },
            { cardId: 13, type: 1, queue: 1, due: 3 },
        ],
        onExport: path => vault.put(path, new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const { plugin, vault } = makePlugin({
        decks: ONE_DECK,
        bundle,
        pulledCrt: 1789628529 + 33 * 86400,
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, true, summary.message);
    const dueDates = anki.calls.filter(call => call.action === 'setDueDate');
    assert.equal(dueDates.length, 1, 'one day, one call');
    assert.deepEqual(dueDates[0].params.cards, [11]);
    assert.equal(
        dueDates[0].params.days,
        String(20749 - Math.floor(Date.now() / 86_400_000)),
        'a day count from today, which is the form this add-on accepts'
    );
    assert.equal(
        anki.calls.some(call => call.action === 'setEaseFactors'),
        false,
        'the ease factors already agree'
    );
    assert.deepEqual(
        summary.decks[0].note,
        '1 due date carried',
        'the reader is told what moved'
    );
});

test('a batch pushed before Anki’s rollover is corrected, not left a day out', async () => {
    // Built from today rather than pinned to a date: the correction is measured
    // in days from *today*, and a fixed calendar turns this into a test that
    // passes until the month ends.
    const today = Math.floor(Date.now() / 86_400_000);
    const deckCrt = 1789628529;
    const deckDay = Math.floor(deckCrt / 86_400);
    const deck = { id: '1700000000000', name: 'Biology', modified: 1, options: DEFAULT_DECK_OPTIONS };
    const card = (id: string, due: number) => ({
        id, noteId: '1700000000001', deckId: deck.id, ord: 0, type: 2, queue: 2,
        interval: 5, easeFactor: 2500, reviews: 3, lapses: 0, due, newPosition: null, flag: 0,
    });
    const bundle = {
        deck, notes: [], media: [],
        extra: { crt: deckCrt },
        cards: [
            card('11', today + 3 - deckDay), // the vault moved this one: it wants today + 3
            card('12', today - deckDay),     // both sides already agree on today
        ],
    };
    const ankiCrt = today * 86_400;
    const { plugin, vault } = makePlugin({ decks: ONE_DECK, bundle, pulledCrt: ankiCrt });
    // Anki's own "today" is still yesterday's: the reader is up before 4am.
    const anki = fakeAnki({
        decks: { Biology: 1700000000000 },
        crt: ankiCrt,
        rolloverSkew: 1,
        cards: [
            { cardId: 11, type: 2, queue: 2, due: 0 },
            { cardId: 12, type: 2, queue: 2, due: 0 },
        ],
        onExport: path => vault.put(path, new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    await service.syncAll();

    const pushes = anki.calls.filter(call => call.action === 'setDueDate');
    assert.equal(pushes.length, 2, 'the batch went, was read back, and went again');
    assert.equal(pushes[0].params.days, '3');
    assert.equal(pushes[1].params.days, '4', 'one day later, to land on the day the vault meant');
    assert.equal(anki.dueOf(11), 3, 'three days from the collection’s own day 0');
});

test('a phone leaves Anki alone', async () => {
    const { plugin } = makePlugin({ decks: ONE_DECK });
    const anki = fakeAnki({ decks: { Biology: 1700000000000 } });
    const service = new AnkiConnectService(plugin, anki.post);
    const platform = Platform as unknown as { isDesktop: boolean };
    platform.isDesktop = false;
    try {
        const summary = await service.syncAll();
        assert.equal(summary.ok, false);
        assert.match(summary.errors[0], /desktop/i);
        assert.equal(anki.calls.length, 0, 'not one packet');
        const status = await service.status();
        assert.equal(status.reachable, false);
        assert.match(status.error ?? '', /phone/i);
    } finally {
        platform.isDesktop = true;
    }
});

test('an add-on without setDueDate writes the due column instead', async () => {
    const bundle = carriedBundle();
    const crt = 1789628529 + 33 * 86400;
    const { plugin, vault } = makePlugin({ decks: ONE_DECK, bundle, pulledCrt: crt });
    const anki = fakeAnki({
        decks: { Biology: 1700000000000 },
        crt,
        noSetDueDate: true,
        cards: [
            { cardId: 11, type: 2, queue: 2, due: 0 },
            { cardId: 12, type: 2, queue: 2, due: 0 },
            { cardId: 13, type: 1, queue: 1, due: 3 },
        ],
        onExport: path => vault.put(path, new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.equal(summary.ok, true, summary.message);
    assert.equal(anki.calls.some(call => call.action === 'apiReflect'), true, 'the add-on was asked what it can do');
    assert.equal(anki.calls.some(call => call.action === 'setDueDate'), false, 'and a door it does not have is not tried');
    const writes = anki.calls.filter(call => call.action === 'setSpecificValueOfCard');
    assert.equal(writes.length, 1, 'one card needed moving');
    assert.deepEqual(writes[0].params.keys, ['due']);
    // The column is a day number in Anki's frame: day 20749 was asked for.
    assert.deepEqual(writes[0].params.newValues, [3]);
    assert.equal(anki.dueOf(11), 3, 'and it landed on that day');
});

test('when the add-on cannot set a due date, the reader is told instead of guessing', async () => {
    const bundle = carriedBundle();
    const crt = 1789628529 + 33 * 86400;
    const { plugin, vault } = makePlugin({ decks: ONE_DECK, bundle, pulledCrt: crt });
    const anki = fakeAnki({
        decks: { Biology: 1700000000000 },
        crt,
        noSetDueDate: true,
        noDueColumn: true,
        cards: [
            { cardId: 11, type: 2, queue: 2, due: 0 },
            { cardId: 12, type: 2, queue: 2, due: 0 },
        ],
        onExport: path => vault.put(path, new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const summary = await service.syncAll();

    assert.match(summary.decks[0].note ?? '', /cannot set due dates|protected state/i);
    assert.equal(summary.ok, true, 'the content still went: this is a limitation, not a failure');
});

// ------------------------------------------------------------- big decks

test('a deck of thousands of cards goes over in slices, and an unchanged deck is not sent again', async () => {
    const deck = { id: '1700000000000', name: 'Biology', modified: 1792300000000, options: DEFAULT_DECK_OPTIONS };
    const note = {
        id: '1700000000001',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['a', 'b'],
        tags: [],
        cardIds: [],
        mediaFiles: [],
    };
    const cards = Array.from({ length: 1200 }, (_, index) => ({
        id: String(1792300001000 + index),
        noteId: note.id,
        deckId: deck.id,
        ord: 0,
        type: 2,
        queue: 2,
        interval: 3,
        easeFactor: 2500,
        reviews: 1,
        lapses: 0,
        due: 30,
        newPosition: null,
        flag: 0,
    }));
    const bundle = { deck, notes: [note], cards, media: [], extra: { crt: 1789628529 } };
    const { plugin, vault } = makePlugin({ decks: ONE_DECK, bundle, pulledCrt: 1789628529 });
    const anki = fakeAnki({
        decks: { Biology: 1700000000000 },
        crt: 1789628529,
        cards: cards.map(card => ({ cardId: Number(card.id), type: 2, queue: 2, due: card.due })),
        onExport: path => vault.put(path, new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const service = new AnkiConnectService(plugin, anki.post);

    const packages = (): number => anki.calls.filter(call => call.action === 'importPackage').length;

    await service.syncAll();
    assert.equal(packages(), 3, '1200 cards go over in packages of 500');
    assert.equal(plugin.settings.ankiPushed[ONE_DECK[0].path], deck.modified, 'the revision was noted');

    const before = packages();
    await service.syncAll();
    assert.equal(packages(), before, 'a deck that has not changed since is not sent again');
});
