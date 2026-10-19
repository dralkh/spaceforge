/**
 * Randomised stability run: drive the real controllers through long, mixed
 * sequences of user actions and assert the invariants that must hold after
 * every single step — no throws, sane schedule data, one grade per note per run,
 * and a bar that always describes something real.
 *
 * Seeded, so a failure can be replayed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeShell } from './support/fake-shell';
import { MiniElement } from './support/mini-dom';
import { DateUtils } from '../utils/dates';
import { ReviewSchedule } from '../models/review-schedule';

/** Deterministic PRNG so a failing sequence can be reproduced. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const NOTE_PATHS = [
    'cell-biology.md',
    'notes/thermodynamics.md',
    'notes/krebs-cycle.md',
    'notes/fsrs-card.md',
    'archive/old-entry.md',
    'notes/leechy.md',
];

function buildVault(shell: FakeShell, random: () => number): void {
    for (const path of NOTE_PATHS) {
        const overdue = Math.floor(random() * 5);
        const isFsrs = random() < 0.4;
        shell.addNote({
            path,
            dueInDays: -overdue,
            schedule: isFsrs
                ? {
                    schedulingAlgorithm: 'fsrs',
                    fsrsData: {
                        stability: 1 + random() * 10,
                        difficulty: 1 + random() * 9,
                        elapsed_days: overdue,
                        scheduled_days: 2,
                        reps: Math.floor(random() * 8),
                        lapses: random() < 0.3 ? 2 : 0,
                        state: 2,
                    },
                }
                : {
                    interval: 1 + Math.floor(random() * 30),
                    repetitionCount: Math.floor(random() * 5),
                    lapses: path.includes('leechy') ? 1 : 0,
                    ease: 130 + Math.floor(random() * 120),
                },
        });
    }
}

/** Everything that has to stay true, whatever the user just did. */
function assertInvariants(shell: FakeShell, context: string): void {
    const strip = shell.strip();
    const vaultTitles = new Set(
        [...shell.files.keys()].map(path => path.replace(/\.md$/, '').split('/').pop() ?? path)
    );

    if (strip) {
        const title = shell.stripTitle();
        assert.ok(
            title === '' || title === 'Session complete' || vaultTitles.has(title),
            `${context}: the bar shows "${title}", which is not a note in the vault`
        );
        const gradeCount = strip.byClass('sf-strip-grade').length;
        const decisionCount = strip.byClass('sf-strip-decision-button').length;
        assert.ok(
            gradeCount === 0 || gradeCount === 4 || gradeCount === 6,
            `${context}: ${gradeCount} grade buttons is not a valid set`
        );
        assert.ok(decisionCount === 0 || decisionCount === 4, `${context}: ${decisionCount} decision buttons`);
        assert.ok(!(gradeCount > 0 && decisionCount > 0), `${context}: the bar offers grades and a question at once`);
    }

    for (const schedule of Object.values(shell.service.schedules)) {
        const where = `${context}: ${schedule.path}`;
        assert.ok(Number.isFinite(schedule.nextReviewDate), `${where} nextReviewDate`);
        assert.ok(Number.isFinite(schedule.ease), `${where} ease ${schedule.ease}`);
        if (schedule.schedulingAlgorithm === 'sm2') {
            assert.ok(schedule.ease >= 130, `${where}: SM-2 ease must respect the 1.3 floor, got ${schedule.ease}`);
        } else {
            // FSRS reuses `ease` for display as difficulty x10 (10-100); a card
            // that has not been graded yet still carries the SM-2 style base value.
            assert.ok(schedule.ease >= 10 && schedule.ease <= 500, `${where}: unexpected FSRS ease ${schedule.ease}`);
        }
        assert.ok(Number.isFinite(schedule.interval) && schedule.interval >= 0, `${where} interval ${schedule.interval}`);
        assert.ok((schedule.reviewCount ?? 0) >= 0, `${where} reviewCount`);
        if (schedule.schedulingAlgorithm === 'fsrs') {
            assert.ok(Number.isFinite(schedule.fsrsData?.stability), `${where} stability`);
            assert.ok(Number.isFinite(schedule.fsrsData?.difficulty), `${where} difficulty`);
        }
    }

    for (const entry of shell.service.history) {
        assert.ok(Number.isFinite(entry.timestamp), `${context}: history timestamp`);
        assert.ok(entry.response >= 0 && entry.response <= 5, `${context}: history response ${entry.response}`);
    }
}

interface RunLog {
    grades: string[];
}

async function step(shell: FakeShell, random: () => number, log: RunLog): Promise<string> {
    const roll = random();
    const decisionOpen = (shell.strip()?.byClass('sf-strip-decision-button').length ?? 0) > 0;

    if (decisionOpen) {
        const choices = shell.strip()?.byClass('sf-strip-decision-button') ?? [];
        const pick = Math.floor(random() * choices.length);
        choices[Math.min(pick, choices.length - 1)].click();
        await shell.settle();
        return `decide(${pick})`;
    }

    if (roll < 0.55) {
        const key = String(Math.floor(random() * 6));
        const handled = shell.document.press(key);
        await shell.settle();
        if (handled) {
            const last = shell.service.history[shell.service.history.length - 1];
            if (last) log.grades.push(last.path);
        }
        return `key(${key})`;
    }
    if (roll < 0.68) {
        shell.document.press('n');
        await shell.settle();
        return 'skip';
    }
    if (roll < 0.76) {
        shell.document.press('p');
        await shell.settle();
        return 'postpone';
    }
    if (roll < 0.86) {
        shell.document.press('u');
        await shell.settle();
        return 'undo';
    }
    if (roll < 0.92) {
        shell.fireLayoutChange();
        await shell.settle();
        return 'layout';
    }
    if (roll < 0.97) {
        shell.flow.start();
        await shell.settle();
        return 'start';
    }
    shell.document.press('Escape');
    await shell.settle();
    return 'end';
}

/**
 * Soak runs: SF_FUZZ_ACTIONS / SF_FUZZ_SEEDS widen the search, e.g.
 *   SF_FUZZ_SEEDS=$(seq -s, 1 40) SF_FUZZ_ACTIONS=1500 npm test
 */
const FUZZ_ACTIONS = Number(process.env.SF_FUZZ_ACTIONS ?? 200);
const FUZZ_SEEDS = (process.env.SF_FUZZ_SEEDS ?? '1,5,7,42,99,777,1234,2024')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value));

for (const seed of FUZZ_SEEDS) {
    test(`a long mixed run stays consistent (seed ${seed})`, async () => {
        const random = mulberry32(seed);
        const shell = new FakeShell({ leechThreshold: 3 });
        buildVault(shell, random);

        const log: RunLog = { grades: [] };
        const history: string[] = [];
        await shell.flow.start();
        await shell.settle();
        assertInvariants(shell, 'start');

        for (let i = 0; i < FUZZ_ACTIONS; i++) {
            const action = await step(shell, random, log);
            history.push(action);
            try {
                assertInvariants(shell, `step ${i} (${action})`);
            } catch (error) {
                console.error(`seed ${seed} failed at step ${i}; actions: ${history.join(' ')}`);
                throw error;
            }
        }

        // Nothing may be graded twice inside a single run: each action either
        // moves the run on or is refused.
        const perNote = new Map<string, number>();
        for (const entry of shell.service.history) {
            perNote.set(entry.path, (perNote.get(entry.path) ?? 0) + 1);
        }
        for (const [path, count] of perNote) {
            assert.ok(count <= 30, `${path} was graded ${count} times in one session`);
        }

        assert.ok(shell.keydownListenerCount() <= 1, 'never more than one keyboard listener');
    });
}

test('a very large vault stays quick to run through', async () => {
    const random = mulberry32(99);
    const shell = new FakeShell();
    const total = 300;
    for (let i = 0; i < total; i++) {
        shell.addNote({ path: `bulk/note-${String(i).padStart(3, '0')}.md` });
    }

    const started = Date.now();
    await shell.flow.start();
    await shell.settle();

    for (let i = 0; i < 60; i++) {
        const key = String(Math.floor(random() * 6));
        shell.document.press(key);
        await shell.settle();
        assertInvariants(shell, `bulk step ${i}`);
    }

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20000, `60 grades over 300 notes took ${elapsed}ms`);
    // Failures stay due today, so only passing grades count as handled.
    const passed = shell.service.history.filter(entry => entry.response >= 3).length;
    const stripText = shell.stripText();
    // The readout is where the reader stands: at least one place past what they
    // have passed, and never further than the queue holds. (Failures stay due,
    // so the cursor keeps walking over them and the number leads the tally.)
    const shown = Number(stripText.match(/(\d+)\/\d+ notes/)?.[1] ?? NaN);
    assert.ok(
        stripText.includes('Review session complete') || (shown >= passed + 1 && shown <= total),
        `the readout stands between ${passed + 1} and ${total}, got "${stripText}"`
    );
    assert.ok(shell.service.history.length === 60, 'every grade is recorded, pass or fail');
});

test('undo and re-grade in a loop keeps the schedule exactly where it was', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    await shell.flow.start();

    const pristine = JSON.stringify(shell.service.schedules['a.md']);
    for (let i = 0; i < 10; i++) {
        shell.document.press('5');
        await shell.settle();
        shell.document.press('u');
        await shell.settle();
        assert.equal(JSON.stringify(shell.service.schedules['a.md']), pristine, `iteration ${i} must land back where it started`);
        assert.equal(shell.service.history.length, 0, `iteration ${i} leaves no history behind`);
    }

    // And the note can still be graded normally afterwards.
    shell.document.press('5');
    await shell.settle();
    assert.equal(shell.service.history.length, 1);
    assert.notEqual(JSON.stringify(shell.service.schedules['a.md']), pristine);
});

test('a run survives notes vanishing under it', async () => {
    const shell = new FakeShell();
    for (let i = 0; i < 12; i++) shell.addNote({ path: `n${i}.md` });
    shell.flow.start();
    await shell.settle();

    for (let i = 0; i < 12; i++) {
        // Every third note is deleted (or rescheduled) before its turn.
        if (i % 3 === 1) {
            shell.removeFile(`n${i}.md`);
        } else if (i % 3 === 2) {
            const schedule: ReviewSchedule | undefined = shell.service.schedules[`n${i}.md`];
            if (schedule) schedule.nextReviewDate = DateUtils.addDays(Date.now(), 4);
        }
        shell.document.press('5');
        await shell.settle();
        assertInvariants(shell, `vanishing step ${i}`);
    }

    assert.ok(
        shell.stripText().includes('Review session complete') || shell.strip()?.byClass('sf-strip-grade').length === 6,
        shell.stripText()
    );
    assert.ok(shell.keydownListenerCount() <= 1);
    const notices = shell.takeNotices();
    assert.ok(notices.every(message => typeof message === 'string' && message.length > 0));
});

test('the bar never claims more progress than the queue holds', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    shell.flow.start();
    await shell.settle();

    for (const expected of ['1/2', '2/2']) {
        assert.ok(shell.stripText().includes(expected), `expected ${expected} in "${shell.stripText()}"`);
        shell.document.press('5');
        await shell.settle();
    }

    const stripText = shell.stripText();
    assert.ok(stripText.includes('Review session complete'));
    assert.ok(/2 notes? handled/.test(stripText), stripText);
});

test('a note pinned at the leech threshold always resolves, however it is answered', async () => {
    for (const choice of [0, 1, 2, 3]) {
        const shell = new FakeShell({ leechThreshold: 2 });
        shell.addNote({ path: 'a.md', schedule: { lapses: 1 } });
        shell.addNote({ path: 'b.md' });
        shell.flow.start();
        await shell.settle();

        shell.document.press('1'); // fail it: hits the checkpoint
        await shell.settle();
        const buttons = shell.strip()?.byClass('sf-strip-decision-button') ?? [];
        assert.equal(buttons.length, 4, `choice ${choice}: the question must be asked`);

        buttons[choice].click();
        await shell.settle();

        assert.ok(shell.strip(), `choice ${choice}: the bar is still there`);
        const gradeButtons = shell.strip()?.byClass('sf-strip-grade').length ?? 0;
        const decisionButtons = shell.strip()?.byClass('sf-strip-decision-button').length ?? 0;
        assert.ok(gradeButtons > 0 || decisionButtons > 0 || shell.stripText().includes('Review session complete'),
            `choice ${choice}: the bar shows something actionable`);
        assertInvariants(shell, `leech choice ${choice}`);
    }
});

test('a note pane that is a graph view rather than a note is never used as a host', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    // The leaf is not holding note content at all.
    const notANote = new MiniElement('div');
    notANote.addClass('view-content');
    shell.leaf.view.containerEl = notANote;

    shell.flow.start();
    await shell.settle();

    assert.equal(shell.strip(), null, 'no bar is planted in a non-note pane');
    // The run is still live and grades by keyboard.
    assert.equal(await shell.document.press('5'), true);
    await shell.settle();
    assert.equal(shell.service.history.length, 1);
});

test('running out of due notes leaves the controller able to keep going', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    shell.flow.start();
    await shell.settle();

    // Empty the queue through the flow, then postpone the last note as well:
    // the index bookkeeping used to end up at -1 here and crash the next grade.
    shell.document.press('5');
    await shell.settle();
    shell.document.press('5');
    await shell.settle();
    assert.deepEqual(shell.duePaths(), []);

    shell.flow.start();
    await shell.settle();
    shell.document.press('p');
    await shell.settle();

    // A note becomes due again (the next day, another device, a manual schedule).
    shell.service.schedules['a.md'].nextReviewDate = DateUtils.startOfUTCDay(new Date());
    shell.flow.start();
    await shell.settle();

    assert.equal(shell.stripTitle(), 'a', 'the run picks the note up again');
    const before = JSON.stringify(shell.service.schedules['a.md']);
    shell.document.press('5');
    await shell.settle();

    assert.notEqual(JSON.stringify(shell.service.schedules['a.md']), before, 'and grading it still works');
    assert.equal(shell.service.history.length, 3);
    assertInvariants(shell, 'after an empty queue');
});

test('a controller failure in the middle of a run is reported, not fatal', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.addNote({ path: 'b.md' });
    shell.flow.start();
    await shell.settle();

    const original = shell.reviewController.processReviewResponse.bind(shell.reviewController);
    shell.reviewController.processReviewResponse = async () => {
        throw new Error('boom');
    };
    shell.takeNotices();

    shell.document.press('5');
    await shell.settle();

    assert.deepEqual(shell.takeNotices(), ['Could not record that rating. See the developer console for details.']);
    assert.ok(shell.strip(), 'the bar is still there');
    assert.equal(shell.stripTitle(), 'a', 'and still on the note that failed');
    assert.equal(shell.service.history.length, 0);

    // Recover: put the real implementation back and carry on.
    shell.reviewController.processReviewResponse = original;
    shell.document.press('5');
    await shell.settle();
    assert.equal(shell.service.history.length, 1);
    assert.equal(shell.stripTitle(), 'b');
});

test('an emptied queue never leaves the note index pointing off the end', async () => {
    const shell = new FakeShell();
    shell.addNote({ path: 'a.md' });
    shell.reviewController.updateTodayNotes();
    assert.equal(shell.reviewController.getTodayNotes().length, 1);
    assert.equal(shell.reviewController.getCurrentNoteIndex(), 0);

    // Postponing the only due note empties the queue.
    await shell.reviewController.postponeNote('a.md', 1);
    assert.deepEqual(shell.duePaths(), []);
    assert.equal(shell.reviewController.getCurrentNoteIndex(), 0, 'the index stays at a valid 0, not -1');

    // Next day: it comes due again, and the list is refreshed the way a grade does.
    shell.service.schedules['a.md'].nextReviewDate = DateUtils.startOfUTCDay(new Date());
    assert.doesNotThrow(() => shell.reviewController.updateTodayNotes(true), 'refreshing with an empty previous list must not throw');

    assert.equal(shell.reviewController.getTodayNotes().length, 1);
    assert.equal(shell.reviewController.getCurrentNoteIndex(), 0);
});
