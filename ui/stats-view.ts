/**
 * The statistics view: a reader's progress at a glance, in Anki's shapes.
 *
 * A leaf of its own (not a sidebar tab) because a grid of small charts needs
 * width; it can sit beside the note, on a second pane, or in a popout window.
 * Open it with "Spaceforge: Open statistics" or the chart button in the review
 * sidebar's header.
 *
 * The page is a compact dashboard on a twelve-column grid, where each card
 * takes the width its content needs (charts get seven columns, tables four)
 * and the whole canvas stops growing at a comfortable reading width. The
 * cards, in reading order:
 *
 * - six tiles: reviews today, streak, retention, due/overdue, days studied,
 *   and how much of the collection is currently retrievable (FSRS);
 * - Activity: the heatmap of the last six months (a year for the wide
 *   windows) beside a Details card that shows the weekday rhythm, or the full
 *   breakdown of a day the reader clicks;
 * - Next 30 days: the due forecast of both lanes, overdue folded into today;
 * - Retention: true retention by maturity, for today, a week, a month and all
 *   time;
 * - Answer buttons, Collection health (interval / ease / stability /
 *   difficulty), and one row per deck;
 * - Needs attention (leeches and struggle) and the Study card (tutor
 *   objectives and quiz accuracy).
 *
 * Everything is computed from the vault — day counters, the review log, the
 * schedules and the deck files. Nothing is sent anywhere.
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type SpaceforgePlugin from '../main';
import { AnkiCardQueue, DeckBundle, DeckScheduler } from '../models/anki';
import { isLeech } from '../models/anki-scheduler';
import type { ReviewHistoryItem } from '../models/review-schedule';
import {
    DAY_MS,
    DayActivity,
    GradeCounts,
    GradeMix,
    RangeTotals,
    RetentionSummary,
    ReviewGrade,
    STATS_RANGE_LABELS,
    StatsRange,
    Streaks,
    dayKeyOfTimestamp,
    gradeOfHistoryItem,
    startOfUTCDay,
    timestampOfDayKey,
} from '../models/stats';
import { DeckSummary } from '../services/deck-store';
import { QuizSummary, StatsForecast, StatsService, TutorSummary, deckSnapshot, retrievability } from '../services/stats-service';
import { deckDayBase } from '../utils/dates';
import {
    attachChartTips,
    dayHistogramCap,
    eachDay,
    formatDayKey,
    formatStreak,
    measureWidth,
    renderForecastBars,
    renderHeatmap,
    renderHistogram,
} from './stats-charts';

export const STATS_VIEW = 'spaceforge-stats';

type HealthMetric = 'interval' | 'ease' | 'stability' | 'difficulty';

interface DeckEntry {
    summary: DeckSummary;
    bundle: DeckBundle;
}

interface AttentionRow {
    label: string;
    meta: string;
    path: string;
    weight: number;
    severe: boolean;
}

interface DeckRow {
    name: string;
    path: string;
    due: number;
    newCount: number;
    learningCount: number;
    reviewCount: number;
    maturePct: number | null;
    retention: number | null;
    retentionAnswers: number;
    averageSeconds: number | null;
}

interface StatsViewData {
    now: number;
    todayStart: number;
    decks: DeckEntry[];
    activity: Map<string, DayActivity>;
    heatmapDays: Array<{ key: string; timestamp: number; notes: number; decks: number }>;
    totals: RangeTotals;
    today: { notes: number; decks: number; skipped: number };
    weekAverage: number;
    streaks: Streaks;
    daysStudied: { active: number; total: number; pct: number | null };
    forecast: StatsForecast;
    retentionPeriods: Array<{ label: string; summary: RetentionSummary }>;
    mix: GradeMix;
    health: Record<HealthMetric, { values: number[]; format: (value: number) => string; median: number | null }>;
    attention: AttentionRow[];
    attentionTotal: number;
    deckRows: DeckRow[];
    memory: { pct: number | null; recallable: number; items: number };
    tutor: TutorSummary;
    quiz: QuizSummary;
    weekdays: number[];
}

const RETENTION_PERIODS: Array<{ label: string; days: number | 'all' }> = [
    { label: 'Today', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: 'All', days: 'all' },
];

const HEALTH_METRICS: Array<{ key: HealthMetric; label: string }> = [
    { key: 'interval', label: 'Interval' },
    { key: 'ease', label: 'Ease' },
    { key: 'stability', label: 'Stability' },
    { key: 'difficulty', label: 'Difficulty' },
];

const GRADE_ORDER: ReviewGrade[] = ['again', 'hard', 'good', 'easy'];
const GRADE_LABELS: Record<ReviewGrade, string> = {
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy',
};

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** One deck read, and when it was read, so a repaint does not re-parse it. */
interface CachedDeck {
    modified: number;
    bundle: DeckBundle;
}

export class StatsView extends ItemView {
    private plugin: SpaceforgePlugin;
    private range: StatsRange = '90d';
    private healthMetric: HealthMetric = 'interval';
    private selectedDayKey: string | null = null;
    private root: HTMLElement | null = null;
    private data: StatsViewData | null = null;
    private deckCache = new Map<string, CachedDeck>();
    private refreshTimer: number | null = null;
    private renderToken = 0;
    private resizeObserver: ResizeObserver | null = null;
    private lastWidth = 0;
    private readonly onSidebarUpdate = () => this.scheduleRefresh();
    private readonly onActiveLeafChange = (): void => {
        if (this.plugin.app.workspace.activeLeaf === this.leaf) void this.refresh();
    };

    constructor(leaf: WorkspaceLeaf, plugin: SpaceforgePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return STATS_VIEW; }
    getDisplayText(): string { return 'Spaceforge statistics'; }
    getIcon(): string { return 'trending-up'; }

    /** What Obsidian persists for the leaf: which window was being looked at. */
    getState(): Record<string, unknown> {
        return { range: this.range, healthMetric: this.healthMetric };
    }

    setState(state: unknown, _result: unknown): Promise<void> {
        const record = state as { range?: unknown; healthMetric?: unknown } | null;
        if (record && (record.range === '30d' || record.range === '90d' || record.range === '1y' || record.range === 'all')) {
            this.range = record.range;
        }
        if (record && (record.healthMetric === 'interval' || record.healthMetric === 'ease' || record.healthMetric === 'stability' || record.healthMetric === 'difficulty')) {
            this.healthMetric = record.healthMetric;
        }
        return Promise.resolve();
    }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('sf-stats-view-content');
        this.root = this.contentEl.createDiv('sf-stats');
        this.plugin.events.on('sidebar-update', this.onSidebarUpdate);
        this.plugin.app.workspace.on('active-leaf-change', this.onActiveLeafChange);
        this.watchResize();
        await this.refresh();
    }

    onClose(): Promise<void> {
        this.plugin.events.off('sidebar-update', this.onSidebarUpdate);
        this.plugin.app.workspace.off('active-leaf-change', this.onActiveLeafChange);
        if (this.refreshTimer !== null && typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
            window.clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        return Promise.resolve();
    }

    /**
     * Coalesce a burst of updates (a review run fires one per answer) into one
     * repaint a moment later. Without a window object — the test world — the
     * refresh happens immediately; there is nothing to coalesce for.
     */
    private scheduleRefresh(): void {
        if (this.refreshTimer !== null) return;
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
            void this.refresh();
            return;
        }
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            void this.refresh();
        }, 1200);
    }

    /** Re-read everything and repaint, if the leaf is still alive. */
    async refresh(): Promise<void> {
        const token = ++this.renderToken;
        const data = await this.gather();
        if (token !== this.renderToken) return; // a newer pass owns the page now
        this.data = data;
        this.paint();
    }

    private watchResize(): void {
        if (typeof ResizeObserver === 'undefined') return;
        this.resizeObserver = new ResizeObserver(() => {
            const width = measureWidth(this.contentEl, 0);
            if (width > 0 && Math.abs(width - this.lastWidth) > 16) {
                this.lastWidth = width;
                if (this.data) this.paint();
            }
        });
        this.resizeObserver.observe(this.contentEl);
    }

    /* ---------------------------------------------------------- gathering */

    private async gather(): Promise<StatsViewData> {
        const plugin = this.plugin;
        const stats = plugin.statsService;
        const now = Date.now();
        const todayStart = startOfUTCDay(now);
        const schedules = plugin.reviewScheduleService?.schedules ?? {};
        const history = plugin.reviewScheduleService?.history ?? [];
        const decks = await this.loadDecks();

        const activity = stats.activityByDay(this.range, now);
        const activityAll = this.range === 'all' ? activity : stats.activityByDay('all', now);
        const totals = stats.totalsForRange(this.range, now);

        const todayKey = dayKeyOfTimestamp(now);
        const todayActivity = activity.get(todayKey);
        const today = {
            notes: todayActivity?.notes ?? 0,
            decks: todayActivity?.decks ?? 0,
            skipped: todayActivity?.skipped ?? 0,
        };
        let weekTotal = 0;
        for (let i = 0; i < 7; i++) {
            const key = dayKeyOfTimestamp(todayStart - i * DAY_MS);
            const day = activityAll.get(key);
            weekTotal += (day?.notes ?? 0) + (day?.decks ?? 0);
        }

        // The heatmap is a consistency lens, not a range readout: it always
        // covers half a year, and the wide windows stretch it to a whole one.
        const heatmapSpan = this.range === '1y' || this.range === 'all' ? 365 : 182;
        const firstActiveKey = [...activityAll.keys()].sort()[0];
        const heatmapStart = heatmapSpan === 365 && firstActiveKey
            ? Math.max(todayStart - 370 * DAY_MS, timestampOfDayKey(firstActiveKey))
            : todayStart - (heatmapSpan - 1) * DAY_MS;
        const heatmapDays = eachDay(heatmapStart, todayStart).map(day => ({
            ...day,
            notes: activityAll.get(day.key)?.notes ?? 0,
            decks: activityAll.get(day.key)?.decks ?? 0,
        }));
        if (this.selectedDayKey && !heatmapDays.some(day => day.key === this.selectedDayKey)) {
            this.selectedDayKey = null;
        }

        const weekdays = new Array<number>(7).fill(0);
        for (const day of activity.values()) {
            const index = (new Date(day.timestamp).getUTCDay() + 6) % 7; // Monday first
            weekdays[index] += day.notes + day.decks;
        }

        const bundles = decks.map(entry => entry.bundle);
        const forecast = stats.forecast(schedules, bundles, 30, now);
        const retentionPeriods = RETENTION_PERIODS.map(period => ({
            label: period.label,
            summary: stats.retentionForDays(period.days, 'both', now),
        }));

        const attention = this.buildAttention(decks, history, now, todayStart);

        return {
            now,
            todayStart,
            decks,
            activity,
            heatmapDays,
            totals,
            today,
            weekAverage: Math.round((weekTotal / 7) * 10) / 10,
            streaks: stats.streaks(now),
            daysStudied: stats.daysStudied(this.range, now),
            forecast,
            retentionPeriods,
            mix: stats.gradeMixForRange(this.range, 'both', now),
            health: this.collectHealth(schedules, decks),
            attention: attention.slice(0, 8),
            attentionTotal: attention.length,
            deckRows: this.buildDeckRows(decks, stats, now),
            memory: this.memoryReadout(schedules, decks, now),
            tutor: stats.tutorSummary(now),
            quiz: stats.quizSummary(now),
            weekdays,
        };
    }

    /** The vault's decks, re-reading only the files that changed. */
    private async loadDecks(): Promise<DeckEntry[]> {
        const store = this.plugin.deckStore;
        if (!store) return [];
        let summaries: DeckSummary[];
        try {
            summaries = await store.listDecks();
        } catch {
            return [];
        }
        const entries: DeckEntry[] = [];
        for (const summary of summaries) {
            const cached = this.deckCache.get(summary.path);
            if (cached && cached.modified === summary.modified) {
                entries.push({ summary, bundle: cached.bundle });
                continue;
            }
            try {
                const bundle = await store.readDeck(summary.path);
                this.deckCache.set(summary.path, { modified: summary.modified, bundle });
                entries.push({ summary, bundle });
            } catch {
                // A deck that cannot be read is skipped, exactly as the
                // calendar skips it; the next pass will try again.
            }
        }
        return entries;
    }

    /** The snapshot histograms: interval, ease, stability, difficulty. */
    private collectHealth(
        schedules: Record<string, { interval?: number; ease?: number; scheduleCategory?: string; schedulingAlgorithm?: string; fsrsData?: { stability: number; difficulty: number } }>,
        decks: DeckEntry[]
    ): StatsViewData['health'] {
        const intervals: number[] = [];
        const eases: number[] = [];
        const stabilities: number[] = [];
        const difficulties: number[] = [];

        for (const schedule of Object.values(schedules)) {
            if ((schedule.interval ?? 0) >= 1 && schedule.scheduleCategory !== 'initial') intervals.push(schedule.interval as number);
            if (schedule.schedulingAlgorithm === 'sm2' && schedule.scheduleCategory !== 'initial' && (schedule.ease ?? 0) > 0) {
                eases.push(schedule.ease as number);
            }
            if (schedule.schedulingAlgorithm === 'fsrs' && schedule.fsrsData) {
                stabilities.push(schedule.fsrsData.stability);
                difficulties.push(schedule.fsrsData.difficulty);
            }
        }
        for (const { bundle } of decks) {
            const fsrs = bundle.deck.options.scheduler === DeckScheduler.Fsrs;
            for (const card of bundle.cards) {
                if (card.queue === AnkiCardQueue.Review && (card.interval ?? 0) >= 1) intervals.push(card.interval);
                if (fsrs) {
                    if (card.memory) {
                        stabilities.push(card.memory.stability);
                        difficulties.push(card.memory.difficulty);
                    }
                } else if (card.easeFactor > 0) {
                    eases.push(card.easeFactor);
                }
            }
        }

        const median = (values: number[]): number | null => {
            if (values.length === 0) return null;
            const sorted = [...values].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        };

        return {
            interval: { values: intervals, format: value => `${Math.round(value)}d`, median: median(intervals) },
            ease: { values: eases, format: value => `${Math.round(value / 10)}%`, median: median(eases) },
            stability: { values: stabilities, format: value => `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}d`, median: median(stabilities) },
            difficulty: { values: difficulties, format: value => `${Math.round(value * 10) / 10}`, median: median(difficulties) },
        };
    }

    /** Leeches and struggle: what a reader should look at next. */
    private buildAttention(
        decks: DeckEntry[],
        history: ReviewHistoryItem[],
        now: number,
        todayStart: number
    ): AttentionRow[] {
        const rows: AttentionRow[] = [];
        const since = now - 90 * DAY_MS;
        const againByPath = new Map<string, number>();
        for (const item of history) {
            if (item.isSkipped || item.timestamp < since) continue;
            if (gradeOfHistoryItem(item) === 'again') {
                againByPath.set(item.path, (againByPath.get(item.path) ?? 0) + 1);
            }
        }
        for (const schedule of Object.values(this.plugin.reviewScheduleService?.schedules ?? {})) {
            const lapses = schedule.fsrsData?.lapses ?? schedule.lapses ?? 0;
            const again = againByPath.get(schedule.path) ?? 0;
            if (lapses < 3 && again < 3) continue;
            const dueIn = Math.round((startOfUTCDay(schedule.nextReviewDate) - todayStart) / DAY_MS);
            const parts: string[] = [];
            if (lapses > 0) parts.push(`${lapses} lapse${lapses === 1 ? '' : 's'}`);
            if (again > 0) parts.push(`${again} again in 90d`);
            parts.push(dueIn <= 0 ? 'due now' : `due in ${dueIn}d`);
            rows.push({
                label: basename(schedule.path),
                meta: parts.join(' · '),
                path: schedule.path,
                weight: lapses * 2 + again,
                severe: lapses >= 8 || again >= 6,
            });
        }
        for (const { summary, bundle } of decks) {
            for (const note of bundle.notes) {
                const leeches = bundle.cards.filter(card => card.noteId === note.id && isLeech(card, bundle.deck.options));
                if (leeches.length === 0) continue;
                const text = note.values.find(value => value.trim().length > 0) ?? '';
                rows.push({
                    label: `${truncate(text, 56)} — ${summary.name}`,
                    meta: `${leeches.length} leech card${leeches.length === 1 ? '' : 's'}`,
                    path: summary.path,
                    weight: 6 + leeches.length,
                    severe: true,
                });
            }
        }
        return rows.sort((a, b) => b.weight - a.weight);
    }

    private buildDeckRows(decks: DeckEntry[], stats: StatsService, now: number): DeckRow[] {
        return decks.map(({ summary, bundle }) => {
            const created = bundle.extra?.crt;
            const dayBase = deckDayBase(bundle.deck.id, typeof created === 'number' ? created : null);
            const snapshot = deckSnapshot(bundle.cards, bundle.deck.options, now, dayBase);
            const retention = stats.deckRetention(summary.path, 30, now).all;
            const totals = stats.deckReviewTotals(summary.path, 30, now);
            return {
                name: summary.name,
                path: summary.path,
                due: snapshot.dueToday,
                newCount: snapshot.newCount,
                learningCount: snapshot.learningCount,
                reviewCount: snapshot.reviewCount,
                maturePct: snapshot.maturePct,
                retention: retention.pct,
                retentionAnswers: retention.answered,
                averageSeconds: totals.reviews > 0 && totals.timeMs > 0 ? Math.round((totals.timeMs / totals.reviews) / 100) / 10 : null,
            };
        });
    }

    /** FSRS's "estimated knowledge": how much of the material is recallable today. */
    private memoryReadout(
        schedules: Record<string, { schedulingAlgorithm?: string; fsrsData?: { stability: number; last_review?: number } }>,
        decks: DeckEntry[],
        now: number
    ): { pct: number | null; recallable: number; items: number } {
        let sum = 0;
        let items = 0;
        const add = (stability: number, lastReview: number | undefined): void => {
            if (!(stability > 0) || lastReview === undefined || !Number.isFinite(lastReview)) return;
            sum += retrievability(stability, (now - lastReview) / DAY_MS);
            items += 1;
        };
        for (const schedule of Object.values(schedules)) {
            if (schedule.schedulingAlgorithm === 'fsrs' && schedule.fsrsData) {
                add(schedule.fsrsData.stability, schedule.fsrsData.last_review);
            }
        }
        for (const { bundle } of decks) {
            if (bundle.deck.options.scheduler !== DeckScheduler.Fsrs) continue;
            for (const card of bundle.cards) {
                if (card.memory) add(card.memory.stability, card.memory.lastReview);
            }
        }
        if (items === 0) return { pct: null, recallable: 0, items: 0 };
        return {
            pct: Math.round((sum / items) * 1000) / 10,
            recallable: Math.round(sum * 10) / 10,
            items,
        };
    }

    /* ------------------------------------------------------------ painting */

    private paint(): void {
        const data = this.data;
        const root = this.root;
        if (!data || !root || !this.contentEl.isConnected) return;
        root.empty();

        // Which grid shape the cards take is decided from the measured width,
        // not a media query: the view lives in a pane whose width the window
        // knows nothing about.
        const width = measureWidth(root);
        root.removeClass('is-layout-narrow');
        root.removeClass('is-layout-mid');
        root.removeClass('is-layout-wide');
        root.addClass(width < 720 ? 'is-layout-narrow' : width < 1060 ? 'is-layout-mid' : 'is-layout-wide');

        this.paintHeader(root);
        const body = root.createDiv('sf-stats-body');

        if (this.isEmpty(data)) {
            body.createDiv({
                cls: 'sf-stats-empty-state',
                text: 'Nothing to chart yet. Add notes to the review schedule or import an Anki deck — this page fills in as you study.',
            });
            return;
        }

        this.paintTiles(body, data);
        const grid = body.createDiv('sf-stats-grid');
        this.paintActivityCard(grid, data);
        this.paintDetailsCard(grid, data);
        this.paintForecastCard(grid, data);
        this.paintRetentionCard(grid, data);
        this.paintGradesCard(grid, data);
        this.paintHealthCard(grid, data);
        if (data.deckRows.length > 0) this.paintDecksCard(grid, data);
        if (data.attention.length > 0) this.paintAttentionCard(grid, data);
        if (data.tutor.objectives.total > 0 || data.tutor.sessionsLast30 > 0 || data.quiz.sessionsLast30 > 0) {
            this.paintStudyCard(grid, data);
        }
    }

    private isEmpty(data: StatsViewData): boolean {
        const hasSchedules = Object.keys(this.plugin.reviewScheduleService?.schedules ?? {}).length > 0;
        const hasAnyActivity = Object.keys(this.plugin.statsService.reviewDayStats ?? {}).length > 0;
        return !hasSchedules
            && data.decks.length === 0
            && !hasAnyActivity
            && data.tutor.objectives.total === 0;
    }

    private paintHeader(root: HTMLElement): void {
        const header = root.createDiv('sf-stats-header');
        const texts = header.createDiv('sf-stats-header-text');
        texts.createDiv({ cls: 'sf-stats-title', text: 'Statistics' });
        texts.createDiv({ cls: 'sf-stats-subtitle', text: 'How the studying is going, from the vault\u2019s own records' });

        const ranges = header.createDiv('sf-stats-ranges');
        for (const key of Object.keys(STATS_RANGE_LABELS) as StatsRange[]) {
            const button = ranges.createDiv({
                cls: `sf-stats-range-btn${key === this.range ? ' is-active' : ''}`,
                text: STATS_RANGE_LABELS[key],
            });
            button.addEventListener('click', () => {
                if (this.range === key) return;
                this.range = key;
                this.selectedDayKey = null;
                void this.refresh();
            });
        }
    }

    private tile(parent: HTMLElement, label: string, value: string, sub: string, tone?: 'is-good' | 'is-warn'): void {
        const tile = parent.createDiv(`sf-stats-tile${tone ? ` ${tone}` : ''}`);
        tile.createDiv({ cls: 'sf-stats-tile-value', text: value });
        tile.createDiv({ cls: 'sf-stats-tile-label', text: label });
        tile.createDiv({ cls: 'sf-stats-tile-sub', text: sub });
    }

    private paintTiles(body: HTMLElement, data: StatsViewData): void {
        const tiles = body.createDiv('sf-stats-tiles');
        const todayTotal = data.today.notes + data.today.decks;
        this.tile(tiles, 'Reviews today', String(todayTotal), `7-day average ${data.weekAverage}/day`);

        this.tile(
            tiles,
            'Streak',
            formatStreak(data.streaks.current),
            `best ${formatStreak(data.streaks.best)}`,
            data.streaks.current >= 7 ? 'is-good' : undefined
        );

        const retention = data.retentionPeriods.find(period => period.label === '30 days')?.summary.all;
        const retentionPct = retention?.pct ?? null;
        this.tile(
            tiles,
            'Retention (30 d)',
            retentionPct === null ? '—' : `${retentionPct}%`,
            retention && retention.answered > 0 ? `${retention.passed} of ${retention.answered} recalled` : 'no scheduled reviews yet',
            retentionPct === null ? undefined : retentionPct >= 90 ? 'is-good' : retentionPct < 75 ? 'is-warn' : undefined
        );

        this.tile(
            tiles,
            'Due today',
            String(data.forecast.dueToday),
            data.forecast.overdue > 0 ? `${data.forecast.overdue} overdue, waiting` : `due tomorrow ${data.forecast.dueTomorrow}`,
            data.forecast.overdue > 0 ? 'is-warn' : undefined
        );

        this.tile(
            tiles,
            'Days studied',
            data.daysStudied.pct === null ? '—' : `${data.daysStudied.pct}%`,
            `${data.daysStudied.active} of ${data.daysStudied.total} days in ${STATS_RANGE_LABELS[this.range].toLowerCase()}`
        );

        this.tile(
            tiles,
            'Memory now',
            data.memory.pct === null ? '—' : `${data.memory.pct}%`,
            data.memory.items > 0
                ? `≈${Math.round(data.memory.recallable)} of ${data.memory.items} items recallable`
                : 'FSRS is not in use yet',
            data.memory.pct === null ? undefined : data.memory.pct >= 90 ? 'is-good' : data.memory.pct < 70 ? 'is-warn' : undefined
        );
    }

    private card(grid: HTMLElement, title: string, options: { span: 4 | 5 | 7 | 8 | 12; hint?: string; cls?: string }): { card: HTMLElement; body: HTMLElement } {
        const card = grid.createDiv(`sf-stats-card is-span-${options.span}${options.cls ? ` ${options.cls}` : ''}`);
        const head = card.createDiv('sf-stats-card-head');
        head.createDiv({ cls: 'sf-stats-card-title', text: title });
        if (options.hint) head.createDiv({ cls: 'sf-stats-card-hint', text: options.hint });
        return { card, body: card.createDiv('sf-stats-card-body') };
    }

    /* ------------------------------------------------------------ activity */

    private paintActivityCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Activity', { span: 7, hint: 'reviews per day', cls: 'sf-stats-activity-card' });
        const chart = body.createDiv('sf-stats-chart');
        this.renderHeatmapInto(chart, data);

        const totals = data.totals.notes + data.totals.decks;
        body.createDiv({
            cls: 'sf-stats-note',
            text: `${totals} reviews in ${STATS_RANGE_LABELS[this.range].toLowerCase()} · `
                + `${data.daysStudied.active} days studied`
                + (data.totals.skipped > 0 ? ` · ${data.totals.skipped} skipped` : ''),
        });
    }

    private renderHeatmapInto(chart: HTMLElement, data: StatsViewData): void {
        renderHeatmap(chart, {
            days: data.heatmapDays,
            width: measureWidth(chart),
            selectedKey: this.selectedDayKey,
            todayKey: dayKeyOfTimestamp(data.now),
            onSelect: day => {
                this.selectedDayKey = day.key;
                this.repaintActivity();
            },
        });
        attachChartTips(chart);
    }

    /** Repaint the heatmap and the details card when a day is picked. */
    private repaintActivity(): void {
        const data = this.data;
        if (!data) return;
        // Simple selectors only, each step from the element before it: the
        // tests' miniature DOM matches one simple selector at a time.
        const activityCard = this.root?.querySelector('.sf-stats-activity-card');
        const chart = activityCard?.querySelector('.sf-stats-chart');
        if (chart) this.renderHeatmapInto(chart as HTMLElement, data);
        const detailsCard = this.root?.querySelector('.sf-stats-details-card');
        const detailsBody = detailsCard?.querySelector('.sf-stats-card-body');
        if (detailsBody) this.paintDetailsBody(detailsBody as HTMLElement, data);
    }

    /* ------------------------------------------------------------- details */

    private paintDetailsCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Details', { span: 5, hint: this.selectedDayKey ? 'day breakdown' : 'weekday rhythm', cls: 'sf-stats-details-card' });
        this.paintDetailsBody(body, data);
    }

    private paintDetailsBody(body: HTMLElement, data: StatsViewData): void {
        body.empty();
        if (this.selectedDayKey) {
            this.paintDayBreakdown(body, data, this.selectedDayKey);
            return;
        }
        this.paintWeekdays(body, data);
    }

    /** The weekday rhythm: which days of the week carry the studying. */
    private paintWeekdays(body: HTMLElement, data: StatsViewData): void {
        const total = data.weekdays.reduce((sum, count) => sum + count, 0);
        body.createDiv({
            cls: 'sf-stats-note',
            text: total > 0 ? `${total} reviews in ${STATS_RANGE_LABELS[this.range].toLowerCase()}` : 'No reviews in this period yet.',
        });
        if (total === 0) return;
        const max = Math.max(...data.weekdays, 1);
        for (let index = 0; index < 7; index++) {
            const count = data.weekdays[index];
            const row = body.createDiv('sf-stats-weekday-row');
            row.createSpan({ cls: 'sf-stats-weekday-label', text: WEEKDAY_LABELS[index] });
            const bar = row.createDiv('sf-stats-weekday-bar');
            const fill = bar.createDiv({ cls: 'sf-stats-weekday-fill' });
            fill.setCssProps({ '--sf-stats-bar-width': `${Math.round((count / max) * 100)}%` });
            row.createSpan({ cls: 'sf-stats-weekday-count', text: String(count) });
        }
        body.createDiv({ cls: 'sf-stats-note', text: 'Click a day on the heatmap for its breakdown.' });
    }

    /** One day's full breakdown, reached by clicking a heatmap cell. */
    private paintDayBreakdown(body: HTMLElement, data: StatsViewData, key: string): void {
        const head = body.createDiv('sf-stats-day-head');
        head.createDiv({ cls: 'sf-stats-day-date', text: formatDayKey(key) });
        const clear = head.createDiv({ cls: 'sf-stats-link', text: 'Weekdays' });
        clear.setAttribute('role', 'button');
        clear.addEventListener('click', () => {
            this.selectedDayKey = null;
            this.repaintActivity();
        });

        const day = this.plugin.statsService.reviewDayStats[key];
        if (!day) {
            body.createDiv({ cls: 'sf-stats-empty', text: 'No reviews on that day.' });
            return;
        }
        const notes = addGrades(day.notes?.learning ?? empty(), day.notes?.young ?? empty(), day.notes?.mature ?? empty());
        const decks = addGrades(day.decks?.learning ?? empty(), day.decks?.young ?? empty(), day.decks?.mature ?? empty());
        const notesTotal = gradeTotal(notes);
        const decksTotal = gradeTotal(decks);
        const skipped = (day.notes?.skipped ?? 0) + (day.decks?.skipped ?? 0);
        body.createDiv({
            cls: 'sf-stats-day-total',
            text: `${notesTotal + decksTotal} review${notesTotal + decksTotal === 1 ? '' : 's'} · ${notesTotal} notes · ${decksTotal} deck cards`
                + (skipped > 0 ? ` · ${skipped} skipped` : ''),
        });
        const combined = addGrades(notes, decks);
        if (gradeTotal(combined) > 0) {
            this.paintGradeRows(body, combined);
        }
    }

    /* ------------------------------------------------------------ forecast */

    private paintForecastCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Next 30 days', { span: 7, hint: 'due per day' });
        const chart = body.createDiv('sf-stats-chart');
        renderForecastBars(chart, { days: data.forecast.days, width: measureWidth(chart) });
        attachChartTips(chart);
        const forecast = data.forecast;
        body.createDiv({
            cls: 'sf-stats-note',
            text: `${forecast.dueTomorrow} due tomorrow · avg ${forecast.averagePerDay}/day · load ≈${Math.round(forecast.dailyLoad)}`
                + (forecast.newAvailable > 0 ? ` · ${forecast.newAvailable} new card${forecast.newAvailable === 1 ? '' : 's'} waiting` : '')
                + (forecast.overdue > 0 ? ` · ${forecast.overdue} overdue` : ''),
        });
    }

    /* ----------------------------------------------------------- retention */

    private paintRetentionCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Retention', { span: 5, hint: 'recalled, by maturity' });
        const table = body.createEl('table', { cls: 'sf-stats-table' });
        const head = table.createTHead();
        const headRow = head.insertRow();
        headRow.createEl('td');
        for (const period of data.retentionPeriods) headRow.createEl('td', { text: period.label });

        const rows: Array<{ label: string; pick: (summary: RetentionSummary) => RetentionSummary[keyof RetentionSummary] }> = [
            { label: 'Learning', pick: summary => summary.learning },
            { label: 'Young', pick: summary => summary.young },
            { label: 'Mature', pick: summary => summary.mature },
            { label: 'All reviews', pick: summary => summary.all },
        ];
        const bodyEl = table.createTBody();
        for (const row of rows) {
            const rowEl = bodyEl.insertRow();
            rowEl.createEl('td', { text: row.label });
            for (const period of data.retentionPeriods) {
                const bucket = row.pick(period.summary);
                const cell = rowEl.createEl('td');
                if (bucket.pct === null) {
                    cell.createSpan({ cls: 'sf-stats-muted', text: '—' });
                } else {
                    const tone = bucket.pct >= 90 ? ' is-good' : bucket.pct < 75 ? ' is-low' : '';
                    cell.createSpan({ cls: `sf-stats-pct${tone}`, text: `${bucket.pct}%` });
                    cell.createSpan({ cls: 'sf-stats-count', text: String(bucket.answered) });
                }
            }
        }
        body.createDiv({
            cls: 'sf-stats-note',
            text: 'True retention counts only reviews scheduled a day or more out; steps are shown on their own. Again is the only failure, as in FSRS.',
        });
    }

    /* -------------------------------------------------------------- grades */

    /** The four answer buttons, as rows: name, bar, count and share. */
    private paintGradeRows(body: HTMLElement, counts: GradeCounts): void {
        const total = gradeTotal(counts);
        const max = Math.max(counts.again, counts.hard, counts.good, counts.easy, 1);
        const list = body.createDiv('sf-stats-grades');
        for (const grade of GRADE_ORDER) {
            const row = list.createDiv('sf-stats-grade-row');
            row.createDiv({ cls: `sf-stats-grade-name is-${grade}`, text: GRADE_LABELS[grade] });
            const bar = row.createDiv('sf-stats-grade-bar');
            const fill = bar.createDiv({ cls: `sf-stats-grade-fill is-${grade}` });
            fill.setCssProps({ '--sf-stats-bar-width': `${Math.round((counts[grade] / max) * 100)}%` });
            row.createDiv({
                cls: 'sf-stats-grade-count',
                text: total > 0 ? `${counts[grade]} · ${Math.round((counts[grade] / total) * 100)}%` : '0 · 0%',
            });
        }
    }

    private paintGradesCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Answer buttons', { span: 4, hint: STATS_RANGE_LABELS[this.range].toLowerCase() });
        const combined = addGrades(data.mix.learning, data.mix.young, data.mix.mature);
        this.paintGradeRows(body, combined);
        const againRates = (['learning', 'young', 'mature'] as const)
            .map(bucket => {
                const counts = data.mix[bucket];
                const answered = gradeTotal(counts);
                return answered > 0 ? `${bucket} ${Math.round((counts.again / answered) * 100)}%` : null;
            })
            .filter((entry): entry is string => entry !== null);
        body.createDiv({
            cls: 'sf-stats-note',
            text: againRates.length > 0 ? `Again rate: ${againRates.join(' · ')}` : 'No answers in this period yet.',
        });
    }

    /* -------------------------------------------------------------- health */

    private paintHealthCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Collection health', { span: 4, hint: 'scheduled cards' });
        const segment = body.createDiv('sf-stats-seg');
        for (const metric of HEALTH_METRICS) {
            const button = segment.createDiv({
                cls: `sf-stats-seg-btn${this.healthMetric === metric.key ? ' is-active' : ''}`,
                text: metric.label,
            });
            button.addEventListener('click', () => {
                this.healthMetric = metric.key;
                const buttons = segment.querySelectorAll('.sf-stats-seg-btn');
                buttons.forEach((node, index) => {
                    const el = node as HTMLElement;
                    if (HEALTH_METRICS[index]?.key === this.healthMetric) el.addClass('is-active');
                    else el.removeClass('is-active');
                });
                const healthBody = body.querySelector('.sf-stats-health-body');
                if (healthBody) this.paintHealthInto(healthBody as HTMLElement, data);
            });
        }
        const healthBody = body.createDiv('sf-stats-health-body');
        this.paintHealthInto(healthBody, data);

        const noteLines: string[] = [];
        const notes = Object.values(this.plugin.reviewScheduleService?.schedules ?? {});
        if (notes.length > 0) {
            let learning = 0;
            let young = 0;
            let mature = 0;
            for (const schedule of notes) {
                if (schedule.scheduleCategory === 'initial' || (schedule.interval ?? 0) < 1) learning += 1;
                else if ((schedule.interval ?? 0) >= 21) mature += 1;
                else young += 1;
            }
            noteLines.push(`notes ${learning}·${young}·${mature}`);
        }
        if (data.deckRows.length > 0) {
            const newCount = data.deckRows.reduce((sum, row) => sum + row.newCount, 0);
            const learning = data.deckRows.reduce((sum, row) => sum + row.learningCount, 0);
            const review = data.deckRows.reduce((sum, row) => sum + row.reviewCount, 0);
            noteLines.push(`decks ${newCount} new · ${learning} learning · ${review} review`);
        }
        if (noteLines.length > 0) body.createDiv({ cls: 'sf-stats-note', text: `learning · young · mature — ${noteLines.join('   ·   ')}` });
    }

    private paintHealthInto(host: HTMLElement, data: StatsViewData): void {
        const metric = data.health[this.healthMetric];
        host.empty();
        host.createDiv({
            cls: 'sf-stats-note',
            text: metric.values.length > 0
                ? `${metric.values.length} item${metric.values.length === 1 ? '' : 's'} · median ${metric.median === null ? '—' : metric.format(metric.median)}`
                : 'Nothing to plot for this metric yet.',
        });
        const chart = host.createDiv('sf-stats-chart');
        const cap = this.healthMetric === 'interval' ? dayHistogramCap(metric.values) : undefined;
        renderHistogram(chart, { values: metric.values, width: measureWidth(chart), format: metric.format, cap });
        attachChartTips(chart);
    }

    /* --------------------------------------------------------------- decks */

    private paintDecksCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Decks', { span: 4, hint: 'Anki cards' });
        const list = body.createDiv('sf-stats-decks');
        for (const row of data.deckRows) {
            const item = list.createDiv('sf-stats-deck-row');
            const name = item.createDiv({ cls: 'sf-stats-deck-name', text: row.name });
            name.addEventListener('click', () => {
                void this.plugin.app.workspace.openLinkText(row.path, '', false);
            });
            const stats = item.createDiv('sf-stats-deck-stats');
            stats.createSpan({ cls: row.due > 0 ? 'sf-stats-deck-due is-due' : 'sf-stats-deck-due', text: `${row.due} due` });
            stats.createSpan({ text: `${row.newCount} new` });
            stats.createSpan({ text: `${row.learningCount} learning` });
            stats.createSpan({ text: `${row.reviewCount} review` });
            stats.createSpan({ text: row.maturePct === null ? '— mature' : `${row.maturePct}% mature` });
            stats.createSpan({
                text: row.retention === null
                    ? 'ret —'
                    : `ret ${row.retention}%${row.retentionAnswers > 0 ? ` (${row.retentionAnswers})` : ''}`,
            });
            if (row.averageSeconds !== null) stats.createSpan({ text: `${row.averageSeconds}s/card` });
        }
        body.createDiv({ cls: 'sf-stats-note', text: 'Retention reads the deck review log; it starts with the first card answered here. Mature = 21 days or more.' });
    }

    /* ----------------------------------------------------------- attention */

    private paintAttentionCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Needs attention', { span: 5, hint: 'leeches and struggle' });
        const list = body.createDiv('sf-stats-attention');
        for (const row of data.attention) {
            const item = list.createDiv(`sf-stats-attention-row${row.severe ? ' is-severe' : ' is-warn'}`);
            item.createDiv({ cls: 'sf-stats-attention-label', text: row.label });
            item.createDiv({ cls: 'sf-stats-attention-meta', text: row.meta });
            item.addEventListener('click', () => {
                void this.plugin.app.workspace.openLinkText(row.path, '', false);
            });
        }
        if (data.attentionTotal > data.attention.length) {
            body.createDiv({
                cls: 'sf-stats-note',
                text: `+${data.attentionTotal - data.attention.length} more below the fold`,
            });
        }
    }

    /* --------------------------------------------------------------- study */

    private paintStudyCard(grid: HTMLElement, data: StatsViewData): void {
        const { body } = this.card(grid, 'Study', { span: 7, hint: 'tutor & quizzes' });
        const blocks = body.createDiv('sf-stats-study');

        const tutor = data.tutor;
        if (tutor.objectives.total > 0 || tutor.sessionsLast30 > 0) {
            const block = blocks.createDiv('sf-stats-study-block');
            block.createDiv({ cls: 'sf-stats-block-title', text: 'Tutor' });
            if (tutor.objectives.total > 0) {
                const bar = block.createDiv('sf-stats-segbar');
                const parts: Array<{ cls: string; count: number }> = [
                    { cls: 'is-mastered', count: tutor.objectives.mastered },
                    { cls: 'is-stable', count: tutor.objectives.stable },
                    { cls: 'is-fragile', count: tutor.objectives.fragile },
                    { cls: 'is-learning', count: tutor.objectives.learning },
                    { cls: 'is-unseen', count: tutor.objectives.unseen },
                ];
                for (const part of parts) {
                    if (part.count === 0) continue;
                    const segment = bar.createDiv({ cls: `sf-stats-segbar-part ${part.cls}` });
                    segment.setCssProps({ '--sf-stats-share': String(part.count) });
                }
                const legend = block.createDiv('sf-stats-legend');
                for (const [label, count] of [
                    ['Mastered', tutor.objectives.mastered],
                    ['Stable', tutor.objectives.stable],
                    ['Fragile', tutor.objectives.fragile],
                    ['Learning', tutor.objectives.learning],
                    ['Unseen', tutor.objectives.unseen],
                ] as const) {
                    if (count === 0) continue;
                    legend.createSpan({ cls: 'sf-stats-legend-item', text: `${label} ${count}` });
                }
            }
            const lines: string[] = [];
            lines.push(tutor.objectives.due > 0 ? `${tutor.objectives.due} objective${tutor.objectives.due === 1 ? '' : 's'} due` : 'nothing due');
            if (tutor.sessionsLast30 > 0) lines.push(`${tutor.sessionsLast30} sessions · ${tutor.minutesLast30} min (30d)`);
            if (tutor.averageScoreLast30 !== null) lines.push(`avg score ${Math.round(tutor.averageScoreLast30 * 100)}%`);
            block.createDiv({ cls: 'sf-stats-note', text: lines.join(' · ') });
            if (tutor.topErrors.length > 0) {
                const chips = block.createDiv('sf-stats-chips');
                for (const error of tutor.topErrors) {
                    chips.createSpan({ cls: 'sf-stats-chip', text: `${error.category.replace(/_/g, ' ')} ${error.count}` });
                }
            }
        }

        const quiz = data.quiz;
        if (quiz.sessionsLast30 > 0) {
            const block = blocks.createDiv('sf-stats-study-block');
            block.createDiv({ cls: 'sf-stats-block-title', text: 'Quizzes' });
            const lines: string[] = [`${quiz.questionsLast30} questions · ${quiz.sessionsLast30} session${quiz.sessionsLast30 === 1 ? '' : 's'}`];
            if (quiz.accuracyLast30 !== null) lines.push(`${quiz.accuracyLast30}% correct`);
            if (quiz.averageSecondsPerQuestion !== null) lines.push(`${quiz.averageSecondsPerQuestion}s per question`);
            block.createDiv({ cls: 'sf-stats-note', text: lines.join(' · ') });
        }
    }
}

/* ---------------------------------------------------------------- helpers */

function basename(path: string): string {
    const name = path.split('/').pop() ?? path;
    return name.replace(/\.md$/i, '');
}

function truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function gradeTotal(counts: GradeCounts): number {
    return counts.again + counts.hard + counts.good + counts.easy;
}

function addGrades(...counts: GradeCounts[]): GradeCounts {
    const total: GradeCounts = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const entry of counts) {
        total.again += entry.again;
        total.hard += entry.hard;
        total.good += entry.good;
        total.easy += entry.easy;
    }
    return total;
}

function empty(): GradeCounts {
    return { again: 0, hard: 0, good: 0, easy: 0 };
}
