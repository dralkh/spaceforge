import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { DockSuggestion, DockTabState, ReviewDock } from '../ui/review-dock';
import { StudyController } from '../controllers/study-controller';
import { MCQSet } from '../models/mcq';

/**
 * The dock is where study and questions live, under the review bar. These tests
 * pin the two rules that used to be broken by the popups: a sitting never
 * grades itself unless asked to, and grading one never moves the learner off
 * the note.
 */

interface Call {
    path: string;
    rating: number;
    options: { ratingKind: string; navigate?: boolean };
}

function makeDock(options: {
    mcqGradingMode?: 'ask' | 'score';
    plan?: boolean;
    questions?: number;
    /** false for a vault with no deck lane at all. */
    deck?: boolean;
    dueCount?: number | null;
    countedAt?: number;
    /** Hold the questions preparation open (or fail it) for the tests that need to. */
    ensure?: (path: string) => Promise<MCQSet | null>;
    /** True once the run has stood on one of the decks' steps. */
    cardsReached?: boolean;
} = {}) {
    installMiniDocument();
    const questions = options.questions ?? 3;
    const set: MCQSet = {
        notePath: 'notes/a.md',
        generatedAt: 1,
        questions: Array.from({ length: questions }, (_, i) => ({
            question: `Question ${i + 1}?`,
            choices: ['first', 'second', 'third'],
            correctAnswerIndex: 1,
        })),
    };

    const calls = {
        recorded: [] as Call[],
        refreshed: 0,
        savedSessions: 0,
        enqueued: [] as string[],
        /** Every ensureMcqSetForNote() call the dock made, by note. */
        ensure: [] as string[],
        /** Every suggestion the dock published, in order. */
        suggestions: [] as (DockSuggestion | null)[],
        /** Every tab state it published, in order. */
        tabs: [] as DockTabState[],
    };

    const plugin = {
        settings: {
            studyEnabled: true,
            enableMCQ: true,
            mcqGradingMode: options.mcqGradingMode ?? 'ask',
            reviewDockHeight: 0,
            reviewStripIntervalPreviews: false,
            reviewStripGradeKeys: true,
            defaultSchedulingAlgorithm: 'fsrs',
            studyAutoRateNote: false,
            mcqDeductFullMarkOnFirstFailure: true,
            mcqTimeDeductionSeconds: 90,
            mcqTimeDeductionAmount: 0.5,
        },
        // Truthy is all the dock asks of these two: it is the settings that
        // decide whether a tab is offered at all.
        studyController: { subscribeChart: () => () => undefined },
        mcqService: { getMCQSetForNote: () => set },
        mcqController: {
            ensureMcqSetForNote: (path: string) => {
                calls.ensure.push(path);
                return options.ensure ? options.ensure(path) : Promise.resolve(set);
            },
            saveMCQSession: async () => { calls.savedSessions += 1; },
        },
        reviewScheduleService: {
            schedules: { 'notes/a.md': { schedulingAlgorithm: 'fsrs' } },
            previewReview: () => null,
        },
        reviewController: {
            processReviewResponse: async (path: string, rating: number, opts: Call['options']) => {
                calls.recorded.push({ path, rating, options: opts });
                return { recorded: true, nextPath: null, nextPathSource: null, sessionComplete: false };
            },
        },
        reviewFlowController: { refreshCurrent: () => { calls.refreshed += 1; } },
        // The deck lane, and the count the sidebar last worked out: the dock
        // only reads them, so plain objects are enough.
        deckSessionController: options.deck === false
            ? undefined
            : { isActive: () => false, startAllDue: async () => undefined },
        deckDueCount: options.dueCount ?? null,
        deckDueCountedAt: options.countedAt ?? 0,
        studyChartQueue: {
            enqueue: (path: string) => { calls.enqueued.push(path); },
            tick: async () => undefined,
        },
        savePluginData: async () => undefined,
        getSidebarView: () => null,
    };

    const controller = {
        studyBadge: () => ({ hasPlan: options.plan !== false, due: 0, mastered: 0, total: 40, charting: false }),
        isCharting: () => false,
        chartUpdate: () => null,
        subscribeChart: () => () => undefined,
        planService: { getPlan: () => (options.plan === false ? null : { objectives: [] }) },
        // The study panel reads the note when it mounts; what the note says is
        // not what these tests are about, so it reads as empty.
        readNote: async () => null,
    };

    const host = new MiniElement('div');
    host.addClass('workspace-leaf-content');
    const dock = new ReviewDock(plugin as never, controller as unknown as StudyController, {
        onSuggestion: suggestion => calls.suggestions.push(suggestion),
        onTabs: state => calls.tabs.push(state),
        cardsReached: () => options.cardsReached ?? false,
    });
    dock.mountInto(host as unknown as HTMLElement);
    dock.setPath('notes/a.md');

    return { dock, plugin, calls, host, set };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Answer one question correctly and move on, as a user would. */
function answerCorrectly(dock: ReviewDock, host: MiniElement, correctIndex = 1): void {
    const choice = host.byClass('sf-mcq-runner-choice')[correctIndex];
    assert.ok(choice, 'a choice button is rendered');
    choice.click();
    const action = host.byClass('sf-mcq-runner-action')[0];
    assert.ok(action, 'a continue action follows a correct pick');
    action.click();
}

test('the dock tells the bar what each tab has waiting, and has no row of its own', () => {
    const { dock, calls, host } = makeDock();

    const state = dock.tabState();
    assert.equal(state.study?.label, 'Study · 40 objectives');
    assert.equal(state.mcq?.label, 'MCQs · 3');
    assert.equal(state.active, null, 'nothing is open until it is opened');
    assert.ok(calls.tabs.length > 0, 'the bar was told');

    assert.equal(host.byClass('sf-dock-row').length, 0, 'the tabs are on the bar now, not on a row here');
    const root = host.byClass('sf-dock')[0];
    assert.ok(!root.hasClass('sf-hidden'), 'the dock shows when there is something to offer');

    dock.openTab('mcq');
    assert.equal(dock.tabState().active, 'mcq', 'and the bar is told which one is open');
});

test('a suggestion is handed over, not printed as a second set of buttons', async () => {
    const { dock, host, calls } = makeDock();
    dock.openTab('mcq');
    await settle();
    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();

    assert.equal(host.byClass('sf-dock-gate').length, 0, 'no gate block exists any more');
    assert.equal(host.byClass('sf-dock-gate-grades').length, 0, 'and no duplicate grade row');
    assert.equal(host.byClass('sf-dock-scorecard').length, 1, 'the sitting still reports itself');

    const published = calls.suggestions.filter(Boolean);
    assert.equal(published.length, 1, 'exactly one suggestion was published');
    assert.equal(published[0]?.score, 1, 'a perfect sitting');
    assert.equal(published[0]?.label, 'Easy');
    assert.equal(published[0]?.rating, 4, 'the FSRS grade the score implies');

    assert.equal(calls.recorded.length, 0, 'and nothing was recorded by the dock');
});

test('a sitting reports its score and leaves the grade to the learner', async () => {
    const { dock, host, calls } = makeDock();
    dock.openTab('mcq');
    await settle();

    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();

    assert.equal(calls.recorded.length, 0, 'a finished sitting does not grade itself');
    assert.equal(calls.savedSessions, 1, 'the sitting itself is recorded');
    assert.match(host.textOf('sf-dock-scorecard'), /100%/, 'the score is reported');
    const [suggestion] = calls.suggestions.filter(Boolean);
    assert.equal(suggestion?.rating, 4, 'and the grade it implies is offered to the bar');
    assert.equal(suggestion?.score, 1);
});

test('asking for the grade clears the suggestion: it has been acted on', async () => {
    const { dock, host, calls } = makeDock();
    dock.openTab('mcq');
    await settle();
    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();

    assert.equal(calls.suggestions.at(-1)?.rating, 4);
    dock.clearSuggestion();
    assert.equal(calls.suggestions.at(-1), null, 'the bar is told to stop marking a grade');
});

test('an SM-2 note is suggested its own scale, in the words its buttons use', async () => {
    const { dock, host, plugin, calls } = makeDock();
    plugin.reviewScheduleService.schedules['notes/a.md'] = { schedulingAlgorithm: 'sm2' };
    dock.openTab('mcq');
    await settle();
    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();

    const [suggestion] = calls.suggestions.filter(Boolean);
    assert.equal(suggestion?.rating, 5, 'the SM-2 value');
    assert.equal(suggestion?.label, 'Perfect recall', 'in the words the SM-2 grade row prints');
});

test('a finished sitting is not started again by a re-render', async () => {
    const { dock, host, plugin, calls } = makeDock();
    dock.openTab('mcq');
    await settle();
    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();
    assert.ok(host.byClass('sf-dock-scorecard').length === 1, 'the score card is up');

    // Every strip tick asks the dock to redraw; none of them is "sit another".
    dock.setExpanded(false);
    dock.setExpanded(true);
    await settle();

    assert.equal(host.byClass('sf-dock-scorecard').length, 1, 'still the card, not a new sitting');
    assert.equal(host.byClass('sf-mcq-runner-choice').length, 0, 'no questions are asked again');
    assert.equal(dock.isAnswering(), false, 'so the bar keeps its own keys');
    assert.equal(calls.recorded.length, 0, 'and nothing was graded by the redraw');

    // Asking for another sitting is explicit, and it works.
    host.byClass('sf-dock-scorecard-restart')[0].click();
    await settle();
    assert.equal(host.byClass('sf-mcq-runner-choice').length, 3, 'a fresh set is asked');
});

test('a question given up on still ends in a grade the learner gives', async () => {
    const { dock, host, calls } = makeDock();
    dock.openTab('mcq');
    await settle();

    for (let i = 0; i < 3; i += 1) {
        const wrong = host.byClass('sf-mcq-runner-choice')[0];
        wrong.click();
        const giveUp = host.byClass('sf-mcq-runner-action')[0];
        assert.ok(giveUp, 'a wrong pick offers the answer');
        giveUp.click();
        // Giving up reveals the answer; moving on is a second click.
        host.byClass('sf-mcq-runner-action')[0]?.click();
    }
    await settle();

    assert.equal(calls.recorded.length, 0);
    assert.equal(calls.suggestions.filter(Boolean).at(-1)?.label, 'Again', 'a zero score suggests Again');
});

test('the dock remembers the height it was left at, and auto-sizes by default', () => {
    const { host, plugin } = makeDock();
    const inner = host.byClass('sf-dock-inner')[0];
    assert.equal(inner.style['--sf-dock-height'] ?? '', '', 'no stored height means the stylesheet decides');

    plugin.settings.reviewDockHeight = 320;
    const second = makeDock();
    second.plugin.settings.reviewDockHeight = 320;
    second.dock.mountInto(second.host as unknown as HTMLElement);
    assert.equal(second.host.byClass('sf-dock-inner')[0].style['--sf-dock-height'], '320px');
});

test('a finished study session offers its grade and records nothing on its own', async () => {
    const { dock, calls } = makeDock();
    const internal = dock as unknown as { afterStudySession: (payload: unknown) => void };

    internal.afterStudySession({ notePath: 'notes/a.md', score: 0.75 });

    const [suggestion] = calls.suggestions.filter(Boolean);
    assert.equal(suggestion?.rating, 3, 'the score-implied FSRS grade');
    assert.equal(suggestion?.score, 0.75);
    assert.equal(suggestion?.label, 'Good');
    assert.equal(calls.recorded.length, 0, 'nothing is recorded until the learner grades');
});

test('following the next note clears the sitting and its suggestion', async () => {
    const { dock, host, calls } = makeDock();
    dock.openTab('mcq');
    await settle();
    for (let i = 0; i < 3; i += 1) answerCorrectly(dock, host);
    await settle();
    assert.equal(calls.suggestions.filter(Boolean).length, 1, 'the sitting left a suggestion');

    dock.setPath('notes/b.md');

    assert.equal(calls.suggestions.at(-1), null, 'the previous note\'s grade does not follow the bar');
    assert.equal(calls.recorded.length, 0, 'and is not silently recorded either');
});

// ---------------------------------------------------------------------------
// The cards tab: the deck lane's sitting lives in the dock, in the same slot
// the questions render in.
// ---------------------------------------------------------------------------

test('a note keeps the decks\u2019 control out of the tab row until the run reaches their steps', async () => {
    const { dock, calls } = makeDock({ deck: true, dueCount: 5 });
    dock.openTab('study');
    await settle();
    assert.equal(
        calls.tabs.at(-1)?.cards,
        null,
        'a note\u2019s tab row is about the note: the decks are not offered yet',
    );

    const reached = makeDock({ deck: true, dueCount: 5, cardsReached: true });
    reached.dock.openTab('study');
    await settle();
    assert.ok(reached.calls.tabs.at(-1)?.cards, 'once the run has stood on a deck step, it is offered');
});

test('the cards tab joins the bar when the vault has a deck lane', () => {
    const { dock, plugin } = makeDock({ cardsReached: true });

    assert.equal(dock.tabState().cards?.label, 'Cards', 'no count yet means no number');
    assert.match(dock.tabState().cards?.title ?? '', /opens a card sitting/);

    plugin.deckDueCount = 33;
    plugin.deckDueCountedAt = Date.now();
    assert.equal(dock.tabState().cards?.label, 'Cards · 33', 'a fresh count rides on the label');
    assert.match(dock.tabState().cards?.title ?? '', /33 cards due/, 'and is explained on hover');

    // The sidebar counted a while ago: a number that might be an hour old is
    // worse than none, so it is dropped rather than shown wrong.
    plugin.deckDueCountedAt = Date.now() - 90_000;
    assert.equal(dock.tabState().cards?.label, 'Cards', 'a stale count is not printed');
});

test('without a deck lane there is no cards tab to offer', () => {
    const { dock } = makeDock({ deck: false });

    assert.equal(dock.tabState().cards, null, 'no deck lane, no tab');
    assert.ok(dock.tabState().mcq, 'and the other tabs are unaffected');
});

test('a docked sitting counts itself down: the tab drops a card per answer', () => {
    const { dock, plugin, calls } = makeDock({ deck: true, dueCount: 43 });
    // The deck lane's own sitting, in the shape DeckSessionController reports
    // it: a queue of 43 that shrinks as cards are answered.
    let answered = 0;
    plugin.deckSessionController = {
        isActive: () => true,
        currentDeckPath: () => 'decks/demo.md',
        startAllDue: async () => undefined,
        currentCard: () => ({ position: answered + 1, total: 43 }),
        summary: () => ({
            deckName: 'Demo', deckCount: 1,
            position: answered + 1, total: 43, answered,
            correct: 0, picks: 0, notesWaiting: 0,
        }),
    } as unknown as typeof plugin.deckSessionController;
    dock.dockCards({ mount: () => () => undefined });

    // The number is the sitting's own — not the sidebar's, which has not been
    // re-counted since the reader started answering.
    assert.equal(dock.tabState().cards?.label, 'Cards · 43', 'the sitting says what is left in it');
    assert.match(dock.tabState().cards?.title ?? '', /left in the sitting/);

    answered = 1;
    dock.cardSittingChanged();
    assert.equal(dock.tabState().cards?.label, 'Cards · 42', 'one card answered is one card less');
    assert.equal(calls.tabs.at(-1)?.cards?.label, 'Cards · 42', 'and the bar is told at once');

    answered = 43;
    assert.equal(dock.tabState().cards?.label, 'Cards', 'a spent sitting prints no number, not a zero');
    assert.match(dock.tabState().cards?.title ?? '', /done/);
});

test('a finished sitting reads as nothing left, not as one more card', () => {
    // The sitting's own shape once its queue is spent: the summary stands on
    // the last card answered, with nothing behind it.
    const { dock, plugin } = makeDock({ deck: true, dueCount: 9, countedAt: Date.now(), cardsReached: true });
    plugin.deckSessionController = {
        isActive: () => true,
        currentDeckPath: () => 'decks/demo.md',
        startAllDue: async () => undefined,
        currentCard: () => null,
        summary: () => ({ deckName: 'Demo', deckCount: 1, position: 9, total: 9, answered: 9 }),
    } as unknown as typeof plugin.deckSessionController;
    dock.dockCards({ mount: () => () => undefined });

    assert.equal(dock.tabState().cards?.label, 'Cards', 'nothing left is not a count of one');
    assert.match(dock.tabState().cards?.title ?? '', /done/);
});

test('with no sitting docked the sidebar’s last count still stands', () => {
    const { dock, plugin } = makeDock({ deck: true, dueCount: 12, countedAt: Date.now(), cardsReached: true });
    // A sitting out in its own window is not this dock's to count: the number
    // falls back to the count the sidebar worked out.
    plugin.deckSessionController = {
        isActive: () => true,
        currentDeckPath: () => 'decks/demo.md',
        startAllDue: async () => undefined,
        currentCard: () => ({ position: 1, total: 12 }),
        summary: () => ({ deckName: 'Demo', deckCount: 1, position: 1, total: 12, answered: 0 }),
    } as unknown as typeof plugin.deckSessionController;

    assert.equal(dock.tabState().cards?.label, 'Cards · 12', 'the sidebar count, because nothing is docked here');
});

test('the cards tab mounts the sitting once, and a tab switch only hides it', async () => {
    const { dock } = makeDock();
    let mounts = 0;
    let teardowns = 0;
    const panels: MiniElement[] = [];
    dock.dockCards({
        mount: (container: HTMLElement) => {
            mounts += 1;
            panels.push(container as unknown as MiniElement);
            return () => { teardowns += 1; };
        },
    });

    assert.equal(mounts, 1, 'the sitting arriving mounts exactly once');
    assert.equal(dock.tabState().active, 'cards', 'and opens its own tab');
    assert.equal(panels.length, 1, 'in one panel, made by the dock');
    const panel = panels[0];
    assert.ok(panel.hasClass('sf-dock-body'), 'the panel takes the dock body slot');
    assert.equal(panel.hasClass('sf-hidden'), false, 'and the sitting is on screen');
    assert.equal(dock.isCardSittingHidden(), false, 'the sitting is the tab on screen');

    // Another tab, then back: hidden and shown, never re-mounted.
    dock.openTab('mcq');
    await settle();
    assert.equal(panel.hasClass('sf-hidden'), true, 'leaving the tab hides the sitting');
    assert.equal(dock.isCardSittingHidden(), true, 'and the bar can see it is out of sight');
    assert.equal(mounts, 1, 'it is not mounted again on the way out');
    assert.equal(teardowns, 0, 'and not torn down either');

    dock.openTab('cards');
    await settle();
    assert.equal(mounts, 1, 'coming back does not mount a second surface');
    assert.equal(panels.length, 1, 'the same panel is shown again');
    assert.equal(panel.hasClass('sf-hidden'), false);
    assert.equal(dock.isCardSittingHidden(), false);
    assert.equal(dock.tabState().active, 'cards');

    // The tab itself toggles like study and MCQs always did.
    dock.openTab('cards');
    assert.equal(dock.isExpanded(), false, 'the open cards tab collapses the dock');
    dock.openTab('cards');
    assert.equal(dock.isExpanded(), true, 'and asking again brings it back');
    assert.equal(mounts, 1, 'still the same sitting');
});

test('the sitting is taken down when it is replaced and when the dock goes', () => {
    const { dock } = makeDock();
    let first = 0;
    let second = 0;
    dock.dockCards({ mount: () => () => { first += 1; } });
    assert.equal(first, 0, 'a sitting on screen is not torn down');

    // A new sitting replaces the old one: the old surface is given back first.
    dock.dockCards({ mount: () => () => { second += 1; } });
    assert.equal(first, 1, 'the replaced sitting was taken down');
    assert.equal(second, 0, 'and the new one is alive');

    dock.destroy();
    assert.equal(second, 1, 'the dock tears its sitting down with it');
});

test('a sitting that ends by itself hands the panel back and the note returns', () => {
    const { dock, calls } = makeDock();
    let tornDown = 0;
    dock.dockCards({ mount: () => () => { tornDown += 1; } });
    dock.openTab('cards');
    assert.equal(dock.hasCardSitting(), true, 'the sitting is docked');

    dock.cardsEnded();

    assert.equal(tornDown, 1, 'the sitting\'s surface was given back');
    assert.equal(dock.hasCardSitting(), false, 'the slot is free for the next sitting');
    assert.equal(dock.tabState().active, null, 'and the reader is back at the note');
    assert.equal(calls.tabs.length > 0, true, 'the bar was told, so its tab stops claiming to be open');
});

test('a card sitting opens a collapsed dock, however small it was left', () => {
    const { dock, host, plugin } = makeDock();

    // The reader collapsed it, and an old drag left a height nothing could be
    // read through. A sitting is content: whatever the dock was doing before,
    // the cards have to end up on screen.
    dock.openTab('study');
    dock.openTab('study');
    assert.equal(dock.isExpanded(), false, 'the dock starts closed');
    plugin.settings.reviewDockHeight = 2;
    dock.mountInto(host as unknown as HTMLElement);
    assert.equal(
        host.byClass('sf-dock-inner')[0].style['--sf-dock-height'],
        '160px',
        'a stored hairline comes back as the floor the handle itself keeps',
    );

    let mounts = 0;
    dock.dockCards({
        mount: container => {
            mounts += 1;
            (container as unknown as MiniElement).addClass('sf-deck-host');
            return () => undefined;
        },
    });

    assert.equal(dock.isExpanded(), true, 'the sitting opens the dock');
    assert.equal(mounts, 1, 'and mounts into it, once');
    const panel = host.byClass('sf-deck-host')[0];
    assert.ok(panel, 'the dock made a panel for it');
    assert.equal(panel.hasClass('sf-hidden'), false, 'the panel is on screen, not behind a bar');
    assert.equal(dock.tabState().active, 'cards', 'the cards tab is the one on screen');
    assert.equal(dock.isCardSittingHidden(), false, 'and the bar agrees the sitting is visible');

    // The floor is not an override of a real choice: a dragged size stands.
    plugin.settings.reviewDockHeight = 320;
    dock.mountInto(host as unknown as HTMLElement);
    assert.equal(host.byClass('sf-dock-inner')[0].style['--sf-dock-height'], '320px');
});

test('a docked sitting is not folded away when the bar follows the next note', () => {
    const { dock, host } = makeDock();
    const panels: MiniElement[] = [];
    let mounts = 0;
    dock.dockCards({
        mount: container => {
            mounts += 1;
            panels.push(container as unknown as MiniElement);
            return () => undefined;
        },
    });
    assert.equal(dock.isExpanded(), true, 'the sitting opened the dock');

    // The next note arrives while the cards are still up: the study and MCQ
    // panels belong to the note that has gone, the cards do not.
    dock.setPath('notes/b.md');

    assert.equal(dock.isExpanded(), true, 'the note change does not close the dock on the cards');
    assert.equal(panels[0].hasClass('sf-hidden'), false, 'the sitting is still on screen');
    assert.equal(mounts, 1, 'and was not mounted again');
    assert.equal(dock.tabState().active, 'cards', 'the cards tab is still the one shown');
    assert.equal(host.byClass('sf-dock-body').length, 1, 'and the dock holds one panel, not a second copy');

    // The sitting ending is still what hands the dock back to the note.
    dock.cardsEnded();
    assert.equal(dock.isExpanded(), false, 'the end of the sitting closes it, as it always did');
    assert.equal(dock.tabState().active, null);
});

// ---------------------------------------------------------------------------
// One panel per kind, and one preparation per note: the dock can be re-rendered
// by a tab click, a sidebar refresh and a layout change in the same breath, and
// none of those may stack a second question runner, mint a second set of
// questions, or throw away a panel another tab is still using.
// ---------------------------------------------------------------------------

/** The dock's own state, for the assertions about object identity. */
const inside = (dock: ReviewDock) => dock as unknown as Record<string, unknown>;
/** A render the way a strip tick does it: on the dock, from the outside. */
const rerender = (dock: ReviewDock): void => (inside(dock).renderContent as () => void).call(dock);

test('concurrent renders prepare one set of questions and mount one runner', async () => {
    const gates: (() => void)[] = [];
    const { dock, host, calls, set } = makeDock({
        ensure: () => new Promise<MCQSet | null>(resolve => { gates.push(() => resolve(set)); }),
    });

    dock.openTab('mcq');
    // A strip tick, a layout change and another click: all of them re-render,
    // all of them arrive while the first preparation is still in flight.
    rerender(dock);
    rerender(dock);
    rerender(dock);
    await settle();

    assert.equal(calls.ensure.length, 1, 'four renders, one preparation');
    assert.equal(host.byClass('sf-mcq-runner').length, 0, 'nothing is mounted while it is still being prepared');

    gates.shift()?.();
    await settle();
    await settle();

    assert.equal(host.byClass('sf-mcq-runner').length, 1, 'exactly one runner when it lands');
    assert.equal(host.byClass('sf-dock-body').length, 1, 'in one panel of its kind');
    assert.equal(dock.isAnswering(), true, 'and it is the one the reader answers');

    // A late render after the questions are up is not a second sitting.
    rerender(dock);
    await settle();
    assert.equal(calls.ensure.length, 1, 'still the one preparation');
    assert.equal(host.byClass('sf-mcq-runner').length, 1, 'still the one runner');
});

test('switching cards -> mcqs -> cards keeps the identical panels, runner included', async () => {
    const { dock, host } = makeDock();
    let mounts = 0;
    let teardowns = 0;
    const panels: MiniElement[] = [];
    dock.dockCards({
        mount: (container: HTMLElement) => {
            mounts += 1;
            const panel = container as unknown as MiniElement;
            panel.addClass('sf-deck-host');
            panels.push(panel);
            return () => { teardowns += 1; };
        },
    });
    const cards = panels[0];
    assert.ok(cards, 'the sitting got its panel');

    dock.openTab('mcq');
    await settle();
    const runner = inside(dock).runner;
    assert.ok(runner, 'the questions are up');
    // Half-answered: the first question answered, the loop on the second.
    answerCorrectly(dock, host);
    assert.match(host.textOf('sf-mcq-runner-progress'), /^2\/3$/, 'on the second question');
    assert.equal(cards.hasClass('sf-hidden'), true, 'the sitting is hidden, not gone');

    dock.openTab('cards');
    await settle();
    assert.equal(mounts, 1, 'the sitting was mounted exactly once');
    assert.equal(teardowns, 0, 'and never taken down');
    assert.equal(host.byClass('sf-dock-body').includes(cards), true, 'the identical panel is still mounted');
    assert.equal(cards.hasClass('sf-hidden'), false, 'and it is the tab on screen');
    assert.equal(dock.isAnswering(), false, 'the hidden runner is not answering anything');

    dock.openTab('mcq');
    await settle();
    assert.equal(inside(dock).runner, runner, 'the very same runner is shown again');
    assert.match(host.textOf('sf-mcq-runner-progress'), /^2\/3$/, 'where the sitting was left');
    assert.equal(dock.isAnswering(), true, 'and it answers again');
    assert.equal(panels.length, 1, 'no second cards panel was built on the way back');
});

test('switching study -> cards -> mcqs leaves exactly one panel of each kind', async () => {
    const { dock, host } = makeDock();
    dock.openTab('study');
    await settle();
    const studyPanel = inside(dock).panel;
    assert.ok(studyPanel, 'the study panel is up');

    let decks = 0;
    dock.dockCards({
        mount: (container: HTMLElement) => {
            decks += 1;
            (container as unknown as MiniElement).addClass('sf-deck-host');
            return () => undefined;
        },
    });
    dock.openTab('mcq');
    await settle();
    dock.openTab('study');
    await settle();
    dock.openTab('cards');
    await settle();
    dock.openTab('mcq');
    await settle();
    dock.openTab('study');
    await settle();

    const inner = host.byClass('sf-dock-inner')[0];
    assert.equal(inner.byClass('sf-dock-body').length, 3, 'one panel per kind, three kinds');
    assert.equal(inner.byClass('sf-mcq-runner').length, 1, 'one question runner');
    assert.equal(inner.byClass('sf-study-panel').length, 1, 'one study panel');
    assert.equal(inner.byClass('sf-deck-host').length, 1, 'one card sitting');
    assert.equal(decks, 1, 'the sitting itself was mounted once');
    assert.equal(inside(dock).panel, studyPanel, 'and the study panel is the same instance it was');
    assert.equal(inner.children.filter(child => child.hasClass('sf-dock-body')).length, 3, 'nothing else wears a panel\'s clothes');
});

test('a tab switch during an in-flight start does not stack a second panel', async () => {
    const gates: (() => void)[] = [];
    const { dock, host, calls, set } = makeDock({
        ensure: () => new Promise<MCQSet | null>(resolve => { gates.push(() => resolve(set)); }),
    });
    dock.dockCards({
        mount: (container: HTMLElement) => {
            (container as unknown as MiniElement).addClass('sf-deck-host');
            return () => undefined;
        },
    });

    dock.openTab('mcq');
    await settle();
    assert.equal(calls.ensure.length, 1, 'the questions are being prepared');

    // The reader walks off to the cards while it lands.
    dock.openTab('cards');
    await settle();
    gates.shift()?.();
    await settle();
    await settle();

    assert.equal(host.byClass('sf-mcq-runner').length, 0, 'nothing is mounted behind the reader\'s back');
    assert.equal(host.byClass('sf-dock-body').length, 1, 'the cards panel alone — no questions panel was made');

    // Back to the tab: the questions are asked for once, and once only.
    dock.openTab('mcq');
    await settle();
    gates.shift()?.();
    await settle();
    await settle();

    assert.equal(host.byClass('sf-mcq-runner').length, 1, 'exactly one runner');
    assert.equal(host.byClass('sf-dock-body').length, 2, 'and no second panel of either kind');
    assert.equal(calls.ensure.length, 2, 'the second look reads the set the first one wrote');
});

test('a panel left behind by an interrupted mount is cleared before a new one arrives', async () => {
    const { dock, host } = makeDock();
    const inner = host.byClass('sf-dock-inner')[0];
    // A plugin reload leaves last sitting's markup behind, with nothing in the
    // dock pointing at it.
    const strayPanel = inner.createDiv('sf-dock-body');
    strayPanel.createDiv('sf-mcq-runner');

    dock.openTab('mcq');
    await settle();
    assert.equal(host.byClass('sf-mcq-runner').length, 1, 'one runner');
    assert.equal(strayPanel.isConnected, false, 'the stray panel went with its runner');

    // The same for a sitting: the stale panel goes when the cards tab claims one.
    const straySitting = inner.createDiv('sf-dock-body');
    straySitting.addClass('sf-deck-host');
    dock.dockCards({
        mount: (container: HTMLElement) => {
            (container as unknown as MiniElement).addClass('sf-deck-host');
            return () => undefined;
        },
    });
    assert.equal(host.byClass('sf-deck-host').length, 1, 'one sitting');
    assert.equal(straySitting.isConnected, false, 'the stale sitting did not survive beside the new one');
    assert.equal(host.byClass('sf-dock-body').length, 2, 'one panel of each kind');
});

test('the note changing takes every panel with it, preparation included', async () => {
    const gates: (() => void)[] = [];
    const { dock, host, calls, set } = makeDock({
        ensure: () => new Promise<MCQSet | null>(resolve => { gates.push(() => resolve(set)); }),
    });
    dock.openTab('mcq');
    await settle();
    assert.equal(calls.ensure.length, 1);

    dock.setPath('notes/b.md');
    gates.shift()?.();
    await settle();
    await settle();

    assert.equal(host.byClass('sf-mcq-runner').length, 0, 'the old note\'s questions do not land on the new note');
    // The dock follows the note now: the note the bar arrived at is prepared
    // straight away instead of the panel folding away and waiting for a click.
    assert.equal(calls.ensure.length, 2, 'the note we arrived at is prepared, the one we left is not');
    assert.equal(calls.ensure[1], 'notes/b.md', 'and it is the note the bar is on');

    gates.shift()?.();
    await settle();
    await settle();
    assert.equal(host.byClass('sf-mcq-runner').length, 1, 'its questions are on screen without another click');
});
