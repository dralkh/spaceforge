import { ItemView, Notice, WorkspaceLeaf, Setting } from "obsidian";
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
    sidebarViewType?: 'list' | 'calendar';
}

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

    constructor(leaf: WorkspaceLeaf, plugin: SpaceforgePlugin) {
        super(leaf);
        this.plugin = plugin;
        this.noteItemRenderer = new NoteItemRenderer(this.plugin);
        // PomodoroUIManager and ListViewRenderer are initialized in ensureBaseStructure
    }

    getViewType(): string { return "spaceforge-review-schedule"; }
    getDisplayText(): string { return "Spaceforge Review"; } // eslint-disable-line obsidianmd/ui/sentence-case
    getIcon(): string { return "calendar-clock"; }

    async onOpen(): Promise<void> {
        this.plugin.events.on('sidebar-update', this.refresh.bind(this));
        this.plugin.events.on('pomodoro-update', () => {
            if (this.pomodoroUIManager) {
                this.pomodoroUIManager.updatePomodoroUI();
            }
        });

        // Ensure structure and render on first open
        await this.refresh();
    }

    onClose(): Promise<void> {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.plugin.events.off('sidebar-update', this.refresh.bind(this));
        // No need to explicitly unregister pomodoro-update as the manager handles its own logic
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
            const viewToggle = this.persistentHeaderEl.createDiv("review-view-toggle");

            const listViewBtn = viewToggle.createDiv("review-view-btn");
            listViewBtn.setText("List");
            listViewBtn.addEventListener("click", () => {
                if (this.plugin.settings.sidebarViewType === 'list') return;
                this.plugin.settings.sidebarViewType = 'list';
                this.activeListBaseDate = null;
                void (async () => {
                    await this.plugin.savePluginData();
                    await this.refresh();
                })();
            });

            const calendarViewBtn = viewToggle.createDiv("review-view-btn");
            calendarViewBtn.setText("Calendar");
            calendarViewBtn.addEventListener("click", () => {
                if (this.plugin.settings.sidebarViewType === 'calendar') return;
                this.plugin.settings.sidebarViewType = 'calendar';
                void (async () => {
                    await this.plugin.savePluginData();
                    await this.refresh();
                })();
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
                refreshSidebarView: this.refresh.bind(this)
            });
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
        if (listViewBtn) listViewBtn.classList.toggle("active", this.plugin.settings.sidebarViewType === 'list');
        if (calendarViewBtn) calendarViewBtn.classList.toggle("active", this.plugin.settings.sidebarViewType === 'calendar');
    }

    async refresh(): Promise<void> {
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
            await this.plugin.reviewController.setReviewDateOverride(targetControllerOverrideValue);
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

        // Apply scroll position *after* rendering is complete
        if (this.mainContainer) {
            requestAnimationFrame(() => {
                if (this.mainContainer) this.mainContainer.scrollTop = storedScrollPosition;
                this.lastScrollPosition = storedScrollPosition; // Update state after applying
            });
        }
    }

    private async showCorrectViewPane(): Promise<void> {
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
     * Render the list view content by delegating to ListViewRenderer.
     */
    async renderListViewContent(container: HTMLElement): Promise<void> {
        if (this.listViewRenderer) { // Check if renderer is initialized
            await this.listViewRenderer.render(container);
        } else {
            container.setText("Error: Could not render list view. Renderer not ready."); // eslint-disable-line obsidianmd/ui/sentence-case
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
            container.setText("Error: Could not render calendar view. CalendarView not ready."); // eslint-disable-line obsidianmd/ui/sentence-case
            return; // Avoid further errors if calendarView is somehow null
        }

        // Add resize observer logic
        // The resizeObserver should still observe this.containerEl (the root of the sidebar view)
        // but updateCalendarContainerClass needs to target the correct element within CalendarView's structure.
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
            if (sidebarWidth < collapsedThreshold) {
                calendarContainer.classList.add("is-collapsed");
            } else {
                calendarContainer.classList.remove("is-collapsed");
            }
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
