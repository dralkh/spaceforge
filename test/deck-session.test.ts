/**
 * A deck sitting, end to end, without a window: the queue it builds, what an
 * answer writes back, what burying does to it, and when it is over.
 *
 * The surface is replaced by a stand-in that records what it was asked to show,
 * and the store by one that keeps decks in memory — so this tests the sitting's
 * own decisions, which are the part that can be wrong in a way a reader would
 * feel but a screenshot would not show.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AnkiCard, AnkiCardQueue, AnkiCardType, AnkiGrade, DeckBundle, DeckScheduler } from '../models/anki';
import { deckDayBase } from '../utils/dates';
import { DeckSessionController, DeckSessionCard, DeckSessionHandlers } from '../controllers/deck-session-controller';
import type { DeckSessionSummary } from '../ui/deck-session-view';

const DAY = 86_400_000;
const NOW = 1_792_224_000_000;
const DECK_ID = String(NOW - 30 * DAY);
const DAY_BASE = Date.UTC(2026, 9, 17);

/** A note with two fields, so the cards are ordinary flip cards. */
function bundleWith(cards: Array<Partial<AnkiCard>>): DeckBundle {
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

    // Notes are built from the cards' own note ids, so two cards that name the
    // same note really are siblings — which is what burying is about.
    const noteIds = [...new Set(cards.map((card, index) => card.noteId ?? `n${index}`))];
    const notes = noteIds.map(id => {
        const members = cards
            .map((card, index) => ({ card, index }))
            .filter(entry => (entry.card.noteId ?? `n${entry.index}`) === id);
        return {
            id,
            modelName: 'Basic',
            fields: ['Front', 'Back'],
            values: [`Question for ${id}`, `Answer for ${id}`],
            tags: [],
            cardIds: members.map(entry => entry.card.id ?? `c${entry.index}`),
            mediaFiles: [],
        };
    });

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

/** What the surface was shown, in order. */
interface Recorded {
    shown: DeckSessionCard[];
    finished: DeckSessionSummary[];
    mounts: number;
    /** How many times the surface was taken down. */
    destroys: number;
}

function standInHandlers(): { handlers: DeckSessionHandlers; log: string[] } {
    const log: string[] = [];
    return {
        log,
        handlers: {
            onGrade: grade => log.push(`grade:${grade}`),
            onChoose: (index, correct) => log.push(`choose:${index}:${correct}`),
            onSkip: () => log.push('skip'),
            onEnd: () => log.push('end'),
            onRebuild: () => log.push('rebuild'),
        },
    };
}

/** A controller wired to a stand-in surface and a deck held in memory. */
function makeSitting(bundle: DeckBundle, now = NOW): {
    controller: DeckSessionController;
    recorded: Recorded;
    written: { path: string; cards: AnkiCard[] }[];
    bundle: DeckBundle;
    plugin: Record<string, unknown>;
} {
    const recorded: Recorded = { shown: [], finished: [], mounts: 0, destroys: 0 };
    const written: { path: string; cards: AnkiCard[] }[] = [];
    const { handlers } = standInHandlers();

    const view = {
        mountInto: () => { recorded.mounts += 1; },
        show: (card: DeckSessionCard) => { recorded.shown.push(card); },
        finish: (summary: DeckSessionSummary | null) => { if (summary) recorded.finished.push(summary); },
        pulse: () => undefined,
        destroy: () => { recorded.destroys += 1; },
        isAnswering: () => true,
    };

    const store = {
        readDeck: async () => bundle,
        updateCardStates: async (path: string, cards: AnkiCard[]) => {
            written.push({ path, cards });
            return 'in-place' as const;
        },
        writeDeck: async () => path => path,
    };

    const plugin: Record<string, unknown> = {
        app: { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => leaf() } },
        settings: { reviewSessionPlacement: 'split', mcqGradingMode: 'ask' },
        // The other lane, which the finish screen asks about, and the dock it
        // would hand its panel back to: neither is up in these tests.
        reviewScheduleService: { getDueNotes: () => [] },
        reviewFlowController: null,
    };

    const controller = new DeckSessionController(plugin as never, store as never, {
        createView: () => view as never,
    });
    return { controller, recorded, written, bundle, plugin };
}

function leaf(): unknown {
    return { view: { containerEl: {} }, openFile: async () => undefined };
}

test('a sitting opens on the deck’s own queue: learning, then reviews, then new', async () => {
    const bundle = bundleWith([
        { id: 'review-due', type: AnkiCardType.Review, queue: AnkiCardQueue.Review, interval: 5, due: 0 },
        { id: 'learning-due', type: AnkiCardType.Learning, queue: AnkiCardQueue.Learning, interval: -600, due: NOW - 1000 },
        { id: 'new-a' },
        { id: 'new-b' },
    ]);
    const { controller, recorded } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');

    assert.deepEqual(recorded.shown.map(card => card.card.id), ['learning-due'], 'one card at a time');
    assert.equal(recorded.mounts, 1);
    assert.equal(recorded.shown[0].view.mode, 'flip');
    assert.equal(recorded.shown[0].total, 4);
    assert.equal(recorded.shown[0].preview.good.length > 0, true, 'the buttons know their intervals');

    // Walking the sitting shows the order: the learning card that is due, then the
    // review, then the new cards in the order they were added.
    await controller.answer(AnkiGrade.Easy);
    await controller.answer(AnkiGrade.Easy);
    await controller.answer(AnkiGrade.Easy);
    assert.deepEqual(
        recorded.shown.map(card => card.card.id),
        ['learning-due', 'review-due', 'new-a', 'new-b'],
    );
});

test('answering writes that card back and moves to the next one', async () => {
    const bundle = bundleWith([{ id: 'a' }, { id: 'b' }]);
    const { controller, recorded, written } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    assert.equal(controller.currentCard()?.card.id, 'a');

    const result = await controller.answer(AnkiGrade.Good);
    assert.equal(result?.card.id, 'a');
    assert.equal(written.length, 1, 'the card went back to the deck on its own');
    assert.equal(written[0].cards[0].reviews, 1, 'and it was counted');
    assert.equal(written[0].cards[0].queue, AnkiCardQueue.Learning, 'a new card answered good is in learning');
    assert.equal(recorded.shown.map(card => card.card.id).join(','), 'a,b', 'the surface moved on');
});

test('a sibling of the card just answered waits until tomorrow, as in Anki', async () => {
    const bundle = bundleWith([{ id: 'front', noteId: 'shared' }, { id: 'back', noteId: 'shared' }, { id: 'other' }]);
    const { controller, recorded, written } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    await controller.answer(AnkiGrade.Good);

    const buried = bundle.cards.find(card => card.id === 'back');
    assert.equal(buried?.queue, AnkiCardQueue.SchedBuried, 'sibling burying uses Anki’s own queue value');
    assert.equal(written.some(entry => entry.cards.some(card => card.id === 'back')), true, 'and is written back');
    assert.deepEqual(
        recorded.shown.map(card => card.card.id),
        ['front', 'other'],
        'the buried sibling is out of the sitting, not shown and skipped',
    );
});

test('the sitting ends when the queue runs out, and says what was done', async () => {
    const bundle = bundleWith([{ id: 'only' }]);
    const { controller, recorded } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    await controller.answer(AnkiGrade.Easy);

    assert.equal(recorded.finished.length, 1);
    assert.equal(recorded.finished[0].answered, 1);
    assert.equal(controller.currentCard(), null);
});

test('a card in learning is not finished with: it is due again inside the sitting', async () => {
    const bundle = bundleWith([{ id: 'step-one' }, { id: 'step-two' }]);
    const { controller, recorded } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    await controller.answer(AnkiGrade.Again);

    // It went to the back of the queue rather than out of the sitting: the
    // reader will see it again, which is what a one-minute step means.
    assert.deepEqual(recorded.shown.map(card => card.card.id), ['step-one', 'step-two']);

    await controller.answer(AnkiGrade.Good);
    assert.deepEqual(
        recorded.shown.map(card => card.card.id),
        ['step-one', 'step-two', 'step-one'],
        'the card that came back is asked again',
    );
    assert.equal(recorded.finished.length, 0, 'and the sitting is not over');
});

test('skipping puts a card back without touching its schedule', async () => {
    const bundle = bundleWith([{ id: 'a' }, { id: 'b' }]);
    const { controller, recorded, written } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    assert.deepEqual(recorded.shown.map(card => card.card.id), ['a'], 'it opens on the first card');

    controller.skip();
    assert.deepEqual(recorded.shown.map(card => card.card.id), ['a', 'b'], 'the next card, not the same one');

    controller.skip();
    assert.deepEqual(recorded.shown.map(card => card.card.id), ['a', 'b', 'a'], 'and the skipped cards come round again');
    assert.equal(written.length, 0, 'nothing was written for a skip');
});

test('a rating is remembered for the sitting’s score, and a rebuild keeps it', async () => {
    const bundle = bundleWith([{ id: 'a' }, { id: 'b' }]);
    const { controller } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md');
    await controller.answer(AnkiGrade.Good);
    const before = controller.summary();
    assert.equal(before?.answered, 1);

    await controller.rebuild();
    const after = controller.summary();
    assert.equal(after?.answered, 1, 'what was answered stays answered');
});

test('the day a deck counts from is the collection’s creation, not its id', () => {
    // 1789628529 is a real collection stamp in seconds (2026-09-17); the deck id
    // beside it is a different moment entirely (2023). Anki counts a review
    // card's due date from the former, so that is what the sitting must use.
    const fromStamp = deckDayBase('1700000000000', 1789628529);
    assert.equal(fromStamp, Date.UTC(2026, 8, 17));

    // A hand-written deck has no crt: its id is the moment the document was made.
    assert.equal(deckDayBase(String(Date.UTC(2026, 9, 17, 8)), null), Date.UTC(2026, 9, 17));

    // Milliseconds are accepted too, rather than being multiplied again.
    assert.equal(deckDayBase('1', 1789628529000), Date.UTC(2026, 8, 17));
});

/** A sitting over several decks, to prove the combined queue behaves. */
function makeCombined(named: Array<[string, DeckBundle]>): {
    controller: DeckSessionController;
    recorded: Recorded;
    written: { path: string; cards: AnkiCard[] }[];
} {
    const recorded: Recorded = { shown: [], finished: [], mounts: 0, destroys: 0 };
    const written: { path: string; cards: AnkiCard[] }[] = [];
    const byPath = new Map(named);
    const { handlers } = standInHandlers();

    const view = {
        mountInto: () => { recorded.mounts += 1; },
        show: (card: DeckSessionCard) => { recorded.shown.push(card); },
        finish: (summary: DeckSessionSummary | null) => { if (summary) recorded.finished.push(summary); },
        pulse: () => undefined,
        destroy: () => undefined,
        isAnswering: () => true,
    };

    const store = {
        listDecks: async () => named.map(([path, bundle]) => ({
            path,
            name: bundle.deck.name,
            id: bundle.deck.id,
            counts: { newCount: bundle.cards.length, learningCount: 0, reviewCount: 0, totalCards: bundle.cards.length, dueToday: bundle.cards.length },
            mediaCount: 0,
            modified: NOW,
            warnings: [],
        })),
        readDeck: async (path: string) => byPath.get(path) as DeckBundle,
        updateCardStates: async (path: string, cards: AnkiCard[]) => { written.push({ path, cards }); return 'in-place' as const; },
        writeDeck: async () => path => path,
    };

    const plugin = {
        app: { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => leaf() } },
        settings: { reviewSessionPlacement: 'split', mcqGradingMode: 'ask' },
        // The other lane, which the finish screen asks about, and the dock it
        // would hand its panel back to: neither is up in these tests.
        reviewScheduleService: { getDueNotes: () => [] },
        reviewFlowController: null,
    };

    const controller = new DeckSessionController(plugin as never, store as never, {
        createView: () => view as never,
    });
    return { controller, recorded, written };
}

test('studying everything due takes one queue across every deck, decks taking turns', async () => {
    const one = bundleWith([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]);
    one.deck.name = 'Deck A';
    const two = bundleWith([{ id: 'b1' }]);
    two.deck.name = 'Deck B';

    const { controller, recorded } = makeCombined([
        ['spaceforge/decks/A.md', one],
        ['spaceforge/decks/B.md', two],
    ]);

    await controller.startAllDue();

    assert.equal(recorded.mounts, 1);
    assert.equal(controller.currentCard()?.deckName, 'Deck A');
    assert.equal(controller.summary()?.deckCount, 2);
    assert.equal(controller.summary()?.deckName, 'your decks');

    // Interleaved, not laid end to end: A, B, A, A.
    await controller.answer(AnkiGrade.Easy);
    assert.equal(recorded.shown.map(card => card.card.id).join(','), 'a1,b1');
    assert.equal(recorded.shown[1].deckName, 'Deck B', 'and each card knows its deck');
});

test('in a combined sitting every answer lands in its own deck’s file', async () => {
    const one = bundleWith([{ id: 'a1' }]);
    const two = bundleWith([{ id: 'b1' }]);
    const { controller, written } = makeCombined([
        ['spaceforge/decks/A.md', one],
        ['spaceforge/decks/B.md', two],
    ]);

    await controller.startAllDue();
    await controller.answer(AnkiGrade.Good);
    await controller.answer(AnkiGrade.Good);

    assert.deepEqual(written.map(entry => entry.path), ['spaceforge/decks/A.md', 'spaceforge/decks/B.md']);
    assert.equal(written[0].cards[0].id, 'a1');
    assert.equal(written[1].cards[0].id, 'b1');
});

test('a deck with nothing due is left out of a combined sitting', async () => {
    const due = bundleWith([{ id: 'x1' }]);
    const resting = bundleWith([]);
    const { controller } = makeCombined([
        ['spaceforge/decks/Due.md', due],
        ['spaceforge/decks/Resting.md', resting],
    ]);

    await controller.startAllDue();
    assert.equal(controller.summary()?.deckCount, 1, 'a deck that owes nothing is not a participant');
    assert.equal(controller.currentCard()?.card.id, 'x1');
});

test('a question clicked in the browser opens the sitting on that question', async () => {
    const bundle = bundleWith([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
    const { controller, recorded } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md', { fromCardId: 'three' });

    assert.equal(controller.currentCard()?.card.id, 'three');
    await controller.answer(AnkiGrade.Good);
    assert.equal(recorded.shown.map(card => card.card.id).join(','), 'three,one', 'and the rest follow in their own order');
});

test('a card that is not due still opens when it is the one asked for', async () => {
    const bundle = bundleWith([
        { id: 'due-now' },
        { id: 'suspended', queue: AnkiCardQueue.Suspended },
    ]);
    const { controller } = makeSitting(bundle);

    await controller.start('spaceforge/decks/Test deck.md', { fromCardId: 'suspended' });
    assert.equal(controller.currentCard()?.card.id, 'suspended');
});

// ---------------------------------------------------------------------------
// Where a sitting lives: in the review dock when a review bar is up, in the
// configured placement (modal / pane / window) when there is no dock.
// ---------------------------------------------------------------------------

test('with a review bar up, the sitting is docked under it instead of taking a pane', async () => {
    const bundle = bundleWith([{ id: 'a' }, { id: 'b' }]);
    const { controller, recorded, plugin } = makeSitting(bundle);
    let asked = 0;
    let mountedInto: unknown = null;
    let dockTeardown: (() => void) | null = null;
    const dockPanel = { isDock: true } as unknown as HTMLElement;
    plugin.reviewFlowController = {
        showCardSitting: (mount: (container: HTMLElement) => () => void) => {
            asked += 1;
            mountedInto = dockPanel;
            dockTeardown = mount(dockPanel);
            return true;
        },
    };

    await controller.start('spaceforge/decks/Test deck.md');

    assert.equal(asked, 1, 'the flow was asked for a dock first');
    assert.equal(recorded.mounts, 1, 'the sitting mounted, once');
    assert.equal(mountedInto, dockPanel, 'inside the panel the dock handed over');
    assert.ok(dockTeardown, 'and the dock holds the surface\'s teardown');
    assert.equal(controller.isActive(), true, 'the sitting lives');
    assert.equal(controller.currentCard()?.card.id, 'a');

    // The sitting ending gives the docked surface back.
    controller.end();
    assert.equal(recorded.destroys, 1, 'ending the sitting ran the docked surface\'s teardown');
    assert.equal(controller.isActive(), false);
});

test('without a dock the sitting falls back to the configured placement', async () => {
    const bundle = bundleWith([{ id: 'a' }]);
    const { controller, recorded, plugin } = makeSitting(bundle);
    let asked = 0;
    plugin.reviewFlowController = {
        showCardSitting: () => {
            asked += 1;
            return false;
        },
    };

    await controller.start('spaceforge/decks/Test deck.md');

    assert.equal(asked, 1, 'the flow was asked first, and said no');
    assert.equal(recorded.mounts, 1, 'the sitting took the pane the setting asks for');
    assert.equal(controller.isActive(), true);

    controller.end();
    assert.equal(recorded.destroys, 1, 'and its own teardown ends it as before');
    assert.equal(controller.isActive(), false);
});

test('a host move that re-makes the dock panel brings the card back, not a blank panel', async () => {
    const bundle = bundleWith([{ id: 'a' }, { id: 'b' }]);
    const { controller, recorded, plugin } = makeSitting(bundle);

    // The dock hands a panel over and keeps the mount closure, as ReviewDock
    // does. A host move can end with the dock re-making the panel — the old one
    // was detached — and a re-made panel mounts the sitting into itself again.
    let remount: (() => void) | null = null;
    const panel = { isDockPanel: true };
    plugin.reviewFlowController = {
        showCardSitting: (mount: (container: HTMLElement) => () => void) => {
            remount = () => { mount(panel as unknown as HTMLElement); };
            mount(panel as unknown as HTMLElement);
            return true;
        },
    };

    await controller.start('spaceforge/decks/Test deck.md');
    assert.equal(controller.currentCard()?.card.id, 'a');

    remount!();

    assert.equal(controller.isActive(), true, 'the sitting survived the move');
    assert.equal(controller.currentCard()?.card.id, 'a', 'and is still the card the reader was on');
    assert.equal(recorded.mounts, 2, 'the surface was made again for the panel it was handed');
    assert.equal(recorded.destroys, 1, 'the old surface was given back, not leaked');
    assert.equal(recorded.shown.at(-1)?.card.id, 'a', 'and the fresh surface shows the card, not a blank');
});

test('the sitting\'s summary says how many notes are still waiting', async () => {
    const bundle = bundleWith([{ id: 'a' }]);
    const { controller, plugin } = makeSitting(bundle);
    plugin.reviewScheduleService = { getDueNotes: () => [{ path: 'notes/x.md' }, { path: 'notes/y.md' }] };

    await controller.start('spaceforge/decks/Test deck.md');

    assert.equal(controller.summary()?.notesWaiting, 2, 'the finish screen can offer the way back');
});
