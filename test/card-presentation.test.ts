/**
 * The presentation layer: how a card asks its question, and how the answer is
 * judged. Two things are pinned here — the pure engine, and the round trip
 * through the deck document, because the file is meant to be edited by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AnkiCard, AnkiCardQueue, AnkiCardType, AnkiNote } from '../models/anki';
import {
    blankCloze,
    clozeAnswerText,
    clozeOrdinals,
    compareTypedAnswer,
    isClozeNote,
    judgeChoice,
    modeLabel,
    resolvePresentation,
    revealCloze,
} from '../models/card-presentation';
import { newDeck, parseDeck, serializeDeck } from '../models/deck-document';

function note(overrides: Partial<AnkiNote> = {}): AnkiNote {
    return {
        id: '1700000000001',
        modelName: 'Basic',
        fields: ['Front', 'Back'],
        values: ['What organelle makes ATP?', 'The mitochondrion.'],
        tags: ['cells'],
        cardIds: ['1700000000011'],
        mediaFiles: [],
        ...overrides,
    };
}

function card(overrides: Partial<AnkiCard> = {}): AnkiCard {
    return {
        id: '1700000000011',
        noteId: '1700000000001',
        deckId: '1700000000000',
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: 1_700_000_000_000,
        newPosition: 1,
        flag: 0,
        ...overrides,
    };
}

// ------------------------------------------------------------------- the engine

test('a two-field note is a flip card, and its second card asks the other way round', () => {
    const forward = resolvePresentation(note(), card());
    assert.equal(forward.mode, 'flip');
    assert.equal(forward.front, 'What organelle makes ATP?');
    assert.equal(forward.back, 'The mitochondrion.');

    // ord 1 is the flip matrix's other half: back to front.
    const backward = resolvePresentation(note(), card({ ord: 1 }));
    assert.equal(backward.mode, 'flip');
    assert.equal(backward.front, 'The mitochondrion.');
    assert.equal(backward.back, 'What organelle makes ATP?');
});

test('a one-field note with cloze markers is a cloze card', () => {
    const clozeNote = note({
        modelName: 'Cloze',
        fields: ['Text'],
        values: ['The {{c1::mitochondrion}} makes ATP, and the {{c2::Golgi apparatus::Golgi}} packages proteins.'],
    });
    assert.equal(isClozeNote(clozeNote), true);
    assert.deepEqual(clozeOrdinals(clozeNote.values[0]), [1, 2]);

    const first = resolvePresentation(clozeNote, card({ ord: 0 }));
    assert.equal(first.mode, 'cloze');
    assert.equal(first.clozeOrdinal, 1);
    assert.equal(first.front, 'The [...] makes ATP, and the Golgi apparatus packages proteins.');
    assert.equal(first.back, 'The **mitochondrion** makes ATP, and the Golgi apparatus packages proteins.');

    // The hint form is what the reader sees in the blank.
    const hinted = note({ values: ['The {{c1::mitochondrion::powerhouse}} makes ATP.'] });
    assert.equal(blankCloze(hinted.values[0], 1), 'The [powerhouse] makes ATP.');
    assert.equal(clozeAnswerText(hinted.values[0], 1), 'mitochondrion');
});

test('a hand-written card with markers is a cloze card, however many fields it has', () => {
    // The file writes the same text into both fields of a two-field note, so the
    // markers — not the field count — have to be what decides.
    const written = note({ values: ['The {{c1::mitochondrion}} makes ATP.', 'The {{c1::mitochondrion}} makes ATP.'] });
    const view = resolvePresentation(written, card({ ord: 0 }));
    assert.equal(view.mode, 'cloze');
    assert.equal(view.clozeOrdinal, 1);
    assert.equal(view.front, 'The [...] makes ATP.');
    assert.equal(view.answerText, 'mitochondrion');

    // ord 1 asks about the second deletion when the text has one.
    const twoDeletions = note({ values: ['{{c1::alpha}} then {{c2::beta}}', '{{c1::alpha}} then {{c2::beta}}'] });
    assert.equal(resolvePresentation(twoDeletions, card({ ord: 1 })).clozeOrdinal, 2);
});

test('a cloze back carries the note’s extra fields, as Anki’s template does', () => {
    const withExtra = note({
        fields: ['Text', 'Extra'],
        values: ['The {{c1::mitochondrion}} makes ATP.', 'page 2'],
    });
    const view = resolvePresentation(withExtra, card());
    assert.equal(view.front, 'The [...] makes ATP.', 'the front is the cloze text alone');
    assert.equal(view.back, 'The **mitochondrion** makes ATP.\n\npage 2');
    assert.equal(view.answerText, 'mitochondrion', 'but only the deletion is compared');
});

test('a cloze card asking about several deletions accepts them in any order', () => {
    const view = resolvePresentation(
        note({ values: ['{{c1::alpha}} and {{c1::beta}}'] }),
        card(),
    );
    assert.equal(clozeAnswerText('{{c1::alpha}} and {{c1::beta}}', 1), 'alpha, beta');
    assert.equal(view.mode, 'cloze');

    const textual = resolvePresentation(
        note({ values: ['{{c1::alpha}} and {{c1::beta}}'] }),
        card(),
    );
    assert.equal(compareTypedAnswer('alpha, beta', textual), true);
    assert.equal(compareTypedAnswer('beta, alpha', textual), true, 'order does not matter');
    assert.equal(compareTypedAnswer('alpha', textual), false, 'both are required');
});

test('a card can ask multiple choice, and a wrong choice is wrong', () => {
    const view = resolvePresentation(
        note(),
        card({ presentation: { mode: 'mcq', choices: ['The nucleus', 'The mitochondrion', 'The Golgi apparatus'], answer: 1 } }),
    );
    assert.equal(view.mode, 'mcq');
    assert.deepEqual(view.choices, ['The nucleus', 'The mitochondrion', 'The Golgi apparatus']);
    assert.equal(view.answerIndex, 1);
    assert.equal(judgeChoice(view, 1), 'correct');
    assert.equal(judgeChoice(view, 0), 'wrong');

    const unanswered = resolvePresentation(note(), card({ presentation: { mode: 'mcq', choices: ['a', 'b'] } }));
    assert.equal(unanswered.answerIndex, -1, 'no answer marked');
    assert.equal(judgeChoice(unanswered, 0), 'unknown', 'so nothing is claimed either way');
});

test('a typed answer is compared exactly, unless the card says otherwise', () => {
    const strict = resolvePresentation(note(), card({ presentation: { mode: 'type' } }));
    assert.equal(compareTypedAnswer('The mitochondrion.', strict), true);
    assert.equal(compareTypedAnswer('the mitochondrion.', strict), false, 'case counts by default');
    assert.equal(compareTypedAnswer('  The mitochondrion.  ', strict), true, 'stray space does not');
    assert.equal(compareTypedAnswer('<div>The mitochondrion.</div>', strict), true, 'markup does not');

    const relaxed = resolvePresentation(
        note(),
        card({ presentation: { mode: 'type', caseInsensitive: true } }),
    );
    assert.equal(compareTypedAnswer('the mitochondria.', relaxed), false);
    assert.equal(compareTypedAnswer('THE MITOCHONDRION.', relaxed), true);

    // Accents: the card is written with one, and the reader may leave it out —
    // but capitalisation still counts, because that is a separate modifier.
    const accents = resolvePresentation(
        note({ values: ['Which cell?', 'La mitocóndria'] }),
        card({ presentation: { mode: 'type', ignoreDiacritics: true } }),
    );
    assert.equal(compareTypedAnswer('La mitocondria', accents), true);
    assert.equal(compareTypedAnswer('la mitocóndria', accents), false, 'case still counts');

    const both = resolvePresentation(
        note({ values: ['Which cell?', 'La mitocóndria'] }),
        card({ presentation: { mode: 'type', ignoreDiacritics: true, caseInsensitive: true } }),
    );
    assert.equal(compareTypedAnswer('la mitocondria', both), true, 'both modifiers at once');

    const listed = resolvePresentation(
        note(),
        card({ presentation: { mode: 'type', accept: ['mitochondrion', 'the mitochondrion'] } }),
    );
    assert.equal(compareTypedAnswer('mitochondrion', listed), true, 'another spelling the card allows');
    assert.equal(compareTypedAnswer('', listed), false, 'an empty answer is never right');
});

test('each mode has a label a person can read', () => {
    assert.equal(modeLabel('flip'), 'Flip');
    assert.equal(modeLabel('mcq'), 'Multiple choice');
    assert.equal(modeLabel('type'), 'Typed answer');
    assert.equal(modeLabel('cloze'), 'Cloze');
});

// ------------------------------------------------------------- the written file

function deckWith(cards: AnkiCard[], notes: AnkiNote[]): string {
    const bundle = newDeck('Cell Biology::Organelles', {}, 1_700_000_000_000);
    const built = {
        ...bundle,
        cards: cards.map(entry => ({ ...entry, deckId: bundle.deck.id })),
        notes: notes.map(entry => ({ ...entry, cardIds: cards.filter(c => c.noteId === entry.id).map(c => c.id) })),
    };
    return serializeDeck(built);
}

test('multiple choice survives a trip through the file', () => {
    const text = deckWith(
        [card({ presentation: { mode: 'mcq', choices: ['The nucleus', 'The mitochondrion'], answer: 1 } })],
        [note()],
    );

    // The options are written out where a person can edit them.
    assert.match(text, /\*\*Q\*\*: What organelle makes ATP\?/);
    assert.match(text, /1\. The nucleus/);
    assert.match(text, /2\. The mitochondrion/);
    const answerAt = text.indexOf('**A**:');
    assert.ok(text.indexOf('2. The mitochondrion') < answerAt, 'options come before the answer');

    const parsed = parseDeck(text, 'spaceforge/decks/Cell Biology.md');
    assert.equal(parsed.cards.length, 1);
    assert.equal(parsed.cards[0].presentation?.mode, 'mcq');
    assert.deepEqual(parsed.cards[0].presentation?.choices, ['The nucleus', 'The mitochondrion']);
    assert.equal(parsed.cards[0].presentation?.answer, 1);

    // And the file is a fixed point: writing back gives the same text.
    assert.equal(serializeDeck(parsed), text);
});

test('a hand-written multiple-choice card needs nothing but the list', () => {
    const text = [
        '---',
        'sf-deck: 1',
        'id: "1700000000999"',
        'name: "Hand written"',
        'modified: 1700000000000',
        'cards: 1',
        '---',
        '',
        '# Hand written',
        '',
        '## Anything for a heading',
        '**Q**: Which organelle makes ATP?',
        '1. The nucleus',
        '2. The mitochondrion',
        '**A**: The mitochondrion.',
        '',
    ].join('\n');

    const parsed = parseDeck(text, 'spaceforge/decks/Hand written.md');
    assert.equal(parsed.cards.length, 1);
    assert.equal(parsed.cards[0].presentation?.mode, 'mcq', 'listing the options is enough to say so');
    assert.deepEqual(parsed.cards[0].presentation?.choices, ['The nucleus', 'The mitochondrion']);
    assert.equal(parsed.cards[0].presentation?.answer, -1, 'the answer is the author\u2019s to mark');
    assert.equal(parsed.notes[0].values[0], 'Which organelle makes ATP?', 'the question kept its text');
    assert.equal(parsed.notes[0].values[1], 'The mitochondrion.');
});

test('a typed card keeps its comparison rules in the file', () => {
    const text = deckWith(
        [card({ presentation: { mode: 'type', accept: ['mitochondrion'], caseInsensitive: true } })],
        [note()],
    );
    assert.match(text, /"mode":"type"/);
    assert.match(text, /"ci":true/);

    const parsed = parseDeck(text, 'spaceforge/decks/Typed.md');
    const presentation = parsed.cards[0].presentation;
    assert.equal(presentation?.mode, 'type');
    assert.equal(presentation?.caseInsensitive, true);
    assert.deepEqual(presentation?.accept, ['mitochondrion']);
    assert.equal(serializeDeck(parsed), text);
});

test('an unknown mode is a warning, not a broken card', () => {
    const text = deckWith([card()], [note()]).replace('"flag":0', '"flag":0,"mode":"quiz"');
    const parsed = parseDeck(text, 'spaceforge/decks/Odd.md');
    assert.equal(parsed.cards[0].presentation, undefined, 'the card keeps its default reading');
    assert.equal(parsed.cards[0].queue, AnkiCardQueue.New);
});
