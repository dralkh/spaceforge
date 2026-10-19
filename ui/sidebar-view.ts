import { ItemView, Notice, WorkspaceLeaf, Setting, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { PomodoroUIManager } from "./sidebar/pomodoro-ui-manager";
import { NoteItemRenderer } from "./sidebar/note-item-renderer";
import { ListViewRenderer } from "./sidebar/list-view-renderer"; // Import ListViewRenderer
import { ReviewSchedule } from "../models/review-schedule";
import { DateUtils } from "../utils/dates";

import { CalendarView } from "./calendar-view";

/**
 * Represents the state of the ReviewSidebarView.
 */
interface ReviewSidebarViewState {
    activeListBaseDateISO?: string | null;
    // isPomodoroSectionOpen?: boolean; // Removed as Pomodoro section is always "open"
    expandedUpcomingDayKey?: string | null;
    selectedNotes?: string[];
    lastScrollPosition?: number;
    sidebarViewType?: 'list' | 'calendar' | 'review';
}

/** The pane this sidebar is showing: the list, the calendar, or the session. */
type SidebarPaneMode = 'list' | 'calendar' | 'review';

/** How often the list asks the run where it is, while a run is walking. */
const RUN_FOLLOW_MS = 400;

/**
 * Sidebar view for displaying review schedules. Acts as an orchestrator for sub-components.
 */
export class ReviewSidebarView extends ItemView {
    plugin: SpaceforgePlugin;
    public activeListBaseDate: Date | null = null;
    selectedNotes: string[] = [];
    private lastSelectedNotePath: string | null = null;
    private lastScrollPosition = 0;
    private expandedUpcomingDayKey: string | null = null; // State for upcoming section
    private resizeObserver: ResizeObserver | null = null;
    private refreshPromise: Promise<void> | null = null;
    private refreshQueued = false;
    /** The run's position as last painted; the tick compares against it. */
    private lastRunSignature: string | null = null;
    /** The follow tick, up only while the list is the pane and a run walks. */
    private runFollowTimer: number | null = null;
    private readonly onSidebarUpdate = () => { void this.refresh(); };
    private readonly onPomodoroUpdate = () => {
        if (this.pomodoroUIManager) {
            this.pomodoroUIManager.updatePomodoroUI();
        }
    };

    // Sub-components for rendering different parts
    private pomodoroUIManager: PomodoroUIManager;
    private noteItemRenderer: NoteItemRenderer;
    private listViewRenderer: ListViewRenderer | null = null; // Initialize as null
    calendarView: CalendarView;

    // Persistent UI elements
    private mainContainer: HTMLElement | null = null;
    private persistentHeaderEl: HTMLElement | null = null;
    private listViewContentEl: HTMLElement | null = null;
    private calendarViewContentEl: HTMLElement | null = null;
    /** The review tab: a mount point, created once, for the session's own DOM. */
    private reviewViewContentEl: HTMLElement | null = null;
    /** Whether this view has already handed its container to the session. */
    private claimedReviewTab = false;

    constructor(leaf: WorkspaceLeaf, plugin: SpaceforgePlugin) {
        super(leaf);
        this.plugin = plugin;
        this.noteItemRenderer = new NoteItemRenderer(this.plugin);
        // PomodoroUIManager and ListViewRenderer are initialized in ensureBaseStructure
    }

    getViewType(): string { return "spaceforge-review-schedule"; }
    getDisplayText(): string { return "Spaceforge review"; }
    getIcon(): string { return "calendar-clock"; }

    /**
     * True only while the review pane is the pane this sidebar is really showing.
     *
     * This is the one honest answer to "is the session's home on screen?": the
     * mode says which pane the reader chose, and the container's own state says
     * whether this view is showing it. The two disagree more often than the tab
     * buttons suggest — the mode is remembered across restarts, and it is
     * written from elsewhere (a date picked in the calendar, a setting, the
     * bar's menu) — so the review flow asks this instead of reading the setting
     * and assuming the pane followed.
     */
    isReviewPaneVisible(): boolean {
        if (this.plugin.settings.sidebarViewType !== 'review') return false;
        const container = this.reviewViewContentEl;
        if (!container) return false;
        return container.isConnected && !container.hasClass('sf-hidden');
    }

    async onOpen(): Promise<void> {
        this.plugin.events.on('sidebar-update', this.onSidebarUpdate);
        this.plugin.events.on('pomodoro-update', this.onPomodoroUpdate);

        // Ensure structure and render on first open
        await this.refresh();
    }

    onClose(): Promise<void> {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.stopRunFollow();
        this.plugin.events.off('sidebar-update', this.onSidebarUpdate);
        this.plugin.events.off('pomodoro-update', this.onPomodoroUpdate);
        // Closing the pane must not strand the session inside an element the
        // app is about to discard: the review tab hands it back, exactly as
        // leaving the tab by hand does. Unconditional on purpose — the mode can
        // name another pane while this one is still holding a live session (a
        // mode written from outside the view), and only the view's own record
        // of where the session went can settle that.
        this.leaveReviewTab();
        // The calendar half of this view holds a tooltip and a pending timer of
        // its own; closing the pane has to take them down with it.
        this.calendarView?.destroy();
        return Promise.resolve();
    }

    private ensureBaseStructure(): void {
        const contentEl = this.containerEl;
        if (!contentEl) return;

        if (!this.mainContainer) {
            contentEl.empty();
            this.mainContainer = contentEl.createDiv("spaceforge-container");
        }

        if (!this.persistentHeaderEl) {
            this.persistentHeaderEl = this.mainContainer.createDiv("review-header");
            new Setting(this.persistentHeaderEl).setHeading().setName("Review schedule");
            // The toggle and the statistics button share one row: the toggle
            // takes the width, the button keeps its own small square.
            const headerRow = this.persistentHeaderEl.createDiv("review-header-row");
            const viewToggle = headerRow.createDiv("review-view-toggle");

            const listViewBtn = viewToggle.createDiv("review-view-btn");
            listViewBtn.setText("List");
            listViewBtn.addEventListener("click", () => {
                void this.switchMode('list');
            });

            const calendarViewBtn = viewToggle.createDiv("review-view-btn");
            calendarViewBtn.setText("Calendar");
            calendarViewBtn.addEventListener("click", () => {
                void this.switchMode('calendar');
            });

            // The third mode is a mount point for the live session rather than a
            // rendering of the schedule, but the reader chooses it exactly the
            // way they choose the other two.
            const reviewViewBtn = viewToggle.createDiv("review-view-btn");
            reviewViewBtn.setText("Review");
            reviewViewBtn.addEventListener("click", () => {
                void this.switchMode('review');
            });

            // The statistics page is a leaf of its own, not a fourth pane: the
            // charts need more width than this sidebar has.
            const statsBtn = headerRow.createDiv("review-stats-btn");
            setIcon(statsBtn, "trending-up");
            statsBtn.setAttribute("aria-label", "Statistics");
            statsBtn.setAttribute("title", "Statistics");
            statsBtn.addEventListener("click", () => {
                void this.plugin.openStatsView();
            });
        }
        this.updateViewToggleButtonsState();

        if (!this.listViewContentEl) {
            this.listViewContentEl = this.mainContainer.createDiv("list-view-content");
        }
        // Ensure managers are initialized *after* their container exists
        if (!this.pomodoroUIManager) {
            this.pomodoroUIManager = new PomodoroUIManager(this.plugin);
        }
        if (!this.listViewRenderer) {
            this.listViewRenderer = new ListViewRenderer(this.plugin, this.pomodoroUIManager, this.noteItemRenderer, {
                getActiveListBaseDate: () => this.activeListBaseDate,
                getSelectedNotes: () => this.selectedNotes,
                setSelectedNotes: (notes) => { this.selectedNotes = notes; },
                getExpandedUpcomingDayKey: () => this.expandedUpcomingDayKey,
                setExpandedUpcomingDayKey: (key) => { this.expandedUpcomingDayKey = key; },
                getLastSelectedNotePath: () => this.lastSelectedNotePath,
                setLastSelectedNotePath: (path) => { this.lastSelectedNotePath = path; },
                refreshSidebarView: async () => { await this.refresh(); }
            });
        }

        if (!this.reviewViewContentEl) {
            // Created once and never re-created: the session's live DOM — the
            // grading bar and the dock — is moved in here by the flow
            // controller, and it has to survive every refresh of this view.
            this.reviewViewContentEl = this.mainContainer.createDiv("sf-sidebar-review");
            this.reviewViewContentEl.addClass('sf-hidden');
        }

        if (!this.calendarViewContentEl) {
            this.calendarViewContentEl = this.mainContainer.createDiv("calendar-view-content");
        }
        // Ensure CalendarView is instantiated here, once, with the persistent container
        if (!this.calendarView && this.calendarViewContentEl) {
            this.calendarView = new CalendarView(this.calendarViewContentEl, this.plugin);
        }
    }

    private updateViewToggleButtonsState(): void {
        if (!this.persistentHeaderEl) return;
        const viewToggle = this.persistentHeaderEl.querySelector(".review-view-toggle");
        if (!viewToggle) return;
        const listViewBtn = viewToggle.children[0] as HTMLElement;
        const calendarViewBtn = viewToggle.children[1] as HTMLElement;
        const reviewViewBtn = viewToggle.children[2] as HTMLElement;
        if (listViewBtn) listViewBtn.classList.toggle("active", this.plugin.settings.sidebarViewType === 'list');
        if (calendarViewBtn) calendarViewBtn.classList.toggle("active", this.plugin.settings.sidebarViewType === 'calendar');
        if (reviewViewBtn) reviewViewBtn.classList.toggle("active", this.plugin.settings.sidebarViewType === 'review');
    }

    async refresh(): Promise<void> {
        // Coalesce concurrent refresh requests. Overlapping renders mutate shared
        // DOM containers and can transiently duplicate note items, so renders are
        // serialized here: while one is running, further requests are collapsed
        // into a single follow-up pass.
        if (this.refreshPromise) {
            this.refreshQueued = true;
            return this.refreshPromise;
        }

        const refreshPromise = (async () => {
            try {
                do {
                    this.refreshQueued = false;
                    await this._refreshView();
                } while (this.refreshQueued);
            } finally {
                this.refreshPromise = null;
            }
        })();
        this.refreshPromise = refreshPromise;

        return refreshPromise;
    }

    private async _refreshView(): Promise<void> {
        // Capture the state of activeListBaseDate *before* any potential changes in this refresh cycle.
        const previousActiveListBaseDateEpoch = this.activeListBaseDate ? DateUtils.startOfUTCDay(this.activeListBaseDate) : null;

        // Determine the target date for this refresh. It defaults to the current activeListBaseDate
        // unless a calendar click provides a new date.
        let newTargetDate: Date | null = this.activeListBaseDate;

        if (this.plugin.clickedDateFromCalendar) {
            newTargetDate = this.plugin.clickedDateFromCalendar;
            this.plugin.clickedDateFromCalendar = null; // Consume the calendar click event

            // If a date was clicked from the calendar, ensure the view switches to 'list' mode.
            if (this.plugin.settings.sidebarViewType !== 'list') {
                this.plugin.settings.sidebarViewType = 'list';
                await this.plugin.savePluginData(); // Persist the change in view type
            }
        }
        // Note: User clicks on "List" or "Calendar" view toggle buttons in the header
        // directly modify `this.plugin.settings.sidebarViewType` and (for "List") `this.activeListBaseDate`
        // *before* calling `this.refresh()`. So, `this.activeListBaseDate` will already reflect such changes here.

        // Calculate the epoch for the new target date. `null` signifies "today" (no specific override).
        const newTargetDateEpoch = newTargetDate ? DateUtils.startOfUTCDay(newTargetDate) : null;
        let reviewDateChanged = false;

        // If the effective date for the list view has changed, update the view's state.
        if (newTargetDateEpoch !== previousActiveListBaseDateEpoch) {
            this.activeListBaseDate = newTargetDate; // Update the sidebar's primary date state
            reviewDateChanged = true;
        }

        // Synchronize the ReviewController's date override with the sidebar's `activeListBaseDate`.
        // `this.activeListBaseDate` is now the definitive date context for the sidebar's list view.
        const currentControllerOverrideEpoch = this.plugin.reviewController.getCurrentReviewDateOverride();
        const targetControllerOverrideValue = this.activeListBaseDate ? DateUtils.startOfUTCDay(this.activeListBaseDate) : null;

        if (targetControllerOverrideValue !== currentControllerOverrideEpoch) {
            this.plugin.reviewController.setReviewDateOverride(targetControllerOverrideValue);
            // If the controller's date context was updated, it's a significant change
            // that warrants treating as `reviewDateChanged` for UI refresh purposes.
            if (!reviewDateChanged) {
                reviewDateChanged = true;
            }
        }
        // At this point:
        // - `this.activeListBaseDate` reflects the correct date for the view.
        // - `this.plugin.reviewController` is synchronized with this date.
        // - `reviewDateChanged` is true if the date context effectively changed.

        this.ensureBaseStructure(); // Ensures containers and managers are initialized

        let storedScrollPosition = this.lastScrollPosition; // Use the stored state
        if (this.mainContainer) {
            // Update storedScrollPosition if the container is currently scrolled
            storedScrollPosition = this.mainContainer.scrollTop;
        }

        this.updateViewToggleButtonsState();
        await this.showCorrectViewPane(); // Handles showing/hiding and rendering content

        // The list now wears the pin for the position it just painted; from
        // here the follow tick keeps it wearing the right one while the run
        // walks (a step of the run re-renders the bar, not this pane).
        this.lastRunSignature = this.runSignature();
        this.ensureRunFollow();

        // Apply scroll position *after* rendering is complete
        if (this.mainContainer) {
            window.requestAnimationFrame(() => {
                if (this.mainContainer) this.mainContainer.scrollTop = storedScrollPosition;
                this.lastScrollPosition = storedScrollPosition; // Update state after applying
            });
        }
    }

    /**
     * Where the run is standing, as one string: what the list's pin is painted
     * from. Null while no run is walking.
     *
     * A deck step names no note — `currentPath()` is null there by design — so
     * the deck case asks the question the list's own marker asks: which deck is
     * the sitting on. The sitting's deck is named late (the run starts it on
     * the way to the step), and an empty deck name is therefore a position too:
     * when the sitting lands, the string changes and the pin is repainted.
     */
    private runSignature(): string | null {
        const flow = this.plugin.reviewFlowController;
        if (!flow || !flow.isActive?.()) return null;
        if (flow.isOnCardsStep?.()) {
            return `cards:${this.plugin.deckSessionController?.currentDeckPath?.() ?? ''}`;
        }
        return `note:${flow.currentPath?.() ?? ''}`;
    }

    /**
     * Keep the list's pin following the run, from the moment the pane is up.
     *
     * A step of the run is not an event this pane can hear: it re-renders the
     * bar and opens the note, and the sidebar is never told about it — so the
     * note row's marker moves through the flow controller's own walk, and the
     * row of the deck a deck step stands on (which that walk does not know
     * about) would keep yesterday's paint until something else refreshed the
     * list. The tick this installs asks the run where it is, and repaints only
     * when the answer has changed since the last paint. It reads three
     * properties when it has nothing to do, runs for as long as the view does,
     * and gates itself: no run, or a pane that is not the list, is not news.
     */
    private ensureRunFollow(): void {
        if (this.runFollowTimer !== null) return;
        const handle = window.setInterval(() => this.followRun(), RUN_FOLLOW_MS);
        // A number in the app; a Timeout in a test runner, which must not hold
        // the process open after its tests are done.
        (handle as unknown as { unref?: () => void }).unref?.();
        // Let the app take it down with the view, however the view goes.
        (this as unknown as { registerInterval?: (id: number) => void }).registerInterval?.(handle);
        this.runFollowTimer = handle;
    }

    /** One tick of the follow: repaint only when the pinned position is stale. */
    private followRun(): void {
        const signature = this.runSignature();
        if (signature === null) {
            // No run walking: nothing to follow — and the next run's first
            // position must read as news, never as the paint that was left.
            this.lastRunSignature = null;
            return;
        }
        if (this.plugin.settings.sidebarViewType !== 'list') return;
        if (signature === this.lastRunSignature) return;
        // Recorded before the refresh so the refresh's own pass is not news.
        this.lastRunSignature = signature;
        void this.refresh();
    }

    private stopRunFollow(): void {
        if (this.runFollowTimer === null) return;
        window.clearInterval(this.runFollowTimer);
        this.runFollowTimer = null;
    }

    private async showCorrectViewPane(): Promise<void> {
        // The buttons follow the pane, whoever changed the mode: a click, a date
        // picked in the calendar, or the bar's menu moving the session here.
        this.updateViewToggleButtonsState();
        if (this.plugin.settings.sidebarViewType === 'review') {
            if (this.listViewContentEl) this.listViewContentEl.hide();
            if (this.calendarViewContentEl) this.calendarViewContentEl.hide();
            this.enterReviewTab();
            return;
        }
        // Any other tab ends the session's stay in the sidebar.
        this.leaveReviewTab();

        if (this.plugin.settings.sidebarViewType === 'calendar') {
            if (this.listViewContentEl) this.listViewContentEl.hide();
            if (this.calendarViewContentEl) {
                this.calendarViewContentEl.show();
                await this.renderCalendarViewContent(this.calendarViewContentEl);
            }
        } else { // 'list'
            if (this.calendarViewContentEl) this.calendarViewContentEl.hide();
            if (this.listViewContentEl) { // Check if container exists
                this.listViewContentEl.show();
                // Now delegate rendering to the ListViewRenderer
                await this.renderListViewContent(this.listViewContentEl);
            }
        }
    }

    /**
     * The one way the tabs change panes.
     *
     * A tab press is a choice, and the review pane hands the session back
     * *before* the new mode is written: between the write and the next render
     * there is a window in which a session started from the list would mount
     * into a pane the reader has already left. The other writers of the mode
     * (the calendar's date pick, the settings tab, the bar's own menu) land in
     * the refresh that follows them, where showCorrectViewPane does the same.
     */
    private async switchMode(mode: SidebarPaneMode): Promise<void> {
        if (this.plugin.settings.sidebarViewType === mode) return;
        if (mode === 'review') {
            // Being here is the choice; showCorrectViewPane reveals the pane.
            this.plugin.settings.sidebarViewType = mode;
        } else {
            this.leaveReviewTab();
            this.plugin.settings.sidebarViewType = mode;
            if (mode === 'list') this.activeListBaseDate = null;
        }
        await this.plugin.savePluginData();
        await this.refresh();
    }

    /**
     * The reader is on the review tab: hand the flow controller the element to
     * mount the session into, and make sure there is a session to show.
     *
     * Persisting the host here is the reader's own choice — they picked the
     * tab — so it is written to their settings rather than kept as view state.
     */
    private enterReviewTab(): void {
        const container = this.reviewViewContentEl;
        if (!container) return;
        this.mainContainer?.addClass('sf-review-mode');
        container.removeClass('sf-hidden');
        const flow = this.plugin.reviewFlowController;
        if (!flow) return;
        // The tab claims the session once, when the reader opens it. Claiming
        // again on every render would fight any move they make from the bar's
        // menu — and restart a run they had just ended.
        if (this.claimedReviewTab) return;
        // A claim is only honest while this pane is the one on screen. The mode
        // can name the review pane while the app is showing something else — a
        // view whose element the app has discarded, a mode written from outside
        // — and a session handed to a pane nobody can see is a session that
        // disappears until the reader hunts for it.
        if (!this.isReviewPaneVisible()) return;
        this.claimedReviewTab = true;
        flow.setHost('sidebar', container);
        if (!flow.isActive()) {
            // An empty tab would read as broken; a run is what the tab is for.
            flow.start();
        }
    }

    /**
     * The reader left the review tab (or the view is closing): give the session
     * back to the home they remember, without overwriting that memory — and
     * only while the sidebar is really the one holding it.
     *
     * The session leaves *before* the tab is hidden: hiding first is what left
     * a live bar and dock inside an invisible element (a container is only safe
     * to hide once nothing of the session is inside it).
     */
    private leaveReviewTab(): void {
        this.claimedReviewTab = false;
        const container = this.reviewViewContentEl;
        const flow = this.plugin.reviewFlowController;
        if (flow && container && flow.getHost() === 'sidebar') {
            const remembered = this.plugin.settings.reviewSessionHost;
            flow.setHost(remembered === 'sidebar' ? 'note' : remembered, null, false);
        }
        this.mainContainer?.removeClass('sf-review-mode');
        container?.addClass('sf-hidden');
    }

    /**
     * Open the review tab for a session the reader is already in — the bar's
     * menu calls this right after the sidebar pane has been revealed, which can
     * happen before this view has ever rendered. Only `this.plugin` is needed:
     * refresh() builds the structure if it is not there yet.
     */
    async openReviewTab(): Promise<void> {
        // The reader asked for the tab by name, so it claims the session again
        // even if an earlier render had already done so.
        this.claimedReviewTab = false;
        if (this.plugin.settings.sidebarViewType !== 'review') {
            this.plugin.settings.sidebarViewType = 'review';
            await this.plugin.savePluginData();
        }
        await this.refresh();
    }

    /**
     * Render the list view content by delegating to ListViewRenderer.
     */
    async renderListViewContent(container: HTMLElement): Promise<void> {
        if (this.listViewRenderer) { // Check if renderer is initialized
            await this.listViewRenderer.render(container);
        } else {
            container.setText("Error: could not render list view. Renderer not ready.");
        }
    }

    /**
     * Render the calendar view content
     */
    async renderCalendarViewContent(container: HTMLElement): Promise<void> {
        // container is this.calendarViewContentEl, which is persistent.
        // CalendarView instance is now also persistent and initialized in ensureBaseStructure.
        // It manages its own content within this.calendarViewContentEl.

        // No longer empty the container here, CalendarView manages its own content.
        // No longer create a temporary wrapper here.
        // CalendarView instance is already created.

        if (this.calendarView) { // Should always exist due to ensureBaseStructure
            await this.calendarView.render();
        } else {
            container.setText("Error: could not render calendar view. CalendarView not ready.");
            return; // Avoid further errors if calendarView is somehow null
        }

        // Add resize observer logic
        // The resizeObserver should still observe this.containerEl (the root of the sidebar view)
        // but updateCalendarContainerClass needs to target the correct element within CalendarView's structure.
        // Disconnect any previous observer first so repeated renders don't leak them.
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === this.containerEl) {
                    this.updateCalendarContainerClass();
                }
            }
        });

        if (this.containerEl) {
            resizeObserver.observe(this.containerEl);
            this.resizeObserver = resizeObserver;
            this.updateCalendarContainerClass();
        }
    }

    updateCalendarContainerClass(): void {
        if (!this.containerEl || !this.calendarViewContentEl) return;
        // CalendarView creates a div with class "calendar-container" inside its root element (this.calendarViewContentEl)
        const calendarContainer = this.calendarViewContentEl.querySelector(".calendar-container");
        if (calendarContainer) {
            const sidebarWidth = this.containerEl.clientWidth; // sidebarWidth is the width of the entire sidebar ItemView
            const collapsedThreshold = 300;
            const isNarrow = sidebarWidth < collapsedThreshold;
            calendarContainer.classList.toggle("is-collapsed", isNarrow);
            // Seven columns of a pane this narrow leaves under forty pixels for a
            // day — less than a date, let alone the day's counts need. The month
            // reads as one day per row instead (see .is-stacked in calendar.css).
            calendarContainer.classList.toggle("is-stacked", isNarrow);
        }
    }

    // --- Methods moved out ---

    // --- Existing methods kept for view lifecycle / state ---

    /**
     * Move a note up in the list
     * (Existing Method - Consider moving to controller)
     */
    async moveNoteUp(dateStr: string, note: ReviewSchedule): Promise<void> {
        if (!this.listViewRenderer) {
            return;
        }
        const notes = this.listViewRenderer.groupNotesByDate(
            this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true),
            false
        );
        const dateNotes = notes[dateStr];

        if (!dateNotes) return;
        const index = dateNotes.findIndex(n => n.path === note.path);
        if (index <= 0) return;

        const path1 = dateNotes[index].path;
        const path2 = dateNotes[index - 1].path;
        await this.plugin.reviewController.swapNotes(path1, path2);
        await this.refresh();
        new Notice(`Moved note up.`);
    }

    /**
     * Move a note down in the list
     * (Existing Method - Consider moving to controller)
     */
    async moveNoteDown(dateStr: string, note: ReviewSchedule): Promise<void> {
        if (!this.listViewRenderer) {
            return;
        }
        const notes = this.listViewRenderer.groupNotesByDate(
            this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true),
            false
        );
        const dateNotes = notes[dateStr];

        if (!dateNotes) return;
        const index = dateNotes.findIndex(n => n.path === note.path);
        if (index < 0 || index >= dateNotes.length - 1) return;

        const path1 = dateNotes[index].path;
        const path2 = dateNotes[index + 1].path;
        await this.plugin.reviewController.swapNotes(path1, path2);
        await this.refresh();
        new Notice(`Moved note down.`);
    }

    /**
     * Group notes by their folder
     * (Existing Method - Consider moving to utility/service)
     */
    groupNotesByFolder(notes: ReviewSchedule[]): Record<string, ReviewSchedule[]> {
        const grouped: Record<string, ReviewSchedule[]> = {};
        for (const note of notes) {
            const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
            const folderPath = file?.parent?.path || '/';
            if (!grouped[folderPath]) { grouped[folderPath] = []; }
            grouped[folderPath].push(note);
        }
        return grouped;
    }

    // --- State Management for Obsidian View Lifecycle ---

    getViewState(): ReviewSidebarViewState {
        // const isPomodoroOpen = this.pomodoroUIManager ? this.pomodoroUIManager.getIsPomodoroSectionOpen() : false; // Removed
        // Capture scroll position just before saving state
        if (this.mainContainer) {
            this.lastScrollPosition = this.mainContainer.scrollTop;
        }
        return {
            activeListBaseDateISO: this.activeListBaseDate ? this.activeListBaseDate.toISOString() : null,
            // isPomodoroSectionOpen: isPomodoroOpen, // Removed
            expandedUpcomingDayKey: this.expandedUpcomingDayKey,
            selectedNotes: this.selectedNotes,
            lastScrollPosition: this.lastScrollPosition,
            sidebarViewType: this.plugin.settings.sidebarViewType,
        };
    }

    async setViewState(state: ReviewSidebarViewState): Promise<void> {
        if (!state) return;

        // Restore non-UI-dependent state first
        this.activeListBaseDate = state.activeListBaseDateISO ? new Date(state.activeListBaseDateISO) : null;
        this.expandedUpcomingDayKey = state.expandedUpcomingDayKey ?? null;
        this.selectedNotes = state.selectedNotes ?? [];
        this.lastScrollPosition = state.lastScrollPosition ?? 0; // Restore scroll state

        if (state.sidebarViewType) {
            this.plugin.settings.sidebarViewType = state.sidebarViewType;
        }

        // Refresh the view first to ensure elements and managers are created/initialized
        await this.refresh();

        // Now that elements exist (due to refresh), set the state for components like Pomodoro
        // Ensure pomodoroUIManager is initialized before setting state
        // if (this.pomodoroUIManager) { // Logic related to isPomodoroSectionOpen removed
        // this.pomodoroUIManager.setIsPomodoroSectionOpen(state.isPomodoroSectionOpen ?? false);
        // No need to call updatePomodoroUI here, as refresh -> showCorrectViewPane -> renderListViewContent -> render (in ListViewRenderer)
        // should call pomodoroUIManager.updatePomodoroUI() if the section is enabled.
        // } else {
        // }

        // Scroll position is applied at the end of refresh() using requestAnimationFrame
    }
}
