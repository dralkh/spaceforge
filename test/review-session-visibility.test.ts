/**
 * A session must be visible the moment it starts — from the sidebar's list as
 * much as from anywhere else.
 *
 * Two things are pinned here, both about the *entry points* the reader presses
 * rather than about the run itself: the dock shows a card sitting even when the
 * run it belongs to has no note left to sit under, and a deck sitting that has
 * to take a pane of its own is brought to the reader rather than opened in a tab
 * they have since left.
 *
 * The flow-side half of the same rule — a session whose remembered home is the
 * sidebar's hidden review pane coming back under the note — is driven through
 * the real ReviewFlowController in review-flow-controller.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { ReviewDock } from '../ui/review-dock';
import { DeckSessionController, DeckSessionCard } from '../controllers/deck-session-controller';
import { AnkiCard, AnkiCardQueue, AnkiCardType, DeckBundle, DeckScheduler } from '../models/anki';
import type { DeckSessionSummary } from '../ui/deck-session-view';

// --------------------------------------------------------------- the dock

/**
 * A dock whose run has no note left: the queue emptied, and the cards are what
 * the reader is being handed.
 */
function makePathlessDock(): { dock: ReviewDock; host: MiniElement } {
    installMiniDocument();
    const plugin = {
        settings: {
            studyEnabled: true,
            enableMCQ: true,
            reviewDockHeight: 0,
            studyAutoRateNote: false,
            defaultSchedulingAlgorithm: 'fsrs',
        },
        // Truthy is all the dock asks of these two: the settings decide which
        // tabs are offered at all.
        studyController: { subscribeChart: () => () => undefined },
        mcqController: { ensureMcqSetForNote: async () => null },
        mcqService: { getMCQSetForNote: () => null },
        reviewScheduleService: { schedules: {} },
        reviewController: { processReviewResponse: async () => ({ recorded: false }) },
        reviewFlowController: { refreshCurrent: () => undefined },
        // The deck lane, and the count the sidebar last worked out.
        deckSessionController: { isActive: () => false, startAllDue: async () => undefined },
        deckDueCount: 12,
        deckDueCountedAt: Date.now(),
        studyChartQueue: { enqueue: () => undefined, tick: async () => undefined },
        savePluginData: async () => undefined,
        getSidebarView: () => null,
    };
    const controller = {
        subscribeChart: () => () => undefined,
        chartUpdate: () => null,
    };

    const host = new MiniElement('div');
    host.addClass('workspace-leaf-content');
    const dock = new ReviewDock(plugin as never, controller as never, {});
    dock.mountInto(host as unknown as HTMLElement);
    // No setPath(): this run has no note, which is exactly the hand-over state.
    return { dock, host };
}

test('a card sitting docks and shows with no note left in the run', () => {
    const { dock, host } = makePathlessDock();
    let mounts = 0;

    dock.dockCards({
        mount: container => {
            mounts += 1;
            container.addClass('sf-deck-host');
            container.createDiv('sf-deck');
            return () => undefined;
        },
    });

    const root = host.byClass('sf-dock')[0];
    assert.ok(root, 'the dock is mounted');
    assert.equal(root.hasClass('sf-hidden'), false, 'the dock shows for the cards');
    assert.equal(dock.isExpanded(), true, 'the sitting opens the dock');
    assert.equal(mounts, 1, 'and mounts into it');
    assert.equal(host.byClass('sf-deck').length, 1, 'where the reader can see it');
    assert.equal(dock.tabState().active, 'cards', 'the bar is told which tab is on screen');
    assert.ok(dock.tabState().cards, 'and the cards tab stays offered with no note behind it');
});

// -------------------------------------------------------- the deck sitting

const NOW = 1_792_224_000_000;

/** One new card in one deck: the smallest sitting the lane will start. */
function deckBundle(): DeckBundle {
    const card: AnkiCard = {
        id: 'c1',
        noteId: 'n1',
        deckId: 'd1',
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: 0,
        flag: 0,
    };
    return {
        deck: {
            id: 'd1',
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
        },
        notes: [{
            id: 'n1',
            modelName: 'Basic',
            fields: ['Front', 'Back'],
            values: ['Question', 'Answer'],
            tags: [],
            cardIds: ['c1'],
            mediaFiles: [],
        }],
        cards: [card],
        media: [],
    };
}

test('a deck sitting takes the dock when the flow offers one, and a pane of its own when it does not', async () => {
    installMiniDocument();
    const bundle = deckBundle();
    const standIn = {
        shown: [] as DeckSessionCard[],
        finished: [] as DeckSessionSummary[],
        mounts: 0,
    };
    const view = {
        mountInto: () => { standIn.mounts += 1; },
        show: (card: DeckSessionCard) => { standIn.shown.push(card); },
        finish: (summary: DeckSessionSummary | null) => { if (summary) standIn.finished.push(summary); },
        pulse: () => undefined,
        destroy: () => undefined,
        isAnswering: () => true,
    };

    const containerEl = new MiniElement('div');
    containerEl.addClass('workspace-leaf-content');
    const leaf = { view: { containerEl }, openFile: async () => undefined };
    const revealed: unknown[] = [];
    let dockAsked = 0;

    const plugin = {
        app: {
            vault: { getAbstractFileByPath: () => null },
            workspace: {
                getLeaf: () => leaf,
                revealLeaf: (target: unknown) => { revealed.push(target); return Promise.resolve(); },
            },
        },
        settings: { deckSessionPlacement: 'split', reviewSessionPlacement: 'split', mcqGradingMode: 'ask' },
        reviewScheduleService: { getDueNotes: () => [] },
        // No dock is up: the flow refuses the sitting, so it takes a pane — and
        // that pane has to be one the reader is looking at.
        reviewFlowController: { showCardSitting: () => { dockAsked += 1; return false; } },
    };
    const store = {
        readDeck: async () => bundle,
        updateCardStates: async () => 'in-place' as const,
    };

    const controller = new DeckSessionController(
        plugin as never,
        store as never,
        { createView: () => view as never },
    );

    await controller.start('spaceforge/decks/Test deck.md');

    assert.equal(dockAsked, 1, 'the dock is the first thing asked for');
    assert.equal(revealed.length, 1, 'the pane the sitting takes is brought on screen');
    assert.equal(revealed[0], leaf, 'the very leaf the sitting mounts into');
    assert.equal(standIn.mounts, 1, 'the sitting mounted');
    assert.equal(standIn.shown.length, 1, 'on its first card');
});
