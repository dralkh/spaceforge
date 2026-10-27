import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyPlanService } from '../services/study-plan-service';
import { StudySessionService } from '../services/study-session-service';
import { StudyWebSearchService } from '../services/study-web-search-service';
import { StudyMode, StudySessionEvent } from '../models/study';
import { DEFAULT_SETTINGS } from '../models/settings';
import { repairStudyWorkspace } from '../models/study-workspace';
import { StudyController } from '../controllers/study-controller';

const options = { mode: StudyMode.Guided, webSearch: false, turnLimit: 20, freshStart: false };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const response = (id: string, evidence = false) => ({ text: JSON.stringify({ stage: 'retrieve', objectiveId: id, say: `Teaching ${id}`, next: { kind: 'question', text: `Question ${id}`, format: 'mcq', objectiveId: id, choices: ['yes', 'no'], correctIndex: 0, expect: 'yes', hint: 'think', difficulty: 2 }, ...(evidence ? { verdict: { correct: true, errorCategory: 'success' }, progress: { objectiveId: id, U: 2, R: 2, T: 1 } } : {}) }) });
function harness(saved?: any) {
    let disk: any = saved;
    let fail = false;
    let saves = 0;
    const plugin: any = { settings: { ...DEFAULT_SETTINGS }, savePluginData: async () => {
        saves += 1;
        if (!fail) disk = clone({ plans: plans.plans, progress: plans.progress, sessions: plans.sessions });
        return !fail;
    } };
    const plans = new StudyPlanService(plugin, saved?.plans ?? {}, saved?.progress ?? {}, saved?.sessions ?? {});
    const plan = plans.getPlan('n.md') ?? plans.buildPlanFromChart('n.md', 'Alpha beta', { objectives: ['Alpha', 'Beta'].map(title => ({ title, statement: `${title} has independent causal reasoning and specific mechanisms`, type: 'mechanism', anchors: [] })) }, 'general');
    plans.savePlan(plan);
    const make = (freshStart = false) => new StudySessionService(plugin, plans, new StudyWebSearchService(plugin), 'n.md', 'Alpha beta', plan, { ...options, freshStart });
    return { plans, make, disk: () => disk, fail: (value: boolean) => { fail = value; }, saves: () => saves };
}
function transport(s: StudySessionService, send: (request: any) => Promise<any>) { (s as any).chatClient = { send }; }

test('a malformed thread is dropped without taking the workspace down', async () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!)); await s.start(); await s.flush();
    const disk = clone(h.disk());
    const workspace = disk.progress['n.md'].workspace;
    const thread = workspace.threads[workspace.activeThreadId];
    thread.checkpoint = { session: thread.checkpoint.session }; // options and counters are gone
    const h2 = harness(disk); const r = h2.make();
    transport(r, async () => response(r.getActiveObjectiveId()!));
    await assert.doesNotReject(() => r.start());
    assert.equal(Object.keys(h2.plans.getProgress('n.md')!.workspace!.threads).length, 1);
    assert.ok(r.getActiveObjectiveId());
});

test('an unsupported workspace schema starts clean instead of throwing', async () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!)); await s.start(); await s.flush();
    const disk = clone(h.disk());
    disk.progress['n.md'].workspace.schema = 99;
    const h2 = harness(disk); const r = h2.make();
    transport(r, async () => response(r.getActiveObjectiveId()!));
    await assert.doesNotReject(() => r.start());
    assert.equal(r.getProgress().workspace!.schema, 1);
    const workspace = r.getProgress().workspace!;
    assert.ok(workspace.activeThreadId);
    assert.equal(workspace.threads[workspace.activeThreadId].objective!.id, r.getActiveObjectiveId());
});

test('repair retires a thread whose objective the rechart no longer teaches', () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!));
    return s.start().then(() => {
        const workspace = s.getProgress().workspace!;
        const thread = workspace.threads[workspace.activeThreadId!];
        const repaired = repairStudyWorkspace(clone(workspace), new Set(['not-in-this-plan']));
        assert.equal(repaired.workspace.threads[thread.id].archived, true);
        assert.equal(repaired.workspace.activeThreadId, null);
    });
});


test('only one live Study surface may own a note', () => {
    const controller = new StudyController({} as never, {} as never, {} as never);
    const dock = {}; const modal = {};
    assert.equal(controller.acquireStudy('n.md', dock), true);
    assert.equal(controller.acquireStudy('n.md', modal), false);
    assert.equal(controller.acquireStudy('other.md', modal), true);
    controller.releaseStudy('n.md', dock);
    assert.equal(controller.acquireStudy('n.md', modal), true);
});

test('a record key that disagrees with its thread id is re-keyed without losing the active chat', () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!));
    return s.start().then(() => {
        const workspace = s.getProgress().workspace!;
        const thread = workspace.threads[workspace.activeThreadId!];
        const drifted = clone(workspace);
        drifted.threads = { 'legacy-key': thread };
        drifted.activeThreadId = thread.id;
        const repaired = repairStudyWorkspace(drifted, new Set([thread.objective!.id]));
        assert.ok(repaired.workspace.threads[thread.id], 'the thread survives under its id');
        assert.equal(repaired.workspace.activeThreadId, thread.id);
        assert.equal(repaired.changed, true);
        assert.equal(repairStudyWorkspace(clone(repaired.workspace), new Set([thread.objective!.id])).changed, false, 'repair converges');
    });
});

test('a retired active objective leaves the panel on the briefing, not another chat', () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!));
    return s.start().then(() => {
        const workspace = s.getProgress().workspace!;
        const active = workspace.threads[workspace.activeThreadId!];
        const otherObjective = s.getPlan().objectives.find(objective => objective.id !== active.objective!.id)!;
        const second = clone(active);
        second.id = 'thread-second'; second.objective = clone(otherObjective);
        workspace.threads[second.id] = second;
        workspace.activeThreadId = second.id;
        const repaired = repairStudyWorkspace(clone(workspace), new Set([active.objective!.id]));
        assert.equal(repaired.workspace.activeThreadId, null);
        assert.equal(repaired.workspace.threads[second.id].archived, true);
    });
});

test('the global cap keeps live chats ahead of archived history', () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(s.getActiveObjectiveId()!));
    return s.start().then(() => {
        const workspace = clone(s.getProgress().workspace!);
        const template = workspace.threads[workspace.activeThreadId!];
        const objectiveIds = new Set<string>();
        const threads: Record<string, any> = {};
        for (let index = 0; index < 64; index += 1) {
            const objectiveId = `objective-cap-${index}`;
            objectiveIds.add(objectiveId);
            for (const archived of [false, true]) {
                const id = `thread-cap-${index}-${archived ? 'old' : 'live'}`;
                threads[id] = { ...clone(template), id, archived, objective: { ...clone(template.objective!), id: objectiveId }, checkpoint: { ...clone(template.checkpoint), session: { ...clone(template.checkpoint.session), startedAt: 1000 + index } } };
            }
        }
        workspace.threads = threads;
        workspace.activeThreadId = 'thread-cap-63-live';
        const repaired = repairStudyWorkspace(workspace, objectiveIds);
        const kept = Object.values(repaired.workspace.threads);
        assert.equal(kept.length, 64);
        assert.ok(kept.every(thread => !thread.archived), `${kept.filter(thread => thread.archived).length} archived survivors`);
        assert.ok(repaired.workspace.threads['thread-cap-63-live']);
    });
});

test('reload restores exact prompt, options, draft, transcript and counters without a request', async () => {
    const h = harness(); const s = h.make(); let calls = 0;
    transport(s, async () => { calls++; return response(s.getActiveObjectiveId()!); });
    await s.start(); s.setDraft('my unfinished answer'); await s.flush();
    const before = clone(s.getPendingPrompt()); const transcript = clone(s.getVisibleTranscript());
    const h2 = harness(clone(h.disk())); const restored = h2.make(); const events: StudySessionEvent[] = [];
    restored.subscribe(e => events.push(e)); transport(restored, async () => { throw new Error('must not send'); });
    await restored.start();
    assert.deepEqual(restored.getPendingPrompt(), before); assert.deepEqual(restored.getVisibleTranscript(), transcript);
    assert.equal(restored.getDraft(), 'my unfinished answer'); assert.equal(restored.getSessionRecord().turnCount, 1);
    assert.equal(restored.getSessionRecord().id, s.getSessionRecord().id); assert.equal(h2.plans.getProgress('n.md')!.totalSessions, 1);
    assert.ok(events.some(e => e.type === 'restored')); assert.equal(calls, 1);
});

test('objective threads isolate context and retain their own questions and drafts', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    const requests: any[] = []; transport(s, async r => { requests.push(r); return response(s.getActiveObjectiveId()!); });
    await s.focusOn(ids[0]); s.setDraft('draft A'); const a = clone(s.getVisibleTranscript());
    await s.focusOn(ids[1]); assert.equal(s.getDraft(), ''); assert.ok(!JSON.stringify(requests[1]).includes(`Teaching ${ids[0]}`)); s.setDraft('draft B');
    await s.focusOn(ids[0]); assert.equal(s.getDraft(), 'draft A'); assert.deepEqual(s.getVisibleTranscript(), a); assert.equal(requests.length, 2);
    assert.equal(s.getPendingPrompt()!.objectiveId, ids[0]);
});

test('submission is durable before request; duplicate clicks and late completion cannot cross threads', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    transport(s, async () => response(ids[0])); await s.start();
    let resolve!: (x: any) => void; let calls = 0;
    transport(s, async () => { calls++; assert.ok(JSON.stringify(h.disk()).includes('submitted answer')); return new Promise(r => { resolve = r; }); });
    const pending = s.answer('submitted answer'); await new Promise(r => setImmediate(r));
    await s.answer('submitted answer'); assert.equal(calls, 1);
    transport(s, async () => response(ids[1])); await s.focusOn(ids[1]);
    resolve(response(ids[0], true)); await pending;
    assert.equal(s.getActiveObjectiveId(), ids[1]); assert.equal(s.getProgress().objectives[ids[0]].attempts, 0);
    await s.focusOn(ids[0]); assert.equal(s.getVisibleTranscript().filter(t => t.role === 'user').length, 1);
    const h2 = harness(h.disk()); const reloaded = h2.make(); transport(reloaded, async () => { throw new Error('no auto resend'); }); await reloaded.start();
    assert.equal(reloaded.getVisibleTranscript().filter(t => t.role === 'user').length, 1);
});

test('retry reuses submitted turn; evidence and finish do not duplicate across restore', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start();
    transport(s, async () => { throw new Error('offline'); }); await s.answer('yes');
    transport(s, async () => response(id, true)); await s.retryPending(); await s.retryPending();
    assert.equal(s.getVisibleTranscript().filter(t => t.role === 'user').length, 1); assert.equal(s.getProgress().objectives[id].attempts, 1);
    const all = s.getVisibleTranscript().map(t => t.id); assert.equal(new Set(all).size, all.length);
    s.finish(true); s.finish(true); await s.flush();
    const h2 = harness(h.disk()); const r = h2.make(); await r.start();
    assert.equal(r.getSessionRecord().completed, true); assert.equal(h2.plans.sessionsForNote('n.md').length, 1); assert.equal(r.getProgress().objectives[id].attempts, 1);
});

test('save failure is recoverable, never sends unsaved answer, suspend does not finish', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id; let calls = 0;
    transport(s, async () => { calls++; return response(id); }); await s.start();
    const events: StudySessionEvent[] = []; s.subscribe(e => events.push(e)); h.fail(true); await s.answer('unsaved');
    assert.equal(calls, 1); assert.ok(events.some(e => e.type === 'error' && /sav/i.test(e.message)));
    h.fail(false); s.suspend(); await s.flush(); assert.equal(h.plans.sessionsForNote('n.md').length, 0);
    const h2 = harness(h.disk()); const r = h2.make(); await r.start(); assert.equal(r.getSessionRecord().endedAt, null);
});

test('draft typing writes once per burst, and flush persists the last text', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start(); await s.flush();
    const before = h.saves();
    s.setDraft('a'); s.setDraft('ab'); s.setDraft('abc');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(h.saves() - before, 1, 'one write for the burst');
    s.setDraft('abcd');
    await s.flush();
    assert.equal(h.saves() - before, 2, 'flush writes the pending draft immediately');
    assert.equal(s.getDraft(), 'abcd');
    const h2 = harness(h.disk()); const r = h2.make(); await r.start();
    assert.equal(r.getDraft(), 'abcd');
});

test('a steering command after a failed answer sends the command, not the old answer', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start();
    transport(s, async () => { throw new Error('offline'); }); await s.answer('old answer');
    assert.ok(s.getPendingRequest());
    const sent: string[] = [];
    transport(s, async request => { sent.push(JSON.stringify(request)); return response(id); });
    await s.command('wrap-up');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /learner asked to stop/, 'the command is the turn that was sent');
    assert.equal(s.getPendingRequest(), null);
});

test('objective switches in one sitting count one session', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    transport(s, async () => response(s.getActiveObjectiveId()!));
    await s.start(); await s.answer('yes'); await s.focusOn(ids[1]);
    s.finish(true); await s.flush();
    assert.equal(h.plans.getProgress('n.md')!.totalSessions, 1);
    assert.equal(h.plans.sessionsForNote('n.md').length, 1);
});

test('fresh start replaces only selected checkpoint and retains chat archive and evidence', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    transport(s, async () => response(s.getActiveObjectiveId()!)); await s.start(); await s.answer('yes'); await s.focusOn(ids[1]); await s.flush();
    const fresh = h.make(true); transport(fresh, async () => response(ids[1])); await fresh.start();
    await fresh.focusOn(ids[0]); assert.equal(fresh.getVisibleTranscript().filter(t => t.role === 'user').length, 1);
    assert.ok(Object.keys(fresh.getProgress().workspace!.threads).length >= 3);
});

test('a sitting finished after the note is renamed is saved beside the moved note', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start(); await s.answer('yes');
    assert.equal(h.plans.renameForNote('n.md', 'moved/n.md'), true);
    s.finish(true); await s.flush();
    assert.equal(h.plans.sessionsForNote('n.md').length, 0, 'no history is stranded at the old path');
    assert.equal(h.plans.sessionsForNote('moved/n.md').length, 1);
    assert.equal(h.plans.getProgress('moved/n.md')!.completedSessions, 1);
});


test('a renamed sitting checkpoints the moved path and counts its start', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start();
    assert.equal(h.plans.renameForNote('n.md', 'moved/n.md'), true);
    s.setDraft('after the move'); s.suspend(); await s.flush();
    const moved = h.plans.getProgress('moved/n.md')!;
    const thread = moved.workspace!.threads[moved.workspace!.activeThreadId!];
    assert.equal(thread.checkpoint.session.notePath, 'moved/n.md');
    assert.equal(thread.draft, 'after the move');
    assert.equal(moved.totalSessions, 1);
});

test('an answer after a failed request is never silently discarded', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start();
    transport(s, async () => { throw new Error('offline'); }); await s.answer('first answer');
    const events: StudySessionEvent[] = []; s.subscribe(e => events.push(e));
    await s.answer('second answer');
    assert.equal(s.getVisibleTranscript().filter(t => t.role === 'user').length, 1);
    assert.ok(events.some(e => e.type === 'status' && /not sent|interrupted/i.test(e.text)));
    assert.equal(s.canAnswer(), false);
    transport(s, async () => response(id)); await s.retryPending();
    assert.equal(s.getVisibleTranscript().filter(t => t.role === 'user').length, 1);
});

test('focusing a finished objective opens an editable chat instead of a dead end', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    transport(s, async () => response(ids[0])); await s.start(); s.finish(true); await s.flush();
    assert.equal(s.isFinished(), true);
    transport(s, async () => response(ids[0])); await s.focusOn(ids[0]);
    assert.equal(s.isFinished(), false);
    assert.ok(s.getVisibleTranscript().some(t => t.role === 'tutor'));
    assert.equal(s.canAnswer(), true);
});

test('a restored thread carries its own mode and lookup choice', async () => {
    const h = harness(); const s = h.make(); const ids = h.plans.getPlan('n.md')!.objectives.map(o => o.id);
    transport(s, async () => response(s.getActiveObjectiveId()!)); await s.start();
    s.setMode(StudyMode.Exam); await s.focusOn(ids[1]); s.setMode(StudyMode.Guided); await s.focusOn(ids[0]);
    assert.equal(s.getOptions().mode, StudyMode.Exam);
});

test('failed completed-response save retries storage, not evidence or the model', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start(); let calls = 0;
    const events: StudySessionEvent[] = []; s.subscribe(e => events.push(e));
    transport(s, async () => { calls++; h.fail(true); return response(id, true); }); await s.answer('yes');
    assert.equal(events.filter(e => e.type === 'turn').length, 0, 'never present an unsaved result as committed');
    assert.equal(s.getProgress().objectives[id].attempts, 1);
    h.fail(false); await s.retrySave(); await s.retryPending();
    assert.equal(calls, 1); assert.equal(h.disk().progress['n.md'].objectives[id].attempts, 1);
});

test('explicit finish fences an outstanding result and preserves finished transcript on reload', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    transport(s, async () => response(id)); await s.start(); let resolve!: (x: any) => void;
    transport(s, async () => new Promise(r => { resolve = r; })); const pending = s.answer('yes'); await new Promise(r => setImmediate(r));
    s.finish(false); await s.flush(); resolve(response(id, true)); await pending;
    assert.equal(s.getProgress().objectives[id].attempts, 0); assert.equal(s.getPendingPrompt(), null);
    const h2 = harness(h.disk()); const r = h2.make(); await r.start(); assert.ok(r.getSessionRecord().endedAt); assert.deepEqual(r.getVisibleTranscript(), s.getVisibleTranscript());
});

test('a long sitting keeps the newest 400 messages with unique identities', async () => {
    const h = harness(); const s = h.make(); transport(s, async () => response(h.plans.getPlan('n.md')!.objectives[0].id)); await s.start();
    for (let i = 0; i < 430; i++) (s as any).recordTranscript('system', 'warning', String(i), null, null, null, null);
    s.suspend(); await s.flush(); const ids = s.getVisibleTranscript().map(t => t.id);
    assert.equal(ids.length, 400, 'the checkpoint is bounded');
    assert.equal(new Set(ids).size, ids.length);
    const texts = s.getVisibleTranscript().map(t => t.text);
    assert.equal(texts[texts.length - 1], '429', 'the newest message survives');
    const h2 = harness(h.disk()); const r = h2.make(); await r.start(); assert.equal(r.getVisibleTranscript().length, 400);
});

test('verified sources and research bookkeeping survive interruption without duplicate lookups', async () => {
    const h = harness(); const s = h.make(); const id = h.plans.getPlan('n.md')!.objectives[0].id;
    const search = { status: () => ({ ok: true, label: 'scripted lookup', reason: null }), searchMany: async () => [{ query: 'mechanism', results: [{ title: 'Verified', url: 'https://source.test/verified', snippet: 'evidence' }], error: null }] };
    (s as any).searchService = search; s.setWebSearch(true); let calls = 0;
    transport(s, async () => { if (calls++ === 0) return { text: JSON.stringify({ stage: 'teach', objectiveId: id, research: { queries: ['mechanism'] } }) }; throw new Error('interrupted after lookup'); });
    await s.start(); await s.flush();
    const cp = s.getProgress().workspace!.threads[s.getProgress().workspace!.activeThreadId!].checkpoint;
    assert.deepEqual(cp.allowedUrls, ['https://source.test/verified']); assert.equal(cp.researchRounds, 1); assert.equal(cp.session.webLookups, 1);
    const h2 = harness(h.disk()); const r = h2.make(); (r as any).searchService = { ...search, searchMany: async () => { throw new Error('lookup must not repeat'); } };
    await r.start(); assert.equal(r.getOptions().webSearch, true);
    const events: StudySessionEvent[] = []; r.subscribe(e => events.push(e));
    transport(r, async request => { assert.ok(JSON.stringify(request).includes('https://source.test/verified')); return { text: JSON.stringify({ stage: 'retrieve', objectiveId: id, say: 'Sourced answer', sources: [{ title: 'Verified', url: 'https://source.test/verified' }, { title: 'Invented', url: 'https://invented.test/' }] }) }; });
    await r.retryPending(); assert.equal(r.getSessionRecord().webLookups, 1);
    const turn = events.find(e => e.type === 'turn'); assert.ok(turn && turn.type === 'turn'); assert.equal(turn.turn.sources.length, 1);
});

test('multi-section rechart preserves not-yet-seen mastery and never remaps progress twice', async () => {
    const h = harness(); const original = h.plans.getPlan('n.md')!; const [a, b] = original.objectives;
    const store = h.plans.ensureProgress(original); store.objectives[a.id].U = 3; store.objectives[b.id].U = 1;
    const note = `# First\n${'first paragraph '.repeat(55)}\n\n# Second\n${'second paragraph '.repeat(55)}`;
    let calls = 0;
    const report = await StudySessionService.chart(h.plans.plugin, h.plans, 'n.md', note, {
        rechart: true, sectionChars: 1200,
        chat: { send: async () => ({ text: JSON.stringify({ objectives: [calls++ === 0 ? b : a] }) }) } as any,
        onProgress: () => { assert.equal(store.objectives[a.id]?.U, 3, 'A survives the partial B-only chart'); },
    });
    assert.ok(report); assert.equal(calls, 2); assert.equal(store.objectives[a.id].U, 3); assert.equal(store.objectives[b.id].U, 1);
});

test('workspace retention keeps one live chat per objective and bounds the data', async () => {
    const h = harness(); const s = h.make();
    transport(s, async () => response(h.plans.getPlan('n.md')!.objectives[0].id)); await s.start();
    const original = clone(s.getProgress().workspace!);
    const active = original.activeThreadId!;
    const [a, b] = h.plans.getPlan('n.md')!.objectives.map(objective => objective.id);
    const template = original.threads[active];
    const threads: Record<string, any> = {};
    for (let index = 0; index < 40; index += 1) {
        const id = `thread-bulk-${index}`;
        threads[id] = {
            ...clone(template), id,
            objective: { ...template.objective!, id: index % 2 === 0 ? a : b },
            archived: index >= 30,
            checkpoint: {
                ...clone(template.checkpoint),
                session: { ...clone(template.checkpoint.session), startedAt: 1000 + index },
            },
        };
    }
    const bulk = { ...original, activeThreadId: 'thread-bulk-39', threads };
    const before = JSON.stringify(bulk).length;
    const repaired = repairStudyWorkspace(bulk, new Set([a, b]));
    const after = JSON.stringify(repaired.workspace).length;
    assert.ok(Object.keys(repaired.workspace.threads).length <= 4, `${Object.keys(repaired.workspace.threads).length} threads`);
    assert.ok(repaired.workspace.threads['thread-bulk-39'], 'the active chat is never pruned');
    assert.ok(after < before, `${after} < ${before}`);
    const second = repairStudyWorkspace(repaired.workspace, new Set([a, b]));
    assert.equal(second.changed, false, 'pruning is idempotent');
});
