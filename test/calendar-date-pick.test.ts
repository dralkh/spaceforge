/**
 * Picking a day in the calendar has to take the reader to that day's list.
 *
 * The regression this pins is the one the reader reported as "practically
 * disabled": the click wrote the mode, asked the *workspace* for the sidebar,
 * got null (a reloaded plugin leaves a view of an older class in the leaf), and
 * told them the sidebar "will update" — which it never did. Meanwhile pressing
 * the List tab did nothing either, because the mode already said `list` and the
 * tab returned early.
 *
 * Two contracts are asserted here, at the real classes:
 *   - the calendar answers a date pick through the host that drew it, silently;
 *   - the calendar never reads a note's text to draw a cell (that read-per-note
 *     is what made a month take seconds on a real vault).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../models/settings';
import { MiniElement } from './support/mini-dom';
import { notices } from './support/obsidian-shim';
import { CalendarView } from '../ui/calendar-view';
import { ReviewSidebarView } from '../ui/sidebar-view';

const DAY = 86_400_000;

function dayStart(offsetDays: number): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY;
}

function makeCalendar(host: { onDatePicked?: (date: Date) => void }) {
    const reads: string[] = [];
    const schedules: Record<string, unknown> = {};
    for (const offset of [0, 3, 10]) {
        const path = `Note ${offset}.md`;
        schedules[path] = {
            path,
            lastReviewDate: null,
            nextReviewDate: dayStart(offset),
            ease: 250,
            interval: 1,
            consecutive: 0,
            reviewCount: 0,
            repetitionCount: 0,
            scheduleCategory: 'spaced',
            schedulingAlgorithm: 'sm2',
        };
    }

    const plugin = {
        settings: { ...DEFAULT_SETTINGS, sidebarViewType: 'calendar', enableCalendarEvents: false },
        reviewScheduleService: {
            schedules,
            estimateReviewTimeCached: () => 120,
            estimateReviewTime: async (path: string) => { reads.push(path); return 120; },
        },
        wordCounts: { prime: async (paths: string[]) => paths.length, words: () => 200 },
        deckStore: { listDecks: async () => [] },
        pluginState: { calendarEvents: {} },
        app: { vault: { getAbstractFileByPath: () => null, read: async (file: { path: string }) => { reads.push(file.path); return ''; } } },
        savePluginData: async () => undefined,
    };

    const container = new MiniElement('div');
    const view = new CalendarView(container as unknown as HTMLElement, plugin as never, host);
    return { view, container, reads };
}

test('a date picked in the calendar is answered by the sidebar that drew it, with no notice', async () => {
    const picked: Date[] = [];
    const { view, container, reads } = makeCalendar({ onDatePicked: date => picked.push(date) });

    const before = notices.length;
    await view.render();

    const cells = container.querySelectorAll('.calendar-day');
    assert.ok(cells.length >= 28, `the grid drew ${cells.length} cells`);

    // The first cell that carries work: its own count element is the tell.
    const target = cells.find(cell => cell.querySelectorAll('.calendar-review-count').length > 0);
    assert.ok(target, 'a day cell exists for a date with work on it');

    const handler = (target as unknown as { onclick?: (event: unknown) => void }).onclick;
    assert.equal(typeof handler, 'function', 'the cell is clickable');
    handler.call(target, {});

    assert.equal(picked.length, 1, 'the host was asked exactly once');
    assert.ok(picked[0] instanceof Date);
    assert.equal(notices.length, before, 'no notice was raised by a click that works');
});

test('drawing a month never reads a note: the estimate comes from the count it already has', async () => {
    const { view, reads } = makeCalendar({});
    await view.render();
    assert.deepEqual(reads, [], 'the calendar issued no vault reads');
});

test('pressing the tab that already names the mode still paints it', async () => {
    // The reader's report: a date picked in the calendar left the mode saying
    // `list` while the calendar was still on screen, and pressing List then did
    // nothing — the tab returned early because the mode already matched.
    let paints = 0;
    let saves = 0;
    const fake = {
        plugin: {
            settings: { sidebarViewType: 'list' as const },
            savePluginData: async () => { saves += 1; },
        },
        activeListBaseDate: null as Date | null,
        leaveReviewTab: (): void => undefined,
        refresh: async (): Promise<void> => { paints += 1; },
    };

    const switchMode = (ReviewSidebarView.prototype as unknown as {
        switchMode: (this: typeof fake, mode: string) => Promise<void>;
    }).switchMode;
    await switchMode.call(fake, 'list');

    assert.equal(paints, 1, 'the press repainted the pane');
    assert.equal(saves, 0, 'nothing was written when the mode did not change');
});
