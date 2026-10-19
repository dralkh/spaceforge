/**
 * UI contract tests for the docked review bar: what it renders for each
 * algorithm and phase, and which handler each control calls. Rendering runs
 * against a miniature DOM (test/support/mini-dom.ts), so layout and styling are
 * not covered here — only the behaviour the user actually drives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReviewStrip, StripState } from '../ui/review-strip';
import type { DockTab } from '../ui/review-dock';
import { LeechAction, ReviewSessionHost } from '../models/review-flow';
import { menuItems } from './support/obsidian-shim';
import { MiniElement, flatten, textsOfClass } from './support/mini-dom';

interface Recorded {
    tabs: DockTab[];
    grades: number[];
    skips: number;
    previouses: number;
    nexts: number;
    postpones: number;
    undos: number;
    ends: number;
    decisions: LeechAction[];
    mcqTests: number;
    mcqRegenerations: number;
    removals: number;
    hosts: ReviewSessionHost[];
}

function makeStrip(mcqAvailable = false): { strip: ReviewStrip; host: MiniElement; calls: Recorded } {
    const calls: Recorded = {
        tabs: [],
        grades: [], skips: 0, previouses: 0, nexts: 0, postpones: 0, undos: 0, ends: 0,
        decisions: [], mcqTests: 0, mcqRegenerations: 0, removals: 0, hosts: [],
    };
    const strip = new ReviewStrip({
        onTab: (tab) => calls.tabs.push(tab),
        onGrade: (response) => calls.grades.push(response),
        onSkip: () => { calls.skips += 1; },
        onPrevious: () => { calls.previouses += 1; },
        onNext: () => { calls.nexts += 1; },
        onPostpone: () => { calls.postpones += 1; },
        onUndo: () => { calls.undos += 1; },
        onEnd: () => { calls.ends += 1; },
        onDecision: (action) => calls.decisions.push(action),
        onTestWithMCQs: () => { calls.mcqTests += 1; },
        onRegenerateMCQs: () => { calls.mcqRegenerations += 1; },
        onRemoveFromSchedule: () => { calls.removals += 1; },
        onHost: (host) => calls.hosts.push(host),
    });
    strip.setMcqAvailable(mcqAvailable);

    const host = new MiniElement('div');
    host.addClass('workspace-leaf-content');
    // The strip mounts through Obsidian's element helpers.
    strip.mountInto(host as unknown as HTMLElement);
    return { strip, host, calls };
}

function reviewingState(overrides: Partial<StripState> = {}): StripState {
    return {
        phase: 'reviewing',
        title: 'Cell biology',
        meta: 'FSRS · review · stability 12.0 · difficulty 4.8',
        dueLabel: '3d overdue',
        // Six steps passed and the reader standing on the seventh: the model's
        // own place, with the cursor at the head of what is left of the queue.
        position: { handled: 6, remaining: 17, total: 23, index: 0, place: 7 },
        algorithm: 'fsrs',
        grades: [
            { response: 1, label: 'Again', key: '1', variant: 'again', intervalText: '10m' },
            { response: 2, label: 'Hard', key: '2', variant: 'hard', intervalText: '6m' },
            { response: 3, label: 'Good', key: '3', variant: 'good', intervalText: '4d' },
            { response: 4, label: 'Easy', key: '4', variant: 'easy', intervalText: '12d' },
        ],
        decision: null,
        canUndo: true,
        hint: '1-4 rate · n next · u undo · p postpone · esc end',
        ...overrides,
    };
}

test('the status line reads as groups: the note, its scheduler, and the due state', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    const element = host.byClass('sf-strip')[0];
    assert.ok(element, 'the strip is mounted into the note pane');

    // (a) the note and how far through the run: "6/23 · Cell biology".
    const identity = host.byClass('sf-strip-group-identity')[0];
    assert.ok(identity, 'the identity is a group of its own');
    assert.equal(identity.textOf('sf-strip-progress-count'), '7/23 notes', 'six passed, standing on the seventh');
    // One number, not two: "17 left" beside "1/18" read as a second total.
    assert.equal(host.byClass('sf-strip-progress-left').length, 0);
    assert.equal(identity.textOf('sf-strip-title'), 'Cell biology');

    // (b) the scheduler, muted, with the longer numbers left on the hover.
    const schedule = host.byClass('sf-strip-group-schedule')[0];
    assert.ok(schedule, 'the scheduler is a group of its own');
    const meta = schedule.byClass('sf-strip-meta')[0];
    assert.equal(flatten(meta), 'FSRS · review');
    assert.match(meta.getAttribute('title') ?? '', /stability 12\.0/);

    // (c) the due state is a group of its own.
    const due = host.byClass('sf-strip-group-due')[0];
    assert.ok(due, 'the due state is a group of its own');
    assert.equal(due.textOf('sf-strip-due'), '3d overdue');

    // Three facts, three elements — not one run-on line.
    assert.equal(host.byClass('sf-strip-group').length, 3);
});

test('the scheduler group keeps the short form on the line and the full string on the hover', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ meta: 'SM-2 · interval 6d · ease 2.50' }));

    const meta = host.byClass('sf-strip-group-schedule')[0].byClass('sf-strip-meta')[0];
    assert.equal(flatten(meta), 'SM-2 · 6d', 'the algorithm and the interval, without the word said twice');
    assert.equal(meta.getAttribute('title'), 'SM-2 · interval 6d · ease 2.50', 'the whole scheduler string stays reachable');
});

test('a fact with nothing to say gets no group at all', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ meta: '', dueLabel: '' }));

    assert.equal(host.byClass('sf-strip-group').length, 1, 'only the identity remains');
    assert.equal(host.byClass('sf-strip-group-identity').length, 1);
    assert.equal(host.byClass('sf-strip-group-schedule').length, 0, 'no scheduler line without a scheduler');
    assert.equal(host.byClass('sf-strip-group-due').length, 0, 'no due group when nothing is due');
});

test('the keyboard hints sit behind the help affordance, not on the line', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    // The status line is a status line again: no keys, no prose about keys.
    const status = host.byClass('sf-strip-status')[0];
    assert.ok(status, 'the status line is one element');
    assert.doesNotMatch(flatten(status), /rate|next|esc end/);
    assert.equal(host.byClass('sf-strip-hint').length, 0, 'the old inline hint is gone');
    assert.doesNotMatch(flatten(host.byClass('sf-strip')[0]), /n next|esc end/, 'nothing prints them inline anywhere on the bar');

    // The affordance carries them: hover for the pointer, the label for
    // assistive tech.
    const help = host.byClass('sf-strip-help')[0];
    assert.ok(help, 'the bar has a help affordance');
    assert.equal(help.text, '?');
    assert.match(help.getAttribute('title') ?? '', /1-4 rate · n next · u undo · p postpone · esc end/);
    assert.match(help.getAttribute('aria-label') ?? '', /Keyboard shortcuts — 1-4 rate/);
    assert.equal(help.getAttribute('aria-expanded'), 'false');

    // Asked for, it prints the same sentence once; asked again, it puts it away.
    help.click();
    assert.equal(host.byClass('sf-strip-help-text').length, 1, 'the hint appears once');
    assert.match(host.textOf('sf-strip-help-text'), /n next · u undo · p postpone · esc end/);
    assert.equal(help.getAttribute('aria-expanded'), 'true');
    assert.ok(help.hasClass('is-open'), 'and the affordance says it is showing');

    help.click();
    assert.equal(host.byClass('sf-strip-help-text').length, 0, 'pressing it again puts the hint away');
    assert.equal(help.getAttribute('aria-expanded'), 'false');
});

test('each grade button carries its label, key and resulting interval', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    const labels = textsOfClass(host, 'sf-strip-grade-label');
    const keys = textsOfClass(host, 'sf-strip-grade-key');
    const intervals = textsOfClass(host, 'sf-strip-grade-interval');

    assert.deepEqual(labels, ['Again', 'Hard', 'Good', 'Easy']);
    assert.deepEqual(keys, ['1', '2', '3', '4']);
    assert.deepEqual(intervals, ['10m', '6m', '4d', '12d']);
    assert.deepEqual(host.byClass('sf-strip-grade').map(button => button.tag), ['button', 'button', 'button', 'button']);
});

test('SM-2 notes get their six grades', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        algorithm: 'sm2',
        grades: [
            { response: 0, label: 'Complete blackout', key: '0', variant: 'blackout', intervalText: '1d' },
            { response: 1, label: 'Incorrect', key: '1', variant: 'incorrect', intervalText: '1d' },
            { response: 2, label: 'Incorrect but familiar', key: '2', variant: 'familiar', intervalText: '1d' },
            { response: 3, label: 'Correct with difficulty', key: '3', variant: 'difficulty', intervalText: '1d' },
            { response: 4, label: 'Correct with hesitation', key: '4', variant: 'hesitation', intervalText: '6d' },
            { response: 5, label: 'Perfect recall', key: '5', variant: 'perfect', intervalText: '14d' },
        ],
        hint: '0-5 rate · n next · u undo · p postpone · esc end',
    }));

    assert.deepEqual(textsOfClass(host, 'sf-strip-grade-key'), ['0', '1', '2', '3', '4', '5']);
    // The reminder names the scale the running algorithm really offers, and it
    // reaches the reader through the help affordance.
    assert.match(host.byClass('sf-strip-help')[0].getAttribute('title') ?? '', /0-5 rate/);
});

test('a grade button hands its own rating back', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState());

    const buttons = host.byClass('sf-strip-grade');
    buttons[2].click();
    assert.deepEqual(calls.grades, [3]);

    buttons[0].click();
    assert.deepEqual(calls.grades, [3, 1]);
});

test('secondary controls skip, postpone, undo and end', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState());

    const actions = host.byClass('sf-strip-action');
    assert.equal(actions.length, 6);
    for (const action of actions) action.click();

    assert.equal(calls.undos, 1);
    assert.equal(calls.previouses, 1);
    assert.equal(calls.nexts, 1);
    assert.equal(calls.postpones, 1);
    assert.equal(calls.ends, 1);
    // The fourth control opens the overflow menu rather than acting on its own.
    assert.equal(calls.mcqTests, 0);
});

test('undo is not offered until something has been graded', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ canUndo: false }));

    const undo = host.byClass('sf-strip-action')[0];
    assert.equal(undo.disabled, true);

    strip.render(reviewingState({ canUndo: true }));
    assert.equal(host.byClass('sf-strip-action')[0].disabled, false);
});

test('the overflow menu only offers questions when MCQs are available', () => {
    const withoutMCQ = makeStrip(false);
    withoutMCQ.strip.render(reviewingState());
    withoutMCQ.host.byClass('sf-strip-action')[4].click();   // More, past Previous/Next
    // The menu also says where the session lives — but a question action only
    // appears when there are questions to make.
    assert.deepEqual(menuItems.map(item => item.title), [
        'Skip this note (s)',
        'Keep the review under the note',
        'Move the review into a window',
        'Move the review into the sidebar',
        'Remove from review schedule',
    ]);
    assert.equal(menuItems.filter(item => /MCQ/.test(item.title)).length, 0);
    menuItems[3].click();
    assert.deepEqual(withoutMCQ.calls.hosts, ['sidebar']);
    menuItems[4].click();
    assert.equal(withoutMCQ.calls.removals, 1);

    const withMCQ = makeStrip(true);
    withMCQ.strip.render(reviewingState());
    withMCQ.host.byClass('sf-strip-action')[4].click();
    assert.deepEqual(menuItems.map(item => item.title), [
        'Test with MCQs',
        'Generate new MCQs',
        'Skip this note (s)',
        'Keep the review under the note',
        'Move the review into a window',
        'Move the review into the sidebar',
        'Remove from review schedule',
    ]);
    menuItems[0].click();
    menuItems[1].click();
    assert.equal(withMCQ.calls.mcqTests, 1);
    assert.equal(withMCQ.calls.mcqRegenerations, 1);
});

test('a leech decision replaces the grades and holds the flow', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        phase: 'decision',
        decision: {
            message: 'Cell biology has lapsed 8 times (checkpoint every 8). What should happen to it?',
            choices: [
                { action: 'reset', label: 'Reset progress', description: 'Back to a 1 day interval', primary: true },
                { action: 'postpone', label: 'Rest for a week', description: 'Hide this note for 7 days', primary: false },
                { action: 'remove', label: 'Remove from schedule', description: 'Stop reviewing this note', primary: false },
                { action: 'keep', label: 'Keep as is', description: 'Carry on', primary: false },
            ],
        },
    }));

    assert.equal(host.byClass('sf-strip-grade').length, 0, 'no grades while a decision is pending');
    assert.match(host.textOf('sf-strip-decision'), /lapsed 8 times/);

    const choices = host.byClass('sf-strip-decision-button');
    assert.deepEqual(choices.map(choice => flatten(choice)), ['Reset progress', 'Rest for a week', 'Remove from schedule', 'Keep as is']);

    choices[0].click();
    assert.deepEqual(calls.decisions, ['reset']);
    choices[3].click();
    assert.deepEqual(calls.decisions, ['reset', 'keep']);
});

test('a finished session reports what was handled', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        phase: 'finished',
        grades: [],
        position: { handled: 12, remaining: 0, total: 12 },
        canUndo: true,
    }));

    assert.equal(host.byClass('sf-strip-grade').length, 0);
    assert.match(host.textOf('sf-strip-finished'), /Review session complete — 12 notes handled/);
    // The run is over: the bar keeps its actions, but nothing has keys left to
    // remind the reader of.
    assert.equal(host.byClass('sf-strip-help').length, 0);

    // Undo has to survive the end of the run, so a mis-key can still be fixed.
    const actions = host.byClass('sf-strip-action');
    actions[0].click();
    actions[1].click();
    assert.equal(calls.undos, 1);
    assert.equal(calls.ends, 1);
});

test('a finished queue offers the decks, and nothing when they hold nothing', () => {
    const { strip, host, calls } = makeStrip();
    const finished = reviewingState({ phase: 'finished', grades: [], canUndo: true });

    strip.render({ ...finished, nextStep: { label: 'Study 31 cards', title: '31 cards waiting' } });
    const next = host.byClass('sf-strip-next-button')[0];
    assert.ok(next, 'the day\'s other half is on the bar');
    assert.match(host.textOf('sf-strip-next'), /Study 31 cards/);
    next.click();
    assert.deepEqual(calls.tabs, ['cards'], 'and one press opens the card tab');

    strip.render({ ...finished, nextStep: null });
    assert.equal(host.byClass('sf-strip-next-button').length, 0, 'nothing is offered when no cards are waiting');
    assert.match(host.textOf('sf-strip-finished'), /Review session complete/);
});

test('unmounting takes the bar and its host class with it', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());
    assert.equal(host.hasClass('sf-strip-host'), true);

    strip.unmount();
    assert.equal(host.byClass('sf-strip').length, 0);
    assert.equal(host.hasClass('sf-strip-host'), false);
});

test('re-mounting into the same pane keeps a single bar', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());
    strip.mountInto(host as unknown as HTMLElement);

    assert.equal(host.byClass('sf-strip').length, 1);
});

test('the tab row is its own row of tabs: each count in its label, the open one selected', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        tabs: {
            study: { label: 'Study · 40 objectives', title: 'teach me these' },
            mcq: { label: 'MCQs · 3', title: 'sit three questions' },
            cards: { label: 'Cards · 33', title: 'sit the card lane' },
            active: 'mcq',
        },
    }));

    const stripEl = host.byClass('sf-strip')[0];
    const row = host.byClass('sf-strip-tabs')[0];
    assert.ok(row, 'the bar has a tab row');
    assert.equal(row.getAttribute('role'), 'tablist');
    assert.equal(stripEl.children[0].hasClass('sf-strip-header'), true);
    assert.equal(stripEl.children[1], row, 'the row sits under the status and above the grades');
    assert.equal(host.byClass('sf-strip-status')[0].byClass('sf-strip-tab').length, 0, 'the tabs are not on the status line');

    const tabs = row.byClass('sf-strip-tab');
    assert.deepEqual(
        tabs.map(tab => flatten(tab)),
        ['Study · 40 objectives', 'MCQs · 3', 'Cards · 33'],
        'each tab carries its own count inside its own label',
    );
    assert.deepEqual(tabs.map(tab => tab.getAttribute('role')), ['tab', 'tab', 'tab']);
    assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
    assert.deepEqual(tabs.map(tab => tab.hasClass('is-active')), [false, true, false], 'and the open one is the selected one');
    assert.equal(tabs[0].getAttribute('title'), 'teach me these');

    host.byClass('sf-strip-tab-mcq')[0].click();
    assert.deepEqual(calls.tabs, ['mcq'], 'clicking a tab asks for it');
});

test('a re-render replaces the bar, never stacking a second copy of it', () => {
    const { strip, host } = makeStrip();
    const withTabs = reviewingState({
        tabs: {
            study: { label: 'Study · 40 objectives', title: 'teach me these' },
            mcq: { label: 'MCQs · 3', title: 'sit three questions' },
            cards: null,
            active: 'study',
        },
    });

    strip.render(withTabs);
    const stripEl = host.byClass('sf-strip')[0];
    const first = stripEl.findAll(() => true).length;
    strip.render(withTabs);
    const second = stripEl.findAll(() => true).length;

    assert.equal(host.byClass('sf-strip').length, 1, 'one bar');
    assert.equal(host.byClass('sf-strip-header').length, 1, 'one header');
    assert.equal(host.byClass('sf-strip-group').length, 3, 'one group per fact');
    assert.equal(host.byClass('sf-strip-tabs').length, 1, 'one tab row');
    assert.equal(host.byClass('sf-strip-tab').length, 2, 'one of each tab');
    assert.equal(host.byClass('sf-strip-help').length, 1, 'one help affordance');
    assert.equal(second, first, 'and no element was added by the second render');
});

test('the open tab is the marked one, and a missing side is not offered', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        tabs: { study: { label: 'Study', title: 'study' }, mcq: null, cards: null, active: 'study' },
    }));

    const tabs = host.byClass('sf-strip-tab');
    assert.equal(tabs.length, 1, 'only the side that exists is printed');
    assert.ok(tabs[0].hasClass('is-active'), 'and the open one is marked');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'for assistive tech as well as the eye');
});

test('the cards tab is a tab like the others: same row, same active marking', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        tabs: {
            study: null,
            mcq: { label: 'MCQs', title: 'sit the questions' },
            cards: { label: 'Cards · 33', title: 'sit the card lane' },
            active: 'cards',
        },
    }));

    const tabs = host.byClass('sf-strip-tab');
    assert.deepEqual(tabs.map(button => flatten(button)), ['MCQs', 'Cards · 33'], 'the card lane joins the same row');
    assert.equal(tabs[0].hasClass('is-active'), false, 'the questions are not the open tab');
    assert.equal(tabs[1].hasClass('is-active'), true, 'the cards tab is, and is marked like the rest');
    assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true']);

    host.byClass('sf-strip-tab-cards')[0].click();
    assert.deepEqual(calls.tabs, ['cards'], 'clicking it asks for the card sitting');
});

test('a finished sitting marks the grade it implies, with the score in that button', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ suggestion: { rating: 3, score: 0.75, label: 'Good' } }));

    const suggested = host.byClass('sf-strip-grade').filter(button => button.hasClass('is-suggested'));
    assert.equal(suggested.length, 1, 'exactly one grade is marked');
    assert.match(flatten(suggested[0]), /Good/, 'and it is the one the score implies');
    assert.equal(suggested[0].byClass('sf-strip-grade-score')[0].text, '75%', 'the percentage sits in it');
    assert.match(suggested[0].getAttribute('aria-label') ?? '', /suggests this grade, 75%/);
});

test('no suggestion means no marked grade', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());
    assert.equal(host.byClass('is-suggested').length, 0);
    assert.equal(host.byClass('sf-strip-grade-score').length, 0);
});

// ---------------------------------------------------------------------------
// The card lane's steps: the counter counts everything the sitting is made of,
// and the cards are a step of it rather than a tab that ignores the run.
// ---------------------------------------------------------------------------

test('with cards in the run the counter counts the steps, and says what they are on the hover', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        position: { handled: 4, remaining: 8, total: 12, index: 4 },
        queue: { notes: 6, cards: 6 },
    }));

    const count = host.byClass('sf-strip-progress-count')[0];
    assert.equal(count.text, '5/12 steps', 'six notes and six cards is twelve things to get through');
    assert.equal(count.getAttribute('title'), '6 notes · 6 cards', 'and the split is one hover away');

    // A queue of notes alone is still counted in notes, with nothing to split.
    strip.render(reviewingState({ position: { handled: 6, remaining: 17, total: 23, index: 6 }, queue: { notes: 23, cards: 0 } }));
    const notes = host.byClass('sf-strip-progress-count')[0];
    assert.equal(notes.text, '7/23 notes');
    assert.equal(notes.getAttribute('title'), null, 'one number, and one thing it counts');
});

test('the counter prints the run’s place, never a tally that has run ahead of it', () => {
    // The stuck reading the reader reported: the handled tally was ahead of the
    // walk (the decks' steps had been marked spent), so `max(handled, index) +
    // 1` printed `7/11 steps` for every place behind the tally and neither
    // direction moved it. The model's own place is what the bar prints.
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        position: { handled: 6, remaining: 5, total: 11, index: 5, place: 6 },
        queue: { notes: 5, cards: 6 },
    }));
    assert.equal(host.textOf('sf-strip-progress-count'), '6/11 steps', 'the place the reader stands in');

    // And it follows the place as the reader walks — one per step, both ways.
    for (const [index, place] of [[6, 7], [7, 8], [6, 7], [5, 6], [4, 5]] as const) {
        strip.render(reviewingState({
            position: { handled: 6, remaining: 5, total: 11, index, place },
            queue: { notes: 5, cards: 6 },
        }));
        assert.equal(host.textOf('sf-strip-progress-count'), `${place}/11 steps`);
    }
});

test('the cards step takes the place of the grades and names where the sitting is', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        phase: 'cards',
        title: 'Cards',
        meta: '',
        dueLabel: '',
        grades: [],
        position: { handled: 3, remaining: 3, total: 6, index: 3 },
        queue: { notes: 3, cards: 3 },
        cardsStep: { label: 'Cards', detail: 'sitting Biology demo' },
        tabs: {
            study: null,
            mcq: null,
            cards: { label: 'Cards · 3', title: 'sit the card lane' },
            active: 'cards',
        },
    }));

    assert.equal(host.byClass('sf-strip-grade').length, 0, 'the card on screen has its own buttons');
    const step = host.byClass('sf-strip-cards')[0];
    assert.ok(step, 'the bar says which step the run is standing on');
    assert.match(flatten(step), /Cards/);
    assert.match(flatten(step), /sitting Biology demo/);
    assert.equal(host.textOf('sf-strip-progress-count'), '4/6 steps');
    assert.equal(host.byClass('sf-strip-tab-cards')[0].hasClass('is-active'), true, 'and the cards are the open one');

    // The run's own controls stay: the cards are a step of it, so Previous,
    // Next and End have to walk off them the same way they walk off a note.
    const actions = host.byClass('sf-strip-action');
    actions[1].click();
    actions[2].click();
    assert.equal(calls.previouses, 1);
    assert.equal(calls.nexts, 1);
});

test('a finished run that carried cards says both, because both were steps of it', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        phase: 'finished',
        grades: [],
        position: { handled: 6, remaining: 0, total: 6 },
        queue: { notes: 3, cards: 3 },
        canUndo: true,
    }));

    assert.match(host.textOf('sf-strip-finished'), /Review session complete — 3 notes and 3 cards handled/);
});

