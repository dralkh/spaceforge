import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniElement, flatten, installMiniDocument } from './support/mini-dom';
import fs from 'node:fs';
import { StudyPanel } from '../ui/study-panel';
import { StudyMaterialState } from '../ui/study-material-section';

import { coerceVisualPack } from '../models/study-visuals';
import { StudyMaterialSection } from '../ui/study-material-section';

const pack = () => coerceVisualPack({
    mindMap: { title: 'Topic', root: { id: 'root', label: 'Topic', children: [{ id: 'a', label: 'Branch', children: [{ id: 'b', label: 'Detail' }] }] } },
    visuals: [{ kind: 'matrix', title: 'Compare', columns: ['A', 'B'], rows: [{ label: 'First', cells: ['1', '2'] }, { label: 'Second', cells: ['3', '4'] }] }],
    summary: { title: 'Summary', bullets: [{ text: 'Remember this' }] },
}, { domain: 'general', sourceHash: 'source' })!;

const byClass = (root: MiniElement, cls: string): MiniElement[] => {
    const found: MiniElement[] = [];
    const visit = (el: MiniElement) => { if (el.classList.contains(cls)) found.push(el); el.children.forEach(visit); };
    visit(root); return found;
};

test('workspace owns navigation: material host has no duplicate tabs and empty views are actionable', () => {
    const root = new MiniElement('div');
    const section = new StudyMaterialSection();
    section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: null, stale: false }), generate: async () => null }, { externalNavigation: true });
    section.setView('board');
    assert.equal(byClass(root, 'sf-study-material-tab').length, 0);
    assert.match(flatten(root), /Visualize/);
    assert.equal(byClass(root, 'sf-study-material-generate').length, 1);
});

test('status refresh preserves the mounted material, and returning to a view retains its DOM interaction state', () => {
    const root = new MiniElement('div');
    const section = new StudyMaterialSection();
    const material = pack();
    section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: material, stale: false }), generate: async () => material });
    const original = byClass(root, 'sf-mm-map')[0];
    section.refresh();
    assert.equal(byClass(root, 'sf-mm-map')[0], original, 'readiness refresh must not reset expansion');
    section.setView('summary');
    assert.equal(byClass(root, 'sf-mm-map').length, 0);
    section.setView('mindmap');
    assert.equal(byClass(root, 'sf-mm-map')[0], original, 'return restores the live map rather than mounting a fresh one');
});

test('map expansion and gallery selection survive a JSON round trip and are scoped to the pack', () => {
    const material = pack();
    let state: StudyMaterialState = {};
    let root = new MiniElement('div');
    let section = new StudyMaterialSection();
    const mount = () => section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: material, stale: false }), generate: async () => material, state });
    mount();
    const collapse = byClass(root, 'sf-mm-collapse-all')[0];
    assert.ok(collapse, 'real map toolbar is present');
    collapse.click();
    section.setView('board');
    byClass(root, 'sf-vg-head')[0].click();
    assert.equal(byClass(root, 'sf-vg-card')[0].classList.contains('is-open'), false);
    section.destroy();
    state = JSON.parse(JSON.stringify(state));
    root = new MiniElement('div'); section = new StudyMaterialSection(); mount();
    assert.equal(byClass(root, 'sf-vg-card')[0].classList.contains('is-open'), false);
    section.setView('mindmap');
    assert.ok(byClass(root, 'sf-mm-node').some(el => el.classList.contains('is-collapsed')));
    assert.equal(Object.keys(state.packs!).length, 1, 'state is scoped by source and pack identity');
    section.destroy();
});

test('lab values and sequence position persist by asset identity across teardown and JSON reload', () => {
    installMiniDocument();
    const material = pack();
    material.visuals = [
        { kind: 'lab', title: 'Relationship', params: [{ id: 'x', label: 'X', min: 0, max: 10, value: 2 }], outputs: [{ id: 'y', label: 'Y', expr: 'x*2', render: 'value' }] },
        { kind: 'sequence', title: 'Process', steps: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }, { id: 'c', label: 'Third' }] },
    ] as any;
    let state: StudyMaterialState = { view: 'board' };
    let root = new MiniElement('div'); let section = new StudyMaterialSection();
    const mount = () => section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: material, stale: false }), generate: async () => material, state });
    mount();
    const slider = byClass(root, 'sf-lab-range')[0]; slider.value = '7'; slider.dispatch('input');
    byClass(root, 'sf-vg-head')[1].click();
    byClass(root, 'sf-vsq-next')[0].click();
    section.destroy();
    state = JSON.parse(JSON.stringify(state)); root = new MiniElement('div'); section = new StudyMaterialSection(); mount();
    assert.equal(byClass(root, 'sf-lab-range')[0].value, '7');
    assert.match(flatten(byClass(root, 'sf-vsq-position')[0]), /2 of 3/);
    assert.equal(Object.keys(Object.values(state.packs!)[0].assets!).length, 2);
    section.destroy();
});

// Drive the actual panel shell without making a provider request. The engine's
// public getters represent a checkpoint, not a synthetic network response.
function panelHarness() {
    installMiniDocument();
    (globalThis as any).window = globalThis;
    const store: any = { objectives: { a: { attempts: 1 }, b: { attempts: 0 } } };
    const material = pack();
    const plan = { objectives: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], visuals: material };
    const plugin: any = { app: { workspace: { openLinkText: async () => {} } }, savePluginData: async () => {}, getSidebarView: () => ({ refresh: () => {} }), studyVisualService: { isStale: () => false } };
    const controller: any = { planService: { getProgress: () => store, getPlan: () => plan }, applySessionResult: async () => {} };
    const panel: any = new StudyPanel(plugin, controller, 'Topic.md');
    const root = new MiniElement('div');
    panel.root = root;
    panel.overflowEl = root.createDiv();
    panel.buildWorkspace();
    return { panel, root, store, plugin, controller };
}

test('one visible view row serves briefing and live learning without ending or rebuilding the session', () => {
    const { panel, root, store } = panelHarness();
    let draft = 'unfinished reasoning'; let suspends = 0; let finishes = 0;
    panel.session = { getActiveObjectiveId: () => 'a', getDraft: () => draft, setDraft: (value: string) => { draft = value; }, suspend: () => { suspends++; }, finish: () => { finishes++; } };
    panel.inputEl = panel.learningEl.createEl('textarea'); panel.inputEl.value = draft;
    const originalInput = panel.inputEl;
    assert.equal(byClass(root, 'sf-study-workspace-view').length, 4);
    assert.match(flatten(root), /1 of 2 objectives practiced/);
    for (const view of ['board', 'summary', 'mindmap', 'learn']) panel.switchWorkspaceView(view);
    assert.equal(byClass(root, 'sf-study-material-tab').length, 0);
    assert.equal(panel.inputEl, originalInput);
    assert.equal(panel.inputEl.value, 'unfinished reasoning');
    assert.equal(store.workspace.viewState.activeView, 'learn');
    assert.equal(finishes, 0);
    panel.unmount();
    assert.equal(suspends, 1); assert.equal(finishes, 0);
});

test('restored event renders exact transcript and a single live pending question, retaining draft', () => {
    const { panel } = panelHarness();
    panel.streamEl = panel.learningEl.createDiv();
    panel.inputEl = panel.learningEl.createEl('textarea');
    const prompt = { text: 'Why does it happen?', kind: 'question', format: 'free', choices: [], difficulty: 1, objectiveId: 'a' };
    panel.session = {
        getActiveObjectiveId: () => 'a', getDraft: () => 'because…', setDraft: () => {}, isBusy: () => false, suspend: () => {},
        getPendingPrompt: () => prompt,
        getVisibleTranscript: () => [{ role: 'tutor', kind: 'explain', text: 'A mechanism.' }, { role: 'tutor', kind: 'question', text: prompt.text }],
    };
    panel.handleEvent({ type: 'restored' }); panel.handleEvent({ type: 'restored' });
    assert.equal(byClass(panel.streamEl, 'sf-study-question').length, 1);
    assert.equal(byClass(panel.streamEl, 'sf-study-turn').length, 1);
    assert.equal(panel.inputEl.value, 'because…');
    panel.unmount();
});

test('preparation updates preserve material DOM and expose local retry rather than dead tabs', () => {
    const root = new MiniElement('div');
    const material = pack();
    let preparation = { state: 'running', materials: 'running', message: 'Preparing material…' };
    const section = new StudyMaterialSection();
    section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: material, stale: false, preparation }), generate: async () => material });
    const map = byClass(root, 'sf-mm-map')[0];
    assert.equal(byClass(root, 'sf-study-material-generate')[0].getAttribute('disabled'), 'true');
    preparation = { state: 'error', materials: 'error', message: 'Provider unavailable. Retry material.' };
    section.refresh();
    assert.equal(byClass(root, 'sf-mm-map')[0], map);
    assert.match(flatten(root), /Retry material/);
    assert.equal(byClass(root, 'sf-study-material-generate')[0].getAttribute('disabled'), null);
    section.destroy();
});

test('manual workspace material generation uses the queue explicit retry contract', async () => {
    const { panel, plugin, controller } = panelHarness();
    let retries = 0;
    plugin.studyChartQueue = { retryMaterials: async (path: string) => { assert.equal(path, 'Topic.md'); retries++; }, getPreparationStatus: () => ({ materials: 'ready' }) };
    controller.readNote = async () => 'updated source';
    const generated = await panel.generateVisuals();
    assert.equal(retries, 1);
    assert.equal(generated, controller.planService.getPlan().visuals);
    assert.equal(panel.content, 'updated source');
    panel.unmount();
});

test('a restored transcript does not repeat the pending question at the end of the tutor turn', () => {
    const { panel } = panelHarness();
    panel.streamEl = panel.learningEl.createDiv();
    panel.inputEl = panel.learningEl.createEl('textarea');
    const prompt = { text: 'Why is the step irreversible, and what pays for it?', kind: 'question', format: 'free', choices: [], difficulty: 1, objectiveId: 'a' };
    panel.session = {
        getActiveObjectiveId: () => 'a', getDraft: () => '', setDraft: () => {}, isBusy: () => false, suspend: () => {},
        getPendingPrompt: () => prompt,
        getVisibleTranscript: () => [
            { role: 'tutor', kind: 'explain', text: 'The thioester is spent on the condensation.\n\nYour turn: why is the step irreversible, and what pays for it?' },
            { role: 'tutor', kind: 'question', text: prompt.text },
        ],
    };
    panel.handleEvent({ type: 'restored' });
    assert.equal(byClass(panel.streamEl, 'sf-study-turn').length, 1);
    const tutorBody = byClass(panel.streamEl, 'sf-study-turn-body')[0];
    assert.ok(tutorBody, 'the tutor turn body is drawn');
    assert.doesNotMatch(flatten(tutorBody), /Your turn/);
    assert.match(flatten(tutorBody), /thioester is spent/);
    assert.match(flatten(panel.streamEl), /Your turn/, 'the question card keeps its own label');
    panel.unmount();
});

test('repeated question wording keeps earlier questions in history and renders only the live one', () => {
    const { panel } = panelHarness();
    panel.streamEl = panel.learningEl.createDiv();
    panel.inputEl = panel.learningEl.createEl('textarea');
    const prompt = { text: 'Explain it back in your own words.', kind: 'question', format: 'free', choices: [], difficulty: 1, objectiveId: 'a' };
    panel.session = {
        getActiveObjectiveId: () => 'a', getDraft: () => '', setDraft: () => {}, isBusy: () => false, suspend: () => {},
        getPendingPrompt: () => prompt,
        getVisibleTranscript: () => [
            { role: 'tutor', kind: 'question', text: prompt.text },
            { role: 'user', kind: 'answer', text: 'first answer' },
            { role: 'tutor', kind: 'explain', text: 'That is closer.' },
            { role: 'tutor', kind: 'question', text: prompt.text },
        ],
    };
    panel.handleEvent({ type: 'restored' });
    assert.equal(byClass(panel.streamEl, 'sf-study-question').length, 1, 'one live question card');
    assert.equal(byClass(panel.streamEl, 'sf-study-turn').length, 3, 'earlier question, answer and explanation remain');
    assert.match(flatten(panel.streamEl), /first answer/);
    assert.match(flatten(panel.streamEl), /That is closer/);
    panel.unmount();
});

test('a late chart update cannot replace a finished session report', async () => {
    const { panel } = panelHarness();
    let applied = 0;
    panel.controller.applySessionResult = async () => { applied += 1; };
    const payload: any = {
        notePath: 'Topic.md',
        session: { completed: true, summary: 'You can explain the first step.', turnCount: 3, score: 0.5, sources: [], objectivesTouched: [], objectivesMastered: [], webLookups: 0 },
        score: 0.5,
        digest: { covered: 1, totalObjectives: 2, webLookups: 0 },
        mastered: [], fragile: [], markdown: '',
    };
    await panel.renderComplete(payload);
    assert.match(flatten(panel.learningEl), /session report/);
    panel.onChartProgress({ path: 'Topic.md', done: 2, total: 2, objectives: 5, complete: true, message: 'Chart ready', pending: 0, error: null });
    assert.match(flatten(panel.learningEl), /session report/, 'late chart progress must not wipe the report');
    assert.equal(applied, 1);
    panel.unmount();
});

test('a restored report is read-only and does not record the result again', async () => {
    const { panel } = panelHarness();
    let applied = 0; let ended = 0;
    panel.controller.applySessionResult = async () => { applied += 1; };
    panel.options.onSessionEnd = () => { ended += 1; };
    const payload: any = {
        notePath: 'Topic.md',
        session: { completed: true, summary: 'Restored summary.', turnCount: 2, score: 0.4, sources: [], objectivesTouched: [], objectivesMastered: [], webLookups: 0 },
        score: 0.4,
        digest: { covered: 1, totalObjectives: 2, webLookups: 0 },
        mastered: [], fragile: [], markdown: '',
    };
    await panel.renderComplete(payload, true);
    assert.equal(applied, 0);
    assert.equal(ended, 0);
    assert.match(flatten(panel.learningEl), /Restored summary/);
    panel.unmount();
});

test('a panel follows a file or folder move and stops cleanly when its note is deleted', () => {
    const { panel } = panelHarness();
    panel.notePath = 'notes/a.md';
    assert.equal(panel.movedPath('notes/a.md', 'archive/a.md'), 'archive/a.md');
    assert.equal(panel.movedPath('notes', 'archive/notes'), 'archive/notes/a.md');
    assert.equal(panel.movedPath('other.md', 'archive/other.md'), null);
    let suspended = 0;
    panel.session = { getDraft: () => '', setDraft: () => {}, suspend: () => { suspended += 1; }, isBusy: () => false };
    panel.inputEl = panel.learningEl.createEl('textarea'); panel.inputEl.value = 'unfinished';
    panel.noteGone();
    assert.equal(suspended, 1);
    assert.match(flatten(panel.overflowEl!), /note was deleted/);
    panel.unmount();
});

test('submit keeps the typed answer when the engine is waiting to retry a failed send', () => {
    const { panel } = panelHarness();
    let answers = 0;
    panel.session = {
        isBusy: () => false, canAnswer: () => false, getActiveObjectiveId: () => 'a', setDraft: () => {},
        answer: () => { answers += 1; }, getDraft: () => '',
    };
    panel.inputEl = panel.learningEl.createEl('textarea');
    panel.inputEl.value = 'do not lose this';
    panel.submit();
    assert.equal(panel.inputEl.value, 'do not lose this');
    assert.equal(answers, 0);
    panel.unmount();
});

test('rebuilding the workspace retires the old material section', () => {
    const { panel } = panelHarness();
    let destroyed = 0;
    panel.materialSection = { destroy: () => { destroyed += 1; } };
    panel.buildWorkspace();
    assert.equal(destroyed, 1);
    assert.equal(panel.materialSection, null);
    panel.unmount();
});

test('a restored session syncs its mode and lookup choice into the chips', () => {
    const { panel } = panelHarness();
    panel.session = { getOptions: () => ({ mode: 'exam', webSearch: true }), getActiveObjectiveId: () => 'a', getDraft: () => '', setDraft: () => {} };
    panel.modeButton = panel.learningEl.createEl('button');
    panel.webChip = panel.learningEl.createDiv();
    panel.syncSessionOptions();
    assert.equal(panel.mode, 'exam');
    assert.match(flatten(panel.modeButton), /Exam/);
    assert.match(flatten(panel.webChip), /Looking things up/);
    panel.unmount();
});

test('typing writes the draft through the engine once, not through the panel too', () => {
    const { panel, plugin } = panelHarness();
    let engineSaves = 0; let hostSaves = 0;
    plugin.savePluginData = async () => { hostSaves += 1; };
    panel.session = { getActiveObjectiveId: () => 'a', setDraft: () => { engineSaves += 1; }, getDraft: () => '', isBusy: () => false };
    panel.composerEl = panel.learningEl.createDiv();
    panel.buildComposer();
    panel.inputEl!.value = 'a partial thought';
    panel.inputEl!.dispatch('input');
    assert.equal(engineSaves, 1);
    assert.equal(hostSaves, 0, 'the engine checkpoint is the durable write for a draft');
    panel.unmount();
});

test('a rejected view-state save is shown in place, not swallowed', async () => {
    const { panel, plugin } = panelHarness();
    plugin.savePluginData = async () => { throw new Error('disk full'); };
    panel.saveWorkspace();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(flatten(panel.overflowEl!), /Progress not saved/);
    panel.unmount();
});

test('a new prompt retires the previous card so only one set of controls is live', () => {
    const { panel } = panelHarness();
    panel.streamEl = panel.learningEl.createDiv();
    const first = { text: 'First question', kind: 'question', format: 'mcq', choices: ['a', 'b'], difficulty: 1, objectiveId: 'a' };
    const second = { text: 'Second question', kind: 'question', format: 'free', choices: [], difficulty: 1, objectiveId: 'b' };
    panel.renderPrompt(first as any);
    panel.renderPrompt(second as any);
    assert.equal(byClass(panel.streamEl, 'sf-study-question').length, 1);
    assert.equal(byClass(panel.streamEl, 'sf-study-turn-history').length, 1);
    assert.match(flatten(panel.streamEl), /First question/);
    panel.unmount();
});

test('workspace typography uses house tokens and adapts to host width without a mode-card wall', () => {
    const css = fs.readFileSync('styles/study-workspace.css', 'utf8');
    assert.match(css, /@container \(min-width: 768px\)/);
    assert.match(css, /\.sf-study-workspace-objective/);
    assert.doesNotMatch(css, /font-size\s*:\s*[\d.]+(?:px|rem)/);
    const { panel, root } = panelHarness();
    for (const el of byClass(root, 'sf-study-workspace-view')) assert.match(css, new RegExp('\\.' + [...el.classes][0]));
    panel.unmount();
});

test('view state keeps one short entry per pack across regenerations', () => {
    const state: StudyMaterialState = {};
    const mount = (material: ReturnType<typeof pack>) => {
        const root = new MiniElement('div');
        const section = new StudyMaterialSection();
        section.mount(root as unknown as HTMLElement, { snapshot: () => ({ pack: material, stale: false }), generate: async () => material, state });
        section.setView('board');
        section.destroy();
    };
    mount(pack());
    const second = coerceVisualPack({
        mindMap: { title: 'Topic', root: { id: 'root', label: 'Topic', children: [{ id: 'a', label: 'Branch' }] } },
        visuals: [{ kind: 'matrix', title: 'Compare', columns: ['A', 'B'], rows: [{ label: 'First', cells: ['1', '2'] }, { label: 'Second', cells: ['3', '4'] }] }],
        summary: { title: 'Summary', bullets: [{ text: 'Remember this' }] },
    }, { domain: 'general', sourceHash: 'second' })!;
    mount(second);
    assert.equal(Object.keys(state.packs!).length, 1, 'a retired pack does not keep its UI state');
    const [key] = Object.keys(state.packs!);
    assert.ok(key.length < 120, `the pack key is ${key.length} chars, not the whole pack`);
    assert.match(key, /^second:/);
});
