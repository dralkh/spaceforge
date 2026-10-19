/**
 * The statistics service: classification of reviews, the permanent day
 * counters (including seeding from an older file and undo), the read figures
 * (retention, streaks, forecasts), the deck review log, and the write hooks in
 * the scheduling service that feed all of it. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA, PluginStateData } from '../models/plugin-data';
import { ReviewSchedule, ReviewHistoryItem, ReviewResponse, FsrsRating } from '../models/review-schedule';
import { AnkiCard, AnkiCardQueue, AnkiCardType, DeckBundle, DeckOptions, DeckScheduler, LeechAction } from '../models/anki';
import {
    DAY_MS,
    bucketOfDeckAnswer,
    bucketOfHistoryItem,
    buildForecast,
    dailyLoad,
    dayKeyOfTimestamp,
    gradeOfFsrsRating,
    gradeOfHistoryItem,
    gradeOfSm2Quality,
    histogram,
    median,
    schedulerOfHistoryItem,
    startOfUTCDay,
    streaksFromDays,
    timestampOfDayKey,
} from '../models/stats';
import { StatsService, deckSnapshot, retrievability } from '../services/stats-service';
import { ReviewScheduleService } from '../services/review-schedule-service';
import { DateUtils } from '../utils/dates';

/* ---------------------------------------------------------------- harness */

interface Harness {
    plugin: Record<string, unknown>;
    stats: StatsService;
    service: ReviewScheduleService;
    state: PluginStateData;
}

function makeHarness(): Harness {
    const state: PluginStateData = {
        ...DEFAULT_PLUGIN_STATE_DATA,
        schedules: {},
        history: [],
        deckHistory: [],
        customNoteOrder: [],
    };
    const emitted: string[] = [];
    const plugin: Record<string, unknown> = {
        settings: { ...DEFAULT_SETTINGS },
        events: { emit: (name: string) => emitted.push(name) },
        emitted,
        studyPlanService: { sessions: {}, progress: {} },
        mcqService: { mcqSessions: {} },
    };
    const stats = new StatsService(plugin as never, state.reviewDayStats, state.deckHistory);
    stats.applyLoadedState(state);
    plugin.statsService = stats;
    const service = new ReviewScheduleService(plugin as never, state.schedules, [], null, state.history);
    return { plugin, stats, service, state };
}

function sm2Schedule(overrides: Partial<ReviewSchedule> = {}): ReviewSchedule {
    return {
        path: 'notes/a.md',
        lastReviewDate: DateUtils.startOfUTCDay(new Date()),
        nextReviewDate: DateUtils.startOfUTCDay(new Date()),
        ease: 250,
        interval: 6,
        consecutive: 2,
        reviewCount: 3,
        repetitionCount: 3,
        scheduleCategory: 'spaced',
        schedulingAlgorithm: 'sm2',
        ...overrides,
    };
}

function fsrsSchedule(overrides: Partial<ReviewSchedule> = {}): ReviewSchedule {
    return {
        path: 'notes/b.md',
        lastReviewDate: DateUtils.startOfUTCDay(new Date()),
        nextReviewDate: DateUtils.startOfUTCDay(new Date()),
        ease: 50,
        interval: 3,
        consecutive: 3,
        reviewCount: 3,
        schedulingAlgorithm: 'fsrs',
        fsrsData: {
            stability: 5,
            difficulty: 5,
            elapsed_days: 3,
            scheduled_days: 3,
            reps: 3,
            lapses: 2,
            state: 2,
            last_review: DateUtils.addDays(Date.now(), -3),
        },
        ...overrides,
    };
}

function historyItem(overrides: Partial<ReviewHistoryItem>): ReviewHistoryItem {
    return { path: 'notes/a.md', timestamp: Date.now(), response: ReviewResponse.PerfectRecall, interval: 5, ease: 250, ...overrides };
}

function card(overrides: Partial<AnkiCard> = {}): AnkiCard {
    return {
        id: `c${Math.random().toString(36).slice(2, 8)}`,
        noteId: 'n1',
        deckId: 'd1',
        ord: 0,
        type: AnkiCardType.Review,
        queue: AnkiCardQueue.Review,
        interval: 5,
        easeFactor: 2500,
        reviews: 3,
        lapses: 0,
        due: 0,
        newPosition: null,
        flag: 0,
        ...overrides,
    };
}

function options(overrides: Partial<DeckOptions> = {}): DeckOptions {
    return {
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
        leechAction: LeechAction.TagOnly,
        buryNewSiblings: true,
        buryReviewSiblings: true,
        maxAnswerSeconds: 0,
        againDelayMinutes: 10,
        scheduler: DeckScheduler.Sm2,
        fsrs: { desiredRetention: 0.9, maximumInterval: 36500, weights: [], useOwnWeights: false },
        ...overrides,
    };
}

/* ------------------------------------------------------- classification */

test('an old history entry is classified by its ease and interval', () => {
    assert.equal(schedulerOfHistoryItem(historyItem({ ease: 250 })), 'sm2');
    assert.equal(schedulerOfHistoryItem(historyItem({ ease: 80 })), 'fsrs');
    assert.equal(schedulerOfHistoryItem(historyItem({ ease: 0 })), 'sm2', 'a missing ease is not FSRS difficulty');
    assert.equal(schedulerOfHistoryItem(historyItem({ ease: 250, scheduler: 'fsrs' })), 'fsrs', 'an explicit scheduler wins');

    assert.equal(bucketOfHistoryItem(historyItem({ interval: 2, scheduler: 'initial' })), 'learning');
    assert.equal(bucketOfHistoryItem(historyItem({ interval: 0, scheduler: 'sm2' })), 'learning');
    assert.equal(bucketOfHistoryItem(historyItem({ interval: 5, scheduler: 'sm2' })), 'young');
    assert.equal(bucketOfHistoryItem(historyItem({ interval: 21, scheduler: 'sm2' })), 'mature');
    assert.equal(bucketOfHistoryItem(historyItem({ interval: 30, scheduler: 'fsrs' })), 'mature');
});

test('grades fold onto the four buttons the way the algorithms mean them', () => {
    assert.equal(gradeOfSm2Quality(0), 'again');
    assert.equal(gradeOfSm2Quality(2), 'again');
    assert.equal(gradeOfSm2Quality(3), 'hard');
    assert.equal(gradeOfSm2Quality(4), 'good');
    assert.equal(gradeOfSm2Quality(5), 'easy');
    assert.equal(gradeOfFsrsRating(FsrsRating.Again), 'again');
    assert.equal(gradeOfFsrsRating(FsrsRating.Hard), 'hard');
    assert.equal(gradeOfFsrsRating(FsrsRating.Easy), 'easy');

    assert.equal(gradeOfHistoryItem(historyItem({ response: 2, ease: 80 })), 'hard', 'FSRS Hard is stored as response 2');
    assert.equal(gradeOfHistoryItem(historyItem({ response: 2, ease: 250 })), 'again', 'SM-2 grade 2 is a lapse');
    assert.equal(gradeOfHistoryItem(historyItem({ response: 2, ease: 250, grade: 'hard' })), 'hard', 'an explicit grade wins');
});

test('a review keeps only the buttons the four-button scale has', () => {
    const stats = new StatsService({} as never, {}, []);
    const day = new Date().toISOString().slice(0, 10);
    stats.recordNoteReview(historyItem({ timestamp: Date.now(), grade: 'hard', interval: 30, scheduler: 'fsrs' }));
    assert.equal(stats.reviewDayStats[day].notes?.mature.hard, 1);
    assert.equal(stats.reviewDayStats[day].notes?.mature.again, 0);
    stats.removeNoteReview(historyItem({ timestamp: Date.now(), grade: 'hard', interval: 30, scheduler: 'fsrs' }));
    assert.equal(stats.reviewDayStats[day].notes?.mature.hard, 0);
    stats.removeNoteReview(historyItem({ timestamp: Date.now(), grade: 'hard', interval: 30, scheduler: 'fsrs' }));
    assert.equal(stats.reviewDayStats[day].notes?.mature.hard, 0, 'removals never go below zero');
});

/* ---------------------------------------------------------- write hooks */

test('grading a note writes what the grade did into the log and the counters', () => {
    const { service, stats } = makeHarness();
    service.schedules['notes/a.md'] = sm2Schedule();

    assert.equal(service.recordReview('notes/a.md', ReviewResponse.PerfectRecall), true);
    const entry = service.history[0];
    assert.equal(entry.scheduler, 'sm2');
    assert.equal(entry.grade, 'easy');
    assert.equal(entry.nextInterval, service.schedules['notes/a.md'].interval);

    const lane = stats.reviewDayStats[dayKeyOfTimestamp(entry.timestamp)].notes;
    assert.equal(lane?.young.easy, 1, 'a 6-day note is young');
});

test('an FSRS rating is kept as the button that was pressed', () => {
    const { service, stats } = makeHarness();
    service.schedules['notes/b.md'] = fsrsSchedule();

    assert.equal(service.recordReview('notes/b.md', FsrsRating.Hard, false, Date.now(), 'fsrs'), true);
    const entry = service.history[0];
    assert.equal(entry.scheduler, 'fsrs');
    assert.equal(entry.grade, 'hard');
    const lane = stats.reviewDayStats[dayKeyOfTimestamp(entry.timestamp)].notes;
    assert.equal(lane?.young.hard, 1);
});

test('undoing a grade takes it back out of the day counters', () => {
    const { service, stats } = makeHarness();
    service.schedules['notes/a.md'] = sm2Schedule();
    const snapshot = {
        path: 'notes/a.md',
        scheduleJSON: JSON.stringify(service.schedules['notes/a.md']),
        historyLength: service.history.length,
        previousPath: null,
        recordedAt: Date.now(),
    };

    service.recordReview('notes/a.md', ReviewResponse.PerfectRecall);
    assert.equal(Object.keys(stats.reviewDayStats).length, 1);
    service.restoreSnapshot(snapshot);
    const lane = stats.reviewDayStats[dayKeyOfTimestamp(Date.now())].notes;
    assert.equal(lane?.young.easy, 0, 'the undo emptied the day again');
});

test('a skipped note counts as activity, never as an answer', () => {
    const { service, stats } = makeHarness();
    service.schedules['notes/a.md'] = sm2Schedule();

    service.skipNote('notes/a.md');
    const lane = stats.reviewDayStats[dayKeyOfTimestamp(Date.now())].notes;
    assert.equal(lane?.skipped, 1);
    assert.equal(lane?.young.easy, 0);
    assert.equal(lane?.young.again, 0);
});

/* ------------------------------------------------------- seeding + shape */

test('a file that predates the counters is seeded from its review log, once', () => {
    const state: PluginStateData = {
        ...DEFAULT_PLUGIN_STATE_DATA,
        schedules: {},
        deckHistory: [],
        history: [
            historyItem({ timestamp: DateUtils.addDays(Date.now(), -2), response: 4, interval: 6, ease: 250 }),
            historyItem({ timestamp: DateUtils.addDays(Date.now(), -1), response: 1, interval: 30, ease: 80, scheduler: 'fsrs' }),
            historyItem({ timestamp: DateUtils.addDays(Date.now(), -1), response: 3, interval: 0, ease: 250, isSkipped: true }),
        ],
    };
    const stats = new StatsService({} as never, undefined, undefined);
    stats.applyLoadedState(state);

    const twoDaysAgo = stats.reviewDayStats[dayKeyOfTimestamp(DateUtils.addDays(Date.now(), -2))];
    assert.equal(twoDaysAgo?.notes?.young.good, 1);
    const yesterday = stats.reviewDayStats[dayKeyOfTimestamp(DateUtils.addDays(Date.now(), -1))];
    assert.equal(yesterday?.notes?.mature.again, 1, 'an ease of 80 reads as FSRS');
    assert.equal(yesterday?.notes?.skipped, 1);

    assert.equal(state.reviewDayStats, stats.reviewDayStats, 'the save serializes the live counters');

    // A second load of the same file must not count the log twice.
    const counts = JSON.stringify(stats.reviewDayStats);
    stats.applyLoadedState(state);
    assert.equal(JSON.stringify(stats.reviewDayStats), counts);
});

test('hand-edited counters are normalized, not trusted', () => {
    const state: PluginStateData = {
        ...DEFAULT_PLUGIN_STATE_DATA,
        history: [],
        deckHistory: [],
        reviewDayStats: {
            '2026-01-02': {
                notes: { young: { good: 3.7, again: -2, hard: 'x' }, learning: {}, mature: {}, skipped: 'no' },
            },
            'not-a-day': { notes: {} },
        },
    } as PluginStateData;
    const stats = new StatsService({} as never, undefined, undefined);
    stats.applyLoadedState(state);

    assert.deepEqual(Object.keys(stats.reviewDayStats), ['2026-01-02']);
    assert.equal(stats.reviewDayStats['2026-01-02'].notes?.young.good, 3);
    assert.equal(stats.reviewDayStats['2026-01-02'].notes?.young.again, 0);
    assert.equal(stats.reviewDayStats['2026-01-02'].notes?.skipped, 0);
});

/* ------------------------------------------------------------- reads */

test('retention, the button mix and days studied add up as Anki reads them', () => {
    const { stats } = makeHarness();
    const today = startOfUTCDay(Date.now());
    const at = (offset: number): number => today - offset * DAY_MS + 60_000;

    stats.recordNoteReview(historyItem({ timestamp: at(1), interval: 5, grade: 'good', scheduler: 'fsrs' }));
    stats.recordNoteReview(historyItem({ timestamp: at(2), interval: 5, grade: 'again', scheduler: 'fsrs' }));
    stats.recordNoteReview(historyItem({ timestamp: at(3), interval: 30, grade: 'good', scheduler: 'sm2' }));
    stats.recordNoteReview(historyItem({ timestamp: at(4), interval: 0, grade: 'hard', scheduler: 'initial' }));

    const retention = stats.retentionForDays('all', 'notes');
    assert.deepEqual(retention.young, { answered: 2, passed: 1, pct: 50 });
    assert.deepEqual(retention.mature, { answered: 1, passed: 1, pct: 100 });
    assert.deepEqual(retention.all, { answered: 3, passed: 2, pct: 66.7 });

    const mix = stats.gradeMixForRange('all', 'notes');
    assert.equal(mix.young.good, 1);
    assert.equal(mix.young.again, 1);
    assert.equal(mix.learning.hard, 1);

    const studied = stats.daysStudied('30d');
    assert.equal(studied.active, 4);
    assert.equal(studied.total, 30);
    assert.equal(studied.pct, 13);
});

test('a gap breaks a streak, and today is still allowed to be empty', () => {
    const today = startOfUTCDay(Date.now());
    assert.deepEqual(streaksFromDays([today, today - DAY_MS, today - 2 * DAY_MS, today - 5 * DAY_MS], today), { current: 3, best: 3 });
    assert.deepEqual(streaksFromDays([today - DAY_MS, today - 2 * DAY_MS], today), { current: 2, best: 2 });
    assert.deepEqual(streaksFromDays([today - 2 * DAY_MS], today), { current: 0, best: 1 });
    assert.deepEqual(streaksFromDays([], today), { current: 0, best: 0 });

    const { stats } = makeHarness();
    stats.recordNoteReview(historyItem({ timestamp: today - DAY_MS + 60_000, grade: 'good', interval: 5, scheduler: 'sm2' }));
    assert.equal(stats.streaks(today + 3_600_000).current, 1, 'the streak reaches back to yesterday');
});

test('the forecast folds overdue into today and leaves new cards out of the bars', () => {
    const { stats } = makeHarness();
    const now = Date.now();
    const todayStart = startOfUTCDay(now);
    const crt = todayStart / 1000;

    const schedules: Record<string, ReviewSchedule> = {
        'notes/a.md': sm2Schedule({ nextReviewDate: todayStart }),
        'notes/b.md': sm2Schedule({ nextReviewDate: todayStart - 3 * DAY_MS, interval: 1 }),
    };
    const deck = {
        deck: { id: 'd1', name: 'Deck', options: options() },
        extra: { crt },
        cards: [
            card({ queue: AnkiCardQueue.Review, type: AnkiCardType.Review, interval: 5, due: 2 }),
            card({ queue: AnkiCardQueue.Review, type: AnkiCardType.Review, interval: 30, due: -3 }),
            card({ queue: AnkiCardQueue.Review, type: AnkiCardType.Review, interval: 60, due: todayStart + 5 * DAY_MS }),
            card({ queue: AnkiCardQueue.Learning, type: AnkiCardType.Learning, interval: -60, due: now + 60_000 }),
            card({ queue: AnkiCardQueue.New, type: AnkiCardType.New, due: now }),
            card({ queue: AnkiCardQueue.Suspended, due: now }),
        ],
    } as unknown as DeckBundle;

    const forecast = stats.forecast(schedules, [deck], 30, now);
    assert.equal(forecast.overdue, 2, 'an overdue note and an overdue card');
    assert.equal(forecast.dueToday, 4, 'two notes and two deck cards are owed today');
    assert.equal(forecast.days[0].decks, 2, 'the overdue card joins the learning card today');
    assert.equal(forecast.days[2].decks, 1, 'the card due in two days sits there');
    assert.equal(forecast.days[5].decks, 1, 'a card carrying an absolute due date is placed by its timestamp');
    assert.equal(forecast.newAvailable, 1, 'new cards are counted, not charted');
    assert.equal(forecast.dueTomorrow, 0);
    const expectedLoad = 1 / 6 + 1 / 1 + 1 / 5 + 1 / 30 + 1 / 60;
    assert.ok(Math.abs(forecast.dailyLoad - expectedLoad) < 1e-9, `daily load ${forecast.dailyLoad}`);
});

/* ---------------------------------------------------------- deck lane */

test('deck answers land in the log and read back as retention', () => {
    const { stats } = makeHarness();
    const now = Date.now();
    const answer = (overrides: Partial<Parameters<StatsService['recordDeckReview']>[0]>) =>
        stats.recordDeckReview({
            deckPath: 'spaceforge/decks/d.md',
            cardId: 'c1',
            timestamp: now,
            grade: 3,
            priorInterval: 5,
            nextInterval: 10,
            factor: 2500,
            timeMs: 4200,
            kind: 'review',
            ...overrides,
        });

    answer({});
    answer({ grade: 1, priorInterval: 5 });
    answer({ grade: 4, priorInterval: 30 });
    answer({ grade: 2, priorInterval: -60, kind: 'learn' });

    const retention = stats.deckRetention('spaceforge/decks/d.md', 30, now);
    assert.deepEqual(retention.young, { answered: 2, passed: 1, pct: 50 });
    assert.deepEqual(retention.mature, { answered: 1, passed: 1, pct: 100 });

    const totals = stats.deckReviewTotals('spaceforge/decks/d.md', 30, now);
    assert.equal(totals.reviews, 4);
    assert.equal(totals.timeMs, 16800);
    assert.equal(totals.again, 1);

    assert.equal(bucketOfDeckAnswer(-60, 'learn'), 'learning');
    assert.equal(bucketOfDeckAnswer(30, 'review'), 'mature');
});

test('the deck review log is capped; the counters it fed are not', () => {
    const { stats } = makeHarness();
    const limit = StatsService.DECK_HISTORY_LIMIT;
    for (let i = 0; i < limit + 5; i++) {
        stats.recordDeckReview({
            deckPath: 'd.md',
            cardId: `c${i}`,
            timestamp: Date.now(),
            grade: 3,
            priorInterval: 5,
            nextInterval: 10,
            factor: 2500,
            timeMs: null,
            kind: 'review',
        });
    }
    assert.equal(stats.deckHistory.length, limit);
    const lane = stats.reviewDayStats[dayKeyOfTimestamp(Date.now())].decks;
    assert.equal(lane?.young.good, limit + 5, 'every answer still counts');
});

/* --------------------------------------------------------- deck snapshot */

test('a deck snapshot counts its queues, maturity, leeches and retrievability', () => {
    const now = Date.now();
    const base = startOfUTCDay(now);
    const snapshot = deckSnapshot(
        [
            card({ queue: AnkiCardQueue.Review, interval: 30, due: 0 }),
            card({ queue: AnkiCardQueue.Review, interval: 5, due: 10 }),
            card({ queue: AnkiCardQueue.New, interval: 0, lapses: 0, due: 0 }),
            card({ queue: AnkiCardQueue.Learning, interval: -60, due: now }),
            card({ queue: AnkiCardQueue.Suspended, interval: 100, due: 0 }),
            card({ queue: AnkiCardQueue.Review, interval: 10, lapses: 8, due: 0 }),
            card({
                queue: AnkiCardQueue.Review,
                interval: 10,
                due: 0,
                memory: { stability: 10, difficulty: 5, lastReview: now - 10 * DAY_MS, scheduledDays: 10 },
            }),
        ],
        options(),
        now,
        base
    );

    assert.equal(snapshot.reviewCount, 4);
    assert.equal(snapshot.newCount, 1);
    assert.equal(snapshot.learningCount, 1);
    assert.equal(snapshot.suspended, 1);
    assert.equal(snapshot.mature, 1);
    assert.equal(snapshot.leeches, 1);
    assert.equal(snapshot.maturePct, 25);
    assert.equal(snapshot.dueToday, 5, 'new and learning availability plus the reviews whose day has arrived');
    assert.ok(snapshot.averageRetrievability !== null && Math.abs(snapshot.averageRetrievability - 90) < 0.5, 'a card reviewed at its interval is at 90%');
});

test('retrievability is the FSRS curve and hits 90% at the scheduled moment', () => {
    assert.equal(Math.round(retrievability(10, 0) * 1000) / 10, 100);
    assert.equal(Math.round(retrievability(10, 10) * 1000) / 10, 90);
    assert.ok(retrievability(10, 250) < 0.5, 'well past the interval, recall drops away');
    assert.equal(retrievability(0, 5), 0);
});

/* ---------------------------------------------------------- tutor + quiz */

test('the tutor and quiz summaries read the stores they were given', () => {
    const now = Date.now();
    const state: PluginStateData = { ...DEFAULT_PLUGIN_STATE_DATA, schedules: {}, history: [], deckHistory: [] };
    const plugin: Record<string, unknown> = {
        settings: { ...DEFAULT_SETTINGS },
        events: { emit: () => undefined },
    };
    // Hand-built stores, typed loosely on purpose: the summaries only read them.
    plugin.studyPlanService = {
        sessions: {
            'notes/a.md': [
                { id: 's1', notePath: 'notes/a.md', startedAt: now - 2 * 3_600_000, endedAt: now - 3_600_000, score: 0.5 },
                { id: 's2', notePath: 'notes/a.md', startedAt: now - 40 * DAY_MS, endedAt: now - 40 * DAY_MS + 600_000, score: 1 },
            ],
        },
        progress: {
            'notes/a.md': {
                notePath: 'notes/a.md',
                updatedAt: now,
                totalSessions: 2,
                completedSessions: 2,
                objectives: {
                    o1: { status: 'mastered', nextReviewAt: null, errorCounts: { recall: 2 } },
                    o2: { status: 'fragile', nextReviewAt: now - 1000, errorCounts: { recall: 1, transfer: 3 } },
                    o3: { status: 'unseen', nextReviewAt: null, errorCounts: {} },
                },
                tutorMemory: [],
                lastSessionSummary: null,
                scheduleSuggestions: [],
            },
        },
    };
    plugin.mcqService = {
        mcqSessions: {
            'notes/a.md': [
                { startedAt: now - 1000, answers: [{ correct: true, timeToAnswer: 10 }, { correct: false, timeToAnswer: 20 }] },
            ],
        },
    };

    const stats = new StatsService(plugin as never, undefined, []);
    stats.applyLoadedState(state);

    const tutor = stats.tutorSummary(now);
    assert.equal(tutor.sessionsLast30, 1);
    assert.equal(tutor.minutesLast30, 60);
    assert.equal(tutor.averageScoreLast30, 0.5);
    assert.deepEqual(
        { total: tutor.objectives.total, mastered: tutor.objectives.mastered, fragile: tutor.objectives.fragile, unseen: tutor.objectives.unseen, due: tutor.objectives.due },
        { total: 3, mastered: 1, fragile: 1, unseen: 1, due: 1 }
    );
    assert.deepEqual(tutor.topErrors, [{ category: 'recall', count: 3 }, { category: 'transfer', count: 3 }]);

    const quiz = stats.quizSummary(now);
    assert.equal(quiz.sessionsLast30, 1);
    assert.equal(quiz.questionsLast30, 2);
    assert.equal(quiz.accuracyLast30, 50);
    assert.equal(quiz.averageSecondsPerQuestion, 15);
});

/* ------------------------------------------------------------- pure math */

test('forecast counting, daily load and histograms are plain arithmetic', () => {
    const today = startOfUTCDay(Date.now());
    assert.deepEqual(buildForecast([today - 5 * DAY_MS, today + 60_000, today + 2 * DAY_MS, today + 100 * DAY_MS], 30, today), [
        2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    assert.equal(Math.round(dailyLoad([1, 2, 4]) * 100) / 100, 1.75);
    assert.deepEqual(histogram([0, 1, 1, 3, 10], [0, 2, 5, 15]), [3, 1, 1]);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(timestampOfDayKey('2026-08-14'), startOfUTCDay(Date.UTC(2026, 7, 14)));
});
