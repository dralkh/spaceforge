import SpaceforgePlugin from '../main';
import {
    ObjectiveProgressState,
    StudyDigest,
    StudyErrorCategory,
    StudyMode,
    StudyObjective,
    StudyObjectiveStatus,
    StudyPlan,
    StudyProgressStore,
    StudySearchBackendSummary,
    StudyStage,
    StudySessionEvent,
    StudySessionOptions,
    StudyChartReport,
    StudyChartState,
    StudyImageRef,
    StudySessionRecord,
    StudySummaryPayload,
    STUDY_DATA_VERSION,
    StudyTurnRecord,
    TutorPromptSpec,
    TutorTurn,
    STUDY_MAX_TURNS_PER_SESSION,
    createObjectiveProgress,
} from '../models/study';
import { getDomainProfile } from '../models/study-domains';
import { extractImageRefs } from '../utils/study-media';
import { applyEvidence, computeFocusOrder, computeSessionScore } from '../models/study-rubric';
import { ChatClient, ChatClientError, createChatClient, inspectChatProvider } from '../api/chat-client';
import { StudyPlanService, filterVerifiedSources, renderSessionMarkdown } from './study-plan-service';
import { StudyWebSearchService } from './study-web-search-service';
import {
    ChartSection,
    TutorPromptContext,
    buildChartMessages,
    buildChartSections,
    buildProtocolRepairMessage,
    buildSourceDigest,
    buildTutorMessages,
} from './study-prompts';
import { parseJsonLoose, parseTutorTurn } from '../utils/tutor-protocol';

/** What the modal shows before a session starts. */
export interface StudyBriefing {
    notePath: string;
    noteTitle: string;
    hasPlan: boolean;
    /** True when the note changed since it was charted. */
    stale: boolean;
    domainId: string;
    domainLabel: string;
    domainNotes: string;
    safetyCritical: boolean;
    topicSummary: string;
    totalObjectives: number;
    covered: number;
    mastered: number;
    fragile: number;
    masteryScore: number;
    due: { objectiveId: string; title: string; overdueDays: number }[];
    objectives: { objective: StudyObjective; state: ObjectiveProgressState }[];
    lastSessionSummary: string | null;
    lastSessionAt: number | null;
    sessionsCount: number;
    tutorMemory: string[];
    suggestedMode: StudyMode;
    /** Provider readiness, so the briefing can explain why it cannot start. */
    providerReady: boolean;
    providerReason: string | null;
    providerLabel: string;
    providerModel: string;
    searchAvailable: boolean;
    searchLabel: string;
    searchReason: string | null;
    webDefault: boolean;
}

/** Learner steering commands that do not need a fresh model call. */
export type StudyCommand = 'dont-know' | 'hint' | 'harder' | 'easier' | 'more' | 'skip' | 'wrap-up';

/**
 * The adaptive tutoring engine.
 *
 * One instance drives one open Study window. It owns the loop state, decides
 * what to send each turn, enforces the mastery rubric on whatever the model
 * proposes, and turns the whole thing into a session record that feeds back
 * into the note's review schedule.
 *
 * Two invariants are enforced here rather than trusted to the model:
 * - nothing is credited as durable recall without evidence from another day;
 * - a citation only exists if a lookup actually returned that URL.
 */
export class StudySessionService {
    private plugin: SpaceforgePlugin;
    private planService: StudyPlanService;
    private searchService: StudyWebSearchService;
    private chatClient: ChatClient | null;

    private notePath: string;
    private noteTitle: string;
    private noteContent: string;

    private plan: StudyPlan;
    private progress: StudyProgressStore;
    private options: StudySessionOptions;

    private session: StudySessionRecord;
    private pendingPrompt: TutorPromptSpec | null = null;
    private recentTurns: { role: 'tutor' | 'user'; text: string; objectiveId: string | null }[] = [];
    private listeners: ((event: StudySessionEvent) => void)[] = [];
    private allowedUrls = new Set<string>();
    private researchRounds = 0;
    private turnErrorCounts: Partial<Record<StudyErrorCategory, number>> = {};
    private masteredBefore = new Set<string>();
    private touched = new Set<string>();
    /** Bumped when the window closes so late replies are ignored. */
    private generation = 0;
    private busy = false;
    private finished = false;
    private focusOrder: string[] = [];

    constructor(
        plugin: SpaceforgePlugin,
        planService: StudyPlanService,
        searchService: StudyWebSearchService,
        notePath: string,
        noteContent: string,
        plan: StudyPlan,
        options: StudySessionOptions
    ) {
        this.plugin = plugin;
        this.planService = planService;
        this.searchService = searchService;
        this.notePath = notePath;
        this.noteContent = noteContent;
        this.plan = plan;
        this.progress = planService.ensureProgress(plan);
        this.options = options;
        this.chatClient = createChatClient(plugin.settings);
        this.noteTitle = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');

        for (const objective of plan.objectives) {
            const state = this.progress.objectives[objective.id];
            if (state?.status === StudyObjectiveStatus.Mastered) this.masteredBefore.add(objective.id);
        }

        this.session = {
            id: `study-${Date.now()}`,
            notePath,
            mode: options.mode,
            webSearch: options.webSearch,
            startedAt: Date.now(),
            endedAt: null,
            turnCount: 0,
            objectivesTouched: [],
            objectivesMastered: [],
            errorCounts: {},
            transcript: [],
            summary: null,
            score: null,
            completed: false,
            webLookups: 0,
            sources: [],
        };
        this.planService.noteSessionStarted(notePath);
    }

    // ---------------------------------------------------------------- events

    subscribe(listener: (event: StudySessionEvent) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(existing => existing !== listener);
        };
    }

    private emit(event: StudySessionEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // A broken listener must not take the session down.
            }
        }
    }

    /** Close the window: no more model calls for this instance. */
    abort(): void {
        this.generation++;
        this.busy = false;
    }

    isBusy(): boolean {
        return this.busy;
    }

    getSessionRecord(): StudySessionRecord {
        return this.session;
    }

    getPlan(): StudyPlan {
        return this.plan;
    }

    getProgress(): StudyProgressStore {
        return this.progress;
    }

    getPendingPrompt(): TutorPromptSpec | null {
        return this.pendingPrompt;
    }

    getOptions(): StudySessionOptions {
        return this.options;
    }

    // -------------------------------------------------------------- briefing

    /** Read everything the modal needs to brief the learner before starting. */
    static prepare(
        plugin: SpaceforgePlugin,
        planService: StudyPlanService,
        searchService: StudyWebSearchService,
        notePath: string,
        noteContent: string
    ): StudyBriefing {
        const plan = planService.getPlan(notePath);
        const store = plan ? planService.ensureProgress(plan) : null;
        const provider = inspectChatProvider(plugin.settings);
        const search = searchService.status();
        const noteTitle = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');

        if (!plan || !store) {
            return {
                notePath,
                noteTitle,
                hasPlan: false,
                stale: false,
                domainId: 'general',
                domainLabel: getDomainProfile('general').label,
                domainNotes: '',
                safetyCritical: false,
                topicSummary: '',
                totalObjectives: 0,
                covered: 0,
                mastered: 0,
                fragile: 0,
                masteryScore: 0,
                due: [],
                objectives: [],
                lastSessionSummary: null,
                lastSessionAt: null,
                sessionsCount: planService.sessionsForNote(notePath).length,
                tutorMemory: [],
                suggestedMode: StudyMode.Guided,
                providerReady: provider.ready,
                providerReason: provider.reason,
                providerLabel: provider.label,
                providerModel: provider.model,
                searchAvailable: search.ok,
                searchLabel: search.label,
                searchReason: search.reason,
                webDefault: plugin.settings.studyWebSearchDefault && search.ok,
            };
        }

        const objectives = plan.objectives.map(objective => ({
            objective,
            state: store.objectives[objective.id] ?? createObjectiveProgress(),
        }));

        const due = planService.dueObjectives(plan, store).map(entry => ({
            ...entry,
            title: plan.objectives.find(objective => objective.id === entry.objectiveId)?.title ?? entry.objectiveId,
        }));
        const fragile = objectives.filter(entry => entry.state.status === StudyObjectiveStatus.Fragile).length;
        const failedOften = objectives.reduce((total, entry) =>
            total + Object.entries(entry.state.errorCounts).filter(([category]) => category !== 'success').reduce((sum, [, count]) => sum + (count ?? 0), 0), 0);

        const last = planService.mostRecentSession(notePath);

        return {
            notePath,
            noteTitle,
            hasPlan: true,
            stale: planService.isStale(plan, noteContent),
            domainId: plan.domainId,
            domainLabel: plan.domainLabel,
            domainNotes: plan.domainNotes,
            safetyCritical: plan.safetyCritical,
            topicSummary: plan.topicSummary,
            totalObjectives: plan.objectives.length,
            covered: planService.coverageCount(plan, store),
            mastered: objectives.filter(entry => entry.state.status === StudyObjectiveStatus.Mastered).length,
            fragile,
            masteryScore: planService.overallMastery(plan, store),
            due,
            objectives,
            lastSessionSummary: store.lastSessionSummary,
            lastSessionAt: last ? last.startedAt : null,
            sessionsCount: planService.sessionsForNote(notePath).length,
            tutorMemory: store.tutorMemory,
            suggestedMode: due.length > 0 ? StudyMode.Guided : failedOften > 3 ? StudyMode.Repair : StudyMode.Guided,
            providerReady: provider.ready,
            providerReason: provider.reason,
            providerLabel: provider.label,
            providerModel: provider.model,
            searchAvailable: search.ok,
            searchLabel: search.label,
            searchReason: search.reason,
            webDefault: plugin.settings.studyWebSearchDefault && search.ok,
        };
    }

    /**
     * Chart a note into objectives, a section at a time.
     *
     * Charting is a job, not an event: a long note (a converted lecture PDF, a
     * clinical topic with figures) takes several model calls, and any one of
     * them can fail or come back truncated. So this function:
     *
     *   - splits the note into heading-aligned sections and keeps the whole
     *     note (no silent tail truncation),
     *   - skips sections already charted for this note body (resumable),
     *   - retries a failed section by halving it, twice, before giving up on it,
     *   - saves after every successful section, so stopping early still leaves
     *     a usable plan,
     *   - reports per-section results instead of returning null.
     *
     * It never blocks a window on its own: callers run it in the background and
     * watch `onProgress`.
     */
    static async chart(
        plugin: SpaceforgePlugin,
        planService: StudyPlanService,
        notePath: string,
        noteContent: string,
        options: {
            rechart?: boolean;
            onStatus?: (text: string) => void;
            /** Sections to process in this run; the rest stay pending. */
            maxSections?: number;
            /** Characters per section. Lower it for a small local context window. */
            sectionChars?: number;
            /** Called after each section so a UI can update live. */
            onProgress?: (report: StudyChartReport) => void;
            /** Injectable for tests; defaults to the configured provider. */
            chat?: ChatClient;
        } = {}
    ): Promise<StudyChartReport | null> {
        const chat = options.chat ?? createChatClient(plugin.settings);
        const status = options.onStatus ?? ((): void => { /* no-op */ });
        if (!chat) {
            status('No AI provider configured');
            return null;
        }

        const noteTitle = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');
        const previous = options.rechart ? planService.getPlan(notePath) : null;
        const fingerprint = StudyPlanService.fingerprint(noteContent);

        // Figures first: they are part of the material, and their names appear
        // in the section text as markers.
        const images = extractImageRefs(noteContent, target => this.resolveImage(plugin, notePath, target));
        const sections = buildChartSections(noteContent, images, Math.max(1200, options.sectionChars ?? 6000));
        if (sections.length === 0) {
            status('The note is empty');
            return null;
        }

        // Which sections still need charting? Everything, unless we are
        // continuing a run over the same note body.
        const priorState = previous?.chartState ?? planService.getPlan(notePath)?.chartState ?? null;
        const resuming = priorState !== null && priorState.fingerprint === fingerprint && !options.rechart;
        const done = new Set<number>(resuming ? priorState.done : []);
        const failures = new Map<number, string>(resuming ? priorState.failed.map(f => [f.index, f.reason]) : []);
        const pending = sections.filter(section => !done.has(section.index));
        const budget = Math.max(1, options.maxSections ?? 99);
        const thisRun = pending.slice(0, budget);

        const report: StudyChartReport = {
            plan: previous ?? planService.getPlan(notePath) ?? this.emptyPlan(notePath, noteContent),
            kept: 0,
            added: 0,
            dropped: 0,
            sections: [],
            complete: false,
            pending: pending.length - thisRun.length,
            images: images.length,
            failed: 0,
        };

        if (thisRun.length === 0) {
            status(`Already charted (${done.size}/${sections.length} sections)`);
            report.complete = done.size >= sections.length;
            report.plan = planService.getPlan(notePath) ?? report.plan;
            return report;
        }

        status(sections.length > 1
            ? `Charting ${thisRun.length} of ${pending.length} remaining section${pending.length === 1 ? '' : 's'}…`
            : 'Charting the note…');

        // One reused list of existing objectives, so later sections reuse
        // titles verbatim and mastery keeps matching across a re-chart.
        let knownObjectives: StudyObjective[] = previous ? [...previous.objectives] : (planService.getPlan(notePath)?.objectives ?? []);
        let limitedSections = 0;
        let collected: StudyObjective[] = resuming && !options.rechart
            ? [...(planService.getPlan(notePath)?.objectives ?? [])]
            : [];

        // Spread the note's objective ceiling across its sections, with slack:
        // a fifty-section note should not ask each section for the whole
        // allowance, and an eight-section note should not be starved either.
        const ceiling = Math.max(4, Math.min(60, plugin.settings.studyMaxObjectives || 12));
        const perSection = Math.max(2, Math.min(8, Math.ceil(ceiling / Math.max(1, sections.length)) + 1));

        for (const section of thisRun) {
            const label = section.title ?? `section ${section.index + 1}`;

            // The ceiling is a promise, not a suggestion: once the plan holds
            // enough objectives, charting more sections would only produce work
            // that gets thrown away, so the rest are marked done-with-a-reason.
            if (collected.length >= ceiling) {
                done.add(section.index);
                failures.set(section.index, `objective limit reached (${ceiling})`);
                limitedSections += 1;
                continue;
            }

            status(`Charting ${section.index + 1}/${sections.length}: ${label}`);
            const remaining = Math.max(1, ceiling - collected.length);
            const result = await this.chartSection(chat, plugin, noteTitle, section, knownObjectives, 0, Math.min(perSection, remaining));
            report.sections.push({ index: section.index, title: section.title, objectives: result.objectives.length, error: result.error });

            if (result.objectives.length > 0) {
                done.add(section.index);
                failures.delete(section.index);
                collected = [...collected, ...result.objectives];
                knownObjectives = collected;

                // Persist after every section: an interrupted job is not a lost job.
                const partial = this.composePlan(noteTitle, notePath, noteContent, collected, sections, images, partialChartState(fingerprint, sections, done, failures), planService);
                const merged = planService.mergePlans(previous ?? planService.getPlan(notePath), partial);
                report.plan = merged.plan;
                // Continue with the normalised objectives (ids assigned,
                // prerequisites resolved) so later sections reuse titles and
                // the next compose pass cannot lose what has been built.
                collected = merged.plan.objectives;
                knownObjectives = collected;
                report.kept = merged.kept;
                report.added = merged.added;
                report.dropped = merged.dropped.length;
                if (result.warning) failures.set(section.index, result.warning);
                try {
                    await plugin.savePluginData();
                } catch {
                    // Saving is best effort here; the next run re-derives it.
                }
                options.onProgress?.({ ...report });
            } else {
                failures.set(section.index, result.error ?? 'no objectives returned');
                report.failed += 1;
                options.onProgress?.({ ...report });
            }
        }

        // The plan carries the chart state, and the state is only saved when a
        // section produces something. Sections skipped at the end of a run —
        // the ceiling reached, a failure — have to be written down too, or the
        // next run would retry them for ever.
        const savedState = report.plan.chartState;
        const stateChanged = done.size !== (savedState?.done.length ?? 0) || failures.size !== (savedState?.failed.length ?? 0);
        if (collected.length > 0 && stateChanged) {
            try {
                const finalPlan = this.composePlan(noteTitle, notePath, noteContent, collected, sections, images, partialChartState(fingerprint, sections, done, failures), planService);
                const merged = planService.mergePlans(previous ?? planService.getPlan(notePath), finalPlan);
                report.plan = merged.plan;
                await plugin.savePluginData();
            } catch {
                // Best effort: the queue re-derives its work from the schedule.
            }
        }

        report.complete = done.size >= sections.length;
        report.pending = Math.max(0, sections.length - done.size);
        if (limitedSections > 0) {
            report.limited = limitedSections;
            status(`Charted ${collected.length} objectives; ${limitedSections} section(s) left uncharted because the objective limit is ${ceiling}`);
        }
        status(report.complete
            ? `Charted ${collected.length} objectives from ${sections.length} sections`
            : `Charted ${done.size}/${sections.length} sections (${report.pending} left)`);

        if (collected.length === 0) {
            // Nothing usable at all: tell the caller why, per section.
            const reasons = [...failures.values()].slice(0, 3).join('; ');
            status(`Charting failed: ${reasons || 'the model returned no objectives'}`);
            return null;
        }

        return report;
    }

    /**
     * Resolve an image link to a vault path.
     *
     * Obsidian's own link resolution handles relative paths, name-only embeds
     * and files that live elsewhere in the vault, which is exactly the range of
     * things a converted PDF export throws at us.
     */
    private static resolveImage(plugin: SpaceforgePlugin, notePath: string, target: string): string | null {
        try {
            const resolved = plugin.app.metadataCache?.getFirstLinkpathDest(target, notePath);
            if (resolved) return resolved.path;
        } catch {
            // Older or restricted environments: fall through to a plain lookup.
        }
        try {
            const direct = plugin.app.vault.getAbstractFileByPath(target);
            return direct ? target : null;
        } catch {
            return null;
        }
    }

    /** A blank plan shell for a note that has never been charted. */
    private static emptyPlan(notePath: string, content: string): StudyPlan {
        const profile = getDomainProfile('general');
        return {
            notePath,
            generatedAt: Date.now(),
            updatedAt: Date.now(),
            version: STUDY_DATA_VERSION,
            contentFingerprint: StudyPlanService.fingerprint(content),
            visuals: null,
            domainId: profile.id,
            domainLabel: profile.label,
            domainNotes: '',
            domainOverriddenByUser: false,
            safetyCritical: profile.safetyCritical,
            topicSummary: '',
            objectives: [],
            uncoveredSource: [],
            tutorMemory: [],
            images: [],
            chartState: null,
        };
    }

    /** Assemble a plan from whatever objectives exist so far. */
    private static composePlan(
        noteTitle: string,
        notePath: string,
        content: string,
        objectives: StudyObjective[],
        sections: ChartSection[],
        images: StudyImageRef[],
        chartState: StudyChartState,
        planService: StudyPlanService
    ): StudyPlan {
        // Objectives arriving here can be raw model output (before ids and
        // normalisation) or already-normalised ones from an earlier pass, so
        // everything is passed through defensively; buildPlanFromChart assigns
        // ids, resolves prerequisites and infers anything missing.
        const plan = planService.buildPlanFromChart(notePath, content, {
            objectives: objectives.map(objective => ({
                title: objective.title,
                statement: objective.statement,
                type: objective.type,
                importance: objective.importance,
                prerequisites: (Array.isArray(objective.prerequisites) ? objective.prerequisites : [])
                    .map(id => objectives.find(candidate => candidate.id === id)?.title ?? id),
                anchors: Array.isArray(objective.anchors) ? objective.anchors : [],
            })),
            topicSummary: `${noteTitle}: charted from ${sections.length} section${sections.length === 1 ? '' : 's'}.`,
            uncovered: [],
        }, planService.getPlan(notePath)?.domainId ?? 'general');
        plan.images = images;
        plan.chartState = chartState;
        // Keep whatever the earlier sections already established about the
        // subject, rather than resetting it to the generic guess every time.
        const existing = planService.getPlan(notePath);
        if (existing) {
            plan.domainId = existing.domainId;
            plan.domainLabel = existing.domainLabel;
            plan.domainNotes = existing.domainNotes;
            plan.domainOverriddenByUser = existing.domainOverriddenByUser;
            plan.safetyCritical = existing.safetyCritical;
            plan.topicSummary = existing.topicSummary || plan.topicSummary;
            plan.tutorMemory = existing.tutorMemory;
        }
        return plan;
    }

    /**
     * Chart one section, splitting it in half if the model cannot produce
     * objectives for it (usually because the JSON ran out of room).
     */
    private static async chartSection(
        chat: ChatClient,
        plugin: SpaceforgePlugin,
        noteTitle: string,
        section: ChartSection,
        previousObjectives: StudyObjective[],
        depth: number,
        objectiveBudget = 0
    ): Promise<{ objectives: StudyObjective[]; error: string | null; warning: string | null }> {
        const messages = buildChartMessages(
            plugin.settings,
            noteTitle,
            section.text,
            section.index,
            section.total,
            previousObjectives,
            section.title,
            section.images,
            objectiveBudget
        );

        try {
            const result = await chat.send({
                messages,
                temperature: Math.min(0.5, plugin.settings.studyTemperature),
                // The output budget scales with the section: a thinking model
                // asked to chart three thousand characters of clinical text can
                // spend the whole of a flat budget on reasoning and then answer
                // nothing, which is what made long notes seem impossible to
                // chart. The setting is the floor, the cap keeps it valid for
                // every provider.
                maxTokens: Math.min(8192, Math.max(1200, plugin.settings.studyMaxTokens) + Math.ceil(section.text.length / 2)),
                json: true,
                contextWindow: plugin.settings.studyContextWindow,
            });
            const parsed = parseJsonLoose(result.text);
            const objectives = parsed ? collectObjectives(parsed) : [];
            if (objectives.length > 0) {
                return {
                    objectives: objectives as StudyObjective[],
                    error: null,
                    warning: result.truncated ? 'reply was cut off; objectives may be incomplete' : null,
                };
            }

            const reason = result.truncated
                ? 'the model ran out of output tokens'
                : parsed ? 'the reply contained no objectives' : 'the reply was not valid JSON';
            // Splitting a small section gains nothing: report the failure.
            if (depth < 2 && section.text.length >= 1200) {
                return await this.chartHalves(chat, plugin, noteTitle, section, previousObjectives, depth, reason, objectiveBudget);
            }
            return { objectives: [], error: reason, warning: null };
        } catch (error) {
            const message = error instanceof ChatClientError ? error.message : String(error);
            if (depth < 2 && section.text.length >= 1200 && /token|length|cut off/i.test(message)) {
                return await this.chartHalves(chat, plugin, noteTitle, section, previousObjectives, depth, message, objectiveBudget);
            }
            return { objectives: [], error: message.slice(0, 200), warning: null };
        }
    }

    /**
     * Chart a section as two halves, then stitch the results.
     *
     * The cut is chosen by character position, not by line count: a note
     * converted from a PDF or a table export often has whole paragraphs on a
     * single line, and splitting those by line number produces a half that is
     * one heading and a half that is everything else — two calls, neither of
     * them useful.
     */
    private static async chartHalves(
        chat: ChatClient,
        plugin: SpaceforgePlugin,
        noteTitle: string,
        section: ChartSection,
        previousObjectives: StudyObjective[],
        depth: number,
        reason: string,
        // Kept in the signature for call-site symmetry; the halves are charted
        // under the same section ceiling as the whole section was.
        _objectiveBudget: number
    ): Promise<{ objectives: StudyObjective[]; error: string | null; warning: string | null }> {
        const text = section.text;
        const middle = Math.floor(text.length / 2);
        const minimum = Math.floor(text.length * 0.25);

        let cut = text.lastIndexOf('\n', middle);
        if (cut < minimum) cut = text.indexOf('\n', middle);
        if (cut < minimum || cut === -1) cut = middle;

        const halves: ChartSection[] = [
            { ...section, text: text.slice(0, cut).trim() },
            { ...section, startLine: section.startLine + (text.slice(0, cut).split('\n').length - 1), text: text.slice(cut).trim() },
        ].filter(half => half.text.length > 0);

        const objectives: StudyObjective[] = [];
        const errors: string[] = [];
        for (const half of halves) {
            const result = await this.chartSection(chat, plugin, noteTitle, half, [...previousObjectives, ...objectives], depth + 1);
            objectives.push(...result.objectives);
            if (result.error) errors.push(result.error);
        }
        if (objectives.length === 0) {
            return { objectives: [], error: `${reason} (even when split in half: ${errors[0] ?? 'no objectives'})`, warning: null };
        }
        return { objectives, error: null, warning: `recovered by splitting the section (${reason})` };
    }

    // ----------------------------------------------------------------- start

    /** Run the opening turn. */
    async start(): Promise<void> {
        this.focusOrder = this.computeFocusOrder();
        this.emit({ type: 'stage', stage: this.initialStage() });
        this.emit({ type: 'plan', plan: this.plan });
        if (this.options.freshStart) {
            this.emit({ type: 'status', text: 'Starting fresh — previous mastery still counts as evidence.' });
        }
        await this.runTurn(null);
    }

    private initialStage(): StudyStage {
        const covered = this.planService.coverageCount(this.plan, this.progress);
        return covered === 0 ? StudyStage.Orient : StudyStage.Retrieve;
    }

    // ------------------------------------------------------------ turn cycle

    /** Accept the learner's answer and continue the loop. */
    async answer(text: string): Promise<void> {
        const answerText = text.trim();
        if (answerText.length === 0) return;

        const objectiveId = this.pendingPrompt?.objectiveId ?? this.currentFocusObjectiveId();
        this.recordTranscript('user', 'answer', answerText, objectiveId, null, null, null);
        this.emit({
            type: 'user-turn',
            turn: this.session.transcript[this.session.transcript.length - 1],
        });

        await this.runTurn(answerText);
    }

    /** Steering commands the engine can handle without asking the model. */
    async command(command: StudyCommand): Promise<void> {
        switch (command) {
            case 'hint':
                this.emit({
                    type: 'status',
                    text: this.pendingPrompt?.hint
                        ? `Hint: ${this.pendingPrompt.hint}`
                        : 'No hint for this one — answer with what you have, even if you are unsure.',
                });
                return;
            case 'dont-know':
                await this.answer('I don\'t know.');
                return;
            case 'harder':
            case 'easier':
            case 'more':
            case 'skip':
                await this.runTurn(steeringText(command));
                return;
            case 'wrap-up':
                await this.runTurn('(The learner asked to stop.) Please close the session out.', true);
                return;
            default:
                return;
        }
    }

    /** Toggle web lookup mid-session; persisted as a per-note preference. */
    setWebSearch(enabled: boolean): void {
        this.options.webSearch = enabled && this.searchService.status().ok;
        this.session.webSearch = this.options.webSearch;
        this.emit({
            type: 'status',
            text: this.options.webSearch
                ? `Web lookup on. The tutor can verify mechanisms through ${this.searchService.status().label}.`
                : 'Web lookup off. Anything uncertain will be labelled as unverified.',
        });
    }

    setMode(mode: StudyMode): void {
        this.options.mode = mode;
        this.session.mode = mode;
        this.emit({ type: 'status', text: `Mode changed to ${mode}.` });
    }

    /**
     * Move the tutor onto one specific objective, chosen by the learner from
     * the rail. Overrides the engine's own ordering for the rest of the
     * session's focus list.
     */
    async focusOn(objectiveId: string): Promise<void> {
        const objective = this.plan.objectives.find(entry => entry.id === objectiveId);
        if (!objective) return;
        this.focusOrder = [objectiveId, ...this.focusOrder.filter(id => id !== objectiveId)];
        this.pendingPrompt = null;
        this.emit({ type: 'status', text: `Focusing on: ${objective.title}` });
        await this.runTurn(
            `(The learner picked this objective to work on: ${objectiveId} — "${objective.statement}". Start there now: teach it briefly if it is new, otherwise test it.)`
        );
    }

    /** Run one tutor turn: build, call, parse, apply, emit. */
    private async runTurn(learnerAnswer: string | null, forceWrapUp = false): Promise<void> {
        if (this.finished) return;
        if (this.busy) return;

        const chat = this.chatClient;
        if (!chat) {
            const provider = inspectChatProvider(this.plugin.settings);
            this.emit({
                type: 'error',
                message: 'Study cannot reach a model.',
                detail: provider.reason ?? 'Check the API provider configuration in settings.',
            });
            return;
        }

        this.busy = true;
        const generation = this.generation;
        const atTurnLimit = this.session.turnCount >= Math.max(4, this.options.turnLimit) - 1;

        try {
            let research: string | null = null;
            this.researchRounds = 0;
            let repair = false;
            let turn: TutorTurn | null = null;
            // A single turn can take up to five passes: one structured retry
            // plus up to three lookup rounds, with slack.
            let pass = 0;
            let settled = false;

            while (!settled && pass < 5) {
                pass++;
                this.emit({
                    type: 'thinking',
                    active: true,
                    label: research ? 'Reading the sources…' : this.thinkingLabel(),
                });

                const ctx = this.buildContext(learnerAnswer, research, repair, forceWrapUp || atTurnLimit);
                let raw: string;
                const messages = buildTutorMessages(ctx);
                if (repair) {
                    messages.push({ role: 'user', content: buildProtocolRepairMessage() });
                }
                try {
                    const result = await chat.send({
                        messages,
                        temperature: this.plugin.settings.studyTemperature,
                        maxTokens: this.plugin.settings.studyMaxTokens,
                        json: true,
                        contextWindow: this.plugin.settings.studyContextWindow,
                    });
                    raw = result.text;
                } catch (error) {
                    if (generation !== this.generation) return;
                    const message = error instanceof ChatClientError ? error.message : String(error);
                    this.emit({ type: 'error', message: 'The model call failed.', detail: message });
                    this.emit({ type: 'thinking', active: false, label: '' });
                    return;
                }

                if (generation !== this.generation) return;

                turn = parseTutorTurn(raw, this.pendingPrompt?.objectiveId ?? this.currentFocusObjectiveId());

                // Ask for a structured retry once before degrading to prose.
                if (!turn.structured && !repair) {
                    repair = true;
                    continue;
                }
                // Serve a lookup request, then continue the same turn.
                if (turn.research && turn.research.queries.length > 0 && this.options.webSearch && this.researchRounds < 3) {
                    research = await this.performResearch(turn);
                    this.researchRounds++;
                    repair = false;
                    continue;
                }
                settled = true;
            }

            this.emit({ type: 'thinking', active: false, label: '' });
            if (!turn) return;

            this.applyTurn(turn);
        } finally {
            this.busy = false;
        }
    }

    private thinkingLabel(): string {
        switch (this.options.mode) {
            case StudyMode.Exam: return 'Preparing the next question…';
            case StudyMode.Drill: return 'Next question…';
            case StudyMode.Repair: return 'Finding the weak spot…';
            case StudyMode.Scenarios: return 'Building a new situation…';
            default: return this.pendingPrompt ? 'Working through your answer…' : 'Planning where to start…';
        }
    }

    /** Run the lookups the model asked for and describe them back to it. */
    private async performResearch(turn: TutorTurn): Promise<string | null> {
        const request = turn.research;
        if (!request) return null;
        const queries = request.queries.slice(0, 3);

        this.emit({ type: 'research', queries, results: 0, done: false });
        const outcomes = await this.searchService.searchMany(queries);
        let found = 0;
        const lines: string[] = [];

        for (const outcome of outcomes) {
            if (outcome.error) {
                lines.push(`Query: ${outcome.query} — lookup failed: ${outcome.error}`);
                continue;
            }
            if (outcome.results.length === 0) {
                lines.push(`Query: ${outcome.query} — no results.`);
                continue;
            }
            lines.push(`Query: ${outcome.query}`);
            for (const result of outcome.results) {
                found++;
                this.allowedUrls.add(result.url);
                lines.push(`- ${result.title} (${result.url})${result.snippet ? `: ${result.snippet}` : ''}`);
                const existing = this.session.sources.find(source => source.url === result.url);
                if (!existing) this.session.sources.push({ title: result.title, url: result.url });
            }
        }

        this.session.webLookups += outcomes.length;
        this.emit({ type: 'research', queries, results: found, done: true });

        this.recordTranscript(
            'system',
            'research',
            `Looked up: ${queries.join(' · ')} (${found} result${found === 1 ? '' : 's'})`,
            turn.objectiveId,
            null,
            null,
            null
        );

        if (found === 0) {
            return lines.join('\n') || 'No results were returned. Answer from your own knowledge and mark any uncertain claim as unverified.';
        }
        return lines.join('\n');
    }

    private buildContext(learnerAnswer: string | null, research: string | null, repair: boolean, wrapUp: boolean): TutorPromptContext {
        const objectiveId = this.pendingPrompt?.objectiveId ?? this.currentFocusObjectiveId();
        const objectivesForDigest = this.plan.objectives;
        const digest = buildSourceDigest(this.noteContent, objectivesForDigest, objectiveId, 6000);

        return {
            plan: this.plan,
            progress: this.progress,
            mode: this.options.mode,
            webSearch: this.options.webSearch,
            searchBackend: this.searchSummary(),
            pendingPrompt: this.pendingPrompt,
            learnerAnswer,
            sourceDigest: digest,
            images: this.plan.images ?? [],
            recentTurns: this.recentTurns.slice(-8),
            researchBlock: research,
            wrapUp,
            protocolRepair: repair,
            settings: this.plugin.settings,
            focusOrder: this.focusOrder,
        };
    }

    private searchSummary(): StudySearchBackendSummary {
        const status = this.searchService.status();
        return {
            available: this.options.webSearch && status.ok,
            label: status.label,
            reason: status.reason,
        };
    }

    /** Apply a parsed turn: rubric, transcript, events, completion. */
    private applyTurn(turn: TutorTurn): void {
        const objectiveId = turn.progress?.objectiveId ?? turn.objectiveId ?? this.pendingPrompt?.objectiveId ?? this.currentFocusObjectiveId();
        const verdictStage: StudyStage = turn.verdict ? StudyStage.Diagnose : turn.stage;

        // Sanitise citations: only URLs a lookup actually returned survive.
        const verifiedSources = this.options.webSearch ? filterVerifiedSources(turn.sources, this.allowedUrls) : [];

        if (turn.verdict) {
            const feedbackText = [
                turn.verdict.diagnosis ? `Diagnosis: ${turn.verdict.diagnosis}` : '',
                turn.verdict.correction ? `Correction: ${turn.verdict.correction}` : '',
            ].filter(Boolean).join('\n');
            this.recordTranscript(
                'tutor',
                'feedback',
                feedbackText || (turn.verdict.correct ? 'Correct.' : 'Not quite.'),
                objectiveId,
                turn.stage,
                turn.verdict.errorCategory,
                turn.verdict.correct
            );
            this.tallyError(turn.verdict.errorCategory, turn.verdict.correct);
            this.applyRubric(turn, objectiveId);
        }

        if (turn.say.trim().length > 0) {
            this.recordTranscript('tutor', 'explain', turn.say, objectiveId, turn.stage, null, null);
        }

        // Anchor integrity: flag anchors the model invented.
        const anchors = turn.anchors.filter(anchor => this.noteContent.includes(anchor));

        if (turn.flags.safetyCritical) {
            this.recordTranscript('system', 'warning', turn.flags.safetyCritical, objectiveId, null, null, null);
        }
        if (turn.flags.inconsistency) {
            this.recordTranscript('system', 'inconsistency', turn.flags.inconsistency, objectiveId, null, null, null);
        }

        if (turn.next) {
            this.pendingPrompt = {
                ...turn.next,
                objectiveId: turn.next.objectiveId ?? objectiveId,
            };
            this.recordTranscript('tutor', 'question', turn.next.text, this.pendingPrompt.objectiveId, turn.stage, null, null);
        } else {
            this.pendingPrompt = null;
            if (!turn.sessionComplete && !this.finished) {
                // The model forgot to ask anything: keep the loop alive.
                this.pendingPrompt = {
                    kind: 'explain-back',
                    text: 'In your own words, explain what we just covered — including where it would not apply.',
                    format: 'free',
                    objectiveId,
                    choices: [],
                    correctIndex: null,
                    hint: null,
                    expect: null,
                    difficulty: 2,
                };
                this.recordTranscript('tutor', 'question', this.pendingPrompt.text, objectiveId, turn.stage, null, null);
            }
        }

        if (turn.tutorMemory.length > 0) {
            this.progress.tutorMemory = Array.from(new Set([...this.progress.tutorMemory, ...turn.tutorMemory])).slice(-20);
        }

        for (const suggestion of turn.scheduleSuggestions) {
            if (suggestion.objectiveId) {
                this.planService.scheduleObjective(this.plan, this.progress, suggestion.objectiveId, suggestion.inDays);
            }
        }

        this.session.turnCount++;
        this.recentTurns.push({
            role: 'tutor',
            text: [turn.say, turn.next?.text ?? ''].filter(Boolean).join('\n'),
            objectiveId: objectiveId ?? null,
        });

        // Keep the last answer key reachable for the transcript record.
        this.progress.updatedAt = Date.now();
        this.emit({ type: 'stage', stage: turn.sessionComplete ? turn.stage : verdictStage });
        this.emit({
            type: 'turn',
            turn: { ...turn, sources: verifiedSources, anchors },
        });
        this.emitDigest();

        if (turn.sessionComplete || this.session.turnCount >= this.options.turnLimit) {
            this.finish(true, turn.summary);
        }
    }

    /** Record an error occurrence for the session digest. */
    private tallyError(category: StudyErrorCategory | null, correct: boolean | null): void {
        const effective = category ?? (correct === true ? StudyErrorCategory.Success : null);
        if (!effective) return;
        this.session.errorCounts[effective] = (this.session.errorCounts[effective] ?? 0) + 1;
        this.turnErrorCounts[effective] = (this.turnErrorCounts[effective] ?? 0) + 1;
    }

    /**
     * Apply the tutor's proposed rubric changes, clamped to what the evidence
     * can support.
     *
     * The rules themselves live in models/study-rubric.ts so they can be
     * tested without a model; this method is only the wiring: read the current
     * state, hand the evidence over, write the verdict back, and let the note's
     * schedule follow.
     */
    private applyRubric(turn: TutorTurn, objectiveId: string | null): void {
        if (!objectiveId) return;
        const objective = this.plan.objectives.find(entry => entry.id === objectiveId);
        if (!objective) return;

        const previous = this.planService.objectiveState(this.plan, this.progress, objectiveId);
        const outcome = applyEvidence(previous, {
            proposal: turn.progress,
            verdict: turn.verdict,
            today: new Date().toISOString().slice(0, 10),
            now: Date.now(),
        });
        const state = outcome.state;
        this.progress.objectives[objectiveId] = state;

        // A suggestion from the model beats the default only when the objective
        // is not already better off than that (never shorten a mastered interval).
        const alreadyScheduled = previous.nextReviewAt !== null && previous.nextReviewAt > Date.now();
        if (outcome.suggestedReviewDays !== null && (!alreadyScheduled || state.status === StudyObjectiveStatus.Mastered)) {
            this.planService.scheduleObjective(this.plan, this.progress, objectiveId, outcome.suggestedReviewDays);
        }

        if (outcome.becameMastered && !this.masteredBefore.has(objectiveId)) {
            this.masteredBefore.add(objectiveId);
            this.session.objectivesMastered.push(objectiveId);
        }

        this.touched.add(objectiveId);
        this.session.objectivesTouched = Array.from(this.touched);
        this.emit({ type: 'progress', objectiveId, state });
    }

    /** Pick the objective the tutor should be working on when it does not say. */
    private currentFocusObjectiveId(): string | null {
        if (this.pendingPrompt?.objectiveId) return this.pendingPrompt.objectiveId;
        return this.focusOrder[0] ?? this.plan.objectives[0]?.id ?? null;
    }

    /**
     * Order the objectives for this session.
     *
     * Ordering rules live in models/study-rubric.ts (prerequisites first, then
     * whatever the mode says matters most).
     */
    private computeFocusOrder(): string[] {
        return computeFocusOrder(this.options.mode, this.plan.objectives, this.progress, Date.now());
    }

    private recordTranscript(
        role: StudyTurnRecord['role'],
        kind: string,
        text: string,
        objectiveId: string | null,
        stage: StudyTurnRecord['stage'],
        errorCategory: StudyErrorCategory | null,
        correct: boolean | null
    ): void {
        const turn: StudyTurnRecord = {
            id: `t-${this.session.transcript.length + 1}`,
            role,
            kind,
            text,
            objectiveId: objectiveId ?? null,
            stage: stage ?? null,
            errorCategory,
            correct,
            at: Date.now(),
        };
        this.session.transcript.push(turn);
        if (this.session.transcript.length > STUDY_MAX_TURNS_PER_SESSION) {
            this.session.transcript = this.session.transcript.slice(-STUDY_MAX_TURNS_PER_SESSION);
        }
        if (role === 'user') {
            this.recentTurns.push({ role: 'user', text, objectiveId: objectiveId ?? null });
        }
    }

    private emitDigest(): void {
        this.emit({
            type: 'digest',
            digest: this.planService.buildDigest(this.plan, this.progress, {
                turnCount: this.session.turnCount,
                turnLimit: this.options.turnLimit,
                errorCounts: this.session.errorCounts,
                webLookups: this.session.webLookups,
                startedAt: this.session.startedAt,
            }),
        });
    }

    /** Current digest, for the UI's first paint. */
    getDigest(): StudyDigest {
        return this.planService.buildDigest(this.plan, this.progress, {
            turnCount: this.session.turnCount,
            turnLimit: this.options.turnLimit,
            errorCounts: this.session.errorCounts,
            webLookups: this.session.webLookups,
            startedAt: this.session.startedAt,
        });
    }

    // --------------------------------------------------------------- finish

    /**
     * Close the session out and hand the controller a score and a markdown
     * report. Safe to call more than once. Synchronous on purpose: everything
     * it writes is in memory, and the caller decides when to persist.
     */
    finish(completed: boolean, summary?: string | null): StudySummaryPayload {
        if (!this.finished) {
            this.finished = true;
            this.session.endedAt = Date.now();
            this.session.completed = completed;
            // A session that is closed mid-way has no tutor-written summary, and
            // "Session ended without a written summary" tells the next session
            // nothing. Describe what actually happened instead.
            this.session.summary = summary ?? this.session.summary ?? this.describeOutcome();
            this.session.score = this.computeSessionScore();
            this.session.objectivesMastered = Array.from(new Set(this.session.objectivesMastered));
            this.planService.saveSession(this.session);
            this.planService.noteSessionFinished(this.notePath, this.session.summary, completed);
        }

        const digest = this.getDigest();
        const mastered = this.session.objectivesMastered;
        const fragile = this.session.objectivesTouched.filter(id => {
            const state = this.progress.objectives[id];
            return state !== undefined &&
                (state.status === StudyObjectiveStatus.Fragile || state.status === StudyObjectiveStatus.Learning);
        });

        const payload: StudySummaryPayload = {
            notePath: this.notePath,
            session: this.session,
            score: this.session.score ?? 0,
            digest,
            mastered,
            fragile,
            markdown: renderSessionMarkdown(this.plan, {
                session: this.session,
                digest,
                mastered,
                fragile,
                score: this.session.score ?? 0,
            }),
        };

        this.pendingPrompt = null;
        this.emit({ type: 'stage', stage: StudyStage.Complete });
        this.emit({ type: 'complete', summary: payload });
        return payload;
    }

    /**
     * A short, factual account of the session for the next briefing.
     *
     * Built from what the engine observed rather than written by the model, so
     * stopping early still leaves the next session something true to go on.
     */
    private describeOutcome(): string {
        const touched = this.session.objectivesTouched.length;
        const solid = this.session.objectivesMastered.length;
        const fragile = this.session.objectivesTouched.filter(id => {
            const state = this.progress.objectives[id];
            return state !== undefined &&
                (state.status === StudyObjectiveStatus.Fragile || state.status === StudyObjectiveStatus.Learning);
        }).length;
        const errors = Object.entries(this.session.errorCounts)
            .filter(([category, count]) => category !== 'success' && (count ?? 0) > 0)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .slice(0, 2)
            .map(([category, count]) => `${category.replace(/-/g, ' ')} ×${count}`)
            .join(', ');

        const parts = [
            `Worked on ${touched} of ${this.plan.objectives.length} objectives.`,
            solid > 0 ? `${solid} became solid.` : '',
            fragile > 0 ? `${fragile} still need${fragile === 1 ? 's' : ''} another pass.` : '',
            errors ? `Errors: ${errors}.` : 'No errors recorded.',
            `Covered ${this.planService.coverageCount(this.plan, this.progress)}/${this.plan.objectives.length} overall.`,
        ];
        return parts.filter(Boolean).join(' ');
    }

    /**
     * Score the session from the objectives the learner actually worked on.
     *
     * Cross-day recall is capped inside a session's own evidence, so a single
     * sitting can never produce a perfect score — which is the honest answer,
     * and keeps the review rating derived from it conservative.
     */
    private computeSessionScore(): number {
        return computeSessionScore(this.progress, this.session.objectivesTouched);
    }
}

/** Pull objectives out of a chart reply whatever shape they arrived in. */
function collectObjectives(parsed: Record<string, unknown>): unknown[] {
    const direct = parsed.objectives;
    if (Array.isArray(direct)) return direct;
    const nested = parsed.chart;
    if (nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).objectives)) {
        return (nested as Record<string, unknown>).objectives as unknown[];
    }
    for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) {
            const looksLikeObjectives = value.some(entry => entry && typeof entry === 'object' && 'statement' in (entry as object));
            if (looksLikeObjectives) return value;
        }
    }
    return [];
}

/** Snapshot of charting progress for the plan. */
function partialChartState(
    fingerprint: string,
    sections: ChartSection[],
    done: Set<number>,
    failures: Map<number, string>
): StudyChartState {
    return {
        fingerprint,
        total: sections.length,
        done: [...done].sort((a, b) => a - b),
        failed: [...failures.entries()].map(([index, reason]) => ({ index, reason })),
        updatedAt: Date.now(),
    };
}

/** Text sent when the learner steers the session by hand. */
function steeringText(command: StudyCommand): string {
    switch (command) {
        case 'harder':
            return '(The learner asked for something harder.) Raise the difficulty one step and continue.';
        case 'easier':
            return '(The learner asked for something easier.) Drop a step, offer a smaller question, and rebuild from there.';
        case 'more':
            return '(The learner asked for more explanation.) Explain this objective in more depth, from a different angle, then re-test.';
        case 'skip':
            return '(The learner asked to move on.) Acknowledge briefly, park this objective, and move to the next one in the focus order.';
        default:
            return '(Continue.)';
    }
}

/**
 * The session engine for Spaceforge Study.
 */

