import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyChartQueueService } from '../services/study-chart-queue-service';
import { StudySessionService } from '../services/study-session-service';
import { StudyPlanService } from '../services/study-plan-service';
import { StudyVisualService } from '../services/study-visuals-service';
import { DEFAULT_SETTINGS } from '../models/settings';
import { StudyPlan } from '../models/study';
import { STUDY_VISUAL_VERSION } from '../models/study-visuals';

function harness() {
    const notes = new Map([['a.md', 'original body']]);
    const calls = { materials: 0, questions: 0, saves: 0 };
    let outcome: 'ok' | 'null' | 'throw' = 'ok';
    let hold: Promise<void> | null = null;
    let failSave = false;
    let bytes = '';
    const plugin = {
        settings: { ...DEFAULT_SETTINGS, studyEnabled: true, studyAutoMaterials: false, studyAutoMcq: false, enableMCQ: true },
        app: { vault: {
            getAbstractFileByPath: (path: string) => notes.has(path) ? { path } : null,
            cachedRead: async (file: { path: string }) => notes.get(file.path)!,
        } },
        savePluginData: async () => { calls.saves++; if (failSave) throw new Error('disk full'); bytes = JSON.stringify(plans.plans); },
        mcqController: { ensureMcqSetForNote: async () => { calls.questions++; return {}; } },
        studyVisualService: {
            isStale: StudyVisualService.prototype.isStale,
            generate: async (request: { fingerprint: string }) => {
                calls.materials++;
                if (hold) await hold;
                if (outcome === 'throw') throw new Error('quota exhausted');
                if (outcome === 'null') return null;
                return { version: STUDY_VISUAL_VERSION, sourceHash: request.fingerprint };
            },
        },
    };
    const plans = new StudyPlanService(plugin as never, {}, {}, {});
    plans.plans['a.md'] = {
        notePath: 'a.md', generatedAt: 1, updatedAt: 1, version: 2,
        contentFingerprint: 'old chart hash', domainId: 'general', domainLabel: 'General',
        domainNotes: '', domainOverriddenByUser: false, safetyCritical: false, topicSummary: '',
        objectives: [{ id: 'one', title: 'One', statement: 'Explain one', type: 'fact' as never, importance: 'standard', prerequisites: [], anchors: [] }],
        uncoveredSource: [], tutorMemory: [], images: [], chartState: null, visuals: null,
    } as StudyPlan;
    const queue = new StudyChartQueueService(plugin as never, plans);
    return { plugin, plans, queue, notes, calls, setOutcome: (value: typeof outcome) => { outcome = value; },
        setHold: (value: Promise<void>) => { hold = value; }, failSave: () => { failSave = true; },
        reload: () => new StudyPlanService(plugin as never, JSON.parse(bytes), {}, {}),
    };
}

test('explicit startup/enable reconcile backfills ready legacy plans, but respects opt-outs', async () => {
    const h = harness();
    await h.queue.reconcilePreparation();
    assert.equal(h.calls.materials, 0);
    h.plugin.settings.studyAutoMaterials = true;
    const seen: string[] = [];
    const off = h.queue.subscribePreparation(status => seen.push(status.state));
    await h.queue.reconcilePreparation();
    assert.equal(h.calls.materials, 1);
    assert.equal(h.queue.getPreparationStatus('a.md')?.state, 'ready');
    assert.ok(seen.includes('running'));
    assert.ok(seen.includes('ready'));
    off();
    const count = seen.length;
    await h.queue.reconcilePreparation();
    assert.equal(h.calls.materials, 1);
    assert.equal(seen.length, count, 'fresh pack has no new transition');
});

test('null/error are durable and parked, MCQs remain independent, manual retry works', async () => {
    for (const outcome of ['null', 'throw'] as const) {
        const h = harness();
        h.plugin.settings.studyAutoMaterials = true;
        h.plugin.settings.studyAutoMcq = true;
        h.setOutcome(outcome);
        await h.queue.reconcilePreparation();
        assert.equal(h.queue.getPreparationStatus('a.md')?.materials, 'error');
        assert.match(h.queue.getPreparationStatus('a.md')?.message ?? '', /usable|quota/);
        assert.equal(h.calls.questions, 1);
        const reloaded = new StudyChartQueueService(h.plugin as never, h.reload());
        assert.equal(reloaded.getPreparationStatus('a.md')?.state, 'error');
        await reloaded.reconcilePreparation();
        assert.equal(h.calls.materials, 1, 'no quota retry loop on restart');
        h.setOutcome('ok');
        await h.queue.retryMaterials('a.md');
        assert.equal(h.calls.materials, 2);
        assert.equal(h.queue.getPreparationStatus('a.md')?.materials, 'ready');
    }
});

test('freshness uses current content and schema, never the old chart hash', async () => {
    const h = harness(); h.plugin.settings.studyAutoMaterials = true;
    await h.queue.reconcilePreparation();
    await h.queue.notifyPlanReady('a.md');
    assert.equal(h.calls.materials, 1);
    h.notes.set('a.md', 'edited body');
    await h.queue.notifyPlanReady('a.md');
    assert.equal(h.calls.materials, 2);
    h.plans.getPlan('a.md')!.visuals!.version = -1;
    await h.queue.notifyPlanReady('a.md');
    assert.equal(h.calls.materials, 3);
});

test('pause, stop, cancel, deletion, replacement and content edits fence late attachment', async () => {
    for (const action of ['pause', 'stop', 'cancel', 'delete', 'replace', 'edit', 'disable'] as const) {
        const h = harness(); h.plugin.settings.studyAutoMaterials = true;
        let release!: () => void;
        h.setHold(new Promise<void>(resolve => { release = resolve; }));
        const work = h.queue.notifyPlanReady('a.md');
        while (h.calls.materials === 0) await new Promise(resolve => setTimeout(resolve, 0));
        const original = h.plans.getPlan('a.md')!;
        if (action === 'pause') h.queue.pause();
        if (action === 'stop') h.queue.stop();
        if (action === 'cancel') h.queue.cancel('a.md');
        if (action === 'delete') delete h.plans.plans['a.md'];
        if (action === 'replace') h.plans.plans['a.md'] = { ...original };
        if (action === 'edit') h.notes.set('a.md', 'new body');
        if (action === 'disable') h.plugin.settings.studyAutoMaterials = false;
        release(); await work;
        assert.equal(original.visuals, null, action);
        assert.equal(h.plans.getPlan('a.md')?.visuals ?? null, null, action);
        if (action !== 'delete' && action !== 'replace') assert.equal(h.queue.getPreparationStatus('a.md')?.state, 'interrupted', action);
    }
});

test('concurrent reconcile, ready and manual retry share one pipeline', async () => {
    const h = harness(); h.plugin.settings.studyAutoMaterials = true;
    await Promise.all([h.queue.notifyPlanReady('a.md'), h.queue.reconcilePreparation(), h.queue.retryMaterials('a.md')]);
    assert.equal(h.calls.materials, 1);
});

test('interrupted work recovers on startup but is bounded across repeated crashes', async () => {
    const h = harness(); h.plugin.settings.studyAutoMaterials = true;
    await h.queue.reconcilePreparation();
    const saved = JSON.parse(JSON.stringify(h.plans.plans));
    saved['a.md'].visuals = null;
    saved['a.md'].preparation.state = 'running';
    saved['a.md'].preparation.materials = 'running';
    saved['a.md'].preparation.materialAttempts = 2;
    const plans = new StudyPlanService(h.plugin as never, saved, {}, {});
    const recovered = new StudyChartQueueService(h.plugin as never, plans);
    assert.equal(recovered.getPreparationStatus('a.md')?.state, 'interrupted');
    await recovered.reconcilePreparation();
    assert.equal(h.calls.materials, 2);
    assert.equal(recovered.getPreparationStatus('a.md')?.materialAttempts, 3);
    saved['a.md'].visuals = null;
    saved['a.md'].preparation.state = 'running';
    const exhausted = new StudyChartQueueService(h.plugin as never, plans);
    await exhausted.reconcilePreparation();
    assert.equal(h.calls.materials, 2, 'at most three interrupted automatic attempts');
    await exhausted.retryMaterials('a.md');
    assert.equal(h.calls.materials, 3, 'explicit retry renews consent');
});

test('rename fences the path-bound job and the moved plan can be retried', async () => {
    const h = harness(); h.plugin.settings.studyAutoMaterials = true;
    let release!: () => void;
    h.setHold(new Promise<void>(resolve => { release = resolve; }));
    const work = h.queue.notifyPlanReady('a.md');
    while (h.calls.materials === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const moved = h.plans.plans['a.md'];
    delete h.plans.plans['a.md']; h.plans.plans['b.md'] = moved; moved.notePath = 'b.md';
    h.notes.set('b.md', h.notes.get('a.md')!); h.notes.delete('a.md');
    h.queue.handleRename('a.md', 'b.md');
    release(); await work;
    assert.equal(moved.visuals, null);
    assert.equal(h.queue.getPreparationStatus('b.md')?.state, 'interrupted');
    assert.equal(h.queue.getPreparationStatus('b.md')?.notePath, 'b.md');
    await h.queue.retryMaterials('b.md');
    assert.ok(moved.visuals);
});

test('manual material consent is independent from automatic toggles and emits regeneration', async () => {
    const h = harness();
    await h.queue.retryMaterials('a.md');
    assert.equal(h.calls.materials, 1);
    assert.equal(h.calls.questions, 0);
    await h.queue.retryMaterials('a.md');
    assert.equal(h.calls.materials, 2, 'manual regeneration can replace a fresh pack');
    h.plugin.settings.studyEnabled = false;
    await h.queue.retryMaterials('a.md');
    assert.equal(h.calls.materials, 2, 'Study master switch remains authoritative');
});

test('unreadable notes and persistence failures are visible, not ready', async () => {
    const h = harness(); h.plugin.settings.studyAutoMaterials = true;
    h.notes.delete('a.md');
    await h.queue.notifyPlanReady('a.md');
    assert.equal(h.queue.getPreparationStatus('a.md')?.state, 'error');
    assert.match(h.queue.getPreparationStatus('a.md')?.message ?? '', /read/);
    const disk = harness(); disk.plugin.settings.studyAutoMaterials = true; disk.failSave();
    await disk.queue.notifyPlanReady('a.md');
    assert.equal(disk.calls.materials, 0, 'durable intent required before spending provider quota');
    assert.equal(disk.queue.getPreparationStatus('a.md')?.state, 'error');
    assert.match(disk.queue.getPreparationStatus('a.md')?.message ?? '', /disk full/);
});

test('cancelling questions does not abort an in-flight material step', async () => {
    const h = harness();
    h.plugin.settings.studyAutoMaterials = true;
    h.plugin.settings.studyAutoMcq = true;
    let release!: () => void;
    h.setHold(new Promise<void>(resolve => { release = resolve; }));
    const work = h.queue.notifyPlanReady('a.md');
    while (h.calls.materials === 0) await new Promise(resolve => setTimeout(resolve, 0));
    h.queue.cancelPreparation('a.md', 'questions');
    release();
    await work;
    const status = h.queue.getPreparationStatus('a.md');
    assert.equal(status?.materials, 'ready');
    assert.equal(status?.questions, 'interrupted');
    assert.equal(h.calls.questions, 0);
});

test('cancelling material leaves questions available to the same run', async () => {
    const h = harness();
    h.plugin.settings.studyAutoMaterials = true;
    h.plugin.settings.studyAutoMcq = true;
    let release!: () => void;
    h.setHold(new Promise<void>(resolve => { release = resolve; }));
    const work = h.queue.notifyPlanReady('a.md');
    while (h.calls.materials === 0) await new Promise(resolve => setTimeout(resolve, 0));
    h.queue.cancelPreparation('a.md', 'materials');
    release();
    await work;
    const status = h.queue.getPreparationStatus('a.md');
    assert.equal(status?.materials, 'interrupted');
    assert.equal(h.calls.questions, 1, 'the question step still runs');
    assert.equal(status?.questions, 'ready');
});

test('overlapping ticks cannot chart two notes at once', async () => {
    const h = harness();
    h.plugin.settings.studyAutoChart = true;
    h.notes.set('b.md', 'second body');
    const original = (StudySessionService as any).chart;
    let charts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (StudySessionService as any).chart = async () => { charts += 1; await gate; return null; };
    const read = h.plugin.app.vault.cachedRead;
    h.plugin.app.vault.cachedRead = async (file: { path: string }) => {
        if (file.path === 'a.md') await gate;
        return read(file);
    };
    (h.queue as any).queue = ['a.md', 'b.md'];
    try {
        const first = h.queue.tick();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(await h.queue.tick(), false, 'the second caller sees the lock');
        release();
        assert.equal(await first, true);
        assert.equal(charts, 1);
    } finally {
        (StudySessionService as any).chart = original;
        h.plugin.app.vault.cachedRead = read;
    }
});
