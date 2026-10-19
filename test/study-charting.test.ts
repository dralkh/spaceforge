/**
 * Charting tests: the parts that decide whether a long note can be charted at
 * all, and whether it happens without losing anything.
 *
 * A converted lecture PDF — a clinical topic with forty figures and sixty
 * headings — is the case that broke the first implementation: too many model
 * calls for one pass, no recovery when one of them came back truncated, and a
 * whole-note failure if the first call failed. These tests pin the behaviour
 * that fixed it: section-aware chunking with nothing dropped, per-section
 * retry by halving, resumability, and citation-free image handling.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StudyPlanService } from '../services/study-plan-service';
import { StudySessionService } from '../services/study-session-service';
import { buildChartSections } from '../services/study-prompts';
import {
    StudyObjective,
    StudyObjectiveType,
    createObjectiveProgress,
    deriveObjectiveStatus,
} from '../models/study';
import { describeImagesForPrompt, extractImageRefs, imagesInRange, markImageLines } from '../utils/study-media';
import { DEFAULT_SETTINGS } from '../models/settings';
import { ChatClient, ChatRequest, ChatResult } from '../api/chat-client';

const NOTE = `# ACS

## ESSENCE
Acute coronary syndrome covers unstable angina, NSTEMI and STEMI. The distinction is
made by troponin and the ECG.

![](assets/ACS_aaa_img.jpg)

## ECG revision 1
Look for ST elevation in two contiguous leads.

![](assets/ACS_bbb_img.jpg)

## Case 3
A 58 year old man presents with crushing chest pain.

## Acute coronary syndrome
### STEMI
### NSTEMI
### Unstable Angina

![](https://example.org/remote.png)
`;

function makePlugin() {
    return {
        settings: { ...DEFAULT_SETTINGS, studyMaxObjectives: 12 },
        savePluginData: async () => { /* not needed in tests */ },
    };
}

function makePlanService() {
    return new StudyPlanService(makePlugin() as never, {}, {}, {});
}

// --------------------------------------------------------------- images

test('finds every kind of image reference, with its heading and line', () => {
    const refs = extractImageRefs(NOTE, target => (target.startsWith('assets/') ? target : null));

    assert.equal(refs.length, 3);
    assert.equal(refs[0].syntax, 'markdown');
    assert.equal(refs[0].fileName, 'ACS_aaa_img.jpg');
    assert.equal(refs[0].heading, 'ESSENCE');
    assert.equal(refs[0].resolvedPath, 'assets/ACS_aaa_img.jpg');
    assert.equal(refs[1].heading, 'ECG revision 1');
    assert.equal(refs[2].syntax, 'remote');
    assert.equal(refs[2].resolvedPath, 'https://example.org/remote.png');
    // Line numbers point at the actual embed lines.
    assert.equal(refs[0].line, 7);
    assert.equal(refs[1].line, 12);
});

test('reads Obsidian embeds, sizes and captions', () => {
    const refs = extractImageRefs('![[diagram.png|300]]\n![[scan.jpg|ECG on arrival]]\n![[notes.md]]');
    assert.equal(refs.length, 2, 'a non-image embed is ignored');
    assert.equal(refs[0].target, 'diagram.png');
    assert.equal(refs[0].alt, '300');
    assert.equal(refs[1].alt, 'ECG on arrival');
});

test('image markers keep the figure in place without spending tokens on paths', () => {
    const refs = extractImageRefs(NOTE, () => null);
    const marked = markImageLines(NOTE, refs);
    assert.match(marked, /\[figure: ACS_aaa_img\.jpg\]/);
    assert.match(marked, /\[figure: remote\.png\]/);
    assert.ok(!marked.includes('assets/ACS_aaa_img.jpg'), 'the path itself is gone');
    assert.equal(marked.split('\n').length, NOTE.split('\n').length, 'line numbers stay aligned for anchors');
});

test('the image prompt block forbids describing pictures and gives exact syntax', () => {
    // Images that resolve in the vault, so the prompt can name a syntax that works.
    const refs = extractImageRefs(NOTE, target => (target.startsWith('assets/') ? target : null));
    const block = describeImagesForPrompt(refs);
    assert.match(block, /you cannot see them/i);
    assert.match(block, /never claim to see an image/i);
    assert.match(block, /!\[\[assets\/ACS_aaa_img\.jpg\]\]/, 'the tutor is given an embed syntax that resolves from anywhere in the vault');
    assert.match(block, /https:\/\/example\.org\/remote\.png/, 'a remote figure keeps its URL form');
    assert.equal(describeImagesForPrompt([]), '', 'no images means no block at all');
});

test('images are attributed to the section they fall in', () => {
    const refs = extractImageRefs(NOTE, () => null);
    assert.equal(imagesInRange(refs, 1, 8).length, 1);
    assert.equal(imagesInRange(refs, 9, 16).length, 1);
    assert.equal(imagesInRange(refs, 17, 30).length, 1);
});

// -------------------------------------------------------------- sections

test('a long note is split by heading with nothing silently dropped', () => {
    const long = Array.from({ length: 40 }, (_, index) =>
        `## Section ${index + 1}\n\n${'Paragraph text about the topic. '.repeat(20)}`
    ).join('\n');
    const sections = buildChartSections(long, [], 4000);

    assert.ok(sections.length > 6, `expected many sections, got ${sections.length}`);
    // Every section is returned: no cap, no folded tail.
    const covered = sections.map(section => section.text).join('\n');
    for (const marker of ['Section 1\n', 'Section 20\n', 'Section 40']) {
        assert.ok(covered.includes(marker), `${marker.trim()} survived chunking`);
    }
    assert.equal(sections[0].total, sections.length);
    assert.deepEqual(sections.map(s => s.index), sections.map((_, index) => index));
});

test('sections carry their figures and stay line-aligned with the note', () => {
    const refs = extractImageRefs(NOTE, () => null);
    const sections = buildChartSections(NOTE, refs, 6000);
    const allImages = sections.flatMap(section => section.images.map(image => image.id));
    assert.equal(new Set(allImages).size, refs.length, 'every figure lands in exactly one section');
    for (const section of sections) {
        for (const image of section.images) {
            assert.ok(image.line >= section.startLine && image.line <= section.endLine);
        }
    }
});

// ---------------------------------------------------------------- dedupe

test('objectives with the same title but different ideas both survive', () => {
    const service = makePlanService();
    const plan = service.buildPlanFromChart('a.md', 'body', {
        objectives: [
            { title: 'NSTEMI', statement: 'Define the troponin criteria for NSTEMI', anchors: [] },
            { title: 'NSTEMI', statement: 'Describe the initial management of NSTEMI', anchors: [] },
            { title: 'Unstable Angina', statement: 'Distinguish unstable angina from NSTEMI', anchors: [] },
        ],
    }, 'general');

    assert.equal(plan.objectives.length, 3, 'repeated headings in a real note are different objectives');
});

test('genuinely repeated objectives are still folded', () => {
    const service = makePlanService();
    const plan = service.buildPlanFromChart('a.md', 'body', {
        objectives: [
            { title: 'Mechanism', statement: 'Explain how the drug lowers glucose production in the liver' },
            { title: 'Mechanism', statement: 'Explain how the drug lowers glucose production in the liver' },
        ],
    }, 'general');
    assert.equal(plan.objectives.length, 1);
});

// ------------------------------------------------------- charting a note

/** A chat client that answers from a script, so charting can be tested. */
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

function objectivesReply(count: number, prefix: string): ChatResult {
    return {
        text: JSON.stringify({
            topicSummary: 'Scripted',
            objectives: Array.from({ length: count }, (_, index) => ({
                title: `${prefix} objective ${index + 1}`,
                statement: `${prefix} statement number ${index + 1} about the mechanism`,
                type: 'mechanism',
                anchors: [],
            })),
        }),
        providerLabel: 'Scripted',
        model: 'scripted-1',
        durationMs: 1,
        finishReason: 'stop',
        truncated: false,
    };
}

function truncatedReply(): ChatResult {
    return { text: '{"objectives": [{"title": "Cut off', providerLabel: 'Scripted', model: 's', durationMs: 1, finishReason: 'length', truncated: true };
}

test('a note is charted section by section, and a failed section does not lose the rest', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const long = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(name =>
        `## ${name}\n\n${`Text about ${name} and its management. `.repeat(30)}`
    ).join('\n');

    // The Beta section can never be charted (truncated every time, including
    // when split); everything else charts.
    const chat = scriptedChat(request => {
        const prompt = request.messages[request.messages.length - 1]?.content ?? '';
        return prompt.includes('Text about Beta') ? truncatedReply() : objectivesReply(2, 'S');
    });
    const report = await StudySessionService.chart(plugin as never, service, 'ACS.md', long, {
        chat,
        rechart: true,
        sectionChars: 500,
    });

    assert.ok(report, 'a report comes back even with a failure');
    assert.ok(report.plan.objectives.length > 0, 'the sections that worked are in the plan');
    assert.ok(report.failed >= 1, 'the failure is reported rather than swallowed');
    assert.equal(report.complete, false);
    assert.ok(report.pending > 0);
    assert.ok((report.plan.chartState?.total ?? 0) > 0, 'the plan records how many sections the note has');
    assert.ok((report.plan.chartState?.done.length ?? 0) > 0, 'and which ones are done');
    assert.ok(service.getPlan('ACS.md'), 'the partial plan is saved');
});

test('a truncated section is retried in halves instead of being abandoned', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const content = `## One\n\n${'A long paragraph about the topic with plenty of detail. '.repeat(60)}`;

    // First call (the whole section) is cut off; the two halves succeed.
    let call = 0;
    const chat = scriptedChat(() => {
        call += 1;
        return call === 1 ? truncatedReply() : objectivesReply(1, `half${call}`);
    });

    const report = await StudySessionService.chart(plugin as never, service, 'Half.md', content, { chat });
    assert.ok(report, 'the run still produces a plan');
    assert.ok(report.plan.objectives.length >= 1, 'objectives come from the halves');
    assert.ok(chat.calls >= 3, `expected the section to be split and retried, made ${chat.calls} calls`);
});

test('charting resumes: already-charted sections are not charted again', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const long = Array.from({ length: 15 }, (_, index) =>
        `## Topic ${index + 1}\n\n${'Text about the clinical topic and its management. '.repeat(24)}`
    ).join('\n');

    // Budget of three sections per run, as the background queue does.
    const first = scriptedChat(() => objectivesReply(1, 'First'));
    const report = await StudySessionService.chart(plugin as never, service, 'Long.md', long, { chat: first, maxSections: 3 });
    assert.ok(report);
    assert.equal(report.complete, false);
    const doneAfterFirst = report.plan.chartState?.done.length ?? 0;
    assert.equal(doneAfterFirst, 3, 'the run stopped at its budget');
    const callsFirstRun = first.calls;

    // The next run continues where the last one stopped.
    const second = scriptedChat(() => objectivesReply(1, 'Second'));
    const continued = await StudySessionService.chart(plugin as never, service, 'Long.md', long, { chat: second });
    assert.ok(continued);
    assert.ok((continued.plan.chartState?.done.length ?? 0) > doneAfterFirst, 'more sections are charted');
    assert.ok(second.calls > 0);
    // Nothing was re-charted: the resumed run made fewer calls than a fresh one would.
    const totalSections = continued.plan.chartState?.total ?? 0;
    assert.ok(second.calls < totalSections, `resumed with ${second.calls} calls, not ${totalSections}`);
    assert.ok(callsFirstRun > 0);

    // An unchanged note has nothing left to do.
    const third = scriptedChat(() => objectivesReply(1, 'Third'));
    const nothing = await StudySessionService.chart(plugin as never, service, 'Long.md', long, { chat: third });
    if (nothing?.complete) assert.equal(third.calls, 0, 'a finished note makes no calls');
});

test('a chart survives being written to disk and read back', async () => {
    const plans: Record<string, unknown> = {};
    const progress: Record<string, unknown> = {};
    const sessions: Record<string, unknown> = {};
    const plugin = makePlugin();
    const long = Array.from({ length: 10 }, (_, index) =>
        `## Topic ${index + 1}\n\n${`Text about topic ${index + 1} and its management. `.repeat(30)}`
    ).join('\n');

    const firstService = new StudyPlanService(plugin as never, plans as never, progress as never, sessions as never);
    const first = scriptedChat(() => objectivesReply(2, 'Round'));
    const report = await StudySessionService.chart(plugin as never, firstService, 'Disk.md', long, { chat: first, maxSections: 2 });
    assert.ok(report);
    const doneBeforeReload = report.plan.chartState?.done ?? [];
    const imagesBeforeReload = report.plan.images.length;

    // Obsidian writes plugin data as JSON and reads it back: a Set or a Map in
    // the chart state would arrive as an empty object and resumability would
    // silently die on the next start.
    const reloadedPlans = JSON.parse(JSON.stringify(plans)) as Record<string, unknown>;
    const reloadedProgress = JSON.parse(JSON.stringify(progress)) as Record<string, unknown>;
    const afterReload = new StudyPlanService(plugin as never, reloadedPlans as never, reloadedProgress as never, sessions as never);

    const plan = afterReload.getPlan('Disk.md');
    assert.ok(plan, 'the plan came back from JSON');
    assert.deepEqual(plan.chartState?.done, doneBeforeReload, 'the done list is still a list of numbers');
    assert.equal(plan.images.length, imagesBeforeReload, 'figures survived the round trip');

    // And a run against the reloaded plan continues instead of starting over.
    const second = scriptedChat(() => objectivesReply(2, 'Round'));
    const continued = await StudySessionService.chart(plugin as never, afterReload, 'Disk.md', long, { chat: second });
    assert.ok(continued);
    assert.ok((continued.plan.chartState?.done.length ?? 0) > doneBeforeReload.length, 'charting continued after the reload');
    assert.ok(second.calls < (continued.plan.chartState?.total ?? 0), `did not redo finished sections (${second.calls} calls)`);
});

test('mastery and figures ride along with the plan across a re-chart', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const refs = extractImageRefs(NOTE, () => null);

    const first = scriptedChat(() => objectivesReply(2, 'Initial'));
    const initial = await StudySessionService.chart(plugin as never, service, 'ACS.md', NOTE, { chat: first });
    assert.ok(initial);
    assert.equal(initial.plan.images.length, refs.length, 'figures are recorded on the plan');

    const store = service.getProgress('ACS.md');
    assert.ok(store);
    const id = initial.plan.objectives[0].id;
    const state = store.objectives[id] ?? createObjectiveProgress();
    state.U = 3;
    state.R = 2;
    state.T = 2;
    state.successfulDays = ['2026-01-01', '2026-01-05'];
    state.status = deriveObjectiveStatus(state);
    store.objectives[id] = state;

    // The note grows a section; the re-chart keeps what was earned.
    const grown = `${NOTE}\n## New topic\n\nSomething new about reperfusion.\n`;
    const second = scriptedChat(() => objectivesReply(2, 'Initial'));
    const recharted = await StudySessionService.chart(plugin as never, service, 'ACS.md', grown, { chat: second, rechart: true });
    assert.ok(recharted);
    const carried = service.getProgress('ACS.md')?.objectives;
    const stillSolid = Object.values(carried ?? {}).some(entry => entry.status === 'mastered');
    assert.ok(stillSolid, 'the mastered objective survived the re-chart');
    assert.ok((recharted.plan.images.length > 0), 'figures are still on the plan after a re-chart');
});

test('a small objective ceiling stops charting instead of throwing work away', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, studyMaxObjectives: 4 };
    const long = Array.from({ length: 10 }, (_, index) =>
        `## Topic ${index + 1}\n\n${`Text about topic ${index + 1} and its management. `.repeat(30)}`
    ).join('\n');

    // Two fresh ideas per section, so the ceiling is what stops the run.
    const chat = scriptedChat((_request, call) => objectivesReply(2, `Section${call}`));
    const report = await StudySessionService.chart(plugin as never, service, 'Ceiling.md', long, { chat, rechart: true });

    assert.ok(report);
    assert.ok(report.plan.objectives.length <= 4, `plan respects the ceiling, has ${report.plan.objectives.length}`);
    assert.ok((report.limited ?? 0) > 0, 'the sections that were skipped for the ceiling are reported');
    assert.equal(report.failed, 0, 'a skipped-for-ceiling section is not a failure');
    assert.ok(chat.calls <= 3, `charting stopped early: ${chat.calls} calls`);
    // The skipped sections are remembered, so a resumed run does not redo them.
    const state = report.plan.chartState;
    assert.equal(state?.done.length, state?.total);
});

test('a note that yields nothing at all fails loudly, with the reason', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const chat = scriptedChat(() => ({ ...truncatedReply() }));
    const report = await StudySessionService.chart(plugin as never, service, 'Empty.md', '## Nothing\n\nShort.', { chat });
    assert.equal(report, null, 'no plan claims to exist');
});

test('objective anchors and types survive a scripted chart', async () => {
    const service = makePlanService();
    const plugin = makePlugin();
    const chat = scriptedChat(() => ({
        text: JSON.stringify({
            domain: 'medicine',
            objectives: [
                { title: 'Thresholds', statement: 'Apply the eGFR thresholds', type: 'application', importance: 'critical', anchors: ['eGFR < 30'] },
            ],
        }),
        providerLabel: 'Scripted',
        model: 's',
        durationMs: 1,
        finishReason: 'stop',
        truncated: false,
    }));
    const report = await StudySessionService.chart(plugin as never, service, 'T.md', 'eGFR < 30 means do not start.', { chat });
    assert.ok(report);
    const objective: StudyObjective | undefined = report.plan.objectives[0];
    assert.equal(objective?.type, StudyObjectiveType.Application);
    assert.equal(objective?.importance, 'critical');
    assert.deepEqual(objective?.anchors, ['eGFR < 30']);
});
