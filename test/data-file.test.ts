import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectRecoverableCandidates,
    corruptBackupPath,
    goodCopyPath,
    isRecoverableName,
    isUnusableDataBody,
    mergePluginStates,
    parsePluginData,
    readTextOrNull,
    schedulesOf,
    writeJsonAtomically,
    type DataFileAdapter,
    type PluginDataShape,
} from '../utils/data-file';

/** The bit of the vault adapter these helpers use, over a plain map. */
function fakeAdapter(files: Record<string, string> = {}, options: { refuseRename?: boolean; refuseRenameOver?: boolean } = {}) {
    const store = new Map(Object.entries(files));
    const log: string[] = [];
    const adapter: DataFileAdapter = {
        async read(path) {
            log.push(`read ${path}`);
            const value = store.get(path);
            if (value === undefined) throw new Error(`no such file: ${path}`);
            return value;
        },
        async write(path, data) {
            log.push(`write ${path}`);
            store.set(path, data);
        },
        async rename(from, to) {
            log.push(`rename ${from} -> ${to}`);
            if (options.refuseRename) throw new Error('EPERM');
            if (options.refuseRenameOver && store.has(to)) throw new Error('Destination file already exists!');
            const value = store.get(from);
            if (value === undefined) throw new Error(`no such file: ${from}`);
            store.delete(from);
            store.set(to, value);
        },
        async remove(path) {
            log.push(`remove ${path}`);
            store.delete(path);
        },
        async list(path) {
            const files = [...store.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'));
            return { files, folders: [] };
        },
        async exists(path) {
            return store.has(path);
        },
        async mkdir() { /* not needed */ },
    };
    return { adapter, store, log };
}

const state = (schedules: string[], history: unknown[] = []): PluginDataShape => ({
    settings: { baseEase: 250 },
    pluginState: {
        schedules: Object.fromEntries(schedules.map(path => [path, { path, interval: 3 }])),
        history,
    },
});

test('atomic write replaces the file without ever renaming onto an existing name', async () => {
    // Obsidian's adapter refuses a rename whose destination exists, so the swap has
    // to move the old copy aside first.
    const { adapter, store, log } = fakeAdapter({ 'dir/data.json': '{"old":true}' }, { refuseRenameOver: true });
    await writeJsonAtomically(adapter, 'dir/data.json', { hello: 'world' });

    assert.deepEqual(log, [
        'write dir/data.json.tmp',
        'rename dir/data.json -> dir/data.json.previous',
        'rename dir/data.json.tmp -> dir/data.json',
    ]);
    assert.equal(store.get('dir/data.json'), JSON.stringify({ hello: 'world' }, null, 2));
    assert.equal(JSON.parse(store.get('dir/data.json.previous')!).old, true, 'the file it replaced is kept');
    assert.equal(store.has('dir/data.json.tmp'), false, 'no temp file left behind');
});

test('an existing previous copy is cleared rather than renamed over', async () => {
    const { adapter, log } = fakeAdapter({
        'dir/data.json': '{"old":true}',
        'dir/data.json.previous': '{"older":true}',
    }, { refuseRenameOver: true });
    await writeJsonAtomically(adapter, 'dir/data.json', { hello: 'world' });
    assert.ok(log.includes('remove dir/data.json.previous'), 'the stale previous copy is removed first');
});

test('a crash between the two renames still leaves the data recoverable', async () => {
    // Simulate: the new copy was written and the old one moved aside, then the app died.
    const { adapter } = fakeAdapter({
        'dir/data.json.previous': JSON.stringify(state(['a.md', 'b.md'])),
        'dir/data.json.tmp': '',
    });
    const candidates = await collectRecoverableCandidates(adapter, 'dir');
    assert.deepEqual(candidates.map(entry => entry.name), ['data.json.previous']);
    assert.equal(candidates[0].schedules, 2);
});

test('atomic write falls back to a direct write when the adapter cannot rename', async () => {
    const { adapter, store } = fakeAdapter({}, { refuseRename: true });
    const warnings: string[] = [];
    await writeJsonAtomically(adapter, 'dir/data.json', { kept: true }, message => warnings.push(message));

    assert.equal(JSON.parse(store.get('dir/data.json')!).kept, true, 'the data still lands');
    assert.match(warnings[0], /falling back/i);
});

test('an interrupted write is recognised as unusable, a real file is not', () => {
    assert.equal(isUnusableDataBody(''), true);
    assert.equal(isUnusableDataBody('   \n'), true);
    assert.equal(isUnusableDataBody('{"settings": {"base'), true, 'truncated mid-object');
    assert.equal(isUnusableDataBody('[1,2'), true);
    assert.equal(isUnusableDataBody('{"settings":{}}'), false);
    assert.equal(parsePluginData(''), null);
    assert.equal(parsePluginData(null), null);
    assert.equal(parsePluginData('[]'), null, 'an array is not a saved state');
    assert.deepEqual(Object.keys(schedulesOf(parsePluginData('{"settings":{}}'))), []);
});

test('candidates are collected by name and ranked by how much they hold', async () => {
    const { adapter } = fakeAdapter({
        'plugins/sf/data.json': '',
        'plugins/sf/data.json.good': JSON.stringify(state(['a.md', 'b.md', 'c.md'])),
        'plugins/sf/data.json.backup-2026-01-01T00-00-00': JSON.stringify(state(['a.md'], [{ path: 'a.md', timestamp: 1 }])),
        'plugins/sf/data (conflicted copy 2026-01-02 030405).json': JSON.stringify(state(['a.md', 'b.md', 'c.md', 'd.md'])),
        'plugins/sf/data.json.tmp': JSON.stringify(state(['z.md'])),
        'plugins/sf/main.js': 'not json',
        'plugins/sf/notes.md': JSON.stringify(state(['z.md'])),
    });
    const candidates = await collectRecoverableCandidates(adapter, 'plugins/sf');

    assert.deepEqual(candidates.map(entry => entry.name), [
        'data (conflicted copy 2026-01-02 030405).json',
        'data.json.good',
        'data.json.backup-2026-01-01T00-00-00',
        'data.json.tmp',
    ], 'the richest first, unrelated files ignored');
    assert.equal(candidates[0].schedules, 4);
    assert.equal(candidates[2].history, 1);
    assert.equal(candidates[3].schedules, 1, 'a complete temp file is still a source');
});

test('recoverable names are the backup shapes only', () => {
    assert.equal(isRecoverableName('data.json'), false, 'the live file is not its own fallback');
    assert.equal(isRecoverableName('data.json.tmp'), true, 'a complete temp copy counts');
    assert.equal(isRecoverableName('data.json.tmp.tmp'), false);
    assert.equal(isRecoverableName('data.json.good'), true);
    assert.equal(isRecoverableName('data.json.previous'), true);
    assert.equal(isRecoverableName('data.json.backup-2026-01-01T00-00-00'), true);
    assert.equal(isRecoverableName('data.json.bak-2026-10-17-051956'), true);
    assert.equal(isRecoverableName('data.json.corrupt-2026-01-01T00-00-00'), true);
    assert.equal(isRecoverableName('data (conflicted copy 2026-10-15 071145).json'), true);
    assert.equal(isRecoverableName('main.js'), false);
    assert.equal(isRecoverableName('data.jsonc'), false);
});

test('merging adds what is missing and leaves what is there alone', () => {
    const current = state(['keep.md'], [{ path: 'keep.md', timestamp: 5 }]);
    (schedulesOf(current) as Record<string, { interval: number }>)['keep.md'].interval = 99;
    const incoming = state(['keep.md', 'revived.md'], [
        { path: 'keep.md', timestamp: 5 },
        { path: 'revived.md', timestamp: 7 },
    ]);

    const { merged, addedSchedules, addedHistory } = mergePluginStates(current, incoming);
    assert.deepEqual(addedSchedules, ['revived.md']);
    assert.equal(addedHistory, 1, 'the duplicate history entry is not added twice');
    const schedules = schedulesOf(merged) as Record<string, { interval: number }>;
    assert.equal(schedules['keep.md'].interval, 99, 'the current state wins for a note it has');
    assert.equal(schedules['revived.md'].interval, 3);
    assert.equal((merged.pluginState!.history as unknown[]).length, 2);
    assert.equal(merged.settings?.baseEase, 250, 'settings are untouched');
});

test('merging an unparsable candidate changes nothing', () => {
    const current = state(['only.md']);
    const { merged, addedSchedules } = mergePluginStates(current, null);
    assert.equal(merged, current, 'same object back');
    assert.deepEqual(addedSchedules, []);
});

test('the good copy and the preserved corrupt file get predictable names', () => {
    assert.equal(goodCopyPath('plugins/sf/data.json'), 'plugins/sf/data.json.good');
    assert.equal(corruptBackupPath('plugins/sf/data.json', Date.UTC(2026, 0, 2, 3, 4, 5)), 'plugins/sf/data.json.corrupt-2026-01-02T03-04-05');
});

test('reading a missing file is null, not a throw', async () => {
    const { adapter } = fakeAdapter({});
    assert.equal(await readTextOrNull(adapter, 'nope/data.json'), null);
});
