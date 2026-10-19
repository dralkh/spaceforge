/**
 * Progress analytics, stateful half.
 *
 * This service owns the two durable pieces of the statistics feature:
 *
 * - `reviewDayStats`: one `DayReviewStats` per day studied, for notes and for
 *   decks. Every recorded review folds into it; nothing is ever trimmed, so a
 *   heatmap, a streak or a retention figure keeps its whole history even
 *   though the detailed review log does not (it keeps the newest 1000
 *   reviews only). Undoing a grade takes its contribution back out.
 * - `deckHistory`: the review log for the deck lane, in the shape of Anki's
 *   revlog. Anki keeps this table and reads every statistics screen from it;
 *   the deck lane used to answer without writing one, which is why deck
 *   statistics only reach back to the day this log started.
 *
 * The read side aggregates the day counters; the screen itself is in
 * `ui/stats-view.ts` and the pure arithmetic in `models/stats.ts`.
 */
import SpaceforgePlugin from '../main';
import { AnkiCard, AnkiCardQueue, AnkiGrade, DeckBundle, DeckOptions } from '../models/anki';
import { dueCounts, isLeech } from '../models/anki-scheduler';
import { PluginStateData } from '../models/plugin-data';
import { ReviewHistoryItem, ReviewSchedule } from '../models/review-schedule';
import {
    DAY_MS,
    DayActivity,
    DayReviewStats,
    DeckReviewLogItem,
    GradeMix,
    LaneDayStats,
    MATURE_INTERVAL_DAYS,
    RangeTotals,
    RetentionSummary,
    ReviewLane,
    StatsRange,
    STATS_RANGE_DAYS,
    Streaks,
    addDeckReviewToDay,
    addHistoryItemToDay,
    buildForecast,
    bucketOfDeckAnswer,
    dailyLoad,
    dayKeyOfTimestamp,
    emptyLaneDayStats,
    gradeMixOfLane,
    laneReviewCount,
    normalizeDayReviewStats,
    removeHistoryItemFromDay,
    retentionOfLane,
    startOfUTCDay,
    streaksFromDays,
    sumLaneDays,
    timestampOfDayKey,
} from '../models/stats';
import { StudyObjectiveStatus } from '../models/study';
import { deckDayBase } from '../utils/dates';

/** One day's totals for the forecast chart. */
export interface ForecastDay {
    timestamp: number;
    notes: number;
    decks: number;
}

/** The forecast, plus the figures the chart's header line reports. */
export interface StatsForecast {
    days: ForecastDay[];
    overdue: number;
    dueToday: number;
    dueTomorrow: number;
    /** Due reviews, averaged over the whole horizon. */
    averagePerDay: number;
    /** Anki's daily load: the steady-state reviews the current intervals imply. */
    dailyLoad: number;
    /** New deck cards waiting to be introduced (not part of the bars). */
    newAvailable: number;
}

/** What the tutor card shows. */
export interface TutorSummary {
    sessionsLast30: number;
    minutesLast30: number;
    averageScoreLast30: number | null;
    objectives: {
        total: number;
        mastered: number;
        stable: number;
        fragile: number;
        learning: number;
        unseen: number;
        /** Objectives whose suggested review is due now. */
        due: number;
    };
    /** Cumulative error categories across every objective's progress. */
    topErrors: Array<{ category: string; count: number }>;
}

/** What the quiz card shows. */
export interface QuizSummary {
    sessionsLast30: number;
    questionsLast30: number;
    accuracyLast30: number | null;
    averageSecondsPerQuestion: number | null;
}

/** A deck's current shape, read from its cards. */
export interface DeckSnapshot {
    total: number;
    newCount: number;
    learningCount: number;
    reviewCount: number;
    suspended: number;
    buried: number;
    dueToday: number;
    mature: number;
    maturePct: number | null;
    leeches: number;
    intervals: number[];
    eases: number[];
    stabilities: number[];
    difficulties: number[];
    /** Mean FSRS retrievability today across cards with a memory state. */
    averageRetrievability: number | null;
    /** How many cards that state suggests you would recall today. */
    estimatedKnowledge: number | null;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class StatsService {
    private plugin: SpaceforgePlugin;

    /** One entry per day studied, keyed `YYYY-MM-DD` (UTC). */
    reviewDayStats: Record<string, DayReviewStats>;

    /** The deck lane's review log, newest last. */
    deckHistory: DeckReviewLogItem[];

    /** How many deck answers are kept; older ones still count in the day stats. */
    static readonly DECK_HISTORY_LIMIT = 5000;

    constructor(
        plugin: SpaceforgePlugin,
        reviewDayStats?: Record<string, DayReviewStats>,
        deckHistory?: DeckReviewLogItem[]
    ) {
        this.plugin = plugin;
        this.reviewDayStats = reviewDayStats ?? {};
        this.deckHistory = Array.isArray(deckHistory) ? deckHistory : [];
    }

    /* ------------------------------------------------------------ loading */

    /**
     * Point at the freshly loaded plugin state, and seed the day counters from
     * the review log the first time this version loads a file.
     *
     * Seeding rebuilds the counters from the log's whole (capped) history, so
     * it is honest about what it can see and cannot double-count: it only runs
     * while the file has no counters at all. From then on, every review folds
     * into them as it happens, and they outlive the log's own trim.
     */
    applyLoadedState(state: PluginStateData): void {
        const raw = state.reviewDayStats;
        if (raw && typeof raw === 'object') {
            const normalized: Record<string, DayReviewStats> = {};
            for (const [key, day] of Object.entries(raw)) {
                if (!DAY_KEY_PATTERN.test(key)) continue;
                const clean = normalizeDayReviewStats(day);
                if (clean) normalized[key] = clean;
            }
            this.reviewDayStats = normalized;
        } else {
            this.reviewDayStats = {};
            for (const item of state.history ?? []) {
                if (!item || typeof item.timestamp !== 'number') continue;
                addHistoryItemToDay(this.dayOf(item.timestamp), item);
            }
        }

        const loadedDeckHistory = Array.isArray(state.deckHistory) ? state.deckHistory : [];
        this.deckHistory = loadedDeckHistory.filter(item => item && typeof item.timestamp === 'number');
        if (!raw || typeof raw !== 'object') {
            for (const item of this.deckHistory) {
                addDeckReviewToDay(this.dayOf(item.timestamp), item);
            }
        }

        // Share the live objects with the state the save serializes; the save
        // rebuilds the state field by field, so these two fields have to be
        // the same records the service keeps counting into.
        state.reviewDayStats = this.reviewDayStats;
        state.deckHistory = this.deckHistory;
    }

    /* ------------------------------------------------------------ writes */

    /** Fold one note review into its day. */
    recordNoteReview(item: ReviewHistoryItem): void {
        if (!item || typeof item.timestamp !== 'number') return;
        addHistoryItemToDay(this.dayOf(item.timestamp), item);
    }

    /** Take a note review back out of its day (the undo path). */
    removeNoteReview(item: ReviewHistoryItem): void {
        if (!item || typeof item.timestamp !== 'number') return;
        const day = this.reviewDayStats[dayKeyOfTimestamp(item.timestamp)];
        removeHistoryItemFromDay(day, item);
    }

    /** Write one deck answer into the log and the day counters. */
    recordDeckReview(item: DeckReviewLogItem): void {
        this.deckHistory.push(item);
        if (this.deckHistory.length > StatsService.DECK_HISTORY_LIMIT) {
            this.deckHistory.splice(0, this.deckHistory.length - StatsService.DECK_HISTORY_LIMIT);
        }
        addDeckReviewToDay(this.dayOf(item.timestamp), item);
    }

    private dayOf(timestamp: number): DayReviewStats {
        const key = dayKeyOfTimestamp(timestamp);
        return (this.reviewDayStats[key] ??= {});
    }

    /* ------------------------------------------------------------- reads */

    /** The first day key a range covers, or null for "all history". */
    private rangeStartKey(range: StatsRange, now: number): string | null {
        if (range === 'all') return null;
        const start = startOfUTCDay(now) - (STATS_RANGE_DAYS[range] - 1) * DAY_MS;
        return dayKeyOfTimestamp(start);
    }

    /** Every day with any activity in the window, keyed `YYYY-MM-DD`. */
    activityByDay(range: StatsRange, now: number = Date.now()): Map<string, DayActivity> {
        const from = this.rangeStartKey(range, now);
        const result = new Map<string, DayActivity>();
        for (const key of Object.keys(this.reviewDayStats).sort()) {
            if (from && key < from) continue;
            const day = this.reviewDayStats[key];
            const notes = laneReviewCount(day.notes);
            const decks = laneReviewCount(day.decks);
            const skipped = (day.notes?.skipped ?? 0) + (day.decks?.skipped ?? 0);
            if (notes === 0 && decks === 0 && skipped === 0) continue;
            result.set(key, { key, timestamp: timestampOfDayKey(key), notes, decks, skipped });
        }
        return result;
    }

    /** Totals across the window's days. */
    totalsForRange(range: StatsRange, now: number = Date.now()): RangeTotals {
        const from = this.rangeStartKey(range, now);
        let notes = 0;
        let decks = 0;
        let skipped = 0;
        for (const [key, day] of Object.entries(this.reviewDayStats)) {
            if (from && key < from) continue;
            notes += laneReviewCount(day.notes);
            decks += laneReviewCount(day.decks);
            skipped += day.notes?.skipped ?? 0;
        }
        return { notes, decks, skipped };
    }

    /** Current and best streaks, from every day ever recorded. */
    streaks(now: number = Date.now()): Streaks {
        const days: number[] = [];
        for (const [key, day] of Object.entries(this.reviewDayStats)) {
            if (laneReviewCount(day.notes) + laneReviewCount(day.decks) === 0) continue;
            days.push(Date.parse(`${key}T00:00:00Z`));
        }
        return streaksFromDays(days, startOfUTCDay(now));
    }

    /** How much of the window saw study, for the consistency line. */
    daysStudied(range: StatsRange, now: number = Date.now()): { active: number; total: number; pct: number | null } {
        const from = this.rangeStartKey(range, now);
        let active = 0;
        let firstActive: string | null = null;
        for (const [key, day] of Object.entries(this.reviewDayStats)) {
            if (laneReviewCount(day.notes) + laneReviewCount(day.decks) === 0) continue;
            if (!firstActive || key < firstActive) firstActive = key;
            if (from && key < from) continue;
            active += 1;
        }
        if (range === 'all') {
            if (!firstActive) return { active: 0, total: 0, pct: null };
            const totalDays = Math.round((startOfUTCDay(now) - Date.parse(`${firstActive}T00:00:00Z`)) / DAY_MS) + 1;
            return { active, total: totalDays, pct: totalDays > 0 ? Math.round((active / totalDays) * 100) : null };
        }
        const total = STATS_RANGE_DAYS[range];
        return { active, total, pct: Math.round((active / total) * 100) };
    }

    /** True retention over the last `days` (or all time) for one lane. */
    retentionForDays(days: number | 'all', lane: ReviewLane | 'both', now: number = Date.now()): RetentionSummary {
        const from = days === 'all' ? null : dayKeyOfTimestamp(startOfUTCDay(now) - (days - 1) * DAY_MS);
        return retentionOfLane(this.sumLaneSince(lane, from));
    }

    /** The answer-button mix per population for one lane (or both) and window. */
    gradeMixForRange(range: StatsRange, lane: ReviewLane | 'both', now: number = Date.now()): GradeMix {
        return gradeMixOfLane(this.sumLaneSince(lane, this.rangeStartKey(range, now)));
    }

    private sumLaneSince(lane: ReviewLane | 'both', from: string | null): LaneDayStats {
        const lanes: ReviewLane[] = lane === 'both' ? ['notes', 'decks'] : [lane];
        const window: DayReviewStats[] = [];
        for (const [key, day] of Object.entries(this.reviewDayStats)) {
            if (from && key < from) continue;
            window.push(day);
        }
        return sumLaneDays(window, lanes);
    }

    /* -------------------------------------------------------- deck reads */

    /** True retention for one deck over the window, from its review log. */
    deckRetention(deckPath: string, days: number | 'all', now: number = Date.now()): RetentionSummary {
        const lane = this.deckLaneFromLog(deckPath, days, now);
        return retentionOfLane(lane);
    }

    /** Reviews, answer time and button mix for one deck over the window. */
    deckReviewTotals(deckPath: string, days: number | 'all', now: number = Date.now()): { reviews: number; timeMs: number; again: number } {
        const lane = this.deckLaneFromLog(deckPath, days, now);
        let again = 0;
        for (const bucket of ['learning', 'young', 'mature'] as const) again += lane[bucket].again;
        let timeMs = 0;
        for (const item of this.deckLogWindow(deckPath, days, now)) timeMs += item.timeMs ?? 0;
        return { reviews: laneReviewCount(lane), timeMs, again };
    }

    private deckLogWindow(deckPath: string, days: number | 'all', now: number): DeckReviewLogItem[] {
        const from = days === 'all' ? null : startOfUTCDay(now) - (days - 1) * DAY_MS;
        return this.deckHistory.filter(item =>
            item.deckPath === deckPath && (from === null || item.timestamp >= from)
        );
    }

    private deckLaneFromLog(deckPath: string, days: number | 'all', now: number): LaneDayStats {
        const lane = emptyLaneDayStats();
        for (const item of this.deckLogWindow(deckPath, days, now)) {
            const bucket = bucketOfDeckAnswer(item.priorInterval, item.kind);
            lane[bucket][gradeOfDeckGrade(item.grade)] += 1;
        }
        return lane;
    }

    /* -------------------------------------------------------- forecast */

    /**
     * The due forecast for both lanes: one bar per day, overdue folded into
     * today. Notes come from their schedules, decks from their card states
     * (new cards are left out of the bars and counted separately, as Anki
     * does).
     */
    forecast(
        schedules: Record<string, ReviewSchedule>,
        decks: DeckBundle[],
        days: number,
        now: number = Date.now()
    ): StatsForecast {
        const todayStart = startOfUTCDay(now);
        const noteDue: number[] = [];
        const noteIntervals: number[] = [];
        for (const schedule of Object.values(schedules)) {
            if (!schedule || typeof schedule.nextReviewDate !== 'number') continue;
            noteDue.push(schedule.nextReviewDate);
            if ((schedule.interval ?? 0) >= 1) noteIntervals.push(schedule.interval);
        }

        const deckDue: number[] = [];
        const deckIntervals: number[] = [];
        let newAvailable = 0;
        for (const { cards, deck, extra } of decks) {
            const created = extra?.crt;
            const base = deckDayBase(deck.id, typeof created === 'number' ? created : null);
            for (const card of cards) {
                if (
                    card.queue === AnkiCardQueue.Suspended ||
                    card.queue === AnkiCardQueue.SchedBuried ||
                    card.queue === AnkiCardQueue.UserBuried
                ) {
                    continue;
                }
                if (card.queue === AnkiCardQueue.New) {
                    newAvailable += 1;
                    continue;
                }
                deckDue.push(deckDueAt(card, base));
                if (card.queue === AnkiCardQueue.Review && (card.interval ?? 0) >= 1) deckIntervals.push(card.interval);
            }
        }

        const noteCounts = buildForecast(noteDue, days, todayStart);
        const deckCounts = buildForecast(deckDue, days, todayStart);
        const result: ForecastDay[] = [];
        let total = 0;
        for (let i = 0; i < days; i++) {
            const timestamp = todayStart + i * DAY_MS;
            result.push({ timestamp, notes: noteCounts[i], decks: deckCounts[i] });
            total += noteCounts[i] + deckCounts[i];
        }
        const overdueNotes = noteDue.filter(due => due < todayStart).length;
        const overdueDecks = deckDue.filter(due => due < todayStart).length;

        return {
            days: result,
            overdue: overdueNotes + overdueDecks,
            dueToday: (noteCounts[0] ?? 0) + (deckCounts[0] ?? 0),
            dueTomorrow: (noteCounts[1] ?? 0) + (deckCounts[1] ?? 0),
            averagePerDay: Math.round(total / Math.max(days, 1)),
            dailyLoad: dailyLoad([...noteIntervals, ...deckIntervals]),
            newAvailable,
        };
    }

    /* -------------------------------------------------- tutor / quizzes */

    /** What the tutor screens add up to across every noted plan. */
    tutorSummary(now: number = Date.now()): TutorSummary {
        const since = startOfUTCDay(now) - 30 * DAY_MS;
        let sessionsLast30 = 0;
        let minutesLast30 = 0;
        let scoreSum = 0;
        let scoreCount = 0;
        const errors = new Map<string, number>();

        for (const store of Object.values(this.plugin.studyPlanService?.sessions ?? {})) {
            for (const session of store) {
                if (session.startedAt >= since) {
                    sessionsLast30 += 1;
                    if (session.endedAt && session.endedAt > session.startedAt) {
                        minutesLast30 += (session.endedAt - session.startedAt) / 60000;
                    }
                    if (typeof session.score === 'number') {
                        scoreSum += session.score;
                        scoreCount += 1;
                    }
                }
            }
        }

        const objectives = { total: 0, mastered: 0, stable: 0, fragile: 0, learning: 0, unseen: 0, due: 0 };
        for (const progress of Object.values(this.plugin.studyPlanService?.progress ?? {})) {
            if (!progress?.objectives) continue;
            for (const state of Object.values(progress.objectives)) {
                objectives.total += 1;
                switch (state.status) {
                    case StudyObjectiveStatus.Mastered: objectives.mastered += 1; break;
                    case StudyObjectiveStatus.Stable: objectives.stable += 1; break;
                    case StudyObjectiveStatus.Fragile: objectives.fragile += 1; break;
                    case StudyObjectiveStatus.Learning: objectives.learning += 1; break;
                    default: objectives.unseen += 1; break;
                }
                if (state.nextReviewAt !== null && state.nextReviewAt !== undefined && state.nextReviewAt <= now) {
                    objectives.due += 1;
                }
                for (const [category, count] of Object.entries(state.errorCounts ?? {})) {
                    if (typeof count === 'number') errors.set(category, (errors.get(category) ?? 0) + count);
                }
            }
        }

        const topErrors = [...errors.entries()]
            .map(([category, count]) => ({ category, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        return {
            sessionsLast30,
            minutesLast30: Math.round(minutesLast30),
            averageScoreLast30: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
            objectives,
            topErrors,
        };
    }

    /** What the MCQ sessions add up to across every note. */
    quizSummary(now: number = Date.now()): QuizSummary {
        const since = startOfUTCDay(now) - 30 * DAY_MS;
        let sessionsLast30 = 0;
        let questions = 0;
        let correct = 0;
        let seconds = 0;
        let timedQuestions = 0;

        for (const sessions of Object.values(this.plugin.mcqService?.mcqSessions ?? {})) {
            for (const session of sessions) {
                if (session.startedAt < since) continue;
                sessionsLast30 += 1;
                for (const answer of session.answers ?? []) {
                    questions += 1;
                    if (answer.correct) correct += 1;
                    if (typeof answer.timeToAnswer === 'number' && answer.timeToAnswer > 0) {
                        seconds += answer.timeToAnswer;
                        timedQuestions += 1;
                    }
                }
            }
        }

        return {
            sessionsLast30,
            questionsLast30: questions,
            accuracyLast30: questions > 0 ? Math.round((correct / questions) * 1000) / 10 : null,
            averageSecondsPerQuestion: timedQuestions > 0 ? Math.round((seconds / timedQuestions) * 10) / 10 : null,
        };
    }
}

/* ------------------------------------------------------------- pure aids */

/**
 * The moment a deck card falls due, whichever way its due value is written.
 *
 * Two conventions live in vault files, and they are told apart by magnitude:
 *
 * - the in-app scheduler writes a *day number* for review cards, counted from
 *   the deck's day base (`deckDayBase`);
 * - a package imported from Anki carries the due as an absolute epoch
 *   millisecond timestamp (see `dueFromStorage`), and learning steps are
 *   timestamps in both conventions.
 *
 * Day numbers are small (tens of thousands at most); epoch milliseconds are
 * around 10^12. Reading the wrong one would put a card years away, so the
 * value's own scale decides.
 */
export function deckDueAt(card: AnkiCard, dayBase: number): number {
    if (card.queue !== AnkiCardQueue.Review && card.queue !== AnkiCardQueue.New) return card.due;
    const looksLikeDayNumber = Number.isFinite(card.due) && card.due >= 0 && card.due < 1e10;
    return looksLikeDayNumber ? dayBase + card.due * DAY_MS : card.due;
}

/** The four-button grade an Anki grade is; kept local to avoid a cycle. */
function gradeOfDeckGrade(grade: AnkiGrade): 'again' | 'hard' | 'good' | 'easy' {
    if (grade >= AnkiGrade.Easy) return 'easy';
    if (grade >= AnkiGrade.Good) return 'good';
    if (grade >= AnkiGrade.Hard) return 'hard';
    return 'again';
}

/**
 * FSRS's forgetting curve: the probability of recall after `elapsedDays` for a
 * card of this stability. TS-FSRS (the bundled model) uses FSRS-5's fixed
 * decay, so this is the closed form Anki's "Card Retrievability" graph uses.
 */
export function retrievability(stability: number, elapsedDays: number): number {
    if (!(stability > 0)) return 0;
    const decay = 0.5;
    const factor = Math.pow(0.9, -1 / decay) - 1;
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + (factor * t) / stability, -decay);
}

/** Read one deck's cards into the snapshot the deck card renders. */
export function deckSnapshot(cards: AnkiCard[], options: DeckOptions, now: number = Date.now(), dayBase = 0): DeckSnapshot {
    const snapshot: DeckSnapshot = {
        total: cards.length,
        newCount: 0,
        learningCount: 0,
        reviewCount: 0,
        suspended: 0,
        buried: 0,
        dueToday: 0,
        mature: 0,
        maturePct: null,
        leeches: 0,
        intervals: [],
        eases: [],
        stabilities: [],
        difficulties: [],
        averageRetrievability: null,
        estimatedKnowledge: null,
    };
    // The scheduler's own count, so the table's "Due" says the same thing the
    // session will offer.
    const counts = dueCounts(cards, options, now, dayBase);
    snapshot.dueToday = counts.dueToday;

    let retrievabilitySum = 0;
    let memories = 0;
    for (const card of cards) {
        if (card.queue === AnkiCardQueue.Suspended) snapshot.suspended += 1;
        else if (card.queue === AnkiCardQueue.SchedBuried || card.queue === AnkiCardQueue.UserBuried) snapshot.buried += 1;
        else if (card.queue === AnkiCardQueue.New) snapshot.newCount += 1;
        else if (card.queue === AnkiCardQueue.Learning) snapshot.learningCount += 1;
        else if (card.queue === AnkiCardQueue.Review) snapshot.reviewCount += 1;

        if (isLeech(card, options)) snapshot.leeches += 1;

        if (card.queue === AnkiCardQueue.Review && (card.interval ?? 0) >= 1) {
            snapshot.intervals.push(card.interval);
            if (card.interval >= MATURE_INTERVAL_DAYS) snapshot.mature += 1;
        }
        if (card.easeFactor > 0) snapshot.eases.push(card.easeFactor);
        if (card.memory) {
            snapshot.stabilities.push(card.memory.stability);
            snapshot.difficulties.push(card.memory.difficulty);
            const elapsed = (now - card.memory.lastReview) / DAY_MS;
            retrievabilitySum += retrievability(card.memory.stability, elapsed);
            memories += 1;
        }
    }

    if (snapshot.reviewCount > 0) {
        snapshot.maturePct = Math.round((snapshot.mature / snapshot.reviewCount) * 100);
    }
    if (memories > 0) {
        snapshot.averageRetrievability = Math.round((retrievabilitySum / memories) * 1000) / 10;
        snapshot.estimatedKnowledge = Math.round(retrievabilitySum * 10) / 10;
    }
    return snapshot;
}
