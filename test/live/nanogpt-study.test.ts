/**
 * Live end-to-end test for Study mode against NanoGPT.
 *
 * This is deliberately **not** part of `npm test`: it makes real, paid model
 * calls and needs a real key. Run it explicitly:
 *
 *   node --env-file=$HOME/.env test/live/build.mjs
 *   node --env-file=$HOME/.env --test .test-build/live/nanogpt-study.test.js
 *
 * It exercises the shipping services, not a mock of them: provider discovery,
 * incremental charting, the briefing, the visual pack, MCQ generation, a full
 * Guided tutor session, every other Study mode, web lookup, persistence and the
 * score-to-review integration. The only test seam is Obsidian's `requestUrl`,
 * which is wired to real `fetch` below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ApiProvider,
    DEFAULT_SETTINGS,
    MCQDifficulty,
    MCQQuestionAmountMode,
    SpaceforgeSettings,
    StudySearchProvider,
} from '../../models/settings';
import {
    StudyMode,
    StudyStage,
    StudySessionEvent,
    StudySummaryPayload,
} from '../../models/study';
import {
    STUDY_VISUAL_VERSION,
    mapDepth,
    mapNodeCount,
} from '../../models/study-visuals';
import { getDomainProfile } from '../../models/study-domains';
import { StudyPlanService } from '../../services/study-plan-service';
import { StudySessionService } from '../../services/study-session-service';
import { StudyVisualService } from '../../services/study-visuals-service';
import { StudyWebSearchService } from '../../services/study-web-search-service';
import { StudyController } from '../../controllers/study-controller';
import { OpenAIHttpService } from '../../api/openai-http-service';
import { inspectChatProvider } from '../../api/chat-client';
import {
    describeProviderGap,
    discoverModels,
    getHttpProvider,
    resolveHttpKey,
} from '../../api/provider-registry';
import { buildChartSections } from '../../services/study-prompts';
import {
    notices,
    setRequestUrlStub,
    StubRequestUrlRequest,
    StubRequestUrlResponse,
} from '../support/obsidian-shim';

const MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const NOTE_PATH = 'notes/enzyme-kinetics.md';
const NOTE = `# Enzyme kinetics and regulation

## Michaelis–Menten kinetics
Enzymes are protein catalysts that speed a reaction without being consumed. The substrate binds the active site, forming an enzyme–substrate complex; the enzyme lowers the activation energy and releases the product, then returns to its original state.

For a simple one-substrate reaction, the initial rate V0 rises almost linearly at low substrate concentration and levels off at high concentration because the enzyme becomes saturated. The Michaelis–Menten relation is V0 = Vmax[S]/(Km+[S]). Vmax is the rate when every enzyme molecule is working; Km is the substrate concentration that gives half of Vmax.

Km is often used as an inverse index of affinity: a low Km means the enzyme reaches half-maximal rate at a low substrate concentration, so it binds the substrate tightly. Km is not a binding constant, and it can change with conditions.

## Competitive and non-competitive inhibition
A competitive inhibitor resembles the substrate and binds the active site. It raises the apparent Km but leaves Vmax unchanged, because enough substrate can outcompete it. A non-competitive inhibitor binds elsewhere and reduces Vmax without changing Km. An uncompetitive inhibitor binds only the enzyme–substrate complex and lowers both Vmax and the apparent Km. Mixed inhibition changes both, and the direction of the Km change depends on whether the inhibitor prefers the free enzyme or the complex.

## Allosteric regulation and feedback inhibition
Allosteric enzymes have regulatory sites separate from the active site. A positive effector stabilises the active conformation and produces a sigmoidal rate curve; a negative effector stabilises the inactive conformation. The sigmoid reflects cooperativity between subunits: binding at one site changes the affinity of the others.

Feedback inhibition is a common control pattern. The end product of a pathway binds an early, rate-limiting enzyme and lowers its activity, so the pathway slows when the product accumulates. This is negative feedback, not product exhaustion. The first committed step is usually the regulated step because it avoids wasting intermediates.

## Worked example
An enzyme has Vmax = 100 µmol/min and Km = 5 mM. At [S] = 5 mM, V0 = 50 µmol/min. At [S] = 20 mM, V0 = 80 µmol/min. A competitive inhibitor raises the apparent Km to 10 mM; at saturating substrate Vmax is still 100 µmol/min.
`;

interface LiveCall {
    phase: string;
    method: string;
    url: string;
    status: number;
    ms: number;
    requestChars: number;
    responseChars: number;
    finishReason: string | null;
    contentChars: number | null;
    tokenParam: string;
    temperature: number | null;
    model: string | null;
    usage: unknown;
    error: string | null;
}

const calls: LiveCall[] = [];
let phase = 'setup';
const defects: string[] = [];

function check(condition: unknown, label: string, detail?: unknown): boolean {
    if (condition) {
        console.log(`  ok   ${label}`);
        return true;
    }
    const suffix = detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 1200)}`;
    defects.push(`${label}${suffix}`);
    console.error(`  FAIL ${label}${suffix}`);
    return false;
}

function required(condition: unknown, label: string, detail?: unknown): void {
    if (!check(condition, label, detail)) throw new Error(label);
}

async function runPhase(name: string, fn: () => Promise<void>): Promise<void> {
    phase = name;
    console.log(`\n=== ${name} ===`);
    try {
        await fn();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        defects.push(`${name}: ${message}`);
        console.error(`  ABORT ${name}: ${message}`);
    }
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function makeSettings(): SpaceforgeSettings {
    return {
        ...(clone(DEFAULT_SETTINGS) as SpaceforgeSettings),
        mcqApiProvider: ApiProvider.NanoGpt,
        // Empty on purpose: the live test must prove the environment key is
        // what the provider picks up, not a copied settings key.
        providerKeys: {},
        providerModels: { nanogpt: MODEL },
        providerUrls: {},
        studyEnabled: true,
        studyMaxObjectives: 20,
        studyTurnLimit: 8,
        studyMaxTokens: 3000,
        studyTemperature: 0.3,
        studyContextWindow: 16000,
        studyLanguage: '',
        studySearchProvider: StudySearchProvider.Tavily,
        studySearchApiKey: process.env.TAVILY_API_KEY ?? '',
        studySearchMaxResults: 3,
        studyWebSearchDefault: true,
        mcqQuestionAmountMode: MCQQuestionAmountMode.Fixed,
        mcqQuestionsPerNote: 5,
        mcqChoicesPerQuestion: 4,
        mcqDifficulty: MCQDifficulty.Advanced,
        studyAutoRateNote: false,
    };
}

interface Harness {
    plugin: unknown;
    settings: SpaceforgeSettings;
    saves: { count: number };
}

function makeHarness(settings: SpaceforgeSettings): Harness {
    const saves = { count: 0 };
    const plugin = {
        settings,
        app: {
            metadataCache: { getFirstLinkpathDest: (): null => null },
            vault: {
                getAbstractFileByPath: (): null => null,
                cachedRead: async (): Promise<string> => NOTE,
                read: async (): Promise<string> => NOTE,
            },
        },
        savePluginData: async (): Promise<void> => { saves.count += 1; },
    };
    return { plugin, settings, saves };
}

/** The single test seam: Obsidian's requestUrl becomes a real HTTP call. */
async function liveRequest(request: StubRequestUrlRequest): Promise<StubRequestUrlResponse> {
    const started = Date.now();
    const method = request.method ?? 'GET';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
        const response = await fetch(request.url, {
            method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        const record = json as {
            choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
            usage?: unknown;
        } | undefined;
        const choice = record?.choices?.[0];
        let requestJson: Record<string, unknown> = {};
        try {
            requestJson = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        } catch {
            requestJson = {};
        }
        const tokenParam = typeof requestJson.max_tokens === 'number'
            ? 'max_tokens'
            : typeof requestJson.max_completion_tokens === 'number'
                ? 'max_completion_tokens'
                : 'none';
        calls.push({
            phase,
            method,
            url: request.url,
            status: response.status,
            ms: Date.now() - started,
            requestChars: request.body?.length ?? 0,
            responseChars: text.length,
            finishReason: choice?.finish_reason ?? null,
            contentChars: typeof choice?.message?.content === 'string' ? choice.message.content.length : null,
            tokenParam,
            temperature: typeof requestJson.temperature === 'number' ? requestJson.temperature : null,
            model: typeof requestJson.model === 'string' ? requestJson.model : null,
            usage: record?.usage ?? null,
            error: response.status >= 300 ? text.slice(0, 600) : null,
        });
        return { status: response.status, text, json };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        calls.push({
            phase,
            method,
            url: request.url,
            status: 0,
            ms: Date.now() - started,
            requestChars: request.body?.length ?? 0,
            responseChars: 0,
            finishReason: null,
            contentChars: null,
            tokenParam: 'unknown',
            temperature: null,
            model: null,
            usage: null,
            error: message,
        });
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * An answer in the learner's own words, so the tutor grades an attempt rather
 * than an echo of its own answer key. The live test deliberately does not copy
 * `expect` from the prompt: the tutor detects that and (correctly) refuses to
 * count it as evidence.
 */
function answerFor(prompt: { text: string; format: string; choices: string[]; correctIndex: number | null }): string {
    if (prompt.format === 'mcq' && prompt.choices.length > 0) {
        return prompt.correctIndex !== null && prompt.choices[prompt.correctIndex]
            ? prompt.choices[prompt.correctIndex]
            : prompt.choices[0];
    }
    const text = prompt.text.toLowerCase();
    if (/competitive|active[- ]site|blocker|inhibitor|inhibition/.test(text)) {
        return 'A competitive inhibitor sits in the active site, so it competes with the substrate. That lowers the observed rate at a fixed substrate concentration, but adding enough substrate can outcompete it, so Vmax is unchanged and the apparent Km looks higher.';
    }
    if (/allosteric|effector|sigmoid|cooperativ|feedback/.test(text)) {
        return 'An allosteric effector binds away from the active site and shifts the enzyme between an active and an inactive shape, which is why the curve becomes sigmoidal. When the end product of a pathway inhibits an early step, the pathway slows as product accumulates — negative feedback, not product exhaustion.';
    }
    if (/\bkm\b|michaelis|vmax|half|saturat/.test(text)) {
        return 'Km is the substrate concentration that gives half of Vmax. A low Km means the enzyme reaches half-maximal rate at a low substrate concentration, which is tighter binding, and the rate levels off at Vmax once the enzyme is saturated.';
    }
    if (/activation|barrier|free[- ]energy|delta g|δg|equilibrium|endergonic|exergonic|protease|dipeptide/.test(text)) {
        return 'The enzyme only lowers the activation-energy barrier, so the reaction goes faster in both directions. It does not change the free-energy difference between the reactants and the products, so the overall ΔG and the equilibrium position stay as they were, and the enzyme itself emerges unchanged rather than being consumed.';
    }
    return 'The key point I would use is that the enzyme changes the barrier and the rate, while the overall energy difference between the starting material and the product is left alone, so the enzyme comes out of the reaction unchanged.';
}

function printCallSummary(): void {
    console.log('\n=== live calls ===');
    for (const call of calls) {
        const usage = call.usage && typeof call.usage === 'object'
            ? ` tokens=${JSON.stringify(call.usage)}`
            : '';
        console.log(
            `  [${call.phase}] ${call.method} ${call.status} ${call.ms}ms ` +
            `req=${call.requestChars} resp=${call.responseChars} ` +
            `model=${call.model ?? '-'} token=${call.tokenParam} temp=${call.temperature ?? '-'} ` +
            `finish=${call.finishReason ?? '-'} content=${call.contentChars ?? '-'}${usage}`
        );
        if (call.error) console.log(`    error: ${call.error}`);
    }
    const totalMs = calls.reduce((sum, call) => sum + call.ms, 0);
    const failed = calls.filter(call => call.status === 0 || call.status >= 300);
    console.log(`  total calls=${calls.length} failed=${failed.length} wall=${(totalMs / 1000).toFixed(1)}s`);
}

test('live: NanoGPT DeepSeek V4.1 Flash across the full Study surface', { timeout: 1_800_000 }, async () => {
    const key = process.env.NANOGPT_API_KEY;
    required(Boolean(key), 'NANOGPT_API_KEY is present in the environment (load $HOME/.env)');
    if (!key) return;

    setRequestUrlStub(liveRequest);
    const settings = makeSettings();
    const harness = makeHarness(settings);
    const plugin = harness.plugin as never;

    let planService = new StudyPlanService(plugin, {}, {}, {});
    let plan = planService.getPlan(NOTE_PATH);
    let progress = planService.getProgress(NOTE_PATH);
    let visualPack: Awaited<ReturnType<StudyVisualService['generate']>> = null;
    let mcqSet: Awaited<ReturnType<OpenAIHttpService['generateMCQs']>> = null;
    let sessionPayload: StudySummaryPayload | null = null;

    try {
        // ---------------------------------------------------------- provider
        await runPhase('provider + model discovery', async () => {
            const descriptor = getHttpProvider(ApiProvider.NanoGpt);
            required(descriptor, 'NanoGPT is in the provider registry');
            if (!descriptor) return;

            check(describeProviderGap(descriptor, settings) === null, 'NanoGPT is ready', describeProviderGap(descriptor, settings));
            check(resolveHttpKey(descriptor, settings) === key, 'the key comes from the environment');
            check(Boolean(key), 'the environment key is non-empty');

            const inspected = inspectChatProvider(settings);
            check(inspected.ready, 'Study reports a ready provider', inspected);
            check(inspected.label === 'NanoGPT', 'Study names NanoGPT', inspected.label);
            check(inspected.model === MODEL, 'Study uses the requested model', inspected.model);

            const discovery = await discoverModels(ApiProvider.NanoGpt, settings);
            check(discovery.error === null, 'the live model list was read', discovery.error);
            check(discovery.models.length > 100, 'the live catalogue is non-trivial', discovery.models.length);
            check(
                discovery.models.some(model => model.id === MODEL),
                `the live catalogue contains ${MODEL}`,
                discovery.models.filter(model => /deepseek\/deepseek-v4/.test(model.id)).map(model => model.id).slice(0, 10)
            );
        });

        // ------------------------------------------------------------- chart
        await runPhase('incremental charting', async () => {
            const expectedSections = buildChartSections(NOTE, [], 1200).length;
            check(expectedSections >= 3, 'the note splits into several chart sections', expectedSections);

            const first = await StudySessionService.chart(plugin, planService, NOTE_PATH, NOTE, {
                sectionChars: 1200,
                maxSections: 1,
            });
            required(first, 'the first chart section returned a report');
            if (!first) return;

            plan = first.plan;
            progress = planService.getProgress(NOTE_PATH);
            check(first.complete === false, 'the first pass is deliberately incomplete');
            check(first.pending === expectedSections - 1, 'the first pass leaves the rest pending', {
                pending: first.pending,
                expected: expectedSections - 1,
            });
            check(first.sections.length === 1, 'the first pass charted exactly one section', first.sections.length);
            check(first.sections[0]?.error === null, 'the first section charted without error', first.sections[0]);
            check((first.sections[0]?.objectives ?? 0) > 0, 'the first section produced objectives', first.sections[0]);
            check(plan.chartState?.done.length === 1, 'the plan records the section as done', plan.chartState);
            check(plan.objectives.length > 0, 'the partial plan is already usable', plan.objectives.length);

            const rest = await StudySessionService.chart(plugin, planService, NOTE_PATH, NOTE, {
                sectionChars: 1200,
                maxSections: 99,
            });
            required(rest, 'the resumed chart returned a report');
            if (!rest) return;

            plan = rest.plan;
            progress = planService.getProgress(NOTE_PATH);
            check(rest.complete === true, 'the resumed chart completed every section');
            check(rest.pending === 0, 'no sections remain', rest.pending);
            check(rest.failed === 0, 'no section failed', rest.sections.filter(section => section.error));
            check(rest.plan.chartState?.done.length === expectedSections, 'every section is recorded as done', rest.plan.chartState);
            check(rest.plan.chartState?.failed.length === 0, 'the chart records no failed sections', rest.plan.chartState?.failed);
            check(StudyPlanService.planReady(plan), 'the plan is ready for downstream Study features');

            const domainProfile = getDomainProfile(plan.domainId);
            check(
                ['life-sciences', 'physical-sciences', 'medicine'].includes(plan.domainId),
                'the chart detected a plausible domain for enzyme kinetics',
                plan.domainId
            );
            check(domainProfile.id === plan.domainId, 'the detected domain exists in the registry', plan.domainId);
            check(plan.domainLabel === domainProfile.label, 'the domain label is normalised', plan.domainLabel);
            check(plan.safetyCritical === domainProfile.safetyCritical, 'the domain carries the right safety flag', plan.safetyCritical);
            check(plan.objectives.length >= 4, 'the chart produced a real objective set', plan.objectives.length);
            check(plan.topicSummary.trim().length > 0, 'the chart wrote a topic summary', plan.topicSummary);
            check(plan.contentFingerprint === StudyPlanService.fingerprint(NOTE), 'the plan stores the note fingerprint');

            const ids = new Set(plan.objectives.map(objective => objective.id));
            check(ids.size === plan.objectives.length, 'objective ids are unique');
            check(plan.objectives.every(objective => typeof objective.title === 'string' && objective.title.trim().length > 0), 'every objective has a title');
            check(plan.objectives.every(objective => typeof objective.statement === 'string' && objective.statement.trim().length > 10), 'every objective has a statement');
            check(plan.objectives.every(objective => Array.isArray(objective.anchors)), 'every objective carries an anchors array');
            check(
                plan.objectives.every(objective => objective.prerequisites.every(id => ids.has(id) && id !== objective.id)),
                'every prerequisite resolves to another objective',
                plan.objectives.map(objective => ({ id: objective.id, prerequisites: objective.prerequisites }))
            );

            const anchors = plan.objectives.flatMap(objective => objective.anchors);
            const verbatim = anchors.filter(anchor => NOTE.includes(anchor));
            check(anchors.length > 0, 'the chart produced source anchors', { objectives: plan.objectives.length });
            check(
                anchors.length === 0 || verbatim.length === anchors.length,
                'every source anchor is verbatim from the note',
                { anchors: anchors.length, verbatim: verbatim.length, sample: anchors.filter(anchor => !NOTE.includes(anchor)).slice(0, 3) }
            );
            check(plan.uncoveredSource.length <= plan.objectives.length, 'the uncovered-source list is plausible', plan.uncoveredSource);
        });

        // ---------------------------------------------------------- briefing
        await runPhase('briefing', async () => {
            const search = new StudyWebSearchService(plugin);
            const briefing = StudySessionService.prepare(plugin, planService, search, NOTE_PATH, NOTE);
            check(briefing.hasPlan, 'the briefing has a plan');
            check(briefing.stale === false, 'the plan is not stale');
            check(briefing.providerReady === true, 'the briefing says the provider is ready', briefing.providerReason);
            check(briefing.providerLabel === 'NanoGPT', 'the briefing names NanoGPT', briefing.providerLabel);
            check(briefing.providerModel === MODEL, 'the briefing names the requested model', briefing.providerModel);
            check(briefing.totalObjectives === plan.objectives.length, 'the briefing lists every objective');
            check(briefing.covered === 0, 'a new plan starts uncovered');
            check(briefing.mastered === 0, 'a new plan starts unmastered');
            check(briefing.objectives.length === plan.objectives.length, 'the briefing carries every objective state');
            check(briefing.searchAvailable === Boolean(settings.studySearchApiKey), 'the briefing reports the search backend honestly', {
                available: briefing.searchAvailable,
                reason: briefing.searchReason,
            });
            check(briefing.webDefault === settings.studyWebSearchDefault, 'the briefing honours the web default');
            check(briefing.suggestedMode === StudyMode.Guided, 'a new note suggests Guided', briefing.suggestedMode);
        });

        // ------------------------------------------------------ visual pack
        await runPhase('visual material', async () => {
            const service = new StudyVisualService(plugin);
            const fingerprint = plan.contentFingerprint;
            visualPack = await service.generate({
                notePath: NOTE_PATH,
                content: NOTE,
                objectives: plan.objectives,
                fingerprint,
                profile: getDomainProfile(plan.domainId),
            });
            required(visualPack, 'the visual service returned a pack', notices.slice(-5));
            if (!visualPack) return;

            check(visualPack.version === STUDY_VISUAL_VERSION, 'the pack has the current version');
            check(visualPack.domain === plan.domainId, 'the pack uses the plan domain', visualPack.domain);
            check(visualPack.sourceHash === fingerprint, 'the pack stores the note fingerprint');
            check(visualPack.mindMap.root.label.trim().length > 0, 'the mind map has a root label', visualPack.mindMap.root.label);
            check(mapNodeCount(visualPack.mindMap.root) >= 3, 'the mind map has real structure', mapNodeCount(visualPack.mindMap.root));
            check(mapDepth(visualPack.mindMap.root) >= 2, 'the mind map has depth', mapDepth(visualPack.mindMap.root));
            check(visualPack.summary.bullets.length >= 3, 'the summary has real bullets', visualPack.summary.bullets.length);
            check(visualPack.summary.bullets.every(bullet => bullet.text.trim().length > 0), 'every summary bullet has text');
            check(visualPack.visuals.length >= 1, 'the pack contains at least one visual asset', visualPack.visuals.length);
            check(visualPack.visuals.length <= 6, 'the pack respects the visual cap', visualPack.visuals.length);
            check(visualPack.visuals.every(visual => Boolean(visual.kind) && Boolean(visual.title)), 'every visual has a kind and title');
            check(service.isStale(visualPack, fingerprint) === false, 'the fresh pack is not stale');

            // Exactly what the panel does after a generation.
            plan.visuals = visualPack;
            planService.savePlan(plan);
            check(planService.getPlan(NOTE_PATH)?.visuals === visualPack, 'the pack is kept on the plan');
        });

        // ------------------------------------------------------------- MCQs
        await runPhase('MCQ generation', async () => {
            const descriptor = getHttpProvider(ApiProvider.NanoGpt);
            required(descriptor, 'NanoGPT descriptor is available for MCQs');
            if (!descriptor) return;

            notices.length = 0;
            const service = new OpenAIHttpService(plugin, descriptor);
            mcqSet = await service.generateMCQs(NOTE_PATH, NOTE, settings);
            required(mcqSet, 'the MCQ service returned a question set', notices.slice(-5));
            if (!mcqSet) return;

            check(mcqSet.notePath === NOTE_PATH, 'the question set belongs to the note');
            check(mcqSet.generatedAt > 0, 'the question set has a timestamp');
            check(mcqSet.questions.length >= 3, 'the model produced a usable number of questions', mcqSet.questions.length);
            check(mcqSet.questions.length <= settings.mcqQuestionsPerNote, 'the model did not exceed the requested count', mcqSet.questions.length);
            check(mcqSet.questions.length === settings.mcqQuestionsPerNote, 'the model produced the requested number of questions', {
                asked: settings.mcqQuestionsPerNote,
                got: mcqSet.questions.length,
            });
            for (const [index, question] of mcqSet.questions.entries()) {
                check(question.question.trim().length > 0, `question ${index + 1} has text`);
                check(!question.question.includes('[CORRECT]'), `question ${index + 1} does not leak the answer marker`);
                check(question.choices.length >= 2, `question ${index + 1} has choices`, question.choices.length);
                check(question.choices.length <= 6, `question ${index + 1} has a sane number of choices`, question.choices.length);
                check(
                    question.correctAnswerIndex >= 0 && question.correctAnswerIndex < question.choices.length,
                    `question ${index + 1} has a valid correct index`,
                    { correctAnswerIndex: question.correctAnswerIndex, choices: question.choices.length }
                );
                check(
                    new Set(question.choices.map(choice => choice.trim().toLowerCase())).size === question.choices.length,
                    `question ${index + 1} has distinct choices`
                );
            }
        });

        // ---------------------------------------------------- tutor session
        await runPhase('Guided tutor session', async () => {
            const search = new StudyWebSearchService(plugin);
            const session = new StudySessionService(plugin, planService, search, NOTE_PATH, NOTE, plan, {
                mode: StudyMode.Guided,
                webSearch: true,
                turnLimit: 8,
                freshStart: true,
            });
            const events: StudySessionEvent[] = [];
            session.subscribe(event => {
                events.push(event);
                if (event.type === 'error') console.error(`  session error: ${event.message} — ${event.detail ?? ''}`);
                if (event.type === 'research') console.log(`  research: ${event.queries.join(' | ')} -> ${event.results} result(s)`);
            });

            await session.start();
            required(events.some(event => event.type === 'turn'), 'the opening turn produced a tutor turn');
            const opening = events.find(event => event.type === 'turn');
            if (opening?.type === 'turn') {
                check(opening.turn.structured === true, 'the opening turn is structured JSON');
                check(opening.turn.say.trim().length > 0, 'the opening turn has something to say');
            } else {
                check(false, 'the opening turn is a tutor turn');
            }

            const answers = [
                'My own words: the enzyme lowers the activation energy and the rate saturates because every active site is occupied.',
                'I do not know.',
                'The substrate concentration that gives half of Vmax; a low Km means tighter binding.',
            ];
            let answerIndex = 0;

            // Four learner turns: own-words answers, the "I don't know" branch
            // in the middle, then more own-words answers. The next turn is the
            // wrap-up.
            for (let step = 0; step < 4; step++) {
                if (session.getSessionRecord().completed) break;
                const prompt = session.getPendingPrompt();
                if (!prompt) break;

                console.log(`  prompt ${step + 1} [${prompt.kind}/${prompt.format}] ${prompt.text.slice(0, 240)}`);
                if (prompt.expect) console.log(`    expect: ${prompt.expect.slice(0, 240)}`);
                if (step === 1) {
                    // Exercise the "uncertain" branch the engine and the model
                    // both have to handle.
                    await session.command('dont-know');
                } else {
                    const answer = answerFor(prompt);
                    console.log(`    answer: ${answer.slice(0, 240)}`);
                    await session.answer(answer);
                }
                answerIndex += 1;

                const turn = [...events].reverse().find(event => event.type === 'turn');
                if (turn?.type === 'turn') {
                    check(turn.turn.structured === true, `answer ${answerIndex} produced structured JSON`);
                    console.log(`    verdict: ${JSON.stringify(turn.turn.verdict)}`);
                }
                const error = [...events].reverse().find(event => event.type === 'error');
                check(!error, `answer ${answerIndex} produced no provider error`, error);
            }

            if (!session.getSessionRecord().completed) {
                // Ask for the closing turn now that the learner has answered.
                await session.command('wrap-up');
            }

            const complete = events.find(event => event.type === 'complete');
            if (complete?.type === 'complete') {
                sessionPayload = complete.summary;
            } else {
                check(false, 'the session emitted a completion payload');
                sessionPayload = session.finish(true, 'Live test forced a finish after the wrap-up did not complete');
            }

            const turnEvents = events.filter(event => event.type === 'turn');
            const progressEvents = events.filter(event => event.type === 'progress');
            const digestEvents = events.filter(event => event.type === 'digest');
            const stageEvents = events.filter(event => event.type === 'stage');
            const errorEvents = events.filter(event => event.type === 'error');

            check(turnEvents.every(event => event.type === 'turn' && event.turn.structured), 'every tutor turn is structured JSON');
            check(turnEvents.length >= 2, 'the session ran more than one tutor turn', turnEvents.length);
            const verdicts = turnEvents
                .filter((event): event is Extract<StudySessionEvent, { type: 'turn' }> => event.type === 'turn')
                .map(event => event.turn.verdict)
                .filter((verdict): verdict is NonNullable<typeof verdict> => verdict !== null);
            check(verdicts.length > 0, 'the tutor graded at least one answer', verdicts.length);
            check(
                verdicts.every(verdict => verdict.correct === true || verdict.correct === false),
                'every graded answer has a boolean verdict',
                verdicts.map(verdict => verdict.correct)
            );
            // The model marked own-words answers correct in earlier live runs;
            // which answers pass is model judgement, not plugin plumbing, so
            // this run reports the count rather than requiring a success.
            console.log(`  correct verdicts: ${verdicts.filter(verdict => verdict.correct === true).length}/${verdicts.length}`);
            check(progressEvents.length > 0, 'the session recorded mastery progress', progressEvents.length);
            check(digestEvents.length > 0, 'the session emitted a digest', digestEvents.length);
            check(stageEvents.length >= 2, 'the session moved through stages', stageEvents.map(event => event.type === 'stage' ? event.stage : ''));
            check(errorEvents.length === 0, 'the session had no provider errors', errorEvents.map(event => event.type === 'error' ? event.message : ''));

            const record = session.getSessionRecord();
            check(record.turnCount >= 2, 'the session counted its turns', record.turnCount);
            check(record.transcript.length >= 4, 'the transcript has the exchange', record.transcript.length);
            check(record.objectivesTouched.length >= 1, 'the session touched at least one objective', record.objectivesTouched.length);
            check(record.summary !== null && record.summary.trim().length > 0, 'the session has a written summary', record.summary);
            check(record.score !== null && record.score >= 0 && record.score <= 1, 'the session score is in range', record.score);
            check(session.getPendingPrompt() === null, 'no prompt is left hanging after completion');

            const attempted = Object.entries(session.getProgress().objectives)
                .filter(([, state]) => state.attempts > 0);
            check(attempted.length >= 1, 'at least one objective has recorded attempts', attempted.length);
            check(
                attempted.every(([, state]) => state.lastSeenAt !== null && state.status !== 'unseen'),
                'attempted objectives moved out of unseen',
                attempted.map(([id, state]) => ({ id, status: state.status, attempts: state.attempts }))
            );

            if (!sessionPayload) return;
            check(sessionPayload.notePath === NOTE_PATH, 'the summary belongs to the note');
            check(sessionPayload.session.completed === true, 'the summary marks the session complete');
            check(sessionPayload.score >= 0 && sessionPayload.score <= 1, 'the summary score is in range', sessionPayload.score);
            check(sessionPayload.digest.totalObjectives === plan.objectives.length, 'the digest counts every objective', sessionPayload.digest);
            check(sessionPayload.markdown.startsWith('# Study session —'), 'the report is markdown for the note', sessionPayload.markdown.slice(0, 120));
            check(sessionPayload.markdown.includes(`Subject: ${plan.domainLabel}`), 'the report names the domain', sessionPayload.markdown.slice(0, 300));
            check(sessionPayload.markdown.includes('Session score:'), 'the report includes the score');
            check(sessionPayload.session.sources.every(source => /^https?:\/\//.test(source.url)), 'every cited source is a real URL');
            check(sessionPayload.session.webLookups === 0 || sessionPayload.session.sources.length > 0, 'lookups, when made, produced sources');
            check(planService.sessionsForNote(NOTE_PATH).length === 1, 'the session was saved under the note');
            check(progress.totalSessions === 1, 'the progress store counted the session', progress.totalSessions);
            check(progress.completedSessions === 1, 'the progress store counted it as complete', progress.completedSessions);
            check(progress.lastSessionSummary !== null, 'the progress store kept the summary', progress.lastSessionSummary);
        });

        // ------------------------------------------------------- other modes
        await runPhase('all Study modes', async () => {
            const search = new StudyWebSearchService(plugin);
            const modes = [StudyMode.Drill, StudyMode.Repair, StudyMode.Scenarios, StudyMode.Exam];
            for (const mode of modes) {
                const modePlans = { [NOTE_PATH]: clone(plan) };
                const modeProgress = { [NOTE_PATH]: clone(progress) };
                const modeSessions: Record<string, never[]> = {};
                const modeService = new StudyPlanService(plugin, modePlans, modeProgress, modeSessions);
                const modePlan = modeService.getPlan(NOTE_PATH);
                required(modePlan, `mode ${mode} has a plan`);
                if (!modePlan) continue;

                const session = new StudySessionService(plugin, modeService, search, NOTE_PATH, NOTE, modePlan, {
                    mode,
                    webSearch: false,
                    turnLimit: 4,
                    freshStart: true,
                });
                const events: StudySessionEvent[] = [];
                session.subscribe(event => events.push(event));
                await session.start();

                const turn = events.find(event => event.type === 'turn');
                const error = events.find(event => event.type === 'error');
                check(Boolean(turn), `mode ${mode} produced a turn`);
                check(turn?.type === 'turn' && turn.turn.structured === true, `mode ${mode} produced structured JSON`);
                check(turn?.type === 'turn' && turn.turn.say.trim().length > 0, `mode ${mode} has a tutor message`);
                check(Boolean(session.getPendingPrompt()) || session.getSessionRecord().completed, `mode ${mode} asked something or finished`);
                check(!error, `mode ${mode} had no provider error`, error);

                const payload = session.finish(false, `Live mode probe: ${mode}`);
                check(payload.markdown.includes(`Mode: ${mode}`), `mode ${mode} is named in its report`, payload.markdown.slice(0, 220));
            }
        });

        // --------------------------------------------------------- web lookup
        await runPhase('web lookup', async () => {
            const search = new StudyWebSearchService(plugin);
            const status = search.status();
            check(status.ok, 'Tavily lookup is configured', status.reason);
            if (!status.ok) return;

            const outcome = await search.search('Michaelis Menten enzyme kinetics');
            check(outcome.error === null, 'the lookup returned without error', outcome.error);
            check(outcome.results.length >= 1, 'the lookup returned sources', outcome.results.length);
            check(outcome.results.every(result => /^https?:\/\//.test(result.url)), 'every result has a real URL');
            check(outcome.results.every(result => result.title.trim().length > 0), 'every result has a title');
            check(outcome.results.every(result => result.snippet.length > 0), 'every result has a snippet');
        });

        // ------------------------------------------------------- persistence
        await runPhase('persistence round trip', async () => {
            const persisted = clone({
                plans: planService.plans,
                progress: planService.progress,
                sessions: planService.sessions,
            });
            const reloaded = new StudyPlanService(plugin, persisted.plans, persisted.progress, persisted.sessions);
            const reloadedPlan = reloaded.getPlan(NOTE_PATH);
            required(reloadedPlan, 'the plan reloads from JSON');
            if (!reloadedPlan) return;

            check(reloadedPlan.objectives.length === plan.objectives.length, 'the reloaded plan keeps every objective');
            check(reloadedPlan.visuals?.mindMap.root.label === visualPack?.mindMap.root.label, 'the reloaded plan keeps the visual pack');
            check(reloaded.getProgress(NOTE_PATH) !== null, 'the reloaded progress store exists');
            check(reloaded.sessionsForNote(NOTE_PATH).length === 1, 'the reloaded sessions keep the sitting', reloaded.sessionsForNote(NOTE_PATH).length);

            const search = new StudyWebSearchService(plugin);
            const briefing = StudySessionService.prepare(plugin, reloaded, search, NOTE_PATH, NOTE);
            check(briefing.hasPlan, 'the reloaded briefing has a plan');
            check(briefing.sessionsCount >= 1, 'the reloaded briefing counts the sitting', briefing.sessionsCount);
            check(briefing.lastSessionSummary !== null, 'the reloaded briefing has the last summary', briefing.lastSessionSummary);
            check(briefing.mastered === briefing.objectives.filter(entry => entry.state.status === 'mastered').length, 'the briefing mastered count is consistent');
        });

        // --------------------------------------------------- review integration
        await runPhase('score-to-review integration', async () => {
            if (!sessionPayload) {
                check(false, 'a session payload exists for the review integration');
                return;
            }
            const applied: Array<{ path: string; rating: unknown; options: unknown }> = [];
            const reviewPlugin = {
                settings,
                reviewScheduleService: {
                    schedules: { [NOTE_PATH]: { schedulingAlgorithm: 'fsrs' } },
                },
                reviewController: {
                    processReviewResponse: async (path: string, rating: unknown, options: unknown): Promise<void> => {
                        applied.push({ path, rating, options });
                    },
                },
            };
            const controller = new StudyController(reviewPlugin as never, planService, new StudyWebSearchService(reviewPlugin as never));

            settings.studyAutoRateNote = false;
            const suggested = await controller.applySessionResult(sessionPayload);
            check(suggested.applied === false, 'auto-rate off leaves the grade for the reader');
            check(Boolean(suggested.suggested), 'auto-rate off still suggests a grade', suggested.suggested);
            check(applied.length === 0, 'auto-rate off records nothing');

            settings.studyAutoRateNote = true;
            const recorded = await controller.applySessionResult(sessionPayload);
            check(recorded.applied === true, 'auto-rate on records the grade', recorded);
            check(recorded.ratingLabel.length > 0, 'the recorded grade has a label', recorded.ratingLabel);
            check(applied.length === 1, 'exactly one review was recorded', applied.length);
            check(applied[0]?.path === NOTE_PATH, 'the review is for the studied note');
            check(applied[0]?.options && typeof applied[0].options === 'object', 'the review records without navigation', applied[0]?.options);
        });
    } finally {
        setRequestUrlStub(null);
        printCallSummary();
    }

    // The token-cap probe is expected: NanoGPT can reject both spellings before
    // accepting the same request with no cap. Those 400s are the compatibility
    // path working, not a Study failure.
    const expectedTokenProbe = (call: LiveCall): boolean =>
        call.status === 400 && /max_(completion_)?tokens/i.test(call.error ?? '');
    const failedCalls = calls.filter(call => call.status === 0 || (call.status >= 300 && !expectedTokenProbe(call)));
    check(failedCalls.length === 0, 'every live HTTP call succeeded (expected token-cap probes excluded)', failedCalls);
    check(
        calls.filter(expectedTokenProbe).length < calls.length / 2,
        'the token-cap fallback is cached rather than retried on every turn',
        { probes: calls.filter(expectedTokenProbe).length, total: calls.length }
    );
    assert.deepEqual(defects, [], `${defects.length} live Study defect(s) found:\n${defects.join('\n')}`);
});
