import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_SETTINGS } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA } from '../models/plugin-data';

/** Exercise the shipping plugin save/recovery boundary, not a service-only fake. */
function pluginHarness() {
    const requireCjs = createRequire(import.meta.url);
    const Module = requireCjs('module') as { _load: (id: string, parent?: unknown, isMain?: boolean) => unknown };
    const original = Module._load;
    const classes = new Proxy({} as Record<string, unknown>, {
        get(target, name: string) {
            if (name === '__esModule') return true;
            return target[name] ?? (target[name] = class {});
        },
    });
    Module._load = function (id, parent, isMain) {
        return id === 'obsidian' || id === 'electron' ? classes : original.call(this, id, parent, isMain);
    };
    let Plugin: { prototype: object };
    try {
        const bundlePath = path.resolve('main.js');
        assert.ok(fs.existsSync(bundlePath), 'build main.js before exercising its storage boundary');
        delete requireCjs.cache[bundlePath];
        Plugin = requireCjs(bundlePath).default;
    } finally {
        Module._load = original;
    }
    const files = new Map<string, string>();
    let fail = false;
    const adapter = {
        read: async (p: string) => { if (!files.has(p)) throw new Error('not found'); return files.get(p)!; },
        write: async (p: string, value: string) => { if (fail) throw new Error('disk full'); files.set(p, value); },
        exists: async (p: string) => files.has(p),
        list: async (dir: string) => ({ files: [...files.keys()].filter(p => p.startsWith(`${dir}/`)), folders: [] }),
        stat: async () => ({ mtime: 10 }),
        remove: async (p: string) => { files.delete(p); },
        mkdir: async () => undefined,
    };
    const state = structuredClone(DEFAULT_PLUGIN_STATE_DATA);
    const plugin = Object.assign(Object.create(Plugin.prototype), {
        settings: structuredClone(DEFAULT_SETTINGS), pluginState: state,
        manifest: { id: 'spaceforge', version: 'test' },
        app: { vault: { adapter, configDir: '.obsidian', getRoot: () => ({ path: '' }), getAbstractFileByPath: () => null } },
        reviewScheduleService: { schedules: {}, customNoteOrder: [], lastLinkAnalysisTimestamp: null },
        reviewHistoryService: { history: [] }, reviewSessionService: { reviewSessions: { sessions: {}, activeSessionId: null } },
        mcqService: { mcqSets: {}, mcqSessions: {} },
        studyPlanService: { plans: {}, progress: {}, sessions: {} },
        statsService: { reviewDayStats: {}, deckHistory: [] },
        scheduleProgressProjection: () => undefined,
    });
    return { plugin, files, setFailure: (value: boolean) => { fail = value; }, dataPath: '.obsidian/plugins/spaceforge/data.json' };
}

test('the real plugin save retains nested objective workspace data on disk', async () => {
    const h = pluginHarness();
    const workspace = { schema: 1, id: 'note-stable', threads: { objective: { draft: 'unfinished answer', pendingPrompt: { text: 'Exact pending question' } } } };
    h.plugin.studyPlanService.progress['note.md'] = { notePath: 'note.md', workspace };
    await h.plugin.savePluginData();
    const saved = JSON.parse(h.files.get(h.dataPath)!);
    assert.deepEqual(saved.pluginState.studyProgress['note.md'].workspace, workspace);
    assert.deepEqual(h.plugin.pluginState.studyProgress['note.md'].workspace, workspace);
});

test('a failed durable save resolves false, and the next save can recover without losing the draft', async () => {
    const h = pluginHarness();
    h.plugin.studyPlanService.progress['note.md'] = { workspace: { draft: 'keep me' } };
    h.setFailure(true);
    assert.equal(await h.plugin.savePluginData(), false);
    h.setFailure(false);
    assert.equal(await h.plugin.savePluginData(), true);
    assert.equal(JSON.parse(h.files.get(h.dataPath)!).pluginState.studyProgress['note.md'].workspace.draft, 'keep me');
});

test('a corrupt primary recovers a Study-only backup even without scheduled notes', async () => {
    const h = pluginHarness();
    const progress = { 'note.md': { notePath: 'note.md', updatedAt: 30, workspace: { draft: 'recover me' } } };
    h.files.set(h.dataPath, '{broken');
    h.files.set(`${h.dataPath}.previous`, JSON.stringify({ settings: {}, pluginState: { studyProgress: progress, studyPlans: {}, studySessions: {} } }));
    const recovered = await h.plugin.readDataFileWithRecovery(h.dataPath);
    assert.deepEqual(recovered.pluginState.studyProgress, progress);
});

test('a valid Study-only primary does not resurrect deleted state from an older backup', async () => {
    const h = pluginHarness();
    const state = { settings: {}, pluginState: { studyProgress: { 'note.md': { workspace: { draft: 'current' } } } } };
    h.files.set(h.dataPath, JSON.stringify(state));
    h.files.set(`${h.dataPath}.previous`, JSON.stringify({ settings: {}, pluginState: { schedules: { 'old.md': { nextReviewDate: '2020-01-01' } }, studyProgress: { 'note.md': { workspace: { draft: 'old' } } } } }));
    const recovered = await h.plugin.readDataFileWithRecovery(h.dataPath);
    assert.equal(recovered.pluginState.studyProgress['note.md'].workspace.draft, 'current');
    assert.equal(recovered.pluginState.schedules, undefined);
});

test('a zero-byte primary still recovers a valid Study-only previous copy', async () => {
    const h = pluginHarness();
    const progress = { 'note.md': { notePath: 'note.md', updatedAt: 40, workspace: { draft: 'from the previous copy' } } };
    h.files.set(h.dataPath, '');
    h.files.set(`${h.dataPath}.previous`, JSON.stringify({ settings: {}, pluginState: { studyProgress: progress } }));
    const recovered = await h.plugin.readDataFileWithRecovery(h.dataPath);
    assert.equal(recovered.pluginState.studyProgress['note.md'].workspace.draft, 'from the previous copy');
});

test('a legacy pre-workspace primary stays readable beside a newer backup', async () => {
    const h = pluginHarness();
    const legacy = { settings: {}, pluginState: { studyProgress: { 'note.md': { notePath: 'note.md', objectives: {}, totalSessions: 2 } } } };
    h.files.set(h.dataPath, JSON.stringify(legacy));
    h.files.set(`${h.dataPath}.previous`, JSON.stringify({ settings: {}, pluginState: { studyProgress: { 'note.md': { workspace: { draft: 'newer but not authoritative' } } } } }));
    const recovered = await h.plugin.readDataFileWithRecovery(h.dataPath);
    assert.equal(recovered.pluginState.studyProgress['note.md'].totalSessions, 2);
    assert.equal(recovered.pluginState.studyProgress['note.md'].workspace, undefined);
});
