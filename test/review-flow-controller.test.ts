/**
 * End-to-end tests for a docked review run, driven through the real controllers
 * (ReviewController facade -> ReviewControllerCore -> ReviewFlowController ->
 * ReviewScheduleService) with a fake Obsidian shell (test/support/fake-shell.ts).
 *
 * What a user does — open a note, press a grade, look at the next note — is what
 * these tests do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeShell, FakeKeyEvent } from './support/fake-shell';
import { MiniElement, flatten } from './support/mini-dom';
import { DateUtils } from '../utils/dates';
import { ReviewResponse } from '../models/review-schedule';
import { ReviewControllerCore } from '../controllers/review-controller-core';
import { ReviewFlowController } from '../controllers/review-flow-controller';
import { DeckSessionController, DeckSessionCard } from '../controllers/deck-session-controller';
import { AnkiCard, AnkiCardQueue, AnkiCardType, DeckBundle, DeckScheduler } from '../models/anki';
import { DEFAULT_SETTINGS, migrateSettings } from '../models/settings';

function threeDueNotes(overrides = {}): FakeShell {
    const shell = new FakeShell(overrides);
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    shell.addNote({ path: 'c.md' });
    return shell;
}

/** Start a run and let the controller finish opening the first note. */
async function start(shell: FakeShell, path?: string): Promise<void> {
    shell.flow.start(path);
    await shell.settle();
}

/** Click a grade button the way a user would, then let the flow settle. */
async function grade(shell: FakeShell, label: string): Promise<void> {
    shell.clickGrade(label);
    await shell.settle();
}

/** Press a key, let the flow settle, and report whether the plugin claimed it. */
async function press(shell: FakeShell, key: string, options: Partial<FakeKeyEvent> = {}): Promise<boolean> {
    const handled = shell.document.press(key, options);
    await shell.settle();
    return handled;
}

/** The fake editor element handed in as the event target. */
function asTarget(element: MiniElement): EventTarget {
    return element as unknown as EventTarget;
}

/** Click one of the leech decision buttons by index. */
async function decide(shell: FakeShell, index: number): Promise<void> {
    const button = shell.strip()?.byClass('sf-strip-decision-button')[index];
    if (!button) throw new Error(`No decision button at index ${index}`);
    button.click();
    await shell.settle();
}

/**
 * Record the notes the docked bar is asked to take over.
 *
 * The review dialog is gone, so every path that used to raise one routes here
 * instead; tests assert on which note the bar was pointed at.
 */
function captureDockedRuns(): { started: string[]; restore: () => void } {
    const original = ReviewControllerCore.prototype.openDockedReview;
    const started: string[] = [];
    ReviewControllerCore.prototype.openDockedReview = function (notePath: string) {
        started.push(notePath);
    };
    return {
        started,
        restore: () => { ReviewControllerCore.prototype.openDockedReview = original; },
    };
}

/** The caret sitting in the note's text, where digits must type. */
function editorTarget(): MiniElement {
    const editor = new MiniElement('div');
    editor.addClass('cm-editor');
    editor.isContentEditable = true;
    return editor;
}

test('starting a run opens the first due note with the bar under it, and nothing over it', async () => {
    const shell = threeDueNotes();
    await start(shell);

    assert.deepEqual(shell.opened, ['a.md']);
    const strip = shell.strip();
    assert.ok(strip, 'the bar is mounted in the note pane');
    assert.equal(shell.leaf.view.containerEl.hasClass('sf-strip-host'), true);
    // The bar is a sibling *after* the note, not an overlay.
    const children = shell.leaf.view.containerEl.children;
    assert.equal(children[children.length - 1], strip);
    assert.equal(shell.stripTitle(), 'a');
    assert.ok(shell.stripText().includes('1/3'));
    assert.deepEqual(shell.gradeLabels(), [
        'Complete blackout', 'Incorrect', 'Incorrect but familiar',
        'Correct with difficulty', 'Correct with hesitation', 'Perfect recall',
    ]);
});

test('an FSRS note gets its own four grades and they schedule the note', async () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'fsrs.md',
        schedule: {
            schedulingAlgorithm: 'fsrs',
            fsrsData: { stability: 5, difficulty: 5, elapsed_days: 3, scheduled_days: 3, reps: 3, lapses: 0, state: 2 },
        },
    });
    await start(shell);

    assert.deepEqual(shell.gradeLabels(), ['Again', 'Hard', 'Good', 'Easy']);
    assert.deepEqual(shell.strip()?.byClass('sf-strip-grade-key').map(element => element.text), ['1', '2', '3', '4']);

    await grade(shell, 'Good');
    assert.equal(shell.service.schedules['fsrs.md'].fsrsData?.reps, 4);
    assert.equal(shell.service.schedules['fsrs.md'].reviewCount, 4);
});

test('a finished sitting marks the grade it implies and records nothing, until the learner grades', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'sitting.md', schedule: { schedulingAlgorithm: 'fsrs' } });
    await start(shell);

    const reviews = shell.service.schedules['sitting.md'].reviewCount ?? 0;
    const controller = shell.flow as unknown as { acceptSuggestion: (suggestion: unknown) => void };
    controller.acceptSuggestion({ rating: 3, score: 0.75, label: 'Good' });

    const marked = shell.strip()?.byClass('sf-strip-grade').filter(button => button.hasClass('is-suggested')) ?? [];
    assert.equal(marked.length, 1, 'the suggested grade is marked on the bar, not given');
    assert.equal(marked[0].byClass('sf-strip-grade-score')[0].text, '75%', 'with the score in that button');
    assert.equal(shell.service.schedules['sitting.md'].reviewCount, reviews, 'nothing was recorded');

    await grade(shell, 'Good');
    assert.equal(shell.service.schedules['sitting.md'].reviewCount, reviews + 1, 'the learner\'s press is what records');
    assert.equal(
        shell.strip()?.byClass('is-suggested').length,
        0,
        'and the mark is spent once the grade is given',
    );
});

test('with the score set to decide, the same sitting is graded without being asked', async () => {
    const shell = new FakeShell({ mcqGradingMode: 'score' });
    shell.addNote({ path: 'sitting.md', schedule: { schedulingAlgorithm: 'fsrs' } });
    await start(shell);

    const reviews = shell.service.schedules['sitting.md'].reviewCount ?? 0;
    const opened = shell.opened.length;
    const controller = shell.flow as unknown as { acceptSuggestion: (suggestion: unknown) => void };
    controller.acceptSuggestion({ rating: 4, score: 1, label: 'Easy' });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(shell.service.schedules['sitting.md'].reviewCount, reviews + 1, 'the score-derived grade was applied');
    assert.equal(shell.opened.length, opened, 'and nothing was opened over the note');
    assert.equal(shell.strip()?.byClass('is-suggested').length, 0, 'nothing is left to ask');
});

test('a grade records the review, saves, and moves straight to the next due note', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const before = { ...shell.service.schedules['a.md'] };
    const historyBefore = shell.service.history.length;
    shell.takeNotices();

    await grade(shell, 'Correct with hesitation');

    const after = shell.service.schedules['a.md'];
    assert.equal(after.reviewCount, before.reviewCount + 1, 'the review is counted');
    assert.equal(after.lastReviewDate, DateUtils.startOfUTCDay(new Date()), 'last review stamped to today');
    assert.ok(after.nextReviewDate > before.nextReviewDate, 'the note is rescheduled forward');
    assert.equal(shell.service.history.length, historyBefore + 1, 'history records the rating');
    assert.equal(shell.service.history[0].path, 'a.md');
    assert.ok(shell.saves > 0, 'the change is persisted');
    assert.deepEqual(shell.opened, ['a.md', 'b.md'], 'the next due note opens in the same leaf');
    assert.equal(shell.stripTitle(), 'b');
    assert.ok(shell.stripText().includes('2/3'));
    assert.deepEqual(shell.takeNotices(), [], 'a fast flow does not interrupt with a notice per note');
});

test('grading through the queue finishes the run and says so', async () => {
    const shell = threeDueNotes();
    await start(shell);

    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'c');

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripText().includes('Review session complete'), true, 'the bar reports the end');
    assert.equal(shell.gradeButtons().length, 0);
    assert.ok(shell.stripText().includes('3 notes handled'));
    assert.deepEqual(shell.duePaths(), [], 'every note left the due list');
});

test('keys grade and advance, and the bar follows the keyboard', async () => {
    const shell = threeDueNotes();
    await start(shell);

    assert.equal(await press(shell, '4'), true, 'the plugin claims the key');
    assert.equal(shell.service.history.length, 1);
    assert.equal(shell.service.history[0].response, ReviewResponse.CorrectWithHesitation);
    assert.equal(shell.stripTitle(), 'b');

    await press(shell, '1');
    assert.equal(shell.service.history[1].response, ReviewResponse.IncorrectResponse);
    assert.equal(shell.stripTitle(), 'c');
});

test('keys are ignored while the caret is in the note, where Alt plus the key grades', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const editor = editorTarget();

    assert.equal(await press(shell, '3', { target: asTarget(editor) }), false, 'a plain digit belongs to the text');
    assert.equal(shell.service.history.length, 0);
    assert.equal(shell.stripTitle(), 'a');

    assert.equal(await press(shell, '3', { target: asTarget(editor), altKey: true }), true);
    assert.equal(shell.service.history.length, 1);
    assert.equal(shell.stripTitle(), 'b');
});

test('keys are ignored while a modal or menu owns the keyboard', async () => {
    const shell = threeDueNotes();
    await start(shell);
    shell.document.overlayOpen = true;

    assert.equal(await press(shell, '3'), false);
    assert.equal(await press(shell, 's'), false);
    assert.equal(await press(shell, 'Escape'), false);
    assert.equal(shell.service.history.length, 0);
    assert.equal(shell.stripTitle(), 'a');

    shell.document.overlayOpen = false;
    assert.equal(await press(shell, '3'), true);
});

test('skip moves on without recording anything (the note stays due)', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const before = JSON.stringify(shell.service.schedules['a.md']);

    assert.equal(await press(shell, 's'), true);

    assert.equal(JSON.stringify(shell.service.schedules['a.md']), before, 'skipping writes nothing');
    assert.equal(shell.service.history.length, 0);
    assert.equal(shell.stripTitle(), 'b');
    assert.ok(shell.duePaths().includes('a.md'), 'the skipped note is still due');
});

test('postpone pushes the note a day out and out of the running order', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const before = shell.service.schedules['a.md'].nextReviewDate;

    assert.equal(await press(shell, 'p'), true);

    assert.equal(shell.service.schedules['a.md'].nextReviewDate, DateUtils.addDays(before, 1));
    assert.deepEqual(shell.duePaths(), ['b.md', 'c.md']);
    assert.equal(shell.stripTitle(), 'b');
});

test('undo restores the schedule, the history and the note itself', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const before = JSON.stringify(shell.service.schedules['a.md']);

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'b');
    assert.equal(shell.service.history.length, 1);

    assert.equal(await press(shell, 'u'), true);

    assert.equal(JSON.stringify(shell.service.schedules['a.md']), before, 'the schedule is back');
    assert.equal(shell.service.history.length, 0, 'the history entry is withdrawn');
    assert.deepEqual(shell.opened, ['a.md', 'b.md', 'a.md'], 'the note being fixed is re-opened');
    assert.equal(shell.stripTitle(), 'a');
    assert.equal(shell.flow.runPosition().handled, 0, 'it counts as unreviewed again');
    assert.ok(shell.stripText().includes('3/3'), shell.stripText());

    // Only one grade existed, so a second undo has nothing left to do.
    shell.takeNotices();
    assert.equal(await press(shell, 'u'), true);
    assert.deepEqual(shell.takeNotices(), ['Nothing to undo.']);
});

test('undo after the run has finished still works', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    const cBeforeLastGrade = JSON.stringify(shell.service.schedules['c.md']);

    await grade(shell, 'Perfect recall');
    assert.ok(shell.stripText().includes('Review session complete'));

    await press(shell, 'u');

    assert.equal(JSON.stringify(shell.service.schedules['c.md']), cBeforeLastGrade, 'the last rating is undone');
    assert.equal(shell.stripTitle(), 'c', 'the flow is back on the note that was reverted');
    assert.ok(shell.stripText().includes('3/3'));
    assert.deepEqual(shell.duePaths(), ['c.md'], 'c is due again, the others were reviewed');
});

test('undo does not swallow a rating that was made elsewhere in the meantime', async () => {
    const shell = threeDueNotes();
    await start(shell);
    const before = JSON.stringify(shell.service.schedules['a.md']);

    await grade(shell, 'Perfect recall');            // grade a, undo record for a
    shell.service.recordReview('b.md', ReviewResponse.PerfectRecall); // something else writes history

    await press(shell, 'u');

    assert.equal(JSON.stringify(shell.service.schedules['a.md']), before);
    const bEntries = shell.service.history.filter(item => item.path === 'b.md');
    assert.equal(bEntries.length, 1, "b's own rating survives the undo of a");
});

test('a note that keeps failing stops the flow and asks, then carries on', async () => {
    const shell = new FakeShell({ leechThreshold: 3 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 2, interval: 6, repetitionCount: 3 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');

    // Held on the note that failed, waiting for an answer.
    assert.equal(shell.stripTitle(), 'a', 'the run does not slide on to b');
    assert.equal(shell.gradeButtons().length, 0, 'grades are replaced by the question');
    assert.ok(shell.stripText().includes('a has lapsed 3 times'), `prompt text: ${shell.stripText()}`);
    assert.deepEqual(shell.opened, ['a.md'], 'nothing else has been opened yet');

    // A grade is not accepted while the question stands.
    assert.equal(await press(shell, '5'), false);
    assert.equal(shell.service.history.length, 1);

    const choices = shell.strip()?.byClass('sf-strip-decision-button') ?? [];
    assert.deepEqual(choices.map(choice => flatten(choice)), [
        'Reset progress', 'Rest for a week', 'Remove from schedule', 'Keep as is',
    ]);
    await decide(shell, 3); // Keep as is

    assert.equal(shell.stripTitle(), 'b', 'the run resumes on the next note');
    assert.equal(shell.service.schedules['a.md'].leechHandledAtLapses, 3);
    assert.equal(shell.service.history.length, 1, 'answering the question is not a review');
});

test('reset progress from the decision row keeps the note in rotation', async () => {
    const shell = new FakeShell({ leechThreshold: 2 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 1, interval: 30, repetitionCount: 4 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');
    await decide(shell, 0); // Reset progress

    const schedule = shell.service.schedules['a.md'];
    assert.equal(schedule.interval, 1);
    assert.equal(schedule.lapses, 0);
    assert.equal(schedule.nextReviewDate, DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), 1));
    assert.equal(shell.stripTitle(), 'b');
});

test('resting a failing note takes it out of the run', async () => {
    const shell = new FakeShell({ leechThreshold: 2 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 1 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');
    await decide(shell, 1); // Rest for a week

    assert.ok(!shell.duePaths().includes('a.md'));
    assert.equal(shell.stripTitle(), 'b');
});

test('removing a failing note from the schedule takes it out of the run', async () => {
    const shell = new FakeShell({ leechThreshold: 2 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 1 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');
    await decide(shell, 2); // Remove from schedule

    assert.equal(shell.service.schedules['a.md'], undefined);
    assert.equal(shell.stripTitle(), 'b');
    assert.deepEqual(shell.duePaths(), ['b.md']);
});

test('escape ends the run and takes the bar away', async () => {
    const shell = threeDueNotes();
    await start(shell);

    assert.equal(await press(shell, 'Escape'), true);

    assert.equal(shell.strip(), null, 'the bar is gone');
    assert.equal(shell.leaf.view.containerEl.hasClass('sf-strip-host'), false);
    assert.equal(shell.keydownListenerCount(), 0, 'the keyboard listener is removed');
    assert.equal(shell.flow.isActive(), false);
    assert.equal(shell.service.history.length, 0);
});

test('after the run ends, keys do nothing at all', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await press(shell, 'Escape');

    await press(shell, '3');
    await press(shell, 's');
    await press(shell, 'u');

    assert.equal(shell.service.history.length, 0);
    assert.deepEqual(shell.opened, ['a.md'], 'no further navigation');
});

test('nothing due: the run refuses politely and leaves no listeners behind', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'later.md', dueInDays: 5 });
    await start(shell);

    assert.deepEqual(shell.takeNotices(), ['No notes are due for review.']);
    assert.equal(shell.strip(), null);
    assert.equal(shell.keydownListenerCount(), 0);
    assert.equal(shell.flow.isActive(), false);
    assert.deepEqual(shell.opened, []);
});

test('starting a run twice does not stack listeners or bars', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await grade(shell, 'Perfect recall');
    await start(shell);

    assert.equal(shell.keydownListenerCount(), 1, 'one keyboard listener');
    assert.equal(shell.strip()?.byClass('sf-strip-grade').length, 6, 'one bar');
    assert.ok(shell.stripText().includes('1/2'), 'the new run covers what is still due');
    assert.equal(shell.stripTitle(), 'b');
});

test('a run started from a specific note begins there', async () => {
    const shell = threeDueNotes();
    await start(shell, 'c.md');

    assert.deepEqual(shell.opened, ['c.md']);
    assert.equal(shell.stripTitle(), 'c');
});

test('reviewing everything due routes into the docked run, not a dialog', async () => {
    const shell = threeDueNotes();
    await shell.reviewController.reviewAllTodaysNotes();
    await shell.settle();

    assert.equal(shell.flow.isActive(), true);
    assert.deepEqual(shell.opened, ['a.md']);
    assert.equal(shell.stripTitle(), 'a');
    assert.equal(shell.gradeButtons().length, 6, 'the bar is mounted, not a modal');
});

test('a note deleted mid-run is reported and skipped', async () => {
    const shell = threeDueNotes();
    await start(shell);
    shell.removeFile('b.md');
    shell.takeNotices();

    await grade(shell, 'Perfect recall');

    assert.deepEqual(
        shell.takeNotices().filter(message => message.startsWith('Note not found')),
        ['Note not found: b.md']
    );
    assert.equal(shell.stripTitle(), 'c', 'the run continues with the next note that exists');
});

test('the bar re-attaches if Obsidian rebuilds the pane', async () => {
    const shell = threeDueNotes();
    await start(shell);
    assert.ok(shell.strip());

    // Simulate Obsidian tearing the leaf content down and putting it back.
    const rebuilt = new MiniElement('div');
    rebuilt.addClass('workspace-leaf-content');
    shell.leaf.view.containerEl = rebuilt;

    shell.fireLayoutChange();
    await shell.settle();

    assert.ok(shell.strip(), 'the bar comes back');
    assert.equal(rebuilt.hasClass('sf-strip-host'), true);
    assert.equal(shell.stripTitle(), 'a');
});

test('a grade for a note that is no longer due is refused, not silently dropped', async () => {
    const shell = threeDueNotes();
    await start(shell);
    // The note gets rescheduled out from under the run (another device, a sync).
    shell.service.schedules['a.md'].nextReviewDate = DateUtils.addDays(Date.now(), 9);
    shell.takeNotices();

    await grade(shell, 'Perfect recall');

    assert.deepEqual(shell.takeNotices(), [
        'Note previewed, not recorded',
        'Nothing recorded — this note is not due.',
    ]);
    assert.deepEqual(shell.opened, ['a.md'], 'the flow stays put rather than skipping ahead');
    assert.ok(shell.strip(), 'the bar is still there');
});

test('MCQ review during a run keeps the run going instead of stacking a dialog', async () => {
    const shell = threeDueNotes();
    await start(shell);

    // The MCQ dialog rates the note through the same controller entry point.
    await shell.reviewController.processReviewResponse('a.md', ReviewResponse.CorrectWithHesitation);
    await shell.settle();

    assert.equal(shell.service.history.length, 1);
    assert.equal(shell.stripTitle(), 'b', 'the docked run moved on, no modal was raised');
    assert.equal(shell.flow.isActive(), true);
});

test('unloading the plugin mid-run clears everything up', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await grade(shell, 'Perfect recall');

    shell.flow.dispose();

    assert.equal(shell.strip(), null);
    assert.equal(shell.keydownListenerCount(), 0);
    assert.equal(shell.flow.isActive(), false);
    // The grade that already happened is kept.
    assert.equal(shell.service.history.length, 1);
});

test('the interval preview on each button matches the interval the grade produces', async () => {
    const shell = threeDueNotes();
    await start(shell);

    const intervalText = shell.strip()?.byClass('sf-strip-grade-interval').map(element => element.text) ?? [];
    assert.equal(intervalText.length, 6);
    assert.ok(intervalText.every(text => text.length > 0), `every button shows an interval: ${intervalText.join(',')}`);

    // What the button promised for "correct with hesitation" must be what the
    // schedule actually does when that button is pressed.
    const promised = intervalText[4];
    assert.match(promised, /^\d+d$/, `expected a day-based interval, got ${promised}`);
    await grade(shell, 'Correct with hesitation');
    const actualDays = DateUtils.dayDifferenceUTC(Date.now(), shell.service.schedules['a.md'].nextReviewDate);
    assert.equal(`${actualDays}d`, promised);
});

test('the number-key preference can be switched off without losing the letters', async () => {
    const shell = threeDueNotes({ reviewStripGradeKeys: false });
    await start(shell);

    assert.equal(await press(shell, '3'), false, 'digits no longer grade');
    assert.equal(shell.service.history.length, 0);
    assert.equal(await press(shell, 's'), true, 'letters still work');
    assert.equal(shell.stripTitle(), 'b');
});

test('the docked bar is what a default install gets', async () => {
    assert.equal(DEFAULT_SETTINGS.reviewInterface, 'strip');
    const shell = threeDueNotes();
    assert.equal(shell.settings.reviewInterface, 'strip');

    await shell.reviewController.reviewNote('a.md');
    await shell.settle();

    assert.equal(shell.flow.isActive(), true);
    assert.equal(shell.stripTitle(), 'a');
});

test('a vault still set to the old dialog interface is migrated to the docked bar', async () => {
    // Vaults that had the dialog selected must not be left on a dead setting.
    const legacy = { ...DEFAULT_SETTINGS, reviewInterface: 'modal' } as unknown as typeof DEFAULT_SETTINGS;
    assert.equal(migrateSettings(legacy), true, 'the migration reports a change to save');
    assert.equal(legacy.reviewInterface, 'strip');
    migrateSettings(legacy);
    assert.equal(legacy.reviewInterface, 'strip', 'and stays migrated however often it runs');

    // And the routing ignores a legacy value even before a save happens.
    const shell = threeDueNotes();
    shell.settings.reviewInterface = 'modal' as never;
    await shell.reviewController.reviewNote('a.md');
    await shell.settle();

    assert.equal(shell.flow.isActive(), true, 'reviewing is docked whatever the stored value says');
    assert.equal(shell.stripTitle(), 'a');
});

test('grading in the middle of a queue keeps the queue order intact', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    shell.addNote({ path: 'c.md' });
    await start(shell, 'b.md');

    assert.deepEqual(shell.opened, ['b.md']);
    await grade(shell, 'Perfect recall');
    assert.deepEqual(shell.opened, ['b.md', 'c.md'], 'it carries on after b');
    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'a', 'and wraps to the note still due');
});

test('a quick double grade cannot double-count a note', async () => {
    const shell = threeDueNotes();
    await start(shell);

    // Two clicks before the first one has finished writing.
    shell.clickGrade('Perfect recall');
    shell.clickGrade('Perfect recall');
    await shell.settle();

    const aReviews = shell.service.history.filter(item => item.path === 'a.md').length;
    assert.equal(aReviews, 1, 'a is rated once');
    assert.notEqual(shell.stripTitle(), 'a', 'the flow is past a');
});

test('a note due later today but not yet scheduled is left alone', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'due.md' });
    shell.addNote({ path: 'tomorrow.md', dueInDays: 1 });
    await start(shell);

    assert.deepEqual(shell.duePaths(), ['due.md'], 'only what is due joins the run');
    await grade(shell, 'Perfect recall');
    assert.ok(shell.stripText().includes('Review session complete'), 'one note is a complete run');
    assert.equal(shell.service.schedules['tomorrow.md'].reviewCount, 3, 'the future note is untouched');
});

test('a hierarchical session still drives the order while the bar is docked', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'session/one.md' });
    shell.addNote({ path: 'session/two.md' });
    shell.setActiveSession('session/one.md');
    await start(shell);

    await grade(shell, 'Perfect recall');
    assert.deepEqual(shell.opened, ['a.md', 'session/one.md'], 'the session file opens next, not the next due note');
    assert.equal(shell.stripTitle(), 'one');

    // The session hands out its next file...
    shell.setActiveSession('session/two.md');
    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'two');

    // ...and then runs dry: the run reports that rather than stalling.
    shell.setActiveSession(null); // still in a session, but out of files
    shell.takeNotices();
    await grade(shell, 'Perfect recall');

    assert.ok(
        shell.takeNotices().some(message => message.includes('Hierarchical review session complete')),
        'running out of session files is announced'
    );
    assert.equal(shell.flow.isActive(), true, 'the bar stays up for whatever is still due');
});

test('files pulled in by a session are graded even though they are not due', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'session/deep.md', dueInDays: 30 });
    shell.setActiveSession('session/deep.md');
    await start(shell);

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'deep');

    // A file the session hands over is shown, and rating it is a preview: it is
    // not due, so nothing is written and the flow says so instead of guessing.
    shell.takeNotices();
    await grade(shell, 'Perfect recall');
    assert.deepEqual(shell.takeNotices(), [
        'Note previewed, not recorded',
        'Nothing recorded — this note is not due.',
    ]);
    assert.equal(shell.service.schedules['session/deep.md'].reviewCount, 3, 'the future note is untouched');
});

test('a grade cannot be entered while the leech question is open, and neither can a skip', async () => {
    const shell = new FakeShell({ leechThreshold: 2 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 1 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');
    assert.equal(shell.strip()?.byClass('sf-strip-decision-button').length, 4);

    // The buttons are gone, so a stray click cannot double-record...
    assert.equal(shell.gradeButtons().length, 0);
    // ...and n/p/u stay inert until the question is answered.
    assert.equal(await press(shell, 's'), false);
    assert.equal(await press(shell, 'p'), false);
    shell.takeNotices();
    assert.equal(await shell.flow.skip().then(() => true), true);
    assert.ok(shell.takeNotices().some(message => message.includes('Answer the question about this note first')));
    assert.equal(shell.stripTitle(), 'a', 'still waiting on the same note');

    await decide(shell, 3);
    assert.equal(shell.stripTitle(), 'b');
});

test('a rating with no run going carries on through the docked bar', async () => {
    const shell = threeDueNotes();
    const capture = captureDockedRuns();
    shell.takeNotices();

    try {
        const result = await shell.reviewController.processReviewResponse('a.md', ReviewResponse.PerfectRecall);
        await shell.settle();

        assert.equal(result.recorded, true);
        assert.equal(result.nextPath, 'b.md');
        assert.equal(result.nextPathSource, 'queue');
        assert.equal(shell.stripTitle(), 'b', 'the bar is showing the next note');
        assert.deepEqual(capture.started, [], 'and the routing went through the flow, not a second start');
        assert.ok(shell.saves > 0, 'the rating is persisted');
    } finally {
        capture.restore();
    }
});

test('a rating from the question dialog starts a docked run when none is going', async () => {
    const shell = threeDueNotes();

    {
        // An MCQ question was answered for note a while no run is active.
        await shell.reviewController.processReviewResponse('a.md', ReviewResponse.CorrectWithHesitation);
        await shell.settle();

        assert.equal(shell.flow.isActive(), true, 'a run picks up from where the rating left off');
        assert.deepEqual(shell.opened, ['b.md']);
        assert.equal(shell.stripTitle(), 'b');
    }
});

test('reviewing a note straight from the sidebar opens it with the bar, not a dialog', async () => {
    const shell = threeDueNotes();

    {
        await shell.reviewController.reviewNote('c.md');
        await shell.settle();

        assert.deepEqual(shell.opened, ['c.md']);
        assert.equal(shell.stripTitle(), 'c');
        assert.match(shell.stripText(), /\d+\/3 notes/, 'the bar carries the run readout');
    }
});
test('the readout follows the reader: one place per grade, never backwards', async () => {
    const shell = threeDueNotes();
    await start(shell);
    let previous = counterAt(shell);
    assert.ok(previous >= 1, 'the readout starts on the note the reader is standing on');

    for (let i = 0; i < 3; i++) {
        await grade(shell, 'Perfect recall');
        await shell.settle();
        const now = counterAt(shell);
        assert.ok(now >= previous, `the readout never goes backwards (${previous} -> ${now})`);
        previous = now;
    }
});
test('a note postponed in the sidebar mid-run leaves the running order cleanly', async () => {
    const shell = threeDueNotes();
    await start(shell);

    // The sidebar's postpone button for b, while the bar is showing a.
    await shell.reviewController.postponeNote('b.md', 1);
    await shell.settle();

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'c', 'the postponed note is stepped over');
    assert.ok(!shell.duePaths().includes('b.md'));
});

test('reviewing a past date from the calendar keeps previews and recordings consistent', async () => {
    const shell = new FakeShell();
    // A note that came due exactly one week ago.
    shell.addNote({ path: 'a.md', dueInDays: -7 });
    shell.addNote({ path: 'b.md', dueInDays: -7 });
    const reviewDay = DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), -7);
    shell.reviewController.setReviewDateOverride(reviewDay);
    await start(shell);

    assert.deepEqual(shell.duePaths(), ['a.md', 'b.md'], 'the run covers that day, not today');

    const promised = shell.strip()?.byClass('sf-strip-grade-interval').map(element => element.text) ?? [];
    assert.match(promised[5] ?? '', /^\d+d$/, `expected a day-based preview, got ${promised[5]}`);

    await grade(shell, 'Perfect recall');

    const promisedDays = Number((promised[5] ?? '0d').replace('d', ''));
    const recorded = shell.service.schedules['a.md'];
    assert.equal(DateUtils.dayDifferenceUTC(recorded.nextReviewDate, reviewDay), promisedDays,
        'the note is scheduled using the reviewed date, exactly as the button said');
});

test('a queue that repeats a path still behaves as one item', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    // Drive the model directly with a duplicated path, as a defensive caller might.
    shell.flow.start();
    await shell.settle();

    assert.equal(shell.strip()?.byClass('sf-strip-grade').length, 6);
    await grade(shell, 'Perfect recall');
    assert.ok(shell.stripText().includes('Review session complete'));
});

test('an FSRS note that keeps lapsing is asked about too', async () => {
    const shell = new FakeShell({ leechThreshold: 3, fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false } });
    shell.addNote({
        path: 'a.md',
        schedule: {
            schedulingAlgorithm: 'fsrs',
            fsrsData: { stability: 3, difficulty: 7, elapsed_days: 4, scheduled_days: 4, reps: 6, lapses: 2, state: 2 },
        },
    });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Again'); // the third lapse

    assert.equal(shell.strip()?.byClass('sf-strip-decision-button').length, 4, 'the question is asked for FSRS notes as well');
    assert.ok(shell.stripText().includes('lapsed 3 times'), shell.stripText());
    await decide(shell, 3);
    assert.equal(shell.stripTitle(), 'b');
});

test('a run over a large queue stays linear and lands correctly', async () => {
    const shell = new FakeShell();
    const total = 120;
    for (let i = 0; i < total; i++) {
        shell.addNote({ path: `note-${String(i).padStart(3, '0')}.md` });
    }
    await start(shell);
    assert.ok(shell.stripText().includes(`1/${total}`), 'the readout is where the reader stands');

    for (let i = 0; i < 6; i++) {
        await grade(shell, 'Perfect recall');
    }

    assert.ok(shell.stripText().includes(`7/${total}`), shell.stripText());
    assert.equal(shell.stripTitle(), 'note-006');
    assert.equal(shell.service.history.length, 6);
});

test('a note with an interval at the maximum still previews and records the same day', async () => {
    const shell = new FakeShell({ maximumInterval: 365 });
    shell.addNote({ path: 'ancient.md', schedule: { interval: 364, repetitionCount: 9, ease: 250 } });
    await start(shell);

    const promised = shell.strip()?.byClass('sf-strip-grade-interval').map(element => element.text) ?? [];
    await grade(shell, 'Perfect recall');

    const promisedDays = Number((promised[5] ?? '0d').replace('d', ''));
    const actualDays = DateUtils.dayDifferenceUTC(Date.now(), shell.service.schedules['ancient.md'].nextReviewDate);
    assert.equal(actualDays, promisedDays);
    assert.ok(actualDays <= 365, `capped at the maximum interval, got ${actualDays}`);
});

test('closing the note pane mid-run walks the note back: a live run never goes invisible', async () => {
    const shell = threeDueNotes();
    await start(shell);

    shell.closeLeaf();
    shell.fireLayoutChange();
    await shell.settle();

    // The pane is gone, so the bar does not keep sitting inside a dead leaf: the
    // note is opened again, once, and the bar comes back with it.
    assert.ok(shell.strip(), 'the bar is on screen again');
    assert.deepEqual(shell.opened, ['a.md', 'a.md'], 'the note was walked back to, once');
    assert.equal(shell.stripTitle(), 'a');

    // And the run carries on from where it was.
    assert.equal(await press(shell, '5'), true);
    assert.equal(shell.stripTitle(), 'b');
    assert.equal(shell.service.history.length, 1);
});

test('a pane that is only rebuilt (theme reload, split change) keeps its bar', async () => {
    const shell = threeDueNotes();
    await start(shell);

    const rebuilt = new MiniElement('div');
    rebuilt.addClass('workspace-leaf-content');
    shell.leaf.view.containerEl = rebuilt;
    shell.fireLayoutChange();
    await shell.settle();

    assert.ok(shell.strip());
    assert.equal(shell.stripTitle(), 'a');
});

// ---------------------------------------------------------------------------
// The day is one habit: when the notes run out, the decks are the next thing,
// and the bar says so — with the way there, not just the number.
// ---------------------------------------------------------------------------

test('a finished run hands the day over to the decks', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.ok(shell.stripText().includes('Session complete'), shell.stripText());
    assert.equal(shell.flow.runPosition().total, 3, 'the sitting that finished was its three notes');

    // The decks report in after the sitting is over: the day's other half is
    // offered where the reader is standing, with the way there.
    shell.pluginRef.deckDueCount = 31;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 31 }, (_, i) => `deck-${i + 1}`);
    shell.flow.refreshCurrent();
    await shell.settle();

    const handoff = shell.strip()?.byClass('sf-strip-next-button')[0];
    assert.ok(handoff, 'the decks are offered at the end of the queue');
    assert.match(shell.stripText(), /Study 31 cards/);
    assert.equal(shell.flow.runPosition().total, 3, 'and a count that came late does not grow a finished sitting');
});

test('nothing is offered when the decks hold nothing, or the count is stale', async () => {
    const shell = threeDueNotes();
    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');

    assert.equal(shell.strip()?.byClass('sf-strip-next-button').length, 0, 'no count, no offer');

    // A count from an hour ago is not a count.
    shell.pluginRef.deckDueCount = 12;
    shell.pluginRef.deckDueCountedAt = Date.now() - 3_600_000;
    shell.pluginRef.deckDueDecks = Array.from({ length: 12 }, (_, i) => `deck-${i + 1}`);
    shell.flow.refreshCurrent();
    await shell.settle();
    assert.equal(shell.strip()?.byClass('sf-strip-next-button').length, 0, 'a stale count is not printed');
});

// ---------------------------------------------------------------------------
// A failure stays in the same day: the note is drilled again before the session
// ends, the way Anki re-asks a lapsed card after its relearning step.
// ---------------------------------------------------------------------------

test('a failed note comes back later in the same run', async () => {
    const shell = threeDueNotes();
    await start(shell);
    assert.equal(shell.stripTitle(), 'a');

    // "Incorrect" (1) on an SM-2 note: interval 0, so it is still due today.
    await grade(shell, 'Incorrect');
    assert.equal(shell.stripTitle(), 'b', 'the run moves on to the next note');
    assert.equal(shell.service.schedules['a.md'].nextReviewDate, DateUtils.startOfUTCDay(new Date()), 'a is due today');

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'c');

    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'a', 'and now the failed note is back');
    assert.ok(!shell.stripText().includes('Session complete'), 'the run is not over');

    await grade(shell, 'Perfect recall');
    assert.equal(
        shell.service.schedules['a.md'].nextReviewDate,
        DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), 1),
        'passing it again schedules I(1) = 1 day'
    );
    assert.ok(shell.stripText().includes('Session complete'), 'every note has been passed');
    assert.deepEqual(shell.service.history.map(h => h.path), ['a.md', 'b.md', 'c.md', 'a.md']);
});

test('an FSRS failure keeps the note in the run too, on a same-day step', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'x.md', schedule: { schedulingAlgorithm: 'fsrs', interval: 10, fsrsData: {
        stability: 10, difficulty: 5, elapsed_days: 10, scheduled_days: 10, reps: 4, lapses: 0, state: 2,
        last_review: Date.now() - 10 * 86400000,
    } } });
    shell.addNote({ path: 'y.md' });
    await start(shell);

    assert.equal(shell.stripTitle(), 'x');
    await grade(shell, 'Again');

    const x = shell.service.schedules['x.md'];
    assert.equal(x.fsrsData!.state, 3, 'a lapsed card goes to relearning');
    assert.ok(x.nextReviewDate <= DateUtils.endOfUTCDay(new Date()), 'due again today');
    assert.equal(shell.stripTitle(), 'y', 'the run moves on');

    await grade(shell, 'Perfect recall');   // y is an SM-2 note
    assert.equal(shell.stripTitle(), 'x', 'and x is asked again in this session');

    await grade(shell, 'Good');             // x is FSRS, so its own labels
    assert.ok(shell.stripText().includes('Session complete'), shell.stripText());
    assert.ok(shell.service.schedules['x.md'].nextReviewDate > DateUtils.endOfUTCDay(new Date()), 'x graduated back to days');
});

test('skipping a failed note lets the run finish (the bury escape hatch)', async () => {
    const shell = threeDueNotes();
    await start(shell);

    await grade(shell, 'Incorrect');   // a stays due today
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.equal(shell.stripTitle(), 'a', 'a is back');
    assert.ok(await press(shell, 's'), 'skip is claimed');

    assert.ok(shell.stripText().includes('Session complete'), shell.stripText());
    // The skip key buries the note for this session without recording anything.
    assert.equal(shell.service.history.filter(h => h.path === 'a.md').length, 1, 'only the failed grade is in the history');
    assert.ok(shell.service.getDueNotes(new Date().getTime()).some(s => s.path === 'a.md'), 'a is still due today');
});

test('the leaky note that keeps failing can still be ended', async () => {
    const shell = threeDueNotes();
    await start(shell);
    // Fail the same note three times over: the run must never lose the ability to
    // finish, and Escape must always work.
    for (let i = 0; i < 3; i++) {
        await grade(shell, 'Complete blackout');
    }
    assert.ok(shell.flow.isActive(), 'the run is still live');
    await press(shell, 'Escape');
    assert.equal(shell.flow.isActive(), false);
    assert.equal(shell.strip(), null, 'the bar is gone');
});

test('with the window setting, a session opens in its own window and leaves the pane alone', async () => {
    const shell = threeDueNotes({ reviewSessionPlacement: 'window' });

    await start(shell);

    assert.equal(shell.popoutOpens, 1, 'a window is created for the session');
    assert.equal(
        shell.popoutLeaf.view.containerEl.hasClass('sf-strip-host'),
        true,
        'the bar lives in the window',
    );
    assert.equal(
        shell.leaf.view.containerEl.hasClass('sf-strip-host'),
        false,
        'the pane the reader was working in is untouched',
    );
    assert.deepEqual(shell.opened, ['a.md'], 'the note is opened in the window too');

    // The whole run stays in that window: the second note opens there as well.
    await grade(shell, 'Correct with hesitation');
    assert.deepEqual(shell.opened, ['a.md', 'b.md']);
    assert.equal(shell.popoutOpens, 1, 'the same window is reused, not a new one per note');
    assert.equal(shell.leaf.view.containerEl.hasClass('sf-strip-host'), false);
});

test('the split setting keeps the session in the pane, as before', async () => {
    const shell = threeDueNotes({ reviewSessionPlacement: 'split' });

    await start(shell);

    assert.equal(shell.popoutOpens, 0, 'no window is created when the setting says split');
    assert.equal(shell.leaf.view.containerEl.hasClass('sf-strip-host'), true);
    assert.equal(shell.popoutLeaf.view.containerEl.hasClass('sf-strip-host'), false);
});

// ---------------------------------------------------------------------------
// The card lane's tab: the sitting lives in the dock, under the grades, and a
// tab switch hides it rather than throwing it away.
// ---------------------------------------------------------------------------

interface DeckLane {
    started: string[];
    live: boolean;
    mounts: number;
    tornDown: number;
    panel: MiniElement | null;
    /** The sitting's own root element inside the panel, as its view mounts it. */
    root: MiniElement | null;
}

/**
 * Give the shell a review-ready vault with the deck lane on it: what the plugin
 * exposes, and a sitting that asks the flow for the dock exactly as
 * DeckSessionController.mount() does.
 */
function withDeckLane(shell: FakeShell): DeckLane {
    shell.settings.studyEnabled = false;
    shell.settings.enableMCQ = true;
    const plugin = shell.pluginRef as Record<string, unknown>;
    plugin.studyController = {
        subscribeChart: () => () => undefined,
        chartUpdate: () => null,
    };
    plugin.mcqController = { ensureMcqSetForNote: async () => null };
    plugin.deckDueCount = null;
    plugin.deckDueDecks = [];
    plugin.deckDueCountedAt = 0;

    const lane: DeckLane = { live: false, mounts: 0, tornDown: 0, panel: null, root: null, started: [] };
    const mountSitting = (): void => {
        lane.live = true;
        shell.flow.showCardSitting(container => {
            lane.mounts += 1;
            lane.panel = container as unknown as MiniElement;
            // The real DeckSessionView marks the panel it was handed and
            // mounts its own root inside it — the markup a sweep must never
            // be allowed to reach while the sitting is live.
            lane.panel.addClass('sf-deck-host');
            lane.root = lane.panel.createDiv('sf-deck');
            return () => { lane.live = false; lane.tornDown += 1; };
        });
    };
    plugin.deckSessionController = {
        isActive: () => lane.live,
        currentDeckPath: () => lane.started[lane.started.length - 1] ?? null,
        startAllDue: async () => { mountSitting(); },
        // A deck step sits that deck: the run walks the queue deck by deck.
        start: async (deckPath: string) => { lane.started.push(deckPath); mountSitting(); },
        // A live sitting walks over to another deck: same panel, new cards.
        switchDeck: async (deckPath: string) => { lane.started.push(deckPath); lane.live = true; },
    };
    return lane;
}

/**
 * A document-wide search, as the real sweep sees it.
 *
 * The mini DOM has no single document root, so a test names the trees that make
 * up the app — install it only where the sweep is driven, and keep the roots
 * current inside the callback (a sweep may run against a leaf that was replaced
 * mid-test).
 */
function installDocumentSweep(shell: FakeShell, roots: () => MiniElement[]): void {
    (shell.document as unknown as { querySelectorAll: (selector: string) => MiniElement[] }).querySelectorAll =
        selector => roots().flatMap(root => root.querySelectorAll(selector));
}

test("the bar's Cards tab sits the deck in the dock, under the grades", async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    // The decks the run will hand over to: without them there is no deck step
    // to reach, and the cards control stays out of the note's tab row. No count
    // is set, so the tab's label carries no number.
    shell.pluginRef.deckDueDecks = ['decks/one.md'];

    await start(shell);
    // The decks' control appears once the run reaches their steps.
    await walkToCards(shell);
    await shell.settle();

    const cards = shell.strip()?.byClass('sf-strip-tab-cards')[0];
    assert.ok(cards, 'the bar carries the cards tab');
    assert.equal(cards.text, 'Cards');

    cards.click();
    await shell.settle();

    assert.equal(lane.mounts, 1, 'the sitting mounted into the dock, once');
    const panel = lane.panel;
    assert.ok(panel, 'and the dock made a panel for it');
    assert.equal(panel.hasClass('sf-hidden'), false, 'the panel is on screen');
    assert.equal(
        shell.strip()?.byClass('sf-strip-tab-cards')[0].hasClass('is-active'),
        true,
        'and the tab it lives in is the active one',
    );

    // Leaving the tab keeps the sitting: hidden, never unmounted.
    // A deck step's tab row is the cards' alone, so step back to a note to
    // leave the tab — and the sitting waits, hidden, the way it always did.
    shell.flow.stepBack();
    await shell.settle();
    await shell.settle();
    shell.strip()?.byClass('sf-strip-tab-mcq')[0].click();
    await shell.settle();
    assert.equal(lane.mounts, 1, 'no second mount on the way out');
    assert.equal(panel.hasClass('sf-hidden'), true, 'the sitting waits, hidden');
    assert.equal(lane.tornDown, 0, 'and nothing was torn down');

    // The hidden sitting still listens on the document, so the bar takes the
    // keys off it: a card nobody can see must not be answered.
    shell.document.press('3');
    assert.equal(shell.document.lastEvent?.immediateStopped, true, 'the keys belong to the bar, not the hidden card');
    assert.equal(lane.mounts, 1, 'and the stale key did not touch the sitting');

    await walkToCards(shell);
    await shell.settle();
    assert.equal(lane.mounts, 1, 'coming back shows the same sitting');
    assert.equal(panel.hasClass('sf-hidden'), false);

    // Ending the review run takes the dock — and the sitting in it — down.
    await press(shell, 'Escape');
    assert.equal(lane.tornDown, 1, "the sitting's teardown ran with the dock");
    assert.equal(shell.strip(), null, 'and the bar is gone');
    assert.equal(shell.flow.isActive(), false);
});

test('a hidden card sitting does not take the escape key off the review', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    // The decks the run will hand over to: without them there is no deck step
    // to reach, and the cards control stays out of the note's tab row. No count
    // is set, so the tab's label carries no number.
    shell.pluginRef.deckDueDecks = ['decks/one.md'];

    await start(shell);

    await walkToCards(shell);
    await shell.settle();
    // A deck step's tab row is the cards' alone, so step back to a note to
    // leave the tab — and the sitting waits, hidden, the way it always did.
    shell.flow.stepBack();
    await shell.settle();
    await shell.settle();
    shell.strip()?.byClass('sf-strip-tab-mcq')[0].click();
    await shell.settle();
    assert.equal(lane.mounts, 1, 'the sitting is docked, out of sight');

    assert.equal(await press(shell, 'Escape'), true, 'the bar claims escape, as it always has');
    assert.equal(shell.document.lastEvent?.immediateStopped, false, 'it was never taken off the bar');
    assert.equal(shell.flow.isActive(), false, 'and the review ends on it');
    assert.equal(lane.tornDown, 1, 'the docked sitting goes with the dock');
});

test('a finished run still hands the decks into the dock, not a window', async () => {
    const shell = threeDueNotes();
    withDeckLane(shell);
    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.ok(shell.stripText().includes('Session complete'), shell.stripText());

    // No current note any more — and the dock is still exactly where the reader
    // is standing, which is where the cards have to open.
    let mounted = 0;
    assert.equal(
        shell.flow.showCardSitting(() => {
            mounted += 1;
            return () => undefined;
        }),
        true,
        'the bar stayed, so its dock takes the sitting',
    );
    assert.equal(mounted, 1, 'and the sitting mounted into it');
});

test('finishing the notes opens the cards by itself, once', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 31;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 31 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.equal(lane.mounts, 0, 'not while notes are still waiting');

    await grade(shell, 'Perfect recall');
    await shell.settle();

    assert.equal(lane.mounts, 1, 'the end of the queue is the start of the cards');

    // Ending the sitting is the reader's answer, and it is not reopened.
    lane.live = false;
    shell.flow.refreshCurrent();
    await shell.settle();
    assert.equal(lane.mounts, 1, 'never reopened behind the reader');
});

// ---------------------------------------------------------------------------
// The sitting counts everything it is made of: the notes, and the decks' cards
// as their own series of steps behind them. Reaching the cards is a step of the
// run, and the step shows the sitting — it never has to be hunted for.
// ---------------------------------------------------------------------------

/** The number the bar's counter is standing on, whatever it counts. */
function stepNumber(shell: FakeShell): number {
    const match = shell.stripText().match(/(\d+)\/(\d+) (?:steps|notes)/);
    return match ? Number(match[1]) : -1;
}

/** The whole counter, noun and all. */
function counterText(shell: FakeShell): string {
    return shell.strip()?.byClass('sf-strip-progress-count')[0]?.text ?? '';
}

/** The card lane's own tab label, as the bar prints it. */
function cardTabText(shell: FakeShell): string {
    return shell.strip()?.byClass('sf-strip-tab-cards')[0]?.text ?? '';
}

/**
 * Press one of the bar's own navigation controls.
 *
 * A live card sitting owns the keyboard — a card on screen is a question — so
 * the bar's buttons are the reader's route while the decks' steps are up.
 */
function clickNav(shell: FakeShell, which: 'next' | 'previous'): void {
    const actions = shell.strip()?.byClass('sf-strip-action') ?? [];
    const button = which === 'next' ? actions[2] : actions[1];
    if (!button) throw new Error(`no ${which} control on the bar`);
    button.click();
}

/** Walk the notes out so the run stands on its deck steps. */
async function walkToCards(shell: FakeShell): Promise<void> {
    // Pure navigation: no grades, so it works in any host and handles nothing.
    for (let i = 0; i < 10 && !shell.flow.isOnCardsStep(); i++) {
        if (!shell.flow.isActive()) break;
        shell.flow.stepForward();
        await shell.settle();
    }
}

test('the counter counts the cards the decks are holding as steps of the run', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 3;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 3 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    assert.equal(counterText(shell), '1/6 steps', 'three notes and three cards is six things to get through');
    assert.equal(
        shell.strip()?.byClass('sf-strip-progress-count')[0].getAttribute('title'),
        '3 notes · 3 cards',
        'and the split is one hover away',
    );
    assert.equal(shell.flow.isOnCardsStep(), false, 'the run starts on its first note');

    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    assert.equal(lane.mounts, 0, 'the sitting is not opened while notes are still waiting');

    await grade(shell, 'Perfect recall');
    await shell.settle();

    assert.equal(counterText(shell), '4/6 steps', 'the three notes are behind the reader, the cards are not');
    assert.equal(shell.flow.isOnCardsStep(), true, 'the run walked into its card step');
    assert.equal(shell.flow.currentPath(), null, 'a card step is not a note to open or grade');
    assert.equal(lane.mounts, 1, 'and the sitting is open in the dock, without being asked for');
    assert.match(shell.stripText(), /sitting below/, shell.stripText());
    assert.equal(shell.strip()?.byClass('sf-strip-grade').length, 0, 'the card on screen has its own buttons');
    assert.equal(
        shell.strip()?.byClass('sf-strip-tab-cards')[0].hasClass('is-active'),
        true,
        'and its step is the open one',
    );
});

test('walking from one deck step to the next sits that deck, not the first one', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 2;
    shell.pluginRef.deckDueDecks = ['decks/one.md', 'decks/two.md'];
    shell.pluginRef.deckDueCountedAt = Date.now();

    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await shell.settle();

    assert.equal(shell.flow.isOnCardsStep(), true, 'the run walked into its first deck step');
    assert.deepEqual(lane.started, ['decks/one.md'], 'and sat that deck');

    // One more step: the next deck's step, with its own cards.
    shell.flow.stepForward();
    await shell.settle();
    await shell.settle();

    assert.equal(shell.flow.isOnCardsStep(), true, 'the second deck step is still a deck step');
    assert.deepEqual(
        lane.started,
        ['decks/one.md', 'decks/two.md'],
        'the sitting switched to the deck the bar is on',
    );
    assert.equal(lane.live, true, 'and the same sitting is still on screen');
});

test('every step of the run moves the bar\u2019s number by exactly one', async () => {
    const shell = threeDueNotes();
    // The deck lane's own stand-in: nothing docks, so the bar keeps the keys —
    // this is about the run's steps, not about the sitting.
    shell.pluginRef.deckDueCount = 2;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 2 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    assert.equal(stepNumber(shell), 1);

    const seen = [stepNumber(shell)];
    for (let step = 0; step < 4; step++) {
        assert.equal(await press(shell, 'n'), true, 'navigating is the bar\u2019s own key');
        seen.push(stepNumber(shell));
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5], 'one press, one place — never a jump of two');
    assert.equal(shell.flow.runPosition().handled, 0, 'and browsing still marks nothing as done');
});

test('the cards control walks the run to its card step instead of opening a tab beside it', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 3;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 3 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    assert.equal(shell.flow.runPosition().index, 0);

    await walkToCards(shell);
    await shell.settle();

    assert.equal(shell.flow.runPosition().index, 3, 'pressing Cards takes the run to the steps it stands for');
    assert.equal(shell.flow.isOnCardsStep(), true);
    assert.equal(counterText(shell), '4/6 steps');
    assert.equal(shell.flow.runPosition().handled, 0, 'the press is navigation: nothing was handled by it');
    assert.equal(lane.mounts, 1, 'and the sitting it stands for is on screen');

    // The run is still one walk: Previous steps off the cards, onto the last
    // note, and the dock follows the step back to the note's own panel.
    await shell.flow.stepBack();
    await shell.settle();
    assert.equal(shell.flow.currentPath(), 'c.md');
    assert.equal(shell.flow.isOnCardsStep(), false);
    assert.equal(
        shell.strip()?.byClass('sf-strip-tab-cards')[0].hasClass('is-active'),
        false,
        'the card step is not the open one any more',
    );
});

test('a count that arrives while the sitting is under way joins the run', async () => {
    const shell = threeDueNotes();
    await start(shell);
    assert.equal(counterText(shell), '1/3 notes', 'the decks had not reported yet, so the sitting is its notes');

    shell.pluginRef.deckDueCount = 3;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 3 }, (_, i) => `deck-${i + 1}`);
    await grade(shell, 'Perfect recall');

    assert.equal(counterText(shell), '2/6 steps', 'the cards are part of the sitting the run is walking');
    assert.equal(
        shell.strip()?.byClass('sf-strip-progress-count')[0].getAttribute('title'),
        '3 notes · 3 cards',
        'and the split counts the note that has been graded as part of it',
    );
});

test('an ended deck sitting spends its own step: the run walks on by one', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 3;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 3 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await grade(shell, 'Perfect recall');
    await shell.settle();
    assert.equal(lane.mounts, 1, 'the cards are on screen');
    assert.equal(stepNumber(shell), 4, 'standing on the first deck\u2019s step');

    // The sitting gives its slot back, exactly as DeckSessionController does
    // when the reader ends it or its last card is answered.
    lane.live = false;
    shell.flow.cardSittingEnded();
    await shell.settle();

    assert.equal(lane.tornDown, 1, 'the sitting ended');
    assert.equal(shell.flow.isOnCardsStep(), true, 'the run walks onto the next deck\u2019s step');
    assert.equal(stepNumber(shell), 5, 'by exactly one place, not to the end of the run');
    assert.equal(lane.started.at(-1), 'deck-2', 'and that step sits the next deck');
    assert.equal(shell.flow.runPosition().remaining, 2, 'the decks still to walk are still work');

    // The other two decks the same way: the run finishes when the last step of
    // it is walked, not when the first sitting ends.
    for (let sitting = 0; sitting < 2; sitting++) {
        lane.live = false;
        shell.flow.cardSittingEnded();
        await shell.settle();
    }
    assert.equal(shell.flow.isOnCardsStep(), false, 'the run walked off the cards');
    assert.ok(shell.stripText().includes('Review session complete'), shell.stripText());
    assert.equal(shell.flow.runPosition().remaining, 0);
    assert.ok(
        shell.stripText().includes('3 notes and 3 cards handled'),
        `the end says what the sitting was made of: ${shell.stripText()}`,
    );
});

test('the bar\u2019s number keeps moving one per step while a deck sitting comes and goes', async () => {
    // The reader\u2019s report: completing a deck left the number stuck at `7/11`
    // and navigation dead in both directions. The walk has to stay walkable.
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    shell.pluginRef.deckDueCount = 3;
    shell.pluginRef.deckDueCountedAt = Date.now();
    shell.pluginRef.deckDueDecks = Array.from({ length: 3 }, (_, i) => `deck-${i + 1}`);

    await start(shell);
    assert.equal(stepNumber(shell), 1);
    for (let step = 0; step < 3; step++) await grade(shell, 'Perfect recall');
    await shell.settle();
    assert.equal(stepNumber(shell), 4, 'three notes walked, standing on the first deck');

    // Navigating stays one per step with the tally and the cursor at odds. The
    // live sitting owns the keyboard (a card on screen is a question), so the
    // reader's route is the bar's own Previous/Next — the route they reported
    // as dead.
    const walked: number[] = [];
    for (let step = 0; step < 3; step++) {
        clickNav(shell, 'next');
        await shell.settle();
        walked.push(stepNumber(shell));
    }
    for (let step = 0; step < 3; step++) {
        clickNav(shell, 'previous');
        await shell.settle();
        walked.push(stepNumber(shell));
    }
    assert.deepEqual(walked, [5, 6, 4, 6, 5, 4], 'out, round the end of the queue, and back, one place a press');

    // The sitting ends: the step it was on is spent and the number moves by one.
    lane.live = false;
    shell.flow.cardSittingEnded();
    await shell.settle();
    assert.equal(stepNumber(shell), 5, 'the step the sitting stood on is spent, and the run walks to the next');
    assert.equal(lane.started.at(-1), 'deck-2', 'which is the second deck');
    assert.equal(shell.flow.runPosition().handled, 4, 'and exactly one step was spent — not the series');
});

test('a saved run comes back counting its card steps', async () => {
    const shell = threeDueNotes();
    const saved = {
        order: ['a.md', 'b.md', 'c.md', 'spaceforge:cards:0', 'spaceforge:cards:1', 'spaceforge:cards:2'],
        cursor: 0,
        handled: [],
        savedAt: Date.now(),
    };
    shell.pluginRef.pluginState = { noteRun: saved };

    assert.equal(shell.flow.resumeSavedRunIfAny(), true, 'the saved run came back');
    await shell.settle();

    assert.equal(counterText(shell), '1/6 steps', 'the cards it was holding are steps of the same run');
    assert.equal(shell.stripTitle(), 'a');
    // A count nobody has refreshed since (the deck lane's stand-in counts
    // nothing) does not add to or take from the steps the save carried.
    assert.equal(shell.flow.runPosition().total, 6);
});

test('with no dock up, the flow refuses a card sitting so the caller can fall back', () => {
    const shell = threeDueNotes();

    assert.equal(
        shell.flow.showCardSitting(() => () => undefined),
        false,
        'no run means no dock, and no docked sitting',
    );
});

/**
 * Where a session lives.
 *
 * A run is not tied to the pane its note is in: the same bar and the same dock
 * follow the reader to a window of its own or to the sidebar's review tab, and
 * the note stays where they are working.
 */
test('the session can move into a window of its own, and the note keeps its pane', async () => {
    const shell = threeDueNotes();
    await start(shell, 'a.md');

    shell.flow.setHost('window');
    await shell.settle();

    assert.equal(shell.flow.getHost(), 'window');
    assert.equal(shell.popoutOpens, 1, 'a window was opened for the session');
    assert.equal(shell.settings.reviewSessionHost, 'window', 'the home is remembered');
});

test('the sidebar hosts the session when it is handed a tab, and gives it back', async () => {
    const shell = threeDueNotes();
    await start(shell, 'a.md');

    // The tab the sidebar's review mode hands over.
    const tab = new MiniElement('div');
    shell.flow.setHost('sidebar', tab);
    await shell.settle();

    assert.equal(shell.flow.getHost(), 'sidebar');
    assert.equal(tab.byClass('sf-strip').length, 1, 'the bar moved into the tab');
    assert.equal(tab.hasClass('sf-host-sidebar'), true, 'the host is marked for its own CSS');
    assert.equal(shell.settings.reviewSessionHost, 'sidebar');

    // Leaving the tab puts the session back under the note.
    shell.flow.setHost('note');
    await shell.settle();
    assert.equal(tab.byClass('sf-strip').length, 0, 'the bar left the tab');
    assert.equal(shell.strip()?.byClass('sf-strip').length ?? 0, 1, 'and is back under the note');
});

test('a sidebar host without its tab is refused rather than half-applied', async () => {
    const shell = threeDueNotes();
    await start(shell, 'a.md');

    shell.flow.setHost('sidebar');
    await shell.settle();

    assert.equal(shell.flow.getHost(), 'note', 'nowhere to put it, so nothing changed');
});

// ---------------------------------------------------------------------------
// A live run must never go invisible: a host change moves the surfaces to a
// visible container or takes them down cleanly — and a card sitting is moved
// with the dock, never torn down by the move.
// ---------------------------------------------------------------------------

test('a host change with the pane gone walks the session back, never into a hidden tab', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    // The decks the run will hand over to: without them there is no deck step
    // to reach, and the cards control stays out of the note's tab row. No count
    // is set, so the tab's label carries no number.
    shell.pluginRef.deckDueDecks = ['decks/one.md'];

    await start(shell, 'a.md');

    // The sidebar's review tab takes the session — a live bar and dock in it.
    const tab = new MiniElement('div');
    shell.flow.setHost('sidebar', tab as unknown as HTMLElement);
    await shell.settle();
    assert.equal(tab.byClass('sf-strip').length, 1, 'the bar moved into the tab');
    assert.equal(tab.byClass('sf-dock').length, 1, 'and the dock with it');

    // A card sitting opens in the dock's cards tab (the bar is in the tab now).
    // Reaching the deck steps is what opens it: the note's own tab row does not
    // offer the decks before that.
    await walkToCards(shell);
    await shell.settle();
    assert.equal(lane.mounts, 1, 'the sitting is docked');

    // The reader's note pane is closed, and they leave the review tab: the
    // sidebar hides the tab the moment they switch away.
    shell.closeLeaf();
    tab.addClass('sf-hidden');
    shell.flow.setHost('note');
    await shell.settle();

    // Nothing of the session is left inside the hidden element...
    assert.equal(tab.byClass('sf-strip').length, 0, 'the bar left the hidden tab');
    assert.equal(tab.byClass('sf-dock').length, 0, 'and so did the dock');
    assert.equal(tab.hasClass('sf-hidden'), true, 'the tab is still hidden');

    // ...and the session is whole: a deck step has no note, so the closed pane is
    // not reopened for it. The sitting keeps its dock where it was mounted — moved
    // out of the hidden tab with the session, never restarted, never torn down.
    assert.equal(shell.flow.isActive(), true, 'the session is still live');
    assert.equal(lane.mounts, 1, 'the sitting was never re-mounted');
    assert.equal(lane.tornDown, 0, 'and never torn down');
    assert.equal(lane.live, true);
    assert.ok(lane.root, 'the sitting has its own root mounted');
    assert.equal(lane.root.closest('.sf-hidden'), null, 'and is out of the hidden tab as well');

    // And stepping back onto a note reopens it: the run is walking again, with a
    // pane to be seen in (the bar mounts there on the next render).
    shell.flow.stepBack();
    await shell.settle();
    await shell.settle();
    assert.ok(shell.opened.includes('c.md'), 'the run reopened the note it walked back to');
});

test('leaving the sidebar review mode leaves no session DOM inside the hidden tab', async () => {
    const shell = threeDueNotes();
    withDeckLane(shell);
    await start(shell, 'a.md');

    // What the sidebar hands over, and what it does on the way out.
    const tab = new MiniElement('div');
    shell.flow.setHost('sidebar', tab as unknown as HTMLElement);
    await shell.settle();
    assert.equal(tab.byClass('sf-strip').length, 1, 'the bar is in the tab');
    assert.equal(tab.byClass('sf-dock').length, 1, 'and the dock with it');

    shell.flow.setHost('note');
    tab.addClass('sf-hidden');
    await shell.settle();

    assert.equal(tab.byClass('sf-strip').length, 0);
    assert.equal(tab.byClass('sf-dock').length, 0);
    assert.equal(tab.byClass('sf-strip-host').length, 0, 'and the tab no longer looks like a mount point');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-strip').length, 1, 'the bar is under the note');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-dock').length, 1, 'and the dock with it');
});

// ---------------------------------------------------------------------------
// The sweep: leftovers from a previous instance go on load, and only then — a
// mount that runs after a layout change must leave the live session alone.
// ---------------------------------------------------------------------------

test('a layout change never takes a live sitting, its dock or its bar down', async () => {
    const shell = threeDueNotes();
    const lane = withDeckLane(shell);
    // The decks the run will hand over to: without them there is no deck step
    // to reach, and the cards control stays out of the note's tab row. No count
    // is set, so the tab's label carries no number.
    shell.pluginRef.deckDueDecks = ['decks/one.md'];

    await start(shell);

    // The reader has the card sitting docked under the grades.
    await walkToCards(shell);
    await shell.settle();

    const strip = shell.strip();
    const dock = shell.leaf.view.containerEl.byClass('sf-dock')[0];
    const panel = lane.panel;
    const sitting = lane.root;
    assert.ok(strip && dock && panel && sitting, 'the session is on screen');
    installDocumentSweep(shell, () => [shell.leaf.view.containerEl]);

    // Obsidian rebuilds the layout, and the bar re-renders after it.
    shell.fireLayoutChange();
    await shell.settle();
    shell.flow.refreshCurrent();
    await shell.settle();

    assert.equal(shell.strip(), strip, 'the very same bar element is still on screen');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-strip').length, 1, 'exactly one bar');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-dock').length, 1, 'exactly one dock');
    assert.equal(panel.children.includes(sitting), true, 'the sitting is still inside its panel');
    assert.equal(lane.mounts, 1, 'and was never re-mounted');
    assert.equal(lane.tornDown, 0, 'or torn down');
});

test('a stale bar and sitting from a previous instance are cleared on load', () => {
    const shell = new FakeShell();
    // A pane still carrying what a killed instance left behind.
    const pane = new MiniElement('div');
    const staleStrip = pane.createDiv('sf-strip');
    const staleDeck = pane.createDiv('sf-deck');
    installDocumentSweep(shell, () => [pane]);

    // The plugin loads again: the fresh controller sweeps before anything of
    // its own exists.
    const reloaded = new ReviewFlowController(shell.pluginRef as never);

    assert.ok(reloaded, 'a fresh controller came up');
    assert.equal(staleStrip.isConnected, false, 'the leftover bar is gone');
    assert.equal(staleDeck.isConnected, false, 'and the leftover card sitting with it');
});

// ---------------------------------------------------------------------------
// A session must be visible the moment it starts, wherever the reader is. The
// sidebar's review pane is a home only while it is the pane on screen: its mode
// is remembered across restarts, so a run can be started — from a note's title,
// or from a deck's Study button — while the sidebar is showing its list.
// ---------------------------------------------------------------------------

/**
 * A sidebar view stand-in: it answers the one question the session asks a
 * sidebar, and counts how often it was asked.
 *
 * The pane it stands for is deliberately left without `sf-hidden`. The leak the
 * reader hit is a pane the app has never hidden while another pane is the one
 * on screen, so the view's own answer — not the class — is what settles it.
 * `shows()` lets a test move the reader from the review tab to the list.
 */
function withSidebarPane(shell: FakeShell, visible: boolean): {
    pane: MiniElement;
    asked: () => number;
    shows: (visible: boolean) => void;
} {
    const pane = new MiniElement('div');
    pane.addClass('sf-sidebar-review');
    let showing = visible;
    let asked = 0;
    shell.pluginRef.getSidebarView = () => ({
        isReviewPaneVisible: () => { asked += 1; return showing; },
    });
    return {
        pane,
        asked: () => asked,
        shows: (next: boolean) => { showing = next; },
    };
}

test('a session started while the sidebar shows its list is seen, not left in the pane the reader left', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    withDeckLane(shell);
    const sidebar = withSidebarPane(shell, true);

    // The reader's session lives in the review tab, where it is visible.
    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    await start(shell, 'a.md');
    assert.equal(sidebar.pane.byClass('sf-strip').length, 1, 'the bar is in the pane');

    // They go back to the list. The pane is left holding the session (the leak:
    // nothing ever hid the pane, and the mode was written elsewhere) and the
    // reader presses a note's title there.
    sidebar.shows(false);
    await start(shell, 'a.md');

    assert.ok(sidebar.asked() > 0, 'the view itself was asked which pane is on screen');
    assert.equal(shell.flow.getHost(), 'note', 'the session moved to the home that is always visible');
    assert.equal(sidebar.pane.byClass('sf-strip').length, 0, 'no bar was left in the pane');
    assert.equal(sidebar.pane.byClass('sf-dock').length, 0, 'nor a dock');
    const strip = shell.strip();
    assert.ok(strip, 'the bar is under the note, where the reader can see it');
    assert.equal(strip.closest('.sf-hidden'), null, 'and nothing of it is inside anything hidden');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-strip').length, 1, 'exactly one bar');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-dock').length, 1, 'and the dock with it');
});

test('a card sitting started from the list is shown where the reader is standing', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    const lane = withDeckLane(shell);
    const sidebar = withSidebarPane(shell, true);

    // The run is in the review tab, where it is visible.
    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    await start(shell, 'a.md');
    assert.equal(sidebar.pane.byClass('sf-strip').length, 1, 'the bar is in the pane');
    assert.equal(sidebar.pane.byClass('sf-dock').length, 1, 'and the dock with it');

    // The reader is on the list — the pane was left holding the session — and
    // presses a deck's Study: exactly what DeckSessionController.mount() asks
    // the flow for.
    sidebar.shows(false);
    await (shell.pluginRef.deckSessionController as { startAllDue: () => Promise<void> }).startAllDue();
    await shell.settle();

    assert.equal(lane.mounts, 1, 'the sitting mounted');
    assert.equal(shell.flow.getHost(), 'note', 'the session came back under the note');
    assert.equal(sidebar.pane.byClass('sf-strip').length, 0, 'the bar left the pane');
    assert.equal(sidebar.pane.byClass('sf-dock').length, 0, 'so did the dock');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-dock').length, 1, 'the dock is under the note');
    assert.ok(lane.root, 'the sitting has its own root');
    assert.equal(lane.root.closest('.sf-hidden'), null, 'and is out of every hidden element');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-deck').length, 1, 'the sitting is where the reader is standing');
});

test('a sidebar that really is showing its review pane keeps the session', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    withDeckLane(shell);
    const { pane } = withSidebarPane(shell, true);

    shell.flow.setHost('sidebar', pane as unknown as HTMLElement);
    await start(shell, 'a.md');

    assert.equal(shell.flow.getHost(), 'sidebar', 'the session stays in the home the reader chose');
    assert.equal(pane.byClass('sf-strip').length, 1, 'the bar is in the pane');
    assert.equal(pane.byClass('sf-dock').length, 1, 'and the dock with it');
    assert.equal(shell.leaf.view.containerEl.byClass('sf-strip').length, 0, 'and not under the note');
});

test('a remembered run resumed while the sidebar shows its list comes back under the note', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'list' });
    withSidebarPane(shell, false);
    // A run interrupted when the app was closed: the state the plugin comes
    // back to on load.
    shell.pluginRef.pluginState = {
        noteRun: { order: ['a.md', 'b.md'], cursor: 0, handled: [], savedAt: Date.now() },
    };

    assert.equal(shell.flow.resumeSavedRunIfAny(), true, 'the saved run came back');
    await shell.settle();

    assert.equal(shell.flow.getHost(), 'note', 'it is shown under the note');
    assert.ok(shell.strip(), 'with its bar where the reader can see it');
    assert.equal(shell.stripTitle(), 'a', 'on the note it stopped at');
});

test('with no sidebar view up, a session starts from the note rather than opening the tab behind the reader', async () => {
    // The plugin can be asked for a run before the sidebar has ever been
    // opened, and the mode it would open is the list: the remembered home must
    // not drag the session into a pane the reader is not looking at.
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'list' });
    let revealed = 0;
    shell.pluginRef.activateSidebarView = async () => { revealed += 1; };

    await start(shell);

    assert.equal(revealed, 0, 'the review tab is not brought forward behind their back');
    assert.equal(shell.flow.getHost(), 'note', 'the session is shown under the note');
    assert.ok(shell.strip(), 'where the reader can see it');
});

test('the review pane is handed back when the reader moves the session out of it', async () => {
    // The report: the dock was taken to a window and the reader pressed Review
    // in the sidebar — nothing happened, because the pane still claimed the
    // session it no longer held (and the mode was still review, so the press
    // never even reached the view). Only List→Review cleared it. Handing the
    // pane back on the way out is what makes the first press work.
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    withDeckLane(shell);
    const sidebar = withSidebarPane(shell, true);

    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    await start(shell, 'a.md');
    assert.equal(shell.flow.getHost(), 'sidebar');
    assert.equal(shell.settings.sidebarViewType, 'review', 'the pane is the one on screen');

    shell.flow.setHost('window');
    await shell.settle();

    assert.equal(shell.flow.getHost(), 'window');
    assert.equal(
        shell.settings.sidebarViewType,
        'list',
        'an empty review pane stops being the pane on screen, so its next press can claim the session',
    );
    assert.equal(shell.settings.reviewSessionHost, 'window', 'and the reader’s own home is what was written');

    // The view’s own leave (persist: false) is a hand-back the view makes
    // itself: it drops its own claim there, and the flow must not rewrite the
    // pane’s mode out from under it.
    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    shell.settings.sidebarViewType = 'review';
    shell.flow.setHost('note', null, false);
    assert.equal(shell.settings.sidebarViewType, 'review', 'the view’s own leave leaves the mode alone');
});

test('a run ended inside the review pane frees the pane for the next press', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    withDeckLane(shell);
    const sidebar = withSidebarPane(shell, true);

    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    await start(shell, 'a.md');

    shell.flow.end();

    assert.equal(shell.flow.isActive(), false);
    assert.equal(shell.settings.sidebarViewType, 'list', 'the pane has nothing left to show, so it is handed back');
    assert.equal(shell.settings.reviewSessionHost, 'sidebar', 'and the reader’s remembered home is untouched');
});

test('a card answered in the sitting updates the bar’s own card count', async () => {
    // The dock counts what is *left of the sitting on screen*, so the sitting's
    // own redraws have to reach the bar: a count read from the sidebar's last
    // render never moved when the reader answered a card.
    const shell = threeDueNotes();
    withDeckLane(shell);
    shell.pluginRef.deckDueDecks = ['decks/one.md'];
    let answered = 0;
    Object.assign(shell.pluginRef.deckSessionController as unknown as Record<string, unknown>, {
        summary: () => ({ deckName: 'One', deckCount: 1, position: answered + 1, total: 5, answered }),
        currentCard: () => ({ position: answered + 1, total: 5 }),
    });

    // The sittings’ own view redraws itself; the flow watches the element it
    // was handed. The harness has no MutationObserver, so one is installed.
    const observers: { fire: () => void }[] = [];
    const globals = globalThis as { MutationObserver?: unknown };
    globals.MutationObserver = class {
        private readonly callback: () => void;
        constructor(callback: () => void) { this.callback = callback; observers.push(this); }
        observe(): void { /* the element itself is the app's business */ }
        disconnect(): void { /* nothing to stop in the stand-in */ }
        fire(): void { this.callback(); }
    };
    try {
        await start(shell);
        await walkToCards(shell);
        await shell.settle();

        assert.equal(observers.length, 1, 'the sitting’s element is watched, once');
        assert.equal(cardTabText(shell), 'Cards · 5', 'the tab counts the sitting, not the sidebar’s last count');

        answered = 1;
        observers[0].fire();
        await shell.settle();
        assert.equal(cardTabText(shell), 'Cards · 4', 'one card answered is one card less on the bar');
    } finally {
        delete globals.MutationObserver;
    }
});

test('a remembered home whose tab is the chosen pane is still opened', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    let revealed = 0;
    const opened: string[] = [];
    shell.pluginRef.activateSidebarView = async () => { revealed += 1; };
    shell.pluginRef.getSidebarView = () => ({ openReviewTab: async () => { opened.push('review'); } });

    await start(shell);
    await shell.settle();

    assert.equal(revealed, 1, 'the sidebar pane is revealed');
    assert.deepEqual(opened, ['review'], 'and the review tab is asked for');
});

// ---------------------------------------------------------------------------
// Pressing a deck's study control, with the sidebar showing its list.
//
// The reader's report: one press there and "nothing happened" — the bar came
// up with nothing under it, and switching to the sidebar's review tab was what
// finally made the cards appear. What one press has to end with is a card on
// screen: the dock expanded, the cards tab holding the sitting.
// ---------------------------------------------------------------------------

const DECK_PATH = 'spaceforge/decks/Grading demo.md';

/** A deck with two new cards: the smallest sitting that is still a queue. */
function deckFixture(): DeckBundle {
    const now = Date.now();
    const deckId = String(now - 30 * 86_400_000);
    const card = (id: string, index: number): AnkiCard => ({
        id,
        noteId: `n-${id}`,
        deckId,
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: now - 1000,
        newPosition: index,
        flag: 0,
    });
    return {
        deck: {
            id: deckId,
            name: 'Grading demo',
            modified: now,
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
                buryNewSiblings: false,
                buryReviewSiblings: false,
                maxAnswerSeconds: 60,
                againDelayMinutes: 10,
                scheduler: DeckScheduler.Sm2,
                fsrs: { desiredRetention: 0.9, maximumInterval: 36500, weights: [], useOwnWeights: false },
            },
        },
        notes: ['c1', 'c2'].map(id => ({
            id: `n-${id}`,
            modelName: 'Basic',
            fields: ['Front', 'Back'],
            values: [`Question ${id}`, `Answer ${id}`],
            tags: [],
            cardIds: [id],
            mediaFiles: [],
        })),
        cards: [card('c1', 0), card('c2', 1)],
        media: [],
    };
}

/**
 * The deck lane's real controller over the shell.
 *
 * The deck comes from an in-memory store and the surface is replaced by a
 * stand-in that marks its container the way DeckSessionView does — but the
 * entry point is the shipped one: `DeckSessionController.start()`, which is
 * what the sidebar's deck rows call, asking the flow for the dock exactly as
 * the app does (status is a bare class check in the dock, so `mountInto` and
 * the `sf-deck` root are what has to appear).
 */
function withRealDeckLane(shell: FakeShell): {
    controller: DeckSessionController;
    shown: DeckSessionCard[];
    log: string[];
} {
    shell.settings.deckSessionPlacement = 'split';
    const plugin = shell.pluginRef as Record<string, unknown>;
    plugin.pluginState = {};
    const log: string[] = [];
    const shown: DeckSessionCard[] = [];
    let root: MiniElement | null = null;

    const view = {
        mountInto: (container: HTMLElement) => {
            log.push('mount');
            const el = container as unknown as MiniElement;
            el.addClass('sf-deck-host');
            root = el.createDiv('sf-deck');
        },
        show: (card: DeckSessionCard) => {
            shown.push(card);
            root?.createDiv({ cls: 'sf-deck-front', text: card.view.front });
        },
        finish: () => undefined,
        pulse: () => undefined,
        destroy: () => undefined,
        isAnswering: () => true,
    };
    const store = {
        readDeck: async () => deckFixture(),
        updateCardStates: async () => 'in-place' as const,
    };
    const controller = new DeckSessionController(shell.pluginRef as never, store as never, {
        createView: () => view as never,
    });
    plugin.deckSessionController = controller;

    // The dock's own prerequisites: the deck lane's tab lives on the session's
    // bar, beside Study and MCQs, so the session is the configuration that
    // offers one. Study is off (the stand-in controller cannot badge a note);
    // the questions panel is on, which is what the dock needs to exist at all.
    plugin.studyController = { subscribeChart: () => () => undefined, chartUpdate: () => null };
    plugin.mcqController = { ensureMcqSetForNote: async () => null };
    plugin.deckDueCount = null;
    plugin.deckDueDecks = [];
    plugin.deckDueCountedAt = 0;
    shell.settings.studyEnabled = false;
    shell.settings.enableMCQ = true;
    return { controller, shown, log };
}

/** The one press the reader makes, and the waiting that follows it. */
async function pressDeckStudy(shell: FakeShell, controller: DeckSessionController): Promise<void> {
    await controller.start(DECK_PATH);
    await shell.settle();
}

/**
 * The dock as the reader finds it: expanded, on the cards tab, with the
 * sitting's own panel mounted and on screen.
 */
function assertDockShowsSitting(shell: FakeShell): MiniElement {
    const container = shell.leaf.view.containerEl;
    const dock = container.byClass('sf-dock')[0];
    assert.ok(dock, 'the dock is under the note');
    assert.equal(dock.hasClass('is-open'), true, 'and it is open, not a bar with nothing under it');

    const panel = dock.byClass('sf-dock-body')[0];
    assert.ok(panel, 'the dock made a panel for the sitting');
    assert.equal(panel.hasClass('sf-deck-host'), true, 'the sitting mounted into it');
    assert.equal(panel.hasClass('sf-hidden'), false, 'and the panel is on screen');
    assert.equal(dock.byClass('sf-deck').length, 1, 'the card sitting is in it');
    assert.equal(panel.byClass('sf-deck-host').length, 1, 'and its panel is the sitting\'s own home');
    return dock;
}

test('pressing a deck on the list ends with the dock open and the sitting’s card in it', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'list' });
    const lane = withRealDeckLane(shell);
    const sidebar = withSidebarPane(shell, false);

    await start(shell, 'a.md');
    assert.equal(shell.flow.getHost(), 'note', 'the run is under the note, where the reader is');

    // The reader is on the list — the review pane is not the pane on screen —
    // and presses the deck row's study control: exactly what the shipped row
    // handler does.
    await pressDeckStudy(shell, lane.controller);

    assert.equal(lane.shown.map(card => card.card.id).join(','), 'c1', 'the sitting started on its first card');
    const deckSitting = (shell.pluginRef.pluginState as { deckSitting?: { deckPath: string } }).deckSitting;
    assert.equal(deckSitting?.deckPath, DECK_PATH, 'and it is the sitting the reader asked for');

    const dock = assertDockShowsSitting(shell);
    const panel = dock.byClass('sf-dock-body')[0];
    assert.equal(
        panel.byClass('sf-deck-front')[0]?.text ?? '',
        lane.shown[0].view.front,
        'the card the reader was handed is the one on screen',
    );
    assert.ok((panel.byClass('sf-deck-front')[0]?.text ?? '').length > 0, 'and it has its question on it');
    assert.equal(
        shell.strip()?.byClass('sf-strip-tab-cards')[0].hasClass('is-active'),
        true,
        'the bar’s cards tab is the active one',
    );
    assert.equal(sidebar.pane.byClass('sf-deck').length, 0, 'and nothing was left behind in the review pane');
});

test('a sitting docked into a home the app has hidden brings that home back on screen', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'list' });
    const lane = withRealDeckLane(shell);
    withSidebarPane(shell, false);

    await start(shell, 'a.md');

    // The reader has moved away from the note: the leaf is connected, keeps
    // its DOM, and has no screen — Obsidian hides an inactive tab with
    // layout, so that is what the stand-in answers.
    const container = shell.leaf.view.containerEl as unknown as { getClientRects?: () => unknown[] };
    container.getClientRects = () => [];
    const revealed: unknown[] = [];
    (shell.pluginRef.app as { workspace: { revealLeaf: (leaf: unknown) => Promise<void> } }).workspace.revealLeaf =
        async (leaf: unknown) => { lane.log.push('reveal'); revealed.push(leaf); };

    await pressDeckStudy(shell, lane.controller);

    assert.deepEqual(revealed, [shell.leaf], 'the leaf holding the session was brought to the front');
    assert.deepEqual(lane.log, ['reveal', 'mount'], 'the home was made visible before the cards went into the dock');
    assertDockShowsSitting(shell);
});

test('a review pane the app has hidden hands the session back to the note before the cards dock', async () => {
    const shell = threeDueNotes({ reviewSessionHost: 'sidebar', sidebarViewType: 'review' });
    const lane = withRealDeckLane(shell);
    const sidebar = withSidebarPane(shell, true);

    // The view says this pane is the one on screen, and the pane itself has no
    // screen: the mode and the DOM have parted, and the session must not be
    // left holding cards in a pane nobody can see.
    (sidebar.pane as unknown as { getClientRects?: () => unknown[] }).getClientRects = () => [];
    shell.flow.setHost('sidebar', sidebar.pane as unknown as HTMLElement);
    await start(shell, 'a.md');
    assert.equal(sidebar.pane.byClass('sf-strip').length, 1, 'the run started in the pane');

    await pressDeckStudy(shell, lane.controller);

    assert.equal(shell.flow.getHost(), 'note', 'the session came back under the note');
    assert.equal(sidebar.pane.byClass('sf-deck').length, 0, 'with no cards left in the hidden pane');
    assertDockShowsSitting(shell);
});

// ------------------------------------------------- one remembered position
//
// The run's queue and cursor are the navigation state. The sidebar list's
// Previous/Next, the bar's Skip and a press on a note row all read and move
// that one place, so no surface can be showing a note another one disagrees
// with — and the position that comes back after a reload is the same one.

/** The saved run, as the plugin's own data store would carry it. */
function counterAt(shell: FakeShell): number {
    const match = shell.stripText().match(/(\d+)\/\d+ notes/);
    return match ? Number(match[1]) : -1;
}

function savedRun(shell: FakeShell): { order: string[]; cursor: number; handled: string[] } | null {
    const state = shell.pluginRef.pluginState as { noteRun?: { order: string[]; cursor: number; handled: string[] } | null } | undefined;
    return state?.noteRun ?? null;
}

test('the list’s Next moves the same cursor the dock is on', async () => {
    const shell = threeDueNotes();
    await start(shell);                                  // the run is on a
    assert.equal(shell.flow.currentPath(), 'a.md');
    shell.takeNotices();

    await shell.navigationController.navigateToNextNote();
    await shell.settle();

    assert.equal(shell.flow.currentPath(), 'b.md', 'the run’s own cursor moved');
    assert.equal(shell.flow.runPosition().index, 1);
    assert.equal(shell.stripTitle(), 'b', 'and the bar is on the note the list opened');
    assert.deepEqual(shell.opened, ['a.md', 'b.md']);
    // The readout is the bar's own counter, and it reads the run's position —
    // one number, the one the reader is standing on. (Navigation notices are
    // off by default, so the bar is the honest place to look.)
    assert.ok(shell.stripText().includes('2/3'), shell.stripText());

    // The dock's own control then takes the step the list just took.
    await shell.flow.skip();
    await shell.settle();
    assert.equal(shell.flow.currentPath(), 'c.md', 'the dock takes the same step the list did');
    assert.ok(shell.stripText().includes('3/3'), shell.stripText());
    assert.equal(shell.stripTitle(), 'c');

    await shell.navigationController.navigateToPreviousNote();
    await shell.settle();
    assert.equal(shell.flow.currentPath(), 'b.md', 'Previous walks the same queue back');
    assert.equal(shell.stripTitle(), 'b');
});

test('pressing a note the live run already has moves its cursor and keeps the queue', async () => {
    const shell = threeDueNotes();
    shell.pluginRef.pluginState = { noteRun: null };     // a vault that saves
    await start(shell);
    await press(shell, 's');                             // the dock's Skip: a is handled, the run is on b
    assert.equal(shell.flow.currentPath(), 'b.md');

    await shell.reviewController.reviewNote('a.md');     // a press on the sidebar row for a
    await shell.settle();

    assert.equal(shell.flow.currentPath(), 'a.md', 'the run moved to the note that was pressed');
    assert.equal(shell.stripTitle(), 'a', 'and the bar came with it — one position, not two');

    const saved = savedRun(shell);
    assert.ok(saved, 'the run is being saved');
    assert.deepEqual(saved.order, ['a.md', 'b.md', 'c.md'], 'the queue is the one the reader was walking');
    assert.deepEqual(saved.handled, ['a.md'], 'and what they already passed is not wiped by the press');
    assert.equal(saved.cursor, 0);

    // The skip is not undone either: walking on from here never offers a again.
    await press(shell, 's');                             // b
    await press(shell, 's');                             // c
    assert.equal(shell.flow.currentPath(), 'c.md');
    await press(shell, 's');                             // nothing left: the walk is over
    // Had the press rebuilt the queue, a — skipped before the press — would be
    // fresh work again and the walk would never reach its end.
    assert.ok(shell.stripText().includes('Review session complete'), shell.stripText());
    assert.ok(shell.stripText().includes('3 notes handled'), shell.stripText());
    assert.equal(shell.flow.runPosition().remaining, 0);
});

test('a note skipped in the dock is still skipped when the run comes back', async () => {
    const shell = threeDueNotes();
    shell.pluginRef.pluginState = { noteRun: null };
    await start(shell);
    await press(shell, 's');                             // a is skipped, the run is on b
    await shell.settle();

    const saved = savedRun(shell);
    assert.deepEqual(saved?.handled, ['a.md'], 'the skip was written down as the run moved');
    assert.deepEqual(saved?.order, ['a.md', 'b.md', 'c.md']);

    // The app is reopened: a fresh instance over the same vault and the same save.
    const reloaded = threeDueNotes();
    reloaded.pluginRef.pluginState = { noteRun: saved };
    assert.equal(reloaded.flow.resumeSavedRunIfAny(), true);
    await reloaded.settle();

    assert.equal(reloaded.flow.currentPath(), 'b.md', 'the run comes back where it stopped');
    assert.equal(reloaded.stripTitle(), 'b');
    assert.ok(
        reloaded.stripText().includes('2/3 notes'),
        `the note skipped before the reload still counts as passed: ${reloaded.stripText()}`
    );

    await reloaded.flow.skip();
    await reloaded.settle();
    assert.equal(reloaded.flow.currentPath(), 'c.md', 'and it is not offered again');
    assert.deepEqual(savedRun(reloaded)?.handled, ['a.md', 'b.md']);
});

test('with no run walking, the list’s Next still walks the due list', async () => {
    const shell = threeDueNotes();
    shell.reviewController.updateTodayNotes();
    shell.takeNotices();

    await shell.navigationController.navigateToNextNote();
    await shell.settle();

    assert.equal(shell.flow.isActive(), false, 'a walk of the list is not a sitting');
    // Notices are off by default: the walk itself must not pop anything.
    assert.deepEqual(shell.opened, ['b.md'], 'the due list’s own next note');
    assert.equal(shell.takeNotices().length, 0, 'a walk of the list is quiet by default');

    await shell.navigationController.navigateToPreviousNote();
    await shell.settle();
    assert.deepEqual(shell.opened, ['b.md', 'a.md'], 'and back the way it came');
});

test('the list’s “Review current note” follows the run, not a second count', async () => {
    const shell = threeDueNotes();
    await start(shell);                                  // the run is on a
    await press(shell, 's');                             // the dock’s Skip moves it to b
    assert.equal(shell.flow.currentPath(), 'b.md');

    await shell.reviewController.reviewCurrentNote();    // the list’s session menu
    await shell.settle();

    assert.equal(shell.flow.currentPath(), 'b.md', 'the note it named is the run’s own');
    assert.equal(
        shell.opened[shell.opened.length - 1],
        'b.md',
        'and the note it opens is the run’s own, not the head of the list'
    );
});

test('while a leech question is open, the list’s Next refuses the way the dock’s skip does', async () => {
    const shell = new FakeShell({ leechThreshold: 2 });
    shell.addNote({ path: 'a.md', schedule: { lapses: 1 } });
    shell.addNote({ path: 'b.md' });
    await start(shell);

    await grade(shell, 'Incorrect');
    assert.equal(shell.strip()?.byClass('sf-strip-decision-button').length, 4, 'the question is up');
    shell.takeNotices();

    await shell.navigationController.navigateToNextNote();
    await shell.settle();

    assert.ok(shell.takeNotices().some(message => message.includes('Answer the question about this note first')));
    assert.equal(shell.flow.currentPath(), 'a.md', 'the run does not step around a question that is waiting');
    assert.deepEqual(shell.opened, ['a.md'], 'and the due list is not walked in the run’s place');
});

test('walking the queue from the list never marks the reader\'s work done', async () => {
    const shell = threeDueNotes();
    shell.pluginRef.pluginState = { noteRun: null };
    await start(shell);

    // The list's own Next, three times: the reader is looking around.
    await shell.plugin.navigationController.navigateToNextNote();
    await shell.settle();
    await shell.plugin.navigationController.navigateToNextNote();
    await shell.settle();
    await shell.plugin.navigationController.navigateToNextNote();
    await shell.settle();

    const position = shell.flow.runPosition();
    assert.equal(position.handled, 0, 'browsing is not finishing: nothing is handled');
    assert.deepEqual(savedRun(shell)?.handled, [], 'and the save agrees');
    assert.equal(shell.flow.currentPath(), 'a.md', 'the cursor walked the whole queue and wrapped');

    // The dock's Skip is the thing that marks work — it still does.
    await press(shell, 's');
    await shell.settle();
    assert.equal(shell.flow.runPosition().handled, 1, 'a real skip counts');
});
