import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyPlanService, type IntegrityProgressStore } from '../services/study-plan-service';
import { mergePluginStates, studyRecordCount } from '../utils/data-file';
import { mergeProgress, projectProgress } from '../services/progress-mirror';
import { DEFAULT_SETTINGS } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA } from '../models/plugin-data';
import { createObjectiveProgress } from '../models/study';

function setup() {
    const plugin = { settings: { ...DEFAULT_SETTINGS } } as never;
    const service = new StudyPlanService(plugin, {}, {}, {});
    const chart = (titles: string[], body = 'body') => service.buildPlanFromChart('folder/a.md', body, {
        objectives: titles.map(title => ({ title, statement: `${title} describes its own distinct explanatory mechanism and consequences` })),
    }, 'general');
    const original = chart(['Alpha', 'Beta']);
    service.savePlan(original);
    const store = service.ensureProgress(original) as IntegrityProgressStore;
    store.objectives['obj-1'].U = 3;
    store.objectives['obj-2'].U = 1;
    return { service, chart, original, store };
}

test('repeated merge against original retains identity and never swaps mastery', () => {
    const { service, chart, original, store } = setup();
    store.scheduleSuggestions = [{ objectiveId: 'obj-1', inDays: 3, madeAt: 1, provisional: true }];
    const fresh = chart(['Beta', 'Alpha'], 'changed');
    fresh.objectives[1].prerequisites = [fresh.objectives[0].id];
    for (let pass = 0; pass < 3; pass++) {
        const result = service.mergePlans(original, fresh);
        assert.deepEqual(result.plan.objectives.map(o => o.id), ['obj-2', 'obj-1']);
        assert.equal(store.objectives['obj-1'].U, 3);
        assert.equal(store.objectives['obj-2'].U, 1);
        assert.deepEqual(result.plan.objectives[1].prerequisites, ['obj-2']);
        assert.equal(store.scheduleSuggestions[0].objectiveId, 'obj-1');
    }
});

test('partial merges retain unseen progress; final archives definitions and keeps visuals', () => {
    const { service, chart, original, store } = setup();
    original.visuals = { sourceHash: 'last-good' } as never;
    service.mergePlans(original, chart(['Beta'], 'changed'), { final: false });
    assert.equal(store.objectives['obj-1'].U, 3);
    const final = service.mergePlans(original, chart(['Beta'], 'changed'), { final: true });
    assert.equal(final.plan.visuals?.sourceHash, 'last-good');
    assert.equal(store.objectives['obj-1'], undefined);
    assert.equal(store.archivedObjectives?.['obj-1'].progress.U, 3);
    assert.equal(store.archivedObjectives?.['obj-1'].objective.title, 'Alpha');
});

test('new objective identity never reuses retired IDs, even after reload', () => {
    const { service, chart, original } = setup();
    const replacement = chart(['Gamma'], 'changed');
    // Avoid any fuzzy-continuation inference for the new idea.
    replacement.objectives[0].statement = 'Unrelated entirely new subject';
    const first = service.mergePlans(original, replacement).plan;
    assert.ok(!['obj-1', 'obj-2'].includes(first.objectives[0].id));
    const reloaded = new StudyPlanService({ settings: DEFAULT_SETTINGS } as never,
        JSON.parse(JSON.stringify(service.plans)), JSON.parse(JSON.stringify(service.progress)), {});
    const next = chart(['Delta'], 'again');
    next.objectives[0].statement = 'Another unrelated subject';
    const second = reloaded.mergePlans(first, next).plan;
    assert.notEqual(first.objectives[0].id, second.objectives[0].id);
});

test('backup merge restores Study-only collections without replacing existing records', () => {
    const { original, store } = setup();
    const result = mergePluginStates({ pluginState: {
        studyPlans: {} as Record<string, typeof original>,
        studyProgress: {} as Record<string, typeof store>,
        studySessions: {} as Record<string, { id: string; startedAt: number }[]>,
    } }, {
        pluginState: { studyPlans: { 'folder/a.md': original }, studyProgress: { 'folder/a.md': store }, studySessions: { 'folder/a.md': [{ id: 's', startedAt: 1 }] } },
    });
    assert.deepEqual(result.merged.pluginState.studyPlans['folder/a.md'], original);
    assert.deepEqual(result.merged.pluginState.studyProgress['folder/a.md'], store);
    assert.equal(result.merged.pluginState.studySessions['folder/a.md'][0].id, 's');
});

function mirror(local: object, remote: object) {
    const state = { ...DEFAULT_PLUGIN_STATE_DATA, ...local };
    const envelope = projectProgress(DEFAULT_SETTINGS, { ...DEFAULT_PLUGIN_STATE_DATA, ...remote }, { rev: 1, device: 'remote', version: 'test' });
    return mergeProgress({ settings: DEFAULT_SETTINGS, state }, envelope, { preferOtherSettings: false });
}

test('Study-only mirror addition reports a durable change and newest sessions come first', () => {
    const { original } = setup();
    const result = mirror({}, { studyPlans: { n: original }, studySessions: { n: [{ id: 'old', startedAt: 1 }, { id: 'new', startedAt: 2 }] } });
    assert.ok(result.report.replaced.includes('studyPlans'));
    assert.equal(result.report.addedSessions, 2);
    assert.deepEqual(result.state.studySessions.n.map(s => s.id), ['new', 'old']);
});

test('mirror merges independent objectives by objective clock, not note clock', () => {
    const { original } = setup();
    const base = { notePath: 'n', updatedAt: 20, totalSessions: 0, completedSessions: 0, tutorMemory: [], lastSessionSummary: null, scheduleSuggestions: [] };
    const a = { ...createObjectiveProgress(), U: 3, lastSeenAt: 20 };
    const b = { ...createObjectiveProgress(), U: 2, lastSeenAt: 10 };
    const result = mirror({ studyPlans: { n: original }, studyProgress: { n: { ...base, objectives: { 'obj-1': a, 'obj-2': createObjectiveProgress() } } } },
        { studyPlans: { n: original }, studyProgress: { n: { ...base, updatedAt: 10, objectives: { 'obj-1': createObjectiveProgress(), 'obj-2': b } } } });
    assert.equal(result.state.studyProgress.n.objectives['obj-1'].U, 3);
    assert.equal(result.state.studyProgress.n.objectives['obj-2'].U, 2);
});

test('mirror never attaches reused positional progress to a conflicting definition', () => {
    const { original, chart } = setup();
    const changed = chart(['Other']);
    changed.objectives[0].statement = 'Completely different definition';
    changed.updatedAt = original.updatedAt + 1;
    const result = mirror({ studyPlans: { n: original }, studyProgress: { n: { objectives: { 'obj-1': { ...createObjectiveProgress(), U: 3 } }, updatedAt: 20 } } },
        { studyPlans: { n: changed }, studyProgress: { n: { objectives: { 'obj-1': createObjectiveProgress() }, updatedAt: 10 } } });
    assert.equal(result.state.studyProgress.n.objectives['obj-1'].U, 0);
});

test('rename moves folder descendants and embedded paths; missing retains; forget prevents mirror resurrection', () => {
    const { service, original } = setup();
    service.sessions['folder/a.md'] = [{ id: 's', notePath: 'folder/a.md', startedAt: 1 }] as never;
    assert.equal(service.renameForNote('folder', 'moved'), true);
    assert.equal(service.plans['folder/a.md'], undefined);
    assert.equal(service.plans['moved/a.md'].notePath, 'moved/a.md');
    assert.equal(service.sessions['moved/a.md'][0].notePath, 'moved/a.md');
    const afterRename = mirror({ studyPlans: service.plans, studyProgress: service.progress }, {
        studyPlans: { 'folder/a.md': original }, studyProgress: { 'folder/a.md': { updatedAt: 1, objectives: {} } },
    });
    assert.equal(afterRename.state.studyPlans['folder/a.md'], undefined, 'an offline device must not revive the old binding');
    service.markNoteMissing('moved/a.md');
    assert.ok((service.progress['moved/a.md'] as IntegrityProgressStore).noteMissingAt);
    service.removeForNote('moved/a.md');
    const result = mirror({ studyProgress: service.progress }, { studyPlans: { 'moved/a.md': original }, studyProgress: { 'moved/a.md': { objectives: {}, updatedAt: 1 } } });
    assert.equal(result.state.studyPlans['moved/a.md'], undefined);
    assert.ok((result.state.studyProgress['moved/a.md'] as IntegrityProgressStore).deletedAt);
});

test('workspace checkpoints stay device-local in mirrors but recover from backup', () => {
    const { original, store } = setup();
    const workspace = { schema: 1, id: 'local', threads: {}, activeThreadId: null, updatedAt: 1 };
    const local = { ...store, workspace };
    const state = { ...DEFAULT_PLUGIN_STATE_DATA, studyProgress: { n: local } };
    const projected = projectProgress(DEFAULT_SETTINGS, state as never, { rev: 1, device: 'd', version: 't' });
    assert.equal(projected.state.studyProgress?.n.workspace, undefined);
    const merged = mirror({ studyPlans: { n: original }, studyProgress: { n: local } }, { studyProgress: { n: { ...store, updatedAt: store.updatedAt + 1, workspace: { ...workspace, id: 'remote' } } } });
    assert.equal(merged.state.studyProgress.n.workspace?.id, 'local');
    const backup = { pluginState: { studyProgress: { n: local } } };
    assert.equal(studyRecordCount(backup), 1);
    const recovered = mergePluginStates({ pluginState: {} as Record<string, unknown> }, backup);
    assert.equal((recovered.merged.pluginState.studyProgress as typeof state.studyProgress).n.workspace.id, 'local');
});

test('rename collision refuses all buckets without overwriting the destination', () => {
    const { service, chart } = setup();
    const destination = chart(['Destination']);
    destination.notePath = 'moved/a.md';
    service.savePlan(destination);
    const before = JSON.stringify([service.plans, service.progress, service.sessions]);
    assert.equal(service.renameForNote('folder', 'moved'), false);
    assert.equal(JSON.stringify([service.plans, service.progress, service.sessions]), before);
});

test('a new note created at a receipted path can be charted again', () => {
    const { service, chart } = setup();
    assert.equal(service.renameForNote('folder', 'moved'), true);
    assert.ok((service.progress['folder/a.md'] as IntegrityProgressStore).deletedAt);
    const fresh = chart(['Gamma']);
    assert.equal(service.savePlan(fresh), false, 'a forgotten path refuses the chart');
    assert.equal(service.reviveForNote('folder/a.md'), true);
    assert.equal(service.savePlan(fresh), true);
    assert.ok(service.getPlan('folder/a.md'));
    assert.equal((service.progress['folder/a.md'] as IntegrityProgressStore).deletedAt, undefined);
    assert.equal(service.progress['folder/a.md'].objectives[fresh.objectives[0].id].attempts, 0);
});

test('explicit restore and rename-back supersede old receipts without reviving an old epoch', () => {
    const { service, original, chart } = setup();
    service.renameForNote('folder', 'moved');
    assert.equal(service.renameForNote('moved', 'folder'), true);
    const old = structuredClone(service.progress['folder/a.md']);
    service.removeForNote('folder/a.md');
    const tombstone = structuredClone(service.progress['folder/a.md']);
    service.reviveForNote('folder/a.md');
    service.savePlan(chart(['Alpha']));
    const result = mirror({ studyPlans: service.plans, studyProgress: service.progress },
        { studyPlans: { 'folder/a.md': original }, studyProgress: { 'folder/a.md': { ...old, updatedAt: Number.MAX_SAFE_INTEGER } } });
    assert.equal(result.state.studyProgress['folder/a.md'].objectives['obj-1'].U, 0);
    const withReceipt = mirror(result.state, { studyProgress: { 'folder/a.md': tombstone } });
    assert.ok(withReceipt.state.studyPlans['folder/a.md']);
});

test('final archive survives a partial chart checkpoint and reload', () => {
    const { service, original, chart } = setup();
    service.mergePlans(original, chart(['Beta']), { final: false });
    const reloaded = new StudyPlanService({ settings: DEFAULT_SETTINGS } as never,
        JSON.parse(JSON.stringify(service.plans)), JSON.parse(JSON.stringify(service.progress)), {});
    reloaded.mergePlans(reloaded.plans['folder/a.md'], chart(['Beta']), { final: true });
    assert.equal((reloaded.progress['folder/a.md'] as IntegrityProgressStore).archivedObjectives?.['obj-1'].progress.U, 3);
});

test('duplicate sessions choose their newest checkpoint and forgotten late writers cannot revive records', () => {
    const result = mirror({ studySessions: { n: [{ id: 's', startedAt: 1, endedAt: null, turnCount: 1 }] } },
        { studySessions: { n: [{ id: 's', startedAt: 1, endedAt: 10, turnCount: 3 }] } });
    assert.equal(result.state.studySessions.n[0].turnCount, 3);
    assert.ok(result.report.replaced.includes('studySessions'));
    const { service, original } = setup();
    service.removeForNote(original.notePath);
    service.savePlan(original);
    service.saveSession({ id: 'late', notePath: original.notePath } as never);
    assert.equal(service.plans[original.notePath], undefined);
    assert.equal(service.sessions[original.notePath], undefined);
});

test('portable session copies omit transcripts while a merge keeps the local body', () => {
    const transcript = [{ id: 't1', role: 'user', text: 'private answer' }];
    const projected = projectProgress(DEFAULT_SETTINGS, { ...DEFAULT_PLUGIN_STATE_DATA, studySessions: { n: [{ id: 's', startedAt: 1, transcript, summary: 'private summary' }] } } as never,
        { rev: 1, device: 'd', version: 't' });
    assert.deepEqual(projected.state.studySessions?.n?.[0]?.transcript, []);
    assert.equal(projected.state.studySessions?.n?.[0]?.summary, null);
    const merged = mirror({ studySessions: { n: [{ id: 's', startedAt: 1, transcript, summary: 'private summary' }] } },
        { studySessions: { n: [{ id: 's', startedAt: 1, endedAt: 10, turnCount: 2, transcript: [], summary: null }] } });
    assert.deepEqual(merged.state.studySessions.n[0].transcript, transcript);
    assert.equal(merged.state.studySessions.n[0].summary, 'private summary');
});

test('archived objective state is not resurrected by an older mirror', () => {
    const { service, original, chart, store } = setup();
    const old = JSON.parse(JSON.stringify(store));
    const plan = service.mergePlans(original, chart(['Beta'])).plan;
    const result = mirror({ studyPlans: { n: plan }, studyProgress: { n: store } },
        { studyPlans: { n: original }, studyProgress: { n: old } });
    assert.equal(result.state.studyProgress.n.objectives['obj-1'], undefined);
    assert.equal((result.state.studyProgress.n as IntegrityProgressStore).archivedObjectives?.['obj-1'].progress.U, 3);
});

test('independent-objective sync remains lossless over repeated two-device exchanges', () => {
    const { original, store } = setup();
    let left = { studyPlans: { n: original }, studyProgress: { n: structuredClone(store) } };
    let right = structuredClone(left);
    let seed = 9321;
    for (let round = 1; round <= 100; round++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const l = left.studyProgress.n.objectives['obj-1'];
        const r = right.studyProgress.n.objectives['obj-2'];
        l.attempts += seed % 3 + 1;
        r.attempts += seed % 5 + 1;
        l.lastSeenAt = round;
        r.lastSeenAt = round;
        const expected = [l.attempts, r.attempts];
        const a = mirror(left, right).state;
        const b = mirror(right, left).state;
        for (const state of [a, b]) assert.deepEqual([
            state.studyProgress.n.objectives['obj-1'].attempts,
            state.studyProgress.n.objectives['obj-2'].attempts,
        ], expected, `round ${round}`);
        left = { studyPlans: a.studyPlans, studyProgress: a.studyProgress } as typeof left;
        right = { studyPlans: b.studyPlans, studyProgress: b.studyProgress } as typeof right;
    }
});
