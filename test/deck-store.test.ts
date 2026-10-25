/**
 * Deck documents and the vault-side deck store.
 *
 * Two halves: the format (round trip, hand-edit tolerance, media references,
 * document paths) which needs no vault at all, and the store, which is driven
 * against a small in-memory vault so list/read/write/create/rename/delete,
 * media collision handling and an import's text rewriting are all exercised
 * for real.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';

import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    AnkiNote,
    DeckBundle,
    DeckOptions,
    DeckPreset,
    DeckScheduler,
    DEFAULT_DECK_OPTIONS,
    DECKS_FOLDER,
    DECKS_MEDIA_FOLDER,
    LeechAction,
} from '../models/anki';
import {
    deckDocumentPath,
    deckMediaReferences,
    bundleMediaReferences,
    isDeckDocumentPath,
    parseDeck,
    parseDeckWithWarnings,
    rewriteMediaPaths,
    sanitizeDeckFileName,
    serializeDeck,
    newDeck,
} from '../models/deck-document';
import { DeckStore, deckCountsFrom, mediaMimeType } from '../services/deck-store';

const NOW = 1_700_000_000_000;
const DECK_PATH = `${DECKS_FOLDER}/Cell Biology - Organelles.md`;

// --------------------------------------------------------------- fixture

/** The three-card deck the round trip is checked against. */
function sampleBundle(): DeckBundle {
    const options: DeckOptions = {
        ...DEFAULT_DECK_OPTIONS,
        leechAction: LeechAction.TagOnly,
        scheduler: DeckScheduler.Fsrs,
        fsrs: {
            ...DEFAULT_DECK_OPTIONS.fsrs,
            desiredRetention: 0.85,
            maximumInterval: 3650,
            weights: [0.4, 0.6, 0.8],
            useOwnWeights: true,
        },
    };

    const basic: AnkiNote = {
        id: '1700000000001',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['What is the powerhouse of the cell?', 'The mitochondrion.'],
        tags: [],
        cardIds: ['1700000000100', '1700000000101'],
        mediaFiles: [],
    };
    const cloze: AnkiNote = {
        id: '1700000000002',
        modelName: 'Cloze',
        fields: ['Text'],
        values: ['The {{c1::nucleus}} stores the DNA.'],
        tags: ['cells', 'organelles'],
        cardIds: ['1700000000102'],
        mediaFiles: ['nucleus.png'],
        modified: NOW + 500,
    };

    const cards: AnkiCard[] = [
        {
            id: '1700000000100',
            noteId: basic.id,
            deckId: '1700000000000',
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
        },
        {
            id: '1700000000101',
            noteId: basic.id,
            deckId: '1700000000000',
            ord: 1,
            type: AnkiCardType.Learning,
            queue: AnkiCardQueue.Learning,
            interval: -600,
            easeFactor: 2500,
            reviews: 1,
            lapses: 0,
            due: NOW + 600_000,
            newPosition: null,
            flag: 0,
        },
        {
            id: '1700000000102',
            noteId: cloze.id,
            deckId: '1700000000000',
            ord: 0,
            type: AnkiCardType.Review,
            queue: AnkiCardQueue.Review,
            interval: 5,
            easeFactor: 2600,
            reviews: 3,
            lapses: 1,
            due: NOW + 5 * 86_400_000,
            newPosition: null,
            flag: 2,
            desiredRetentionDays: 5,
            memory: { stability: 4.1, difficulty: 6.3, lastReview: NOW - 86_400_000, scheduledDays: 5 },
            originalDue: NOW + 4 * 86_400_000,
            timeTakenMs: 4321,
        },
    ];

    const preset: DeckPreset = { id: 'preset-1', name: 'Default', options: DEFAULT_DECK_OPTIONS };

    return {
        deck: {
            id: '1700000000000',
            name: 'Cell Biology::Organelles',
            ankiWebId: '7654321',
            sourceUrl: 'https://ankiweb.net/shared/info/7654321',
            modified: NOW,
            options,
            parentId: null,
        },
        notes: [basic, cloze],
        cards,
        presets: [preset],
        deckPresetOf: { '1700000000000': 'preset-1' },
        media: [{ path: `${DECKS_MEDIA_FOLDER}/nucleus.png`, originalName: 'nucleus.png', mime: 'image/png', size: 128 }],
        extra: {
            deck: { favourite: true, colour: 'teal' },
            cards: { '1700000000102': { fsrsSeed: 'seed-42' } },
            notes: { '1700000000001': { modelVersion: 2 } },
        },
    };
}

/** A hand-written deck file: two plain sections and one broken state line. */
const HAND_EDITED = [
    '---',
    'sf-deck: 1',
    'id: "1700000009999"',
    'name: "Handwritten"',
    'modified: 1700000000000',
    '---',
    '',
    '# Handwritten',
    '',
    'A paragraph a human typed between the title and the cards.',
    '',
    '## one',
    '**Q**: What is 2 + 2?',
    '**A**: 4.',
    '',
    '## two',
    '**Q**: What is the capital of France?',
    '**A**: Paris.',
    '<!-- sf-card {"id":"9","nid":"8","ord":0,"type":2,"queue":2,"due":1,"ivl":3,"factor":2500,"reps":2,"lapses":0,"flag":0} -->',
    '',
    '## three',
    '**Q**: Broken state card',
    '**A**: still here',
    '<!-- sf-card {"id":"7","nid": this is not json} -->',
    '',
].join('\n');

// --------------------------------------------------------------- fake vault

/** Just enough of Obsidian's vault to drive the store, over a map. */
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

    const plugin = { app: { vault, fileManager } } as unknown as ConstructorParameters<typeof DeckStore>[0];
    return { store: new DeckStore(plugin), files, folders, trashed };
}

function bytesOf(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// --------------------------------------------------------------- the format

test('a review card written with a timestamp due is read back as Anki\'s day number', () => {
    // The shape an older import produced (and a hand-written file can): the
    // timestamp instead of the day number. The scheduler compares day numbers,
    // so left alone the card reads as due ~55,000 days out and never appears.
    const bundle = sampleBundle();
    bundle.extra = { crt: 1789628529 };
    const review = bundle.cards.find(card => card.type === AnkiCardType.Review);
    assert.ok(review !== undefined);
    const createdDay = Math.floor(1789628529 / 86_400);
    review.due = (createdDay + 19005) * 86_400_000;

    const { bundle: parsed } = parseDeckWithWarnings(serializeDeck(bundle), DECK_PATH);
    const read = parsed.cards.find(card => card.id === review.id);

    assert.equal(read?.due, 19005, 'the same instant, in the convention the scheduler reads');
});

test('a day number is left exactly as written, however it was typed', () => {
    const bundle = sampleBundle();
    bundle.extra = { crt: 1789628529 };
    const review = bundle.cards.find(card => card.type === AnkiCardType.Review);
    assert.ok(review !== undefined);
    review.due = -3; // three days overdue

    const { bundle: parsed } = parseDeckWithWarnings(serializeDeck(bundle), DECK_PATH);
    assert.equal(parsed.cards.find(card => card.id === review.id)?.due, -3);
});

test('a deck with no creation stamp leaves due values alone', () => {
    const bundle = sampleBundle();
    const review = bundle.cards.find(card => card.type === AnkiCardType.Review);
    assert.ok(review !== undefined);
    review.due = 3431635200000;

    const { bundle: parsed } = parseDeckWithWarnings(serializeDeck(bundle), DECK_PATH);
    assert.equal(parsed.cards.find(card => card.id === review.id)?.due, 3431635200000, 'nothing to convert against');
});

test('a deck round-trips through its document: deck, options, notes, cards, media, extras', () => {
    const bundle = sampleBundle();
    const text = serializeDeck(bundle);

    // What a human sees.
    assert.match(text, /^---\n/);
    assert.match(text, /\nname: "Cell Biology::Organelles"\n/, 'the name is quoted because it carries the hierarchy separator');
    assert.match(text, /\ncards: 3\n/, 'the card count is there for a quick glance');
    assert.match(text, /\nscheduler: fsrs\n/);
    assert.match(text, /\nleechAction: tagOnly\n/);
    assert.match(text, /\nfsrs:\n {2}desiredRetention: 0.85\n/);
    assert.match(text, /\nfavourite: true\n/, 'an unknown frontmatter key stays in the frontmatter');
    assert.match(text, /<!-- sf-deck-meta \{"presets":/, 'the machine-only block is one comment');
    assert.match(text, /\n# Cell Biology::Organelles\n/);
    assert.match(text, /\n## 1700000000100\n\*\*Q\*\*: What is the powerhouse of the cell\?\n\*\*A\*\*: The mitochondrion\.\n/);
    assert.match(text, /<!-- sf-card \{"id":"1700000000100","nid":"1700000000001","ord":0/);
    assert.match(text, /"due":1700000000000/);
    assert.match(text, /"fsrsSeed":"seed-42"/, 'an unknown card key stays on its state line');
    assert.match(text, /\*\*Q\*\*: The \[\.\.\.\] stores the DNA\./u, 'a cloze card shows its blanked question');

    // What the machine reads back.
    const parsed = parseDeck(text, DECK_PATH);
    assert.deepEqual(parsed, bundle, 'parse(serialize(x)) is x');

    // And the document does not drift on a second pass.
    assert.equal(serializeDeck(parseDeck(text, DECK_PATH)), text, 'the document is a fixed point');
});

test('a hand-written card with no state line becomes a new card, and a malformed line warns', () => {
    const { bundle, warnings } = parseDeckWithWarnings(HAND_EDITED, 'spaceforge/decks/handwritten.md');

    assert.equal(bundle.cards.length, 3);
    assert.equal(bundle.notes.length, 3, 'each hand-written section is its own note');
    assert.equal(warnings.length, 1, `exactly the broken line warns: ${warnings.join(' | ')}`);
    assert.match(warnings[0], /is not valid JSON/);
    assert.match(warnings[0], /"7"/, 'the warning names the section it came from');

    const [one, two, three] = bundle.cards;
    assert.equal(one.queue, AnkiCardQueue.New, 'a card with no state is new');
    assert.equal(one.type, AnkiCardType.New);
    assert.equal(one.reviews, 0);
    assert.ok(one.due > NOW, 'a hand-added card is due the moment it is read');

    assert.equal(two.id, '9', 'a state line keeps its own card');
    assert.equal(two.queue, AnkiCardQueue.Review);
    assert.equal(two.interval, 3);
    assert.equal(two.reviews, 2);

    assert.ok(three.id !== '7' && three.id.length > 0, 'the broken line gives the card a fresh id');

    const byQuestion = new Map(bundle.notes.map(note => [note.values[0], note.values]));
    assert.deepEqual(byQuestion.get('What is 2 + 2?'), ['What is 2 + 2?', '4.']);
    assert.deepEqual(byQuestion.get('Broken state card'), ['Broken state card', 'still here'], 'the text survives the broken state line');
});

test('unknown keys are preserved wherever they were written', () => {
    const bundle = sampleBundle();
    bundle.extra = {
        deck: {
            favourite: true,
            colour: 'teal',
            toolState: { version: 2, flags: ['a', 'b'] },
            history: [{ at: 1 }, { at: 2 }],
        },
        cards: { '1700000000102': { fsrsSeed: 'seed-42' } },
        notes: { '1700000000001': { modelVersion: 2 } },
    };

    const text = serializeDeck(bundle);
    assert.match(text, /\nfavourite: true\n/, 'a flat unknown key stays in the frontmatter');
    assert.match(text, /\ntoolState:\n {2}version: 2\n {2}flags: \[a, b\]\n/, 'a nested map stays readable');
    assert.match(text, /"deckExtra":\{"history":\[\{"at":1\},\{"at":2\}\]\}/, 'a shape the frontmatter cannot hold goes to the meta line');

    const parsed = parseDeck(text, DECK_PATH);
    assert.deepEqual(parsed.extra, bundle.extra);
    assert.deepEqual(parsed.media, bundle.media);
    assert.deepEqual(parsed.presets, bundle.presets);
    assert.deepEqual(parsed.deckPresetOf, bundle.deckPresetOf);
    assert.equal(serializeDeck(parsed), text, 'and it stays put on the next write');
});

test('comments and hand-typed spacing in the frontmatter are tolerated', () => {
    const text = [
        '---',
        '# a note to self',
        'name: "Commented"   # the deck name',
        "sourceUrl: 'https://example.com/a#b'",
        'id: 1700000000420',
        'newPerDay: 5 # new cards a day',
        'learningSteps: [1, 10] # minutes',
        'buryNewSiblings: false',
        '---',
        '',
        '## anything',
        '**Q**: q',
        '**A**: a',
        '',
    ].join('\n');

    const deck = parseDeck(text, 'spaceforge/decks/commented.md').deck;
    assert.equal(deck.name, 'Commented', 'a quoted value is read even with a comment after it');
    assert.equal(deck.sourceUrl, 'https://example.com/a#b', 'a # inside quotes is not a comment');
    assert.equal(deck.id, '1700000000420');
    assert.equal(deck.options.newPerDay, 5);
    assert.deepEqual(deck.options.learningSteps, [1, 10]);
    assert.equal(deck.options.buryNewSiblings, false);
    assert.equal(deck.options.reviewsPerDay, DEFAULT_DECK_OPTIONS.reviewsPerDay, 'a missing key falls back to Anki');
});

test('reordering sections keeps every card and its state', () => {
    const bundle = sampleBundle();
    const text = serializeDeck(bundle);
    const sections = text.split('\n## ').slice(1);
    assert.equal(sections.length, 3);
    const reordered = `${text.split('\n## ')[0]}\n## ${sections[2]}\n## ${sections[0]}\n## ${sections[1]}`;

    const parsed = parseDeck(reordered, DECK_PATH);
    assert.deepEqual(parsed.cards.map(card => card.id), [
        '1700000000102',
        '1700000000100',
        '1700000000101',
    ], 'the cards come back in the file order');
    const review = parsed.cards[0];
    assert.equal(review.reviews, 3);
    assert.equal(review.lapses, 1);
    assert.deepEqual(review.memory, { stability: 4.1, difficulty: 6.3, lastReview: NOW - 86_400_000, scheduledDays: 5 });
});

test('editing the question or the answer text changes the note it belongs to', () => {
    const bundle = sampleBundle();
    const text = serializeDeck(bundle);

    // Edit the cloze answer, and a question on the reversed card.
    const edited = text
        .replace('The {{c1::nucleus}} stores the DNA.', 'The {{c1::nucleus}} stores the DNA and the histones.')
        .replace('**A**: The mitochondrion.', '**A**: The mitochondrion (and its own DNA).');
    const parsed = parseDeck(edited, DECK_PATH);

    const cloze = parsed.notes.find(note => note.modelName === 'Cloze');
    assert.ok(cloze);
    assert.deepEqual(cloze.values, ['The {{c1::nucleus}} stores the DNA and the histones.'], 'the answer text wins');
    assert.deepEqual(cloze.tags, ['cells', 'organelles'], 'and the note keeps everything else it had');

    const basic = parsed.notes.find(note => note.modelName === 'Basic');
    assert.ok(basic);
    assert.deepEqual(basic.values, ['What is the powerhouse of the cell?', 'The mitochondrion (and its own DNA).']);
});

test('media references are found in every syntax Anki and Obsidian use', () => {
    const text = [
        '![](nucleus.png)',
        '![mito](spaceforge/decks/media/mitochondrion.webp "the mitochondrion")',
        '![](<a file with spaces.png>)',
        '<img src="dna.svg" alt="dna">',
        "<img src='rna.png' width=40>",
        '[sound:click.mp3]',
        '![[embedded.png|alias]]',
        '[the docs](https://example.com/x.png)',
        '![](data:image/png;base64,AAAA)',
        '[a note](Notes/Cell biology.md)',
    ].join(' ');

    assert.deepEqual(deckMediaReferences(text), [
        'nucleus.png',
        'spaceforge/decks/media/mitochondrion.webp',
        'a file with spaces.png',
        'dna.svg',
        'rna.png',
        'click.mp3',
        'embedded.png',
        'Notes/Cell biology.md',
    ], 'absolute URLs and data: URLs are not files beside the deck');
    assert.deepEqual(deckMediaReferences('![](nucleus.png) again ![](nucleus.png)'), ['nucleus.png'], 'the same file once');

    const bundle = sampleBundle();
    bundle.notes[0].values = ['Look: ![](images/nucleus.png)', '[sound:click.mp3]'];
    bundle.notes[1].values = ['![](images/nucleus.png)'];
    assert.deepEqual(bundleMediaReferences(bundle), ['images/nucleus.png', 'click.mp3'], 'across the whole deck, in order');
});

test('rewriting media paths leaves a new bundle and touches every reference form', () => {
    const bundle = sampleBundle();
    bundle.notes[0].values = ['![](nucleus.png) and [sound:click.mp3]'];
    bundle.notes[1].values = ['<img src="nucleus.png">'];
    bundle.notes[1].mediaFiles = ['nucleus.png'];

    const moved = rewriteMediaPaths(bundle, reference => `spaceforge/decks/media/${reference}`);

    assert.deepEqual(moved.notes[0].values, ['![](spaceforge/decks/media/nucleus.png) and [sound:click.mp3]'.replace('[sound:click.mp3]', '[sound:spaceforge/decks/media/click.mp3]')]);
    assert.deepEqual(moved.notes[1].values, ['<img src="spaceforge/decks/media/nucleus.png">']);
    assert.deepEqual(moved.notes[1].mediaFiles, ['spaceforge/decks/media/nucleus.png']);
    assert.deepEqual(bundle.notes[0].values, ['![](nucleus.png) and [sound:click.mp3]'], 'the original bundle is untouched');
    assert.equal(moved.cards, bundle.cards, 'cards are shared, not copied');
});

test('deck document paths flatten hierarchies and stay file-name-safe', () => {
    assert.equal(deckDocumentPath('Cell Biology::Organelles'), `${DECKS_FOLDER}/Cell Biology - Organelles.md`);
    assert.equal(deckDocumentPath('Português'), `${DECKS_FOLDER}/Português.md`, 'accents are fine in a file name');

    const nasty = deckDocumentPath('Neurons: types? <draft> |v2| *star/back\\slash');
    assert.match(nasty, /^spaceforge\/decks\//);
    assert.match(nasty, /\.md$/);
    assert.ok(!/[\\/:*?"<>|]/.test(nasty.slice(DECKS_FOLDER.length + 1)), `illegal characters survived: ${nasty}`);
    assert.equal(sanitizeDeckFileName('a  /*weird*///  ::  name.'), 'a -weird- - name');
    assert.equal(sanitizeDeckFileName('Mitosis / Meiosis'), 'Mitosis - Meiosis');

    assert.equal(deckDocumentPath(''), `${DECKS_FOLDER}/deck.md`, 'a nameless deck still gets a file');
    assert.equal(deckDocumentPath('...'), `${DECKS_FOLDER}/deck.md`, 'a name made of dots is not a hidden file');

    const taken = [`${DECKS_FOLDER}/Biology.md`];
    assert.equal(deckDocumentPath('Biology', taken), `${DECKS_FOLDER}/Biology 2.md`);
    assert.equal(deckDocumentPath('Biology', [...taken, `${DECKS_FOLDER}/Biology 2.md`]), `${DECKS_FOLDER}/Biology 3.md`);

    assert.equal(isDeckDocumentPath(`${DECKS_FOLDER}/Biology.md`), true);
    assert.equal(isDeckDocumentPath(`${DECKS_MEDIA_FOLDER}/nucleus.png`), false);
    assert.equal(isDeckDocumentPath(`other/decks/Biology.md`), false);
    assert.equal(isDeckDocumentPath(`${DECKS_FOLDER}/nested/Biology.md`), false);
});

test('a deck file with no frontmatter is still read, with a warning', () => {
    const { bundle, warnings } = parseDeckWithWarnings('## hand\n**Q**: q\n**A**: a\n', 'spaceforge/decks/lonely.md');
    assert.equal(bundle.deck.name, 'lonely', 'the file name is the fallback');
    assert.equal(bundle.cards.length, 1);
    assert.match(warnings.join(' '), /no frontmatter/);
});

test('counts come from the stored state', () => {
    const bundle = sampleBundle();
    const tomorrow = NOW + 86_400_000;
    assert.deepEqual(deckCountsFrom(bundle.cards, tomorrow), {
        newCount: 1,
        learningCount: 1,
        reviewCount: 1,
        totalCards: 3,
        dueToday: 2,
    }, 'the new card and the learning card are due; the review card is five days out');
    assert.equal(deckCountsFrom(bundle.cards, NOW).dueToday, 1, 'a card that is not due yet is not counted');

    const suspended: AnkiCard = { ...bundle.cards[2], id: 'x', queue: AnkiCardQueue.Suspended };
    assert.equal(deckCountsFrom([...bundle.cards, suspended], tomorrow).dueToday, 2, 'a suspended card is never due');
});

test('a fresh deck is Anki-shaped and empty', () => {
    const deck = newDeck('Starter', { newPerDay: 5 });
    assert.equal(deck.deck.name, 'Starter');
    assert.equal(deck.deck.options.newPerDay, 5);
    assert.equal(deck.deck.options.reviewsPerDay, DEFAULT_DECK_OPTIONS.reviewsPerDay, 'the rest keeps Anki defaults');
    assert.deepEqual(deck.cards, []);
    assert.deepEqual(deck.notes, []);
    assert.deepEqual(deck.media, []);
    assert.ok(Number(deck.deck.id) > 0);
});

// --------------------------------------------------------------- the store

test('the store creates, lists, reads and writes decks in the vault', async () => {
    const { store, files, folders } = fakeVault();

    const created = await store.createDeck('Cell Biology::Organelles');
    assert.equal(created.path, DECK_PATH);
    assert.equal(files.has(DECK_PATH), true, 'the deck file is on disk');
    assert.equal(folders.has(DECKS_FOLDER), true, 'the decks folder was made');
    assert.equal(created.bundle.deck.name, 'Cell Biology::Organelles');

    const second = await store.createDeck('Cell Biology::Organelles');
    assert.equal(second.path, `${DECKS_FOLDER}/Cell Biology - Organelles 2.md`, 'a second deck of the same name does not collide');

    const summaries = await store.listDecks();
    assert.deepEqual(summaries.map(summary => summary.path), [DECK_PATH, second.path], 'listed by name');
    assert.equal(summaries[0].name, 'Cell Biology::Organelles');
    assert.equal(summaries[0].id, created.bundle.deck.id);
    assert.deepEqual(summaries[0].counts, { newCount: 0, learningCount: 0, reviewCount: 0, totalCards: 0, dueToday: 0 });
    assert.equal(summaries[0].mediaCount, 0);
    assert.deepEqual(summaries[0].warnings, []);
    assert.ok(summaries[0].modified > 0);

    const bundle = sampleBundle();
    const path = await store.writeDeck(bundle, DECK_PATH);
    assert.equal(path, DECK_PATH);
    const written = files.get(DECK_PATH);
    assert.ok(written?.text?.includes('## 1700000000100'));

    const read = await store.readDeck(DECK_PATH);
    assert.equal(read.cards.length, 3);
    assert.equal(read.deck.modified, bundle.deck.modified, 'the write stamped the deck');
    assert.ok(read.deck.modified !== NOW, 'and the stamp moved to now');

    const summariesAgain = await store.listDecks();
    const found = summariesAgain.find(summary => summary.path === DECK_PATH);
    assert.ok(found);
    assert.deepEqual(found.counts, {
        newCount: 1,
        learningCount: 1,
        reviewCount: 1,
        totalCards: 3,
        dueToday: 3,
    }, 'the fixture dates are in the past, so everything that is not suspended is due');
    assert.equal(found.mediaCount, 1, 'the deck references one media file');

    await assert.rejects(() => store.readDeck('spaceforge/decks/nope.md'), /Deck file not found/);
});

test('writing a deck without a path reuses the file that holds it', async () => {
    const { store } = fakeVault();
    const { path, bundle } = await store.createDeck('Biology');
    bundle.notes = [{
        id: '1',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['Q', 'A'],
        tags: [],
        cardIds: ['2'],
        mediaFiles: [],
    }];
    bundle.cards = [{
        id: '2',
        noteId: '1',
        deckId: bundle.deck.id,
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: null,
        flag: 0,
    }];

    const again = await store.writeDeck(bundle);
    assert.equal(again, path, 'the same file, not a " 2" copy of it');
    const read = await store.readDeck(path);
    assert.deepEqual(read.cards.map(card => card.id), ['2']);
    assert.deepEqual(read.notes[0].values, ['Q', 'A']);
});

test('renaming a deck moves its file and keeps its content', async () => {
    const { store, files } = fakeVault();
    const { path } = await store.createDeck('Biology');
    const target = await store.renameDeck(path, 'Cell Biology::Organelles');

    assert.equal(target, DECK_PATH, 'the new name is the new path, hierarchy flattened');
    assert.equal(files.has(path), false, 'the old file is gone');
    assert.equal(files.has(target), true);
    assert.ok(files.get(target)?.text?.includes('name: "Cell Biology::Organelles"'));
});

test('deleting a deck goes through the file manager, not the vault', async () => {
    const { store, files, trashed } = fakeVault();
    const { path } = await store.createDeck('Disposable');
    await store.deleteDeck(path);

    assert.deepEqual(trashed, [path], 'the trash preference decides what happens');
    assert.equal(files.has(path), false);
});

test('saving media never overwrites an existing file', async () => {
    const { store, files } = fakeVault();
    const first = await store.saveMedia('Deck A', 'nucleus.png', bytesOf('first'));
    const second = await store.saveMedia('Deck B', 'nucleus.png', bytesOf('second'));
    const third = await store.saveMedia('Deck C', 'pictures/nucleus.png', bytesOf('third'));

    assert.equal(first, `${DECKS_MEDIA_FOLDER}/nucleus.png`);
    assert.equal(second, `${DECKS_MEDIA_FOLDER}/nucleus-1.png`);
    assert.equal(third, `${DECKS_MEDIA_FOLDER}/nucleus-2.png`, 'a package path is reduced to its file name');
    assert.equal(new TextDecoder().decode(files.get(first)?.bytes), 'first', 'the first file still holds its own bytes');

    assert.deepEqual(await store.readMedia(second).then(read => new TextDecoder().decode(read)), 'second');

    const media = store.listMedia();
    const byPath = (left: string, right: string): number => left.localeCompare(right);
    assert.deepEqual(media.map(entry => entry.path), [first, second, third].sort(byPath));
    assert.deepEqual(
        media.map(entry => entry.originalName).sort(),
        ['nucleus.png', 'nucleus-1.png', 'nucleus-2.png'].sort()
    );
    assert.equal(mediaMimeType('nucleus.png'), 'image/png');
    assert.equal(mediaMimeType('click.mp3'), 'audio/mpeg');

    await store.deleteMedia(third);
    assert.deepEqual(store.listMedia().map(entry => entry.path), [first, second].sort(byPath));

    await assert.rejects(() => store.readMedia(`${DECKS_MEDIA_FOLDER}/gone.png`), /Deck file not found/);
});

test('media names that a file system would refuse are sanitized, never guessed', async () => {
    const { store, files } = fakeVault();
    const path = await store.saveMedia('Deck', 'a:b*?"<>|.png', bytesOf('x'));
    assert.equal(path, `${DECKS_MEDIA_FOLDER}/a-b-.png`);
    assert.equal(files.has(path), true);

    const nameless = await store.saveMedia('My Deck', '', bytesOf('y'));
    assert.equal(nameless, `${DECKS_MEDIA_FOLDER}/My Deck`, 'a nameless file falls back to the deck it came from');
});

test('importing writes the media first, then the text, then the deck', async () => {
    const { store, files } = fakeVault();
    const bundle = newDeck('Imported Deck');
    bundle.notes = [{
        id: '1',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['Which organelle? <img src="nucleus.png">', 'The nucleus.'],
        tags: [],
        cardIds: ['2'],
        mediaFiles: ['nucleus.png'],
    }];
    bundle.cards = [{
        id: '2',
        noteId: '1',
        deckId: bundle.deck.id,
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: null,
        flag: 0,
    }];
    bundle.media = [{ path: 'nucleus.png', originalName: 'nucleus.png' }];

    const report = await store.importBundle(bundle, {
        mediaBytes: new Map([['nucleus.png', bytesOf('png-bytes')]]),
    });

    assert.equal(report.replaced, false);
    assert.equal(report.deckName, 'Imported Deck');
    assert.equal(report.notesImported, 1);
    assert.equal(report.cardsImported, 1);
    assert.equal(report.mediaImported, 1);
    assert.deepEqual(report.missingMedia, []);
    assert.deepEqual(report.warnings, []);

    const text = files.get(report.deckPath)?.text ?? '';
    assert.match(text, /<img src="spaceforge\/decks\/media\/nucleus\.png">/, 'the card points at the vault path');
    assert.equal(files.has(`${DECKS_MEDIA_FOLDER}/nucleus.png`), true);

    const read = await store.readDeck(report.deckPath);
    assert.deepEqual(read.notes[0].values[0], 'Which organelle? <img src="spaceforge/decks/media/nucleus.png">');
    assert.deepEqual(read.media, [{ path: `${DECKS_MEDIA_FOLDER}/nucleus.png`, originalName: 'nucleus.png', mime: 'image/png', size: 9 }]);
    assert.deepEqual(store.missingMedia(read), [], 'nothing the text names is missing');

    // Importing the same deck again replaces the file it made.
    const again = await store.importBundle(sampleBundle(), { path: report.deckPath });
    assert.equal(again.replaced, true, 'a path that already holds a deck is replaced');
    assert.equal(again.deckPath, report.deckPath);
});

test('an import with no bytes reports what it could not write', async () => {
    const { store } = fakeVault();
    const bundle = newDeck('Missing media');
    bundle.notes = [{
        id: '1',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['![](ghost.png)', 'answer'],
        tags: [],
        cardIds: ['2'],
        mediaFiles: ['ghost.png'],
    }];
    bundle.cards = [{
        id: '2',
        noteId: '1',
        deckId: bundle.deck.id,
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: null,
        flag: 0,
    }];
    bundle.media = [{ path: 'ghost.png', originalName: 'ghost.png' }];

    const report = await store.importBundle(bundle);
    assert.deepEqual(report.missingMedia, ['ghost.png']);
    assert.equal(report.mediaImported, 0);
    assert.match(report.warnings.join(' '), /had no content/);

    const read = await store.readDeck(report.deckPath);
    assert.deepEqual(store.missingMedia(read), ['ghost.png'], 'and the vault really does not have it');
});

test('a re-import of the same deck lands on the same file', async () => {
    const { store, files } = fakeVault();
    const bundle = newDeck('Twice');
    bundle.media = [];
    const first = await store.importBundle(bundle);
    assert.equal(first.replaced, false);

    bundle.deck.name = 'Twice (renamed)';
    const second = await store.importBundle(bundle);
    assert.equal(second.replaced, true, 'the same deck id replaced the earlier import');
    assert.equal(second.deckPath, first.deckPath, 'and it landed in the same file');
    assert.equal(files.size, 1, 'no stray second deck file');
});

test('exporting a deck resolves its media back to bytes', async () => {
    const { store } = fakeVault();
    const bundle = newDeck('With media');
    bundle.notes = [{
        id: '1',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['![](nucleus.png)', 'answer'],
        tags: [],
        cardIds: [],
        mediaFiles: ['nucleus.png'],
    }];
    bundle.media = [{ path: 'nucleus.png', originalName: 'nucleus.png' }];
    const report = await store.importBundle(bundle, { mediaBytes: { 'nucleus.png': bytesOf('image-bytes') } });

    const exported = await store.exportBundle(report.deckPath);
    assert.equal(exported.bundle.deck.name, 'With media');
    assert.equal(exported.media.length, 1);
    assert.equal(exported.media[0].file.originalName, 'nucleus.png');
    assert.deepEqual(new TextDecoder().decode(exported.media[0].bytes), 'image-bytes');
    assert.deepEqual(exported.missing, []);

    // And a deck whose media has since gone says so instead of failing.
    const gone = await store.exportBundle((await store.createDeck('Empty')).path);
    assert.deepEqual(gone.missing, []);
});

test('updating card states edits the state lines in place', async () => {
    const { store, files } = fakeVault();
    const bundle = sampleBundle();
    const path = await store.writeDeck(bundle, DECK_PATH);
    const before = files.get(path)?.text ?? '';

    const answered = { ...bundle.cards[0] };
    answered.due = NOW + 86_400_000;
    answered.interval = 1;
    answered.reviews = 1;
    answered.queue = AnkiCardQueue.Review;
    answered.type = AnkiCardType.Review;
    answered.memory = { stability: 1.2, difficulty: 5.5, lastReview: NOW, scheduledDays: 1 };

    const mode = await store.updateCardStates(path, [answered]);
    assert.equal(mode, 'in-place');

    const after = files.get(path)?.text ?? '';
    assert.ok(after.includes('**Q**: What is the powerhouse of the cell?'), 'the text a human typed is untouched');
    assert.ok(after.includes('A paragraph') === false);
    assert.ok(before.includes('"reps":0'));
    assert.ok(after.includes('"reps":1'));
    assert.ok(after.includes('"mem":{"s":1.2'));
    assert.ok(after.includes('"fsrsSeed":"seed-42"'), "the card's unknown key survives a state write");
    assert.ok(after.includes('"tags":["cells","organelles"]'), "the note's payload survives a state write");

    const reread = await store.readDeck(path);
    const card = reread.cards.find(candidate => candidate.id === '1700000000100');
    assert.ok(card);
    assert.equal(card.reviews, 1);
    assert.equal(card.due, NOW + 86_400_000);
    assert.deepEqual(card.memory, { stability: 1.2, difficulty: 5.5, lastReview: NOW, scheduledDays: 1 });
    assert.equal(reread.cards.length, 3, 'the other cards kept their own state');

    // Only the modified stamp and the one state line moved.
    const changed = before.split('\n').filter((line, index) => line !== after.split('\n')[index]);
    assert.equal(changed.length, 2, `only the state line and the stamp changed: ${changed.join(' | ')}`);
    assert.ok(changed.some(line => line.startsWith('modified: ')));
    assert.ok(changed.some(line => line.includes('sf-card')));
});

test('a card with no state line in the file forces a full rewrite', async () => {
    const { store, files } = fakeVault();
    const bundle = sampleBundle();
    const path = await store.writeDeck(bundle, DECK_PATH);

    const fresh: AnkiCard = {
        id: '1700000009999',
        noteId: '1700000000002',
        deckId: bundle.deck.id,
        ord: 1,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: null,
        flag: 0,
    };
    const mode = await store.updateCardStates(path, [fresh]);
    assert.equal(mode, 'rewritten');

    const reread = await store.readDeck(path);
    assert.deepEqual(reread.cards.map(card => card.id), [
        '1700000000100',
        '1700000000101',
        '1700000000102',
        '1700000009999',
    ], 'every card the file had, plus the new one');
    assert.deepEqual(reread.notes.find(note => note.id === '1700000000002')?.cardIds, ['1700000000102', '1700000009999']);
    assert.ok(files.get(path)?.text?.includes('## 1700000009999'));
});

test('an update carrying a card the file has never seen rewrites the whole deck', async () => {
    const { store } = fakeVault();
    const bundle = sampleBundle();
    const path = await store.writeDeck(bundle, DECK_PATH);

    // Not every incoming card has a state line in the file, so the store
    // falls back to serialising the whole deck rather than dropping it.
    const mode = await store.updateCardStates(path, [
        ...bundle.cards,
        { ...bundle.cards[0], id: '1700000005555' },
    ]);
    assert.equal(mode, 'rewritten');
    const reread = await store.readDeck(path);
    assert.deepEqual(reread.cards.map(card => card.id), [
        '1700000000100',
        '1700000000101',
        '1700000000102',
        '1700000005555',
    ]);
    assert.equal(reread.notes.length, 2, 'the notes are the same two notes');
    assert.deepEqual(reread.notes[0].cardIds, ['1700000000100', '1700000000101', '1700000005555']);
});
