/**
 * The merge between a deck that arrived from Anki and the one in the vault.
 *
 * The property under test is the one the feature exists for: an answer made in
 * Anki must survive a package import, an answer made in the vault must survive
 * one too, and neither may be decided by "whoever synced last". Every case
 * therefore states *which* side is newer and checks the schedule that comes out
 * — plus the counts the reader is shown.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    AnkiDeck,
    AnkiNote,
    DeckBundle,
    DEFAULT_DECK_OPTIONS,
} from '../models/anki';
import {
    cardMod,
    mergeDeckBundles,
    mergeSummary,
    noteMod,
    sameCardState,
} from '../models/deck-merge';

const NOW = 1_700_000_000_000;
const DECK_ID = '1700000000000';

function deck(overrides: Partial<AnkiDeck> = {}): AnkiDeck {
    return {
        id: DECK_ID,
        name: 'Cell Biology',
        modified: NOW,
        options: { ...DEFAULT_DECK_OPTIONS, learningSteps: [...DEFAULT_DECK_OPTIONS.learningSteps] },
        ...overrides,
    };
}

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

function note(id: string, values: string[], overrides: Partial<AnkiNote> = {}): AnkiNote {
    return {
        id,
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values,
        tags: [],
        cardIds: [`card-${id}`],
        mediaFiles: [],
        ...overrides,
    };
}

function bundle(cards: AnkiCard[], notes: AnkiNote[] = [], overrides: Partial<DeckBundle> = {}): DeckBundle {
    return { deck: deck(), cards, notes, media: [], ...overrides };
}

// --------------------------------------------------------------- the merge

test('a newer answer from Anki replaces the vault state, an older one does not', () => {
    const vault = bundle([card('a', { interval: 3, mod: NOW }), card('b', { interval: 7, mod: NOW })]);
    const fromAnki = bundle([
        card('a', { interval: 12, mod: NOW + 60_000 }),
        card('b', { interval: 2, mod: NOW - 60_000 }),
    ]);

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.equal(merged.cards.find(c => c.id === 'a')?.interval, 12, 'the package was newer');
    assert.equal(merged.cards.find(c => c.id === 'b')?.interval, 7, 'the vault was newer');
    assert.equal(report.cards.taken, 1);
    assert.equal(report.cards.kept, 1);
    assert.deepEqual(
        report.resolved.map(entry => [entry.cardId, entry.winner]),
        [['a', 'incoming'], ['b', 'local']]
    );
});

test('an identical schedule is untouched, whatever the stamps claim', () => {
    // Anki's stamps are whole seconds, so a package can look "newer" while
    // carrying exactly the state the vault already has. That must not count as
    // an update, or every import would report a merge that changed nothing.
    const same = { interval: 5, mod: NOW };
    const vault = bundle([card('a', same)]);
    const fromAnki = bundle([card('a', { ...same, mod: NOW + 5_000 })]);

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.equal(report.cards.unchanged, 1);
    assert.equal(report.cards.taken, 0);
    assert.equal(report.resolved.length, 0);
    assert.equal(merged.cards[0].mod, NOW, 'the vault copy is kept as it was');
});

test('cards only one side has are kept, and added ones are counted', () => {
    const vault = bundle([card('a')]);
    const fromAnki = bundle([card('b'), card('c')]);

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.deepEqual(merged.cards.map(c => c.id).sort(), ['a', 'b', 'c']);
    assert.equal(report.cards.kept, 1);
    assert.equal(report.cards.added, 2);
    assert.ok(merged.cards.every(c => c.deckId === DECK_ID), 'every card belongs to the vault deck');
});

test('a card added in Anki and one added in the vault both survive', () => {
    const vault = bundle([card('a'), card('vault-new')]);
    const fromAnki = bundle([card('a'), card('anki-new')]);

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.deepEqual(merged.cards.map(c => c.id).sort(), ['a', 'anki-new', 'vault-new']);
    assert.equal(report.cards.added, 1);
    assert.equal(report.cards.kept, 1, 'the vault-only card is kept');
});

test('a note is decided by its own modified stamp, not the deck clock', () => {
    const vault = bundle(
        [card('a', { noteId: 'n1', mod: NOW }), card('b', { noteId: 'n2', mod: NOW })],
        [note('n1', ['What is ATP?', 'Energy currency.'], { modified: NOW + 9_000 }), note('n2', ['Q2', 'A2'], { modified: NOW })],
        { deck: deck({ modified: NOW }) }
    );
    const fromAnki = bundle(
        [card('a', { noteId: 'n1', mod: NOW }), card('b', { noteId: 'n2', mod: NOW })],
        [note('n1', ['What is ATP?', 'The energy currency of the cell.'], { modified: NOW + 1_000 }), note('n2', ['Q2 edited in Anki', 'A2'], { modified: NOW + 5_000 })]
    );

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.deepEqual(
        merged.notes.find(n => n.id === 'n1')?.values,
        ['What is ATP?', 'Energy currency.'],
        'the vault edited n1 later'
    );
    assert.deepEqual(
        merged.notes.find(n => n.id === 'n2')?.values,
        ['Q2 edited in Anki', 'A2'],
        'Anki edited n2 later'
    );
    assert.equal(report.notes.kept, 1);
    assert.equal(report.notes.taken, 1);
});

test('the deck keeps its own identity, name and options', () => {
    const vault = bundle([card('a')], [], {
        deck: deck({ name: 'Biology (mine)', options: { ...DEFAULT_DECK_OPTIONS, newPerDay: 5 } }),
    });
    const fromAnki = bundle([card('a', { interval: 9, mod: NOW + 1_000 })], [], {
        deck: deck({ id: '999', name: 'Biology', options: { ...DEFAULT_DECK_OPTIONS, newPerDay: 50 } }),
    });

    const { bundle: merged } = mergeDeckBundles(vault, fromAnki);

    assert.equal(merged.deck.id, DECK_ID);
    assert.equal(merged.deck.name, 'Biology (mine)');
    assert.equal(merged.deck.options.newPerDay, 5);
    assert.ok(merged.cards.every(c => c.deckId === DECK_ID), 'a package from another deck id is re-homed');
});

test('media the vault does not have is added; a shared name is not duplicated', () => {
    const vault = bundle([card('a')], [], {
        media: [{ path: 'spaceforge/decks/media/nucleus.png', originalName: 'nucleus.png' }],
    });
    const fromAnki = bundle([card('a')], [], {
        media: [
            { path: 'nucleus.png', originalName: 'nucleus.png' },
            { path: 'atp.png', originalName: 'atp.png' },
        ],
    });

    const { bundle: merged, report } = mergeDeckBundles(vault, fromAnki);

    assert.equal(report.mediaAdded, 1);
    assert.deepEqual(merged.media.map(entry => entry.originalName).sort(), ['atp.png', 'nucleus.png']);
    assert.equal(merged.media.find(entry => entry.originalName === 'nucleus.png')?.path, 'spaceforge/decks/media/nucleus.png');
});

test('review-log rows from both sides are unioned, never duplicated', () => {
    const row = (id: number) => [id, 'c1', 0, 3, 4, 2, 2500, 1500, 1];
    const vault = bundle([card('a')], [], { extra: { revlog: [row(1), row(2)] } });
    const fromAnki = bundle([card('a')], [], { extra: { revlog: [row(2), row(3)] } });

    const { bundle: merged } = mergeDeckBundles(vault, fromAnki);
    const rows = merged.extra?.revlog as unknown[][];

    assert.deepEqual(rows.map(entry => entry[0]), [1, 2, 3]);
});

test('raw per-card rows for a new card ride along without disturbing the vault ones', () => {
    const vault = bundle([card('a')], [], { extra: { cards: { a: { left: 2 } } } });
    const fromAnki = bundle([card('a'), card('b')], [], { extra: { cards: { a: { left: 9 }, b: { left: 1 } } } });

    const { bundle: merged } = mergeDeckBundles(vault, fromAnki);
    const rows = merged.extra?.cards as Record<string, Record<string, unknown>>;

    assert.equal(rows.a.left, 2, 'the vault row wins for a card both sides have');
    assert.equal(rows.b.left, 1, 'the new card brings its row');
});

// --------------------------------------------------------------- the stamp

test('cardMod prefers the real stamp, then FSRS, then the due date, then the deck', () => {
    assert.equal(cardMod(card('a', { mod: 111 }), 999), 111);
    assert.equal(
        cardMod(card('a', { memory: { stability: 1, difficulty: 5, lastReview: 222, scheduledDays: 3 } }), 999),
        222,
        'FSRS keeps the last review'
    );
    const due = NOW + 5 * 86_400_000;
    assert.equal(cardMod(card('a', { due, interval: 5 }), 999), NOW, 'due minus interval is when it was last seen');
    assert.equal(cardMod(card('a', { type: AnkiCardType.New, interval: 0, due: 0 }), 999), 999);
    assert.equal(cardMod(card('a', { interval: -600, due: NOW }), 999), 999, 'a learning step is not a review');
});

test('a card with no stamp of its own is not treated as older than the package', () => {
    // The case that matters for an upgrading vault: the document predates
    // `mod`, so its cards carry none. The estimate has to beat the package's
    // stale state, or the first import after the upgrade reverts every card.
    const reviewed = NOW - 2 * 86_400_000;
    const vault = bundle([card('a', { interval: 4, due: reviewed + 4 * 86_400_000 })], [], {
        deck: deck({ modified: NOW }),
    });
    const fromAnki = bundle([card('a', { interval: 30, due: NOW + 30 * 86_400_000, mod: NOW - 10 * 86_400_000 })], [], {
        deck: deck({ modified: NOW - 20 * 86_400_000 }),
    });

    const { report } = mergeDeckBundles(vault, fromAnki);

    assert.equal(report.cards.kept, 1, 'the vault reviewed this card after the package was exported');
    assert.equal(report.cards.taken, 0);
});

test('noteMod falls back to the deck only when the note has no stamp', () => {
    assert.equal(noteMod(note('n', ['a', 'b'], { modified: 5 }), 9), 5);
    assert.equal(noteMod(note('n', ['a', 'b']), 9), 9);
});

test('sameCardState ignores the stamp and compares the schedule', () => {
    assert.ok(sameCardState(card('a', { mod: 1 }), card('a', { mod: 2 })));
    assert.ok(!sameCardState(card('a'), card('a', { interval: 5 })));
    assert.ok(
        !sameCardState(card('a'), card('a', { presentation: { mode: 'mcq', choices: ['x', 'y'], answer: 1 } })),
        'presentation is part of what the reader sees'
    );
});

test('the merge summary says nothing when nothing changed', () => {
    const vault = bundle([card('a')]);
    const quiet = mergeDeckBundles(vault, bundle([card('a')], [], { deck: deck({ modified: NOW }) }));
    assert.equal(mergeSummary(quiet.report), null);

    const loud = mergeDeckBundles(vault, bundle([card('a', { interval: 9, mod: NOW + 1 }), card('b')]));
    assert.equal(mergeSummary(loud.report), '1 card updated from Anki, 1 new card');
});
