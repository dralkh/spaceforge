/**
 * Integration tests for the scheduling service: interval previews, lapse
 * counting and the leech actions, run against the real service code with a
 * stubbed Obsidian API. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReviewScheduleService } from '../services/review-schedule-service';
import { DEFAULT_SETTINGS, SpaceforgeSettings } from '../models/settings';
import { State as FsrsState } from 'ts-fsrs';
import { ReviewSchedule, ReviewResponse, FsrsRating } from '../models/review-schedule';
import { DateUtils } from '../utils/dates';
import { shouldPromptLeech, nextLeechCheckpoint } from '../models/review-flow';
import { notices } from './support/obsidian-shim';

interface FakePlugin {
    settings: SpaceforgeSettings;
    events: { emit: (name: string) => void };
    emitted: string[];
}

function makePlugin(overrides: Partial<SpaceforgeSettings> = {}): FakePlugin {
    const emitted: string[] = [];
    return {
        settings: { ...DEFAULT_SETTINGS, ...overrides },
        events: { emit: (name: string) => emitted.push(name) },
        emitted,
    };
}

function makeService(settings: Partial<SpaceforgeSettings> = {}): { service: ReviewScheduleService; plugin: FakePlugin } {
    const plugin = makePlugin(settings);
    // Only the plugin fields the scheduling code reads are real; the rest of the
    // plugin instance is not needed outside Obsidian.
    const service = new ReviewScheduleService(
        plugin as unknown as ConstructorParameters<typeof ReviewScheduleService>[0],
        {},
        [],
        null,
        []
    );
    return { service, plugin };
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

test('the preview matches what grading actually records (SM-2)', () => {
    // One fixed review instant for both halves, so the two runs are comparable.
    const now = Date.now();
    const responses = [
        ReviewResponse.CompleteBlackout,
        ReviewResponse.IncorrectResponse,
        ReviewResponse.IncorrectButFamiliar,
        ReviewResponse.CorrectWithDifficulty,
        ReviewResponse.CorrectWithHesitation,
        ReviewResponse.PerfectRecall,
    ];

    for (const response of responses) {
        const previewRun = makeService();
        previewRun.service.schedules['notes/a.md'] = sm2Schedule();
        const preview = previewRun.service.previewReview('notes/a.md', response, now);
        assert.ok(preview, `expected a preview for rating ${response}`);

        const realRun = makeService();
        realRun.service.schedules['notes/a.md'] = sm2Schedule();
        realRun.service.recordReview('notes/a.md', response, false, now);
        const real = realRun.service.schedules['notes/a.md'];

        assert.equal(preview.interval, real.interval, `interval preview for rating ${response}`);
        assert.equal(preview.nextReviewDate, real.nextReviewDate, `due date preview for rating ${response}`);
    }
});

test('the preview matches what grading actually records (FSRS, fuzz off)', () => {
    const now = Date.now();
    const settings = {
        fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false },
    };

    for (const rating of [FsrsRating.Again, FsrsRating.Hard, FsrsRating.Good, FsrsRating.Easy]) {
        const previewRun = makeService(settings);
        previewRun.service.schedules['notes/b.md'] = fsrsSchedule();
        const preview = previewRun.service.previewReview('notes/b.md', rating, now);
        assert.ok(preview, `expected a preview for rating ${rating}`);

        const realRun = makeService(settings);
        realRun.service.schedules['notes/b.md'] = fsrsSchedule();
        realRun.service.recordReview('notes/b.md', rating, false, now);
        const real = realRun.service.schedules['notes/b.md'];

        assert.equal(preview.interval, real.interval, `interval preview for rating ${rating}`);
        assert.equal(preview.nextReviewDate, real.nextReviewDate, `due date preview for rating ${rating}`);
    }
});

test('previewing changes nothing at all', () => {
    const { service, plugin } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule();
    const before = JSON.stringify(service.schedules['notes/a.md']);
    const historyBefore = service.history.length;
    plugin.emitted.length = 0;
    notices.length = 0;

    for (const response of [0, 1, 2, 3, 4, 5]) {
        service.previewReview('notes/a.md', response);
    }

    assert.equal(JSON.stringify(service.schedules['notes/a.md']), before);
    assert.equal(service.history.length, historyBefore);
    assert.deepEqual(plugin.emitted, []);
    assert.deepEqual(notices, []);
});

test('previewing a note that is not due, or has no schedule, yields nothing', () => {
    const { service } = makeService();
    assert.equal(service.previewReview('missing.md', ReviewResponse.PerfectRecall), null);

    service.schedules['notes/future.md'] = sm2Schedule({
        path: 'notes/future.md',
        nextReviewDate: DateUtils.addDays(Date.now(), 5),
    });
    assert.equal(service.previewReview('notes/future.md', ReviewResponse.PerfectRecall), null);
});

test('a failing grade on an SM-2 note counts as a lapse, a pass does not', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: 0, interval: 6, repetitionCount: 2 });

    service.recordReview('notes/a.md', ReviewResponse.IncorrectResponse);
    assert.equal(service.schedules['notes/a.md'].lapses, 1);

    service.recordReview('notes/a.md', ReviewResponse.PerfectRecall);
    assert.equal(service.schedules['notes/a.md'].lapses, 1);
});

test('a failing grade in the initial phase counts as a lapse too', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({
        scheduleCategory: 'initial',
        repetitionCount: 2,
        interval: 3,
        lapses: 0,
    });

    service.recordReview('notes/a.md', ReviewResponse.CompleteBlackout);
    assert.equal(service.schedules['notes/a.md'].lapses, 1);
});

test('FSRS lapses come from the algorithm itself', () => {
    const { service } = makeService({ fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false } });
    service.schedules['notes/b.md'] = fsrsSchedule();
    const before = service.getLapseInfo('notes/b.md').lapses;

    service.recordReview('notes/b.md', FsrsRating.Again);
    const after = service.getLapseInfo('notes/b.md').lapses;

    assert.equal(before, 2);
    assert.ok(after > before, 'Again on a review card should add a lapse');
});

test('reset gives the note a fresh start and defers the next question', () => {
    const threshold = DEFAULT_SETTINGS.leechThreshold;
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: threshold, repetitionCount: 4, interval: 30 });

    const promptedBefore = shouldPromptLeech({
        lapses: service.getLapseInfo('notes/a.md').lapses,
        handledAtLapses: service.getLapseInfo('notes/a.md').handledAtLapses,
        threshold,
    });
    assert.equal(promptedBefore, true);

    service.resolveLeech('notes/a.md', 'reset');
    const schedule = service.schedules['notes/a.md'];
    const lapseInfo = service.getLapseInfo('notes/a.md');

    assert.equal(schedule.interval, 1);
    assert.equal(schedule.lapses, 0);
    assert.equal(schedule.repetitionCount, 0);
    assert.equal(schedule.nextReviewDate, DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), 1));
    assert.equal(lapseInfo.handledAtLapses, threshold);

    // Quiet until the lapses climb back to the next checkpoint.
    assert.equal(shouldPromptLeech({ lapses: threshold, handledAtLapses: lapseInfo.handledAtLapses, threshold }), false);
    assert.equal(shouldPromptLeech({ lapses: nextLeechCheckpoint(threshold, threshold), handledAtLapses: lapseInfo.handledAtLapses, threshold }), true);
});

test('resting a note pushes it a week out, keeping the decision checkpoint', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: 9 });
    const before = service.schedules['notes/a.md'].nextReviewDate;

    service.resolveLeech('notes/a.md', 'postpone');

    const schedule = service.schedules['notes/a.md'];
    assert.equal(schedule.nextReviewDate, DateUtils.addDays(before, 7));
    assert.equal(schedule.leechHandledAtLapses, 9);
});

test('removing a leech drops it from the schedule and stops asking', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: 8 });

    service.resolveLeech('notes/a.md', 'remove');

    assert.equal(service.schedules['notes/a.md'], undefined);
    assert.deepEqual(service.getLapseInfo('notes/a.md'), { lapses: 0, handledAtLapses: 0 });
});

test('carrying on quietens the prompt without touching the schedule', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: 8, interval: 12 });
    const before = JSON.stringify({ ...service.schedules['notes/a.md'], leechHandledAtLapses: undefined });

    service.resolveLeech('notes/a.md', 'keep');

    const schedule = service.schedules['notes/a.md'];
    assert.equal(schedule.interval, 12);
    assert.equal(schedule.leechHandledAtLapses, 8);
    assert.equal(JSON.stringify({ ...schedule, leechHandledAtLapses: undefined }), before);
});

test('reset on an FSRS note rebuilds the card rather than just moving the date', () => {
    const { service } = makeService({ fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false } });
    service.schedules['notes/b.md'] = fsrsSchedule({ lapses: 7 });

    service.resolveLeech('notes/b.md', 'reset');

    const fsrs = service.schedules['notes/b.md'].fsrsData;
    assert.ok(fsrs);
    assert.equal(fsrs.lapses, 0);
    assert.equal(fsrs.scheduled_days, 1);
    assert.ok(fsrs.stability <= 1, `stability squeezed back down, got ${fsrs.stability}`);
    assert.equal(fsrs.state, FsrsState.Relearning);
    assert.equal(service.schedules['notes/b.md'].nextReviewDate, DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), 1));
});

test('resolving a leech on a note with no schedule does nothing at all', () => {
    const { service } = makeService();
    notices.length = 0;

    assert.doesNotThrow(() => service.resolveLeech('ghost.md', 'reset'));
    assert.doesNotThrow(() => service.resolveLeech('ghost.md', 'postpone'));
    assert.doesNotThrow(() => service.resolveLeech('ghost.md', 'remove'));
    assert.doesNotThrow(() => service.resolveLeech('ghost.md', 'keep'));
    assert.deepEqual(service.getLapseInfo('ghost.md'), { lapses: 0, handledAtLapses: 0 });
});

test('answering "keep as is" repeatedly never lowers the checkpoint', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule({ lapses: 12 });

    service.resolveLeech('notes/a.md', 'keep');
    assert.equal(service.schedules['notes/a.md'].leechHandledAtLapses, 12);

    service.resolveLeech('notes/a.md', 'keep');
    assert.equal(service.schedules['notes/a.md'].leechHandledAtLapses, 12);
});

test('undoing a grade puts the schedule back and drops only that note’s history entry', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule();
    service.history.push({ path: 'older.md', timestamp: 1, response: 5, interval: 1, ease: 250 });

    const snapshot = {
        path: 'notes/a.md',
        scheduleJSON: JSON.stringify(service.schedules['notes/a.md']),
        historyLength: service.history.length,
        previousPath: 'notes/a.md',
        recordedAt: Date.now(),
    };

    service.recordReview('notes/a.md', ReviewResponse.PerfectRecall);
    service.history.push({ path: 'elsewhere.md', timestamp: Date.now(), response: 5, interval: 1, ease: 250 });

    service.restoreSnapshot(snapshot);

    assert.equal(JSON.stringify(service.schedules['notes/a.md']), snapshot.scheduleJSON, 'schedule restored');
    assert.deepEqual(service.history.map(item => item.path), ['older.md', 'elsewhere.md'], 'only the graded note loses its entry');
});

test('undoing a grade on a note that had no schedule removes it again', () => {
    const { service } = makeService();
    service.schedules['notes/a.md'] = sm2Schedule();
    const snapshot = {
        path: 'notes/a.md',
        scheduleJSON: null as string | null,
        historyLength: 0,
        previousPath: null,
        recordedAt: Date.now(),
    };

    service.recordReview('notes/a.md', ReviewResponse.PerfectRecall);
    assert.ok(service.schedules['notes/a.md']);

    service.restoreSnapshot(snapshot);
    assert.equal(service.schedules['notes/a.md'], undefined);
});

test('graded data survives a save and reload exactly as it was', () => {
    const { service } = makeService({ fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false } });
    service.schedules['notes/a.md'] = sm2Schedule();
    service.schedules['notes/b.md'] = fsrsSchedule();

    service.recordReview('notes/a.md', ReviewResponse.IncorrectButFamiliar);
    service.recordReview('notes/b.md', FsrsRating.Hard);

    // What main.ts writes to disk, and what loadPluginData() reads back.
    const saved = JSON.stringify({ schedules: service.schedules, history: service.history });
    const reloaded = JSON.parse(saved) as { schedules: Record<string, ReviewSchedule>; history: typeof service.history };

    const reloadedPlugin = makePlugin({ fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_fuzz: false } });
    const reloadedService = new ReviewScheduleService(
        reloadedPlugin as unknown as ConstructorParameters<typeof ReviewScheduleService>[0],
        reloaded.schedules,
        [],
        null,
        reloaded.history
    );

    assert.deepEqual(reloadedService.schedules, service.schedules, 'schedules round-trip unchanged');
    assert.deepEqual(reloadedService.history, service.history, 'history round-trips unchanged');

    // Nothing turned into NaN/Infinity on the way through JSON.
    for (const schedule of Object.values(reloadedService.schedules)) {
        assert.ok(Number.isFinite(schedule.nextReviewDate), `${schedule.path}: nextReviewDate`);
        assert.ok(Number.isFinite(schedule.ease), `${schedule.path}: ease`);
        assert.ok(Number.isFinite(schedule.interval), `${schedule.path}: interval`);
        if (schedule.fsrsData) {
            assert.ok(Number.isFinite(schedule.fsrsData.stability), `${schedule.path}: stability`);
            assert.ok(Number.isFinite(schedule.fsrsData.difficulty), `${schedule.path}: difficulty`);
            assert.ok(Number.isFinite(schedule.fsrsData.scheduled_days), `${schedule.path}: scheduled_days`);
        }
    }

    // And the reloaded copy still schedules normally.
    reloadedService.schedules['notes/a.md'].nextReviewDate = DateUtils.startOfUTCDay(new Date());
    assert.equal(reloadedService.recordReview('notes/a.md', ReviewResponse.PerfectRecall), true);
});
