/**
 * The auto-pilot: what happens to a note once its chart lands.
 *
 * Three facts live here, none of them visible from the panel:
 *
 *  - the discipline is detected from the note, stored on the plan, and the
 *    readers downstream use that stored fact (the visual pack's own `domain`
 *    proves the detection reaches the generators);
 *  - with the two settings off — the default — a charted note generates
 *    nothing beyond its plan: no material call, no question call, no notice;
 *  - with them on, the chart finishing is enough: material first, then the
 *    questions, once each, and a failure in one step does not stop the other.
 *
 * Everything is driven through the real services: `StudySessionService.chart`
 * for the chart, `StudyVisualService` with a scripted chat client for the
 * material, `MCQController` with a scripted generation service for the
 * questions, and `StudyChartQueueService` for the sequence — the same wiring
 * `main.ts` installs, so the shipping path is what runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TFile } from 'obsidian';
import { StudyPlanService } from '../services/study-plan-service';
import { StudySessionService } from '../services/study-session-service';
import { StudyChartQueueService } from '../services/study-chart-queue-service';
import { StudyVisualService } from '../services/study-visuals-service';
import { StudyWebSearchService } from '../services/study-web-search-service';
import { MCQController } from '../controllers/review-controller-mcq';
import { DEFAULT_SETTINGS, SpaceforgeSettings, migrateSettings } from '../models/settings';
import { StudyPlan } from '../models/study';
import { getDomainProfile } from '../models/study-domains';
import { MCQSet } from '../models/mcq';
import { parsePluginData } from '../utils/data-file';
import { ChatClient, ChatRequest, ChatResult } from '../api/chat-client';
import { notices } from './support/obsidian-shim';

/** A clinical note: the keyword pass should place it in medicine. */
const NOTE = `# Acute coronary syndrome

## Presentation
The patient presents with crushing chest pain. The diagnosis is made on troponin
and the ECG. Adjust the dose in renal failure and check for a contraindication.

## Management
Aspirin first, then reperfusion. The threshold and the timing matter.
`;

/** A note that says nothing a discipline registry could place. */
const PLAIN_NOTE = `# Reading list

## Chapter one
Some remarks about the subject, set down in the order they came up.

## Chapter two
More of the same, with a couple of worked examples.
`;

/** The material answer, in the shape the coercion accepts. */
const VISUAL_REPLY = {
    mindMap: {
        title: 'ACS',
        root: { id: 'root', label: 'Acute coronary syndrome', children: [{ id: 'c1', label: 'Troponin' }] },
    },
    visuals: [
        { kind: 'matrix', title: 'Which marker', columns: ['Marker', 'Timing'], rows: [{ label: 'Troponin', cells: ['rises', '3-6h'] }] },
    ],
    summary: { title: 'ACS in one page', bullets: [{ text: 'Troponin decides the diagnosis', emphasis: 'pearl' }] },
};

function result(text: string): ChatResult {
    return { text, providerLabel: 'Scripted', model: 'scripted-1', durationMs: 1, finishReason: 'stop', truncated: false };
}

/** Chart replies: a scripted number of objectives per section. */
function objectivesReply(count: number): ChatResult {
    return result(JSON.stringify({
        objectives: Array.from({ length: count }, (_, index) => ({
            title: `Objective ${index + 1}`,
            statement: `Explain clinical objective ${index + 1} about the patient and the dose`,
            type: 'mechanism',
            anchors: [],
        })),
    }));
}

function scriptedChat(answers: (request: ChatRequest, call: number) => ChatResult): ChatClient & { calls: number } {
    const client = {
        providerLabel: 'Scripted',
        model: 'scripted-1',
        calls: 0,
        send: async (request: ChatRequest): Promise<ChatResult> => {
            client.calls += 1;
            return answers(request, client.calls);
        },
    };
    return client;
}

interface HarnessOptions {
    settings?: Partial<SpaceforgeSettings>;
    /** What the material model does: answer, or fail. */
    material?: 'answer' | 'throw';
}

/**
 * The plugin surface these services touch, with a fake vault.
 *
 * The questions go through the real `MCQController`, which insists on a real
 * `TFile` for the note, so the fake vault hands one out.
 */
function makeHarness(options: HarnessOptions = {}) {
    const settings: SpaceforgeSettings = {
        ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SpaceforgeSettings),
        ...options.settings,
    };
    const notes = new Map<string, string>();
    const storedSets = new Map<string, MCQSet>();
    const calls = { material: 0, questions: [] as string[], order: [] as string[], saves: 0 };

    const fileFor = (path: string): TFile | null => {
        if (!notes.has(path)) return null;
        const file = new TFile();
        file.path = path;
        file.name = path;
        file.basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
        return file;
    };

    const plugin = {
        settings,
        app: {
            vault: {
                getAbstractFileByPath: fileFor,
                cachedRead: async (file: TFile): Promise<string> => notes.get(file.path) ?? '',
                read: async (file: TFile): Promise<string> => notes.get(file.path) ?? '',
            },
        },
        savePluginData: async (): Promise<void> => { calls.saves += 1; },
        mcqService: {
            getMCQSetForNote: (path: string): MCQSet | null => storedSets.get(path) ?? null,
            saveMCQSet: (set: MCQSet): void => { storedSets.set(set.notePath, set); },
        },
    };

    const plans: Record<string, StudyPlan> = {};
    const planService = new StudyPlanService(plugin as never, plans, {}, {});

    const materialClient = scriptedChat(() => {
        calls.material += 1;
        calls.order.push('material');
        if (options.material === 'throw') throw new Error('the provider is down');
        return result(JSON.stringify(VISUAL_REPLY));
    });
    const visualService = new StudyVisualService(plugin as never, () => materialClient);
    (plugin as unknown as { studyVisualService: StudyVisualService }).studyVisualService = visualService;

    const generation = {
        generateMCQs: async (notePath: string): Promise<MCQSet | null> => {
            calls.questions.push(notePath);
            calls.order.push('questions');
            return {
                notePath,
                generatedAt: 1,
                questions: [{ question: 'Which marker decides it?', choices: ['Troponin', 'CRP'], correctAnswerIndex: 0 }],
            };
        },
    };
    (plugin as unknown as { mcqController: MCQController }).mcqController =
        new MCQController(plugin as never, plugin.mcqService as never, generation as never);

    const queue = new StudyChartQueueService(plugin as never, planService);
    // Exactly the wiring main.ts installs: the plan service announces that a
    // chart finished, and the queue's auto-pilot takes it from there.
    planService.subscribePlanReady(plan => {
        void queue.notifyPlanReady(plan.notePath);
    });

    const chart = async (path: string, content: string, chat: ChatClient, options2: { maxSections?: number } = {}): Promise<void> => {
        notes.set(path, content);
        await StudySessionService.chart(plugin as never, planService, path, content, { chat, ...options2 });
        // The auto-pilot runs behind the chart; everything in it is a microtask
        // with these fakes, and one macrotask boundary is what settles it.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    };

    return { plugin, settings, planService, queue, visualService, calls, notes, storedSets, chart };
}

// ------------------------------------------------------- the stored discipline

test('the discipline is detected from the note and stored on the plan', async () => {
    const harness = makeHarness();
    await harness.chart('clinical/acs.md', NOTE, scriptedChat(() => objectivesReply(2)));

    const plan = harness.planService.getPlan('clinical/acs.md');
    assert.ok(plan, 'the note charted');
    assert.equal(plan.domainId, 'medicine', 'the keyword pass over the note placed it');
    assert.equal(plan.domainLabel, getDomainProfile('medicine').label, 'and the label came from the registry');
    assert.equal(plan.safetyCritical, true, 'with the profile that safety-critical follows from');

    // The briefing the reader sees before starting reads the stored fact, and
    // its lens editor pre-selects exactly this discipline.
    const briefing = StudySessionService.prepare(
        harness.plugin as never,
        harness.planService,
        new StudyWebSearchService(harness.plugin as never),
        'clinical/acs.md',
        NOTE,
    );
    assert.equal(briefing.domainId, 'medicine');
    assert.equal(briefing.domainLabel, getDomainProfile('medicine').label);

    // A re-chart keeps it: the reader is never asked to choose again.
    await harness.chart('clinical/acs.md', NOTE, scriptedChat(() => objectivesReply(2)), { maxSections: 99 });
    assert.equal(harness.planService.getPlan('clinical/acs.md')?.domainId, 'medicine');
});

test('a note nothing recognises is general, and junk stored on a plan is repaired on read', () => {
    const harness = makeHarness();
    assert.equal(StudyPlanService.detectPlanDomain(PLAIN_NOTE), 'general');
    assert.equal(StudyPlanService.detectPlanDomain(''), 'general');
    // The subject named only deep in the body is still found: the opening pass
    // looks first, the whole body second.
    const late = `${'plain filler sentence. '.repeat(400)}\n## Lecture\nThis is a clinical diagnosis made on the dose of a drug.`;
    assert.equal(StudyPlanService.detectPlanDomain(late), 'medicine');

    // A plan from disk may carry an id the registry does not know: every reader
    // downstream must meet the neutral profile instead of an unknown string.
    harness.planService.plans['legacy.md'] = {
        notePath: 'legacy.md',
        generatedAt: 1,
        updatedAt: 1,
        version: 2,
        contentFingerprint: 'x',
        domainId: 'astrology',
        domainLabel: '',
        domainNotes: undefined as unknown as string,
        domainOverriddenByUser: undefined as unknown as boolean,
        safetyCritical: undefined as unknown as boolean,
        topicSummary: 'A note from an older vault',
        objectives: [{ id: 'obj-1', title: 'One', statement: 'A statement about something', type: 'fact' as never, importance: 'standard', prerequisites: [], anchors: [] }],
        uncoveredSource: [],
        tutorMemory: [],
        images: [],
        chartState: null,
        visuals: null,
    };

    const healed = harness.planService.getPlan('legacy.md');
    assert.ok(healed);
    assert.equal(healed.domainId, 'general', 'the unknown id resolves to the neutral profile');
    assert.equal(healed.domainLabel, getDomainProfile('general').label);
    assert.equal(healed.domainNotes, '', 'and a missing notes string becomes an empty one');

    // Which is what keeps the tutor prompt from throwing on it.
    const briefing = StudySessionService.prepare(
        harness.plugin as never,
        harness.planService,
        new StudyWebSearchService(harness.plugin as never),
        'legacy.md',
        'the note as it is now',
    );
    assert.equal(briefing.domainId, 'general');
    assert.equal(briefing.domainLabel, getDomainProfile('general').label);
});

test('a plan is ready only once every section has been charted', () => {
    const base: StudyPlan = {
        notePath: 'a.md', generatedAt: 1, updatedAt: 1, version: 2, contentFingerprint: 'f',
        domainId: 'general', domainLabel: 'General', domainNotes: '', domainOverriddenByUser: false,
        safetyCritical: false, topicSummary: '', objectives: [{ id: 'obj-1', title: 't', statement: 's', type: 'fact' as never, importance: 'standard', prerequisites: [], anchors: [] }],
        uncoveredSource: [], tutorMemory: [], images: [], chartState: null, visuals: null,
    };
    assert.equal(StudyPlanService.planReady(null), false);
    assert.equal(StudyPlanService.planReady({ ...base, objectives: [] }), false, 'no objectives is not ready');
    assert.equal(StudyPlanService.planReady(base), true, 'a plan with no chart state has nothing left to chart');
    const state = (done: number[], total: number) => ({ fingerprint: 'f', total, done, failed: [], updatedAt: 1 });
    assert.equal(StudyPlanService.planReady({ ...base, chartState: state([0, 1], 4) }), false, 'half charted is not ready');
    assert.equal(StudyPlanService.planReady({ ...base, chartState: state([0, 1, 2, 3], 4) }), true);
    assert.equal(StudyPlanService.planReady({ ...base, chartState: state([0, 1, 2, 3, 4], 4) }), true, 'a skipped section still counts as accounted for');
});

// --------------------------------------------------------- the pipeline itself

test('with both settings off (the default) a charted note generates nothing', async () => {
    const harness = makeHarness();
    assert.equal(DEFAULT_SETTINGS.studyAutoMaterials, false, 'the material step starts off');
    assert.equal(DEFAULT_SETTINGS.studyAutoMcq, false, 'so does the questions step');

    const before = notices.length;
    await harness.chart('notes/acs.md', NOTE, scriptedChat(() => objectivesReply(2)));
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    assert.ok(harness.planService.getPlan('notes/acs.md'), 'the note charted');
    assert.equal(harness.calls.material, 0, 'no material was drawn');
    assert.deepEqual(harness.calls.questions, [], 'no questions were written');
    assert.equal(harness.planService.getPlan('notes/acs.md')?.visuals, null, 'and the plan has no pack');
    assert.equal(notices.length, before, 'and nothing was announced');
});

test('with the settings on, the chart finishing is enough: material, then questions', async () => {
    const harness = makeHarness({ settings: { studyAutoMaterials: true, studyAutoMcq: true } });
    await harness.chart('notes/acs.md', NOTE, scriptedChat(() => objectivesReply(2)));
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    assert.equal(harness.calls.material, 1, 'the material was drawn once');
    assert.deepEqual(harness.calls.questions, ['notes/acs.md'], 'and the questions were written once');
    assert.deepEqual(harness.calls.order, ['material', 'questions'], 'in that order');

    const plan = harness.planService.getPlan('notes/acs.md');
    assert.ok(plan?.visuals, 'the pack is on the plan');
    assert.equal(plan.visuals.domain, 'medicine', 'drawn through the stored discipline');
    assert.equal(plan.visuals.summary.bullets.length, 1);
    assert.ok(harness.calls.saves > 0, 'and it was persisted');
    assert.ok(harness.storedSets.get('notes/acs.md')?.questions.length, 'the set was stored');

    // Asking again changes nothing: both steps have what they would make.
    await harness.queue.notifyPlanReady('notes/acs.md');
    assert.equal(harness.calls.material, 1);
    assert.equal(harness.calls.questions.length, 1);
});

test('a partial chart triggers nothing until the plan is ready', async () => {
    const harness = makeHarness({ settings: { studyAutoMaterials: true, studyAutoMcq: true } });
    // Each section is long enough that the next heading starts a section of its
    // own, so the note really is charted over several runs.
    const long = Array.from({ length: 4 }, (_, index) =>
        `## Section ${index + 1}\n\nThe patient has a clinical diagnosis and a dose to adjust. `.repeat(80)
    ).join('\n');

    // One section per run: the plan exists, but it is not finished.
    await harness.chart('notes/long.md', long, scriptedChat(() => objectivesReply(1)), { maxSections: 1 });
    assert.equal(harness.calls.material, 0, 'a half-charted note gets no material');
    assert.deepEqual(harness.calls.questions, []);

    // Finish it: the follow-ups run on the pass that completes the chart.
    await harness.chart('notes/long.md', long, scriptedChat(() => objectivesReply(1)));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(harness.calls.material, 1, 'the finished chart gets its material');
    assert.deepEqual(harness.calls.questions, ['notes/long.md']);
});

test('concurrent asks are one run, and the visual service is asked once', async () => {
    // Charted first with the auto-pilot off, so the sequence starts on a plan
    // that is already ready — which is where two asks can land together.
    const harness = makeHarness();
    await harness.chart('notes/acs.md', NOTE, scriptedChat(() => objectivesReply(2)));
    harness.settings.studyAutoMaterials = true;
    harness.settings.studyAutoMcq = true;

    const first = harness.queue.notifyPlanReady('notes/acs.md');
    const second = harness.queue.notifyPlanReady('notes/acs.md');
    assert.equal(first, second, 'the second ask joins the run in flight');
    await Promise.all([first, second]);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    assert.equal(harness.calls.material, 1, 'one material call for two asks');
    assert.equal(harness.calls.questions.length, 1, 'one question preparation for two asks');
});

test('a failed material step does not stop the questions, and is logged rather than announced', async () => {
    const harness = makeHarness({ settings: { studyAutoMaterials: true, studyAutoMcq: true }, material: 'throw' });
    const before = notices.length;
    await harness.chart('notes/acs.md', NOTE, scriptedChat(() => objectivesReply(2)));
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    assert.equal(harness.calls.material, 1, 'the material step ran and failed');
    assert.equal(harness.planService.getPlan('notes/acs.md')?.visuals, null, 'nothing was stored for it');
    assert.deepEqual(harness.calls.questions, ['notes/acs.md'], 'the questions were still written');
    const added = notices.slice(before);
    assert.equal(added.some(message => /material/i.test(message)), false, `no notice about the material: ${added.join(' | ')}`);
});

test('the deck lane is not charted and not followed up', async () => {
    const harness = makeHarness({ settings: { studyAutoMaterials: true, studyAutoMcq: true } });
    harness.notes.set('spaceforge/decks/round-trip.md', NOTE);
    assert.equal(harness.queue.enqueue('spaceforge/decks/round-trip.md'), false, 'a deck is never queued for charting');
    await harness.queue.notifyPlanReady('spaceforge/decks/round-trip.md');
    assert.equal(harness.calls.material, 0);
    assert.deepEqual(harness.calls.questions, []);
});

// ------------------------------------------------------------- the settings

test('the two auto-pilot settings default off and survive a round trip', () => {
    assert.equal(DEFAULT_SETTINGS.studyAutoMaterials, false);
    assert.equal(DEFAULT_SETTINGS.studyAutoMcq, false);

    // A vault that has chosen them keeps the choice through a save and load.
    const saved = JSON.stringify({
        settings: { studyEnabled: true, studyAutoMaterials: true, studyAutoMcq: true },
        pluginState: {},
    });
    const parsed = parsePluginData(saved) as { settings: Partial<SpaceforgeSettings> } | null;
    assert.ok(parsed);
    const loaded = { ...DEFAULT_SETTINGS, ...parsed.settings } as SpaceforgeSettings;
    migrateSettings(loaded);
    assert.equal(loaded.studyAutoMaterials, true);
    assert.equal(loaded.studyAutoMcq, true);

    // A vault from before they existed gets the defaults, not undefined.
    const legacy = parsePluginData(JSON.stringify({ settings: { studyEnabled: true, studyAutoChart: true }, pluginState: {} })) as { settings: Partial<SpaceforgeSettings> } | null;
    assert.ok(legacy);
    const upgraded = { ...DEFAULT_SETTINGS, ...legacy.settings } as SpaceforgeSettings;
    assert.equal(upgraded.studyAutoMaterials, false);
    assert.equal(upgraded.studyAutoMcq, false);
    assert.equal(upgraded.studyAutoChart, true, 'the master switch for charting itself is untouched');
});
