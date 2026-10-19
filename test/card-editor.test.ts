/**
 * The card editor, where it now lives: inside the cards surface.
 *
 * Two halves, both about the house rule this file exists to keep —
 * editing a card never opens a popup:
 *
 * - the surface's own behaviour: the editor is the panel the sitting mounts
 *   over the card, the card comes back where it was, a new card is written
 *   through the deck store and taken up by the sitting, and an edit lands on
 *   screen (all driven through the real DeckSessionController with stand-ins
 *   for the view and the store, as its sibling suite does);
 * - the static shape: no card surface extends `Modal`, the deck-sitting modal
 *   is gone, and every class the editor renders is styled by deck-session.css.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { AnkiCard, AnkiCardQueue, AnkiCardType, DeckBundle, DeckScheduler } from '../models/anki';
import { parseDeck, serializeDeck } from '../models/deck-document';
import {
    CardEditorHost,
    CardEditorPanel,
    CardEditorSave,
    CardEditorState,
    mintCardsFromDraft,
    validateCardDraft,
} from '../ui/card-editor-panel';
import { DeckSessionCard, DeckSessionController } from '../controllers/deck-session-controller';
import type { DeckSessionSummary } from '../ui/deck-session-view';

const DAY = 86_400_000;
const NOW = 1_792_224_000_000;
const DECK_ID = String(NOW - 30 * DAY);
const DECK_PATH = 'spaceforge/decks/Test deck.md';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const exists = (relative: string): boolean => fs.existsSync(path.join(process.cwd(), relative));

// ------------------------------------------------------------------- fixtures

/** A deck with one Basic note and one card, as a deck file holds it. */
function bundleWith(cards: Array<Partial<AnkiCard>>, values: string[] = ['Front text', 'Back text']): DeckBundle {
    const deck: DeckBundle['deck'] = {
        id: DECK_ID,
        name: 'Test deck',
        modified: NOW,
        options: {
            newPerDay: 20,
            reviewsPerDay: 200,
            learningSteps: [1, 10],
            relearningSteps: [10],
            graduatingInterval: 1,
            easyInterval: 4,
            startingEase: 2500,
            easyBonus: 1300,
            intervalMultiplier: 1000,
            lapseMultiplier: 0,
            hardMultiplier: 1200,
            minimumInterval: 1,
            maximumInterval: 36500,
            leechThreshold: 8,
            leechAction: 0 as never,
            buryNewSiblings: true,
            buryReviewSiblings: false,
            maxAnswerSeconds: 60,
            againDelayMinutes: 10,
            scheduler: DeckScheduler.Sm2,
            fsrs: { desiredRetention: 0.9, maximumInterval: 36500, weights: [], useOwnWeights: false },
        },
    };

    const noteIds = [...new Set(cards.map((card, index) => card.noteId ?? `n${index}`))];
    const notes = noteIds.map(id => ({
        id,
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: [...values],
        tags: [],
        cardIds: cards
            .map((card, index) => ({ card, index }))
            .filter(entry => (entry.card.noteId ?? `n${entry.index}`) === id)
            .map(entry => entry.card.id ?? `c${entry.index}`),
        mediaFiles: [],
        modified: NOW,
    }));

    return {
        deck,
        notes,
        cards: cards.map((card, index) => ({
            id: `c${index}`,
            noteId: card.noteId ?? `n${index}`,
            deckId: DECK_ID,
            ord: 0,
            type: AnkiCardType.New,
            queue: AnkiCardQueue.New,
            interval: 0,
            easeFactor: 2500,
            reviews: 0,
            lapses: 0,
            due: NOW,
            newPosition: index,
            flag: 0,
            ...card,
        })),
        media: [],
    };
}

interface LaneRecord {
    shown: DeckSessionCard[];
    mounts: number;
    destroys: number;
    /** What the view was asked to open the editor on. */
    editorState: CardEditorState | null;
    /** The host the sitting handed the editor. */
    host: CardEditorHost | null;
    editorCloses: number;
    /** What the surface answers for "is it on screen" (a dock can hide it). */
    viewOnScreen: boolean;
    /** How many times the flow was asked to hand the sitting its panel again. */
    redocks: number;
}

/** A view stand-in with the editor's own mouth: open, close, show. */
function standInView(recorded: LaneRecord): Record<string, unknown> {
    return {
        mountInto: () => { recorded.mounts += 1; },
        show: (card: DeckSessionCard) => { recorded.shown.push(card); },
        finish: (summary: DeckSessionSummary | null) => { void summary; },
        pulse: () => undefined,
        destroy: () => { recorded.destroys += 1; },
        isAnswering: () => true,
        isOnScreen: () => recorded.viewOnScreen,
        openEditor: (state: CardEditorState, host: CardEditorHost) => {
            recorded.editorState = state;
            recorded.host = host;
        },
        closeEditor: () => { recorded.editorCloses += 1; recorded.editorState = null; },
        isEditing: () => recorded.editorState !== null,
    };
}

/** A sitting wired to a stand-in surface and a deck held in memory. */
function makeSitting(bundle: DeckBundle, overrideStore?: unknown): {
    controller: DeckSessionController;
    recorded: LaneRecord;
    writeDeckCalls: { bundle: DeckBundle; path?: string }[];
    listDecksCalls: { path: string; name: string }[][];
    plugin: Record<string, unknown>;
} {
    const recorded: LaneRecord = {
        shown: [],
        mounts: 0,
        destroys: 0,
        editorState: null,
        host: null,
        editorCloses: 0,
        viewOnScreen: true,
        redocks: 0,
    };
    const writeDeckCalls: { bundle: DeckBundle; path?: string }[] = [];
    const listDecksCalls: { path: string; name: string }[][] = [];
    const view = standInView(recorded);

    const store = {
        readDeck: async () => bundle,
        listDecks: async () => {
            const decks = [{ path: DECK_PATH, name: bundle.deck.name }];
            listDecksCalls.push(decks);
            return decks;
        },
        writeDeck: async (written: DeckBundle, writtenPath?: string) => {
            writeDeckCalls.push({ bundle: written, path: writtenPath });
            return writtenPath ?? DECK_PATH;
        },
        updateCardStates: async () => 'in-place' as const,
    };

    const plugin: Record<string, unknown> = {
        app: { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => leaf() } },
        settings: { reviewSessionPlacement: 'split', mcqGradingMode: 'ask' },
        reviewScheduleService: { getDueNotes: () => [] },
        reviewFlowController: null,
        getSidebarView: () => null,
    };

    const controller = new DeckSessionController(plugin as never, (overrideStore ?? store) as never, {
        createView: () => view as never,
    });
    return { controller, recorded, writeDeckCalls, listDecksCalls, plugin };
}

function leaf(): unknown {
    return { view: { containerEl: {} }, openFile: async () => undefined };
}

// ------------------------------------------------------------------- drafting

test('a basic draft mints one note and one card, and it round-trips through the deck file', () => {
    const bundle = bundleWith([]);
    const { note, cards } = mintCardsFromDraft(bundle, 'basic', ['What is the powerhouse of the cell?', 'The mitochondria']);

    assert.equal(cards.length, 1);
    assert.equal(cards[0].noteId, note.id);
    assert.deepEqual(note.fields, ['Front', 'Back']);
    assert.deepEqual(note.values, ['What is the powerhouse of the cell?', 'The mitochondria']);

    bundle.notes.push(note);
    bundle.cards.push(...cards);
    const reparsed = parseDeck(serializeDeck(bundle), DECK_PATH);
    assert.equal(reparsed.notes.length, 1);
    assert.equal(reparsed.notes[0].values[0], 'What is the powerhouse of the cell?');
    assert.equal(reparsed.cards.length, 1, 'the card is a real card of the deck document');
});

test('“and reversed” is two cards of one note, and a typed card carries its presentation', () => {
    const bundle = bundleWith([]);
    const reversed = mintCardsFromDraft(bundle, 'basicReversed', ['one', 'two']);
    assert.equal(reversed.cards.length, 2);
    assert.deepEqual(reversed.cards.map(card => card.ord), [0, 1]);
    assert.equal(reversed.cards[0].noteId, reversed.cards[1].noteId, 'one note, two templates');

    const typed = mintCardsFromDraft(bundle, 'typed', ['type this', 'answer']);
    assert.equal(typed.cards[0].presentation?.mode, 'type');
    assert.equal(typed.cards[0].noteId, typed.note.id);
});

test('a cloze draft asks a card per deletion, in ordinal order', () => {
    const bundle = bundleWith([]);
    const cloze = mintCardsFromDraft(bundle, 'cloze', ['{{c2::Paris::city}} is in {{c1::France}}', 'Europe']);
    assert.equal(cloze.cards.length, 2);
    assert.deepEqual(cloze.cards.map(card => card.ord), [0, 1], 'c1 is ord 0, c2 is ord 1');
    assert.deepEqual(cloze.note.fields, ['Cloze text', 'Back extra']);
});

test('new cards queue behind the deck’s own positions', () => {
    const bundle = bundleWith([{ newPosition: 4 }, { newPosition: 6 }]);
    const { cards } = mintCardsFromDraft(bundle, 'basicReversed', ['a', 'b']);
    assert.deepEqual(cards.map(card => card.newPosition), [7, 8]);
});

test('the draft rules are the card lane’s own, said in the reader’s words', () => {
    assert.equal(validateCardDraft('basic', ['', 'back']), 'A card needs a front.');
    assert.equal(validateCardDraft('basic', ['front', '']), 'A basic card needs a back.');
    assert.equal(validateCardDraft('cloze', ['', 'extra']), 'A cloze card needs its text.');
    assert.equal(
        validateCardDraft('cloze', ['no deletion here', '']),
        'A cloze card needs at least one deletion: {{c1::…}}.',
    );
    assert.equal(validateCardDraft('basic', ['front', 'back']), '');
    assert.equal(validateCardDraft('cloze', ['{{c1::x}}', '']), '');
});

// ---------------------------------------------------------------- the surface

test('the Edit control on the card opens the editor in place, on that card’s own fields', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }], ['Original front', 'Original back']);
    const { controller, recorded } = makeSitting(bundle);

    await controller.start(DECK_PATH);
    assert.equal(controller.currentCard()?.card.id, 'c0');

    // What the view's own Edit button calls.
    await controller.openCardEditor({ mode: 'edit' });

    const state = recorded.editorState;
    assert.ok(state, 'the sitting handed the editor to its own view, in place');
    assert.equal(state.mode, 'edit');
    assert.equal(state.questionEditable, false, 'an edit changes the text, not the card’s kind');
    assert.deepEqual(state.fields.map(field => field.label), ['Front', 'Back']);
    assert.deepEqual(state.fields.map(field => field.value), ['Original front', 'Original back']);
    assert.equal(state.deckName, 'Test deck');
});

test('saving an edit writes the note home and the card on screen comes back changed', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }], ['Original front', 'Original back']);
    const { controller, recorded, writeDeckCalls } = makeSitting(bundle);

    await controller.start(DECK_PATH);
    await controller.openCardEditor({ mode: 'edit' });
    const host = recorded.host;
    assert.ok(host);

    const conclusion = await host.save({
        mode: 'edit',
        deckPath: null,
        newDeckName: '',
        question: 'basic',
        values: ['Edited front', 'Edited back'],
    } as CardEditorSave);

    assert.equal(conclusion.ok, true);
    assert.equal(conclusion.message, 'Card saved.');
    assert.equal(writeDeckCalls.length, 1, 'the edit was written through the deck store');
    assert.equal(writeDeckCalls[0].path, DECK_PATH);
    assert.deepEqual(writeDeckCalls[0].bundle.notes[0].values, ['Edited front', 'Edited back']);

    // The card the reader was on is re-resolved and shown where they stand.
    const last = recorded.shown.at(-1);
    assert.equal(last?.card.id, 'c0');
    assert.equal(last?.view.front, 'Edited front');
    assert.equal(last?.view.back, 'Edited back');
    assert.equal(controller.currentCard()?.card.id, 'c0', 'the sitting did not move on');
});

test('a new card is written into the sitting’s deck and waits its turn behind the card on screen', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }]);
    const { controller, recorded, writeDeckCalls } = makeSitting(bundle);

    await controller.start(DECK_PATH);
    const before = controller.currentCard()?.card.id;
    await controller.openCardEditor({ mode: 'new' });

    const state = recorded.editorState;
    assert.ok(state);
    assert.equal(state.mode, 'new');
    assert.equal(state.questionEditable, true);
    assert.equal(state.deckPath, DECK_PATH, 'the sitting’s own deck is the default');
    assert.deepEqual(state.fields.map(field => field.label), ['Front', 'Back']);

    const host = recorded.host;
    assert.ok(host);
    const conclusion = await host.save({
        mode: 'new',
        deckPath: DECK_PATH,
        newDeckName: '',
        question: 'basicReversed',
        values: ['New front', 'New back'],
    } as CardEditorSave);

    assert.equal(conclusion.ok, true);
    assert.match(conclusion.message, /Added 2 cards to "Test deck"\./);
    assert.equal(writeDeckCalls.length, 1);
    assert.equal(writeDeckCalls[0].bundle.notes.length, 2, 'the note went in beside the deck’s own');
    assert.equal(writeDeckCalls[0].bundle.cards.length, 3, 'and both of its cards');
    assert.equal(controller.currentCard()?.card.id, before, 'the reader’s card did not move');
});

test('with nothing running, opening the editor mounts a sitting — never a popup — and a cancel takes it down', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }]);
    const { controller, recorded } = makeSitting(bundle);

    assert.equal(controller.isActive(), false);
    await controller.openCardEditor({ mode: 'new' });

    assert.equal(recorded.mounts, 1, 'a sitting was opened for the writing');
    assert.equal(controller.isActive(), true);
    const state = recorded.editorState;
    assert.ok(state, 'the editor is in the sitting’s own surface');
    assert.equal(state.deckPath, DECK_PATH, 'the first deck is the default');
    assert.equal(recorded.shown.length, 0, 'nothing is shown behind the editor: the queue is empty');

    const host = recorded.host;
    assert.ok(host);
    host.close(false);

    assert.equal(recorded.editorCloses, 1);
    assert.equal(controller.isActive(), false, 'an editor closed without a save leaves nothing behind');
    assert.equal(recorded.destroys, 1);
});

test('with no decks at all, the editor still opens: the deck is named where the card is written', async () => {
    installMiniDocument();
    const bundle = bundleWith([]);
    const recorded: LaneRecord = {
        shown: [],
        mounts: 0,
        destroys: 0,
        editorState: null,
        host: null,
        editorCloses: 0,
        viewOnScreen: true,
        redocks: 0,
    };
    const created: { name: string }[] = [];
    const view = standInView(recorded);
    const store = {
        readDeck: async () => bundle,
        listDecks: async () => [],
        createDeck: async (name: string) => {
            created.push({ name });
            return { path: 'spaceforge/decks/Biology.md', bundle: { ...bundle, deck: { ...bundle.deck, name } } };
        },
        writeDeck: async () => 'spaceforge/decks/Biology.md',
        updateCardStates: async () => 'in-place' as const,
    };
    const plugin: Record<string, unknown> = {
        app: { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => leaf() } },
        settings: { reviewSessionPlacement: 'split', mcqGradingMode: 'ask' },
        reviewScheduleService: { getDueNotes: () => [] },
        reviewFlowController: null,
        getSidebarView: () => null,
    };
    const controller = new DeckSessionController(plugin as never, store as never, {
        createView: () => view as never,
    });

    await controller.openCardEditor({ mode: 'new' });
    const state = recorded.editorState;
    assert.ok(state);
    assert.equal(state.decks.length, 0, 'the picker offers the name field instead');
    assert.equal(state.deckPath, null);

    const conclusion = await recorded.host!.save({
        mode: 'new',
        deckPath: null,
        newDeckName: 'Biology',
        question: 'basic',
        values: ['front', 'back'],
    } as CardEditorSave);

    assert.equal(conclusion.ok, true);
    assert.deepEqual(created, [{ name: 'Biology' }], 'the deck was started by the save');
    assert.match(conclusion.message, /Biology/);
});

test('a sitting docked behind another panel is brought forward before the editor opens in it', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }]);
    const { controller, recorded, plugin } = makeSitting(bundle);
    await controller.start(DECK_PATH);
    assert.equal(recorded.mounts, 1);

    // The dock is holding the cards, but it is standing on another tab: the
    // panel the sitting lives in is hidden.
    recorded.viewOnScreen = false;
    plugin.reviewFlowController = {
        showCardSitting: (mount: (container: HTMLElement) => () => void) => {
            recorded.redocks += 1;
            mount({} as HTMLElement);
            return true;
        },
    };

    await controller.openCardEditor({ mode: 'edit' });

    assert.equal(recorded.redocks, 1, 'the flow was asked to hand the cards forward');
    assert.equal(recorded.mounts, 2, 'the sitting was mounted into the panel the dock handed over again');
    assert.ok(recorded.editorState, 'and the editor opens in the surface that came forward');
    assert.equal(recorded.editorState?.mode, 'edit');
});

test('a sitting already on screen is not re-mounted when the editor opens in it', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }]);
    const { controller, recorded, plugin } = makeSitting(bundle);
    await controller.start(DECK_PATH);
    plugin.reviewFlowController = {
        showCardSitting: () => {
            recorded.redocks += 1;
            return true;
        },
    };

    await controller.openCardEditor({ mode: 'edit' });

    assert.equal(recorded.redocks, 0, 'nothing moved: the card is right there');
    assert.equal(recorded.mounts, 1);
    assert.ok(recorded.editorState);
});

test('a card written mid-sitting is taken up by the sitting, note and all', async () => {
    installMiniDocument();
    const bundle = bundleWith([{ id: 'c0', noteId: 'n0' }]);
    // The store hands back a fresh parse per read, as the real one does: the
    // sitting has to take the deck it just wrote back from the store.
    const written = { bundle: bundleWith([{ id: 'c0', noteId: 'n0' }]) };
    const reread = (source: DeckBundle): DeckBundle => JSON.parse(JSON.stringify(source)) as DeckBundle;
    const store = {
        readDeck: async () => reread(written.bundle),
        listDecks: async () => [{ path: DECK_PATH, name: 'Test deck' }],
        writeDeck: async (next: DeckBundle, writtenPath?: string) => {
            written.bundle = reread(next);
            return writtenPath ?? DECK_PATH;
        },
        updateCardStates: async () => 'in-place' as const,
    };
    const { controller, recorded } = makeSitting(bundle, store);

    await controller.start(DECK_PATH);
    assert.equal(controller.currentCard()?.card.id, 'c0');

    await controller.openCardEditor({ mode: 'new' });
    const conclusion = await recorded.host!.save({
        mode: 'new',
        deckPath: DECK_PATH,
        newDeckName: '',
        question: 'basic',
        values: ['A card written while sitting', 'Its answer'],
    } as CardEditorSave);
    assert.equal(conclusion.ok, true);
    assert.equal(written.bundle.cards.length, 2, 'the new card went into the deck it was written to');
    assert.equal(controller.currentCard()?.card.id, 'c0', 'the reader’s card did not move');

    // The new card waits its turn: a skip hands it over, with its question
    // readable — which it is not if the sitting kept the stale bundle.
    controller.skip();
    const shown = recorded.shown.at(-1);
    assert.ok(shown, 'the sitting moved on');
    assert.equal(shown?.view.front, 'A card written while sitting', 'the card just written is the next one');
    assert.equal(shown?.deckName, 'Test deck');
});

// ---------------------------------------------------------------- the panel

/** The panel, mounted into a mini-DOM container, with a recording host. */
function mountPanel(state: CardEditorState): {
    host: HTMLElement;
    saves: CardEditorSave[];
    closes: boolean[];
    settle: () => Promise<void>;
} {
    const container = new MiniElement('div');
    const saves: CardEditorSave[] = [];
    const closes: boolean[] = [];
    const host: CardEditorHost = {
        save: async draft => {
            saves.push(draft);
            return { ok: true, message: 'Added 1 card to "Test deck".' };
        },
        close: (saved: boolean) => { closes.push(saved); },
    };
    const panel = new CardEditorPanel(state, host);
    panel.mountInto(container as unknown as HTMLElement);
    return {
        host: container as unknown as HTMLElement,
        saves,
        closes,
        settle: () => new Promise(resolve => setTimeout(resolve, 0)),
    };
}

function editorState(mode: 'new' | 'edit'): CardEditorState {
    return {
        mode,
        decks: mode === 'new' ? [{ path: DECK_PATH, name: 'Test deck' }] : [],
        deckPath: DECK_PATH,
        deckName: 'Test deck',
        question: 'basic',
        questionEditable: mode === 'new',
        fields: [
            { label: 'Front', value: 'Original front' },
            { label: 'Back', value: 'Original back' },
        ],
    };
}

test('the panel is a section of the surface: its fields, its deck and its Save are in the tree', () => {
    const mounted = mountPanel(editorState('new'));
    const root = (mounted.host as unknown as MiniElement);
    assert.equal(root.byClass('sf-card-editor').length, 1);
    assert.equal(root.byClass('sf-card-editor-select').length, 2, 'the deck and the question type');
    assert.equal(root.byClass('sf-card-editor-area').length, 2, 'one area per field');
    assert.equal(root.byClass('sf-card-editor-save').length, 1);
    assert.equal(root.byClass('sf-card-editor-cancel').length, 1);
    assert.equal(root.textOf('sf-card-editor-title'), 'New card');
    assert.equal(root.textOf('sf-card-editor-hint'), 'Ctrl+Enter saves · Esc cancels.');
});

test('the panel reads the fields it was given: an edit saves the card’s own values', async () => {
    const mounted = mountPanel(editorState('edit'));
    const root = mounted.host as unknown as MiniElement;
    assert.equal(root.textOf('sf-card-editor-title'), 'Edit card');
    assert.equal(root.textOf('sf-card-editor-deck'), 'Test deck');
    assert.equal(root.byClass('sf-card-editor-area')[0].value, 'Original front');

    root.byClass('sf-card-editor-save')[0].click();
    await mounted.settle();

    assert.deepEqual(mounted.saves[0].values, ['Original front', 'Original back']);
    assert.equal(mounted.saves[0].mode, 'edit');
    assert.deepEqual(mounted.closes, [true], 'a saved editor closes as saved');
});

test('the panel refuses what a card cannot be, in place, and never calls save', async () => {
    const mounted = mountPanel(editorState('new'));
    const root = mounted.host as unknown as MiniElement;
    root.byClass('sf-card-editor-area')[0].value = '';
    root.byClass('sf-card-editor-area')[1].value = '';

    root.byClass('sf-card-editor-save')[0].click();
    await mounted.settle();

    assert.equal(mounted.saves.length, 0);
    assert.equal(mounted.closes.length, 0);
    assert.equal(root.textOf('sf-card-editor-error'), 'A card needs a front.');
});

test('cancelling the panel closes it without a save', async () => {
    const mounted = mountPanel(editorState('new'));
    const root = mounted.host as unknown as MiniElement;
    root.byClass('sf-card-editor-cancel')[0].click();
    await mounted.settle();
    assert.deepEqual(mounted.closes, [false]);
    assert.equal(mounted.saves.length, 0);
});

// ------------------------------------------------------------- no popups here

test('no card surface opens a modal — the editor is the sitting’s own panel', () => {
    const editor = read('ui/card-editor-panel.ts');
    const launcher = read('ui/card-editor-modal.ts');
    const view = read('ui/deck-session-view.ts');

    for (const [name, source] of [['card-editor-panel.ts', editor], ['card-editor-modal.ts', launcher], ['deck-session-view.ts', view]] as [string, string][]) {
        assert.doesNotMatch(source, /extends Modal/, `${name} still extends Modal`);
        assert.doesNotMatch(source, /new Modal\(/, `${name} still opens a modal`);
        assert.doesNotMatch(source, /import[^\n]*\bModal\b[^\n]*from ['"]obsidian['"]/, `${name} still imports Obsidian's Modal class`);
    }

    assert.ok(!exists('ui/deck-session-modal.ts'), 'the deck-sitting modal is deleted, not just unused');
    assert.match(view, /sf-card-editor-host/, 'the sitting mounts the editor inside its own body');
    assert.match(view, /sf-deck-edit/, 'the card carries its own Edit control');
    assert.match(view, /sf-deck-add-card|sf-deck-new/, 'the deck’s own controls offer Add card');

    // The one modal left in the card lane's own files is none: grep the folder.
    const offenders: string[] = [];
    for (const file of fs.readdirSync(path.join(process.cwd(), 'ui'))) {
        if (!/^deck-|^card-/.test(file) || !file.endsWith('.ts')) continue;
        const source = read(`ui/${file}`);
        if (/\bextends Modal\b/.test(source) || /\bnew Modal\(/.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'card/deck surfaces that still open popups');
});

test('every class the editor renders has a rule in deck-session.css', () => {
    const rendered = read('ui/card-editor-panel.ts') + read('ui/deck-session-view.ts');
    const css = read('styles/deck-session.css');

    const tokens = new Set(
        [...rendered.matchAll(/sf-[a-z0-9-]+/g)]
            .map(match => match[0])
            // Template prefixes (sf-deck-grade-${…}) are covered by their variants.
            .filter(token => !token.endsWith('-'))
            // The house utility class, styled once in _components.css.
            .filter(token => token !== 'sf-hidden'),
    );
    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size > 20, `expected the sitting’s classes, found ${tokens.size}`);
});

test('the sitting still answers its own keys — the editor stands them down, not the other way round', () => {
    const view = read('ui/deck-session-view.ts');
    // The editor owns the keyboard while it is open; ask the sitting to check.
    assert.match(view, /if \(this\.editorOpen\) return;/, 'the sitting’s keys stand down while editing');
    // And the editor takes Escape at the window, before the review flow’s own
    // document handler can end the session the reader is in.
    const panel = read('ui/card-editor-panel.ts');
    assert.match(panel, /window\.addEventListener\('keydown', this\.escapeHandler, true\)/);
});
