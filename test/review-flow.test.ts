/**
 * Tests for the review flow core: queue order, leech checkpoints, undo and the
 * hotkey rules. Pure logic, no Obsidian — run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EDITING_HINT,
    HOTKEY_HINT,
    LeechAction,
    ReviewFlowModel,
    bucketResponse,
    formatDueLabel,
    formatDuration,
    formatIntervalPreview,
    formatScheduledInterval,
    gradeForKey,
    gradeKeyLabel,
    gradeOptionsFor,
    hotkeyHint,
    lapseInfoFromSchedule,
    leechChoices,
    nextLeechCheckpoint,
    resolveHotkey,
    shouldPromptLeech,
} from '../models/review-flow';
import { FsrsRating, ReviewResponse, ReviewSchedule } from '../models/review-schedule';

function schedule(overrides: Partial<ReviewSchedule> = {}): ReviewSchedule {
    return {
        path: 'note.md',
        lastReviewDate: null,
        nextReviewDate: Date.now() - 1000,
        ease: 250,
        interval: 3,
        consecutive: 0,
        reviewCount: 2,
        schedulingAlgorithm: 'sm2',
        ...overrides,
    };
}

test('grade options follow the algorithm', () => {
    const fsrs = gradeOptionsFor('fsrs');
    assert.deepEqual(fsrs.map(o => o.key), ['1', '2', '3', '4']);
    assert.deepEqual(fsrs.map(o => o.response), [1, 2, 3, 4]);
    assert.equal(fsrs[0].label, 'Again');

    const sm2 = gradeOptionsFor('sm2');
    assert.deepEqual(sm2.map(o => o.key), ['0', '1', '2', '3', '4', '5']);
    assert.equal(sm2[0].response, ReviewResponse.CompleteBlackout);
    assert.equal(sm2[5].response, ReviewResponse.PerfectRecall);
});

test('grade keys resolve per algorithm', () => {
    assert.equal(gradeForKey('3', 'fsrs')?.response, FsrsRating.Good);
    assert.equal(gradeForKey('5', 'fsrs'), null);
    assert.equal(gradeForKey('5', 'sm2')?.response, ReviewResponse.PerfectRecall);
    assert.equal(gradeForKey('x', 'sm2'), null);
});

test('coarse buckets map onto both algorithms', () => {
    assert.equal(bucketResponse('again', 'fsrs'), FsrsRating.Again);
    assert.equal(bucketResponse('easy', 'fsrs'), FsrsRating.Easy);
    assert.equal(bucketResponse('again', 'sm2'), ReviewResponse.IncorrectResponse);
    assert.equal(bucketResponse('hard', 'sm2'), ReviewResponse.CorrectWithDifficulty);
    assert.equal(bucketResponse('good', 'sm2'), ReviewResponse.CorrectWithHesitation);
    assert.equal(bucketResponse('easy', 'sm2'), ReviewResponse.PerfectRecall);
});

test('durations read the way Anki prints them', () => {
    const minute = 60000;
    assert.equal(formatDuration(30 * 1000), '<1m');
    assert.equal(formatDuration(10 * minute), '10m');
    assert.equal(formatDuration(60 * minute), '1h');
    assert.equal(formatDuration(3 * 24 * 60 * minute), '3d');
    assert.equal(formatDuration(61 * 24 * 60 * minute), '2.0mo');
    assert.equal(formatDuration(800 * 24 * 60 * minute), '2.2y');
    assert.equal(formatDuration(-5), 'now');
});

test('grade buttons print whole days as days and learning steps as minutes', () => {
    const now = 1_000_000_000_000;
    const utcMidnightToday = now - (now % 86400000);

    assert.equal(formatScheduledInterval(3, utcMidnightToday + 3 * 86400000, now), '3d');
    assert.equal(formatScheduledInterval(1, utcMidnightToday + 86400000, now), '1d');
    // FSRS learning steps: scheduled in minutes, so the clock is what matters.
    assert.equal(formatScheduledInterval(0, now + 10 * 60000, now), '10m');
    assert.equal(formatScheduledInterval(0, now + 3600000, now), '1h');
    // Same-day (SM-2 initial phase schedules to UTC midnight, which is behind us).
    assert.equal(formatScheduledInterval(0, utcMidnightToday, now), 'today');
});

test('interval previews and due labels', () => {
    const now = 1_000_000_000_000;
    assert.equal(formatIntervalPreview(now + 4 * 86400000, now), '4d');
    assert.equal(formatIntervalPreview(null, now), null);
    assert.equal(formatDueLabel(now - 3 * 86400000, now), '3d overdue');
    assert.equal(formatDueLabel(now, now), 'due now');
    assert.equal(formatDueLabel(now + 2 * 86400000, now), 'due in 2d');
    // A due label carries the clock: hours and minutes under a day, and the
    // leftover hours for the first week, where they still change the decision.
    assert.equal(formatDueLabel(now - (3 * 3600 + 20 * 60) * 1000, now), '3h 20m overdue');
    assert.equal(formatDueLabel(now + (2 * 3600 + 15 * 60) * 1000, now), 'due in 2h 15m');
    assert.equal(formatDueLabel(now - (3 * 86400000 + 4 * 3600000), now), '3d 4h overdue');
    assert.equal(formatDueLabel(now - 8 * 86400000 - 4 * 3600000, now), '8d overdue');
});

test('lapse info comes from whichever algorithm owns it', () => {
    const sm2 = schedule({ lapses: 4 });
    assert.deepEqual(lapseInfoFromSchedule(sm2), { lapses: 4, handledAtLapses: 0 });

    const fsrs = schedule({
        schedulingAlgorithm: 'fsrs',
        lapses: 99, // ignored: FSRS keeps its own counter
        fsrsData: {
            stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1,
            reps: 3, lapses: 7, state: 2,
        },
    });
    assert.equal(lapseInfoFromSchedule(fsrs).lapses, 7);
    assert.deepEqual(lapseInfoFromSchedule(undefined), { lapses: 0, handledAtLapses: 0 });
});

test('leech prompts land on checkpoints, not on every lapse', () => {
    assert.equal(nextLeechCheckpoint(0, 8), 8);
    assert.equal(nextLeechCheckpoint(8, 8), 16);
    assert.equal(nextLeechCheckpoint(15, 8), 16);

    assert.equal(shouldPromptLeech({ lapses: 7, handledAtLapses: 0, threshold: 8 }), false);
    assert.equal(shouldPromptLeech({ lapses: 8, handledAtLapses: 0, threshold: 8 }), true);
    assert.equal(shouldPromptLeech({ lapses: 8, handledAtLapses: 8, threshold: 8 }), false);
    assert.equal(shouldPromptLeech({ lapses: 15, handledAtLapses: 8, threshold: 8 }), false);
    assert.equal(shouldPromptLeech({ lapses: 16, handledAtLapses: 8, threshold: 8 }), true);
    assert.equal(shouldPromptLeech({ lapses: 100, handledAtLapses: 0, threshold: 0 }), false);
});

test('the leech decision offers exactly the four ways out', () => {
    const actions: LeechAction[] = leechChoices().map(c => c.action);
    assert.deepEqual(actions, ['reset', 'postpone', 'remove', 'keep']);
    assert.equal(leechChoices().filter(c => c.primary).length, 1);
});

test('a run walks the queue and finishes when it is empty', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    assert.equal(model.phase, 'reviewing');
    assert.equal(model.currentPath(), 'a.md');
    assert.deepEqual(model.position(), { handled: 0, remaining: 3, total: 3 });

    model.advance();
    assert.equal(model.currentPath(), 'b.md');
    assert.deepEqual(model.position(), { handled: 1, remaining: 2, total: 3 });

    model.advance();
    model.advance();
    assert.equal(model.phase, 'finished');
    assert.equal(model.position().handled, 3);
    assert.equal(model.nextPendingPath(), null);
});

test('sync drops notes that left the due list and keeps the cursor put', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md', 'd.md']);
    model.advance(); // sitting on b.md
    assert.equal(model.currentPath(), 'b.md');

    // a.md was graded (gone), c.md postponed (gone), e.md became due
    model.sync(['b.md', 'd.md', 'e.md']);
    assert.equal(model.currentPath(), 'b.md');
    assert.deepEqual(model.paths(), ['b.md', 'd.md', 'e.md']);
});

test('sync drops notes that stopped being due, including the one on screen', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    model.focus('b.md');
    model.sync(['b.md', 'c.md']);
    assert.deepEqual(model.paths(), ['b.md', 'c.md'], 'a was graded away');

    // b gets postponed from elsewhere while it is the one being shown.
    model.sync(['c.md']);
    assert.deepEqual(model.paths(), ['c.md']);
    assert.equal(model.currentPath(), 'c.md', 'the run steps over it instead of stalling');
});

test('a session file that is not due is put back into the run explicitly', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md']);
    model.sync([]); // a was graded; the due list is empty
    assert.equal(model.currentPath(), null);

    model.focus('session/deep.md');
    assert.equal(model.currentPath(), 'session/deep.md');
    assert.equal(model.isRunning(), true);
    assert.deepEqual(model.paths(), ['session/deep.md']);
});

test('a leech decision holds the flow until it is answered', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md']);
    model.awaitDecision({ path: 'a.md', lapses: 8, threshold: 8 });

    assert.equal(model.phase, 'decision');
    assert.equal(model.currentPath(), 'a.md');
    assert.equal(model.pendingDecision?.lapses, 8);
    // Asking must not consume the note: the controller only advances after the
    // answer arrives, otherwise the next note would be skipped silently.
    assert.equal(model.position().handled, 0);
    assert.equal(model.position().remaining, 2);

    model.advance();
    assert.equal(model.phase, 'reviewing');
    assert.equal(model.currentPath(), 'b.md');
    assert.equal(model.pendingDecision, null);
    assert.deepEqual(model.position(), { handled: 1, remaining: 1, total: 2 });
});

test('skipping moves on without counting the note as reviewed twice', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md']);
    model.advance(); // skip a.md
    assert.equal(model.position().handled, 1);
    assert.equal(model.currentPath(), 'b.md');
});

test('stepping back walks the same queue without un-handling anything', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    assert.equal(model.has('b.md'), true, 'the run knows the notes it queued');
    assert.equal(model.has('elsewhere.md'), false);

    model.advance(); // skip a.md
    model.advance(); // skip b.md; sitting on c.md
    assert.equal(model.currentPath(), 'c.md');
    assert.equal(model.cursorIndex(), 2);
    assert.deepEqual(model.position(), { handled: 2, remaining: 1, total: 3 });

    assert.equal(model.stepBack(), true);
    assert.equal(model.currentPath(), 'b.md');
    assert.equal(model.cursorIndex(), 1);
    assert.deepEqual(
        model.position(),
        { handled: 2, remaining: 1, total: 3 },
        'a look-back is not a re-handling: what the sitting passed stays passed'
    );

    // From the head of the queue it wraps, the way the due list's own
    // Previous always has.
    model.stepBack(); // b -> a
    assert.equal(model.currentPath(), 'a.md');
    model.stepBack(); // a wraps to the end of the queue
    assert.equal(model.currentPath(), 'c.md');

    // Walking forward from an already-passed note does not offer it as work.
    model.advance();
    assert.equal(model.phase, 'finished', 'every note in the run has been walked');
});

test('there is nothing to step back into when no queue is being walked', () => {
    const model = new ReviewFlowModel();
    assert.equal(model.stepBack(), false, 'inactive: there is no queue at all');

    model.start(['a.md']);
    model.advance();
    assert.equal(model.phase, 'finished');
    assert.equal(model.stepBack(), false, 'a finished walk has nothing left to step back to');
});

test('undo returns to the graded note and re-opens it for marking', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md']);
    const record = {
        path: 'a.md',
        scheduleJSON: '{"path":"a.md"}',
        historyLength: 3,
        previousPath: 'a.md',
        recordedAt: Date.now(),
    };
    model.setUndo(record);
    model.advance();
    assert.equal(model.currentPath(), 'b.md');
    assert.equal(model.undoAvailable(), true);

    const restored = model.undoTo();
    assert.equal(restored?.path, 'a.md');
    assert.equal(model.currentPath(), 'a.md');
    assert.equal(model.undoAvailable(), false);
    assert.equal(model.position().handled, 0);
    assert.equal(model.undoTo(), null);
});

test('focus adds an unknown note to the run', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md']);
    model.focus('elsewhere.md');
    assert.equal(model.currentPath(), 'elsewhere.md');
    assert.deepEqual(model.paths(), ['a.md', 'elsewhere.md']);
    assert.equal(model.position().total, 2);
});

test('ending a run clears it', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md']);
    model.end();
    assert.equal(model.phase, 'inactive');
    assert.equal(model.isActive(), false);
    assert.equal(model.currentPath(), null);
    assert.equal(model.undoAvailable(), false);
});

const baseContext = {
    active: true,
    phase: 'reviewing' as const,
    algorithm: 'fsrs' as const,
    editableTarget: false,
    overlayOpen: false,
    plainKeysEnabled: true,
};

function key(key: string, extra: Partial<Parameters<typeof resolveHotkey>[0]> = {}) {
    return {
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        ...extra,
    };
}

test('digits grade when nothing else is typing', () => {
    assert.deepEqual(resolveHotkey(key('1'), baseContext), { type: 'grade', response: 1 });
    assert.deepEqual(resolveHotkey(key('4'), baseContext), { type: 'grade', response: 4 });
    assert.equal(resolveHotkey(key('5'), baseContext), null);
    assert.deepEqual(
        resolveHotkey(key('0'), { ...baseContext, algorithm: 'sm2' }),
        { type: 'grade', response: 0 }
    );
});

test('digits are left alone while the caret is in text, Alt still grades', () => {
    const editing = { ...baseContext, editableTarget: true };
    assert.equal(resolveHotkey(key('3'), editing), null);
    assert.deepEqual(resolveHotkey(key('3', { altKey: true }), editing), { type: 'grade', response: 3 });
});

test('the number-key preference can be turned off', () => {
    const off = { ...baseContext, plainKeysEnabled: false };
    assert.equal(resolveHotkey(key('3'), off), null);
    assert.deepEqual(resolveHotkey(key('n'), off), { type: 'next' });
});

test('letters drive skip, undo and postpone, but not while typing', () => {
    assert.deepEqual(resolveHotkey(key('n'), baseContext), { type: 'next' });
    assert.deepEqual(resolveHotkey(key('b'), baseContext), { type: 'previous' });
    assert.deepEqual(resolveHotkey(key('s'), baseContext), { type: 'skip' });
    assert.deepEqual(resolveHotkey(key('u'), baseContext), { type: 'undo' });
    assert.deepEqual(resolveHotkey(key('p'), baseContext), { type: 'postpone' });
    assert.deepEqual(resolveHotkey(key('?'), baseContext), { type: 'hint' });

    const editing = { ...baseContext, editableTarget: true };
    assert.equal(resolveHotkey(key('n'), editing), null);
    assert.deepEqual(resolveHotkey(key('s', { altKey: true }), editing), { type: 'skip' });
});

test('the flow never steals Obsidian shortcuts or modifier chords', () => {
    assert.equal(resolveHotkey(key('3', { ctrlKey: true }), baseContext), null);
    assert.equal(resolveHotkey(key('3', { metaKey: true }), baseContext), null);
    assert.equal(resolveHotkey(key('3', { shiftKey: true }), baseContext), null);
    assert.equal(resolveHotkey(key('3', { repeat: true }), baseContext), null);
    assert.equal(resolveHotkey(key('3'), { ...baseContext, overlayOpen: true }), null);
    assert.equal(resolveHotkey(key('3'), { ...baseContext, active: false }), null);
});

test('escape ends the run, except while typing', () => {
    assert.deepEqual(resolveHotkey(key('Escape'), baseContext), { type: 'end' });
    assert.equal(resolveHotkey(key('Escape'), { ...baseContext, editableTarget: true }), null);
});

test('while a decision is pending only undo and escape respond', () => {
    const deciding = { ...baseContext, phase: 'decision' as const };
    assert.equal(resolveHotkey(key('3'), deciding), null);
    assert.equal(resolveHotkey(key('n'), deciding), null);
    assert.deepEqual(resolveHotkey(key('u'), deciding), { type: 'undo' });
    assert.deepEqual(resolveHotkey(key('Escape'), deciding), { type: 'end' });
});

test('hotkey hints name the right key range', () => {
    assert.equal(hotkeyHint('fsrs'), HOTKEY_HINT);
    assert.match(hotkeyHint('sm2'), /0-5/);
});

test('the hint and the key badges describe the binding that is actually live', () => {
    // Plain digits on: the bare key grades, so the badges say so.
    assert.equal(gradeKeyLabel('3', true), '3');
    assert.match(hotkeyHint('sm2', true), /^0-5 rate/);
    assert.match(hotkeyHint('fsrs', true), /^1-4 rate/);

    // Plain digits off: only Alt+digit grades, so nothing may advertise the bare key.
    assert.equal(gradeKeyLabel('3', false), 'Alt+3');
    assert.match(hotkeyHint('sm2', false), /^Alt\+0-5 rate/);
    assert.match(hotkeyHint('fsrs', false), /^Alt\+1-4 rate/);
    assert.ok(!/esc end$/.test(hotkeyHint('fsrs', false)) === false, 'the end hint stays put');

    // With the caret in the note the editor is the chord's home too.
    assert.match(EDITING_HINT, /Alt/);
});

test('with plain digits off, bare digits do nothing but Alt still grades', () => {
    const context = {
        active: true,
        phase: 'reviewing' as const,
        algorithm: 'fsrs' as const,
        editableTarget: false,
        overlayOpen: false,
        plainKeysEnabled: false,
    };
    const press = (key: string, altKey = false) =>
        resolveHotkey({ key, altKey, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false }, context);

    assert.equal(press('3'), null, 'a bare digit must not grade when the setting is off');
    assert.deepEqual(press('3', true), { type: 'grade', response: 3 }, 'Alt+digit still grades');

    // The letter shortcuts are unaffected by that setting.
    assert.deepEqual(press('n'), { type: 'next' });
    assert.deepEqual(press('p'), { type: 'postpone' });
    assert.deepEqual(press('u'), { type: 'undo' });
});

test('Alt+digit grades even with plain digits off, whatever holds focus', () => {
    for (const plainKeysEnabled of [true, false]) {
        for (const editableTarget of [true, false]) {
            const hotkey = (key: string, altKey: boolean) =>
                resolveHotkey(
                    { key, altKey, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false },
                    { active: true, phase: 'reviewing', algorithm: 'sm2', editableTarget, overlayOpen: false, plainKeysEnabled }
                );
            assert.deepEqual(
                hotkey('4', true),
                { type: 'grade', response: 4 },
                `Alt+4 must grade (plainKeys=${plainKeysEnabled}, editable=${editableTarget})`
            );
            // The bare key is exactly what the setting and the caret govern.
            const expectedBare = plainKeysEnabled && !editableTarget ? { type: 'grade', response: 4 } : null;
            assert.deepEqual(
                hotkey('4', false),
                expectedBare,
                `bare 4 with plainKeys=${plainKeysEnabled}, editable=${editableTarget}`
            );
        }
    }

    // Grading is paused while a question is on screen, chord or not.
    const inDecision = resolveHotkey(
        { key: '4', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false },
        { active: true, phase: 'decision', algorithm: 'sm2', editableTarget: false, overlayOpen: false, plainKeysEnabled: true }
    );
    assert.equal(inDecision, null);
});

test('stepping forward navigates without marking anything handled', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    assert.equal(model.currentPath(), 'a.md');

    assert.equal(model.stepForward(), true);
    assert.equal(model.currentPath(), 'b.md', 'the cursor moved');
    assert.deepEqual(model.snapshot().handled, [], 'and nothing was marked as done');

    model.stepForward();
    model.stepForward();  // c wraps to the head of the queue
    assert.equal(model.currentPath(), 'a.md', 'the walk is circular, like Previous');
    assert.deepEqual(model.snapshot().handled, [], 'still nothing handled');

    // The skip is the thing that marks work: it still does.
    model.advance();
    assert.deepEqual(model.snapshot().handled, ['a.md'], 'only a real step past counts');
});

// ---------------------------------------------------------------------------
// The card lane's steps: a sitting is everything that is waiting, and the
// decks' cards are part of the run rather than a tab beside it.
// ---------------------------------------------------------------------------

/** Where the bar's counter stands for this model: the model's own place. */
function counterAt(model: ReviewFlowModel): number {
    return model.place();
}

test('the run holds the card lane as its own series of steps', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md'], undefined, 4);

    assert.deepEqual(model.composition(), { notes: 2, cards: 4 }, 'two notes, four card steps');
    assert.equal(model.cardStepCount(), 4);
    assert.deepEqual(
        model.paths(),
        ['a.md', 'b.md', 'spaceforge:cards:0', 'spaceforge:cards:1', 'spaceforge:cards:2', 'spaceforge:cards:3'],
        'the notes come first and the cards are the tail of the run',
    );
    assert.deepEqual(model.position(), { handled: 0, remaining: 6, total: 6 });
    assert.equal(model.onCardStep(), false, 'the run starts on its first note');
    assert.equal(counterAt(model), 1);
});

test('every step of the run moves the place by exactly one, cards included', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md'], undefined, 3);
    assert.equal(model.position().total, 6, 'three notes and three cards is six steps');

    // Walk the whole run — notes, then the card lane's own steps — and check
    // the number the bar prints never moves by anything but one.
    let previous = counterAt(model);
    for (let step = 1; step <= 6; step++) {
        model.advance();
        const at = counterAt(model);
        assert.ok(at === previous + 1 || model.isFinished(), `step ${step}: ${previous} -> ${at}`);
        previous = at;
    }
    assert.equal(model.isFinished(), true, 'the run ends when its last step is spent');
    assert.equal(previous, 6, 'and the counter reached the run\u2019s own size');
});

test('stepping forward through the cards is one place at a time too', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 2);
    model.stepForward();                                   // the first card step
    assert.equal(model.onCardStep(), true);
    assert.equal(model.cursorIndex(), 1);
    assert.equal(counterAt(model), 2);

    model.stepForward();                                   // the second card step
    assert.equal(model.cursorIndex(), 2);
    assert.equal(counterAt(model), 3);
    assert.deepEqual(model.snapshot().handled, [], 'browsing still marks nothing');

    model.stepForward();                                   // wraps to the note
    assert.equal(model.currentPath(), 'a.md', 'the whole run is one circular walk');
    assert.deepEqual(model.snapshot().handled, [], 'and nothing was marked by walking it');
    assert.equal(counterAt(model), 1, 'so the number is the place the reader is standing in, as it always was');
});

test('the card series follows the live count until the reader reaches it', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 6);
    assert.deepEqual(model.composition(), { notes: 1, cards: 6 });

    // A count that falls before the reader is there takes the steps away…
    model.setCardSteps(4);
    assert.equal(model.cardStepCount(), 4);
    assert.equal(model.position().total, 5);

    // …and one that arrives late still counts.
    model.setCardSteps(9);
    assert.equal(model.cardStepCount(), 9);

    // Once a card step has been handled the series only ever shrinks, and only
    // to what the reader has already passed: a count that moves under the
    // sitting cannot take a step out from under the cursor, and one that comes
    // back cannot add a step to a sitting that is under way.
    model.completeCardStep('spaceforge:cards:0');
    model.completeCardStep('spaceforge:cards:1');
    model.setCardSteps(9);
    assert.equal(model.cardStepCount(), 9, 'the count it was given stands');
    model.setCardSteps(1);
    assert.equal(model.cardStepCount(), 2, 'the steps the reader passed are never given back');
    assert.deepEqual(model.position(), { handled: 2, remaining: 1, total: 3 }, 'the note is still waiting; the cards are not');

    // A closed sitting is closed: every count in the world adds nothing to it.
    const done = new ReviewFlowModel();
    done.start(['a.md'], undefined, 2);
    done.completeCardSteps();
    done.setCardSteps(9);
    assert.equal(done.cardStepCount(), 2);
});

test('the cards control points the run at its card steps', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md'], undefined, 3);
    assert.equal(model.focusCardSteps(), true);
    assert.equal(model.onCardStep(), true);
    assert.equal(model.cursorIndex(), 2, 'the first card step follows the notes');

    model.completeCardStep('spaceforge:cards:0');
    model.focusCardSteps();
    assert.equal(model.currentPath(), 'spaceforge:cards:1', 'the next card step that is not spent');

    model.completeCardSteps();
    assert.equal(model.focusCardSteps(), true);
    assert.equal(model.currentPath(), 'spaceforge:cards:0', 'a sitting that is over is walked back to, not re-handled');

    const empty = new ReviewFlowModel();
    empty.start(['a.md']);
    assert.equal(empty.focusCardSteps(), false, 'no card steps, nowhere to point');
});

test('a finished sitting closes the card series and the run walks on', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 3);
    // A sitting that covered every deck at once: the whole series is spent.
    model.completeCardSteps();
    assert.deepEqual(
        model.position(),
        { handled: 3, remaining: 1, total: 4 },
        'the cards are spent; the note the run had not walked yet is not',
    );
    assert.equal(model.focusCardSteps(), true, 'the cards stay walkable after they are spent');
    assert.equal(model.cardStepCount(), 3, 'and a count that comes back does not add a step to a closed sitting');

    // Stepping off the spent cards hands the run back to the note that is
    // still waiting, rather than finishing a sitting with work left in it.
    model.advance();
    assert.equal(model.currentPath(), 'a.md');
    assert.equal(model.phase, 'reviewing');
    model.advance();
    assert.equal(model.phase, 'finished', 'the run is over once every step of it is');
});

test('a note that comes due mid-run joins the queue before the card series', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md'], undefined, 2);
    model.sync(['a.md', 'b.md', 'late.md'], 2);
    assert.deepEqual(
        model.paths(),
        ['a.md', 'b.md', 'late.md', 'spaceforge:cards:0', 'spaceforge:cards:1'],
        'the cards stay the tail of the run',
    );
    assert.deepEqual(model.composition(), { notes: 3, cards: 2 });
    assert.equal(model.position().total, 5);
});

test('sync without a count leaves the card series exactly as it was', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 3);
    model.sync(['a.md']);
    assert.equal(model.cardStepCount(), 3, 'the run keeps the steps it was given');
    assert.deepEqual(model.paths(), ['a.md', 'spaceforge:cards:0', 'spaceforge:cards:1', 'spaceforge:cards:2']);
});

test('a saved run comes back with its card steps, its place and its total', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md'], undefined, 2);
    model.advance();                                   // a is handled, the run is on b
    model.advance();                                   // b is handled, the run is on the first card step
    const saved = model.snapshot();
    assert.equal(model.onCardStep(), true);

    const reopened = new ReviewFlowModel();
    assert.equal(reopened.restore(saved), true);
    assert.deepEqual(reopened.paths(), saved.order, 'the card steps ride in the save like notes do');
    assert.deepEqual(reopened.snapshot().handled, saved.handled);
    assert.equal(reopened.onCardStep(), true, 'and the run comes back on the step it stopped at');
    assert.deepEqual(reopened.position(), { handled: 2, remaining: 2, total: 4 });
    assert.deepEqual(reopened.composition(), { notes: 2, cards: 2 });
});

test('a note focused into a card-carrying run still lands before the cards', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 2);
    model.focus('session/deep.md');
    assert.deepEqual(model.paths(), ['a.md', 'session/deep.md', 'spaceforge:cards:0', 'spaceforge:cards:1']);
    assert.equal(model.currentPath(), 'session/deep.md');
    assert.deepEqual(model.composition(), { notes: 2, cards: 2 });
});

// ---------------------------------------------------------------------------
// The counter the reader navigates by. The place is where they stand — never a
// tally that has run ahead of the walk — and it moves by exactly one per step
// in both directions, whatever the queue does underneath.
// ---------------------------------------------------------------------------

test('the number is the place the reader stands in, even when the run has handled more than that', () => {
    // The state the reader was stuck in, reproduced from the live app: a
    // sitting had marked the decks' steps spent, so the tally read six while
    // the walk stood on the first note. The bar computed `max(handled, index) +
    // 1`, which printed the same number for every place behind the tally:
    // `7/11 steps`, with Previous and Next both looking dead.
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md'], undefined, 3);
    model.completeCardSteps();
    assert.equal(model.position().handled, 3, 'the tally has run ahead of the walk');
    assert.equal(model.place(), 1, 'and the number is the place, not the tally');

    const forward: number[] = [model.place()];
    for (let step = 0; step < 5; step++) {
        model.stepForward();
        forward.push(model.place());
    }
    assert.deepEqual(forward, [1, 2, 3, 4, 5, 6], 'six steps, six places, one press at a time');

    for (let place = 5; place >= 1; place--) {
        model.stepBack();
        assert.equal(model.place(), place, 'and back again, one at a time');
    }
});

test('a graded note keeps the reader’s place while the queue is re-derived under it', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    model.advance();               // a.md is graded…
    model.sync(['b.md', 'c.md']);  // …and leaves the due list
    assert.equal(model.currentPath(), 'b.md');
    assert.equal(model.place(), 2, 'one note done, standing on the second');

    model.sync(['b.md', 'c.md']);
    assert.equal(model.place(), 2, 'a queue re-derived under the reader does not move the number');

    model.stepForward();
    assert.equal(model.place(), 3);
    model.stepBack();
    assert.equal(model.place(), 2);
});

test('a skip moves the number by exactly one, never by two', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md', 'b.md', 'c.md']);
    model.advance();   // the skip: handled, still due, still in the queue
    assert.equal(model.place(), 2, 'the tally and the place must not be added together');
    model.stepBack();
    assert.equal(model.place(), 1, 'walking back onto the note just passed');
    model.advance();
    assert.equal(model.place(), 2);
});

test('one deck’s sitting spends its own step, not the whole series', () => {
    const model = new ReviewFlowModel();
    model.start(['a.md'], undefined, 3);
    assert.equal(model.focusCardSteps(), true);
    const step = model.currentPath() as string;
    model.completeCardStep(step);
    assert.deepEqual(
        model.position(),
        { handled: 1, remaining: 3, total: 4 },
        'the deck the sitting was on is spent; the other decks are still work',
    );
    assert.equal(model.place(), 2, 'and the run stands where it stood');

    model.advance();
    assert.equal(model.currentPath(), 'spaceforge:cards:1', 'the run walks to the next deck’s step by one');
    assert.equal(model.place(), 3);
});

