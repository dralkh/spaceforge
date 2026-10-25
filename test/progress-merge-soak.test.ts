/**
 * Two devices, one synced folder, hundreds of interleaved edits.
 *
 * The unit tests prove each rule in isolation; this proves the rules compose.
 * Two devices with their own data files write to and read from one shared
 * folder at random, including through the conflicted copies a sync tool leaves
 * behind, and four properties have to survive every step:
 *
 *  1. no review is ever lost (every history entry either device recorded is present);
 *  2. a note either device scheduled is scheduled on both after a sync;
 *  3. the schedule that survives is the one with the newest review, never an older one;
 *  4. the day counters never walk backwards.
 *
 * The PRNG is seeded, so a failure names a reproducible run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    mergeProgress,
    parseProgress,
    projectProgress,
    readNewestProgress,
    writeProgress,
    PROGRESS_FILE,
    type ProgressAdapter,
    type ProgressEnvelope,
} from '../services/progress-mirror';
import { DEFAULT_SETTINGS, type SpaceforgeSettings } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA, type PluginStateData } from '../models/plugin-data';

/** A tiny deterministic PRNG: the same seed replays the same failures. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function memoryAdapter(files: Map<string, string>): ProgressAdapter {
    return {
        async read(path) {
            const text = files.get(path);
            if (text === undefined) throw new Error(`no such file: ${path}`);
            return text;
        },
        async write(path, data) { files.set(path, data); },
        async exists(path) { return files.has(path); },
        async remove(path) { files.delete(path); },
        async rename(from, to) {
            const text = files.get(from);
            if (text === undefined) throw new Error(`no such file: ${from}`);
            files.set(to, text);
            files.delete(from);
        },
        async list(path) {
            const prefix = `${path}/`;
            const out: string[] = [];
            for (const name of Array.from(files.keys())) {
                if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) out.push(name);
            }
            return { files: out, folders: [] };
        },
    };
}

interface Device {
    name: string;
    settings: SpaceforgeSettings;
    state: PluginStateData;
    rev: number;
}

const ZERO = { again: 0, hard: 0, good: 0, easy: 0 };

function device(name: string): Device {
    return {
        name,
        settings: { ...DEFAULT_SETTINGS, ...({ reviewInterface: 'strip' } as Partial<SpaceforgeSettings>) } as SpaceforgeSettings,
        state: { ...DEFAULT_PLUGIN_STATE_DATA, schedules: {}, history: [], reviewDayStats: {}, calendarEvents: {} } as unknown as PluginStateData,
        rev: 0,
    };
}

function project(target: Device, now: number): ProgressEnvelope {
    target.rev += 1;
    return projectProgress(target.settings, target.state, { rev: target.rev, device: target.name, version: 'test', now });
}

/** What a device does on open: read the newest copy, merge it in. */
async function syncIn(target: Device, adapter: ProgressAdapter): Promise<void> {
    const newest = await readNewestProgress(adapter);
    if (!newest) return;
    const { settings, state } = mergeProgress(
        { settings: target.settings, state: target.state },
        newest.envelope,
        { preferOtherSettings: newest.envelope.device !== target.name },
    );
    target.settings = settings;
    target.state = state;
}

/** A review, as the scheduler would record it: monotonically increasing time. */
function review(target: Device, note: string, at: number): void {
    const schedules = target.state.schedules ?? {};
    const prior = schedules[note];
    schedules[note] = {
        ...(prior ?? { path: note, ease: 250, interval: 0, repetitionCount: 0, consecutive: 0, schedulingAlgorithm: 'sm2' }),
        path: note,
        lastReviewDate: at,
        nextReviewDate: at + 86_400_000,
        interval: ((prior?.interval ?? 0) + 1),
        repetitionCount: ((prior?.repetitionCount ?? 0) + 1),
    } as never;
    target.state.schedules = schedules;

    const history = target.state.history ?? [];
    history.push({ path: note, timestamp: at, response: 3 } as never);
    target.state.history = history;

    const day = new Date(at).toISOString().slice(0, 10);
    const stats = target.state.reviewDayStats ?? {};
    const lane = stats[day]?.notes ?? { learning: ZERO, young: ZERO, mature: ZERO, skipped: 0 };
    stats[day] = {
        ...stats[day],
        notes: { ...lane, learning: { ...lane.learning, good: lane.learning.good + 1 } },
    };
    target.state.reviewDayStats = stats;
}

/**
 * Knobs for a longer soak without slowing CI: `SF_SOAK_SEEDS=40
 * SF_SOAK_STEPS=2000 node --test .test-build/progress-merge-soak.test.js`.
 */
const SEEDS = Number(process.env.SF_SOAK_SEEDS ?? 3);
const STEPS = Number(process.env.SF_SOAK_STEPS ?? 150);

for (let seedIndex = 0; seedIndex < SEEDS; seedIndex += 1) test(`two devices never lose a review, a schedule or a counter (seed ${seedIndex + 1} of ${SEEDS}, ${STEPS} steps)`, async () => {
    const random = prng(20_261_025 + seedIndex * 7919);
    const folder = new Map<string, string>();
    const adapter = memoryAdapter(folder);
    const laptop = device('laptop');
    const phone = device('phone');
    const notes = ['a.md', 'b.md', 'c.md', 'd.md'];
    const seenReviews = new Set<string>();
    let clock = 1_790_000_000_000;

    for (let step = 0; step < STEPS; step += 1) {
        const actor = random() < 0.5 ? laptop : phone;
        const other = actor === laptop ? phone : laptop;
        const note = notes[Math.floor(random() * notes.length)];

        if (random() < 0.75) {
            clock += 60_000;
            review(actor, note, clock);
            seenReviews.add(`${note}@${clock}`);
        } else {
            // A preference the reader changed; it should follow the last writer.
            actor.settings.reviewInterface = actor.settings.reviewInterface === 'strip' ? 'dock' : 'strip';
        }

        // One full round trip: the actor publishes, the other reads and
        // republishes what it now knows, the actor reads that back. Occasionally
        // the publish lands in the copy a sync tool would have left behind.
        const publish = async (who: Device) => {
            const envelope = project(who, clock);
            if (random() < 0.15) {
                folder.set('spaceforge/state/progress (conflicted copy).json', JSON.stringify(envelope, null, 2));
            } else {
                await writeProgress(adapter, envelope);
            }
        };
        await publish(actor);
        await syncIn(other, adapter);
        await publish(other);
        await syncIn(actor, adapter);

        for (const target of [laptop, phone]) {
            const histories = (target.state.history ?? []).map(item => `${item.path}@${item.timestamp}`);
            const present = new Set(histories);
            for (const entry of Array.from(seenReviews)) {
                assert.ok(present.has(entry), `${target.name} lost review ${entry} at step ${step}`);
            }
            assert.equal(histories.length, present.size, `${target.name} duplicated a review at step ${step}`);
        }
        const laptopNotes = Object.keys(laptop.state.schedules ?? {});
        const phoneNotes = Object.keys(phone.state.schedules ?? {});
        assert.deepEqual(laptopNotes.sort(), phoneNotes.sort(), `the two devices disagree about which notes are scheduled at step ${step}`);
        for (const path of laptopNotes) {
            assert.equal(
                laptop.state.schedules[path].lastReviewDate,
                phone.state.schedules[path].lastReviewDate,
                `the two devices disagree about when ${path} was last reviewed, at step ${step}`,
            );
        }
        const days = new Set([...Object.keys(laptop.state.reviewDayStats ?? {}), ...Object.keys(phone.state.reviewDayStats ?? {})]);
        for (const day of Array.from(days)) {
            const a = laptop.state.reviewDayStats?.[day]?.notes?.learning.good ?? 0;
            const b = phone.state.reviewDayStats?.[day]?.notes?.learning.good ?? 0;
            assert.equal(a, b, `the two devices disagree about ${day}'s count, at step ${step}`);
        }
    }

    // And the newest review of each note is the one standing.
    for (const path of Object.keys(laptop.state.schedules ?? {})) {
        const latest = Math.max(...Array.from(seenReviews)
            .filter(entry => entry.startsWith(`${path}@`))
            .map(entry => Number(entry.split('@')[1])));
        assert.equal(laptop.state.schedules[path].lastReviewDate, latest, `an older review of ${path} won`);
    }
});
