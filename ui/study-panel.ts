import { Component, EventRef, MarkdownRenderer, Menu, Notice, TFile, setIcon } from 'obsidian';
import SpaceforgePlugin from '../main';
import {
    STUDY_ERROR_LABELS,
    STUDY_STAGE_LABELS,
    STUDY_STAGE_ORDER,
    StudyDigest,
    StudyErrorCategory,
    StudyMode,
    StudyObjective,
    StudyObjectiveStatus,
    StudySessionEvent,
    StudySourceRef,
    StudyStage,
    StudySummaryPayload,
    TutorPromptSpec,
    TutorTurn,
} from '../models/study';
import { STUDY_DOMAINS, getDomainProfile } from '../models/study-domains';
import { StudyImageRef } from '../utils/study-media';
import { StudyChartUpdate, StudyController } from '../controllers/study-controller';
import { StudyBriefing, StudyCommand, StudySessionService } from '../services/study-session-service';
import { StudyPlanService } from '../services/study-plan-service';
import { StudyVisualPack } from '../models/study-visuals';
import { StudyMaterialHost, StudyMaterialSection, StudyMaterialState, StudyMaterialView, studyPackStateKey } from './study-material-section';
import {
    MODE_CHOICES,
    STATUS_LABELS,
    StudyBriefingHost,
    StudyBriefingView,
    TYPE_LABELS,
    modeLabel,
} from './study-briefing';
import { EstimationUtils } from '../utils/estimation';
import { stripRestatedQuestion } from './study-copy';
import { repairStudyWorkspace, studyUniqueId } from '../models/study-workspace';

interface WorkspaceViewState {
    activeView?: 'learn' | StudyMaterialView;
    objectiveId?: string | null;
    scroll?: Record<string, number>;
    material?: StudyMaterialState;
}

export interface StudyPanelOptions {
    /** Tighter layout for embedding above other content. */
    compact?: boolean;
    /** Called when a session finishes, with the report payload. */
    onSessionEnd?: (payload: StudySummaryPayload) => void;
    /** Called when the panel wants more room (host expands itself). */
    onRequestSpace?: () => void;
}

/**
 * The Study surface: briefing, live session and report, as a component that
 * lives *inside* whatever is showing the note.
 *
 * It is a panel rather than a window because studying is part of reviewing a
 * note, not a separate errand — the review dialog embeds it and grows when the
 * learner opts into study mode.
 *
 * Charting is never awaited here. If a note is only half charted the panel
 * still opens, shows what exists, and updates itself as sections land, because
 * making someone watch a spinner while a long note is charted was the wrong
 * trade in the first place.
 */
export class StudyPanel {
    private plugin: SpaceforgePlugin;
    private controller: StudyController;
    private notePath: string;
    private noteTitle: string;
    private options: StudyPanelOptions;

    private root: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private railEl: HTMLElement | null = null;
    private streamEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private stageEl: HTMLElement | null = null;
    private digestEl: HTMLElement | null = null;
    private composerEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendBtn: HTMLButtonElement | null = null;
    private webChip: HTMLElement | null = null;
    private chartLineEl: HTMLElement | null = null;
    private overflowEl: HTMLElement | null = null;
    private materialSection: StudyMaterialSection | null = null;
    private briefingView: StudyBriefingView | null = null;

    private session: StudySessionService | null = null;
    private unsubscribeSession: (() => void) | null = null;
    private unsubscribeChart: (() => void) | null = null;
    private unsubscribePreparation: (() => void) | null = null;
    private renderComponent = new Component();
    private closed = false;
    private finished = false;
    private resultRecorded = false;
    private mode: StudyMode = StudyMode.Guided;
    private modeButton: HTMLElement | null = null;
    private webSearch = false;
    private freshStart = false;
    private stage: StudyStage = StudyStage.Orient;
    private digest: StudyDigest | null = null;
    private heldFeedback: { text: string; correct: boolean | null; label: string }[] = [];
    private selectedObjectiveId: string | null = null;
    private statusTicker: number | null = null;
    private thinkingStartedAt = 0;
    private pendingChoiceButtons: HTMLButtonElement[] = [];
    private content = '';
    private briefing: StudyBriefing | null = null;
    private mounted = false;
    private learningEl: HTMLElement | null = null;
    private materialEl: HTMLElement | null = null;
    private viewButtons = new Map<string, HTMLButtonElement>();
    private activeView: 'learn' | StudyMaterialView = 'learn';
    private viewState: WorkspaceViewState = {};
    private workspaceProgress: HTMLElement | null = null;
    private objectiveChooser: HTMLSelectElement | null = null;
    private saveTimer: number | null = null;
    private workspaceResize: ResizeObserver | null = null;
    private starting = false;
    private readonly leaseToken = {};
    private leasePath: string | null = null;
    private renameRef: EventRef | null = null;
    private deleteRef: EventRef | null = null;
    private modifyRef: EventRef | null = null;
    private modifyTimer: number | null = null;

    constructor(plugin: SpaceforgePlugin, controller: StudyController, notePath: string, options: StudyPanelOptions = {}) {
        this.plugin = plugin;
        this.controller = controller;
        this.notePath = notePath;
        this.options = options;
        this.noteTitle = (notePath.split('/').pop() ?? notePath).replace(/\.md$/, '');
    }

    // ------------------------------------------------------------ lifecycle

    /** Build the panel inside `container` and show the briefing. */
    mount(container: HTMLElement): void {
        this.renderComponent.load();
        this.mounted = true;
        this.closed = false;
        container.empty();
        container.addClass('sf-study-panel');
        if (this.options.compact) container.addClass('is-compact');
        this.root = container;
        if (typeof ResizeObserver !== 'undefined') {
            this.workspaceResize = new ResizeObserver(() => {
                const height = container.clientHeight;
                this.overflowEl?.toggleClass('is-short', height > 0 && height < 480);
            });
            this.workspaceResize.observe(container);
        }

        this.chartLineEl = container.createDiv('sf-study-chartline');
        this.overflowEl = container.createDiv('sf-study-panel-body');

        this.unsubscribeChart = this.controller.subscribeChart(update => {
            if (update.path === this.notePath) this.onChartProgress(update);
        });
        this.unsubscribePreparation = this.plugin.studyChartQueue?.subscribePreparation?.(status => {
            if (status.notePath !== this.notePath || this.closed) return;
            this.materialSection?.refresh();
            if (status.materials === 'ready') void this.controller.readNote(this.notePath).then(content => {
                if (this.closed) return;
                if (content !== null) this.content = content;
                this.materialSection?.refresh();
            });
        }) ?? null;
        const vault = this.plugin.app?.vault;
        if (vault) {
            this.renameRef = vault.on('rename', (file, oldPath) => {
                const moved = this.movedPath(oldPath, file.path);
                if (moved) void this.followNote(moved);
            });
            this.deleteRef = vault.on('delete', file => {
                if (file.path === this.notePath) this.noteGone();
            });
            this.modifyRef = vault.on('modify', file => {
                if (file.path !== this.notePath) return;
                if (this.modifyTimer !== null) window.clearTimeout(this.modifyTimer);
                this.modifyTimer = window.setTimeout(() => {
                    this.modifyTimer = null;
                    void this.refreshNoteContent();
                }, 250);
            });
        }

        void this.init();
    }

    /** The path this panel would have after a file or folder move, if it moved. */
    private movedPath(oldPath: string, newPath: string): string | null {
        if (this.notePath === oldPath) return newPath;
        if (this.notePath.startsWith(`${oldPath}/`)) return newPath + this.notePath.slice(oldPath.length);
        return null;
    }

    private releaseStudyLease(): void {
        if (this.leasePath && typeof this.controller.releaseStudy === 'function') {
            this.controller.releaseStudy(this.leasePath, this.leaseToken);
        }
        this.leasePath = null;
    }

    /** A moved note keeps its sitting: checkpoint, rebind, then restore in place. */
    private async followNote(newPath: string): Promise<void> {
        if (newPath === this.notePath) return;
        if (this.session && !this.finished) {
            if (this.inputEl && this.inputEl.value !== this.session.getDraft()) this.session.setDraft(this.inputEl.value);
            try { this.session.suspend(); } catch { /* the save path reports */ }
        }
        this.stopTicker();
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
        this.session = null;
        this.releaseStudyLease();
        this.notePath = newPath;
        this.noteTitle = (newPath.split('/').pop() ?? newPath).replace(/\.md$/, '');
        this.finished = false;
        this.resultRecorded = false;
        this.starting = false;
        await this.init();
    }

    /** Deleted is not forgotten: keep the history, stop writing, and say so. */
    private noteGone(): void {
        if (this.session && !this.finished) {
            if (this.inputEl && this.inputEl.value !== this.session.getDraft()) this.session.setDraft(this.inputEl.value);
            try { this.session.suspend(); } catch { /* the history is still in memory */ }
        }
        this.stopTicker();
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
        this.session = null;
        this.finished = false;
        this.releaseStudyLease();
        this.controller.setStudyingNote?.(null);
        this.renderFailure('This note was deleted. Its learning history is kept; restore the note to continue.');
    }

    /** The note changed in another pane: freshness follows it without a remount. */
    private async refreshNoteContent(): Promise<void> {
        const content = await this.controller.readNote(this.notePath);
        if (this.closed || content === null) return;
        this.content = content;
        this.briefing = StudySessionService.prepare(
            this.plugin,
            this.controller.planService,
            this.controller.searchService,
            this.notePath,
            content,
        );
        if (!this.finished && !this.session) this.renderBriefing();
        this.materialSection?.refresh();
        this.updateWorkspaceProgress();
    }

    /** Tear the panel down: abort any session and unsubscribe everything. */
    unmount(): void {
        this.captureWorkspace();
        this.saveWorkspace();
        if (this.session && this.inputEl && this.inputEl.value !== this.session.getDraft()) this.session.setDraft(this.inputEl.value);
        this.closed = true;
        this.mounted = false;
        this.stopTicker();
        this.workspaceResize?.disconnect();
        this.workspaceResize = null;
        this.unsubscribeSession?.();
        this.briefingView?.destroy();
        this.briefingView = null;
        this.materialSection?.destroy();
        this.materialSection = null;
        this.unsubscribeSession = null;
        this.unsubscribeChart?.();
        this.unsubscribeChart = null;
        this.unsubscribePreparation?.();
        this.unsubscribePreparation = null;
        const vault = this.plugin.app?.vault;
        if (this.renameRef && vault) vault.offref(this.renameRef);
        this.renameRef = null;
        if (this.deleteRef && vault) vault.offref(this.deleteRef);
        this.deleteRef = null;
        if (this.modifyRef && vault) vault.offref(this.modifyRef);
        this.modifyRef = null;
        if (this.modifyTimer !== null) window.clearTimeout(this.modifyTimer);
        this.modifyTimer = null;
        if (this.session && !this.finished) {
            const session = this.session;
            try {
                session.suspend();
            } catch {
                // The window is going away; nothing useful to do.
            }
        }
        void this.plugin.savePluginData().catch(() => new Notice('Study progress could not be saved. Reopen the workspace to retry.'));
        this.session = null;
        this.releaseStudyLease();
        this.controller.setStudyingNote?.(null);
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.renderComponent.unload();
        this.root?.empty();
        this.root = null;
    }

    isStudying(): boolean {
        return this.session !== null && !this.finished;
    }

    /** Number/letter hotkeys for multiple choice, forwarded by the host. */
    handleChoiceKey(index: number): boolean {
        const button = this.pendingChoiceButtons[index];
        if (!button) return false;
        button.click();
        return true;
    }

    private async init(): Promise<void> {
        const content = await this.controller.readNote(this.notePath);
        if (this.closed) return;
        if (content === null) {
            this.renderFailure('This note could not be read. It may have been moved or deleted.');
            return;
        }
        this.content = content;
        this.briefing = StudySessionService.prepare(this.plugin, this.controller.planService, this.controller.searchService, this.notePath, content);
        if (this.briefing.hasPlan) this.mode = this.briefing.suggestedMode;
        this.webSearch = this.briefing.webDefault;
        const plan = this.controller.planService.getPlan(this.notePath);
        const store = this.controller.planService.getProgress(this.notePath);
        const savedWorkspace = store?.workspace
            ? repairStudyWorkspace(store.workspace, plan ? new Set(plan.objectives.map(objective => objective.id)) : null)
            : null;
        if (savedWorkspace && store) store.workspace = savedWorkspace.workspace;
        if (savedWorkspace && savedWorkspace.droppedThreads > 0) {
            new Notice(`Study removed ${savedWorkspace.droppedThreads} unreadable or over-limit conversation${savedWorkspace.droppedThreads === 1 ? '' : 's'}.`, 6000);
        }
        if (savedWorkspace?.changed) this.saveWorkspace();
        this.viewState = (store?.workspace?.viewState ?? {}) as WorkspaceViewState;
        this.pruneViewState();
        this.activeView = this.viewState.activeView ?? 'learn';
        this.buildWorkspace();
        this.renderBriefing();
        const workspace = store?.workspace;
        const savedThread = workspace?.activeThreadId ? workspace.threads[workspace.activeThreadId] : null;
        const savedIsCurrent = savedThread !== null
            && !savedThread.archived
            && savedThread.objective !== null
            && (plan?.objectives.some(objective => objective.id === savedThread.objective!.id) ?? false);
        // Resume only when there is real unfinished work: an unanswered request
        // or typed draft. Opening a note to browse must not look like a sitting.
        const resumable = !!savedThread
            && (savedThread.draft.trim().length > 0 || savedThread.checkpoint.pendingRequest !== null);
        if (savedThread && savedIsCurrent && savedThread.checkpoint.finished && !this.freshStart) void this.startSession(true);
        else if (savedThread && savedIsCurrent && (this.freshStart || resumable)) void this.startSession();

        // Kick off charting in the background if the note is not fully charted.
        const state = plan?.chartState ?? null;
        const incomplete = !plan || !state || state.done.length < state.total;
        if (incomplete && this.controller.status().ok && !this.controller.isCharting(this.notePath)) {
            void this.controller.startChart(this.notePath);
        } else if (this.controller.isCharting(this.notePath)) {
            const update = this.controller.chartUpdate(this.notePath);
            if (update) this.onChartProgress(update);
        }
    }

    private buildWorkspace(): void {
        const host = this.overflowEl;
        if (!host) return;
        host.empty();
        this.materialSection?.destroy();
        this.materialSection = null;
        host.addClass('sf-study-workspace');
        const heading = host.createDiv('sf-study-workspace-heading');
        const title = heading.createEl('button', { cls: 'sf-study-workspace-note', text: this.noteTitle });
        title.setAttribute('title', 'Open source note');
        title.addEventListener('click', () => void this.plugin.app.workspace.openLinkText(this.notePath, '', false));
        this.workspaceProgress = heading.createDiv('sf-study-workspace-progress');
        this.updateWorkspaceProgress();
        const nav = host.createDiv('sf-study-workspace-views');
        nav.setAttribute('role', 'group');
        nav.setAttribute('aria-label', 'Learning view');
        this.viewButtons.clear();
        for (const [view, label] of [['learn', 'Learn'], ['board', 'Visualize'], ['mindmap', 'Mind map'], ['summary', 'Summary']] as const) {
            const button = nav.createEl('button', { cls: 'sf-study-workspace-view', text: label });
            button.addEventListener('click', () => this.switchWorkspaceView(view));
            this.viewButtons.set(view, button);
        }
        this.learningEl = host.createDiv('sf-study-workspace-learn');
        this.materialEl = host.createDiv('sf-study-workspace-material');
        this.switchWorkspaceView(this.activeView, false);
    }

    private switchWorkspaceView(view: 'learn' | StudyMaterialView, capture = true): void {
        if (capture) this.captureWorkspace();
        this.activeView = view;
        this.viewState.activeView = view;
        this.learningEl?.toggleClass('sf-hidden', view !== 'learn');
        this.materialEl?.toggleClass('sf-hidden', view === 'learn');
        for (const [id, button] of this.viewButtons) {
            button.toggleClass('is-selected', view === id);
            button.setAttribute('aria-pressed', String(view === id));
        }
        if (view !== 'learn' && this.materialEl) {
            if (!this.materialSection) this.renderMaterialSection(this.materialEl);
            this.materialSection?.setView(view);
        }
        const key = `${view}:${this.session?.getActiveObjectiveId() ?? ''}`;
        if (this.overflowEl) this.overflowEl.scrollTop = this.viewState.scroll?.[key] ?? 0;
        this.saveWorkspace();
    }

    private captureWorkspace(): void {
        const key = `${this.activeView}:${this.session?.getActiveObjectiveId() ?? ''}`;
        (this.viewState.scroll ??= {})[key] = this.overflowEl?.scrollTop ?? 0;
        if (this.streamEl && this.session) this.viewState.scroll[`thread:${this.session.getActiveObjectiveId() ?? ''}`] = this.streamEl.scrollTop;
    }

    private saveWorkspace(): void {
        this.pruneViewState();
        const store = this.controller.planService.getProgress(this.notePath);
        if (store) {
            store.workspace ??= { schema: 1, id: studyUniqueId('workspace'), activeThreadId: null, threads: {}, updatedAt: Date.now() };
            store.workspace.viewState = { ...this.viewState };
        }
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.plugin.savePluginData().then(
                saved => { if (saved === false) this.renderError('Progress not saved', 'Your work remains here. Try saving again before closing.'); },
                () => this.renderError('Progress not saved', 'Your work remains here. Try saving again before closing.'),
            );
        }, 300);
    }

    /** View state is cache: one material entry, and no retired packs. */
    private pruneViewState(): void {
        const packs = this.viewState.material?.packs;
        if (!packs) return;
        const pack = this.controller.planService.getPlan(this.notePath)?.visuals ?? null;
        const keep = pack ? studyPackStateKey(pack) : null;
        for (const key of Object.keys(packs)) if (key !== keep) delete packs[key];
    }

    private updateWorkspaceProgress(): void {
        const el = this.workspaceProgress;
        if (!el) return;
        el.empty();
        const objectives = this.controller.planService.getPlan(this.notePath)?.objectives ?? [];
        const store = this.controller.planService.getProgress(this.notePath);
        const practiced = objectives.filter(objective => (store?.objectives[objective.id]?.attempts ?? 0) > 0).length;
        el.createSpan({ text: practiced ? `${practiced} of ${objectives.length} objectives practiced` : `${objectives.length} objectives ready` });
        const bar = el.createEl('progress', { attr: { max: String(Math.max(1, objectives.length)), value: String(practiced), 'aria-label': 'Objectives practiced' } });
        bar.setAttribute('title', 'Practice is not durable mastery');
    }

    private restoreConversation(): void {
        const session = this.session;
        if (!session || !this.streamEl) return;
        this.pendingChoiceButtons = [];
        const stream = this.streamEl;
        stream.empty();
        const prompt = session.getPendingPrompt();
        const transcript = session.getVisibleTranscript();
        // The live prompt is rendered once below with its controls. Only the
        // last matching question is the live one: repeated wording is normal,
        // and earlier copies are history the reader may still need.
        let liveQuestion = -1;
        for (let index = transcript.length - 1; index >= 0; index -= 1) {
            const record = transcript[index];
            if (record.kind === 'question' && record.text === prompt?.text) {
                liveQuestion = index;
                break;
            }
        }
        transcript.forEach((record, index) => {
            // The pending question is rendered once below with its live controls.
            if (index === liveQuestion) return;
            if (record.role === 'user') this.appendUserTurn(record.text);
            else {
                const bubble = stream.createDiv(`sf-study-turn sf-study-turn-${record.role}`);
                bubble.createDiv({ cls: 'sf-study-turn-role', text: record.role === 'tutor' ? 'Tutor' : 'Study' });
                const body = bubble.createDiv('sf-study-turn-body markdown-rendered');
                this.renderMarkdown(
                    record.kind === 'explain' ? stripRestatedQuestion(record.text, prompt?.text) : record.text,
                    body,
                );
            }
        });
        if (prompt) this.renderPrompt(prompt);
        if (this.inputEl) this.inputEl.value = session.getDraft();
        this.markActiveObjective(session.getActiveObjectiveId());
        stream.scrollTop = this.viewState.scroll?.[`thread:${session.getActiveObjectiveId() ?? ''}`] ?? stream.scrollHeight;
        this.setBusy(session.isBusy(), 'Thinking…');
        this.updateWorkspaceProgress();
    }

    // ------------------------------------------------------------- material

    /**
     * The map, the boards and the summary: the section owns the surfaces, the
     * panel owns the plan. `pack` is read through a getter so the section always
     * sees the plan's current answer rather than a copy taken at mount time.
     */
    private renderMaterialSection(card: HTMLElement): void {
        this.materialSection?.destroy();
        const section = new StudyMaterialSection();
        this.materialSection = section;
        const host: StudyMaterialHost = {
            snapshot: () => this.materialSnapshot(),
            generate: () => this.generateVisuals(),
            state: this.viewState.material ??= {},
            saveState: () => this.saveWorkspace(),
        };
        section.mount(card, host, { externalNavigation: true });
    }

    /**
     * What the material buttons in the briefing and the material section both
     * need: the pack on the plan right now, and whether the note has moved on
     * since it was made. One method for both, so the row beside the primary
     * action and the section's own state line can never disagree about it.
     */
    private materialSnapshot(): ReturnType<StudyMaterialHost['snapshot']> {
        const pack = this.controller.planService.getPlan(this.notePath)?.visuals ?? null;
        return {
            pack,
            preparation: this.plugin.studyChartQueue?.getPreparationStatus?.(this.notePath) ?? null,
            // Against the note as it is now, not the fingerprint the chart
            // stored: a note edited after charting is exactly the case this
            // line exists for, and the stored fingerprint never moves.
            stale: this.plugin.studyVisualService.isStale(
                pack,
                StudyPlanService.fingerprint(this.content),
            ),
        };
    }

    /** Make the pack and keep it on the plan; the section paints the result. */
    private async generateVisuals(): Promise<StudyVisualPack | null> {
        if (this.plugin.studyChartQueue?.retryMaterials) {
            await this.plugin.studyChartQueue.retryMaterials(this.notePath);
            const status = this.plugin.studyChartQueue.getPreparationStatus(this.notePath);
            if (status?.materials === 'error' || status?.materials === 'interrupted') throw new Error(status.message);
            const pack = this.controller.planService.getPlan(this.notePath)?.visuals ?? null;
            const content = await this.controller.readNote(this.notePath);
            if (content !== null) this.content = content;
            return pack;
        }
        const plan = this.controller.planService.getPlan(this.notePath);
        if (!plan) throw new Error('This note has not been charted yet.');
        const file = this.plugin.app.vault.getAbstractFileByPath(this.notePath);
        const content = file instanceof TFile ? await this.plugin.app.vault.cachedRead(file) : this.content;
        const pack = await this.plugin.studyVisualService.generate({
            notePath: this.notePath,
            content,
            objectives: plan.objectives,
            fingerprint: StudyPlanService.fingerprint(content),
            profile: getDomainProfile(plan.domainId),
        });
        if (!pack) return null;
        const previous = plan.visuals;
        plan.visuals = pack;
        this.controller.planService.savePlan(plan);
        this.content = content;
        try {
            if ((await this.plugin.savePluginData()) === false) throw new Error('The material could not be saved.');
        } catch (error) {
            plan.visuals = previous;
            this.controller.planService.savePlan(plan);
            throw error;
        }
        // Wake the buttons beside the primary action too: the material exists
        // now, and the row that said "not made yet" has to stop saying it.
        const material = this.materialSnapshot();
        this.briefingView?.setMaterial(material.pack, material.stale);
        return pack;
    }

    private renderFailure(message: string): void {
        const target = this.overflowEl ?? this.root;
        if (!target) return;
        target.empty();
        const failure = target.createDiv('sf-study-failure');
        const icon = failure.createSpan('sf-study-failure-icon');
        setIcon(icon, 'alert-triangle');
        failure.createDiv({ text: message, cls: 'sf-study-failure-text' });
    }

    // ---------------------------------------------------------- chart status

    private onChartProgress(update: StudyChartUpdate): void {
        this.updateWorkspaceProgress();
        this.materialSection?.refresh();
        if (!this.chartLineEl) return;
        this.chartLineEl.empty();
        this.chartLineEl.toggleClass('is-active', !update.complete);
        this.chartLineEl.toggleClass('has-error', update.error !== null && update.objectives === 0);

        const icon = this.chartLineEl.createSpan('sf-study-chartline-icon');
        setIcon(icon, update.error && update.objectives === 0 ? 'alert-triangle' : update.complete ? 'check-circle-2' : 'loader');
        const text = this.chartLineEl.createDiv('sf-study-chartline-text');

        if (update.total > 0) {
            text.setText(`${update.message} · ${update.done}/${update.total} sections`);
            const bar = this.chartLineEl.createDiv('sf-study-chartline-bar');
            const fill = bar.createDiv('sf-study-chartline-fill');
            fill.setCssProps({ '--sf-fill': `${Math.round((update.done / Math.max(1, update.total)) * 100)}%` });
        } else {
            text.setText(update.message);
        }

        if (update.error && update.objectives === 0) {
            const retry = this.chartLineEl.createEl('button', { text: 'Retry', cls: 'sf-btn sf-study-chartline-retry' });
            retry.addEventListener('click', () => {
                void this.controller.startChart(this.notePath, { rechart: true });
            });
        }

        // Objectives arriving mid-session update the rail; otherwise the
        // briefing is refreshed so the counts and the start button keep up.
        if (this.session && !this.finished) {
            const plan = this.controller.planService.getPlan(this.notePath);
            if (plan) this.renderRail(plan.objectives);
        } else if (!this.finished && update.objectives > 0 && update.objectives !== (this.briefing?.totalObjectives ?? -1)) {
            // Refresh the briefing whenever the objective count actually moved,
            // including on the pass that finishes the chart: otherwise the
            // counters keep saying 33 while the plan already holds 40.
            this.briefing = StudySessionService.prepare(this.plugin, this.controller.planService, this.controller.searchService, this.notePath, this.content);
            this.renderBriefing();
        }
    }

    // -------------------------------------------------------------- briefing

    /**
     * Put the briefing on screen — the launch screen, as `StudyBriefingView`.
     *
     * The panel keeps the facts (the briefing it prepared, the plan, the mode
     * and lookup state a session would start with) and the view renders them,
     * in reading order, so what a reader sees before starting is testable
     * without mounting a panel.
     */
    private renderBriefing(): void {
        const briefing = this.briefing;
        const host = this.learningEl;
        if (!briefing || !host) return;
        host.empty();

        this.briefingView?.destroy();
        const view = new StudyBriefingView();
        this.briefingView = view;
        const material = this.materialSnapshot();
        const briefingHost: StudyBriefingHost = {
            workspace: true,
            briefing,
            plan: this.controller.planService.getPlan(this.notePath) ?? null,
            mode: this.mode,
            webLookup: this.webSearch,
            charting: this.controller.isCharting(this.notePath),
            studyMinutes: this.estimateStudyMinutes(),
            materialPack: material.pack,
            materialStale: material.stale,
            materialSlot: element => this.renderMaterialSection(element),
            start: fresh => {
                if (fresh) this.freshStart = true;
                this.options.onRequestSpace?.();
                void this.startSession();
            },
            rechart: () => {
                void this.controller.startChart(this.notePath, { rechart: true });
            },
            changeDomain: (domainId, notes) => void this.applyDomainChoice(domainId, notes),
            changeMode: mode => {
                this.mode = mode;
            },
            toggleLookup: on => {
                this.webSearch = on;
            },
            figureSource: image => this.resolveResourcePath(image),
            openFigure: image => this.openLightbox(image, this.resolveResourcePath(image)),
        };
        view.mount(host, briefingHost);
        const workspace = this.controller.planService.getProgress(this.notePath)?.workspace;
        const thread = workspace?.activeThreadId ? workspace.threads[workspace.activeThreadId] : null;
        const start = host.querySelector<HTMLElement>('.sf-brief-primary');
        if (start && thread && !thread.checkpoint.finished) start.setText('Continue learning');
    }

    /**
     * How long the note's material takes to read, in whole minutes, or null
     * when it cannot be measured.
     *
     * It is the note's own measurement at the reader's configured reading
     * speed — the same number the sidebar shows for the note — which is why
     * the briefing says "about N min", and why a fact that cannot be computed
     * is left out of the scope line rather than guessed at.
     */
    private estimateStudyMinutes(): number | null {
        if (this.content.length === 0) return null;
        const file = this.plugin.app.vault.getAbstractFileByPath(this.notePath);
        if (!(file instanceof TFile)) return null;
        return Math.max(1, Math.round(EstimationUtils.estimateReviewTime(file, this.content) / 60));
    }

    /**
     * Store a subject-lens correction and show it.
     *
     * The view renders the editor; persisting the choice, telling the reader
     * and re-rendering with the corrected lens are the panel's job.
     */
    private async applyDomainChoice(domainId: string, notes: string): Promise<void> {
        const plan = this.controller.planService.getPlan(this.notePath);
        if (plan) {
            const profile = getDomainProfile(domainId);
            const previous = { domainId: plan.domainId, domainLabel: plan.domainLabel, safetyCritical: plan.safetyCritical, domainNotes: plan.domainNotes, domainOverriddenByUser: plan.domainOverriddenByUser };
            plan.domainId = profile.id;
            plan.domainLabel = profile.label;
            plan.safetyCritical = profile.safetyCritical;
            plan.domainNotes = notes;
            plan.domainOverriddenByUser = true;
            this.controller.planService.savePlan(plan);
            try {
                if ((await this.plugin.savePluginData()) === false) throw new Error('The save failed.');
            } catch (error) {
                Object.assign(plan, previous);
                this.controller.planService.savePlan(plan);
                new Notice(`Subject lens not saved: ${String(error)}`);
                return;
            }
            new Notice(`Study will treat this note as: ${profile.label}`);
        }
        this.briefing = this.briefing
            ? { ...this.briefing, domainId, domainLabel: getDomainProfile(domainId).label, domainNotes: notes }
            : null;
        this.renderBriefing();
    }

    /** Vault resource URL for a figure, when it resolves to a real file. */
    private resolveResourcePath(image: StudyImageRef): string | null {
        if (!image.resolvedPath) return null;
        if (image.syntax === 'remote') return image.resolvedPath;
        const file = this.plugin.app.vault.getAbstractFileByPath(image.resolvedPath);
        if (!(file instanceof TFile)) return null;
        try {
            return this.plugin.app.vault.getResourcePath(file);
        } catch {
            return null;
        }
    }

    private openLightbox(image: StudyImageRef, src: string | null): void {
        const host = this.root;
        if (!host) return;
        host.querySelector('.sf-study-lightbox')?.remove();

        const overlay = host.createDiv('sf-study-lightbox');
        const frame = overlay.createDiv('sf-study-lightbox-frame');
        const head = frame.createDiv('sf-study-lightbox-head');
        head.createDiv({ cls: 'sf-study-lightbox-title', text: `${image.fileName}${image.heading ? ` — ${image.heading}` : ''}` });
        const close = head.createEl('button', { cls: 'sf-study-lightbox-close' });
        setIcon(close, 'x');

        if (src) {
            const img = frame.createEl('img', { cls: 'sf-study-lightbox-img' });
            img.src = src;
            img.alt = image.fileName;
        } else {
            frame.createDiv({ cls: 'sf-study-lightbox-missing', text: 'This image could not be resolved in the vault.' });
        }
        if (image.resolvedPath && image.syntax !== 'remote') {
            const open = frame.createEl('button', { text: 'Open the file', cls: 'sf-btn' });
            open.addEventListener('click', () => {
                void this.plugin.app.workspace.openLinkText(image.resolvedPath as string, this.notePath, false);
                overlay.remove();
            });
        }
        const dismiss = (): void => overlay.remove();
        close.addEventListener('click', dismiss);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) dismiss();
        });
    }

    private openDomainEditor(card: HTMLElement): void {
        const briefing = this.briefing;
        if (!briefing) return;
        card.querySelector('.sf-study-domain-editor')?.remove();

        const editor = card.createDiv('sf-study-domain-editor');
        editor.createDiv({ cls: 'sf-study-section-title', text: 'What kind of subject is this?' });
        editor.createDiv({
            cls: 'sf-study-domain-editor-blurb',
            text: 'The tutor changes how it explains, what counts as a mechanism, and what a good test looks like based on this. Correct it if it guessed wrong.',
        });
        const select = editor.createEl('select', { cls: 'dropdown sf-study-domain-select' });
        for (const profile of STUDY_DOMAINS) {
            const option = select.createEl('option', { text: profile.label });
            // `value` is not set by createEl for options in every Obsidian build.
            option.value = profile.id;
            option.selected = profile.id === briefing.domainId;
        }
        const notes = editor.createEl('textarea', { cls: 'sf-study-domain-school' });
        notes.value = briefing.domainNotes;
        notes.placeholder = 'Anything specific about how this subject should be taught (optional)';

        const buttons = editor.createDiv('sf-study-domain-editor-actions');
        const save = buttons.createEl('button', { text: 'Save', cls: 'sf-btn sf-btn-primary' });
        save.addEventListener('click', () => {
            void (async () => {
                const plan = this.controller.planService.getPlan(this.notePath);
                if (plan) {
                    const profile = getDomainProfile(select.value);
                    plan.domainId = profile.id;
                    plan.domainLabel = profile.label;
                    plan.safetyCritical = profile.safetyCritical;
                    plan.domainNotes = notes.value.trim();
                    plan.domainOverriddenByUser = true;
                    this.controller.planService.savePlan(plan);
                    try {
                        if ((await this.plugin.savePluginData()) === false) throw new Error('The save failed.');
                    } catch (error) {
                        new Notice(`Subject lens not saved: ${String(error)}`);
                        return;
                    }
                    new Notice(`Study will treat this note as: ${profile.label}`);
                }
                this.briefing = this.briefing
                    ? { ...this.briefing, domainId: select.value, domainLabel: getDomainProfile(select.value).label, domainNotes: notes.value.trim() }
                    : null;
                this.renderBriefing();
            })();
        });
        const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'sf-btn' });
        cancel.addEventListener('click', () => editor.remove());
    }

    // --------------------------------------------------------------- session

    private async startSession(restoreFinished = false): Promise<void> {
        if (this.starting || (this.session && !this.finished) || this.closed) return;
        const briefing = this.briefing;
        const host = this.learningEl;
        if (!briefing || !host) return;
        this.starting = true;
        const content = await this.controller.readNote(this.notePath);
        this.starting = false;
        if (this.closed) return;
        if (content === null) {
            this.renderFailure('This note could not be read.');
            return;
        }
        this.content = content;
        const plan = this.controller.planService.getPlan(this.notePath);
        if (!plan || plan.objectives.length === 0) {
            new Notice('No objectives yet — charting is still running.');
            return;
        }
        const acquired = typeof this.controller.acquireStudy === 'function'
            ? this.controller.acquireStudy(this.notePath, this.leaseToken)
            : true;
        if (!acquired) {
            new Notice('Study is already open for this note. Close that window before starting another.');
            return;
        }
        this.leasePath = this.notePath;

        this.finished = false;
        this.resultRecorded = false;
        this.heldFeedback = [];
        this.buildSessionShell(host);

        this.session = new StudySessionService(
            this.plugin,
            this.controller.planService,
            this.controller.searchService,
            this.notePath,
            content,
            plan,
            {
                mode: this.mode,
                webSearch: this.webSearch && briefing.searchAvailable,
                turnLimit: Math.max(6, this.plugin.settings.studyTurnLimit),
                freshStart: this.freshStart,
            }
        );
        // The engine consumes freshStart at construction; the panel must not
        // carry it into a later re-init (for example after a rename).
        this.freshStart = false;
        this.saveWorkspace();
        this.unsubscribeSession = this.session.subscribe(event => this.handleEvent(event));
        this.controller.setStudyingNote?.(this.notePath);
        this.renderRail(plan.objectives);
        this.updateWebChip();
        this.setBusy(true, 'Planning where to start…');
        void this.session.start()
            .then(() => {
                if (!restoreFinished || this.closed || !this.session) return;
                const summary = this.session.getFinishedSummary();
                if (summary) void this.renderComplete(summary, true);
            })
            .catch(error => this.renderError('Could not restore the last session', String(error)));
    }

    private buildSessionShell(host: HTMLElement): void {
        host.empty();

        const header = host.createDiv('sf-study-header');
        const chips = header.createDiv('sf-study-chips');

        const domainChip = chips.createEl('button', { cls: 'sf-study-chip sf-study-chip-domain' });
        const domainIcon = domainChip.createSpan('sf-study-chip-icon');
        setIcon(domainIcon, 'compass');
        domainChip.createSpan({ text: this.briefing?.domainLabel ?? 'General' });
        domainChip.setAttribute('title', 'How the tutor is treating this subject — click to change');
        domainChip.addEventListener('click', () => {
            const plan = this.controller.planService.getPlan(this.notePath);
            if (plan) this.openDomainEditor(host);
        });

        this.webChip = chips.createEl('button', { cls: 'sf-study-chip sf-study-chip-web' });
        this.webChip.setAttribute('title', 'Turn web lookup on or off for this session');
        this.webChip.addEventListener('click', () => {
            if (!this.session) return;
            this.session.setWebSearch(!this.session.getOptions().webSearch);
            this.updateWebChip();
        });

        const modeChip = chips.createDiv('sf-study-chip sf-study-chip-mode');
        const modeIcon = modeChip.createSpan('sf-study-chip-icon');
        setIcon(modeIcon, 'sliders-horizontal');
        // A native <select> inside a chip draws its own arrow on top of the
        // chip's, which is what left this control unreadable; a menu carries the
        // same three choices and draws nothing of its own.
        const modeButton = modeChip.createEl('button', { cls: 'sf-study-mode-button' });
        modeButton.setAttribute('type', 'button');
        modeButton.setAttribute('aria-label', 'How to run this session');
        modeButton.setText(modeLabel(this.mode));
        modeButton.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            const menu = new Menu();
            for (const choice of MODE_CHOICES) {
                menu.addItem(item => item
                    .setTitle(`${choice.label} — ${choice.blurb}`)
                    .setChecked(choice.mode === this.mode)
                    .onClick(() => {
                        this.mode = choice.mode;
                        modeButton.setText(modeLabel(this.mode));
                        this.session?.setMode(this.mode);
                    }));
            }
            menu.showAtMouseEvent(event);
        });
        this.modeButton = modeButton;

        const chooserRow = host.createDiv('sf-study-workspace-objective');
        chooserRow.createSpan({ text: 'Objective' });
        this.objectiveChooser = chooserRow.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Objective' } });
        this.objectiveChooser.addEventListener('change', () => {
            this.captureWorkspace();
            void this.session?.focusOn(this.objectiveChooser!.value);
        });
        const objectiveDetails = chooserRow.createEl('button', { text: 'Details', cls: 'sf-btn' });
        objectiveDetails.addEventListener('click', () => {
            const objective = this.controller.planService.getPlan(this.notePath)?.objectives.find(entry => entry.id === this.session?.getActiveObjectiveId());
            if (objective) this.renderObjectiveDetail(objective);
        });
        // In a short dock the chip row is one row too many; the same choices
        // live here, beside the objective, so nothing becomes unreachable.
        const sessionMenu = chooserRow.createEl('button', {
            cls: 'sf-study-session-menu',
            attr: { 'aria-label': 'Session options', title: 'Session options' },
        });
        setIcon(sessionMenu, 'sliders-horizontal');
        sessionMenu.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            const menu = new Menu();
            menu.addItem(item => item
                .setTitle('Look things up')
                .setChecked(this.session?.getOptions().webSearch === true)
                .onClick(() => {
                    if (!this.session) return;
                    this.session.setWebSearch(!this.session.getOptions().webSearch);
                    this.updateWebChip();
                }));
            menu.addSeparator();
            for (const choice of MODE_CHOICES) {
                menu.addItem(item => item
                    .setTitle(`Mode: ${choice.label}`)
                    .setChecked(choice.mode === this.mode)
                    .onClick(() => {
                        this.mode = choice.mode;
                        this.modeButton?.setText(modeLabel(this.mode));
                        this.session?.setMode(this.mode);
                    }));
            }
            // The chip row and the quick-answer row are both hidden in a short
            // dock; their actions live here, so the reader keeps every control.
            menu.addSeparator();
            const commands: [string, StudyCommand][] = [
                ["I don't know", 'dont-know'], ['Nudge me', 'hint'], ['Explain more', 'more'],
                ['Harder', 'harder'], ['Easier', 'easier'], ['Move on', 'skip'], ['Wrap up', 'wrap-up'],
            ];
            for (const [label, command] of commands) {
                menu.addItem(item => item.setTitle(label).onClick(() => void this.session?.command(command)));
            }
            menu.addSeparator();
            menu.addItem(item => item.setTitle('Change subject lens…').onClick(() => this.openDomainEditor(host)));
            menu.showAtMouseEvent(event);
        });
        const body = host.createDiv('sf-study-body');
        const railColumn = body.createDiv('sf-study-rail-column');
        railColumn.createDiv('sf-study-rail-head').createSpan({ text: 'Objectives' });
        this.railEl = railColumn.createDiv('sf-study-rail');

        const main = body.createDiv('sf-study-main');
        this.stageEl = main.createDiv('sf-study-stage-rail');
        this.streamEl = main.createDiv('sf-study-stream');
        this.statusEl = main.createDiv('sf-study-status');
        this.composerEl = main.createDiv('sf-study-composer');
        this.buildComposer();

        const sessionDetails = host.createEl('details', { cls: 'sf-study-workspace-options' });
        sessionDetails.createEl('summary', { text: 'Session details and export' });
        this.digestEl = sessionDetails.createDiv('sf-study-digest');
        this.renderStageRail();
        this.renderDigest();
    }

    private buildComposer(): void {
        const composer = this.composerEl;
        if (!composer) return;
        composer.empty();
        const inputRow = composer.createDiv('sf-study-input-row');
        this.inputEl = inputRow.createEl('textarea', {
            cls: 'sf-study-input',
            attr: { rows: '2', placeholder: 'Answer in your own words…', 'aria-label': 'Your answer. The tutor grades the reasoning, not the phrasing.' },
        });
        this.inputEl.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.submit();
            }
        });
        this.inputEl.addEventListener('input', () => {
            this.session?.setDraft(this.inputEl?.value ?? '');
        });
        this.sendBtn = inputRow.createEl('button', { text: 'Answer', cls: 'sf-btn sf-btn-primary sf-study-send' });
        this.sendBtn.addEventListener('click', () => this.submit());

        // Secondary answer controls stay one disclosure away, so the answer
        // field and its primary button fit a short dock without shrinking type.
        const more = composer.createEl('details', { cls: 'sf-study-quick-more' });
        more.createEl('summary', { text: 'More ways to answer' });
        const actions = more.createDiv('sf-study-quick');
        const quick = (label: string, title: string, handler: () => void, cls = ''): void => {
            const button = actions.createEl('button', { text: label, cls: `sf-study-quick-btn ${cls}`.trim() });
            button.setAttribute('title', title);
            button.addEventListener('click', handler);
        };
        quick('I don\'t know', 'Say you do not know. That is a useful signal, not a failure.', () => void this.session?.command('dont-know'));
        quick('Nudge me', 'Ask for a hint rather than the answer.', () => {
            if (this.session?.getPendingPrompt()?.hint) {
                void this.session.command('hint');
            } else {
                new Notice('No hint stored for this question — the tutor keeps them short on purpose.');
            }
        });
        quick('Explain more', 'Go deeper on this one, then re-test.', () => void this.session?.command('more'));
        quick('Harder', 'Raise the difficulty one step.', () => void this.session?.command('harder'));
        quick('Easier', 'Lower the difficulty one step.', () => void this.session?.command('easier'));
        quick('Move on', 'Park this objective and take the next one.', () => void this.session?.command('skip'));
        quick('Wrap up', 'Close the session with a summary.', () => void this.session?.command('wrap-up'), 'sf-study-quick-end');
    }

    private submit(): void {
        if (!this.inputEl) return;
        const text = this.inputEl.value.trim();
        if (text.length === 0 || !this.session) return;
        const canAnswer = typeof this.session.canAnswer === 'function' ? this.session.canAnswer() : !this.session.isBusy();
        if (!canAnswer) {
            if (!this.session.isBusy()) new Notice('The previous answer was not sent. Use try again before typing a new answer.');
            return;
        }
        this.inputEl.value = '';
        this.session.setDraft('');
        this.pendingChoiceButtons = [];
        this.setBusy(true, 'Reading your answer…');
        void this.session.answer(text);
    }

    private setBusy(busy: boolean, label: string): void {
        this.root?.toggleClass('sf-study-busy', busy);
        if (this.inputEl) this.inputEl.disabled = busy;
        if (this.sendBtn) this.sendBtn.disabled = busy;
        if (busy) this.setStatus(label, true);
        else this.setStatus('', false);
    }

    private setStatus(label: string, active: boolean): void {
        const statusEl = this.statusEl;
        if (!statusEl) return;
        statusEl.empty();
        statusEl.toggleClass('is-active', active);
        if (!active) {
            this.stopTicker();
            return;
        }
        const dots = statusEl.createDiv('sf-study-pulse');
        dots.createSpan(); dots.createSpan(); dots.createSpan();
        statusEl.createDiv({ cls: 'sf-study-status-label', text: label });
        this.thinkingStartedAt = Date.now();
        const timer = statusEl.createDiv({ cls: 'sf-study-status-timer', text: '0s' });
        this.stopTicker();
        this.statusTicker = window.setInterval(() => {
            const seconds = Math.floor((Date.now() - this.thinkingStartedAt) / 1000);
            timer.setText(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
        }, 1000);
    }

    private stopTicker(): void {
        if (this.statusTicker !== null) {
            window.clearInterval(this.statusTicker);
            this.statusTicker = null;
        }
    }

    private syncSessionOptions(): void {
        const getOptions = this.session?.getOptions;
        if (typeof getOptions !== 'function') return;
        const options = getOptions.call(this.session);
        if (!options) return;
        this.mode = options.mode;
        this.webSearch = options.webSearch;
        this.modeButton?.setText(modeLabel(this.mode));
        this.updateWebChip();
    }

    private updateWebChip(): void {
        if (!this.webChip || !this.session) return;
        const on = this.session.getOptions().webSearch;
        this.webChip.empty();
        const icon = this.webChip.createSpan('sf-study-chip-icon');
        setIcon(icon, 'globe');
        this.webChip.createSpan({ text: on ? 'Looking things up' : 'Look things up' });
        this.webChip.toggleClass('is-on', on);
    }

    // ------------------------------------------------------------ event flow

    private handleEvent(event: StudySessionEvent): void {
        switch (event.type) {
            case 'restored':
                this.syncSessionOptions();
                this.restoreConversation();
                break;
            case 'status':
                if (/interrupted|not saved|not sent/i.test(event.text)) this.renderError(event.text, null);
                else new Notice(event.text, 4000);
                break;
            case 'thinking':
                this.setBusy(event.active, event.label);
                break;
            case 'stage':
                this.stage = event.stage;
                this.renderStageRail();
                break;
            case 'plan':
                this.renderRail(event.plan.objectives);
                break;
            case 'turn':
                this.renderTurn(event.turn);
                break;
            case 'user-turn':
                this.appendUserTurn(event.turn.text);
                break;
            case 'research':
                this.renderResearch(event.queries, event.results, event.done);
                break;
            case 'progress':
                this.updateObjective(event.objectiveId, event.state.U, event.state.R, event.state.T, event.state.status, event.state.errorCounts);
                this.updateWorkspaceProgress();
                break;
            case 'digest':
                this.digest = event.digest;
                this.renderDigest();
                break;
            case 'complete':
                void this.renderComplete(event.summary);
                break;
            case 'error':
                this.renderError(event.message, event.detail);
                break;
            default:
                break;
        }
    }

    private renderStageRail(): void {
        const stageEl = this.stageEl;
        if (!stageEl) return;
        stageEl.empty();
        const currentIndex = STUDY_STAGE_ORDER.indexOf(this.stage);
        const position = stageEl.createDiv('sf-study-stage-position');
        position.setText(currentIndex >= 0
            ? `Step ${currentIndex + 1} of ${STUDY_STAGE_ORDER.length} · ${STUDY_STAGE_LABELS[this.stage]}`
            : STUDY_STAGE_LABELS[this.stage]);
        for (const stage of [...STUDY_STAGE_ORDER, StudyStage.Complete]) {
            const index = STUDY_STAGE_ORDER.indexOf(stage);
            const pill = stageEl.createDiv('sf-study-stage');
            pill.createSpan({ text: STUDY_STAGE_LABELS[stage] });
            if (stage === this.stage) pill.addClass('is-current');
            else if (this.stage !== StudyStage.Complete && index !== -1 && currentIndex !== -1 && index < currentIndex) pill.addClass('is-done');
        }
    }

    private renderRail(objectives: StudyObjective[]): void {
        const railEl = this.railEl;
        if (!railEl) return;
        railEl.empty();
        const store = this.session?.getProgress();
        if (this.objectiveChooser) {
            this.objectiveChooser.empty();
            for (const objective of objectives) {
                const option = this.objectiveChooser.createEl('option', { text: objective.title });
                option.value = objective.id;
            }
            this.objectiveChooser.value = this.session?.getActiveObjectiveId() ?? '';
        }

        for (const objective of objectives) {
            const state = store?.objectives[objective.id];
            const row = railEl.createEl('button', { cls: 'sf-study-obj', attr: { type: 'button' } });
            row.dataset.obj = objective.id;
            row.dataset.status = state?.status ?? StudyObjectiveStatus.Unseen;
            if (objective.id === this.selectedObjectiveId) row.addClass('is-selected');

            const status = row.createSpan('sf-study-obj-status');
            status.setAttribute('aria-label', STATUS_LABELS[state?.status ?? StudyObjectiveStatus.Unseen]);

            const main = row.createDiv('sf-study-obj-main');
            main.createDiv({ cls: 'sf-study-obj-title', text: objective.title });
            main.createDiv({
                cls: 'sf-study-obj-meta',
                text: `${TYPE_LABELS[objective.type]}${objective.importance === 'critical' ? ' · critical' : objective.importance === 'high' ? ' · high' : ''}`,
            });

            const meters = row.createDiv('sf-study-obj-meters');
            for (const [dimension, value] of [['U', state?.U ?? 0], ['R', state?.R ?? 0], ['T', state?.T ?? 0]] as [string, number][]) {
                const meter = meters.createDiv('sf-study-meter');
                meter.dataset.dim = dimension;
                meter.setAttribute('title', `${dimension} ${value}/3`);
                const fill = meter.createDiv('sf-study-meter-fill');
                fill.setCssProps({ '--sf-fill': `${(value / 3) * 100}%` });
            }

            const errorTotal = state
                ? Object.entries(state.errorCounts).filter(([category]) => category !== 'success').reduce((sum, [, count]) => sum + (count ?? 0), 0)
                : 0;
            if (errorTotal > 0) row.createSpan({ cls: 'sf-study-obj-errors', text: `${errorTotal}×` });
            if (state?.nextReviewAt != null && state.nextReviewAt <= Date.now()) row.createSpan({ cls: 'sf-study-obj-due', text: 'due' });

            row.addEventListener('click', () => {
                this.selectedObjectiveId = objective.id;
                railEl.querySelectorAll('.sf-study-obj').forEach(el => el.removeClass('is-selected'));
                row.addClass('is-selected');
                this.renderObjectiveDetail(objective);
                this.captureWorkspace();
                void this.session?.focusOn(objective.id);
            });
        }
    }

    private markActiveObjective(objectiveId: string | null): void {
        if (objectiveId) {
            this.selectedObjectiveId = objectiveId;
            this.viewState.objectiveId = objectiveId;
            if (this.objectiveChooser) this.objectiveChooser.value = objectiveId;
            this.saveWorkspace();
        }
        if (!objectiveId || !this.railEl) return;
        this.railEl.querySelectorAll('.sf-study-obj').forEach(el => el.removeClass('is-active'));
        const row = this.railEl.querySelector<HTMLElement>(`.sf-study-obj[data-obj="${objectiveId}"]`);
        if (row) {
            row.addClass('is-active');
            row.scrollIntoView({ block: 'nearest' });
        }
    }

    private updateObjective(
        objectiveId: string,
        U: number,
        R: number,
        T: number,
        status: StudyObjectiveStatus,
        errorCounts: Partial<Record<StudyErrorCategory, number>>
    ): void {
        const row = this.railEl?.querySelector<HTMLElement>(`.sf-study-obj[data-obj="${objectiveId}"]`);
        if (!row) return;
        row.dataset.status = status;
        const values: Record<string, number> = { U, R, T };
        row.querySelectorAll<HTMLElement>('.sf-study-meter').forEach(meter => {
            const fill = meter.querySelector<HTMLElement>('.sf-study-meter-fill');
            if (fill) fill.setCssProps({ '--sf-fill': `${((values[meter.dataset.dim ?? 'U'] ?? 0) / 3) * 100}%` });
        });
        row.querySelector<HTMLElement>('.sf-study-obj-status')?.setAttribute('aria-label', STATUS_LABELS[status]);

        const errorTotal = Object.entries(errorCounts).filter(([category]) => category !== 'success').reduce((sum, [, count]) => sum + (count ?? 0), 0);
        let errorEl = row.querySelector<HTMLElement>('.sf-study-obj-errors');
        if (errorTotal > 0) {
            if (!errorEl) errorEl = row.createSpan({ cls: 'sf-study-obj-errors' });
            errorEl.setText(`${errorTotal}×`);
        } else if (errorEl) {
            errorEl.remove();
        }

        row.addClass('is-pulsing');
        window.setTimeout(() => row.removeClass('is-pulsing'), 1200);
        if (status === StudyObjectiveStatus.Mastered) row.addClass('is-mastered');
    }

    private renderObjectiveDetail(objective: StudyObjective): void {
        const column = this.learningEl ?? this.railEl?.parentElement;
        if (!column) return;
        column.querySelector('.sf-study-obj-detail')?.remove();

        const state = this.session?.getProgress()?.objectives[objective.id];
        const detail = column.createDiv('sf-study-obj-detail');
        detail.createDiv({ cls: 'sf-study-obj-detail-title', text: objective.title });
        detail.createDiv({ cls: 'sf-study-obj-detail-statement', text: objective.statement });

        const meta = detail.createDiv('sf-study-obj-detail-meta');
        meta.createSpan({ text: `${TYPE_LABELS[objective.type]} · ${STATUS_LABELS[state?.status ?? StudyObjectiveStatus.Unseen]}` });
        if (objective.prerequisites.length > 0) meta.createSpan({ text: ` · after ${objective.prerequisites.join(', ')}` });

        const meters = detail.createDiv('sf-study-obj-detail-meters');
        for (const [label, value] of [['Understanding', state?.U ?? 0], ['Recall', state?.R ?? 0], ['Apply it', state?.T ?? 0]] as [string, number][]) {
            const line = meters.createDiv('sf-study-obj-detail-meter');
            line.createSpan({ cls: 'sf-study-obj-detail-meter-label', text: label });
            const bar = line.createDiv('sf-study-meter');
            bar.createDiv('sf-study-meter-fill').setCssProps({ '--sf-fill': `${(value / 3) * 100}%` });
            line.createSpan({ cls: 'sf-study-obj-detail-meter-value', text: `${value}/3` });
        }

        const errors = Object.entries(state?.errorCounts ?? {}).filter(([category]) => category !== 'success');
        if (errors.length > 0) {
            const errorList = detail.createDiv('sf-study-obj-detail-errors');
            for (const [category, count] of errors) errorList.createSpan({ text: `${STUDY_ERROR_LABELS[category as StudyErrorCategory] ?? category} ×${count}` });
        }
        if (state && state.observations.length > 0) {
            const observations = detail.createDiv('sf-study-obj-detail-observations');
            for (const observation of state.observations.slice(-4)) observations.createDiv({ text: observation });
        }
        if (state?.nextReviewAt) {
            detail.createDiv({ cls: 'sf-study-obj-detail-review', text: `Review suggestion: ${new Date(state.nextReviewAt).toLocaleDateString()} (provisional)` });
        }

        const actions = detail.createDiv('sf-study-obj-detail-actions');
        const focus = actions.createEl('button', { text: 'Work on this now', cls: 'sf-btn sf-study-obj-focus' });
        focus.disabled = !this.session || this.session.isBusy() || this.finished;
        focus.addEventListener('click', () => {
            detail.remove();
            void this.session?.focusOn(objective.id);
        });
        const dismiss = actions.createEl('button', { text: 'Close', cls: 'sf-btn' });
        dismiss.addEventListener('click', () => detail.remove());
    }

    private renderMarkdown(markdown: string, el: HTMLElement): void {
        if (this.closed || markdown.trim().length === 0) return;
        void MarkdownRenderer.render(this.plugin.app, markdown, el, this.notePath, this.renderComponent)
            .catch(() => { /* the panel is gone; nothing to show */ });
    }

    private scrollStream(): void {
        if (this.streamEl) this.streamEl.scrollTop = this.streamEl.scrollHeight;
    }

    private appendUserTurn(text: string): void {
        const streamEl = this.streamEl;
        if (!streamEl) return;
        const turn = streamEl.createDiv('sf-study-turn sf-study-turn-user');
        turn.createDiv({ cls: 'sf-study-turn-role', text: 'You' });
        turn.createDiv({ cls: 'sf-study-turn-body', text });
        this.scrollStream();
    }

    private renderTurn(turn: TutorTurn): void {
        const streamEl = this.streamEl;
        if (!streamEl) return;
        if (turn.objectiveId) this.markActiveObjective(turn.objectiveId);

        if (turn.say.trim().length > 0) {
            const bubble = streamEl.createDiv('sf-study-turn sf-study-turn-tutor sf-animate-fade-in');
            bubble.createDiv({ cls: 'sf-study-turn-role', text: `Tutor · ${STUDY_STAGE_LABELS[turn.stage]}` });
            const body = bubble.createDiv('sf-study-turn-body markdown-rendered');
            // The tutor is given the note's exact image syntax, so an image it
            // points at renders here as a preview through the normal renderer.
            this.renderMarkdown(stripRestatedQuestion(turn.say, turn.next?.text), body);

            if (turn.anchors.length > 0) {
                const anchors = bubble.createDiv('sf-study-anchors');
                anchors.createSpan({ cls: 'sf-study-anchors-label', text: 'From the note:' });
                for (const anchor of turn.anchors) anchors.createSpan({ cls: 'sf-study-anchor', text: anchor.length > 90 ? `${anchor.slice(0, 90)}…` : anchor });
            }
            if (turn.sources.length > 0) this.renderSources(bubble, turn.sources);
        }

        if (turn.flags.inconsistency) this.renderFlag('git-compare', 'The source and current knowledge disagree', turn.flags.inconsistency, 'warn');
        if (turn.flags.safetyCritical) this.renderFlag('alert-octagon', 'Do not misremember this', turn.flags.safetyCritical, 'danger');
        if (turn.verdict) this.renderFeedback(turn);
        if (turn.next) this.renderPrompt(turn.next);
    }

    private renderFlag(icon: string, title: string, text: string, kind: 'warn' | 'danger'): void {
        const streamEl = this.streamEl;
        if (!streamEl) return;
        const box = streamEl.createDiv(`sf-study-flag sf-study-flag-${kind} sf-animate-fade-in`);
        const iconEl = box.createSpan('sf-study-flag-icon');
        setIcon(iconEl, icon);
        const content = box.createDiv('sf-study-flag-content');
        content.createDiv({ cls: 'sf-study-flag-title', text: title });
        content.createDiv({ cls: 'sf-study-flag-text', text });
        this.scrollStream();
    }

    private renderSources(parent: HTMLElement, sources: StudySourceRef[]): void {
        const list = parent.createDiv('sf-study-sources');
        list.createSpan({ cls: 'sf-study-sources-label', text: 'Looked up:' });
        for (const source of sources) {
            const chip = list.createEl('button', { cls: 'sf-study-source', text: source.title });
            chip.setAttribute('title', source.url);
            chip.addEventListener('click', () => window.open(source.url, '_blank'));
        }
    }

    private renderFeedback(turn: TutorTurn): void {
        const streamEl = this.streamEl;
        const verdict = turn.verdict;
        if (!streamEl || !verdict) return;
        const correct = verdict.correct === true;
        const label = verdict.errorCategory
            ? (STUDY_ERROR_LABELS[verdict.errorCategory] ?? verdict.errorCategory)
            : (correct ? 'Correct' : 'Not quite');
        const text = [verdict.diagnosis ?? '', verdict.correction ?? ''].filter(Boolean).join('\n\n') || (correct ? 'Correct.' : 'Not quite.');

        if (this.session?.getOptions().mode === StudyMode.Exam && !this.finished) {
            this.heldFeedback.push({ text, correct: verdict.correct ?? null, label });
            const note = streamEl.createDiv('sf-study-turn sf-study-turn-system sf-animate-fade-in');
            note.createDiv({ cls: 'sf-study-turn-role', text: 'Exam block' });
            note.createDiv({ cls: 'sf-study-turn-body', text: 'Answer recorded. Feedback is held back until the block ends.' });
            this.scrollStream();
            return;
        }

        const box = streamEl.createDiv(`sf-study-feedback ${correct ? 'is-correct' : 'is-wrong'} sf-animate-fade-in`);
        const head = box.createDiv('sf-study-feedback-head');
        const icon = head.createSpan('sf-study-feedback-icon');
        setIcon(icon, correct ? 'check-circle-2' : 'x-circle');
        head.createSpan({ cls: 'sf-study-feedback-label', text: label });
        this.renderMarkdown(text, box.createDiv('sf-study-turn-body markdown-rendered'));
        this.scrollStream();
    }

    private renderPrompt(prompt: TutorPromptSpec): void {
        const streamEl = this.streamEl;
        if (!streamEl) return;
        // A new prompt makes the previous card history. Leaving it mounted
        // would leave two live cards and old MCQ choices that can still submit.
        for (const old of Array.from(streamEl.querySelectorAll('.sf-study-question'))) {
            const text = old.querySelector('.sf-study-question-text')?.textContent ?? '';
            old.remove();
            if (!text) continue;
            const past = streamEl.createDiv('sf-study-turn sf-study-turn-tutor sf-study-turn-history');
            past.createDiv({ cls: 'sf-study-turn-role', text: 'Question' });
            past.createDiv({ cls: 'sf-study-turn-body', text });
        }
        const card = streamEl.createDiv('sf-study-question sf-animate-fade-in');
        const head = card.createDiv('sf-study-question-head');
        const icon = head.createSpan('sf-study-question-icon');
        setIcon(icon, prompt.kind === 'explain-back' ? 'message-square-quote' : prompt.kind === 'decision' ? 'git-branch' : 'help-circle');
        head.createSpan({ text: prompt.format === 'mcq' ? 'Choose one' : 'Your turn' });
        head.createSpan({ cls: 'sf-study-question-difficulty', text: `depth ${prompt.difficulty}/4` });

        const focus = this.session?.getActiveObjectiveId() ?? null;
        if (prompt.objectiveId && focus && prompt.objectiveId !== focus) {
            const elsewhere = this.controller.planService.getPlan(this.notePath)?.objectives
                .find(objective => objective.id === prompt.objectiveId)?.title;
            card.createDiv({
                cls: 'sf-study-question-scope',
                text: elsewhere ? `This question is about ${elsewhere}` : 'This question is about another objective',
            });
        }

        this.renderMarkdown(prompt.text, card.createDiv('sf-study-question-text markdown-rendered'));

        this.pendingChoiceButtons = [];
        if (prompt.format === 'mcq' && prompt.choices.length > 0) {
            const choices = card.createDiv('sf-study-choices');
            prompt.choices.forEach((choice, index) => {
                const button = choices.createEl('button', { cls: 'sf-study-choice' });
                this.pendingChoiceButtons.push(button);
                button.createSpan({ cls: 'sf-study-choice-letter', text: `${String.fromCharCode(65 + index)}` });
                button.createSpan({ cls: 'sf-study-choice-text', text: choice });
                button.addEventListener('click', () => {
                    if (!this.session || this.session.isBusy()) return;
                    choices.querySelectorAll('.sf-study-choice').forEach(el => el.addClass('is-locked'));
                    button.addClass('is-picked');
                    this.pendingChoiceButtons = [];
                    const answer = `${String.fromCharCode(65 + index)}) ${choice}`;
                    this.setBusy(true, 'Working through your answer…');
                    void this.session.answer(answer);
                });
            });
        }

        // Bring the question's first line into view. Scrolling to the bottom
        // of the transcript hides the start of a question taller than the pane.
        if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
        else this.scrollStream();
        if (this.inputEl && prompt.format !== 'mcq' && this.activeView === 'learn') this.inputEl.focus();
    }

    private renderResearch(queries: string[], results: number, done: boolean): void {
        const streamEl = this.streamEl;
        if (!streamEl) return;
        const box = streamEl.createDiv('sf-study-research sf-animate-fade-in');
        if (!done) box.addClass('is-live');
        const head = box.createDiv('sf-study-research-head');
        const icon = head.createSpan('sf-study-research-icon');
        setIcon(icon, done ? 'book-open' : 'search');
        head.createSpan({ text: done ? `Checked ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}` : 'Looking this up' });
        const list = box.createDiv('sf-study-research-queries');
        for (const query of queries) list.createDiv({ cls: 'sf-study-research-query', text: query });
        box.createDiv({ cls: 'sf-study-research-results', text: done ? `${results} result${results === 1 ? '' : 's'}` : 'searching…' });
        this.scrollStream();
    }

    private renderError(message: string, detail: string | null): void {
        const streamEl = this.streamEl ?? this.learningEl;
        if (!streamEl) return;
        const box = streamEl.createDiv('sf-study-flag sf-study-flag-danger sf-animate-fade-in');
        const iconEl = box.createSpan('sf-study-flag-icon');
        setIcon(iconEl, 'alert-triangle');
        const content = box.createDiv('sf-study-flag-content');
        content.createDiv({ cls: 'sf-study-flag-title', text: message });
        if (detail) {
            const details = content.createEl('details', { cls: 'sf-study-details' });
            details.createEl('summary', { text: 'Details' });
            details.createEl('pre', { text: detail.slice(0, 2000) });
        }
        this.setBusy(false, '');
        const retry = content.createEl('button', { text: 'Try again', cls: 'sf-btn sf-study-retry' });
        retry.addEventListener('click', () => {
            box.remove();
            if (this.session) void this.session.retryPending();
            else void this.plugin.savePluginData().catch(() => this.renderError('Progress not saved', null));
        });
        this.scrollStream();
    }

    private renderDigest(): void {
        const digestEl = this.digestEl;
        if (!digestEl) return;
        const digest = this.digest;
        digestEl.empty();
        if (!digest) {
            digestEl.createDiv({ cls: 'sf-study-digest-empty', text: 'The session digest appears here as you go.' });
            return;
        }

        const progress = digestEl.createDiv('sf-study-digest-progress');
        const fill = progress.createDiv('sf-study-digest-bar').createDiv('sf-study-digest-fill');
        fill.setCssProps({ '--sf-fill': `${Math.round(digest.masteryScore * 100)}%` });
        progress.createDiv({
            cls: 'sf-study-digest-text',
            text: `${digest.covered}/${digest.totalObjectives} objectives touched · evidence score ${Math.round(digest.masteryScore * 100)}%`,
        });

        const stats = digestEl.createDiv('sf-study-digest-stats');
        const errors = Object.entries(digest.errorCounts)
            .filter(([category, count]) => category !== 'success' && (count ?? 0) > 0)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
        if (errors.length > 0) {
            const row = stats.createDiv('sf-study-digest-errors');
            row.createSpan({ cls: 'sf-study-digest-label', text: 'Errors' });
            for (const [category, count] of errors) {
                row.createSpan({ cls: 'sf-study-digest-error', text: `${STUDY_ERROR_LABELS[category as StudyErrorCategory] ?? category} ×${count}` });
            }
        } else {
            stats.createDiv({ cls: 'sf-study-digest-ok', text: 'No errors recorded yet in this session.' });
        }

        const meta = stats.createDiv('sf-study-digest-meta');
        meta.createSpan({ text: `Turn ${digest.turnCount}/${digest.turnLimit}` });
        if (digest.webLookups > 0) meta.createSpan({ text: ` · ${digest.webLookups} lookup${digest.webLookups === 1 ? '' : 's'}` });
        if (digest.dueObjectives.length > 0) meta.createSpan({ text: ` · ${digest.dueObjectives.length} objective(s) due` });

        const actions = digestEl.createDiv('sf-study-digest-actions');
        const end = actions.createEl('button', { text: 'End and log', cls: 'sf-btn' });
        end.addEventListener('click', () => {
            if (!this.session) return;
            this.setBusy(true, 'Closing the session…');
            void this.renderComplete(this.session.finish(false));
        });
        const exportBtn = actions.createEl('button', { text: 'Save session notes', cls: 'sf-btn' });
        exportBtn.addEventListener('click', () => {
            void (async () => {
                if (!this.session) return;
                const payload = this.session.finish(false);
                await this.controller.exportSession(payload);
                await this.renderComplete(payload);
            })();
        });
    }

    // ---------------------------------------------------------------- report

    private async renderComplete(payload: StudySummaryPayload, restored = false): Promise<void> {
        if (this.finished && this.resultRecorded) return;
        this.finished = true;
        this.stopTicker();
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
        this.controller.setStudyingNote?.(null);

        const host = this.learningEl;
        if (!host) return;
        this.switchWorkspaceView('learn');
        host.empty();

        const header = host.createDiv('sf-study-header');
        const titleRow = header.createDiv('sf-study-title-row');
        const titleIcon = titleRow.createSpan('sf-study-title-icon');
        setIcon(titleIcon, 'flag');
        titleRow.createDiv({ cls: 'sf-study-title', text: `${this.noteTitle} · session report` });

        const body = host.createDiv('sf-study-briefing sf-study-report');
        const score = Math.round(payload.score * 100);
        const scoreRow = body.createDiv('sf-study-score');
        const ring = scoreRow.createDiv('sf-study-score-ring');
        ring.createDiv({ cls: 'sf-study-score-value', text: `${score}%` });
        ring.setAttribute('data-score', score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low');
        ring.setCssProps({ '--sf-study-score': String(score) });
        const scoreText = scoreRow.createDiv('sf-study-score-text');
        scoreText.createDiv({ cls: 'sf-study-score-title', text: payload.session.completed ? 'Session complete' : 'Session ended early' });
        scoreText.createDiv({
            cls: 'sf-study-score-sub',
            text: `${payload.digest.covered}/${payload.digest.totalObjectives} objectives touched · ${payload.session.turnCount} turns · ${payload.digest.webLookups} lookups`,
        });
        if (payload.session.summary) {
            this.renderMarkdown(payload.session.summary, scoreText.createDiv('sf-study-report-summary markdown-rendered'));
        }

        const plan = this.controller.planService.getPlan(this.notePath);
        if (payload.mastered.length > 0) {
            const section = body.createDiv('sf-study-report-section');
            section.createDiv({ cls: 'sf-study-section-title', text: 'Now solid' });
            for (const id of payload.mastered) {
                const objective = plan?.objectives.find(entry => entry.id === id);
                if (objective) section.createDiv({ cls: 'sf-study-report-item sf-study-report-solid', text: objective.statement });
            }
        }
        if (payload.fragile.length > 0) {
            const section = body.createDiv('sf-study-report-section');
            section.createDiv({ cls: 'sf-study-section-title', text: 'Needs another pass' });
            for (const id of payload.fragile) {
                const objective = plan?.objectives.find(entry => entry.id === id);
                if (objective) section.createDiv({ cls: 'sf-study-report-item sf-study-report-fragile', text: objective.statement });
            }
        }
        if (this.heldFeedback.length > 0) {
            const section = body.createDiv('sf-study-report-section');
            section.createDiv({ cls: 'sf-study-section-title', text: 'Held-back feedback from the exam block' });
            this.heldFeedback.forEach((entry, index) => {
                const item = section.createDiv(`sf-study-feedback ${entry.correct ? 'is-correct' : 'is-wrong'}`);
                const head = item.createDiv('sf-study-feedback-head');
                const icon = head.createSpan('sf-study-feedback-icon');
                setIcon(icon, entry.correct ? 'check-circle-2' : 'x-circle');
                head.createSpan({ text: `Q${index + 1} · ${entry.label}` });
                this.renderMarkdown(entry.text, item.createDiv('sf-study-turn-body markdown-rendered'));
            });
        }

        const store = this.controller.planService.getProgress(this.notePath);
        if (plan && store) {
            const section = body.createDiv('sf-study-report-section');
            section.createDiv({ cls: 'sf-study-section-title', text: 'Provisional review plan' });
            section.createDiv({
                cls: 'sf-study-report-note',
                text: 'These intervals are suggestions from this session, not proven optima. The note itself is scheduled by the spaced-repetition engine.',
            });
            const list = section.createDiv('sf-study-review-list');
            for (const objective of plan.objectives) {
                const state = store.objectives[objective.id];
                if (!state || state.nextReviewAt === null) continue;
                const days = Math.max(0, Math.round((state.nextReviewAt - Date.now()) / 86400000));
                const row = list.createDiv('sf-study-review-row');
                const status = row.createSpan({ cls: 'sf-study-review-status' });
                status.setAttribute('data-status', state.status);
                row.createSpan({ cls: 'sf-study-review-title', text: objective.title });
                row.createSpan({ cls: 'sf-study-review-days', text: days <= 0 ? 'due now' : `in ${days}d` });
            }
        }

        if (payload.session.sources.length > 0) {
            const section = body.createDiv('sf-study-report-section');
            section.createDiv({ cls: 'sf-study-section-title', text: 'Sources looked up' });
            this.renderSources(section, payload.session.sources);
        }

        const actions = host.createDiv('sf-study-actions');
        const again = actions.createEl('button', { text: 'Study this note again', cls: 'sf-btn' });
        again.addEventListener('click', () => {
            this.finished = false;
            this.resultRecorded = false;
            this.freshStart = true;
            this.session = null;
            void this.init();
        });
        const exportBtn = actions.createEl('button', { text: 'Save session notes', cls: 'sf-btn' });
        exportBtn.addEventListener('click', () => void this.controller.exportSession(payload));
        const close = actions.createEl('button', { text: 'Done', cls: 'sf-btn sf-btn-primary' });
        close.addEventListener('click', () => {
            if (restored) {
                this.session = null;
                this.finished = false;
                // The saved thread is still finished; the next Start must open
                // a new sitting rather than restore the report again.
                this.freshStart = true;
                this.renderBriefing();
                return;
            }
            this.session = null;
            this.options.onSessionEnd?.(payload);
        });

        if (!restored && !this.resultRecorded) {
            this.resultRecorded = true;
            await this.controller.applySessionResult(payload);
            try {
                if ((await this.plugin.savePluginData()) === false) throw new Error('The result was not saved.');
            } catch (error) {
                new Notice(`Session result not saved: ${String(error)}. Retry before closing.`);
            }
            void this.plugin.getSidebarView()?.refresh();
        }
        if (!restored) this.options.onSessionEnd?.(payload);
    }
}
