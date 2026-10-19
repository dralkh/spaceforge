import SpaceforgePlugin from '../main';
import { isDeckPath } from '../models/anki';
import { StudyPlan } from '../models/study';
import { getDomainProfile } from '../models/study-domains';
import { StudyPlanService } from './study-plan-service';
import { StudySessionService } from './study-session-service';

/**
 * Background charting — and the two follow-ups that finish a note.
 *
 * Charting a note is several model calls, which is far too slow to do while
 * someone waits for a window to open. So it is a queue: notes are charted a few
 * sections at a time, in the background, while the learner does something else,
 * and anything already charted is skipped forever.
 *
 * The queue is deliberately not persisted. It is re-derived from the review
 * schedule on load — "scheduled and not fully charted" is the queue — which
 * means a crash, a quit or a paused run costs nothing and cannot desynchronise
 * from the actual state of the vault.
 *
 * Once a note's plan is ready, the auto-pilot finishes it: the visual pack
 * first, then the question set (`notifyPlanReady`, driven by the plan service's
 * own "ready" announcement). Both steps are opt-in and off by default, and
 * neither is a scheduler of its own — each one is the same single-flight
 * operation the panel and the dock already call.
 */

export interface StudyChartQueueStatus {
    /** Notes waiting, including the one in progress. */
    queued: number;
    /** Note currently being charted, if any. */
    active: string | null;
    /** How far the note in progress has got, when one is running. */
    progress: { done: number; total: number; objectives: number } | null;
    /** Human-readable progress line for the sidebar. */
    message: string;
    /** Notes finished in this session. */
    completed: number;
    /** Notes parked after repeated failures, with the reason. */
    problems: { path: string; reason: string }[];
    paused: boolean;
    /** Why the queue is paused, when it is. */
    pausedReason: string | null;
}

/** Sections charted per note per tick, so a long note does not hog the provider. */
const DEFAULT_SECTIONS_PER_RUN = 3;
/** Attempts for one note before it is parked. */
const MAX_ATTEMPTS_PER_NOTE = 3;
/** Charting runs in a row that add nothing before the queue gives up on a note. */
const MAX_STALLED_RUNS = 2;
/** Gap between notes, to stay a polite background task. */
const GAP_MS = 1200;

export class StudyChartQueueService {
    private plugin: SpaceforgePlugin;
    private planService: StudyPlanService;
    private queue: string[] = [];
    private active: string | null = null;
    private running = false;
    private stopped = false;
    private completed = 0;
    private problems = new Map<string, { reason: string; attempts: number }>();
    private paused = false;
    private pausedReason: string | null = null;
    private message = '';
    private listeners: ((status: StudyChartQueueStatus) => void)[] = [];
    /** Note currently open in a study window; the queue steps around it. */
    private studyingPath: string | null = null;
    /** Runs that charted nothing new, per note: stops a hopeless retry loop. */
    private stalls = new Map<string, number>();
    /** Last seen progress, to tell "still moving" from "stuck". */
    private progressAt = new Map<string, { done: number; objectives: number }>();
    /** Live counters for the note being charted, for the sidebar and the panel. */
    private activeProgress: { done: number; total: number; objectives: number } | null = null;
    /**
     * The auto-pilot, one run per note.
     *
     * The per-step operations are each single-flight already (the visual
     * service's in-flight map, the question controller's own map); this one
     * covers the sequence itself, so a plan re-saved mid-generation — which
     * notifies again — joins the run instead of starting a second one.
     */
    private autoPilotRuns = new Map<string, Promise<void>>();

    constructor(plugin: SpaceforgePlugin, planService: StudyPlanService) {
        this.plugin = plugin;
        this.planService = planService;
    }

    subscribe(listener: (status: StudyChartQueueStatus) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(existing => existing !== listener);
        };
    }

    private emit(): void {
        const status = this.getStatus();
        for (const listener of [...this.listeners]) {
            try {
                listener(status);
            } catch {
                // A broken listener must not stop charting.
            }
        }
    }

    getStatus(): StudyChartQueueStatus {
        return {
            queued: this.queue.length + (this.active ? 1 : 0),
            active: this.active,
            progress: this.activeProgress,
            message: this.message,
            completed: this.completed,
            problems: [...this.problems.entries()].map(([path, entry]) => ({ path, reason: entry.reason })),
            paused: this.paused,
            pausedReason: this.pausedReason,
        };
    }

    /** Whether background charting is switched on in settings. */
    isEnabled(): boolean {
        return this.plugin.settings.studyEnabled && this.plugin.settings.studyAutoChart;
    }

    /** Whether a finished chart should draw the note's study material. */
    private autoMaterialsEnabled(): boolean {
        return this.plugin.settings.studyEnabled && this.plugin.settings.studyAutoMaterials;
    }

    /** Whether a finished chart should write the note's question set. */
    private autoMcqEnabled(): boolean {
        return this.plugin.settings.studyEnabled && this.plugin.settings.studyAutoMcq;
    }

    /**
     * A note's plan just became ready: finish it, without a single click.
     *
     * The reader who turns the auto-pilot on is saying "a charted note should
     * end up complete" — material first (the note's own shape), then the
     * questions written against it. This never blocks the caller and never
     * throws: the sequence runs behind it, and a step that fails is logged
     * rather than announced, because a silent failure inside one background
     * note is not worth a notice per retry.
     *
     * Off by default on both counts, so a vault that asked for nothing
     * generates nothing. A second ask (the plan service announces on every save
     * of a ready plan) joins the run in flight; a run is skipped outright when
     * both steps already have what they would make.
     */
    notifyPlanReady(notePath: string): Promise<void> {
        // The deck lane keeps its own files: a deck is never charted into a
        // study plan and its questions come from its cards.
        if (isDeckPath(notePath)) return Promise.resolve();
        const running = this.autoPilotRuns.get(notePath);
        if (running) return running;
        if (!this.autoMaterialsEnabled() && !this.autoMcqEnabled()) return Promise.resolve();

        const plan = this.planService.getPlan(notePath);
        if (!plan || !StudyPlanService.planReady(plan)) return Promise.resolve();
        if (!this.hasFollowUpWork(plan)) return Promise.resolve();

        const run = this.runAutoPilot(notePath);
        const settle = (): void => {
            if (this.autoPilotRuns.get(notePath) === run) this.autoPilotRuns.delete(notePath);
        };
        void run.then(settle, settle);
        this.autoPilotRuns.set(notePath, run);
        return run;
    }

    /** True when a step of the auto-pilot still has something to make. */
    private hasFollowUpWork(plan: StudyPlan): boolean {
        if (this.autoMaterialsEnabled()) {
            const pack = plan.visuals;
            // No pack at all, or one drawn from a body the plan no longer
            // describes (the note was re-charted since it was made).
            if (!pack || pack.sourceHash !== plan.contentFingerprint) return true;
        }
        return this.autoMcqEnabled() && this.questionsNeeded(plan.notePath);
    }

    /** True when the note has no usable question set yet. */
    private questionsNeeded(notePath: string): boolean {
        if (!this.plugin.settings.enableMCQ || !this.plugin.mcqController) return false;
        const existing = this.plugin.mcqService?.getMCQSetForNote(notePath) ?? null;
        if (!existing) return true;
        return existing.questions.length === 0 || existing.needsQuestionRegeneration === true;
    }

    /**
     * The two steps, in the order a reader would take them.
     *
     * A failure in one step never stops the other: the material's own state
     * line in the Study panel and the questions tab are where a failure shows
     * when the reader looks, and the console is where it is recorded.
     */
    private async runAutoPilot(notePath: string): Promise<void> {
        const name = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');
        if (this.autoMaterialsEnabled()) {
            try {
                await this.makeMaterials(notePath);
            } catch (error) {
                console.warn(`spaceforge: the study material for ${name} was not made:`, error);
            }
        }
        if (this.autoMcqEnabled()) {
            try {
                await this.makeQuestions(notePath);
            } catch (error) {
                console.warn(`spaceforge: the questions for ${name} were not written:`, error);
            }
        }
    }

    /** Draw the pack for a ready plan that has none, or one older than the note. */
    private async makeMaterials(notePath: string): Promise<void> {
        const plan = this.planService.getPlan(notePath);
        if (!plan) return;
        const content = await this.readNote(notePath);
        if (content === null) return;

        const fingerprint = StudyPlanService.fingerprint(content);
        const service = this.plugin.studyVisualService;
        // The panel's own staleness rule, applied one call earlier: a pack made
        // from this exact body is left alone, so a re-notification costs
        // nothing.
        if (plan.visuals && !service.isStale(plan.visuals, fingerprint)) return;

        const pack = await service.generate({
            notePath,
            content,
            objectives: plan.objectives,
            // The body it was drawn from is the one just read, not the chart's
            // older fingerprint, so the pack is stamped with what it describes.
            fingerprint,
            profile: getDomainProfile(plan.domainId),
        });
        if (!pack) return;

        // A re-chart may have replaced the plan while the model was working:
        // the pack belongs on the plan that is stored now.
        const target = this.planService.getPlan(notePath) ?? plan;
        target.visuals = pack;
        this.planService.savePlan(target);
        await this.plugin.savePluginData();
    }

    /** Write the note's question set through the one shared preparation. */
    private async makeQuestions(notePath: string): Promise<void> {
        const controller = this.plugin.mcqController;
        if (!controller || !this.plugin.settings.enableMCQ) return;
        // ensureMcqSetForNote is single-flight per note and shared with the
        // dock and the review window: this is the preparation they would start,
        // so whoever asks second joins it instead of writing a second set.
        await controller.ensureMcqSetForNote(notePath);
    }

    /** Tell the queue which note a study window currently has open. */
    setStudyingPath(path: string | null): void {
        this.studyingPath = path;
    }

    /** Add a note to the queue if it still needs charting. */
    enqueue(notePath: string, atFront = false): boolean {
        if (!this.plugin.settings.studyEnabled) return false;
        // The deck lane is a second lane beside notes: a deck file's cards are
        // scheduled per card, and the file itself is never charted.
        if (isDeckPath(notePath)) return false;
        if (this.problems.get(notePath)?.attempts !== undefined && (this.problems.get(notePath)?.attempts ?? 0) >= MAX_ATTEMPTS_PER_NOTE) {
            return false;
        }
        if (this.active === notePath) return false;
        if (this.queue.includes(notePath)) {
            // Already waiting: asking again means "do this one sooner".
            if (!atFront) return false;
            this.queue = this.queue.filter(path => path !== notePath);
            this.queue.unshift(notePath);
            this.emit();
            return true;
        }
        if (this.isComplete(notePath)) return false;
        if (atFront) this.queue.unshift(notePath);
        else this.queue.push(notePath);
        this.emit();
        return true;
    }

    /**
     * Re-derive the queue from the review schedule.
     *
     * Called on load and on every tick, so notes scheduled anywhere — folder
     * imports, the sidebar, drag and drop — are picked up without every call
     * site having to remember to enqueue them.
     */
    syncFromSchedules(scheduledPaths: string[]): number {
        if (!this.isEnabled() || this.paused) return 0;
        let added = 0;
        for (const path of scheduledPaths) {
            if (this.enqueue(path)) added += 1;
        }
        return added;
    }

    /** True when the note has a plan and every section of its body is charted. */
    isComplete(notePath: string): boolean {
        const plan = this.planService.getPlan(notePath);
        if (!plan) return false;
        const state = plan.chartState;
        if (!state) return plan.objectives.length > 0;
        return state.done.length >= state.total;
    }

    pause(reason: string | null = null): void {
        this.paused = true;
        this.pausedReason = reason;
        this.emit();
    }

    resume(): void {
        this.paused = false;
        this.pausedReason = null;
        this.emit();
    }

    /** Clear a parked note so it can be tried again. */
    retry(notePath: string): void {
        this.problems.delete(notePath);
        // A manual retry gets a fresh allowance.
        this.stalls.delete(notePath);
        this.progressAt.delete(notePath);
        this.enqueue(notePath, true);
        this.emit();
    }

    /** Forget a note entirely (it was removed, or the user asked for a re-chart). */
    cancel(notePath: string): void {
        this.queue = this.queue.filter(path => path !== notePath);
        if (this.active === notePath) this.active = null;
        this.problems.delete(notePath);
        this.emit();
    }

    stop(): void {
        this.stopped = true;
        this.queue = [];
        this.active = null;
    }

    /**
     * Do one unit of work: chart part of one note.
     *
     * Returns true when it did something, so callers can loop or wait for the
     * next tick.
     */
    async tick(): Promise<boolean> {
        if (this.stopped || this.running || this.paused) return false;
        if (!this.isEnabled()) return false;

        const notePath = this.queue.shift() ?? this.active;
        if (!notePath) {
            this.active = null;
            this.message = '';
            return false;
        }
        // Don't rewrite a plan someone is working through — but only when there
        // is one. An uncharted note that happens to be open is the whole reason
        // the queue exists, and deferring it looks like nothing is happening.
        const existing = this.planService.getPlan(notePath);
        const planInUse = !!existing && existing.objectives.length > 0;
        if (planInUse && this.studyingPath === notePath && this.queue.length > 0) {
            this.queue.push(notePath);
            return false;
        }

        const content = await this.readNote(notePath);
        if (content === null) {
            this.problems.set(notePath, { reason: 'the note could not be read', attempts: MAX_ATTEMPTS_PER_NOTE });
            this.active = null;
            this.emit();
            return true;
        }

        this.running = true;
        this.active = notePath;
        const name = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');
        const known = this.planService.getPlan(notePath);
        const knownState = known?.chartState;
        this.activeProgress = {
            done: knownState ? knownState.done.length : 0,
            total: knownState ? knownState.total : 0,
            objectives: known ? known.objectives.length : 0,
        };
        this.message = `Charting ${name}…`;
        this.emit();

        try {
            const sectionsPerRun = Math.max(1, this.plugin.settings.studyChartSectionsPerRun || DEFAULT_SECTIONS_PER_RUN);
            const report = await StudySessionService.chart(this.plugin, this.planService, notePath, content, {
                maxSections: sectionsPerRun,
                onStatus: text => {
                    this.message = text;
                    this.emit();
                },
                onProgress: partial => {
                    const state = partial.plan.chartState;
                    this.activeProgress = {
                        done: state ? state.done.length : partial.sections.length,
                        total: state ? state.total : partial.sections.length,
                        objectives: partial.plan.objectives.length,
                    };
                    this.emit();
                },
            });

            if (report) {
                const finalState = report.plan.chartState;
                this.activeProgress = {
                    done: finalState ? finalState.done.length : 0,
                    total: finalState ? finalState.total : 0,
                    objectives: report.plan.objectives.length,
                };
            }

            if (!report) {
                const entry = this.problems.get(notePath) ?? { reason: 'no objectives returned', attempts: 0 };
                entry.attempts += 1;
                entry.reason = this.message || 'no objectives returned';
                this.problems.set(notePath, entry);
                this.message = entry.attempts >= MAX_ATTEMPTS_PER_NOTE
                    ? `Charting ${name} failed — open it to retry`
                    : `Charting ${name} will be retried`;
                if (entry.attempts < MAX_ATTEMPTS_PER_NOTE) this.queue.push(notePath);
            } else if (report.complete) {
                this.completed += 1;
                this.problems.delete(notePath);
                this.stalls.delete(notePath);
                this.progressAt.delete(notePath);
                this.message = `Charted ${name}: ${report.plan.objectives.length} objectives`;
            } else {
                // More sections left. Continue with this note next tick rather
                // than dropping it to the back of a long queue — but only while
                // it is still making progress: a section that fails every time
                // would otherwise be retried for ever, spending money quietly.
                const state = report.plan.chartState;
                const now = { done: state ? state.done.length : 0, objectives: report.plan.objectives.length };
                const before = this.progressAt.get(notePath);
                const moved = !before || now.done > before.done || now.objectives > before.objectives;
                this.progressAt.set(notePath, now);

                const stalls = moved ? 0 : (this.stalls.get(notePath) ?? 0) + 1;
                this.stalls.set(notePath, stalls);

                if (stalls >= MAX_STALLED_RUNS) {
                    const stuck = (state?.failed ?? []).slice(0, 2).map(entry => `section ${entry.index + 1}: ${entry.reason}`).join('; ');
                    this.problems.set(notePath, {
                        reason: `${report.pending} section(s) would not chart — ${stuck || 'no objectives returned'}`,
                        attempts: MAX_ATTEMPTS_PER_NOTE,
                    });
                    this.message = `Charting ${name} stalled after ${stalls} attempts — open it to retry`;
                } else {
                    this.queue.unshift(notePath);
                    this.message = `Charting ${name}: ${report.plan.objectives.length} objectives so far`;
                }
            }
            await this.plugin.savePluginData();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.problems.set(notePath, { reason: message.slice(0, 200), attempts: MAX_ATTEMPTS_PER_NOTE });
            this.message = `Charting ${name} failed: ${message.slice(0, 80)}`;
        } finally {
            this.running = false;
            this.active = null;
            this.activeProgress = null;
            this.emit();
        }

        return true;
    }

    /** Drain the queue up to a time budget; used for "chart everything now". */
    async drain(maxNotes = 50): Promise<number> {
        let processed = 0;
        while (processed < maxNotes && this.queue.length > 0 && !this.stopped && !this.paused) {
            const didWork = await this.tick();
            if (!didWork) break;
            processed += 1;
            if (this.queue.length > 0) await new Promise(resolve => window.setTimeout(resolve, GAP_MS));
        }
        return processed;
    }

    private async readNote(notePath: string): Promise<string | null> {
        const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
        if (!file) return null;
        try {
            return await this.plugin.app.vault.cachedRead(file as never);
        } catch {
            return null;
        }
    }
}
