import { Notice, TFile, WorkspaceLeaf } from 'obsidian';
import SpaceforgePlugin from '../main';
import {
    EDITING_HINT,
    HOTKEY_HINT,
    GradeBucket,
    ReviewAlgorithm,
    ReviewFlowModel,
    ReviewRecordResult,
    ReviewSessionHost,
    UndoRecord,
    bucketResponse,
    formatDueLabel,
    formatScheduledInterval,
    gradeKeyLabel,
    gradeOptionsFor,
    hotkeyHint,
    isCardsStep,
    leechChoices,
    leechPromptText,
    resolveHotkey,
    shouldPromptLeech,
    deckStepId,
    cardStepDeck,
} from '../models/review-flow';
import { ReviewSchedule } from '../models/review-schedule';
import { FSRS, SM2 } from '../ui/constants';
import { DockSuggestion, DockTab, ReviewDock } from '../ui/review-dock';
import { ReviewStrip, StripGradeButton, StripState } from '../ui/review-strip';
import { REVIEW_WINDOW_VIEW, ReviewWindowView } from '../ui/review-window-view';
import { DateUtils } from '../utils/dates';

function pluralNotes(count: number): string {
    return `${count} note${count === 1 ? '' : 's'}`;
}

/**
 * The one question this controller asks the sidebar: which pane is on screen.
 *
 * Duck-typed rather than imported — the sidebar view already imports the plugin
 * and knows this controller, and this is one question between them, not a
 * dependency. A view that cannot answer leaves the session's own container as
 * the proof.
 */
interface SidebarHostView {
    isReviewPaneVisible?: () => boolean;
}

/**
 * Runs a review session with the bar docked under the note.
 *
 * The note is the item being reviewed, so it owns the screen: this controller
 * opens each due note in the active leaf, renders the grading bar beneath it and
 * keeps the keyboard bound to grading. Nothing is shown on top of the note, and a
 * grade moves straight on to the next one.
 */
export class ReviewFlowController {
    private plugin: SpaceforgePlugin;
    private model = new ReviewFlowModel();
    private strip: ReviewStrip;
    /**
     * Study and MCQ sittings, docked under the bar for the note under review.
     * Everything that used to open a window over the note lives here.
     */
    private dock: ReviewDock | null = null;
    /**
     * Whether this run has already opened the cards at its end.
     *
     * The deck lane is the next step, not a suggestion to click: when the queue
     * empties the sitting opens itself, once. Ending it is the reader's answer,
     * and it is never reopened behind their back.
     */
    private handedOver = false;
    /**
     * Whether the card lane's step has had a sitting on screen.
     *
     * The cards are steps of the run like the notes are, and a step is over
     * when its sitting is: this is what tells "the sitting has ended" from
     * "the sitting has not started yet", so landing on the step never settles
     * it before it has been shown.
     */
    private cardsStepSeen = false;
    /** Sticky: the run has been on a deck step at least once this sitting. */
    private cardsStepReached = false;
    /** True while the run is asking for the card sitting; one ask at a time. */
    private cardsStepStarting = false;
    /**
     * The grade a finished sitting implies. It is marked on the bar's own grade
     * row — the row the learner is about to press — rather than repeated as a
     * second set of buttons under it.
     */
    private dockSuggestion: DockSuggestion | null = null;
    private leaf: WorkspaceLeaf | null = null;
    /** The window a session opened in, when the setting asks for one. */
    private popoutLeaf: WorkspaceLeaf | null = null;
    /** Where the session's own surfaces live right now. */
    private host: ReviewSessionHost = 'note';
    /** The container a host handed us — the sidebar's review tab. */
    private hostContainer: HTMLElement | null = null;
    /** The window the session itself was moved into, when that is its home. */
    private sessionWindow: WorkspaceLeaf | null = null;
    /** The main-area leaf to the right of the note, when the dock sits beside it. */
    private sessionSplit: WorkspaceLeaf | null = null;
    /** True while the split leaf is being created, so a layout change cannot add a second. */
    private splitOpening = false;
    /** The container currently carrying our host class, so it can be taken off. */
    private hostClassEl: HTMLElement | null = null;
    /** True while a walk-back to a visible home is in flight, so it never loops. */
    private recovering = false;
    /** True while a sitting's redraw is already queued for the bar. */
    private cardsChangedQueued = false;
    private busy = false;
    /** The note the list's pin is currently on, so a render can skip re-marking. */
    private lastMarkedPath: string | null = null;
    private lastWasEditable = false;
    /** Set when the graded note stayed due today and must come back this session. */
    private requeueAfterDecision = false;
    private keyHandler: ((event: KeyboardEvent) => void) | null = null;
    /** The run state last written, so a render only saves when something moved. */
    private lastSavedRun: string | null = null;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
        this.strip = new ReviewStrip({
            onGrade: (response) => { void this.grade(response); },
            onSkip: () => { void this.skip(); },
            onPrevious: () => { void this.stepBack(); },
            onNext: () => { void this.stepForward(); },
            onPostpone: () => { void this.postponeCurrent(); },
            onUndo: () => { void this.undo(); },
            onEnd: () => this.end(),
            onDecision: (action) => { void this.resolveDecision(action); },
            onTestWithMCQs: () => { void this.testWithMCQs(); },
            onRegenerateMCQs: () => { void this.regenerateMCQs(); },
            onRemoveFromSchedule: () => { void this.removeCurrentFromSchedule(); },
            onTab: (tab) => this.selectDockTab(tab),
            onHost: (host) => { void this.moveToHost(host); },
        });
        this.host = plugin.settings.reviewSessionHost ?? 'note';
        this.strip.setHost(this.host);

        // Load-time only: take down what a killed instance left in the document
        // before anything of ours exists to be confused with it.
        this.clearStaleSurfaces();

        // The strip lives inside the note's leaf; Obsidian can rebuild that leaf
        // (split changes, view swaps), so re-attach when the layout settles.
        this.plugin.registerEvent(this.plugin.app.workspace.on('layout-change', () => {
            if (this.model.isActive()) {
                this.mountStrip();
                this.render();
            }
        }));
    }

    isActive(): boolean {
        return this.model.isActive();
    }

    /**
     * Pick up an interrupted run when the plugin loads, if there is one.
     *
     * Deliberately not `start()`: a session the reader never asked for must not
     * appear because the app opened. Only a run that was live when the app last
     * closed comes back, and only while it still names a note that exists.
     */
    resumeSavedRunIfAny(): boolean {
        if (this.model.isActive()) return false;
        const saved = this.plugin.pluginState?.noteRun ?? null;
        if (!saved || !Array.isArray(saved.order) || saved.order.length === 0) return false;
        this.ensureHostReady();
        return this.resumeSavedRun();
    }

    /**
     * Start (or restart) a review run.
     *
     * @param startPath Note to start from; defaults to the first due note.
     */
    start(startPath?: string): void {
        this.handedOver = false;
        this.ensureHostReady();

        // A run that is already walking and knows this note: naming it moves the
        // run's own cursor rather than building a second queue behind the one
        // the reader is in. The order and the handled set *are* the reader's
        // place in the walk, so they are kept exactly — a note pressed in the
        // sidebar list positions the dock, it does not fork it. A note the run
        // does not name (or no run at all) starts a fresh walk positioned on it,
        // which is what this call has always done.
        if (startPath && this.model.isActive() && this.model.has(startPath)) {
            this.model.focus(startPath);
            this.installKeyHandler();
            this.strip.setMcqAvailable(this.plugin.settings.enableMCQ && !!this.plugin.mcqController);
            void this.gotoCurrent();
            return;
        }

        // A run that was interrupted — the pane closed, the sidebar switched,
        // the app reloaded — is picked up where it stopped rather than started
        // over, but only when the caller did not name a note of their own.
        if (!startPath && this.resumeSavedRun()) return;
        const dueNotes = this.plugin.reviewController.getTodayNotes();
        const duePaths = dueNotes.map(note => note.path);

        if (duePaths.length === 0) {
            this.plugin.reviewController.updateTodayNotes(true);
            const refreshed = this.plugin.reviewController.getTodayNotes().map(note => note.path);
            if (refreshed.length === 0) {
                new Notice('No notes are due for review.');
                return;
            }
            this.begin(refreshed, startPath);
            return;
        }

        this.begin(duePaths, startPath);
    }

    private begin(duePaths: string[], startPath?: string): void {
        // The run is the sitting, and the sitting is everything that is
        // waiting: the notes first, the decks' cards as their own series of
        // steps behind them, so the bar's counter counts all of it.
        this.cardsStepSeen = false;
        this.cardsStepStarting = false;
        this.cardsStepReached = false;
        this.model.start(duePaths, startPath, this.liveCardSteps());
        this.installKeyHandler();
        this.strip.setMcqAvailable(this.plugin.settings.enableMCQ && !!this.plugin.mcqController);

        if (this.model.phase === 'finished') {
            this.model.end();
            this.removeKeyHandler();
            return;
        }

        void this.gotoCurrent();
    }

    /** End the run and take the strip down. */
    end(): void {
        if (!this.model.isActive()) return;
        const handled = this.model.position().handled;
        const heldPane = this.host === 'sidebar';
        this.model.end();
        this.cardsStepSeen = false;
        this.cardsStepStarting = false;
        this.handedOver = false;
        // The run is over: there is nothing left to come back to.
        this.clearSavedRun();
        this.removeKeyHandler();
        this.strip.unmount();
        this.dock?.destroy();
        this.dock = null;
        // The split is the session's pane, not the reader's: ending the run
        // leaves no empty Review tab behind. The remembered home stays split,
        // so the next run opens beside the note again.
        if (this.host === 'split') this.closeSessionSplit();
        // A review pane with nothing in it still claims to be the session: the
        // reader's next press of Review has to find the tab free, or the press
        // does nothing at all. The remembered home is left as the reader wrote
        // it — the next run opens where they chose.
        if (heldPane) this.handBackSidebarPane();
        this.plugin.reviewController.updateTodayNotes(true);
        void this.plugin.getSidebarView()?.refresh?.();
        if (handled > 0) {
            new Notice(`Review session ended — ${pluralNotes(handled)} handled.`);
        }
    }

    /**
     * Re-render the bar for the note it is already on.
     *
     * A grade given from the dock belongs to this note, so the bar has to show
     * the new schedule without walking to the next one.
     */
    refreshCurrent(): void {
        if (!this.model.isActive()) return;
        this.render();
    }

    /**
     * Where the run is, for every other surface that navigates.
     *
     * The run *is* the navigation state: its cursor is the one remembered
     * position, and the sidebar list's Previous/Next, a press on a note row and
     * the bar's own controls all read and move this one place. No surface keeps
     * a position of its own.
     *
     * Null while the run stands on the card lane's own step: the step is not a
     * note, and a surface that would open, mark or walk a *file* has nothing to
     * do with it ({@link isOnCardsStep} is the question those callers ask).
     */
    currentPath(): string | null {
        if (!this.model.isActive()) return null;
        const path = this.model.currentPath();
        return this.model.isCardStep(path) ? null : path;
    }

    /**
     * True while the run is standing on the card lane's step.
     *
     * The cards are steps of the run — see {@link ReviewFlowModel} — so a step
     * of the run can be a card sitting rather than a note: nothing about it is
     * opened as a file, graded on the bar or postponed.
     */
    isOnCardsStep(): boolean {
        return this.model.isRunning() && this.model.onCardStep();
    }

    /** The run's place in its queue: the bar's counter, plus the cursor itself. */
    runPosition(): { index: number; place: number; total: number; handled: number; remaining: number } {
        // The reader's place in the queue, which the model's tally does not
        // carry: the bar's number and its bar both read this, so navigation and
        // the readout can never disagree.
        const position = this.model.position();
        return {
            index: this.model.cursorIndex(),
            place: this.model.place(),
            handled: position.handled,
            remaining: position.remaining,
            total: position.total,
        };
    }

    /**
     * The run's own forward step — the one the bar's Skip takes.
     *
     * False only when no run is walking, which is the caller's signal to fall
     * back to its own walk of the due list. A leech question holds the run: the
     * step is then refused the way the bar refuses it, and *true* comes back
     * all the same, because the run still owns navigation and the caller must
     * not walk around a question that is waiting for an answer.
     */
    async stepForward(): Promise<boolean> {
        if (!this.model.isRunning()) return false;
        if (this.decisionHoldsStep()) return true;
        if (this.busy) return true;
        // Navigation, not a skip: the note is not marked handled, because
        // looking at the next one is not the same as finishing this one.
        if (!this.model.stepForward()) return true;
        await this.gotoCurrent();
        return true;
    }

    /**
     * The run's own previous note: the cursor moves back one place in the queue
     * the bar is walking, and that note is opened. Same contract as
     * {@link stepForward} — false means nobody is sitting.
     */
    async stepBack(): Promise<boolean> {
        if (!this.model.isRunning()) return false;
        if (this.decisionHoldsStep()) return true;
        if (this.busy) return true;
        if (!this.model.stepBack()) return true;
        await this.gotoCurrent();
        return true;
    }

    /** A pending leech question holds the run: nothing steps past it. */
    private decisionHoldsStep(): boolean {
        if (this.model.phase !== 'decision') return false;
        new Notice('Answer the question about this note first.');
        return true;
    }

    /** Tear down without the notice, for plugin unload. */
    dispose(): void {
        // Unloading is not abandoning: what the run was doing stays saved, so
        // the next start picks it up where it stopped.
        this.persistRun();
        this.model.end();
        this.removeKeyHandler();
        this.strip.unmount();
        this.dock?.destroy();
        this.dock = null;
        const window = this.sessionWindow;
        this.sessionWindow = null;
        window?.detach();
        const split = this.sessionSplit;
        this.sessionSplit = null;
        split?.detach();
    }

    /**
     * Where the session's surfaces live, and how they move.
     *
     * A session is not a place: the same bar and the same dock follow the reader
     * from under the note, to a window of its own, to the sidebar's review tab.
     * Moving them moves the elements — the run, the queue and any sitting in
     * progress travel with them — and nothing is restarted or asked again.
     */
    setHost(host: ReviewSessionHost, container: HTMLElement | null = null, persist = true): void {
        // The sidebar is a place we have to be given: without its tab's element
        // there is nowhere to put the session.
        if (host === 'sidebar' && !container) return;
        const previous = this.host;
        this.host = host;
        this.hostContainer = host === 'sidebar' ? container : null;
        this.hostClassEl?.removeClass('sf-host-note', 'sf-host-window', 'sf-host-sidebar');
        this.hostClassEl = null;
        this.strip.setHost(host);
        if (persist) {
            this.plugin.settings.reviewSessionHost = host;
            void this.plugin.savePluginData();
        }
        if (host === 'window') {
            if (previous === 'split') this.closeSessionSplit();
            const leavingPane = persist && previous === 'sidebar';
            // The pane is handed back *after* the session has left it: hiding a
            // container the session is still inside is its own bug.
            void this.openSessionWindow().then(
                () => { if (leavingPane) this.handBackSidebarPane(); },
                () => { if (leavingPane) this.handBackSidebarPane(); },
            );
            return;
        }
        if (host === 'split') {
            // A split is the reader's own pane: the window, if any, has to go
            // first or the session would be in two homes at once.
            if (previous === 'window') this.closeSessionWindow();
            if (persist && previous === 'sidebar') this.handBackSidebarPane();
            // A preference can be chosen before there is a run; the pane is
            // opened when the run starts, not as an empty frame now.
            if (this.model.isActive()) void this.openSessionSplit();
            return;
        }
        this.closeSessionWindow();
        this.closeSessionSplit();
        // Only a move *away* from the sidebar hands the pane back: entering it
        // is the pane doing the claiming.
        if (persist && previous === 'sidebar' && host !== 'sidebar') this.handBackSidebarPane();
        if (this.model.isActive()) this.remountSurfaces();
    }

    /**
     * The reader has moved the session out of the sidebar's review tab.
     *
     * The pane keeps only one claim on the session — "I already handed it the
     * element" — and it drops that claim when the reader leaves the tab. A move
     * made from the bar's menu never touches the tab, so the pane went on
     * showing the review body with nothing in it and its claim still standing:
     * pressing Review there did nothing (the claim said the session was already
     * mounted, and the mode was already review, so the press never even reached
     * the view). Switching to the list and back was what cleared the claim.
     *
     * Handing the pane back — the mode the reader can see, refreshed — is what
     * that switch does: the review tab stops being the pane on screen, the
     * claim goes with it, and the reader's very first press of Review brings
     * the session into the pane. An empty tab that claims to be the session is
     * the same bug as a duplicate panel.
     */
    private handBackSidebarPane(): void {
        // The mode is the pane the reader can see, and it is the only part of
        // the state that survives a plugin reload (the view instance does not:
        // `getSidebarView()` refuses one built by the previous module load).
        // The press reads the mode first, so leaving it at 'review' is exactly
        // what made the press do nothing.
        if (this.plugin.settings.sidebarViewType !== 'review') return;
        this.plugin.settings.sidebarViewType = 'list';
        void this.plugin.savePluginData();
        // The view's own render lets the pane go (it hides the tab and drops its
        // claim); where there is no view to ask, the mode is the proof.
        const sidebar = this.plugin.getSidebarView?.() as unknown as { refresh?: () => Promise<void> } | null;
        if (typeof sidebar?.refresh === 'function') void sidebar.refresh();
    }

    /**
     * Repaint the bar after a setting that only changes how it is drawn.
     *
     * The strip is rebuilt from the model's current state, so a layout choice
     * lands without touching the run itself.
     */
    refreshStrip(): void {
        this.render();
    }

    getHost(): ReviewSessionHost {
        return this.host;
    }

    /**
     * A remembered home that is not on screen is opened before the first note —
     * unless the reader is standing somewhere else.
     *
     * The sidebar's review tab is a place the reader chose; a session that
     * silently lands somewhere else is a bug they have to report. One rule
     * outranks that memory, though: a session must be visible the moment it
     * starts. With the sidebar showing its list — which the remembered mode
     * says nothing about — a session started from a row there mounts under the
     * note, the one home that is always on screen. The reader's remembered
     * choice is left exactly as they wrote it, for the next run.
     */
    private ensureHostReady(): void {
        if (this.host === 'split') {
            if (!this.splitView()?.containerEl?.isConnected) void this.openSessionSplit();
            return;
        }
        if (this.host !== 'sidebar') return;
        if (!this.sidebarShowsSession()) {
            this.setHost('note', null, false);
            return;
        }
        if (this.hostContainer?.isConnected) return;
        void (async () => {
            await this.plugin.activateSidebarView();
            await this.plugin.getSidebarView()?.openReviewTab();
        })();
    }

    /**
     * The sidebar view, when one is up.
     *
     * It is the only thing that can say which of its panes is really on screen:
     * the mode is remembered in the settings and written from several places,
     * so the setting alone is not evidence that the pane followed it.
     */
    private sidebarView(): SidebarHostView | null {
        const view = this.plugin.getSidebarView?.() as unknown as SidebarHostView | null;
        return view ?? null;
    }

    /**
     * True while the remembered sidebar home is a pane the reader can see.
     *
     * A view that can answer is believed. Without one there is no pane on
     * screen to ask about, and the remembered mode is the whole of the answer —
     * which is how a session reaches a review tab that is about to be built.
     */
    private sidebarShowsSession(): boolean {
        const view = this.sidebarView();
        if (view?.isReviewPaneVisible) return view.isReviewPaneVisible();
        return this.plugin.settings.sidebarViewType === 'review';
    }

    /**
     * A session whose home is not on screen comes back under its note.
     *
     * The remembered home decides *where* a session wants to live, not whether
     * the reader can see it: when the sidebar is holding the session in a pane
     * it is no longer showing, the note is the home that can always be found.
     * Nothing is persisted — the reader's choice still decides the next run.
     */
    private returnToVisibleHome(): void {
        if (this.host !== 'sidebar') return;
        if (this.sidebarShowsSession()) return;
        this.setHost('note', null, false);
    }

    /**
     * The session's window was closed: the session comes back under its note.
     *
     * Not to the remembered home: that home may be a window itself, or the
     * sidebar's tab — which is not on screen here, because the tab hands the
     * session over when the window takes it. The note is the one home that can
     * always be found again; the remembered choice still decides the next run.
     */
    handleSessionWindowClosed(): void {
        this.sessionWindow = null;
        if (this.host === 'split') {
            // An expected close sets `sessionSplit` to null before detaching;
            // a press on the pane's own ✕ leaves it set.
            if (this.sessionSplit === null) return;
            this.sessionSplit = null;
            this.setHost('note', null, false);
            return;
        }
        if (this.host !== 'window') return;
        this.setHost('note', null, false);
    }

    /** The reader picked a new home for the session: the menu, or a command. */
    async moveToHost(host: ReviewSessionHost): Promise<void> {
        if (host === 'sidebar') {
            // The tab mounts the session itself, once it is on screen.
            await this.plugin.activateSidebarView();
            await this.plugin.getSidebarView()?.openReviewTab();
            return;
        }
        this.setHost(host);
    }

    /**
     * A window of the session's own.
     *
     * The note stays in the pane the reader is working in; the questions and the
     * grading bar travel to a window that can sit on a second screen or on top of
     * the app. Closing it brings the session back under the note.
     */
    private async openSessionWindow(): Promise<void> {
        // Any window of ours counts — including one left behind by an earlier
        // plugin instance. A second window beside the first is two review
        // sessions, and the reader only asked for one.
        const existing = this.plugin.app.workspace.getLeavesOfType(REVIEW_WINDOW_VIEW);
        const ours = this.sessionWindow?.view?.containerEl?.isConnected ? this.sessionWindow : null;
        const leaf = ours ?? existing[0] ?? null;
        if (leaf) {
            this.sessionWindow = leaf;
            if (leaf.view?.containerEl?.isConnected) {
                void this.plugin.app.workspace.revealLeaf(leaf);
                if (this.model.isActive()) this.remountSurfaces();
                return;
            }
        }
        const opened = leaf ?? this.plugin.app.workspace.openPopoutLeaf({ size: { width: 560, height: 720 } });
        this.sessionWindow = opened;
        if (opened.view?.getViewType?.() !== REVIEW_WINDOW_VIEW) {
            await opened.setViewState({ type: REVIEW_WINDOW_VIEW, active: true });
        }
        void this.plugin.app.workspace.revealLeaf(opened);
        if (this.model.isActive()) this.remountSurfaces();
    }

    /**
     * The session beside its note: a main-area split to the right.
     *
     * The note keeps the pane it was in and the bar and dock take the new
     * pane, so the divider is Obsidian's own and drags like any other. Unlike
     * the popout window this leaf lives in the workspace: the session is still
     * on the screen the reader is working on, just no longer under the note.
     */
    private async openSessionSplit(): Promise<void> {
        if (this.splitOpening) return;
        this.splitOpening = true;
        try {
            const existing = this.sessionSplit?.view?.containerEl?.isConnected ? this.sessionSplit : null;
            const adopted = existing
                ?? this.plugin.app.workspace.getLeavesOfType(REVIEW_WINDOW_VIEW).find(leaf =>
                    leaf.view?.containerEl?.isConnected
                    && leaf.getViewState?.().state?.spaceforgeSplit === true);
            if (adopted) {
                this.sessionSplit = adopted;
                void this.plugin.app.workspace.revealLeaf(adopted);
                if (this.model.isActive()) this.remountSurfaces();
                return;
            }
            const noteLeaf = this.leaf?.view?.containerEl?.isConnected
                && this.leaf.view?.getViewType?.() === 'markdown'
                && this.leaf.view.containerEl.getBoundingClientRect().width > 0
                ? this.leaf
                : this.plugin.app.workspace.getLeaf();
            const leaf = this.plugin.app.workspace.createLeafBySplit(noteLeaf, 'vertical', false);
            this.sessionSplit = leaf;
            await leaf.setViewState({
                type: REVIEW_WINDOW_VIEW,
                active: false,
                state: { spaceforgeSplit: true },
            });
            void this.plugin.app.workspace.revealLeaf(leaf);
            if (this.model.isActive()) this.remountSurfaces();
        } finally {
            this.splitOpening = false;
        }
    }

    /** The session has left its split: the pane goes with it. */
    private closeSessionSplit(): void {
        const leaf = this.sessionSplit;
        this.sessionSplit = null;
        leaf?.detach();
    }

    /**
     * The session has left its window: the window goes with it.
     *
     * Leaving it open is the same bug as a duplicate panel — an empty frame that
     * claims to be the review session, and a second one on the next move.
     */
    private closeSessionWindow(): void {
        this.sessionWindow = null;
        for (const leaf of this.plugin.app.workspace.getLeavesOfType(REVIEW_WINDOW_VIEW)) {
            leaf.detach();
        }
    }

    private sessionView(): ReviewWindowView | null {
        return this.sessionHostView(this.sessionWindow);
    }

    private splitView(): ReviewWindowView | null {
        return this.sessionHostView(this.sessionSplit);
    }

    /**
     * A view that can host the session, found by its contract rather than by
     * `instanceof`: after a plugin reload the leaf still holds a view built by
     * the previous module load, and a class check says it is a stranger while
     * the object still has the one method we need.
     */
    private sessionHostView(leaf: WorkspaceLeaf | null): ReviewWindowView | null {
        const view = leaf?.view as unknown as { getSessionHostEl?: () => HTMLElement } | null;
        if (!view || typeof view.getSessionHostEl !== 'function') return null;
        return view as unknown as ReviewWindowView;
    }

    /** Take the surfaces out of the leaf and put them at the session's home. */
    private remountSurfaces(): void {
        const container = this.resolveSessionContainer();
        if (!container) {
            // Moving to a home that is not there. Returning early is what
            // stranded a live run inside the element the old host had just
            // hidden or discarded — "the whole interface disappears" — so the
            // surfaces come down and the run is walked back to its note instead.
            this.recoverVisibleHost();
            return;
        }
        this.strip.unmount();
        this.strip.mountInto(container);
        // Re-appending the dock moves it: a sitting in progress comes along,
        // panel and all — a move is never a teardown.
        this.dock?.mountInto(container);
        this.applyHostClass(container);
        this.render();
    }

    /**
     * The session has no on-screen container: give it one, at most once.
     *
     * A host change lands here when the new home is gone (the note's pane is
     * closed, the window was discarded) and a note change lands here while the
     * pane is being rebuilt. The bar is unmounted first — a live bar must never
     * be left inside an element the app has hidden or abandoned — then the run
     * is walked back to the one place that can always be found: its note, in a
     * pane. A finished run has no note, but the dock may still hold a card
     * sitting, and a sitting nobody can see is a sitting lost: that case takes
     * the active pane. With nothing to show, staying unmounted is the clean
     * state, not a failure.
     */
    private recoverVisibleHost(): void {
        this.strip.unmount();
        if (this.recovering) return;
        const path = this.model.isFinished() ? null : this.model.currentPath();
        // Anything worth showing counts: the note the run is on, or the dock —
        // which may be holding a card sitting, or be about to receive one (the
        // deck lane docks into the session's own dock). A dock parked in a pane
        // nobody can see is how a sitting went missing, so a run that still owns
        // one takes a pane rather than staying hidden.
        if (!path && this.dock === null) return;
        this.recovering = true;
        const recovery = path ? this.openNoteInLeaf(path) : Promise.resolve(this.mountIntoVisiblePane());
        void recovery.finally(() => { this.recovering = false; });
    }

    /** A pane for a run with no note left to open — the dock's own contents. */
    private mountIntoVisiblePane(): void {
        this.leaf = this.plugin.app.workspace.getLeaf();
        this.mountStrip();
    }

    private applyHostClass(container: HTMLElement): void {
        if (this.hostClassEl && this.hostClassEl !== container) {
            this.hostClassEl.removeClass('sf-host-note', 'sf-host-split', 'sf-host-window', 'sf-host-sidebar');
        }
        this.hostClassEl = container;
        container.addClass(`sf-host-${this.host}`);
    }

    /**
     * The element the session's surfaces mount into, for the host in force.
     *
     * A container counts only while it is connected and visible: the sidebar
     * hides its tab the moment the reader switches away, and mounting into a
     * hidden element is how a live session disappeared while its run went on.
     * When the host's own element cannot take the session, the note is the
     * fallback — a bar under the note beats a run with no bar at all — and when
     * even that is gone the caller recovers (see {@link recoverVisibleHost}).
     */
    private resolveSessionContainer(): HTMLElement | null {
        const home = this.host === 'sidebar'
            ? this.sidebarHomeContainer()
            : this.host === 'split'
                ? (this.splitView()?.getSessionHostEl() ?? null)
                : this.host === 'window'
                    ? (this.sessionView()?.getSessionHostEl() ?? null)
                    : this.noteContainer();
        if (home && home.isConnected && !home.closest('.sf-hidden')) return home;
        if (this.host === 'note') return null;
        // The tab, or the window, is not on screen yet: rather than a run with
        // no bar at all, the session shows under the note until it arrives.
        return this.noteContainer();
    }

    /**
     * The element the sidebar is holding for the session — while it is a pane
     * the reader can actually see.
     *
     * A container the app has hidden is refused, and so is one the view says is
     * not the pane it is showing: the mode and the DOM can disagree, and a
     * session mounted into an invisible pane is a session that has disappeared.
     * A view that cannot answer leaves the container's own state as the proof.
     */
    private sidebarHomeContainer(): HTMLElement | null {
        const container = this.hostContainer;
        if (!container || !container.isConnected) return null;
        const view = this.sidebarView();
        if (view?.isReviewPaneVisible && !view.isReviewPaneVisible()) return null;
        return container;
    }

    /** The note leaf's content area: the session's original home. */
    private noteContainer(): HTMLElement | null {
        const container = this.leaf?.view?.containerEl ?? null;
        if (!container || !container.isConnected) return null;
        if (!container.hasClass('workspace-leaf-content')) return null;
        return container;
    }

    /** Record a grade for the current note and move to the next one. */
    async grade(response: number): Promise<void> {
        if (this.busy || this.model.phase !== 'reviewing') return;
        // The bar prints no grades on the card lane's step — the card on screen
        // has its own buttons — so nothing here may grade a card step either.
        if (this.model.onCardStep()) return;
        const path = this.model.currentPath();
        if (!path) return;

        this.busy = true;
        try {
            const service = this.plugin.reviewScheduleService;
            const scheduleBefore = service.schedules[path];
            const undo: UndoRecord = {
                path,
                scheduleJSON: scheduleBefore ? JSON.stringify(scheduleBefore) : null,
                historyLength: service.history.length,
                previousPath: path,
                recordedAt: Date.now(),
            };

            let result: ReviewRecordResult;
            try {
                result = await this.plugin.reviewController.processReviewResponse(path, response, {
                    navigate: false,
                    silent: true,
                    // The bar grades FSRS notes on the FSRS scale (1-4), so say so:
                    // the two scales overlap numerically and the response must not
                    // be re-read as an SM-2 quality.
                    ratingKind: this.algorithmFor(path) === 'fsrs' ? 'fsrs' : 'auto',
                });
            } catch (error) {
                // Recording must never take the session down with it: say so and
                // leave the bar where it is so the user can retry or carry on.
                console.error('[spaceforge] failed to record a rating:', error);
                new Notice('Could not record that rating. See the developer console for details.');
                return;
            }

            if (!result.recorded) {
                new Notice('Nothing recorded — this note is not due.');
                return;
            }

            // The grade is given: the suggestion has done its job.
            this.dockSuggestion = null;
            this.dock?.clearSuggestion();

            this.model.setUndo(undo);

            // A failure lands on a short-term step and is still due today: keep it
            // in the run so it comes back after the other notes, the way Anki
            // re-asks a lapsed card in the same session. A pass moves the due date
            // out, so the note leaves the run.
            this.requeueAfterDecision = this.isStillDueToday(service.schedules[path]);

            // A note that keeps coming back gets an explicit decision before the
            // flow moves on — the one place a decision really is the user's.
            // The cursor stays on this note until the decision is answered.
            const info = service.getLapseInfo(path);
            const threshold = this.plugin.settings.leechThreshold;
            if (shouldPromptLeech({ lapses: info.lapses, handledAtLapses: info.handledAtLapses, threshold })) {
                this.model.awaitDecision({ path, lapses: info.lapses, threshold });
                this.render();
                return;
            }

            this.model.advance({ keepInRun: this.requeueAfterDecision });
            this.requeueAfterDecision = false;
            this.model.sync(this.duePaths(), this.liveCardSteps());
            if (result.nextPathSource === 'session' && result.nextPath) {
                // A hierarchical session decides the order itself; the due queue
                // does not, so there the run simply continues from where it is.
                this.model.focus(result.nextPath);
            }

            await this.gotoCurrent();
        } finally {
            this.busy = false;
        }
    }

    /**
     * Open the docked panel on one of its tabs for the note under review —
     * how a hotkey (or a command) gets the learner straight to the tutor or
     * the questions without a mouse.
     */
    openDockTab(tab: 'study' | 'mcq'): boolean {
        if (!this.dock || !this.model.isActive()) return false;
        const path = this.model.currentPath();
        // The tutor and the questions are the note's own panels: on the card
        // lane's step there is no note to teach or ask about.
        if (!path || this.model.isCardStep(path)) return false;
        this.dock.openTab(tab);
        return this.dock.isExpanded();
    }

    /**
     * Show a card sitting — a whole deck's queue — in the dock, under the
     * grades, where the MCQs render: the sitting on top of the note review
     * rather than a window over it.
     *
     * Returns false when there is no dock to put it in, which is the caller's
     * signal to fall back to the sitting's own placement (modal, pane, window).
     */
    showCardSitting(mount: (container: HTMLElement) => () => void): boolean {
        const dock = this.dock;
        // A finished queue has no current note, and the hand-off happens exactly
        // then: the bar — and so the dock — is still where the reader is
        // standing, which is the whole point of opening the cards here rather
        // than in a window over the app.
        if (!dock || !this.model.isActive()) return false;
        // The cards are about to go on screen: a session whose home is not the
        // pane the reader is looking at comes back to the note first. A sitting
        // started from the sidebar's list must be visible the moment it starts,
        // not parked in the review pane the reader switched away from.
        this.returnToVisibleHome();
        // …and the home itself has to be one with a screen. Connected is not
        // the same as visible: a leaf the reader has moved away from keeps its
        // DOM (and the whole session with it) while the app hides it, so cards
        // docked into that leaf are cards nobody can see — the "nothing
        // happened" report, word for word.
        this.revealHiddenHome();
        dock.dockCards({ mount: (container) => this.watchCardsProgress(container, mount) });
        return true;
    }

    /**
     * The sitting's own progress, reported to the dock as it happens.
     *
     * The bar's Cards control prints what is *left of the sitting on screen*
     * rather than the sidebar's last count, so it has to hear about an answered
     * card the moment it lands: the sitting redraws itself with each card, and
     * the dock listens to that redraw instead of waiting for the next unrelated
     * render. The observer is not part of any sitting's API on purpose — the
     * deck lane owns its own view, and the flow only watches the element it was
     * handed.
     */
    private watchCardsProgress(container: HTMLElement, mount: (container: HTMLElement) => () => void): () => void {
        const Observer = (window as { MutationObserver?: typeof MutationObserver }).MutationObserver;
        const observer = typeof Observer === 'function' && typeof container.findAll === 'function'
            ? new Observer(() => this.queueCardSittingChanged())
            : null;
        observer?.observe(container, { childList: true, subtree: true });
        const teardown = mount(container);
        return () => {
            observer?.disconnect();
            teardown();
        };
    }

    /** One notification per redraw pass, however many nodes it wrote. */
    private queueCardSittingChanged(): void {
        if (this.cardsChangedQueued) return;
        this.cardsChangedQueued = true;
        void Promise.resolve().then(() => {
            this.cardsChangedQueued = false;
            this.cardSittingChanged();
        });
    }

    /**
     * The sitting on screen has moved on (a card answered, the sitting ended):
     * the bar's own readouts follow it.
     */
    cardSittingChanged(): void {
        this.dock?.cardSittingChanged();
    }

    /**
     * A session mounted into an element with no layout does not exist.
     *
     * Obsidian hides an inactive tab by layout, not by detaching it: the leaf
     * stays connected, keeps its children — the bar, the dock and any sitting
     * in the dock — and measures 0x0. When the home the session is about to
     * render into has no screen, the leaf that owns it is brought to the front
     * (the note's own pane, where the bar belongs) because the sitting is the
     * thing the reader just asked to see.
     */
    private revealHiddenHome(): void {
        // A collapsed sidebar pane is left rather than revealed: the note is
        // the home that can always be found again, the same rule the
        // host-visible check above follows.
        if (this.host === 'sidebar' && !this.containerOnScreen(this.resolveSessionContainer())) {
            this.setHost('note', null, false);
        }
        const container = this.resolveSessionContainer();
        if (!container || this.containerOnScreen(container)) return;
        const leaf = this.leaf;
        if (leaf) void this.plugin.app.workspace.revealLeaf(leaf);
    }

    /**
     * True while an element is somewhere the reader can see.
     *
     * Duck-typed on purpose: a document stand-in with no layout engine (the
     * test harness) cannot be measured, and an element that cannot answer is
     * believed — "unmeasurable" is not "hidden".
     */
    private containerOnScreen(container: HTMLElement | null): boolean {
        if (!container) return false;
        if (container.closest('.sf-hidden')) return false;
        const rects = typeof container.getClientRects === 'function' ? container.getClientRects() : null;
        return !rects || rects.length > 0;
    }

    /**
     * A control was asked for on the bar. Study and MCQs are the dock's own
     * panels; the cards are a step of the run, so their control walks the run
     * to it — the same step the bar's Next takes — and the sitting is on
     * screen the moment it lands.
     */
    private selectDockTab(tab: DockTab): void {
        if (tab !== 'cards') {
            this.dock?.openTab(tab);
            return;
        }
        // The cards control positions the run rather than opening a tab that
        // ignores it: pressing it from a note walks the sitting to the card
        // lane's step, the way Next would, only directly.
        if (this.model.isRunning() && !this.model.onCardStep() && this.model.focusCardSteps()) {
            void this.gotoCurrent();
            return;
        }
        // Already standing on the cards: their panel is put away the way an
        // open tab is, and the sitting behind it keeps the reader's place.
        if (this.dock?.isShowingCards()) {
            this.dock.openTab('cards');
            return;
        }
        void this.openCardsTab();
    }

    /** The bar's cards control: show the sitting already docked, or start one. */
    private async openCardsTab(): Promise<void> {
        const sitting = this.plugin.deckSessionController;
        if (!sitting) return;
        // A sitting this dock is already showing is brought forward, not started
        // again: where the reader is in the queue is theirs to keep.
        if (sitting.isActive() && (this.dock?.hasCardSitting() ?? false)) {
            this.dock?.showCards();
            return;
        }
        // A sitting running somewhere else (a window, a pane) is not this tab's
        // to show: it is started here, which moves it into the dock.
        await sitting.startAllDue();
    }

    /**
     * The run is standing on the card lane's step: the cards, now.
     *
     * Reaching the step is what shows them — the run's own Next, a grade that
     * emptied the note queue, or the Cards control — and they open in the dock
     * the reader is already looking at, never in a window over the note. One
     * ask at a time: a step that is redrawn (a tab click, a layout change) must
     * not start a second sitting over the first.
     */
    private ensureCardsStep(): void {
        if (!this.dock) return;
        const sitting = this.plugin.deckSessionController;
        if (!sitting) return;
        // A step that names a deck sits that deck: the reader reached it by
        // walking the queue, so it is the deck the bar says they are on.
        const step = this.model.currentPath();
        const deck = step ? cardStepDeck(step) : null;
        if (this.dock.hasCardSitting()) {
            const current = sitting.currentDeckPath?.() ?? null;
            // The same deck (or a sitting that cannot name one) is brought
            // forward. A *different* deck means the run has walked on: the
            // sitting switches, and the page with it, instead of the first
            // deck's cards sitting there under a bar that has moved.
            if (!deck || current === null || current === deck) {
                this.dock.showCards();
                return;
            }
        }
        if (this.cardsStepStarting) return;
        this.cardsStepStarting = true;
        const settle = (): void => { this.cardsStepStarting = false; };
        if (deck) {
            // A sitting already running walks over to the deck the bar is on:
            // switching keeps its place and its answers, starting would not.
            const move = sitting.isActive() ? sitting.switchDeck(deck) : sitting.start(deck);
            void move.then(settle, settle);
            return;
        }
        void this.openCardsTab().then(settle, settle);
    }

    /**
     * What the decks are holding right now: one step per deck with cards due.
     *
     * The deck type is the step, not the answer — a sitting the reader cannot
     * navigate through deck by deck is not one sitting. The list comes from the
     * sidebar's own fresh count, so the bar and the row cannot disagree about
     * which decks are waiting. No deck lane, or no decks, means the run walks
     * notes alone and its counter counts notes alone.
     */
    private liveCardSteps(): string[] {
        if (!this.plugin.deckSessionController) return [];
        // One step per deck holding due cards — the deck types the sitting will
        // hand over, not one step per answer. A list nobody refreshed in the
        // last minute still stands: the run must count the decks the reader is
        // about to sit, not read them as empty.
        return this.plugin.knownDeckDueDecks().map(deckStepId);
    }

    /** The deck's own name for the sitting, when it has one to give. */
    private deckSittingName(): string | null {
        const sitting = this.plugin.deckSessionController as unknown as {
            summary?: () => { deckName?: string } | null;
        } | null;
        const summary = typeof sitting?.summary === 'function' ? sitting.summary() : null;
        const name = summary?.deckName;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }

    /**
     * The card sitting's own count, remembered while it is on screen.
     *
     * A sitting that covers several decks at once (Anki's parent-deck
     * behaviour) has walked every deck's step when it ends, and one that sat a
     * single deck has walked only its own. The sitting cannot be asked after it
     * is gone, so its size is read while it is here.
     */
    private sittingDecks = 1;

    /**
     * Keep the run's card steps true to what is on screen.
     *
     * While the reader stands on the cards, their sitting *is* the step: it is
     * under way, and nothing about the other decks' steps is settled by it. The
     * moment the sitting is gone — finished, ended, closed — the step it was
     * showing is over, and the run walks on by exactly that one step. A sitting
     * that has not been on screen yet is not "gone": nothing settles until it
     * has been.
     *
     * Marking the *whole* series spent here is what the reader hit as a stuck
     * counter: one deck's sitting ended and every deck's step turned handled, so
     * the tally ran ahead of the walk, the bar's number stood at the end of the
     * run while the reader stood at its start, and neither Previous nor Next
     * moved it.
     */
    private settleCardSteps(): void {
        if (!this.model.onCardStep()) return;
        const sitting = this.plugin.deckSessionController;
        const live = sitting?.isActive() ?? false;
        const docked = this.dock?.hasCardSitting() ?? false;
        if (live || docked) {
            // The sitting is on screen: the step is under way, and the cards it
            // has answered count as this step's work — not as the other decks'
            // steps being walked. (A sitting can be live and docked while it is
            // still being handed over — that is not an ending.)
            this.cardsStepSeen = true;
            this.sittingDecks = this.rememberedSittingDecks();
            return;
        }
        // Nothing on screen: either a sitting is still being asked for, or one
        // has never been here. Neither is "the cards are over".
        if (this.cardsStepStarting || !this.cardsStepSeen) return;
        this.cardsStepSeen = false;
        const decks = this.sittingDecks;
        this.sittingDecks = 1;
        // A sitting that held every deck's cards at once walked every deck's
        // step: there is nothing left to walk to, so the series is over.
        if (decks > 1) this.model.completeCardSteps();
        // `advance()` spends the step the cursor is on and moves to the next
        // one — the one step an ended sitting is worth.
        this.model.advance();
        this.model.sync(this.duePaths(), this.liveCardSteps());
    }

    /** How many decks the live sitting is holding, if it can say. */
    private rememberedSittingDecks(): number {
        const sitting = this.plugin.deckSessionController as unknown as {
            summary?: () => { deckCount?: number } | null;
        } | null;
        const summary = typeof sitting?.summary === 'function' ? sitting.summary() : null;
        const count = summary?.deckCount;
        return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.round(count) : 1;
    }

    /** Grade using one of the four coarse buckets (used by the bindable commands). */
    async gradeBucket(bucket: GradeBucket): Promise<void> {
        if (this.model.phase !== 'reviewing') {
            new Notice('No review session running. Start one first.');
            return;
        }
        const path = this.model.currentPath();
        await this.grade(bucketResponse(bucket, this.algorithmFor(path)));
    }

    /** Would this note still be in today's queue? */
    private isStillDueToday(schedule: ReviewSchedule | undefined): boolean {
        if (!schedule) return false;
        const reviewDate = this.plugin.reviewController.getCurrentReviewDateOverride?.() ?? Date.now();
        return schedule.nextReviewDate <= DateUtils.endOfUTCDay(new Date(reviewDate));
    }

    /** Move on without recording anything (the note stays due, like a bury). */
    async skip(): Promise<void> {
        if (this.busy || !this.model.isRunning()) return;
        if (this.decisionHoldsStep()) return;
        this.model.advance();
        await this.gotoCurrent();
    }

    /** Push the current note a day out. */
    async postponeCurrent(): Promise<void> {
        if (this.busy || this.model.phase !== 'reviewing') return;
        const path = this.model.currentPath();
        // A card step is not a note: there is nothing to postpone, and the
        // sitting in the dock owns the card that is on screen.
        if (!path || this.model.isCardStep(path)) return;

        this.busy = true;
        try {
            this.model.clearUndo();
            await this.plugin.reviewController.postponeNote(path, 1);
            this.model.advance();
            await this.gotoCurrent();
        } finally {
            this.busy = false;
        }
    }

    /** Revert the last grade, restore the note's schedule and return to it. */
    async undo(): Promise<void> {
        if (this.busy) return;
        const record = this.model.undoTo();
        if (!record) {
            new Notice('Nothing to undo.');
            return;
        }

        const service = this.plugin.reviewScheduleService;
        service.restoreSnapshot(record);

        await this.plugin.savePluginData();
        this.plugin.reviewController.updateTodayNotes(true);
        this.model.sync(this.duePaths(), this.liveCardSteps());
        await this.gotoCurrent();
        void this.plugin.getSidebarView()?.refresh();
        new Notice('Last rating reverted.');
    }

    /** Apply the user's choice for a note that keeps failing. */
    async resolveDecision(action: 'reset' | 'postpone' | 'remove' | 'keep'): Promise<void> {
        const pending = this.model.pendingDecision;
        if (!pending || this.busy) return;

        this.busy = true;
        try {
            this.plugin.reviewScheduleService.resolveLeech(pending.path, action);
            await this.plugin.savePluginData();
            this.plugin.reviewController.updateTodayNotes(true);
            // A failed note that the user chose to carry on with is still due today,
            // so it stays in the run and comes back later in the same session.
            this.model.advance({ keepInRun: this.requeueAfterDecision });
            this.requeueAfterDecision = false;
            this.model.sync(this.duePaths(), this.liveCardSteps());
            await this.gotoCurrent();
            void this.plugin.getSidebarView()?.refresh();
        } finally {
            this.busy = false;
        }
    }

    /**
     * Called when a grade came from somewhere else (the MCQ flow) while a run is
     * active: keep the run going instead of throwing a modal on top of the note.
     */
    async afterExternalReview(result: ReviewRecordResult): Promise<void> {
        if (!this.model.isActive() || this.busy) return;
        this.busy = true;
        try {
            this.model.clearUndo();
            const path = this.model.currentPath();
            this.model.advance({
                keepInRun: path ? this.isStillDueToday(this.plugin.reviewScheduleService.schedules[path]) : false,
            });
            this.model.sync(this.duePaths(), this.liveCardSteps());
            if (result.nextPathSource === 'session' && result.nextPath) {
                this.model.focus(result.nextPath);
            }
            await this.gotoCurrent();
        } finally {
            this.busy = false;
        }
    }

    private async testWithMCQs(): Promise<void> {
        const path = this.model.currentPath();
        if (!path || this.model.isCardStep(path)) return;
        const controller = this.plugin.mcqController;
        if (!controller) {
            new Notice('Questions feature is not available.');
            return;
        }
        // Questions are sat under the note like study mode: the dock owns
        // generation, the sitting and the grade that follows it.
        if (this.dock) {
            this.dock.openTab('mcq');
            return;
        }
        await controller.startMCQReview(path);
    }

    private async regenerateMCQs(): Promise<void> {
        const path = this.model.currentPath();
        if (!path || this.model.isCardStep(path)) return;
        const controller = this.plugin.mcqController;
        if (!controller) {
            new Notice('Questions feature is not available.');
            return;
        }
        new Notice('Generating new questions…');
        const success = await controller.generateMCQs(path, true);
        if (success) {
            await controller.startMCQReview(path);
        } else {
            new Notice('Could not generate new questions.');
        }
    }

    private async removeCurrentFromSchedule(): Promise<void> {
        const path = this.model.currentPath();
        if (!path || this.model.isCardStep(path)) return;
        this.plugin.reviewScheduleService.removeFromReview(path);
        await this.plugin.savePluginData();
        this.plugin.reviewController.updateTodayNotes(true);
        this.model.advance();
        this.model.sync(this.duePaths(), this.liveCardSteps());
        await this.gotoCurrent();
        void this.plugin.getSidebarView()?.refresh();
    }

    /**
     * Save where the run is, so it survives the pane, the tab and the app.
     *
     * Called after every render — the one place the run's state has just
     * settled — and only written when something actually changed, because a
     * render happens for every step of a sitting.
     */
    private persistRun(): void {
        // Only a run that is walking is worth coming back to: a finished one has
        // nothing left, and 'inactive' means nobody is sitting.
        if (!this.model.isRunning()) return;
        const snapshot = this.model.snapshot();
        const serialised = JSON.stringify(snapshot);
        if (serialised === this.lastSavedRun) return;
        this.lastSavedRun = serialised;
        // A stand-in shell (the test harness) has no data store: a run is saved
        // where there is one, and nowhere else.
        const state = this.plugin.pluginState;
        if (!state) return;
        state.noteRun = { ...snapshot, savedAt: Date.now() };
        void this.plugin.savePluginData();
    }

    /** Forget a finished (or unusable) run, so the next start is a fresh one. */
    /**
     * Move the list's pin to the run's position. Cheap and idempotent: the rows
     * wear one class, and the row the bar is standing on is the one that has it.
     */
    private syncRunPositionMarker(): void {
        // The pin is a decoration, and a decoration must never break a run: a
        // stand-in document (the test harness) has no query at all.
        if (typeof document === 'undefined' || !document.body || typeof document.body.findAll !== 'function') return;
        const current = this.model.isActive() ? this.model.currentPath() : null;
        // Renders are frequent and the position rarely moves: only walk the DOM
        // when the note the bar names has actually changed. The list's own
        // render re-applies the pin to rows it has just rebuilt.
        if (current === this.lastMarkedPath) return;
        this.lastMarkedPath = current;
        for (const row of document.body.findAll('.review-note-item[data-note-path]')) {
            row.toggleClass('is-run-current', current !== null && row.dataset.notePath === current);
        }
    }

    private clearSavedRun(): void {
        this.lastSavedRun = null;
        const state = this.plugin.pluginState;
        if (state?.noteRun) {
            state.noteRun = null;
            void this.plugin.savePluginData();
        }
    }

    /**
     * Pick up the saved run where it stopped.
     *
     * Anything the save names that is no longer in the vault is dropped on the
     * way in; a save with nothing left in it is cleared, never allowed to stop
     * a run from starting.
     */
    private resumeSavedRun(): boolean {
        const saved = this.plugin.pluginState?.noteRun ?? null;
        if (!saved || !Array.isArray(saved.order) || saved.order.length === 0) return false;

        // A card step in the save is still a step of the run: it names no file,
        // and it is not dropped on the way in the way a deleted note is.
        const live = saved.order.filter(step =>
            isCardsStep(step) || this.plugin.app.vault.getAbstractFileByPath(step) !== null);
        if (live.length === 0) {
            this.clearSavedRun();
            return false;
        }

        try {
            if (!this.model.restore({ order: live, cursor: saved.cursor, handled: saved.handled })) {
                this.clearSavedRun();
                return false;
            }
            this.cardsStepSeen = false;
            this.cardsStepStarting = false;
            this.installKeyHandler();
            this.strip.setMcqAvailable(this.plugin.settings.enableMCQ && !!this.plugin.mcqController);
            void this.gotoCurrent();
            return true;
        } catch (error) {
            console.error('spaceforge: could not resume the saved review run', error);
            this.clearSavedRun();
            return false;
        }
    }

    private async gotoCurrent(): Promise<void> {
        const path = this.model.currentPath();
        // A card step is not a note: nothing is opened as a file for it — the
        // sitting it stands for is what goes on screen, and render() is what
        // puts it there.
        const onCards = this.model.isCardStep(path);
        if (this.model.phase !== 'finished' && path && !onCards) {
            await this.openNoteInLeaf(path);
        } else if (onCards && this.model.isRunning() && !this.strip.isMounted()) {
            // The bar is mounted by the note path, and a card step has no note:
            // a run that resumes onto the cards, or steps onto them with no
            // note pane of its own, still has to be on screen — an unmounted
            // bar with a live sitting behind it is a session nobody can see.
            this.mountStrip();
        }
        // A step onto a note from the cards hands the dock back to the note's
        // own panel: the sitting stays mounted and hidden, where the reader
        // left it, and comes back with the step that shows it.
        if (!onCards) this.dock?.showNote();
        this.render();
    }

    private async openNoteInLeaf(path: string): Promise<void> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice(`Note not found: ${path}`);
            this.model.advance();
            return;
        }
        const leaf = this.resolveLeaf();
        await leaf.openFile(file);
        this.leaf = leaf;
        this.mountStrip();
    }

    private resolveLeaf(): WorkspaceLeaf {
        // Only a markdown leaf can hold the note. A session leaf left as
        // `this.leaf` (a split or a window) would otherwise be replaced by the
        // note on the next item, tearing the session down with it.
        if (this.leaf
            && this.leaf.view?.containerEl?.isConnected
            && this.leaf.view?.getViewType?.() === 'markdown') {
            return this.leaf;
        }
        // With the session in a window or the sidebar, the note stays in the pane
        // the reader is working in; the popout placement is about the note itself.
        if (this.host === 'note' && this.plugin.settings.reviewSessionPlacement === 'window') {
            return this.resolvePopoutLeaf();
        }
        return this.plugin.app.workspace.getLeaf();
    }

    /**
     * A leaf in a window of its own, reused for the whole session.
     *
     * Split panes are fine until you want the questions somewhere else: on a
     * second monitor, or on top of the app while you take notes. A window also
     * leaves the pane you were working in untouched.
     */
    private resolvePopoutLeaf(): WorkspaceLeaf {
        if (this.popoutLeaf && this.popoutLeaf.view?.containerEl?.isConnected) return this.popoutLeaf;
        this.popoutLeaf = this.plugin.app.workspace.openPopoutLeaf();
        return this.popoutLeaf;
    }

    /**
     * Remove session markup left behind by a previous plugin instance.
     *
     * Runs once, on load, while nothing of ours is mounted: every match is a
     * leftover then — a second bar, a second dock or a second card sitting on
     * screen when the reader asked for one. It must not run at any other time:
     * a live bar, dock, panel or card sitting wears exactly the same classes as
     * a stale copy and cannot be told from one, and sweeping on a mount is what
     * deleted a live sitting mid-card — measured in the app, a layout change
     * took `.sf-deck` from 1 to 0 and it never came back. A leftover adopted by
     * the next mount costs a reader a duplicate; deleting a live sitting costs
     * them the card they were answering, so when ownership cannot be told,
     * nothing is removed.
     */
    private clearStaleSurfaces(): void {
        if (typeof document === 'undefined' || !document.body || typeof document.body.findAll !== 'function') return;
        // Proof that the sweep is safe: nothing of ours exists yet. The bar has
        // no element, and the dock and the host marker are only ever set by a
        // mount — so if any of them is present, this is not the load path and
        // the sweep is refused rather than risking a live surface.
        if (this.dock !== null || this.strip.getElement() !== null || this.hostClassEl !== null) return;
        for (const selector of ['.sf-strip', '.sf-dock', '.sf-deck', '.modal.sf-deck-modal-host']) {
            for (const stale of document.body.findAll(selector)) stale.remove();
        }
    }

    private mountStrip(): void {
        if (!this.model.isActive()) return;
        // A remembered split whose leaf was closed comes back beside the note
        // it is about to show, not beside whichever leaf happened to be active
        // when the app loaded.
        if (this.host === 'split' && !this.splitView()?.containerEl?.isConnected) void this.openSessionSplit();
        const container = this.resolveSessionContainer();
        if (!container) {
            // The pane is gone (or was never a note's): the bar is taken down
            // rather than left inside a leaf the app has abandoned, and the
            // note is walked back to, once. Grading by keyboard keeps working
            // while that runs — and if the note is gone too, unmounted is the
            // clean state.
            this.recoverVisibleHost();
            return;
        }
        this.strip.mountInto(container);
        this.applyHostClass(container);
        // Study and questions live under the bar too, so the note stays
        // readable while the tutor asks about it.
        const wantsDock = this.plugin.studyController
            && (this.plugin.settings.studyEnabled || (this.plugin.settings.enableMCQ && !!this.plugin.mcqController));
        if (wantsDock) {
            this.dock ??= new ReviewDock(this.plugin, this.plugin.studyController, {
                onSuggestion: (suggestion) => this.acceptSuggestion(suggestion),
                onTabs: () => this.render(),
                cardsReached: () => this.cardsStepReached,
            });
            this.dock.mountInto(container);
        }
    }

    private duePaths(): string[] {
        return this.plugin.reviewController.getTodayNotes().map(note => note.path);
    }

    /**
     * Keep the core's own list index on the note the run is on.
     *
     * That index is the *fallback's* idea of where the reader is: it drives the
     * due-list walk and the list's "Review current note". Leaving a run, or
     * naming the current note from that menu, must not send the reader
     * somewhere the run was not — a second position would be exactly the
     * separation this run exists to avoid. It is derived here and never stored:
     * the cursor is the state, this is a copy of it, so the two cannot drift.
     */
    private syncFallbackIndex(): void {
        const path = this.model.currentPath();
        if (!path) return;
        const index = this.duePaths().indexOf(path);
        // A note the due list does not carry (a session file) has no index to
        // copy onto, and the walk's own place in the list is left alone.
        if (index >= 0) this.plugin.reviewController.setCurrentNoteIndex(index);
    }

    private algorithmFor(path: string | null): ReviewAlgorithm {
        if (path) {
            const schedule = this.plugin.reviewScheduleService.schedules[path];
            if (schedule) return schedule.schedulingAlgorithm;
        }
        return this.plugin.settings.defaultSchedulingAlgorithm;
    }

    private render(): void {
        // Where the run is, saved as it moves: the pane, the tab and the app
        // itself may go at any moment, and a sitting is not something to redo.
        this.persistRun();
        // One position, shown everywhere: the list's pin moves with the run, so
        // a step in the dock is a step in the list — never two maps.
        this.syncRunPositionMarker();
        this.syncFallbackIndex();
        // A step of the run can be the cards rather than a note, and a sitting
        // that is over settles the steps it was made of before anything reads
        // the run's position.
        this.settleCardSteps();
        const now = this.plugin.reviewController.getCurrentReviewDateOverride() ?? Date.now();
        const base = this.model.position();
        // The reader's place in the queue, which the model's tally does not
        // carry: the bar's number and its bar both read this, so navigation and
        // the readout can never disagree. `place` is the number itself — one
        // step at a time, capped at the run's size (see ReviewFlowModel.place).
        const position = {
            handled: base.handled,
            remaining: base.remaining,
            total: base.total,
            index: this.model.cursorIndex(),
            place: this.model.place(),
        };
        const queue = this.model.composition();
        const path = this.model.currentPath();
        const phase = this.model.phase;

        if (phase !== 'finished' && path && this.model.isCardStep(path)) {
            this.renderCardsStep(position, queue);
            return;
        }

        if (phase === 'finished' || !path) {
            // The notes are done. If the decks are holding anything, the sitting
            // opens by itself in the dock: the end of one lane is the start of the
            // other, and a "session complete" screen the reader then has to leave
            // is a dead end dressed as an ending.
            const next = this.nextStep();
            if (next && !this.handedOver && this.dock && !this.dock.hasCardSitting()) {
                this.handedOver = true;
                void this.openCardsTab();
            }
            this.strip.render({
                phase: 'finished',
                title: 'Session complete',
                meta: '',
                dueLabel: '',
                position,
                queue,
                algorithm: this.plugin.settings.defaultSchedulingAlgorithm,
                grades: [],
                decision: null,
                // The queue is empty: this is the one moment the day's other
                // half should be offered, and this is the branch it is offered in.
                nextStep: next,
                // The bar keeps its row after the last note: the cards tab lives
                // there, and it is the next thing to press.
                tabs: this.dock?.tabState() ?? undefined,
                canUndo: this.model.undoAvailable(),
                hint: '',
            });
            return;
        }

        const algorithm = this.algorithmFor(path);
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        const title = file instanceof TFile ? file.basename : path;

        const plainKeysEnabled = this.plugin.settings.reviewStripGradeKeys;
        const grades: StripGradeButton[] = gradeOptionsFor(algorithm).map(option => {
            const preview = this.plugin.settings.reviewStripIntervalPreviews && schedule
                ? this.plugin.reviewScheduleService.previewReview(path, option.response, now,
                    algorithm === 'fsrs' ? 'fsrs' : 'auto')
                : null;
            return {
                response: option.response,
                label: option.label,
                key: gradeKeyLabel(option.key, plainKeysEnabled),
                variant: option.variant,
                intervalText: preview
                    ? formatScheduledInterval(preview.interval, preview.nextReviewDate, now)
                    : null,
            };
        });

        const state: StripState = {
            phase: phase === 'decision' ? 'decision' : 'reviewing',
            title,
            meta: this.describeSchedule(schedule, algorithm),
            dueLabel: schedule ? formatDueLabel(schedule.nextReviewDate, now) : '',
            position,
            queue,
            algorithm,
            grades,
            gradeLayout: this.plugin.settings.reviewGradeLayout,
            decision: this.model.pendingDecision
                ? {
                    message: leechPromptText(title, this.model.pendingDecision.lapses, this.model.pendingDecision.threshold),
                    choices: leechChoices(),
                }
                : null,
            canUndo: this.model.undoAvailable(),
            hint: this.lastWasEditable ? EDITING_HINT : hotkeyHint(algorithm, plainKeysEnabled),
            tabs: this.dock?.tabState() ?? undefined,
            nextStep: this.nextStep(),
            suggestion: this.dockSuggestion,
        };

        this.strip.render(state);
        this.dock?.setPath(this.model.currentPath());
    }

    /**
     * The run is standing on the card lane's step.
     *
     * The cards are steps of the sitting, not a tab beside it: the step shows
     * the sitting in the dock — now, without being asked — and the bar carries
     * the step's place in the run where the note's grades would be. There is no
     * note behind this step, so nothing of one is drawn: no grade row, no
     * scheduler line, and the dock's own note panels are left as they are until
     * the run walks back onto a note.
     */
    /** True once the run has stood on one of the decks' steps. */
    hasReachedCardsStep(): boolean {
        return this.cardsStepReached;
    }

    private renderCardsStep(
        position: { handled: number; remaining: number; total: number; index?: number; place?: number },
        queue: { notes: number; cards: number },
    ): void {
        this.cardsStepReached = true;
        // A deck step is not a note: the dock is told so before the bar is drawn,
        // so its tab row is the cards' alone while the run stands here.
        this.dock?.setPath(null);
        this.ensureCardsStep();
        const deckName = this.deckSittingName();
        this.strip.render({
            phase: 'cards',
            title: 'Cards',
            meta: '',
            dueLabel: '',
            position,
            queue,
            algorithm: this.plugin.settings.defaultSchedulingAlgorithm,
            grades: [],
            decision: null,
            cardsStep: {
                label: 'Cards',
                detail: deckName ? `sitting ${deckName}` : 'sitting below',
            },
            // The run's card steps are the day's other half, on screen: there is
            // nothing left to hand over, so no hand-off is offered here.
            nextStep: null,
            tabs: this.dock?.tabState() ?? undefined,
            canUndo: this.model.undoAvailable(),
            hint: '',
        });
    }

    /**
     * The dock's card slot, given back by the sitting that was using it.
     *
     * Deck-side code calls this when a sitting ends by itself; nothing else
     * knows the panel is free again.
     */
    cardSittingEnded(): void {
        this.dock?.cardsEnded();
    }

    /**
     * What to do when the note queue is done.
     *
     * The two lanes are one habit: when the notes run out, the decks are the next
     * thing, and one press here starts that sitting in the dock the reader is
     * already looking at. Nothing is offered while notes remain — the run is not
     * over yet — and a count nobody has refreshed recently is not offered either.
     *
     * A run whose queue already carried the cards' steps has been to the decks
     * and back: offering the same cards again would be a second sitting for
     * them, so there is nothing to hand over.
     */
    private nextStep(): { label: string; title: string } | null {
        if (!this.plugin.deckSessionController) return null;
        if (this.model.phase !== 'finished') return null;
        if (this.model.cardStepCount() > 0) return null;
        const due = this.plugin.freshDeckDue();
        if (due <= 0) return null;
        return {
            label: `Study ${due} card${due === 1 ? '' : 's'}`,
            title: `${due} card${due === 1 ? '' : 's'} waiting in your decks · opens the sitting under the bar`,
        };
    }

    /**
     * A sitting finished and left a grade behind. By default it is offered: the
     * bar marks the grade the score implies, with the percentage in that button,
     * and nothing is recorded until the learner presses it. The one exception is
     * the opt-in setting that applies the score-derived grade by itself.
     */
    private acceptSuggestion(suggestion: DockSuggestion | null): void {
        const autoApply = suggestion !== null && this.plugin.settings.mcqGradingMode === 'score';
        if (autoApply) {
            this.dockSuggestion = null;
            this.dock?.clearSuggestion();
            void this.grade(suggestion.rating);
            return;
        }
        this.dockSuggestion = suggestion;
        this.render();
    }

    private describeSchedule(schedule: ReviewSchedule | undefined, algorithm: ReviewAlgorithm): string {
        const label = algorithm === 'fsrs' ? FSRS : SM2;
        if (!schedule) return label;
        if (algorithm === 'fsrs' && schedule.fsrsData) {
            const state = FsrsStateName(schedule.fsrsData.state);
            return `${label} · ${state} · stability ${schedule.fsrsData.stability.toFixed(1)} · difficulty ${schedule.fsrsData.difficulty.toFixed(1)}`;
        }
        const interval = schedule.interval ?? 0;
        const ease = ((schedule.ease ?? this.plugin.settings.baseEase) / 100).toFixed(2);
        return `${label} · interval ${interval}d · ease ${ease}`;
    }

    /** Keyboard: grade, skip, undo, postpone, end — never while typing. */
    private installKeyHandler(): void {
        if (this.keyHandler) return;
        this.keyHandler = (event: KeyboardEvent) => this.handleKey(event);
        document.addEventListener('keydown', this.keyHandler, true);
    }

    private removeKeyHandler(): void {
        if (!this.keyHandler) return;
        document.removeEventListener('keydown', this.keyHandler, true);
        this.keyHandler = null;
    }

    private handleKey(event: KeyboardEvent): void {
        if (!this.model.isActive()) return;
        const path = this.model.currentPath();
        const editable = this.isEditableTarget(event.target);
        this.lastWasEditable = editable;

        // A card sitting that is docked but not on screen still listens on the
        // document, so its keys are taken off it here: nobody can answer a card
        // they cannot see. Escape stays live — that one is the review's.
        if (event.key !== 'Escape' && !editable && !this.isOverlayOpen() && this.dock?.isCardSittingHidden()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }

        const action = resolveHotkey(
            {
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                repeat: event.repeat,
            },
            {
                active: true,
                phase: this.model.phase,
                algorithm: this.algorithmFor(path),
                editableTarget: editable,
                overlayOpen: this.isOverlayOpen(),
                // A deck card on screen is a question too: the bar's grading
                // digits belong to it then, exactly as they do to a note's MCQ.
                questionOpen: (this.dock?.isAnswering() ?? false) || (this.plugin.deckSessionController?.isActive() ?? false),
                plainKeysEnabled: this.plugin.settings.reviewStripGradeKeys,
            }
        );

        if (!action) return;
        event.preventDefault();
        event.stopPropagation();

        switch (action.type) {
            case 'grade':
                void this.grade(action.response);
                break;
            case 'next':
                void this.stepForward();
                break;
            case 'previous':
                void this.stepBack();
                break;
            case 'skip':
                void this.skip();
                break;
            case 'undo':
                void this.undo();
                break;
            case 'postpone':
                void this.postponeCurrent();
                break;
            case 'end':
                this.end();
                break;
            case 'hint':
                new Notice(`${HOTKEY_HINT}. ${EDITING_HINT}.`);
                break;
        }
    }

    /** True when the keystroke would land in a text field or the editor. */
    private isEditableTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) return false;
        if (target.isContentEditable) return true;
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        return target.closest('[contenteditable="true"], .cm-editor, .modal, .prompt') !== null;
    }

    /** Modals, menus and suggestion popups own the keyboard while they are up. */
    private isOverlayOpen(): boolean {
        return document.body.querySelector('.modal-container, .menu, .suggestion-container') !== null;
    }
}

function FsrsStateName(state: number): string {
    switch (state) {
        case 0: return 'new';
        case 1: return 'learning';
        case 2: return 'review';
        case 3: return 'relearning';
        default: return 'review';
    }
}
