/**
 * The vault-side projection: what travels, what stays, and what a merge keeps.
 *
 * The property that matters most here is that a merge can never lose a review:
 * every case below either adds records or leaves the local side alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    hashOf,
    isProgressConflictCopy,
    LOCAL_ONLY_SETTINGS,
    LOCAL_ONLY_STATE,
    PORTABLE_STATE_KEYS,
    mergeProgress,
    newDeviceId,
    parseProgress,
    projectProgress,
    readNewestProgress,
    retireConflictCopies,
    SECRET_SETTING_PATTERN,
    writeProgress,
    PROGRESS_FILE,
    type ProgressAdapter,
    type ProgressEnvelope,
} from '../services/progress-mirror';
import { DEFAULT_SETTINGS, type SpaceforgeSettings } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA, type PluginStateData } from '../models/plugin-data';

/** An adapter over a Map, with the rename the atomic write needs. */
function memoryAdapter(initial: Record<string, string> = {}): ProgressAdapter & { files: Map<string, string> } {
    const files = new Map(Object.entries(initial));
    return {
        files,
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
            // Obsidian's real adapter returns vault-relative paths, not bare
            // names; the service has to cope with that shape.
            const prefix = `${path}/`;
            const out: string[] = [];
            for (const name of Array.from(files.keys())) {
                if (!name.startsWith(prefix)) continue;
                const rest = name.slice(prefix.length);
                if (!rest.includes('/')) out.push(name);
            }
            return { files: out, folders: [] };
        },
    };
}

function schedule(path: string, lastReviewDate: number | null, nextReviewDate: number) {
    return {
        path,
        lastReviewDate,
        nextReviewDate,
        ease: 250,
        interval: 3,
        repetitionCount: 2,
        reviewCount: 2,
        consecutive: 2,
        schedulingAlgorithm: 'sm2',
    };
}

function stateWith(overrides: Partial<PluginStateData>): PluginStateData {
    return { ...DEFAULT_PLUGIN_STATE_DATA, ...overrides } as PluginStateData;
}

// ------------------------------------------------------------ what travels

test('the projection carries progress and prefs, and leaves device settings behind', () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        ankiConnectUrl: 'http://192.168.1.9:8765',
        ankiConnectEnabled: true,
        customDataPath: 'elsewhere',
        cliExtraPath: '/opt/bin',
        openRouterApiKey: 'sk-should-not-travel',
        reviewInterface: 'strip',
    } as unknown as typeof DEFAULT_SETTINGS;

    const state = stateWith({
        schedules: { 'notes/a.md': schedule('notes/a.md', 1000, 2000) },
        history: [{ path: 'notes/a.md', timestamp: 1000, response: 3 } as never],
        deckSitting: { deckPath: 'decks/x.md' } as never,
        noteRun: { notePath: 'notes/a.md' } as never,
        pomodoroIsRunning: true,
        reviewDayStats: {},
    });

    const envelope = projectProgress(settings, state, { rev: 4, device: 'dev', version: '1.2.3', now: 555 });

    assert.equal(envelope.rev, 4);
    assert.equal(envelope.updatedAt, 555);
    assert.equal(envelope.schema, 1);
    assert.equal(envelope.settings.ankiConnectUrl, undefined, 'the Anki address names this machine');
    assert.equal(envelope.settings.ankiConnectEnabled, undefined, 'and whether it is on is this machine’s business');
    assert.equal(envelope.settings.customDataPath, undefined);
    assert.equal(envelope.settings.cliExtraPath, undefined);
    assert.equal((envelope.settings as Record<string, unknown>).openRouterApiKey, undefined, 'a credential never travels');
    assert.equal(envelope.settings.reviewInterface, 'strip', 'a preference does');

    const travelling = PORTABLE_STATE_KEYS.filter(key => !LOCAL_ONLY_STATE.includes(key)).sort();
    assert.deepEqual(Object.keys(envelope.state).sort(), travelling, 'the travelling state, and nothing else');
    assert.equal('deckSitting' in envelope.state, false, 'where a sitting stopped is this device’s');
    assert.equal('noteRun' in envelope.state, false);
    assert.equal('pomodoroIsRunning' in envelope.state, false);
});

test('every setting that looks like a credential stays out of the projection', () => {
    const envelope = projectProgress(DEFAULT_SETTINGS, stateWith({}), { rev: 1, device: 'dev', version: '1' });
    const carried = envelope.settings as Record<string, unknown>;
    const settings = DEFAULT_SETTINGS as unknown as Record<string, unknown>;

    const credentialShaped = Object.keys(settings).filter(key => SECRET_SETTING_PATTERN.test(key));
    assert.ok(credentialShaped.includes('openRouterApiKey'), 'the pattern still recognises the keys this plugin has');
    for (const key of credentialShaped) {
        assert.equal(carried[key], undefined, `${key} must not travel`);
    }

    // And the hand-written list is honest: every name in it exists, and none of
    // them travels either.
    for (const key of LOCAL_ONLY_SETTINGS) {
        assert.ok(key in settings, `${key} is listed as local-only but is not a setting any more`);
        assert.equal(carried[key], undefined, `${key} is listed as local-only and must not travel`);
    }

    assert.equal(carried.reviewInterface, DEFAULT_SETTINGS.reviewInterface, 'an ordinary preference does travel');
});

// ----------------------------------------------------------------- merging

test('two devices keep each other’s reviews, and the newer review of a note wins', () => {
    const local = {
        settings: { ...DEFAULT_SETTINGS, reviewInterface: 'strip' } as SpaceforgeSettings,
        state: stateWith({
            schedules: {
                'notes/a.md': schedule('notes/a.md', 5000, 9000),
                'notes/b.md': schedule('notes/b.md', 4000, 8000),
            } as never,
        }),
    };
    const other: ProgressEnvelope = {
        schema: 1,
        rev: 9,
        updatedAt: 9000,
        device: 'phone',
        version: '1.2.3',
        settings: { reviewInterface: 'dock' } as never,
        state: {
            schedules: {
                // Reviewed later on the phone: this one should win.
                'notes/a.md': schedule('notes/a.md', 7000, 12000),
                // A note this device has never seen: added.
                'notes/c.md': schedule('notes/c.md', 6000, 11000),
            } as never,
        },
    };

    const { state, report } = mergeProgress(local, other, { preferOtherSettings: false });

    assert.equal(state.schedules['notes/a.md'].lastReviewDate, 7000, 'the newer review wins');
    assert.equal(state.schedules['notes/b.md'].lastReviewDate, 4000, 'a note only this device has is untouched');
    assert.equal(state.schedules['notes/c.md'].lastReviewDate, 6000, 'a note only the other device has is added');
    assert.deepEqual(report.addedSchedules, ['notes/c.md']);
});

test('a review log is unioned, not replaced, and never grows past its cap', () => {
    const entry = (path: string, timestamp: number) => ({ path, timestamp, response: 3 });
    const local = { settings: DEFAULT_SETTINGS as SpaceforgeSettings, state: stateWith({ history: [entry('a.md', 1), entry('b.md', 2)] as never }) };
    const other: ProgressEnvelope = {
        schema: 1, rev: 2, updatedAt: 2, device: 'phone', version: '1',
        settings: {},
        state: { history: [entry('b.md', 2), entry('c.md', 3)] as never },
    };

    const { state, report } = mergeProgress(local, other, { preferOtherSettings: false });
    assert.deepEqual(state.history.map(item => item.path).sort(), ['a.md', 'b.md', 'c.md'], 'no review is counted twice, none is dropped');
    assert.equal(report.addedHistory, 1);
});

test('day counters only ever move forward', () => {
    const local = { settings: DEFAULT_SETTINGS as SpaceforgeSettings, state: stateWith({ reviewDayStats: { '2026-10-20': { notes: { reviews: 5, agains: 1 } } } as never }) };
    const other: ProgressEnvelope = {
        schema: 1, rev: 1, updatedAt: 1, device: 'phone', version: '1',
        settings: {},
        state: { reviewDayStats: { '2026-10-20': { notes: { reviews: 3, agains: 4 } } } as never },
    };
    const { state } = mergeProgress(local, other, { preferOtherSettings: false });
    assert.deepEqual(state.reviewDayStats?.['2026-10-20']?.notes, { reviews: 5, agains: 4 }, 'the larger count of each field wins');
});

test('preferences are taken from the side that wrote last, and only then', () => {
    const local = { settings: { ...DEFAULT_SETTINGS, reviewInterface: 'strip' } as SpaceforgeSettings, state: stateWith({}) };
    const other: ProgressEnvelope = {
        schema: 1, rev: 1, updatedAt: 1, device: 'phone', version: '1',
        settings: { reviewInterface: 'dock' } as never,
        state: {},
    };

    const quiet = mergeProgress(local, other, { preferOtherSettings: false });
    assert.equal(quiet.settings.reviewInterface, 'strip');

    const loud = mergeProgress(local, other, { preferOtherSettings: true });
    assert.equal(loud.settings.reviewInterface, 'dock');
    assert.deepEqual(loud.report.replaced, ['reviewInterface']);
});

test('a merge never takes a device setting from the other side', () => {
    const local = { settings: { ...DEFAULT_SETTINGS, ankiConnectUrl: 'http://127.0.0.1:8765' } as SpaceforgeSettings, state: stateWith({}) };
    const other: ProgressEnvelope = {
        schema: 1, rev: 1, updatedAt: 1, device: 'phone', version: '1',
        settings: { ankiConnectUrl: 'http://192.168.1.9:8765' } as never,
        state: {},
    };
    const { settings } = mergeProgress(local, other, { preferOtherSettings: true });
    assert.equal(settings.ankiConnectUrl, 'http://127.0.0.1:8765');
});

// -------------------------------------------------------------- the files

test('a projection is written atomically and skipped when nothing changed', async () => {
    const adapter = memoryAdapter();
    const envelope = projectProgress(DEFAULT_SETTINGS, stateWith({}), { rev: 1, device: 'dev', version: '1', now: 10 });

    const first = await writeProgress(adapter, envelope);
    assert.equal(first.written, true);
    assert.equal(adapter.files.has(PROGRESS_FILE), true);
    assert.equal(adapter.files.has(`${PROGRESS_FILE}.tmp`), false, 'the temp file does not outlive the write');
    assert.equal(parseProgress(adapter.files.get(PROGRESS_FILE) ?? null)?.rev, 1);

    const again = await writeProgress(adapter, envelope, { lastHash: first.hash });
    assert.equal(again.written, false, 'an unchanged projection is not rewritten');

    const forced = await writeProgress(adapter, { ...envelope, rev: 2 }, { lastHash: first.hash });
    assert.equal(forced.written, true);
    assert.notEqual(forced.hash, first.hash, 'and a changed one is');
});

test('an adapter that refuses to rename over an existing file still gets the write', async () => {
    const adapter = memoryAdapter();
    const strict = {
        ...adapter,
        async rename(from: string, to: string) {
            if (adapter.files.has(to)) throw new Error('destination exists');
            return adapter.rename(from, to);
        },
    };
    const first = projectProgress(DEFAULT_SETTINGS, stateWith({}), { rev: 1, device: 'dev', version: '1', now: 1 });
    const second = projectProgress(DEFAULT_SETTINGS, stateWith({}), { rev: 2, device: 'dev', version: '1', now: 2 });
    assert.equal((await writeProgress(strict, first)).written, true);
    assert.equal((await writeProgress(strict, second)).written, true, 'the second write is not lost');
    assert.equal(parseProgress(adapter.files.get(PROGRESS_FILE) ?? null)?.rev, 2);
});

test('a sync tool’s copy is recognised, and the newest copy is the one read', async () => {
    assert.equal(isProgressConflictCopy('progress (conflicted copy 2026-10-21).json'), true);
    assert.equal(isProgressConflictCopy('progress.sync-conflict-20261021-120000-ABCDEF.json'), true);
    assert.equal(isProgressConflictCopy('progress 2.json'), true);
    assert.equal(isProgressConflictCopy('progress (1).json'), true);
    assert.equal(isProgressConflictCopy('progress.json'), false);
    assert.equal(isProgressConflictCopy('notes.md'), false);

    const older = projectProgress(DEFAULT_SETTINGS, stateWith({ history: [{ path: 'a.md', timestamp: 1 } as never] }), { rev: 1, device: 'phone', version: '1', now: 100 });
    const newer = projectProgress(DEFAULT_SETTINGS, stateWith({ history: [{ path: 'a.md', timestamp: 1 } as never, { path: 'b.md', timestamp: 2 } as never] }), { rev: 3, device: 'phone', version: '1', now: 300 });
    const adapter = memoryAdapter({
        [PROGRESS_FILE]: JSON.stringify(older),
        [`spaceforge/state/progress (conflicted copy).json`]: JSON.stringify(newer),
    });

    const newest = await readNewestProgress(adapter);
    assert.equal(newest?.envelope.rev, 3);
    assert.deepEqual(newest?.copies, ['progress (conflicted copy).json']);

    const moved = await retireConflictCopies(adapter, newest?.copies ?? []);
    assert.deepEqual(moved, ['progress (conflicted copy).json']);
    assert.equal(adapter.files.has('spaceforge/state/.merged/progress (conflicted copy).json'), true, 'set aside, not deleted');
});

test('an unreadable projection is refused rather than half-trusted', () => {
    assert.equal(parseProgress(''), null);
    assert.equal(parseProgress('{'), null);
    assert.equal(parseProgress('{"rev": "one"}'), null);
    assert.equal(parseProgress('{"rev": 1, "updatedAt": 2, "state": {}}')?.rev, 1);
});

test('a device id is random and says nothing about the machine', () => {
    const first = newDeviceId();
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.notEqual(first, newDeviceId());
    assert.equal(hashOf('a'), hashOf('a'));
    assert.notEqual(hashOf('a'), hashOf('b'));
});
