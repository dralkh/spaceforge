import { Notice, TFile, normalizePath } from 'obsidian';
import SpaceforgePlugin from '../main';
import { StudyChartReport, StudySummaryPayload } from '../models/study';
import { FsrsRating, ReviewResponse } from '../models/review-schedule';
import { StudyPlanService } from '../services/study-plan-service';
import { StudySessionService } from '../services/study-session-service';
import { StudyWebSearchService } from '../services/study-web-search-service';
import { inspectChatProvider } from '../api/chat-client';
import { mapScoreToFsrsRating, mapScoreToSm2Response } from '../utils/rating';

/** Live progress of one note's charting job, for whatever UI is watching. */
export interface StudyChartUpdate {
    path: string;
    /** Sections finished so far. */
    done: number;
    /** Sections the note splits into. */
    total: number;
    /** Objectives in the plan right now. */
    objectives: number;
    /** Progress line fit for a status bar. */
    message: string;
    /** True on the final update of a job. */
    complete: boolean;
    /** Set when the job produced nothing at all. */
    error: string | null;
    /** Sections left for a later run. */
    pending: number;
}

/**
 * Entry points for the Study feature.
 *
 * Everything that starts a study session, charts a note, or reports on its
 * state goes through here, so the guards (feature enabled, provider
 * configured, note is markdown) are asked once and answered the same way
 * everywhere.
 *
 * Charting is owned here rather than by each caller: one job per note, shared
 * by whoever asks — a study panel opening, the background queue, a command —
 * with progress published to every listener. That is what stops two code paths
 * charting the same note at once and fighting over the plan, and it is what
 * lets a UI show charting progress without ever waiting for it.
 */
/**
 * What a finished study sitting did to the schedule, and what it would have
 * suggested if it did not do it.
 *
 * The suggestion travels with the result so the docked UI can offer the grade
 * the score implies without deciding on the learner's behalf.
 */
export interface StudySessionOutcome {
    applied: boolean;
    ratingLabel: string;
    suggested: { rating: number; label: string; ratingKind: 'fsrs' | 'auto' } | null;
}

export class StudyController {
    plugin: SpaceforgePlugin;
    planService: StudyPlanService;
    searchService: StudyWebSearchService;

    private chartJobs = new Map<string, Promise<StudyChartReport | null>>();
    private chartProgress = new Map<string, StudyChartUpdate>();
    private chartListeners: ((update: StudyChartUpdate) => void)[] = [];
    private queueAttached = false;

    constructor(plugin: SpaceforgePlugin, planService: StudyPlanService, searchService: StudyWebSearchService) {
        this.plugin = plugin;
        this.planService = planService;
        this.searchService = searchService;
    }

    /** Whether a session could be started right now, and why not if not. */
    status(): { ok: boolean; reason: string | null } {
        if (!this.plugin.settings.studyEnabled) {
            return { ok: false, reason: 'Study is turned off in settings' };
        }
        const provider = inspectChatProvider(this.plugin.settings);
        if (!provider.ready) {
            return { ok: false, reason: provider.reason ?? 'No AI provider configured' };
        }
        return { ok: true, reason: null };
    }

    /** Short label describing where the tutor will get its answers. */
    providerLabel(): string {
        const provider = inspectChatProvider(this.plugin.settings);
        return provider.ready ? `${provider.label} · ${provider.model}` : (provider.reason ?? 'Not configured');
    }

    /** Cheap state used by the sidebar to badge a note row. */
    studyBadge(notePath: string): { hasPlan: boolean; due: number; mastered: number; total: number; charting: boolean } {
        const charting = this.isCharting(notePath);
        const plan = this.planService.getPlan(notePath);
        if (!plan) return { hasPlan: false, due: 0, mastered: 0, total: 0, charting };
        const store = this.planService.getProgress(notePath);
        if (!store) return { hasPlan: true, due: 0, mastered: 0, total: plan.objectives.length, charting };
        const due = this.planService.dueObjectives(plan, store).length;
        const mastered = plan.objectives.filter(objective => store.objectives[objective.id]?.status === 'mastered').length;
        return { hasPlan: true, due, mastered, total: plan.objectives.length, charting };
    }

    // ------------------------------------------------------------- charting

    /**
     * Tell the controller which note is open in a study surface right now.
     *
     * The background chart queue uses it to step around the note being studied:
     * re-charting the plan under someone mid-session is worse than waiting a
     * tick.
     */
    setStudyingNote(path: string | null): void {
        this.plugin.studyChartQueue?.setStudyingPath(path);
    }

    /**
     * Mirror the background queue's progress into this controller's chart
     * channel.
     *
     * The queue charts without going through `startChart`, so without this a
     * note charting in the background looks idle to the Study panel and to the
     * review dialog, and the learner sees an empty rail with no explanation.
     * Called once the queue exists (it is created after this controller).
     */
    attachToChartQueue(): void {
        const queue = this.plugin.studyChartQueue;
        if (!queue || this.queueAttached) return;
        this.queueAttached = true;

        let last: string | null = null;
        queue.subscribe(status => {
            if (status.active) {
                last = status.active;
                const progress = status.progress;
                this.publish(status.active, {
                    done: progress?.done ?? 0,
                    total: progress?.total ?? 0,
                    objectives: progress?.objectives ?? 0,
                    pending: Math.max(0, (progress?.total ?? 0) - (progress?.done ?? 0)),
                    message: status.message,
                });
                return;
            }

            if (!last) return;
            const previous = this.chartProgress.get(last);
            if (previous && !previous.complete) {
                // The queue has moved on: close this note's progress out so
                // every surface stops showing a spinner.
                this.publish(last, {
                    done: previous.total || previous.done,
                    total: previous.total,
                    objectives: previous.objectives,
                    pending: 0,
                    complete: true,
                    message: previous.message,
                });
            }
            last = null;
        });
    }

    /** Watch charting progress; returns an unsubscribe function. */
    subscribeChart(listener: (update: StudyChartUpdate) => void): () => void {
        this.chartListeners.push(listener);
        return () => {
            this.chartListeners = this.chartListeners.filter(existing => existing !== listener);
        };
    }

    /**
     * Whether this note is being charted right now, by this controller's own job
     * or by the background queue. The queue charts without going through
     * `startChart`, and a surface that only watched `chartJobs` would show a
     * note mid-chart as idle.
     */
    isCharting(notePath: string): boolean {
        if (this.chartJobs.has(notePath)) return true;
        return this.plugin.studyChartQueue?.getStatus().active === notePath;
    }

    anyCharting(): boolean {
        return this.chartJobs.size > 0;
    }

    /** Progress of a note's charting job, if one has run recently. */
    chartUpdate(notePath: string): StudyChartUpdate | null {
        const own = this.chartProgress.get(notePath);
        if (own) return own;

        // Background queue progress, in the same shape, so every surface reads
        // one channel.
        const status = this.plugin.studyChartQueue?.getStatus();
        if (status?.active !== notePath) return null;
        return {
            path: notePath,
            done: status.progress?.done ?? 0,
            total: status.progress?.total ?? 0,
            objectives: status.progress?.objectives ?? 0,
            pending: Math.max(0, (status.progress?.total ?? 0) - (status.progress?.done ?? 0)),
            complete: false,
            error: null,
            message: status.message,
        };
    }

    /**
     * Chart a note in the background.
     *
     * Concurrent callers for the same note share one job, and the returned
     * promise is safe to ignore: progress goes out through `subscribeChart`, so
     * no UI ever has to block on it.
     */
    async startChart(
        notePath: string,
        options: { rechart?: boolean; maxSections?: number } = {}
    ): Promise<StudyChartReport | null> {
        const existing = this.chartJobs.get(notePath);
        if (existing) return existing;

        const status = this.status();
        if (!status.ok) {
            new Notice(`Study charting is not available: ${status.reason}`);
            return null;
        }

        const job = this.runChartJob(notePath, options);
        this.chartJobs.set(notePath, job);
        try {
            return await job;
        } finally {
            this.chartJobs.delete(notePath);
        }
    }

    private publish(notePath: string, update: Partial<StudyChartUpdate> & { message: string }): void {
        const previous = this.chartProgress.get(notePath);
        const full: StudyChartUpdate = {
            path: notePath,
            done: update.done ?? previous?.done ?? 0,
            total: update.total ?? previous?.total ?? 0,
            objectives: update.objectives ?? previous?.objectives ?? 0,
            pending: update.pending ?? previous?.pending ?? 0,
            complete: update.complete ?? false,
            error: update.error ?? null,
            message: update.message,
        };
        this.chartProgress.set(notePath, full);
        for (const listener of [...this.chartListeners]) {
            try {
                listener(full);
            } catch {
                // A broken listener must not stop charting.
            }
        }
    }

    private async runChartJob(
        notePath: string,
        options: { rechart?: boolean; maxSections?: number }
    ): Promise<StudyChartReport | null> {
        const content = await this.readNote(notePath);
        if (content === null) {
            new Notice('Could not read that note.');
            return null;
        }

        const name = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');
        this.publish(notePath, { message: `Charting ${name}…` });

        try {
            const report = await StudySessionService.chart(this.plugin, this.planService, notePath, content, {
                rechart: options.rechart,
                maxSections: options.maxSections,
                onStatus: text => this.publish(notePath, { message: text }),
                onProgress: partial => {
                    const state = partial.plan.chartState;
                    this.publish(notePath, {
                        done: state ? state.done.length : partial.sections.length,
                        total: state ? state.total : partial.sections.length,
                        objectives: partial.plan.objectives.length,
                        pending: partial.pending,
                        message: `Charting ${name}: ${partial.plan.objectives.length} objectives so far`,
                    });
                },
            });

            if (!report) {
                this.publish(notePath, {
                    complete: true,
                    error: 'No objectives could be extracted from this note.',
                    message: `Charting ${name} failed`,
                });
                return null;
            }

            const state = report.plan.chartState;
            this.publish(notePath, {
                done: state ? state.done.length : 0,
                total: state ? state.total : 0,
                objectives: report.plan.objectives.length,
                pending: report.pending,
                complete: report.complete,
                message: report.complete
                    ? `Charted ${name}: ${report.plan.objectives.length} objectives`
                    : `Charting ${name}: ${report.plan.objectives.length} objectives (${report.pending} section${report.pending === 1 ? '' : 's'} left)`,
            });
            await this.plugin.savePluginData();
            return report;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.publish(notePath, {
                complete: true,
                error: message,
                message: `Charting ${name} failed: ${message.slice(0, 80)}`,
            });
            return null;
        }
    }

    /**
     * Open the Study window for a note.
     *
     * Without a path this uses the active note, which is what the command
     * palette and the ribbon expect.
     */
    openStudy(notePath?: string): void {
        const status = this.status();
        if (!status.ok) {
            new Notice(`Study is not available: ${status.reason}`);
            return;
        }

        const path = notePath ?? this.plugin.app.workspace.getActiveFile()?.path ?? null;
        if (!path) {
            new Notice('Open a note first, or pick one from the sidebar.');
            return;
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== 'md') {
            new Notice('Study works on notes.');
            return;
        }

        // Loaded on demand: the panel is only needed when there is no review bar
        // to dock it into, and await keeps the failure path in one place.
        void (async () => {
            const { StudyModal } = await import('../ui/study-modal');
            new StudyModal(this.plugin, this, path).open();
        })();
    }

    /** Read a note's body, or null when it has gone away. */
    async readNote(notePath: string): Promise<string | null> {
        const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile) || file.extension !== 'md') return null;
        try {
            return await this.plugin.app.vault.read(file);
        } catch {
            return null;
        }
    }

    /**
     * Chart a note and wait for it, for the paths that can afford a notice
     * (commands, context menu). The study panel and the background queue call
     * `startChart` instead and watch progress.
     */
    async chartNote(notePath: string, rechart = false): Promise<number | null> {
        const notice = new Notice('Study: reading the note…', 0);
        const unsubscribe = this.subscribeChart(update => {
            if (update.path === notePath) notice.setMessage(`Study: ${update.message}`);
        });
        try {
            const report = await this.startChart(notePath, { rechart });
            if (!report) {
                notice.setMessage('Study: charting produced no objectives.');
                return null;
            }
            const change = rechart
                ? `kept ${report.kept}, added ${report.added}${report.dropped > 0 ? `, dropped ${report.dropped}` : ''}`
                : `${report.added} objectives from ${report.sections.length} section${report.sections.length === 1 ? '' : 's'}`;
            notice.setMessage(`Study: charted this note — ${change}.`);
            window.setTimeout(() => notice.hide(), 4000);
            return report.plan.objectives.length;
        } finally {
            unsubscribe();
        }
    }

    /** Forget the mastery state for a note, keeping the chart. */
    async resetProgress(notePath: string): Promise<void> {
        this.planService.resetProgress(notePath);
        await this.plugin.savePluginData();
        new Notice('Study progress for this note was reset.');
    }

    /** Forget the plan, the progress and the sessions for a note. */
    async forgetNote(notePath: string): Promise<void> {
        this.planService.removeForNote(notePath);
        await this.plugin.savePluginData();
        new Notice('Study data for this note was removed.');
    }

    /**
     * Feed a finished session back into the spaced-repetition schedule.
     *
     * This is the part the equivalent prompt-based setup cannot do: the same
     * evidence that produced the mastery state also moves the note's review
     * date, using the same rating scale the MCQ sessions use.
     */
    async applySessionResult(payload: StudySummaryPayload): Promise<StudySessionOutcome> {
        const score = payload.score;
        const schedule = this.plugin.reviewScheduleService.schedules[payload.notePath];

        // What the score implies, on the scale this note actually uses. Handed
        // back to the UI either way, so a session that is not auto-recorded can
        // still suggest a grade instead of guessing for the learner.
        const ratingKind = schedule?.schedulingAlgorithm === 'fsrs' ? 'fsrs' as const : 'auto' as const;
        const rating: ReviewResponse | FsrsRating = ratingKind === 'fsrs'
            ? mapScoreToFsrsRating(score)
            : mapScoreToSm2Response(score);
        const label = ratingKind === 'fsrs'
            ? FsrsRating[rating as FsrsRating]
            : ReviewResponse[rating as ReviewResponse];
        const suggested = { rating: rating as number, label, ratingKind };

        if (!this.plugin.settings.studyAutoRateNote) {
            new Notice(`Study complete: ${Math.round(score * 100)}% — grade it from the review bar (${label} suggested).`);
            return { applied: false, ratingLabel: '', suggested };
        }

        if (!schedule) {
            new Notice(`Study complete. Score ${Math.round(score * 100)}%. This note is not in the review schedule, so no review was recorded.`);
            return { applied: false, ratingLabel: '', suggested };
        }

        try {
            // No navigation: finishing a sitting is not a reason to move the
            // learner off the note they just studied.
            await this.plugin.reviewController.processReviewResponse(payload.notePath, rating, { ratingKind, navigate: false });
            new Notice(`Study complete: ${Math.round(score * 100)}% · recorded as "${label}".`);
        } catch {
            new Notice(`Study complete: ${Math.round(score * 100)}%. The review could not be recorded.`);
            return { applied: false, ratingLabel: '', suggested };
        }
        return { applied: true, ratingLabel: label, suggested };
    }

    /**
     * Write the session report into the vault next to the note.
     *
     * Appends to the existing report rather than scattering numbered copies,
     * because the point is a growing record for one note.
     */
    async exportSession(payload: StudySummaryPayload): Promise<string | null> {
        const noteFile = this.plugin.app.vault.getAbstractFileByPath(payload.notePath);
        const baseName = (payload.notePath.split('/').pop() ?? 'note').replace(/\.md$/, '');
        const parent = noteFile instanceof TFile ? noteFile.parent?.path ?? '' : '';
        const targetPath = normalizePath(`${parent ? `${parent}/` : ''}${baseName} — study notes.md`);

        const body = `${payload.markdown}\n`;

        try {
            const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
            if (existing instanceof TFile) {
                // process() is atomic: another plugin appending at the same moment
                // cannot lose either write, which read-then-modify can.
                await this.plugin.app.vault.process(existing, previous => `${previous.trimEnd()}\n\n---\n\n${body}`);
            } else {
                await this.plugin.app.vault.create(targetPath, body);
            }
            new Notice(`Study notes saved to ${targetPath}`);
            return targetPath;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Could not save study notes: ${message}`);
            return null;
        }
    }
}
