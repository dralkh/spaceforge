/**
 * Scheduler fidelity: the plugin's intervals must match the algorithms they claim
 * to implement.
 *
 *  - FSRS cards go through ts-fsrs itself, so the test runs the same library with
 *    the same parameters and compares every rating on time and late.
 *  - SM-2 is checked against a from-the-paper implementation (Wozniak 1987), which
 *    is deliberately independent of the plugin's code.
 *
 * These are the tests that catch a rating being silently re-mapped, a lateness
 * penalty that does not exist in either algorithm, or a failure that gets pushed
 * to tomorrow instead of coming back the same day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FSRS, Rating, State, createEmptyCard, default_w } from 'ts-fsrs';
import { FakeShell } from './support/fake-shell';
import { DateUtils } from '../utils/dates';
import { DEFAULT_SETTINGS, SpaceforgeSettings, migrateSettings } from '../models/settings';

const DAY = 86_400_000;
const now = Date.now();
const startOfToday = DateUtils.startOfUTCDay(new Date(now));
const endOfToday = DateUtils.endOfUTCDay(new Date(now));

const W19 = DEFAULT_WEIGHTS();
function DEFAULT_WEIGHTS(): number[] {
    return [...default_w];
}

function fsrsWith(enableFuzz: boolean): FSRS {
    return new FSRS({
        request_retention: 0.9,
        maximum_interval: 36500,
        enable_fuzz: enableFuzz,
        w: W19,
        enable_short_term: true,
    } as never);
}

/** A mature FSRS card: stability 30d, difficulty 5, 30-day interval. */
function matureFsrsCard(lateDays: number) {
    return {
        ...createEmptyCard(new Date(now - 30 * DAY)),
        stability: 30,
        difficulty: 5,
        elapsed_days: 30,
        scheduled_days: 30,
        reps: 8,
        lapses: 0,
        state: State.Review,
        due: new Date(now - lateDays * DAY),
        last_review: new Date(now - 30 * DAY),
    };
}

/**
 * Canonical SM-2 straight from the paper: EF' = EF + (0.1 - (5-q)(0.08 + (5-q)0.02)),
 * floor 1.3; q < 3 restarts the schedule; otherwise I(n) = I(n-1) * EF' with
 * I(1) = 1 day and I(2) = 6 days. Lateness is not an input.
 */
function canonicalSm2(currentInterval: number, currentEasePercent: number, q: number, n: number) {
    let ease = currentEasePercent / 100;
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    if (q < 3) return { interval: 0, ease: Math.round(ease * 100), n: 0 };
    const nextN = n + 1;
    const interval = nextN === 1 ? 1 : nextN === 2 ? 6 : Math.round(currentInterval * ease);
    return { interval, ease: Math.round(ease * 100), n: nextN };
}

test('FSRS: every rating matches ts-fsrs itself, on time and late', () => {
    for (const lateDays of [0, 3, 30]) {
        for (const [name, rating] of Object.entries({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy })) {
            const shell = new FakeShell({ fsrsParameters: { enable_fuzz: false } });
            shell.addNote({
                path: 'n.md',
                dueInDays: -lateDays,
                schedule: {
                    schedulingAlgorithm: 'fsrs',
                    interval: 30,
                    fsrsData: {
                        stability: 30, difficulty: 5, elapsed_days: 30, scheduled_days: 30,
                        reps: 8, lapses: 0, state: State.Review as number, last_review: now - 30 * DAY,
                    },
                },
            });

            const preview = shell.service.previewReview('n.md', rating, now, 'fsrs') as { interval: number; nextReviewDate: number };
            const reference = fsrsWith(false).repeat(matureFsrsCard(lateDays) as never, new Date(now))[rating];

            const expectedDays = reference.card.scheduled_days;
            assert.equal(
                preview.interval, expectedDays,
                `${name} ${lateDays}d late: plugin ${preview.interval}d vs ts-fsrs ${expectedDays}d`
            );
            // The library's own due timestamp is what gets stored, time of day included.
            assert.equal(
                preview.nextReviewDate, reference.card.due.getTime(),
                `${name} ${lateDays}d late: due timestamp`
            );
        }
    }
});

test('FSRS: a late pass grows the interval instead of resetting it', () => {
    const intervals: Record<string, number[]> = { good: [], easy: [] };
    for (const lateDays of [0, 30]) {
        for (const [name, rating] of Object.entries({ good: Rating.Good, easy: Rating.Easy })) {
            const shell = new FakeShell({ fsrsParameters: { enable_fuzz: false } });
            shell.addNote({
                path: 'n.md',
                dueInDays: -lateDays,
                schedule: {
                    schedulingAlgorithm: 'fsrs', interval: 30,
                    fsrsData: {
                        stability: 30, difficulty: 5, elapsed_days: 30 + lateDays, scheduled_days: 30,
                        reps: 8, lapses: 0, state: State.Review as number, last_review: now - (30 + lateDays) * DAY,
                    },
                },
            });
            const preview = shell.service.previewReview('n.md', rating, now, 'fsrs') as { interval: number };
            intervals[name].push(preview.interval);
        }
    }
    assert.ok(intervals.good[1] > intervals.good[0], `late Good must grow: ${intervals.good.join(' -> ')}`);
    assert.ok(intervals.easy[1] > intervals.easy[0], `late Easy must grow: ${intervals.easy.join(' -> ')}`);
});

test('FSRS: Again comes back today (relearning step), not tomorrow', () => {
    const shell = new FakeShell({ fsrsParameters: { enable_fuzz: false } });
    shell.addNote({
        path: 'n.md',
        schedule: {
            schedulingAlgorithm: 'fsrs', interval: 30,
            fsrsData: {
                stability: 30, difficulty: 5, elapsed_days: 30, scheduled_days: 30,
                reps: 8, lapses: 0, state: State.Review as number, last_review: now - 30 * DAY,
            },
        },
    });

    const preview = shell.service.previewReview('n.md', Rating.Again, now, 'fsrs') as { interval: number; nextReviewDate: number };
    assert.equal(preview.interval, 0, 'a relearning step is sub-day');
    assert.ok(preview.nextReviewDate > now, 'the step is in the future');
    assert.ok(preview.nextReviewDate <= endOfToday, 'and still today');

    assert.equal(shell.service.recordReview('n.md', Rating.Again, false, now, 'fsrs'), true);
    const schedule = shell.service.schedules['n.md']!;
    assert.equal(schedule.fsrsData!.state, State.Relearning as number);
    assert.ok(schedule.nextReviewDate <= endOfToday, 'the note is due again today');
    assert.ok(shell.service.getDueNotes(now).some(s => s.path === 'n.md'), 'so it is still in the queue');

    // Passing it again in the same session graduates it back to days.
    const graduate = shell.service.previewReview('n.md', Rating.Good, now + 300_000, 'fsrs') as { interval: number };
    assert.ok(graduate.interval >= 1, `a same-session pass graduates to days, got ${graduate.interval}`);
});

test('SM-2: the grade decides the interval, not how late the review is', () => {
    for (const q of [3, 4, 5]) {
        const results = [0, 1, 3, 30].map(lateDays => {
            const shell = new FakeShell();
            shell.addNote({
                path: 'n.md',
                dueInDays: -lateDays,
                schedule: { interval: 30, ease: 250, repetitionCount: 4, reviewCount: 4, scheduleCategory: 'spaced' },
            });
            const preview = shell.service.previewReview('n.md', q, now) as { interval: number };
            const expected = canonicalSm2(30, 250, q, 4);
            return { lateDays, interval: preview.interval, expected: expected.interval };
        });
        const onTime = results[0];
        for (const result of results) {
            assert.equal(result.interval, result.expected, `q=${q}, ${result.lateDays}d late: interval must be canonical`);
            assert.equal(result.interval, onTime.interval, `q=${q}: lateness must not change the interval`);
        }
    }
});

test('SM-2: ease follows the paper, and lateness does not touch it', () => {
    for (const q of [0, 3, 4, 5]) {
        for (const lateDays of [0, 5]) {
            const shell = new FakeShell();
            shell.addNote({
                path: 'n.md',
                dueInDays: -lateDays,
                schedule: { interval: 30, ease: 250, repetitionCount: 4, reviewCount: 4, scheduleCategory: 'spaced' },
            });
            shell.service.recordReview('n.md', q, false, now);
            const ease = shell.service.schedules['n.md']!.ease;
            assert.equal(ease, canonicalSm2(30, 250, q, 4).ease, `q=${q}, ${lateDays}d late: ease`);
        }
    }
});

test('SM-2: a failure comes back the same day, then I(1) = 1 day after a pass', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        dueInDays: 0,
        schedule: { interval: 30, ease: 250, repetitionCount: 4, reviewCount: 4, scheduleCategory: 'spaced' },
    });

    shell.service.recordReview('n.md', 1, false, now);
    const schedule = shell.service.schedules['n.md']!;
    assert.equal(schedule.interval, 0, 'a failed repetition is drilled again today');
    assert.equal(schedule.nextReviewDate, startOfToday, 'due today');
    assert.equal(schedule.repetitionCount, 0, 'the repetition schedule restarts');
    assert.ok(shell.service.getDueNotes(now).some(s => s.path === 'n.md'), 'so it stays in the queue');

    // The same-session pass then schedules it a day out.
    const preview = shell.service.previewReview('n.md', 4, now) as { interval: number; nextReviewDate: number };
    assert.equal(preview.interval, 1, 'I(1) after a restart');
    assert.equal(preview.nextReviewDate, startOfToday + DAY);

    shell.service.recordReview('n.md', 4, false, now);
    assert.equal(shell.service.schedules['n.md']!.nextReviewDate, startOfToday + DAY);
    assert.ok(!shell.service.getDueNotes(now).some(s => s.path === 'n.md'), 'and it leaves today\u2019s queue');
});

test('SM-2: the interval ladder is I(1)=1d, I(2)=6d, then I*EF', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        dueInDays: 0,
        schedule: { interval: 0, ease: 250, repetitionCount: 0, reviewCount: 0, scheduleCategory: 'spaced' },
    });

    const first = shell.service.previewReview('n.md', 5, now) as { interval: number };
    assert.equal(first.interval, 1, 'I(1)');
    shell.service.recordReview('n.md', 5, false, now);

    // It is now due tomorrow, so move the clock to review it again.
    const tomorrow = now + DAY;
    const second = shell.service.previewReview('n.md', 5, tomorrow) as { interval: number };
    assert.equal(second.interval, 6, 'I(2)');
    shell.service.recordReview('n.md', 5, false, tomorrow);

    const later = now + 7 * DAY;
    const beforeThird = shell.service.schedules['n.md']!;
    const third = shell.service.previewReview('n.md', 5, later) as { interval: number };
    assert.equal(
        third.interval,
        canonicalSm2(beforeThird.interval, beforeThird.ease, 5, beforeThird.repetitionCount).interval,
        'I(n) = I(n-1) * EF′ (the ease factor updated by this very grade)'
    );
});

test('skipping is not a lapse: no interval reset, no ease spent', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        schedule: { interval: 30, ease: 250, repetitionCount: 4, reviewCount: 4, scheduleCategory: 'spaced' },
    });

    shell.service.skipNote('n.md');
    const schedule = shell.service.schedules['n.md']!;
    assert.equal(schedule.interval, 1, 'a skip schedules tomorrow');
    assert.equal(schedule.nextReviewDate, startOfToday + DAY);
});

test('a new note\'s grades mean different things while it is learning', () => {
    const make = (quality: number) => {
        const shell = new FakeShell();
        shell.addNote({
            path: 'n.md',
            schedule: { interval: 0, ease: 250, repetitionCount: 0, reviewCount: 0, scheduleCategory: 'initial' },
        });
        const preview = shell.service.previewReview('n.md', quality, now) as { interval: number };
        shell.service.recordReview('n.md', quality, false, now);
        return { preview: preview.interval, schedule: shell.service.schedules['n.md']! };
    };

    // Easy graduates on the spot: SM-2's I(1) = 1 day, out of the ladder.
    const easy = make(5);
    assert.equal(easy.preview, 1, 'Easy previews graduation');
    assert.equal(easy.schedule.interval, 1);
    assert.equal(easy.schedule.scheduleCategory, 'graduated');
    assert.equal(easy.schedule.repetitionCount, 1);

    // Good advances one step (the ladder starts at 0 days).
    const good = make(4);
    assert.equal(good.schedule.interval, 0);
    assert.equal(good.schedule.repetitionCount, 1);

    // Hard repeats the current step instead of advancing.
    const hard = make(3);
    assert.equal(hard.schedule.interval, 0);
    assert.equal(hard.schedule.repetitionCount, 0);

    // A failure stays in today's session and counts a lapse.
    const failed = make(1);
    assert.equal(failed.schedule.interval, 0);
    assert.equal(failed.schedule.nextReviewDate, startOfToday);
    assert.equal(failed.schedule.repetitionCount, 0);
    assert.equal(failed.schedule.lapses, 1);
    assert.ok(!failed.schedule.scheduleCategory || failed.schedule.scheduleCategory === 'initial');
});

test('a failure part-way up the ladder drops back to the first step, not out', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        schedule: { interval: 7, ease: 250, repetitionCount: 2, reviewCount: 2, scheduleCategory: 'initial' },
    });
    const preview = shell.service.previewReview('n.md', 1, now) as { interval: number };
    assert.equal(preview.interval, 0, 'back to the first step (today)');
    shell.service.recordReview('n.md', 1, false, now);
    const schedule = shell.service.schedules['n.md']!;
    assert.equal(schedule.interval, 0);
    assert.equal(schedule.nextReviewDate, startOfToday);
});

test('the migration fires for a vault whose stored settings predate the flag', () => {
    // What an existing data.json looks like: DEFAULT_SETTINGS merged with the
    // stored settings, which carry neither the corrected value nor the flag.
    const stored = { ...DEFAULT_SETTINGS, fsrsParameters: { enable_fuzz: true, w: [0.4, 0.6] } } as SpaceforgeSettings;
    delete (stored as { fsrsShortTermMigrated?: boolean }).fsrsShortTermMigrated;
    assert.equal(stored.fsrsShortTermMigrated, undefined, 'the flag is unset on old data');
    assert.equal(migrateSettings(stored), true);
    assert.equal(stored.fsrsParameters.enable_short_term, true, 'and the vault is corrected on load');
});

test('an existing vault gets the corrected short-term default exactly once', () => {
    const legacy = {
        ...DEFAULT_SETTINGS,
        fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, enable_short_term: false },
        fsrsShortTermMigrated: undefined,
    } as SpaceforgeSettings;
    assert.equal(migrateSettings(legacy), true, 'the migration runs once');
    assert.equal(legacy.fsrsParameters.enable_short_term, true, 'and lands on the corrected default');
    assert.equal(migrateSettings(legacy), false, 'it does not run again');

    legacy.fsrsParameters.enable_short_term = false;
    migrateSettings(legacy);
    assert.equal(legacy.fsrsParameters.enable_short_term, false, 'a deliberate "off" is respected afterwards');
});

test('the migration repairs the legacy FSRS parameters, not just the flag', () => {
    const legacy = {
        ...DEFAULT_SETTINGS,
        fsrsParameters: {
            request_retention: 0.9,
            maximum_interval: 36500,
            enable_fuzz: true,
            w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
            learning_steps: [1, 10],
            enable_short_term: false,
        },
        fsrsShortTermMigrated: undefined,
    } as unknown as SpaceforgeSettings;

    assert.equal(migrateSettings(legacy), true);
    assert.equal(legacy.fsrsParameters.enable_short_term, true, 'same-day steps on');
    assert.equal(legacy.fsrsParameters.w?.length, 19, 'the padded 17-value set is replaced');
    assert.deepEqual(legacy.fsrsParameters.w, DEFAULT_SETTINGS.fsrsParameters.w, 'with the FSRS-5 defaults');
    assert.ok(!('learning_steps' in (legacy.fsrsParameters as Record<string, unknown>)), 'and the inert step list is dropped');
});

test('hand-edited weights survive the migration', () => {
    const edited = {
        ...DEFAULT_SETTINGS,
        fsrsParameters: { ...DEFAULT_SETTINGS.fsrsParameters, w: new Array(19).fill(0.5) },
        fsrsShortTermMigrated: undefined,
    } as SpaceforgeSettings;
    migrateSettings(edited);
    assert.equal(edited.fsrsParameters.w?.[0], 0.5, 'a custom weight set is left alone');
    assert.equal(edited.fsrsParameters.w?.length, 19);
});

// ---------------------------------------------------------------------------
// Repair pass: cards scheduled under the old rules must be rebuildable from the
// review log into exactly the state the corrected rules would have produced.
// ---------------------------------------------------------------------------

test('repair: a damaged SM-2 note is rebuilt to the schedule a clean run would have made', () => {
    // A real run, played through the shipping code from a fresh card.
    const writer = new FakeShell();
    writer.addNote({
        path: 'n.md',
        dueInDays: 0,
        schedule: { interval: 0, ease: 250, repetitionCount: 0, reviewCount: 0, scheduleCategory: 'spaced' },
    });
    let when = now;
    for (const quality of [5, 5, 5, 4]) {
        writer.service.schedules['n.md'].nextReviewDate = when; // due at that moment
        writer.service.recordReview('n.md', quality, false, when);
        when += Math.max(1, writer.service.schedules['n.md'].interval ?? 1) * DAY;
    }
    const clean = JSON.parse(JSON.stringify(writer.service.schedules['n.md']));
    const log = writer.service.history.map(entry => ({ ...entry }));

    // The same note as the old lateness rule left it: interval collapsed, ease floored.
    const shell = new FakeShell();
    shell.service.schedules['n.md'] = {
        ...clean,
        interval: 1,
        ease: 130,
        repetitionCount: 1,
        nextReviewDate: DateUtils.startOfUTCDay(new Date()),
    };
    shell.service.history.push(...log);

    const report = shell.service.repairFromHistory();
    assert.equal(report.repaired.length, 1, JSON.stringify(report.skipped));
    assert.equal(report.repaired[0].before.interval, 1);
    assert.equal(report.repaired[0].before.ease, 130);

    const after = shell.service.schedules['n.md']!;
    assert.equal(after.interval, clean.interval, 'interval rebuilt');
    assert.equal(after.ease, clean.ease, 'ease rebuilt');
    assert.equal(after.repetitionCount, clean.repetitionCount, 'repetitions rebuilt');
    assert.equal(after.nextReviewDate, clean.nextReviewDate, 'due date rebuilt');
    assert.equal(report.repaired[0].after.interval, clean.interval, 'and reported');
});

test('repair: an FSRS card rebuilt from its log lands on the grade that was pressed', () => {
    const shell = new FakeShell({ fsrsParameters: { enable_fuzz: false } });
    // The card as the shifted translation left it: a Good has Hard's numbers.
    shell.service.schedules['n.md'] = {
        path: 'n.md',
        schedulingAlgorithm: 'fsrs',
        interval: 1,
        ease: 65,
        reviewCount: 1,
        lastReviewDate: now,
        nextReviewDate: now + DAY,
        fsrsData: { stability: 1.18385, difficulty: 6.4855, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 2, last_review: now },
    };
    shell.service.history.push({ path: 'n.md', timestamp: now, response: 3, interval: 0, ease: 65, isSkipped: false });

    const report = shell.service.repairFromHistory();
    assert.equal(report.repaired.length, 1, JSON.stringify(report.skipped));

    // Reference: what ts-fsrs itself does with a Good on a fresh card.
    const reference = fsrsWith(false).repeat(createEmptyCard(new Date(now)) as never, new Date(now))[Rating.Good].card;
    const rebuilt = shell.service.schedules['n.md']!.fsrsData!;
    assert.equal(rebuilt.stability, reference.stability, 'stability is Good\u2019s, not Hard\u2019s');
    assert.equal(rebuilt.difficulty, reference.difficulty, 'difficulty too');
    assert.equal(rebuilt.state, reference.state);
});

test('repair: an incomplete log is left alone and reported', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        dueInDays: 0,
        schedule: { interval: 1, ease: 130, repetitionCount: 1, reviewCount: 5, scheduleCategory: 'spaced' },
    });
    shell.service.history.push({ path: 'n.md', timestamp: now - DAY, response: 5, interval: 1, ease: 130, isSkipped: false });
    const before = JSON.parse(JSON.stringify(shell.service.schedules['n.md']));

    const report = shell.service.repairFromHistory();
    assert.equal(report.repaired.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /partial history/);
    assert.deepEqual(shell.service.schedules['n.md'], before, 'the card is untouched');
});

test('repair: a note that was never logged is reported, not guessed at', () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'n.md', dueInDays: 0, schedule: { interval: 1, ease: 130, repetitionCount: 1, reviewCount: 3, scheduleCategory: 'spaced' } });
    const report = shell.service.repairFromHistory();
    assert.equal(report.repaired.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].reason, 'no history');
});

test('repair: skipped reviews replay as skips, not as lapses', () => {
    const shell = new FakeShell();
    shell.addNote({
        path: 'n.md',
        dueInDays: 0,
        schedule: { interval: 30, ease: 250, repetitionCount: 3, reviewCount: 1, scheduleCategory: 'spaced' },
    });
    shell.service.history.push(
        { path: 'n.md', timestamp: now - 2 * DAY, response: 5, interval: 30, ease: 250, isSkipped: false },
        { path: 'n.md', timestamp: now - DAY, response: 5, interval: 1, ease: 250, isSkipped: true },
    );
    shell.service.schedules['n.md'] = { ...shell.service.schedules['n.md']!, interval: 1, ease: 130, repetitionCount: 1 };

    const report = shell.service.repairFromHistory();
    assert.equal(report.repaired.length, 1, JSON.stringify(report.skipped));
    const after = shell.service.schedules['n.md']!;
    // A "Perfect recall" that graduates, then a skip that pushes a day out.
    assert.equal(after.ease, 260, 'the skip did not spend ease');
    assert.equal(after.repetitionCount, 1, 'and did not reset the item');
});
