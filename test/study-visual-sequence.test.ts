/**
 * The interactive sequence, driven against the repo's mini-dom.
 *
 * The deck is dealt out of order (deterministically — the order comes from a
 * hash of the asset's own step ids, never `Math.random`), and it is *worked*,
 * not read: cards with no numbers on them, moved by the keyboard (Space lifts,
 * the arrows carry, Space drops, Escape puts back) through the pure `reorder`
 * every other route shares. Check draws a mark on every card and says the
 * tally; a move or a re-deal clears it. The ordered mode is a one-card
 * stepper, never a numbered list of everything.
 *
 * The pointer path — pointerdown / pointermove / pointerup, the ghost and the
 * insertion indicator — cannot be driven from this harness: `mini-dom` has no
 * pointer events and no layout, so `getBoundingClientRect` and pointer capture
 * do not exist here. That path is the parent's live check; what a unit test
 * can pin is that the cards are wired for it (`pointerdown` listener per card)
 * and that the drop it produces is `dropIndex` into the same tested `reorder`
 * the keyboard route uses.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { StudySequence, StudySequenceStep } from '../models/study-visuals';
import {
    StudyVisualSequenceView,
    dropIndex,
    inPlaceReport,
    isTrueOrder,
    nextShuffle,
    reorder,
    sequenceSeed,
    shuffleOrder,
} from '../ui/study-visual-sequence';

const repoRoot = process.cwd();
const CSS_PATH = 'styles/study-visual-sequence.css';
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// The surfaces reach for no document of their own, but the suite installs the
// element and document globals every mini-dom suite works against.
installMiniDocument();

// ------------------------------------------------------------------- fixtures

/** Six steps, in the order they truly belong in. */
function cascadeSteps(): StudySequenceStep[] {
    return [
        { id: 'injury', label: 'Vessel injury', detail: 'The endothelium is exposed' },
        { id: 'adhesion', label: 'Platelets adhere', detail: 'Von Willebrand factor holds them' },
        { id: 'plug', label: 'Platelet plug' },
        { id: 'cascade', label: 'Coagulation cascade', detail: 'Thrombin converts fibrinogen' },
        { id: 'mesh', label: 'Fibrin mesh', detail: 'Cross-linked by factor XIII' },
        { id: 'clot', label: 'Clot retraction' },
    ];
}

function shuffleSequence(): StudySequence {
    return {
        kind: 'sequence',
        title: 'Put the cascade in order',
        teach: 'The order the clotting factors act in',
        steps: cascadeSteps(),
        shuffle: true,
        pearl: 'The plug comes first; the mesh holds it.',
    };
}

function orderedSequence(): StudySequence {
    return {
        kind: 'sequence',
        title: 'The cascade, in order',
        teach: 'Read it down, one step at a time',
        steps: cascadeSteps().slice(0, 5),
        pearl: 'The plug comes first; the mesh holds it.',
    };
}

// -------------------------------------------------------------------- mounting

function host(): MiniElement {
    return new MiniElement('div');
}

function mountSequence(sequence: StudySequence, into: MiniElement = host()) {
    const view = new StudyVisualSequenceView();
    const teardown = view.mount(into as unknown as HTMLElement, sequence);
    return { view, into, teardown };
}

/** The ids on screen, in the order the reader has them. */
function drawnIds(into: MiniElement): string[] {
    return into.byClass('sf-vsq-card').map(card => card.attrs['data-step-id']);
}

/** The same order, as the step indices the pure model talks in. */
function orderPositions(sequence: StudySequence, ids: string[]): number[] {
    return ids.map(id => sequence.steps.findIndex(step => step.id === id));
}

/** One key to the card at `position`, as the reader's focus would deliver it. */
function press(into: MiniElement, position: number, key: string): MiniElement {
    const card = into.byClass('sf-vsq-card')[position];
    assert.ok(card, `no card at position ${position + 1} to press ${key} on`);
    card.dispatch('keydown', { key });
    return card;
}

/** Move one card with the keyboard alone: pick it up, arrow it there, drop it. */
function keyboardMove(into: MiniElement, from: number, to: number): void {
    press(into, from, ' ');
    let at = from;
    while (at !== to) {
        const step = to > at ? 1 : -1;
        press(into, at, step > 0 ? 'ArrowDown' : 'ArrowUp');
        at += step;
    }
    press(into, at, ' ');
}

/** Sort the deck into the true order using only the reader's own keys. */
function putInOrder(into: MiniElement, sequence: StudySequence): void {
    for (let position = 0; position < sequence.steps.length; position += 1) {
        const wanted = sequence.steps[position].id;
        for (let guard = 0; guard < sequence.steps.length * 2; guard += 1) {
            const cards = into.byClass('sf-vsq-card');
            const at = cards.findIndex(card => card.attrs['data-step-id'] === wanted);
            if (at <= position) break;
            keyboardMove(into, at, at - 1);
        }
    }
}

// ---------------------------------------------------------------- the deck

test('shuffle mode deals cards with no numbers on them, in the asset’s own seeded order', () => {
    const sequence = shuffleSequence();
    const { into } = mountSequence(sequence);

    assert.equal(into.byClass('sf-vsq')[0].attrs['data-mode'], 'shuffle');
    assert.equal(into.textOf('sf-vsq-teach'), sequence.teach);
    assert.match(into.textOf('sf-vsq-hint'), /Space/, 'the hint says how a card is picked up');

    // A board of drop positions, one card in each.
    const board = into.byClass('sf-vsq-board')[0];
    assert.ok(board, 'the cards sit in a board of drop positions');
    const slots = into.byClass('sf-vsq-slot');
    const cards = into.byClass('sf-vsq-card');
    assert.equal(slots.length, sequence.steps.length);
    assert.equal(cards.length, sequence.steps.length);
    slots.forEach((slot, index) => assert.equal(slot.byClass('sf-vsq-card').length, 1, `slot ${index + 1} holds one card`));

    // The order the reader is handed: the asset's own shuffle, drawn.
    const order = shuffleOrder(sequence.steps.length, sequenceSeed(sequence.steps), 0);
    assert.deepEqual(drawnIds(into), order.map(index => sequence.steps[index].id));
    assert.equal(isTrueOrder(order), false, 'the reader is handed them out of order');
    assert.equal(into.byClass('sf-vsq-list').length, 0, 'not a numbered list');

    // The complaint that started this: no card carries a position number. A
    // card says its step and, at most, its detail — nothing else.
    cards.forEach((card, index) => {
        const step = sequence.steps[order[index]];
        const expected = step.detail ? `${step.label}${step.detail}` : step.label;
        assert.equal(card.textContent, expected, 'a card is its step, and nothing else');
        assert.equal(card.byClass('sf-vsq-card-label')[0].textContent, step.label);
        for (const child of card.children) {
            assert.equal(/^\d+$/.test(child.textContent.trim()), false, `card ${index + 1} draws no position number`);
        }
    });
    assert.equal(into.byClass('sf-vsq-step-num').length, 0, 'the old numbered rows stay gone');

    // Cards are wired for both hands: the pointer lifts them, the keys operate
    // them, and each says its own state.
    cards.forEach(card => {
        assert.equal(card.attrs['tabindex'], '0', 'a card can be focused');
        assert.equal(card.listenerCount('pointerdown'), 1, 'the drag path is bound');
        assert.equal(card.listenerCount('keydown'), 1, 'the keyboard path is bound');
        assert.equal(card.attrs['aria-pressed'], 'false');
    });

    // Nothing is judged until Check is pressed.
    assert.equal(into.textOf('sf-vsq-report'), '');
    assert.equal(into.byClass('sf-vsq-glyph').length, 0, 'no mark is drawn before a check');
    assert.ok(cards.every(card => !card.hasClass('is-right') && !card.hasClass('is-wrong') && !card.hasClass('is-lifted')));

    assert.equal(into.textOf('sf-vsq-pearl-tag'), 'Pearl');
    assert.equal(into.textOf('sf-vsq-pearl-text'), sequence.pearl);
});

test('reorder moves one step, copies the caller’s array, and refuses a move that names nothing', () => {
    assert.deepEqual(reorder([0, 1, 2, 3], 0, 2), [1, 2, 0, 3], 'the first step lands third');
    assert.deepEqual(reorder([0, 1, 2, 3], 3, 0), [3, 0, 1, 2], 'the last step lands first');
    assert.deepEqual(reorder(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b']);

    // A move that names nothing is a no-op — and still a copy.
    const same = [0, 1, 2];
    const noop = reorder(same, 1, 1);
    assert.deepEqual(noop, same, 'equal indices are a no-op');
    assert.notEqual(noop, same, 'the caller’s array is never handed back');
    assert.deepEqual(reorder([0, 1, 2], -1, 1), [0, 1, 2], 'a position before the first is not one');
    assert.deepEqual(reorder([0, 1, 2], 0, 3), [0, 1, 2], 'a slot past the last is not one');
    assert.deepEqual(reorder([0, 1, 2], 7, 0), [0, 1, 2]);
    assert.deepEqual(reorder([0, 1, 2], 1.5, 2), [0, 1, 2], 'a fraction is not a position');
    assert.deepEqual(reorder([], 0, 0), [], 'an empty deck stays empty');
    assert.deepEqual(reorder([7], 0, 0), [7]);

    // The caller's deck is untouched, whatever the move was.
    const steps = cascadeSteps().map(step => step.id);
    const moved = reorder(steps, 0, 2);
    assert.deepEqual(steps, cascadeSteps().map(step => step.id));
    assert.deepEqual(moved, [steps[1], steps[2], steps[0], steps[3], steps[4], steps[5]]);
});

test('a drop lands where the indicator said, whatever gap the pointer named', () => {
    // The pointer names a gap (0 is above the first card, 6 below the sixth);
    // the move names the index the card ends up at.
    assert.equal(dropIndex(2, 0), 0, 'dropped above everything');
    assert.equal(dropIndex(2, 1), 1, 'dropped one gap up');
    assert.equal(dropIndex(2, 2), 2, 'dropped back into its own gap');
    assert.equal(dropIndex(2, 3), 2, 'dropped into the gap below itself: it leaves a gap behind');
    assert.equal(dropIndex(2, 4), 3, 'dropped one gap down');
    assert.equal(dropIndex(0, 6), 5, 'the first card dropped below the last');
    assert.equal(dropIndex(5, 0), 0, 'the last card dropped above the first');

    // And it composes with `reorder` exactly as the deck's own indices expect.
    const deck = ['a', 'b', 'c', 'd', 'e', 'f'];
    assert.deepEqual(reorder(deck, 2, dropIndex(2, 0)), ['c', 'a', 'b', 'd', 'e', 'f']);
    assert.deepEqual(reorder(deck, 0, dropIndex(0, 6)), ['b', 'c', 'd', 'e', 'f', 'a']);
    assert.deepEqual(reorder(deck, 4, dropIndex(4, 5)), deck, 'a drop into its own gap is no move at all');
});

test('the keyboard picks a card up, arrows it through the deck, and puts it down', () => {
    const sequence = shuffleSequence();
    const { into, view } = mountSequence(sequence);
    const before = drawnIds(into);

    // Space lifts the card under the focus, and moves nothing yet.
    press(into, 0, ' ');
    assert.ok(into.byClass('sf-vsq-card')[0].hasClass('is-lifted'), 'the picked card says so');
    assert.equal(into.byClass('sf-vsq-card')[0].attrs['aria-pressed'], 'true');
    assert.deepEqual(drawnIds(into), before, 'picking up changes no order');

    // The arrows carry it one drop position at a time, and it stays in hand.
    press(into, 0, 'ArrowDown');
    assert.deepEqual(drawnIds(into).slice(0, 2), [before[1], before[0]]);
    press(into, 1, 'ArrowDown');
    press(into, 2, 'ArrowDown');
    assert.deepEqual(drawnIds(into).slice(0, 4), [before[1], before[2], before[3], before[0]]);
    assert.deepEqual(
        into.byClass('sf-vsq-card').map(card => card.attrs['aria-pressed']),
        ['false', 'false', 'false', 'true', 'false', 'false'],
        'exactly the card in hand says it is lifted'
    );

    // It walks to the end of the deck and stops there rather than falling off.
    press(into, 3, 'ArrowDown');
    press(into, 4, 'ArrowDown');
    press(into, 5, 'ArrowDown');
    press(into, 5, 'ArrowDown');
    assert.equal(drawnIds(into)[5], before[0], 'the bottom is the bottom');
    assert.ok(into.byClass('sf-vsq-card')[5].hasClass('is-lifted'));

    // Space puts it down where it stands.
    press(into, 5, ' ');
    assert.ok(into.byClass('sf-vsq-card').every(card => !card.hasClass('is-lifted')));
    assert.ok(into.byClass('sf-vsq-card').every(card => card.attrs['aria-pressed'] === 'false'));
    assert.equal(drawnIds(into)[5], before[0]);
    assert.deepEqual([...drawnIds(into)].sort(), [...before].sort(), 'the same six steps, rearranged');

    // Enter and the public entry point a host without a browser drives do the
    // same thing: lift, carry, drop.
    const settled = drawnIds(into);
    const card = into.byClass('sf-vsq-card')[0];
    assert.equal(view.handleKey({ key: 'Enter', target: card } as unknown as KeyboardEvent), true);
    assert.ok(card.hasClass('is-lifted'));
    assert.equal(view.handleKey({ key: 'ArrowDown', target: card } as unknown as KeyboardEvent), true);
    assert.deepEqual(drawnIds(into).slice(0, 2), [settled[1], settled[0]]);
    assert.equal(view.handleKey({ key: ' ', target: into.byClass('sf-vsq-card')[1] } as unknown as KeyboardEvent), true);
    assert.ok(into.byClass('sf-vsq-card').every(candidate => !candidate.hasClass('is-lifted')));

    // A key the deck has no use for is left for whoever else wants it.
    assert.equal(view.handleKey({ key: 'q', target: into.byClass('sf-vsq-card')[0] } as unknown as KeyboardEvent), false);
    assert.equal(view.handleKey({ key: 'ArrowUp', target: null } as unknown as KeyboardEvent), false);
});

test('a lifted card can be put back: Escape undoes the whole lift', () => {
    const sequence = shuffleSequence();
    const { into } = mountSequence(sequence);
    const before = drawnIds(into);

    press(into, 0, ' ');
    press(into, 0, 'ArrowDown');
    press(into, 1, 'ArrowDown');
    assert.notDeepEqual(drawnIds(into), before, 'the deck really moved');

    press(into, 2, 'Escape');
    assert.deepEqual(drawnIds(into), before, 'Escape is the undo of the lift');
    assert.ok(into.byClass('sf-vsq-card').every(card => !card.hasClass('is-lifted')));
    assert.ok(into.byClass('sf-vsq-card').every(card => card.attrs['aria-pressed'] === 'false'));

    // A lift that moved nothing can be dropped without any change at all.
    press(into, 0, ' ');
    press(into, 0, 'Escape');
    assert.deepEqual(drawnIds(into), before);
    assert.ok(into.byClass('sf-vsq-card').every(card => !card.hasClass('is-lifted')));
});

test('a move keeps the keyboard on the card that moved, so it can keep moving', () => {
    // The harness's `focus()` is a no-op, so it is spied on for this check: a
    // card that reorders must carry the reader's place with it, or the next
    // arrow key reaches nothing.
    const focused: MiniElement[] = [];
    const original = MiniElement.prototype.focus;
    MiniElement.prototype.focus = function focus(this: MiniElement): void {
        focused.push(this);
    };
    try {
        const { into } = mountSequence(shuffleSequence());
        const before = drawnIds(into);

        press(into, 0, ' ');
        focused.length = 0;
        press(into, 0, 'ArrowDown');

        const cards = into.byClass('sf-vsq-card');
        assert.equal(focused[focused.length - 1], cards[1], 'the focus followed the card it moved with');
        assert.equal(cards[1].attrs['data-step-id'], before[0]);
        assert.ok(cards[1].hasClass('is-lifted'));

        // Dropping lands the focus on the card that was put down, and picking
        // a card up puts it there in the first place.
        focused.length = 0;
        press(into, 1, ' ');
        assert.equal(focused[focused.length - 1], into.byClass('sf-vsq-card')[1]);
        focused.length = 0;
        press(into, 0, ' ');
        assert.equal(focused[focused.length - 1], into.byClass('sf-vsq-card')[0]);
    } finally {
        MiniElement.prototype.focus = original;
    }
});

test('Check draws a mark on every card, says the tally, and a move clears the verdict', () => {
    const sequence = shuffleSequence();
    const { into } = mountSequence(sequence);
    const check = into.byClass('sf-vsq-check')[0];
    assert.equal(check.tag, 'button');
    assert.equal(check.textContent, 'Check');

    // The tally is taken from what is on screen, not from the code under test.
    const handed = drawnIds(into);
    const inPlace = handed.filter((id, index) => id === sequence.steps[index].id).length;

    check.click();
    assert.equal(into.textOf('sf-vsq-report'), inPlaceReport(inPlace, sequence.steps.length));
    assert.match(into.textOf('sf-vsq-report'), /^\d+ of 6 in place$/, 'a short count, in the reader’s words');
    into.byClass('sf-vsq-card').forEach((card, index) => {
        const right = handed[index] === sequence.steps[index].id;
        assert.equal(card.hasClass('is-right'), right, `card ${index + 1} is marked against the true order`);
        assert.equal(card.hasClass('is-wrong'), !right);
    });

    // Every card carries a drawn mark: a coloured edge for the eye, a glyph
    // that stands for the words a reader hears.
    assert.equal(into.byClass('sf-vsq-glyph').length, sequence.steps.length, 'a glyph on every card');
    assert.equal(into.byClass('sf-vsq-glyph-check').length, inPlace);
    assert.equal(into.byClass('sf-vsq-glyph-cross').length, sequence.steps.length - inPlace);
    assert.deepEqual(
        into.byClass('sf-vsq-card-glyph').map(glyph => glyph.attrs['aria-label']),
        handed.map((id, index) => (id === sequence.steps[index].id ? 'In place' : 'Out of place')),
        'the glyph is readable without seeing it'
    );

    // A finished deck says so.
    putInOrder(into, sequence);
    check.click();
    assert.equal(into.textOf('sf-vsq-report'), '6 of 6 in place');
    assert.ok(into.byClass('sf-vsq-report')[0].hasClass('is-complete'), 'a finished order is marked as finished');
    assert.equal(into.byClass('sf-vsq-glyph-cross').length, 0);
    assert.equal(into.byClass('sf-vsq-card').filter(card => card.hasClass('is-wrong')).length, 0);

    // One adjacent swap leaves two cards out of place, honestly.
    keyboardMove(into, 0, 1);
    check.click();
    assert.equal(into.textOf('sf-vsq-report'), '4 of 6 in place', 'two cards out of place leave four in place');
    assert.equal(into.byClass('sf-vsq-glyph-cross').length, 2);
    assert.equal(into.byClass('sf-vsq-report')[0].hasClass('is-complete'), false);

    // The verdict belongs to the arrangement it was taken on: a move clears it.
    keyboardMove(into, 1, 0);
    assert.equal(into.textOf('sf-vsq-report'), '', 'a stale verdict is cleared the moment the order changes');
    assert.equal(into.byClass('sf-vsq-glyph').length, 0, 'and so is every drawn mark');
    assert.ok(into.byClass('sf-vsq-card').every(card => !card.hasClass('is-right') && !card.hasClass('is-wrong')));
    assert.deepEqual(
        into.byClass('sf-vsq-card-glyph').map(glyph => glyph.attrs['aria-label']),
        [undefined, undefined, undefined, undefined, undefined, undefined]
    );

    // A re-deal is a new arrangement too: the old verdict goes with the old order.
    check.click();
    assert.notEqual(into.textOf('sf-vsq-report'), '');
    into.byClass('sf-vsq-again')[0].click();
    assert.equal(into.textOf('sf-vsq-report'), '');
    assert.equal(into.byClass('sf-vsq-glyph').length, 0);
});

test('Shuffle again re-deals the asset’s own shuffles, deterministically', () => {
    const sequence = shuffleSequence();
    const { into } = mountSequence(sequence);
    const seed = sequenceSeed(sequence.steps);
    const again = into.byClass('sf-vsq-again')[0];
    assert.equal(again.textContent, 'Shuffle again');

    const first = drawnIds(into);
    again.click();
    const second = drawnIds(into);
    assert.notDeepEqual(second, first, 'pressing it does something visible');
    assert.deepEqual([...second].sort(), [...first].sort(), 'and it is still the same steps');
    assert.deepEqual(second, nextShuffle(sequence.steps.length, seed, 1, orderPositions(sequence, first)).map(index => sequence.steps[index].id));

    again.click();
    const third = drawnIds(into);
    assert.notDeepEqual(third, second);

    // Deterministic across mounts: the same asset is handed the same orders,
    // in the same sequence, to every reader of it.
    const replay = mountSequence(shuffleSequence());
    assert.deepEqual(drawnIds(replay.into), first);
    replay.into.byClass('sf-vsq-again')[0].click();
    assert.deepEqual(drawnIds(replay.into), second);
    replay.into.byClass('sf-vsq-again')[0].click();
    assert.deepEqual(drawnIds(replay.into), third);

    // The seeded model, on its own: a permutation of the steps, never the true
    // order, and never a second identical press.
    const order = shuffleOrder(sequence.steps.length, seed, 0);
    assert.deepEqual([...order].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5]);
    assert.equal(isTrueOrder(order), false);
    assert.equal(isTrueOrder([0, 1, 2]), true);
    assert.equal(shuffleOrder(1, seed, 0).length, 1, 'a single step has only one order');
    assert.notDeepEqual(shuffleOrder(6, seed, 1), shuffleOrder(6, seed, 0));

    // The source draws no randomness of its own: the shuffle is the asset's.
    // (Comments are blanked first, so prose about `Math.random` is not the check.)
    const source = read('ui/study-visual-sequence.ts').replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.ok(!/Math\.random/.test(source), 'the shuffle is the asset’s, not the run’s');
    // And the seed is the asset's: different steps, a different shuffle.
    assert.notEqual(sequenceSeed(sequence.steps), sequenceSeed([...sequence.steps].reverse()));
});

// ------------------------------------------------------------- the stepper

test('ordered mode is a one-card stepper: Step N of M, and it stops at both ends', () => {
    const sequence = orderedSequence();
    const { into } = mountSequence(sequence);

    assert.equal(into.byClass('sf-vsq')[0].attrs['data-mode'], 'ordered');
    assert.equal(into.byClass('sf-vsq-check').length, 0, 'nothing to check when the order is the lesson');
    assert.equal(into.byClass('sf-vsq-again').length, 0);
    assert.equal(into.byClass('sf-vsq-teach').length, 1);

    // One card on screen — never a numbered list of everything.
    const cards = into.byClass('sf-vsq-card');
    assert.equal(cards.length, 1, 'one step is on screen at a time');
    assert.equal(into.byClass('sf-vsq-slot').length, 0, 'a stepper is not a board of drop positions');
    assert.equal(into.byClass('sf-vsq-board').length, 0);
    assert.equal(into.byClass('sf-vsq-walk-step').length, 0);
    assert.equal(cards[0].attrs['data-step-id'], sequence.steps[0].id);
    assert.equal(cards[0].textOf('sf-vsq-card-label'), sequence.steps[0].label);

    const prev = into.byClass('sf-vsq-prev')[0];
    const next = into.byClass('sf-vsq-next')[0];
    assert.equal(prev.tag, 'button');
    assert.equal(prev.textContent, 'Previous');
    assert.equal(next.tag, 'button');
    assert.equal(next.textContent, 'Next');

    // It opens on the first step, and there is nothing before it.
    assert.equal(prev.disabled, true);
    assert.equal(next.disabled, false);
    assert.equal(into.textOf('sf-vsq-position'), `Step 1 of ${sequence.steps.length}`);
    assert.equal(into.textOf('sf-vsq-card-detail'), sequence.steps[0].detail);

    // Next advances, showing the step it lands on and that step's detail.
    next.click();
    assert.equal(into.byClass('sf-vsq-card')[0].attrs['data-step-id'], sequence.steps[1].id);
    assert.equal(into.byClass('sf-vsq-card')[0].textOf('sf-vsq-card-label'), sequence.steps[1].label);
    assert.equal(into.textOf('sf-vsq-position'), `Step 2 of ${sequence.steps.length}`);
    assert.equal(into.textOf('sf-vsq-card-detail'), sequence.steps[1].detail);
    assert.equal(prev.disabled, false);

    // Previous goes back and then stops.
    prev.click();
    assert.equal(into.textOf('sf-vsq-position'), `Step 1 of ${sequence.steps.length}`);
    assert.equal(prev.disabled, true);
    prev.click();
    assert.equal(into.textOf('sf-vsq-position'), `Step 1 of ${sequence.steps.length}`, 'the top is the top');

    // Walk to the end of the sequence: it stops there.
    for (let index = 1; index < sequence.steps.length; index += 1) next.click();
    assert.equal(into.textOf('sf-vsq-position'), `Step ${sequence.steps.length} of ${sequence.steps.length}`);
    assert.equal(into.byClass('sf-vsq-card')[0].attrs['data-step-id'], sequence.steps[sequence.steps.length - 1].id);
    assert.equal(into.textOf('sf-vsq-card-detail'), sequence.steps[sequence.steps.length - 1].detail);
    assert.equal(next.disabled, true, 'there is nothing after the last step');
    next.click();
    assert.equal(into.textOf('sf-vsq-position'), `Step ${sequence.steps.length} of ${sequence.steps.length}`);

    assert.equal(into.textOf('sf-vsq-pearl-text'), sequence.pearl);
});

test('a step with nothing more to say shows no invented detail', () => {
    const sequence = orderedSequence();
    const three = sequence.steps[2];
    assert.equal(three.detail, undefined, 'the fixture has a step with no detail');
    sequence.steps = [three, ...cascadeSteps().slice(3, 5)];

    const { into } = mountSequence(sequence);
    assert.ok(into.byClass('sf-vsq-card-detail')[0].hasClass('sf-vsq-hidden'), 'nothing to show, nothing shown');
    assert.equal(into.textOf('sf-vsq-card-detail'), '');

    into.byClass('sf-vsq-next')[0].click();
    assert.equal(into.byClass('sf-vsq-card-detail')[0].hasClass('sf-vsq-hidden'), false);
    assert.equal(into.textOf('sf-vsq-card-detail'), sequence.steps[1].detail);
});

// --------------------------------------------------------------------- teardown

test('mounting again replaces the sequence instead of stacking a second one', () => {
    const { view, into } = mountSequence(shuffleSequence());
    assert.equal(into.byClass('sf-vsq').length, 1);

    view.mount(into as unknown as HTMLElement, orderedSequence());
    assert.equal(into.byClass('sf-vsq').length, 1, 'one sequence, redrawn');
    assert.equal(into.byClass('sf-vsq-stepper').length, 1, 'in the other mode');
    assert.equal(into.byClass('sf-vsq-board').length, 0);
    assert.equal(into.byClass('sf-vsq-card').length, 1);
});

test('teardown takes the deck down, listeners included, and leaves the host as it was', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountSequence(shuffleSequence(), into);

    const check = into.byClass('sf-vsq-check')[0];
    const card = into.byClass('sf-vsq-card')[0];
    assert.equal(check.listenerCount('click'), 1, 'one handler while it is mounted');
    assert.equal(card.listenerCount('keydown'), 1);
    assert.equal(card.listenerCount('pointerdown'), 1);

    teardown();
    assert.equal(into.byClass('sf-vsq').length, 0);
    assert.equal(into.byClass('sf-vsq-card').length, 0, 'every card went with it');
    assert.equal(into.byClass('sf-vsq-check').length, 0);
    assert.equal(into.byClass('sf-vsq-again').length, 0);
    assert.equal(check.listenerCount('click'), 0, 'the controls let go');
    assert.equal(card.listenerCount('keydown'), 0, 'and so do the cards');
    assert.equal(card.listenerCount('pointerdown'), 0);
    assert.equal(into.children.length, 1, 'only what was there before is left');
    assert.equal(into.byClass('someone-elses-box').length, 1);

    // Nothing reacts to the detached controls any more.
    check.click();
    assert.equal(into.byClass('sf-vsq-report').length, 0);
});

// ------------------------------------------------------- the stylesheet’s part

/** The body of the first rule whose selector is exactly this selector. */
function ruleBody(css: string, selector: string): string {
    let at = css.indexOf(selector);
    while (at >= 0 && !/^[\s,{]/.test(css.slice(at + selector.length, at + selector.length + 1))) {
        at = css.indexOf(selector, at + 1);
    }
    assert.ok(at >= 0, `no rule for ${selector}`);
    const open = css.indexOf('{', at);
    assert.ok(open >= 0, `no rule body for ${selector}`);
    return css.slice(open + 1, css.indexOf('}', open));
}

test('every class the sequence renders has a rule in its stylesheet', () => {
    const source = read('ui/study-visual-sequence.ts');
    const css = read(CSS_PATH);
    const tokens = new Set([...source.replace(/--sf-[a-z0-9-]+/g, ' ').matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));

    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size >= 20, `expected to find the sequence's classes, found ${tokens.size}`);

    // The states this surface puts a card or the deck into each need a rule.
    for (const modifier of ['is-lifted', 'is-right', 'is-wrong', 'is-complete', 'is-settling', 'is-dragging', 'sf-vsq-hidden']) {
        assert.ok(css.includes(`.${modifier}`), `no rule for ${modifier}`);
    }
});

test('the sequence is styled with classes, wraps its labels, draws its verdict, and skips motion on request', () => {
    const source = read('ui/study-visual-sequence.ts');
    const css = read(CSS_PATH);

    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'no inline style assignment');

    // Text sizes come from the house tokens, never a px literal.
    const sized = [...css.matchAll(/font-size:\s*([^;{}]+)/g)].map(match => match[1].trim());
    assert.ok(sized.length > 0, 'the stylesheet sizes text');
    assert.deepEqual(sized.filter(value => /\d(\.\d+)?(px|rem|pt|pc|cm|mm|in)\b/.test(value)), [], 'every size comes from a --sf-font-* token');

    // A card label, its detail and the hint wrap rather than being cut.
    for (const selector of ['.sf-vsq-card-label', '.sf-vsq-card-detail', '.sf-vsq-hint']) {
        assert.match(ruleBody(css, selector), /overflow-wrap:\s*anywhere/, `${selector} must wrap`);
    }
    assert.ok(!/overflow(-[xy])?:\s*hidden/.test(css), 'nothing is clipped by the sheet');

    // The verdict is drawn as well as said: an edge on the card, a glyph in
    // the colour that edge is drawn in.
    assert.match(ruleBody(css, '.sf-vsq-card.is-right'), /border-left-color/);
    assert.match(ruleBody(css, '.sf-vsq-card.is-wrong'), /border-left-color/);
    assert.match(ruleBody(css, '.sf-vsq-glyph-check'), /stroke:\s*var\(--sf-success\)/);
    assert.match(ruleBody(css, '.sf-vsq-glyph-cross'), /stroke:\s*var\(--sf-warning\)/);

    // The pointer's own furniture: the ghost follows the position the module
    // writes, and the drop position is shown as an indicator.
    assert.match(source, /setCssProps\(\{ '--sf-vsq-ghost-x'/, 'the ghost position is written as data');
    assert.match(ruleBody(css, '.sf-vsq-ghost'), /left:\s*var\(--sf-vsq-ghost-x/);
    assert.match(ruleBody(css, '.sf-vsq-ghost'), /top:\s*var\(--sf-vsq-ghost-y/);
    assert.match(ruleBody(css, '.sf-vsq-indicator'), /background:\s*var\(--sf-primary\)/);

    // The drop is animated, and skipped for a reader who asked for less motion:
    // the sheet stands the animation down, and the module never writes a shift.
    assert.match(ruleBody(css, '.sf-vsq-card.is-settling'), /animation:\s*sf-vsq-settle/);
    assert.match(css, /--sf-vsq-shift/, 'the settle animation reads the shift the module writes');
    assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/, 'motion is skippable');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'));
    assert.match(reduced, /\.sf-vsq-card\.is-settling\s*\{[^}]*animation:\s*none/, 'the settle stands down');
    assert.match(reduced, /transition:\s*none/, 'and so does the ghost');
    assert.match(source, /prefers-reduced-motion/, 'the module asks the same question before it animates anything');

    // Every control wraps its own label rather than relying on the app's
    // nowrap, which would cut 'Shuffle again' on a narrow host.
    for (const selector of ['.sf-vsq-check', '.sf-vsq-again', '.sf-vsq-prev', '.sf-vsq-next']) {
        assert.match(ruleBody(css, selector), /white-space:\s*normal/, `${selector} must be allowed to wrap`);
    }
});
