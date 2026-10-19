/**
 * The statistics view, over the miniature DOM: the tiles, the heatmap and its
 * day readout, the retention table, the range selector, the deck table and the
 * empty vault. The arithmetic is covered in `stats-service.test.ts`; these
 * checks are about the page actually drawing what the service computed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installMiniDocument, MiniElement, textsOfClass } from './support/mini-dom';
import { StatsService } from '../services/stats-service';
import { StatsView, STATS_VIEW } from '../ui/stats-view';
import { renderHeatmap } from '../ui/stats-charts';
import { DEFAULT_SETTINGS } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA, PluginStateData } from '../models/plugin-data';
import { AnkiCardQueue, AnkiCardType, DeckBundle } from '../models/anki';
import { DAY_MS, startOfUTCDay } from '../models/stats';

installMiniDocument();

interface ViewHarness {
    view: StatsView;
    content: MiniElement;
    plugin: Record<string, unknown>;
    stats: StatsService;
}

function makeView(options: { deck?: { bundle: DeckBundle; summary: Record<string, unknown> } } = {}): ViewHarness {
    const state: PluginStateData = {
        ...DEFAULT_PLUGIN_STATE_DATA,
        schedules: {},
        history: [],
        deckHistory: [],
    };
    const plugin: Record<string, unknown> = {
        settings: { ...DEFAULT_SETTINGS },
        events: { on: () => undefined, off: () => undefined, emit: () => undefined },
        app: {
            workspace: {
                on: () => undefined,
                off: () => undefined,
                getActiveViewOfType: () => null,
                openLinkText: async () => undefined,
            },
        },
    };
    const stats = new StatsService(plugin as never, undefined, []);
    stats.applyLoadedState(state);
    plugin.statsService = stats;
    plugin.reviewScheduleService = { schedules: state.schedules, history: state.history };
    plugin.studyPlanService = { sessions: {}, progress: {} };
    plugin.mcqService = { mcqSessions: {} };
    plugin.deckStore = options.deck
        ? {
            listDecks: async () => [options.deck!.summary],
            readDeck: async () => options.deck!.bundle,
        }
        : { listDecks: async () => [], readDeck: async () => { throw new Error('no deck'); } };

    const view = new StatsView({} as never, plugin as never);
    const content = new MiniElement('div');
    (view as unknown as { contentEl: MiniElement }).contentEl = content;
    return { view, content, plugin, stats };
}

function seedHistory(harness: ViewHarness): { todayStart: number } {
    const now = Date.now();
    const todayStart = startOfUTCDay(now);
    harness.stats.recordNoteReview({ path: 'notes/a.md', timestamp: now - 3_600_000, response: 4, interval: 5, ease: 250, grade: 'good', scheduler: 'sm2' });
    harness.stats.recordNoteReview({ path: 'notes/b.md', timestamp: now - DAY_MS - 3_600_000, response: 1, interval: 30, ease: 80, grade: 'again', scheduler: 'fsrs' });
    const schedules = (harness.plugin.reviewScheduleService as { schedules: Record<string, unknown> }).schedules;
    schedules['notes/a.md'] = {
        path: 'notes/a.md', lastReviewDate: todayStart, nextReviewDate: todayStart,
        ease: 250, interval: 6, consecutive: 2, reviewCount: 3, repetitionCount: 3,
        scheduleCategory: 'spaced', schedulingAlgorithm: 'sm2',
    };
    return { todayStart };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('the page draws the tiles, the heatmap, the retention table and the answers', async () => {
    const harness = makeView();
    seedHistory(harness);
    await harness.view.onOpen();

    const labels = textsOfClass(harness.content, 'sf-stats-tile-label');
    for (const expected of ['Reviews today', 'Streak', 'Retention (30 d)', 'Due today', 'Days studied', 'Memory now']) {
        assert.ok(labels.includes(expected), `tile ${expected}`);
    }
    assert.equal(harness.content.byClass('sf-stats-tile-value').length, 6);

    const cells = harness.content.byClass('sf-stats-cell');
    assert.equal(cells.length, 182, 'the heatmap covers half a year whatever the window');
    assert.equal(cells.filter(cell => !cell.hasClass('is-l0')).length, 2, 'exactly the two review days carry colour');
    assert.equal(harness.content.byClass('sf-stats-weekday-row').length, 7, 'the details card shows the weekday rhythm');

    // Click a busy day: the details card becomes that day's breakdown.
    const busy = cells.find(cell => !cell.hasClass('is-l0'));
    assert.ok(busy);
    busy.click();
    assert.match(harness.content.textOf('sf-stats-day-date'), /, 2026/, 'the picked day is named');
    assert.match(harness.content.textOf('sf-stats-day-total'), /notes/);
    assert.ok(textsOfClass(harness.content, 'sf-stats-grade-name').includes('Again'), 'the day shows its grades');

    // And the way back to the weekday rhythm.
    harness.content.byClass('sf-stats-link')[0].click();
    assert.equal(harness.content.byClass('sf-stats-weekday-row').length, 7);
    assert.equal(harness.content.byClass('sf-stats-day-date').length, 0);

    const tableText = harness.content.textOf('sf-stats-table');
    for (const expected of ['Learning', 'Young', 'Mature', 'All reviews', '100%']) {
        assert.ok(tableText.includes(expected), `retention table shows ${expected}`);
    }

    assert.ok(harness.content.byClass('sf-stats')[0].hasClass('is-layout-narrow'), 'the layout class follows the measured width');

    assert.equal(harness.content.byClass('sf-stats-forecast-svg').length, 1, 'the forecast draws');
    assert.equal(harness.content.byClass('sf-stats-histogram-svg').length, 1, 'the health histogram draws');
    assert.equal(harness.content.byClass('sf-stats-attention-row').length, 0, 'no leeches in this history');
});

test('the range selector changes the window and the page redraws', async () => {
    const harness = makeView();
    seedHistory(harness);
    await harness.view.onOpen();
    assert.equal((harness.view as unknown as { range: string }).range, '90d');

    const buttons = harness.content.byClass('sf-stats-range-btn');
    assert.equal(buttons.length, 4);
    buttons[0].click(); // "1 month"
    await settle();

    assert.equal((harness.view as unknown as { range: string }).range, '30d');
    assert.ok(harness.content.byClass('sf-stats-range-btn')[0].hasClass('is-active'), 'the chosen window is marked after the repaint');
    assert.ok(
        textsOfClass(harness.content, 'sf-stats-tile-sub').some(sub => sub.includes('30 days')),
        'the days-studied tile follows the window'
    );
    assert.equal(harness.content.byClass('sf-stats-cell').length, 182, 'the heatmap stays half a year at the short window too');
});

test('an empty vault says so instead of drawing empty charts', async () => {
    const harness = makeView();
    await harness.view.onOpen();

    assert.equal(harness.content.byClass('sf-stats-empty-state').length, 1);
    assert.equal(harness.content.byClass('sf-stats-grid').length, 0);
});

test('a deck gets its own table, and its cards appear in the forecast', async () => {
    const now = Date.now();
    const todayStart = startOfUTCDay(now);
    const bundle = {
        deck: { id: 'd1', name: 'Biology', modified: 1, options: { scheduler: 'sm2', leechThreshold: 8, leechAction: 1 } },
        notes: [{ id: 'n1', modelName: 'Basic', fields: ['Front'], values: ['What is a cell?'], tags: [], cardIds: ['c1'], mediaFiles: [] }],
        cards: [
            {
                id: 'c1', noteId: 'n1', deckId: 'd1', ord: 0,
                type: AnkiCardType.Review, queue: AnkiCardQueue.Review,
                interval: 30, easeFactor: 2500, reviews: 5, lapses: 0,
                due: 3, newPosition: null, flag: 0,
            },
        ],
        media: [],
        extra: { crt: todayStart / 1000 },
    } as unknown as DeckBundle;
    const summary = {
        path: 'spaceforge/decks/biology.md',
        name: 'Biology',
        id: 'd1',
        counts: { newCount: 0, learningCount: 0, reviewCount: 1, totalCards: 1, dueToday: 0 },
        mediaCount: 0,
        modified: 1,
        warnings: [],
    };
    const harness = makeView({ deck: { bundle, summary } });
    harness.stats.recordNoteReview({ path: 'notes/a.md', timestamp: now - 1000, response: 4, interval: 5, ease: 250, grade: 'good', scheduler: 'sm2' });
    await harness.view.onOpen();

    const deckTable = harness.content.byClass('sf-stats-deck-name');
    assert.equal(deckTable.length, 1, 'the deck is listed');
    assert.equal(deckTable[0].text, 'Biology');
    assert.equal(harness.content.byClass('sf-stats-deck-row').length, 1, 'decks are rows, so nothing can clip');
    assert.ok(textsOfClass(harness.content, 'sf-stats-note').some(note => note.includes('load ≈')), 'the forecast reports its load');
});

test('the health metric segments switch without repainting the page', async () => {
    const harness = makeView();
    seedHistory(harness);
    await harness.view.onOpen();

    const segments = harness.content.byClass('sf-stats-seg-btn');
    assert.deepEqual(segments.map(segment => segment.text), ['Interval', 'Ease', 'Stability', 'Difficulty']);
    assert.ok(segments[0].hasClass('is-active'));

    segments[1].click();
    assert.ok(segments[1].hasClass('is-active'));
    assert.ok(!segments[0].hasClass('is-active'));
    assert.equal((harness.view as unknown as { healthMetric: string }).healthMetric, 'ease');
});

test('the leaf remembers which window it was showing', async () => {
    const harness = makeView();
    await harness.view.setState({ range: '1y', healthMetric: 'difficulty' }, null);
    assert.deepEqual(harness.view.getState(), { range: '1y', healthMetric: 'difficulty' });
    assert.equal(STATS_VIEW, 'spaceforge-stats');
});

test('charts add classes token by token, the way the live app requires', () => {
    // Obsidian's createSvg hands `cls` straight to classList.add, which throws
    // on a string containing a space; the miniature DOM is more forgiving, so
    // the strictness is reproduced here to keep the charts honest.
    const original = MiniElement.prototype.createSvg;
    MiniElement.prototype.createSvg = function strictCreateSvg(this: MiniElement, tag: string, options?: string | { cls?: string; attr?: Record<string, string | number | boolean | null> }) {
        if (options && typeof options === 'object' && typeof options.cls === 'string' && /\s/.test(options.cls)) {
            throw new Error(`classList.add rejects '${options.cls}'`);
        }
        return original.call(this, tag, options);
    };
    try {
        const host = new MiniElement('div');
        const days = [
            { key: '2026-10-17', timestamp: Date.UTC(2026, 9, 17), notes: 0, decks: 0 },
            { key: '2026-10-18', timestamp: Date.UTC(2026, 9, 18), notes: 3, decks: 1 },
        ];
        renderHeatmap(host, { days, width: 320, selectedKey: '2026-10-18', onSelect: () => undefined });
        const cells = host.byClass('sf-stats-cell');
        assert.equal(cells.length, 2);
        assert.ok(cells[1].hasClass('is-selected'), 'the selected cell carries both of its classes');
        assert.ok(cells.some(cell => cell.hasClass('is-l4')));
    } finally {
        MiniElement.prototype.createSvg = original;
    }
});
