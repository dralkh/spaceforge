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
    views: Array<string | undefined>;
    listens: number;
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
        tabs: [], views: [], listens: 0,
        grades: [], skips: 0, previouses: 0, nexts: 0, postpones: 0, undos: 0, ends: 0,
        decisions: [], mcqTests: 0, mcqRegenerations: 0, removals: 0, hosts: [],
    };
    const strip = new ReviewStrip({
        onTab: (tab, view) => { calls.tabs.push(tab); calls.views.push(view); },
        onListen: () => { calls.listens += 1; },
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

/** The bar's ⋯ button. */
function moreButton(host: MiniElement): MiniElement {
    const more = host.byClass('sf-strip-action').find(button => button.getAttribute('aria-label') === 'More');
    assert.ok(more, 'the bar has a ⋯ menu');
    return more;
}

/** Open ⋯ and press the item with this title. */
function pickMenu(host: MiniElement, title: string): void {
    moreButton(host).click();
    const item = menuItems.find(entry => entry.title === title);
    assert.ok(item, `the menu offers "${title}"`);
    item.click();
}

test('the header reads as the note, with its due state and scheduler on one quiet line under it', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    assert.ok(host.byClass('sf-strip')[0], 'the strip is mounted into the note pane');

    const identity = host.byClass('sf-strip-group-identity')[0];
    assert.ok(identity, 'the identity is a group of its own');
    assert.equal(identity.textOf('sf-strip-title'), 'Cell biology');

    // The place in the run sits between the arrows that move it.
    const nav = host.byClass('sf-strip-nav')[0];
    assert.ok(nav, 'previous / place / next are one cluster');
    assert.equal(nav.textOf('sf-strip-progress-count'), '7/23 notes', 'six passed, standing on the seventh');
    assert.equal(host.byClass('sf-strip-progress-left').length, 0);

    const schedule = host.byClass('sf-strip-group-schedule')[0];
    const meta = schedule.byClass('sf-strip-meta')[0];
    assert.equal(flatten(meta), 'FSRS · review');
    assert.match(meta.getAttribute('title') ?? '', /stability 12\.0/);

    const due = host.byClass('sf-strip-group-due')[0];
    assert.equal(due.textOf('sf-strip-due'), '3d overdue');

    // Three facts, three elements — not one run-on line.
    assert.equal(host.byClass('sf-strip-group').length, 3);
});

test('the due state and the scheduler share one line under the name', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    const status = host.byClass('sf-strip-status')[0];
    const sub = host.byClass('sf-strip-sub')[0];
    assert.ok(status && sub, 'the bar draws a status block with a line under the name');
    assert.equal(sub.parentElement, status);
    assert.equal(host.byClass('sf-strip-group-due')[0].parentElement, sub);
    assert.equal(host.byClass('sf-strip-group-schedule')[0].parentElement, sub);
    // Due first: it is the fact that asks for something.
    assert.ok(sub.children[0].hasClass('sf-strip-group-due'));
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

test('the keyboard hints wait in the menu, not on the line', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState());

    const status = host.byClass('sf-strip-status')[0];
    assert.doesNotMatch(flatten(status), /rate|next|esc end/);
    assert.equal(host.byClass('sf-strip-hint').length, 0, 'the old inline hint is gone');
    assert.equal(host.byClass('sf-strip-help').length, 0, 'and so is the separate ? button');
    assert.doesNotMatch(flatten(host.byClass('sf-strip')[0]), /n next|esc end/, 'nothing prints them inline anywhere on the bar');

    // Asked for from ⋯, the same sentence prints once, and survives a re-render.
    pickMenu(host, 'Keyboard shortcuts');
    assert.equal(host.byClass('sf-strip-help-text').length, 1, 'the hint appears once');
    assert.match(host.textOf('sf-strip-help-text'), /n next · u undo · p postpone · esc end/);
    strip.render(reviewingState());
    assert.equal(host.byClass('sf-strip-help-text').length, 1, 'a tick does not take it away');

    pickMenu(host, 'Hide keyboard shortcuts');
    assert.equal(host.byClass('sf-strip-help-text').length, 0, 'asking again puts the hint away');
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

test('the grade palette carries the layout the reader chose', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ gradeLayout: 'stack' }));
    assert.equal(host.byClass('sf-strip-grades')[0].getAttribute('data-grade-layout'), 'stack');
    assert.equal(host.byClass('sf-strip-grades')[0].getAttribute('data-grade-count'), '4');

    // Unset means the automatic layout; the stylesheet resolves it by width.
    strip.render(reviewingState());
    assert.equal(host.byClass('sf-strip-grades')[0].getAttribute('data-grade-layout'), 'auto');
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
    // The reminder names the scale the running algorithm really offers.
    pickMenu(host, 'Keyboard shortcuts');
    assert.match(host.textOf('sf-strip-help-text'), /0-5 rate/);
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

test('the bar walks, undoes and ends; postpone and skip wait in the menu', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({ canUndo: true }));

    const actions = host.byClass('sf-strip-action');
    assert.deepEqual(
        actions.map(action => action.getAttribute('aria-label')),
        ['Undo last rating (u)', 'Previous (b)', 'Next (n)', 'More', 'End review (esc)'],
    );
    for (const action of actions) {
        if (action.getAttribute('aria-label') !== 'More') action.click();
    }
    assert.equal(calls.undos, 1);
    assert.equal(calls.previouses, 1);
    assert.equal(calls.nexts, 1);
    assert.equal(calls.ends, 1);

    pickMenu(host, 'Postpone to tomorrow (p)');
    assert.equal(calls.postpones, 1);
    pickMenu(host, 'Skip this note (s)');
    assert.equal(calls.skips, 1);
    assert.equal(calls.mcqTests, 0);
});

test('undo is not offered until something has been graded', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ canUndo: false }));
    assert.equal(host.byClass('sf-strip-undo').length, 0, 'nothing to undo, no button to press');

    strip.render(reviewingState({ canUndo: true }));
    const undo = host.byClass('sf-strip-undo');
    assert.equal(undo.length, 1);
    assert.equal(undo[0].disabled, false);
});

test('the overflow menu only offers questions when MCQs are available', () => {
    const withoutMCQ = makeStrip(false);
    withoutMCQ.strip.render(reviewingState());
    moreButton(withoutMCQ.host).click();
    assert.deepEqual(menuItems.map(item => item.title), [
        'Postpone to tomorrow (p)',
        'Skip this note (s)',
        'Review under the note',
        'Review in a split',
        'Review in a window',
        'Review in the sidebar',
        'Keyboard shortcuts',
        'Remove from review schedule',
    ]);
    assert.equal(menuItems.filter(item => /MCQ/.test(item.title)).length, 0);
    menuItems[5].click();
    assert.deepEqual(withoutMCQ.calls.hosts, ['sidebar']);
    menuItems[3].click();
    assert.deepEqual(withoutMCQ.calls.hosts, ['sidebar', 'split']);
    menuItems[7].click();
    assert.equal(withoutMCQ.calls.removals, 1);

    const withMCQ = makeStrip(true);
    withMCQ.strip.render(reviewingState());
    moreButton(withMCQ.host).click();
    assert.deepEqual(menuItems.map(item => item.title), [
        'Postpone to tomorrow (p)',
        'Skip this note (s)',
        'Test with MCQs',
        'Generate new MCQs',
        'Review under the note',
        'Review in a split',
        'Review in a window',
        'Review in the sidebar',
        'Keyboard shortcuts',
        'Remove from review schedule',
    ]);
    menuItems[2].click();
    menuItems[3].click();
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

test('one tab row for everything: the study views flattened in, each count a badge, the open one selected', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        tabs: {
            study: { label: 'Learn', title: 'teach me these', count: '2 due' },
            mcq: { label: 'MCQs', title: 'sit three questions', count: '3' },
            cards: { label: 'Cards', title: 'sit the card lane', count: '33' },
            active: 'mcq',
        },
    }));

    const stripEl = host.byClass('sf-strip')[0];
    const row = host.byClass('sf-strip-tabs')[0];
    assert.ok(row, 'the bar has a tab row');
    assert.equal(row.getAttribute('role'), 'tablist');
    const last = stripEl.children[stripEl.children.length - 1];
    assert.ok(last.hasClass('sf-strip-tabbar'), 'the row is the bar\'s last line, sitting on the panel it opens');
    assert.equal(host.byClass('sf-strip-status')[0].byClass('sf-strip-tab').length, 0, 'the tabs are not on the status line');

    const tabs = row.byClass('sf-strip-tab');
    assert.deepEqual(
        tabs.map(tab => tab.textOf('sf-strip-tab-label')),
        ['Learn', 'Visualize', 'Mind map', 'Summary', 'MCQs', 'Cards'],
        'the study panel\'s views are tabs of the same row',
    );
    assert.deepEqual(tabs.map(tab => tab.byClass('sf-strip-tab-count')[0]?.text ?? ''), ['2 due', '', '', '', '3', '33']);
    assert.ok(tabs.every(tab => tab.getAttribute('role') === 'tab'));
    assert.deepEqual(tabs.map(tab => tab.hasClass('is-active')), [false, false, false, false, true, false]);
    assert.equal(tabs[4].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[0].getAttribute('title'), 'teach me these');

    host.byClass('sf-strip-tab-mcq')[0].click();
    host.byClass('sf-strip-tab-view-mindmap')[0].click();
    assert.deepEqual(calls.tabs, ['mcq', 'study'], 'clicking a tab asks for it');
    assert.deepEqual(calls.views, [undefined, 'mindmap'], 'a study view says which');
});

test('the open study view is the marked tab', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        tabs: { study: { label: 'Learn', title: 'study' }, mcq: null, cards: null, active: 'study', view: 'board' },
    }));
    const marked = host.byClass('sf-strip-tab').filter(tab => tab.hasClass('is-active'));
    assert.equal(marked.length, 1);
    assert.ok(marked[0].hasClass('sf-strip-tab-view-board'));
});

test('read aloud sits at the end of the tab row and shows when it is playing', () => {
    const { strip, host, calls } = makeStrip();
    strip.render(reviewingState({
        tabs: { study: null, mcq: { label: 'MCQs', title: 'q' }, cards: null, active: null, listen: { playing: false } },
    }));
    const listen = host.byClass('sf-strip-listen')[0];
    assert.ok(listen, 'a speaker on the tab row');
    assert.equal(listen.getAttribute('aria-pressed'), 'false');
    listen.click();
    assert.equal(calls.listens, 1);

    strip.render(reviewingState({
        tabs: { study: null, mcq: { label: 'MCQs', title: 'q' }, cards: null, active: null, listen: { playing: true } },
    }));
    assert.ok(host.byClass('sf-strip-listen')[0].hasClass('is-playing'));
});

test('a re-render replaces the bar, never stacking a second copy of it', () => {
    const { strip, host } = makeStrip();
    const withTabs = reviewingState({
        tabs: {
            study: { label: 'Learn', title: 'teach me these' },
            mcq: { label: 'MCQs', title: 'sit three questions', count: '3' },
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
    assert.equal(host.byClass('sf-strip-tab').length, 5, 'one of each tab');
    assert.equal(host.byClass('sf-strip-nav').length, 1, 'one set of controls');
    assert.equal(second, first, 'and no element was added by the second render');
});

test('the open tab is the marked one, and a missing side is not offered', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        tabs: { study: null, mcq: { label: 'MCQs', title: 'q' }, cards: null, active: 'mcq' },
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
            cards: { label: 'Cards', title: 'sit the card lane', count: '33' },
            active: 'cards',
        },
    }));

    const tabs = host.byClass('sf-strip-tab');
    assert.deepEqual(tabs.map(button => button.textOf('sf-strip-tab-label')), ['MCQs', 'Cards'], 'the card lane joins the same row');
    assert.equal(tabs[1].textOf('sf-strip-tab-count'), '33');
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
            cards: { label: 'Cards', title: 'sit the card lane', count: '3' },
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


test('every icon button draws its glyph inside a box of its own, so iPadOS cannot shrink it away', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({
        canUndo: true,
        tabs: { study: null, mcq: { label: 'MCQs', title: 'q' }, cards: null, active: null, listen: { playing: false } },
    }));
    const buttons = host.byClass('sf-strip-icon-button');
    assert.equal(buttons.length, 6, 'undo, previous, next, more, end, and read aloud');
    for (const button of buttons) {
        // A bare SVG straight in the button is what collapsed to nothing under
        // Obsidian's mobile button padding; the span is the fixed-size box the
        // stylesheet sizes explicitly.
        assert.equal(button.children.length, 1, `${button.getAttribute('aria-label')} has one child`);
        assert.ok(button.children[0].hasClass('sf-strip-icon'), `${button.getAttribute('aria-label')} wraps its glyph`);
        assert.ok(button.getAttribute('aria-label'), 'and an icon-only button still says what it does');
    }
});


test('the line under the name is reading time: this note, then what is left of the day', () => {
    const { strip, host } = makeStrip();
    strip.render(reviewingState({ timing: { note: '4 min', left: '1h 20m', notesLeft: 26, scope: null } }));
    const time = host.byClass('sf-strip-group-time')[0];
    assert.ok(time, 'a timing group');
    assert.equal(time.textOf('sf-strip-time-note'), '4 min read');
    assert.equal(time.textOf('sf-strip-time-left'), '1h 20m left today');
    assert.equal(host.byClass('sf-strip-group-due').length, 0, 'how late a note is moves to the hover');
    assert.match(time.getAttribute('title') ?? '', /Due: 3d overdue/);

    // A day picked on the calendar names that day; a total still being counted says the notes.
    strip.render(reviewingState({ timing: { note: '2 min', left: null, notesLeft: 3, scope: 'Nov 16' } }));
    assert.equal(host.textOf('sf-strip-time-left'), '3 notes left for Nov 16');
});
