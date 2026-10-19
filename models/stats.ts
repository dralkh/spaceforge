/**
 * Progress analytics: the shapes the statistics screen reads, and the pure
 * arithmetic behind every figure it shows.
 *
 * Two rules shape this file:
 *
 * - everything here is pure. Day buckets, retention, streaks and forecast are
 *   computed from plain data so they can be tested without a vault, an editor
 *   or a clock;
 * - the past is read from permanent day aggregates, not from the review log.
 *   The log is capped (the newest 1000 note reviews stay in `data.json`), so a
 *   figure like "reviews per day for a year" cannot come from it. Each recorded
 *   review is folded into a per-day counter instead (see `LaneDayStats`), which
 *   never expires and costs a few numbers per day studied.
 *
 * A review is classified on two axes, both matching Anki's statistics:
 *
 * - maturity: `learning` (steps inside the day), `young` (scheduled under 21
 *   days) and `mature` (21 days and over);
 * - the four answer buttons: again, hard, good, easy. A grade below `again` is
 *   the only failure; that is how FSRS counts `Hard` as a pass and SM-2 counts
 *   grades 0-2 as a lapse.
 *
 * Sessions are bucketed by the *UTC* day they happened on, like the rest of
 * the plugin's scheduling.
 */
import { AnkiGrade } from './anki';
import { FsrsRating, ReviewHistoryItem } from './review-schedule';

/** Which lane of the plugin a figure describes. */
export type ReviewLane = 'notes' | 'decks';

/** The four answer buttons, after either algorithm's grades are folded in. */
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

/** Which memory population a review fell into, judged at answer time. */
export type ReviewBucket = 'learning' | 'young' | 'mature';

/** Which scheduler ran the review that the entry was written for. */
export type HistoryScheduler = 'initial' | 'sm2' | 'fsrs';

/** The windows the statistics screen can show. */
export type StatsRange = '30d' | '90d' | '1y' | 'all';

/** How many days each fixed range covers. `all` has no bound. */
export const STATS_RANGE_DAYS: Record<Exclude<StatsRange, 'all'>, number> = {
    '30d': 30,
    '90d': 90,
    '1y': 365,
};

/** Human labels, for the range selector. */
export const STATS_RANGE_LABELS: Record<StatsRange, string> = {
    '30d': '1 month',
    '90d': '3 months',
    '1y': '1 year',
    'all': 'All',
};

/** Anki's maturity line between young and mature reviews. */
export const MATURE_INTERVAL_DAYS = 21;

export const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ shapes */

export interface GradeCounts {
    again: number;
    hard: number;
    good: number;
    easy: number;
}

/** One lane's reviews on one UTC day, split by maturity bucket. */
export interface LaneDayStats {
    learning: GradeCounts;
    young: GradeCounts;
    mature: GradeCounts;
    /** Reviews the reader skipped; they count as activity but never as answers. */
    skipped: number;
}

/** One UTC day, with a bucket per lane. */
export interface DayReviewStats {
    notes?: LaneDayStats;
    decks?: LaneDayStats;
}

/**
 * One deck answer, in the shape of Anki's revlog row.
 *
 * `priorInterval` and `nextInterval` follow Anki's sign convention: days for
 * scheduled intervals, negative seconds for the steps inside the day.
 */
export interface DeckReviewLogItem {
    deckPath: string;
    cardId: string;
    /** Exact ms of the answer. */
    timestamp: number;
    grade: AnkiGrade;
    priorInterval: number;
    nextInterval: number;
    /** Ease factor in permille, when the scheduler kept one. */
    factor: number | null;
    /** Answer time in ms, capped the way Anki caps it (60 s). */
    timeMs: number | null;
    kind: 'learn' | 'relearn' | 'review';
    /** Set when the answer made the card a leech. */
    leeched?: boolean;
    stability?: number | null;
    difficulty?: number | null;
}

/** One day of activity, as the charts read it. */
export interface DayActivity {
    key: string;
    timestamp: number;
    notes: number;
    decks: number;
    skipped: number;
}

export interface Streaks {
    /** Days in a row up to today (or yesterday, while today is still young). */
    current: number;
    /** The longest run ever recorded in the aggregates. */
    best: number;
}

export interface RangeTotals {
    notes: number;
    decks: number;
    skipped: number;
}

/** Pass/fail over one population, as the retention table shows it. */
export interface RetentionBucket {
    answered: number;
    passed: number;
    /** `null` when nothing was answered in the window. */
    pct: number | null;
}

export interface RetentionSummary {
    learning: RetentionBucket;
    young: RetentionBucket;
    mature: RetentionBucket;
    /** Young and mature together; steps inside the day are excluded. */
    all: RetentionBucket;
}

export interface GradeMix {
    learning: GradeCounts;
    young: GradeCounts;
    mature: GradeCounts;
}

/* ----------------------------------------------------------- small helpers */

export function emptyGradeCounts(): GradeCounts {
    return { again: 0, hard: 0, good: 0, easy: 0 };
}

export function emptyLaneDayStats(): LaneDayStats {
    return { learning: emptyGradeCounts(), young: emptyGradeCounts(), mature: emptyGradeCounts(), skipped: 0 };
}

export function gradeCountsOf(counts: GradeCounts): number {
    return counts.again + counts.hard + counts.good + counts.easy;
}

export function addGrade(counts: GradeCounts, grade: ReviewGrade): void {
    counts[grade] += 1;
}

/** Take one grade back out, never going below zero (undo, or a repaired file). */
export function removeGrade(counts: GradeCounts, grade: ReviewGrade): void {
    if (counts[grade] > 0) counts[grade] -= 1;
}

export function addToLane(lane: LaneDayStats, bucket: ReviewBucket, grade: ReviewGrade): void {
    addGrade(lane[bucket], grade);
}

export function removeFromLane(lane: LaneDayStats, bucket: ReviewBucket, grade: ReviewGrade): void {
    removeGrade(lane[bucket], grade);
}

/* ------------------------------------------------------------- day keys */

/** The UTC day key (`YYYY-MM-DD`) a moment belongs to. */
export function dayKeyOfTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

/** The UTC midnight that starts the day of `timestamp`. */
export function startOfUTCDay(timestamp: number): number {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The midnight that starts the day `key` names. */
export function timestampOfDayKey(key: string): number {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, (month ?? 1) - 1, day ?? 1);
}

/* ------------------------------------------------------ classification */

/**
 * Which scheduler wrote a history entry.
 *
 * New entries say so. Old ones are read from their ease value: FSRS stores
 * `round(difficulty * 10)` (10-100) where SM-2 stores permille (130 and up),
 * so the two ranges do not overlap. A note still walking its initial steps is
 * marked `initial` by new entries; old ones cannot be told from SM-2 and are
 * treated as SM-2, which schedules them the same way.
 */
export function schedulerOfHistoryItem(item: ReviewHistoryItem): HistoryScheduler {
    if (item.scheduler === 'initial' || item.scheduler === 'sm2' || item.scheduler === 'fsrs') {
        return item.scheduler;
    }
    return typeof item.ease === 'number' && item.ease > 0 && item.ease <= 100 ? 'fsrs' : 'sm2';
}

/** Which maturity bucket the pre-review interval puts an answer in. */
export function bucketOfInterval(intervalDays: number, scheduler: HistoryScheduler): ReviewBucket {
    if (scheduler === 'initial') return 'learning';
    if (!(intervalDays >= 1)) return 'learning';
    return intervalDays >= MATURE_INTERVAL_DAYS ? 'mature' : 'young';
}

export function bucketOfHistoryItem(item: ReviewHistoryItem): ReviewBucket {
    return bucketOfInterval(item.interval ?? 0, schedulerOfHistoryItem(item));
}

/** The answer button an SM-2 grade (0-5) corresponds to. */
export function gradeOfSm2Quality(quality: number): ReviewGrade {
    if (quality >= 5) return 'easy';
    if (quality >= 4) return 'good';
    if (quality >= 3) return 'hard';
    return 'again';
}

/** The answer button an FSRS rating (1-4) corresponds to. */
export function gradeOfFsrsRating(rating: number): ReviewGrade {
    if (rating >= FsrsRating.Easy) return 'easy';
    if (rating >= FsrsRating.Good) return 'good';
    if (rating >= FsrsRating.Hard) return 'hard';
    return 'again';
}

/** The answer button an Anki deck grade (1-4) corresponds to. */
export function gradeOfAnkiGrade(grade: AnkiGrade): ReviewGrade {
    return gradeOfFsrsRating(grade);
}

/**
 * The button a history entry represents: the stored grade when the entry has
 * one, otherwise the legacy translation of its response through its scheduler.
 */
export function gradeOfHistoryItem(item: ReviewHistoryItem): ReviewGrade {
    if (item.grade === 'again' || item.grade === 'hard' || item.grade === 'good' || item.grade === 'easy') {
        return item.grade;
    }
    if (schedulerOfHistoryItem(item) === 'fsrs') {
        return gradeOfFsrsRating(item.response ?? FsrsRating.Again);
    }
    return gradeOfSm2Quality(item.response ?? 0);
}

/** Fold a note review into its day bucket. Skipped reviews count as activity only. */
export function addHistoryItemToDay(day: DayReviewStats, item: ReviewHistoryItem): void {
    const lane = (day.notes ??= emptyLaneDayStats());
    if (item.isSkipped) {
        lane.skipped += 1;
        return;
    }
    addToLane(lane, bucketOfHistoryItem(item), gradeOfHistoryItem(item));
}

/** Take a note review back out of its day bucket (undo, or a file edited by hand). */
export function removeHistoryItemFromDay(day: DayReviewStats | undefined, item: ReviewHistoryItem): void {
    const lane = day?.notes;
    if (!lane) return;
    if (item.isSkipped) {
        if (lane.skipped > 0) lane.skipped -= 1;
        return;
    }
    removeFromLane(lane, bucketOfHistoryItem(item), gradeOfHistoryItem(item));
}

/* -------------------------------------------------------- deck answers */

/** Anki's sign convention for a card interval: days, negative while learning. */
export function deckIntervalDays(interval: number): number {
    return interval < 0 ? interval / 86400 : interval;
}

/** Which revlog kind an answer is; learning steps and relearning steps differ. */
export function deckAnswerKind(reason: 'new' | 'learning' | 'relearning' | 'review' | 'lapse' | 'early'): DeckReviewLogItem['kind'] {
    switch (reason) {
        case 'new':
        case 'learning':
            return 'learn';
        case 'relearning':
        case 'lapse':
            return 'relearn';
        default:
            return 'review';
    }
}

/** Which maturity bucket a deck answer belongs to, judged before the answer. */
export function bucketOfDeckAnswer(priorInterval: number, kind: DeckReviewLogItem['kind']): ReviewBucket {
    if (kind !== 'review') return 'learning';
    return bucketOfInterval(deckIntervalDays(priorInterval), 'sm2');
}

/** Fold a deck answer into its day bucket. */
export function addDeckReviewToDay(day: DayReviewStats, item: DeckReviewLogItem): void {
    const lane = (day.decks ??= emptyLaneDayStats());
    addToLane(lane, bucketOfDeckAnswer(item.priorInterval, item.kind), gradeOfAnkiGrade(item.grade));
}

/* ----------------------------------------------------------- aggregation */

const VALID_GRADES: ReviewGrade[] = ['again', 'hard', 'good', 'easy'];
const VALID_BUCKETS: ReviewBucket[] = ['learning', 'young', 'mature'];

/**
 * Read a stored lane back into a known-good shape.
 *
 * The data file is user property: it can be hand-edited or come from a version
 * that counted things differently. Unknown numbers become zero, missing
 * buckets are filled in, and nothing is thrown away that a chart could have
 * used.
 */
export function normalizeLaneDayStats(raw: unknown): LaneDayStats {
    const lane = emptyLaneDayStats();
    if (!raw || typeof raw !== 'object') return lane;
    const record = raw as Record<string, unknown>;
    for (const bucket of VALID_BUCKETS) {
        const counts = record[bucket];
        if (!counts || typeof counts !== 'object') continue;
        for (const grade of VALID_GRADES) {
            const value = (counts as Record<string, unknown>)[grade];
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                lane[bucket][grade] = Math.floor(value);
            }
        }
    }
    const skipped = record.skipped;
    if (typeof skipped === 'number' && Number.isFinite(skipped) && skipped > 0) {
        lane.skipped = Math.floor(skipped);
    }
    return lane;
}

/** Read one stored day back; `undefined` when nothing usable is left. */
export function normalizeDayReviewStats(raw: unknown): DayReviewStats | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Record<string, unknown>;
    const day: DayReviewStats = {};
    if (record.notes) day.notes = normalizeLaneDayStats(record.notes);
    if (record.decks) day.decks = normalizeLaneDayStats(record.decks);
    return day.notes || day.decks ? day : undefined;
}

/** Total reviews (graded and skipped) across one lane. */
export function laneReviewCount(lane: LaneDayStats | undefined): number {
    if (!lane) return 0;
    return gradeCountsOf(lane.learning) + gradeCountsOf(lane.young) + gradeCountsOf(lane.mature);
}

/** Sum a range of stored days into one lane (or several) total. */
export function sumLaneDays(days: Iterable<DayReviewStats>, lanes: ReviewLane | ReviewLane[]): LaneDayStats {
    const wanted = Array.isArray(lanes) ? lanes : [lanes];
    const total = emptyLaneDayStats();
    for (const day of days) {
        for (const lane of wanted) {
            const part = lane === 'notes' ? day.notes : day.decks;
            if (!part) continue;
            for (const bucket of VALID_BUCKETS) {
                for (const grade of VALID_GRADES) {
                    total[bucket][grade] += part[bucket][grade];
                }
            }
            total.skipped += part.skipped;
        }
    }
    return total;
}

/** Young + mature reviews only: the population "true retention" measures. */
export function gradedReviewsInLane(lane: LaneDayStats): number {
    return gradeCountsOf(lane.young) + gradeCountsOf(lane.mature);
}

function countGrade(counts: GradeCounts, grade: ReviewGrade): number {
    return counts[grade];
}

/** Pass rate per population out of one summed lane. */
export function retentionOfLane(lane: LaneDayStats): RetentionSummary {
    const summary = (counts: GradeCounts): RetentionBucket => {
        const answered = gradeCountsOf(counts);
        const passed = answered - countGrade(counts, 'again');
        return { answered, passed, pct: answered > 0 ? Math.round((passed / answered) * 1000) / 10 : null };
    };
    const learning = summary(lane.learning);
    const young = summary(lane.young);
    const mature = summary(lane.mature);
    const all = summary({
        again: lane.young.again + lane.mature.again,
        hard: lane.young.hard + lane.mature.hard,
        good: lane.young.good + lane.mature.good,
        easy: lane.young.easy + lane.mature.easy,
    });
    return { learning, young, mature, all };
}

/** The grade mix per population out of one summed lane. */
export function gradeMixOfLane(lane: LaneDayStats): GradeMix {
    return { learning: { ...lane.learning }, young: { ...lane.young }, mature: { ...lane.mature } };
}

/* ----------------------------------------------------------- streaks */

/**
 * Current and best streaks from the days that saw activity.
 *
 * The current streak may end yesterday: a streak is not broken until a whole
 * day has passed with nothing studied — the same reading Anki's heatmap gives.
 */
export function streaksFromDays(activeDayStarts: Iterable<number>, todayStart: number): Streaks {
    const days = [...new Set(activeDayStarts)].sort((a, b) => a - b);
    if (days.length === 0) return { current: 0, best: 0 };

    let best = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
        run = days[i] - days[i - 1] === DAY_MS ? run + 1 : 1;
        if (run > best) best = run;
    }

    const active = new Set(days);
    let cursor = active.has(todayStart) ? todayStart : todayStart - DAY_MS;
    let current = 0;
    while (active.has(cursor)) {
        current += 1;
        cursor -= DAY_MS;
    }
    return { current, best };
}

/* ----------------------------------------------------------- forecast */

/**
 * Count due times per day, today first.
 *
 * Anything already owed — due before today — is folded into today's slot,
 * where the reader can act on it; anything past the horizon is dropped.
 */
export function buildForecast(dueTimes: number[], days: number, todayStart: number): number[] {
    const counts = new Array<number>(days).fill(0);
    const horizon = todayStart + days * DAY_MS;
    for (const due of dueTimes) {
        if (!Number.isFinite(due)) continue;
        if (due < todayStart) {
            counts[0] += 1;
        } else if (due < horizon) {
            counts[Math.floor((due - todayStart) / DAY_MS)] += 1;
        }
    }
    return counts;
}

/**
 * Anki's "daily load": the number of reviews a day the current intervals imply,
 * `Σ 1/max(interval, 1)`. New and suspended cards are not inputs.
 */
export function dailyLoad(intervalsInDays: number[]): number {
    let load = 0;
    for (const interval of intervalsInDays) {
        load += 1 / Math.max(Math.abs(interval) || 1, 1);
    }
    return load;
}

/* -------------------------------------------------------- distributions */

/** A histogram with closed bin edges: `edges[i] <= value < edges[i+1]`. */
export function histogram(values: number[], edges: number[]): number[] {
    const bins = new Array<number>(Math.max(edges.length - 1, 0)).fill(0);
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        for (let i = 0; i < bins.length; i++) {
            if (value >= edges[i] && value < edges[i + 1]) {
                bins[i] += 1;
                break;
            }
        }
    }
    return bins;
}

export function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The value at a percentile (0-100), nearest-rank. */
export function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[at];
}
