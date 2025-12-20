import { Notice, Setting } from "obsidian";
import SpaceforgePlugin from "../../main";
import { ReviewSchedule } from "../../models/review-schedule";
import { DateUtils } from "../../utils/dates";
import { EstimationUtils } from "../../utils/estimation";
import { PomodoroUIManager } from "./pomodoro-ui-manager";

import { NoteItemRenderer } from "./note-item-renderer";
import { ConfirmationModal } from "../confirmation-modal";

/**
 * Manages the rendering of the list view within the sidebar.
 */
export class ListViewRenderer {
    private plugin: SpaceforgePlugin;
    private pomodoroUIManager: PomodoroUIManager;
    private noteItemRenderer: NoteItemRenderer;

    // State properties needed from ReviewSidebarView (passed during render or managed via callbacks)
    private getActiveListBaseDate: () => Date | null;
    private getSelectedNotes: () => string[];
    private setSelectedNotes: (notes: string[]) => void;
    private getExpandedUpcomingDayKey: () => string | null;
    private setExpandedUpcomingDayKey: (key: string | null) => void;
    private getLastSelectedNotePath: () => string | null;
    private setLastSelectedNotePath: (path: string | null) => void;
    private refreshSidebarView: () => Promise<void>; // Callback to trigger full refresh if needed

    constructor(
        plugin: SpaceforgePlugin,
        pomodoroUIManager: PomodoroUIManager,
        noteItemRenderer: NoteItemRenderer,
        stateAccessors: {
            getActiveListBaseDate: () => Date | null;
            getSelectedNotes: () => string[];
            setSelectedNotes: (notes: string[]) => void;
            getExpandedUpcomingDayKey: () => string | null;
            setExpandedUpcomingDayKey: (key: string | null) => void;
            getLastSelectedNotePath: () => string | null;
            setLastSelectedNotePath: (path: string | null) => void;
            refreshSidebarView: () => Promise<void>;
        }
    ) {
        this.plugin = plugin;
        this.pomodoroUIManager = pomodoroUIManager;
        this.noteItemRenderer = noteItemRenderer;
        this.getActiveListBaseDate = stateAccessors.getActiveListBaseDate;
        this.getSelectedNotes = stateAccessors.getSelectedNotes;
        this.setSelectedNotes = stateAccessors.setSelectedNotes;
        this.getExpandedUpcomingDayKey = stateAccessors.getExpandedUpcomingDayKey;
        this.setExpandedUpcomingDayKey = stateAccessors.setExpandedUpcomingDayKey;
        this.getLastSelectedNotePath = stateAccessors.getLastSelectedNotePath;
        this.setLastSelectedNotePath = stateAccessors.setLastSelectedNotePath;
        this.refreshSidebarView = stateAccessors.refreshSidebarView;
    }

    /**
     * Render the list view content into the provided container.
     * @param container Container element for list view content
     */
    async render(container: HTMLElement): Promise<void> {
        // container.empty(); // Clear only the list view content area -- REMOVED

        const activeListBaseDate = this.getActiveListBaseDate();
        const selectedNotes = this.getSelectedNotes();
        const dueNotesForStats = this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true);

        // --- Stats Section (REMOVED as per user request) ---
        // await this._ensureAndUpdateStatsSection(container, dueNotesForStats);

        // --- Review Buttons & Pomodoro ---
        // Pass this.plugin.reviewController.getTodayNotes() to ensure Pomodoro uses notes for the selected date context
        await this._ensureAndUpdateReviewButtonsSection(container, this.plugin.reviewController.getTodayNotes(), selectedNotes);

        // --- "All Caught Up" Message ---
        this._ensureAndUpdateAllCaughtUpMessage(container, dueNotesForStats, activeListBaseDate);

        // --- Main List Grouping and Rendering ---
        let notesToGroup: ReviewSchedule[];
        let shouldIncludeFutureInGrouping = false;

        if (activeListBaseDate) {
            notesToGroup = Object.values(this.plugin.reviewScheduleService.schedules);
            shouldIncludeFutureInGrouping = true;
        } else {
            notesToGroup = dueNotesForStats; // Use already fetched due notes
        }

        const groupedNotes = this.groupNotesByDate(notesToGroup, shouldIncludeFutureInGrouping);
        const sortedDateKeys = this.getSortedDateKeys(groupedNotes);

        // --- Render Sections for Main List ---
        await this._ensureAndUpdateDateSections(container, sortedDateKeys, groupedNotes);

        // --- Active Session Section ---
        this._ensureAndUpdateActiveSessionSection(container);

        // --- Upcoming Reviews Section (Conditional) ---
        if (!activeListBaseDate) {
            await this._ensureAndUpdateUpcomingReviewsSection(container);
        } else {
            const existingUpcomingSection = container.querySelector(".review-upcoming-section");
            if (existingUpcomingSection) existingUpcomingSection.remove();
        }

        this.updateBulkActionButtonsVisibility(container); // Ensure bulk actions visibility is correct at the end
    }

    // private async _ensureAndUpdateStatsSection(container: HTMLElement, dueNotesForStats: ReviewSchedule[]): Promise<void> {
    //     let statsEl = container.querySelector(".review-stats-list-view") as HTMLElement;
    //     if (!statsEl) {
    //         statsEl = container.createDiv("review-stats-list-view");
    //     }

    //     let statsCountEl = statsEl.querySelector(".review-stats-count") as HTMLElement;
    //     if (!statsCountEl) {
    //         statsCountEl = statsEl.createEl("div", { cls: "review-stats-count" });
    //     }

    //     const overdueNotes = dueNotesForStats.filter(note => note.nextReviewDate < DateUtils.startOfDay());
    //     let totalTime = 0;
    //     for (const note of dueNotesForStats) {
    //         totalTime += await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
    //     }
    //     statsCountEl.setText(`${dueNotesForStats.length} notes - ${EstimationUtils.formatTime(totalTime)}${overdueNotes.length > 0 ? ` (${overdueNotes.length} overdue)` : ''}`);
    // }

    private _ensureAndUpdateReviewButtonsSection(container: HTMLElement, notesForDisplay: ReviewSchedule[], _selectedNotes: string[]): void {
        // --- Pomodoro Section (Always visible when enabled, independent of notes) ---
        let pomodoroContainer = container.querySelector(".sidebar-pomodoro-section") as HTMLElement;
        if (!pomodoroContainer) {
            pomodoroContainer = container.createDiv("sidebar-pomodoro-section");
        }

        let pomodoroSectionContainerEl = pomodoroContainer.querySelector(".sidebar-pomodoro-section-container") as HTMLElement;
        if (!pomodoroSectionContainerEl) {
            // Check for legacy class names and migrate if found
            const legacyEl = pomodoroContainer.querySelector(".pomodoro-section-container, .sidebar-pomodoro-button-container") as HTMLElement;
            if (legacyEl) {
                legacyEl.className = "sidebar-pomodoro-section-container";
                pomodoroSectionContainerEl = legacyEl;
            } else {
                pomodoroSectionContainerEl = pomodoroContainer.createDiv("sidebar-pomodoro-section-container");
            }
        }

        // Update Pomodoro section visibility and content
        if (this.pomodoroUIManager && pomodoroContainer && pomodoroSectionContainerEl) {
            this.pomodoroUIManager.attachAndRender(pomodoroSectionContainerEl);
            if (this.plugin.settings.pomodoroEnabled) {
                pomodoroContainer.classList.remove('sf-hidden');
                this.pomodoroUIManager.showPomodoroSection(true);
                this.pomodoroUIManager.updatePomodoroUI();

                // Automatically calculate estimation for current notes
                void this.pomodoroUIManager.calculateAndDisplayEstimation();
            } else {
                pomodoroContainer.classList.add('sf-hidden');
                this.pomodoroUIManager.showPomodoroSection(false);
            }
        }

        // --- Review Buttons Section (Only visible when there are notes) ---
        let reviewButtonsContainer = container.querySelector(".review-buttons-container") as HTMLElement;

        // Visibility of review buttons should depend on whether there are notes in the current context (notesForDisplay)
        if (notesForDisplay.length > 0) {
            if (!reviewButtonsContainer) {
                reviewButtonsContainer = container.createDiv("review-buttons-container");
                // Create all buttons once
                const navButtonsContainer = reviewButtonsContainer.createDiv("review-nav-buttons");
                const prevNoteBtn = navButtonsContainer.createEl("button", { text: "Previous", title: "Navigate to previous note", cls: "review-all-button" });
                prevNoteBtn.addEventListener("click", () => { void this.plugin.reviewController.navigateToPreviousNote(); });
                const nextNoteBtn = navButtonsContainer.createEl("button", { text: "Next", title: "Navigate to next note", cls: "review-all-button" });
                nextNoteBtn.addEventListener("click", () => { void this.plugin.reviewController.navigateToNextNote(); });

                const reviewCurrentBtn = reviewButtonsContainer.createEl("button", { text: "Review current note", title: "Review the currently open note if it's due", cls: "review-all-button" });
                reviewCurrentBtn.addEventListener("click", () => { void this.plugin.reviewController.reviewCurrentNote(); });
                const reviewAllBtn = reviewButtonsContainer.createEl("button", { text: "Review all", title: "Start reviewing all due notes", cls: "review-all-button" });
                reviewAllBtn.addEventListener("click", () => { void this.plugin.reviewController.reviewAllTodaysNotes(); });

                if (this.plugin.settings.enableMCQ) {
                    const reviewAllMCQBtn = reviewButtonsContainer.createEl("button", { text: "Review all with MCQs", cls: "review-all-mcq-button" });
                    reviewAllMCQBtn.addEventListener("click", () => { this.plugin.reviewController.reviewAllNotesWithMCQ(true); });
                }
            }
            reviewButtonsContainer.classList.remove('sf-hidden');

            // Bulk action buttons
            let bulkActionButtons = container.querySelector(".review-bulk-actions") as HTMLElement;
            if (!bulkActionButtons) {
                bulkActionButtons = container.createDiv("review-bulk-actions");
                const reviewSelectedBtn = bulkActionButtons.createEl("button", { text: "Review selected", cls: "review-bulk-button" });
                reviewSelectedBtn.addEventListener("click", () => {
                    void this.plugin.reviewController.reviewNotes(this.getSelectedNotes(), false); // Use getter
                    this.setSelectedNotes([]);
                    void this.refreshSidebarView();
                });

                const advanceSelectedBtn = bulkActionButtons.createEl("button", { text: "Advance selected", cls: "review-bulk-button review-bulk-advance" });
                advanceSelectedBtn.addEventListener("click", () => {
                    const pathsToAdvance = [...this.getSelectedNotes()];
                    if (pathsToAdvance.length === 0) {
                        new Notice("No notes selected to advance.");
                        return;
                    }
                    // The controller's advanceNotes will handle eligibility and notices
                    void (async () => {
                        await this.plugin.reviewController.advanceNotes(pathsToAdvance);
                        this.setSelectedNotes([]); // Clear selection after action
                        // advanceNotes in controller already calls savePluginData and refreshSidebarView (via updateTodayNotes)
                        // A direct refresh here might be redundant but ensures UI update if controller logic changes.
                        await this.refreshSidebarView();
                    })();
                });

                const postponeSelectedBtn = bulkActionButtons.createEl("button", { text: "Postpone selected", cls: "review-bulk-button review-bulk-postpone" });
                postponeSelectedBtn.addEventListener("click", () => {
                    const pathsToPostpone = [...this.getSelectedNotes()];
                    if (pathsToPostpone.length === 0) {
                        new Notice("No notes selected to postpone.");
                        return;
                    }
                    this.setSelectedNotes([]);
                    void (async () => {
                        await this.plugin.reviewController.postponeNotes(pathsToPostpone);
                        // postponeNotes in controller handles save and refresh.
                        await this.refreshSidebarView();
                        // Notice is handled by controller/service for postpone.
                    })();
                });

                const removeSelectedBtn = bulkActionButtons.createEl("button", { text: "Remove selected", cls: "review-bulk-button review-bulk-remove" });
                removeSelectedBtn.addEventListener("click", () => {
                    const pathsToRemove = [...this.getSelectedNotes()]; // Use getter
                    new ConfirmationModal(
                        this.plugin.app,
                        'Remove Selected Notes',
                        `Remove ${pathsToRemove.length} selected notes from review schedule?`,
                        () => {
                            this.setSelectedNotes([]);
                            void (async () => {
                                await this.plugin.reviewController.removeNotes(pathsToRemove);
                                await this.plugin.savePluginData();
                                await this.refreshSidebarView();
                                new Notice(`Removed ${pathsToRemove.length} selected notes.`);
                            })();
                        }
                    ).open();
                });
            }
            this.updateBulkActionButtonsVisibility(container); // Update visibility based on current selection

        } else if (reviewButtonsContainer) {
            reviewButtonsContainer.classList.add('sf-hidden');
            const bulkActionButtons = container.querySelector(".review-bulk-actions") as HTMLElement;
            if (bulkActionButtons) bulkActionButtons.toggleClass('sf-hidden', true);
        }
    }

    private _ensureAndUpdateAllCaughtUpMessage(container: HTMLElement, dueNotesForStats: ReviewSchedule[], activeListBaseDate: Date | null): void {
        let caughtUpEl = container.querySelector(".review-all-caught-up") as HTMLElement;
        if (dueNotesForStats.length === 0 && !activeListBaseDate) {
            if (!caughtUpEl) {
                caughtUpEl = container.createDiv("review-all-caught-up");
                // Insert after stats or buttons if they exist
                const statsEl = container.querySelector(".review-stats-list-view");
                const buttonsContainer = container.querySelector(".review-buttons-container");
                const anchor = buttonsContainer || statsEl;
                if (anchor && anchor.nextSibling) {
                    container.insertBefore(caughtUpEl, anchor.nextSibling);
                } else if (anchor) {
                    container.appendChild(caughtUpEl);
                } else {
                    container.prepend(caughtUpEl); // Fallback
                }
            }
            caughtUpEl.setText("All caught up! No notes due for review.");
            caughtUpEl.toggleClass('sf-hidden', false);
        } else if (caughtUpEl) {
            caughtUpEl.toggleClass('sf-hidden', true);
        }
    }

    private async _ensureAndUpdateDateSections(container: HTMLElement, sortedDateKeys: string[], groupedNotes: Record<string, ReviewSchedule[]>): Promise<void> {
        const existingSectionElements = Array.from(container.querySelectorAll(".review-date-section")) as HTMLElement[];
        const dataKeysFromData = new Set(sortedDateKeys);
        let notesDisplayed = false;

        // Remove stale sections
        for (const sectionEl of existingSectionElements) {
            const key = sectionEl.dataset.dateKey;
            if (key && !dataKeysFromData.has(key)) {
                sectionEl.remove();
            }
        }

        // Update existing or create new sections
        for (const dateStr of sortedDateKeys) {
            const notesForSection = groupedNotes[dateStr];
            if (!notesForSection || notesForSection.length === 0) continue;
            notesDisplayed = true;

            let dateSectionEl = container.querySelector(`.review-date-section[data-date-key="${dateStr}"]`) as HTMLElement;
            let notesContainerEl: HTMLElement;

            if (!dateSectionEl) {
                dateSectionEl = container.createDiv("review-date-section");
                dateSectionEl.dataset.dateKey = dateStr;

                const headerRow = dateSectionEl.createDiv("review-date-header");
                const headerContainer = headerRow.createDiv("review-date-header-container");
                headerContainer.createEl("h3"); // Placeholder for heading

                // "Advance All" button for future sections
                const todayStart = DateUtils.startOfDay(new Date()); // Returns timestamp
                const sectionDateKeyIsFuture = !["Due notes", "Today"].includes(dateStr) &&
                    (notesForSection[0] && DateUtils.startOfDay(new Date(notesForSection[0].nextReviewDate)) > todayStart);

                if (sectionDateKeyIsFuture) {
                    const advanceAllBtn = headerContainer.createEl("button", { text: "Advance all", cls: "review-date-action-button review-date-advance-all" });
                    advanceAllBtn.title = `Advance all notes in this section by 1 day`;
                    advanceAllBtn.addEventListener("click", () => {
                        const currentNotesForSection = groupedNotes[dateStr] || [];
                        if (currentNotesForSection.length === 0) return;
                        new ConfirmationModal(
                            this.plugin.app,
                            'Advance All Notes',
                            `Advance all ${currentNotesForSection.length} notes from "${dateStr}" by 1 day? (Only future notes will be affected)`,
                            () => {
                                const paths = currentNotesForSection.map(note => note.path);
                                void this.plugin.reviewController.advanceNotes(paths);
                            }
                        ).open();
                    });
                }

                const postponeAllBtn = headerContainer.createEl("button", { text: "Postpone all", cls: "review-date-action-button review-date-postpone-all" });
                postponeAllBtn.title = `Postpone all notes in this section by 1 day`;
                postponeAllBtn.addEventListener("click", () => {
                    const currentNotesForSection = groupedNotes[dateStr] || [];
                    if (currentNotesForSection.length === 0) return;
                    const daysToPostpone = 1;
                    new ConfirmationModal(
                        this.plugin.app,
                        'Postpone All Notes',
                        `Postpone all ${currentNotesForSection.length} notes from "${dateStr}" by ${daysToPostpone} day(s)?`,
                        () => {
                            const paths = currentNotesForSection.map(note => note.path);
                            void this.plugin.reviewController.postponeNotes(paths, daysToPostpone);
                        }
                    ).open();
                });

                headerRow.createSpan("review-date-time"); // Placeholder for time
                notesContainerEl = dateSectionEl.createDiv("review-notes-container");
            } else {
                notesContainerEl = dateSectionEl.querySelector(".review-notes-container") as HTMLElement;
                if (!notesContainerEl) { // Should not happen if structure is consistent
                    notesContainerEl = dateSectionEl.createDiv("review-notes-container");
                }
            }

            // Update header content
            dateSectionEl.removeClass("review-date-section-overdue");
            // const isDefaultTodayView = !this.getActiveListBaseDate(); // Unused

            // A section is considered "overdue" if its category key is "Due notes".
            // This applies whether in default view (actual overdue notes)
            // or when viewing a past date from calendar (where "Due notes" might be the category for that day's notes).
            if (dateStr === "Due notes") {
                dateSectionEl.addClass("review-date-section-overdue");
            }

            const headerContainer = dateSectionEl.querySelector(".review-date-header-container") as HTMLElement;
            const dateHeading = headerContainer.querySelector("h3") as HTMLElement;
            const reviewTimeEl = dateSectionEl.querySelector(".review-date-time") as HTMLElement;

            let displayHeader = dateStr;
            const noteCountText = `${notesForSection.length} ${notesForSection.length === 1 ? 'note' : 'notes'}`;
            if (dateStr !== "Due notes" && notesForSection.length > 0) {
                const actualGroupSampleDate = new Date(notesForSection[0].nextReviewDate);
                const formattedActualDate = actualGroupSampleDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                if (["Today", "Tomorrow"].includes(dateStr) || dateStr.startsWith("In ")) {
                    displayHeader = `${dateStr} (${formattedActualDate})`;
                }
                displayHeader += ` - ${noteCountText}`;
            } else {
                displayHeader = `${dateStr} - ${noteCountText}`;
            }
            dateHeading.setText(displayHeader);

            let overdueBadge = dateHeading.querySelector(".review-overdue-badge") as HTMLElement | null;
            const todayActualStart = DateUtils.startOfDay(); // Timestamp for actual today's midnight

            // Condition for showing overdue badge:
            // The overdue badge should only show for the "Due notes" section.
            const shouldShowOverdueBadge = (dateStr === "Due notes");

            if (shouldShowOverdueBadge) {
                // If the section is "Due notes", all notes within it are candidates for the overdue calculation.
                const overdueNotesInThisSection = notesForSection;

                if (overdueNotesInThisSection.length > 0) {
                    const daysDiff = overdueNotesInThisSection.map(note => {
                        // When dateStr is "Due notes":
                        // - If in default view (isDefaultTodayView = true), overdue is relative to actual today.
                        // - If viewing a specific past date from calendar (isDefaultTodayView = false),
                        //   "Due notes" might be the category for notes *on* that day.
                        //   In this case, overdue days relative to that selected past date will be 0.
                        const baseDate = this.getActiveListBaseDate();
                        const referenceDateForDiff = baseDate ? DateUtils.startOfDay(baseDate) : todayActualStart;
                        return Math.floor((referenceDateForDiff - new Date(note.nextReviewDate).getTime()) / (24 * 60 * 60 * 1000));
                    });
                    const maxDays = Math.max(0, ...daysDiff.filter(d => d >= 0 && !isNaN(d))); // Ensure positive days and filter NaN

                    if (maxDays > 0) {
                        if (!overdueBadge) {
                            overdueBadge = dateHeading.createSpan("review-overdue-badge sf-overdue-badge");
                        }
                        overdueBadge.setText(` (${maxDays} ${maxDays === 1 ? 'day' : 'days'} overdue)`);
                        overdueBadge.toggleClass('sf-hidden', false);
                    } else if (overdueBadge) {
                        overdueBadge.toggleClass('sf-hidden', true); // No positive overdue days
                    }
                } else if (overdueBadge) {
                    overdueBadge.toggleClass('sf-hidden', true); // No overdue notes in section
                }
            } else if (overdueBadge) {
                overdueBadge.toggleClass('sf-hidden', true); // Conditions for badge not met
            }

            let sectionTime = 0;
            for (const note of notesForSection) { sectionTime += await this.plugin.reviewScheduleService.estimateReviewTime(note.path); }
            reviewTimeEl.setText(`(${EstimationUtils.formatTime(sectionTime)})`);

            await this._updateOrRenderNoteList(notesContainerEl, notesForSection, dateStr, container);
        }

        // Message for activeListBaseDate with no notes
        let noNotesForDateMsg = container.querySelector(".review-no-notes-for-date") as HTMLElement;
        const activeListBaseDate = this.getActiveListBaseDate();
        if (activeListBaseDate && !notesDisplayed) {
            if (!noNotesForDateMsg) {
                noNotesForDateMsg = container.createDiv("review-no-notes-for-date"); // Similar to all-caught-up
            }
            noNotesForDateMsg.setText(`No notes scheduled on or after ${activeListBaseDate.toLocaleDateString()}.`);
            noNotesForDateMsg.toggleClass('sf-hidden', false);
        } else if (noNotesForDateMsg) {
            noNotesForDateMsg.toggleClass('sf-hidden', true);
        }
    }

    private _ensureAndUpdateActiveSessionSection(container: HTMLElement): void {
        const activeSession = this.plugin.reviewSessionService.getActiveSession();
        let sessionSection = container.querySelector(".review-session-section") as HTMLElement;

        if (activeSession) {
            if (!sessionSection) {
                sessionSection = container.createDiv("review-session-section");
                new Setting(sessionSection).setHeading().setName("Active review session");
                const sessionInfo = sessionSection.createDiv("review-session-info");
                sessionInfo.createDiv({ cls: "review-session-name" });
                sessionInfo.createDiv({ cls: "review-session-progress" });
                const progressBarContainer = sessionInfo.createDiv("review-session-progress-bar-container");
                progressBarContainer.createDiv("review-session-progress-bar");
                const continueBtn = sessionSection.createEl("button", { text: "Continue session", cls: "review-session-continue" });
                continueBtn.addEventListener("click", () => { /* ... continue logic ... */ }); // TODO: Implement continue logic if not already present
                const endBtn = sessionSection.createEl("button", { text: "End session", cls: "review-session-end" });
                endBtn.addEventListener("click", () => {
                    this.plugin.reviewSessionService.setActiveSession(null);
                    void this.refreshSidebarView();
                });
            }
            sessionSection.toggleClass('sf-hidden', false);
            (sessionSection.querySelector(".review-session-name") as HTMLElement).setText(activeSession.name);
            (sessionSection.querySelector(".review-session-progress") as HTMLElement).setText(`Progress: ${activeSession.currentIndex}/${activeSession.hierarchy.traversalOrder.length}`);
            const progressBar = sessionSection.querySelector(".review-session-progress-bar") as HTMLElement;
            const progressPercent = Math.min(100, Math.round((activeSession.currentIndex / activeSession.hierarchy.traversalOrder.length) * 100));
            progressBar.style.width = `${progressPercent}%`;
        } else if (sessionSection) {
            sessionSection.toggleClass('sf-hidden', true);
        }
    }

    private async _ensureAndUpdateUpcomingReviewsSection(container: HTMLElement): Promise<void> {
        const allSchedules = Object.values(this.plugin.reviewScheduleService.schedules);
        const upcomingGroupedNotes = await this.groupNotesByDate(allSchedules, true);
        const upcomingKeys = this.getSortedDateKeys(upcomingGroupedNotes)
            .filter(key => {
                if (key === 'Due notes') return false;
                const actualTodayStart = DateUtils.startOfDay(new Date());
                if (key === DateUtils.formatDate(actualTodayStart, 'relative', null)) return false; // Exclude "Today" if it's empty or handled by main list
                if (key === DateUtils.formatDate(DateUtils.addDays(actualTodayStart, 1), 'relative', null)) return false; // Exclude "Tomorrow"
                return true;
            });

        let upcomingSection = container.querySelector(".review-upcoming-section") as HTMLElement;

        if (upcomingKeys.length > 0) {
            if (!upcomingSection) {
                upcomingSection = container.createDiv("review-upcoming-section");
                new Setting(upcomingSection).setHeading().setName("Upcoming reviews");
                upcomingSection.createDiv("review-upcoming-list"); // List container
            }
            upcomingSection.toggleClass('sf-hidden', false);
            const upcomingListEl = upcomingSection.querySelector(".review-upcoming-list") as HTMLElement;
            if (!upcomingListEl) return; // Should not happen

            const existingDayItemElements = Array.from(upcomingListEl.querySelectorAll(".review-upcoming-day")) as HTMLElement[];


            // Remove stale day items
            for (const dayItemEl of existingDayItemElements) {
                const key = dayItemEl.dataset.dayKey;
                if (key && !upcomingKeys.includes(key)) {
                    dayItemEl.remove();
                }
            }

            // Update or create day items
            for (const dayKey of upcomingKeys) {
                const notesForDay = upcomingGroupedNotes[dayKey];
                if (!notesForDay || notesForDay.length === 0) {
                    // Ensure any existing DOM element for this empty dayKey is removed
                    const staleEmptyDayItem = upcomingListEl.querySelector(`.review-upcoming-day[data-day-key="${dayKey}"]`);
                    if (staleEmptyDayItem) staleEmptyDayItem.remove();
                    continue;
                }

                let dayItemEl = upcomingListEl.querySelector(`.review-upcoming-day[data-day-key="${dayKey}"]`) as HTMLElement;
                if (!dayItemEl) {
                    dayItemEl = upcomingListEl.createDiv("review-upcoming-day");
                    dayItemEl.addClass("clickable");
                    dayItemEl.dataset.dayKey = dayKey;
                    const daySummary = dayItemEl.createDiv("review-upcoming-day-summary");
                    daySummary.createEl("span", { cls: "review-upcoming-day-name" }); // Placeholder for name

                    dayItemEl.addEventListener("click", () => { // Attach listener once
                        const currentDayKey = dayItemEl.dataset.dayKey;
                        if (!currentDayKey) return;
                        const expandedUpcomingDayKey = this.getExpandedUpcomingDayKey();
                        const isCurrentlyExpanded = expandedUpcomingDayKey === currentDayKey;
                        this.setExpandedUpcomingDayKey(isCurrentlyExpanded ? null : currentDayKey);
                        // Visual state and note list rendering will be handled by the main render pass
                        void this.refreshSidebarView(); // Trigger a re-render to reflect expansion
                    });
                }

                // Update summary
                const daySummaryNameEl = dayItemEl.querySelector(".review-upcoming-day-summary .review-upcoming-day-name") as HTMLElement;
                let upcomingDisplayHeader = dayKey;
                if (notesForDay.length > 0) { // Should always be true here
                    const sampleUpcomingDate = new Date(notesForDay[0].nextReviewDate);
                    const formattedUpcomingDate = DateUtils.formatDate(sampleUpcomingDate.getTime(), 'medium');
                    if (["Today", "Tomorrow"].includes(dayKey) || dayKey.startsWith("In ")) {
                        upcomingDisplayHeader = `${dayKey} (${formattedUpcomingDate})`;
                    } else {
                        upcomingDisplayHeader = formattedUpcomingDate;
                    }
                }
                if (daySummaryNameEl) daySummaryNameEl.setText(`${upcomingDisplayHeader}: ${notesForDay.length} ${notesForDay.length === 1 ? 'note' : 'notes'}`);

                // Handle expanded state
                const isExpanded = this.getExpandedUpcomingDayKey() === dayKey;
                dayItemEl.classList.toggle("is-expanded", isExpanded);
                let notesContainerEl = dayItemEl.querySelector(".review-upcoming-notes-container") as HTMLElement;

                if (isExpanded) {
                    if (!notesContainerEl) {
                        notesContainerEl = dayItemEl.createDiv("review-upcoming-notes-container");
                    }
                    notesContainerEl.toggleClass('sf-hidden', false);
                    await this._updateOrRenderNoteList(notesContainerEl, notesForDay, dayKey, container);
                } else if (notesContainerEl) {
                    notesContainerEl.toggleClass('sf-hidden', true); // Hide instead of removing
                }
            }

        } else if (upcomingSection) {
            upcomingSection.toggleClass('sf-hidden', true);
        }
    }

    /**
     * Renders or updates a list of notes within a given container.
     */
    private async _updateOrRenderNoteList(
        notesContainer: HTMLElement,
        notes: ReviewSchedule[],
        dateStr: string,
        parentContainerForBulkActions: HTMLElement
    ): Promise<void> {
        const existingNoteElements = Array.from(notesContainer.querySelectorAll('.review-note-item[data-note-path]')) as HTMLElement[];
        const existingNotesMap = new Map(existingNoteElements.map(el => [el.dataset.notePath, el]));
        const notesInOrder: HTMLElement[] = [];

        const lastSelectedNotePath = this.getLastSelectedNotePath();
        const lastSelectedNotePathRef = { current: lastSelectedNotePath };

        for (const note of notes) {
            let noteEl = existingNotesMap.get(note.path);
            if (noteEl) {
                await this.noteItemRenderer.updateNoteItem(
                    noteEl,
                    note,
                    dateStr,
                    this.getSelectedNotes()
                );
                existingNotesMap.delete(note.path); // Mark as processed
            } else {
                noteEl = await this.noteItemRenderer.renderNoteItem(
                    notesContainer, // Temporarily append here, will be reordered
                    note,
                    dateStr,
                    parentContainerForBulkActions,
                    this.getSelectedNotes(),
                    lastSelectedNotePathRef,
                    () => this.handleSelectionChange(parentContainerForBulkActions),
                    this.handleNoteAction.bind(this)
                );
            }
            if (noteEl) notesInOrder.push(noteEl);
        }

        // Remove stale notes
        for (const staleNoteEl of existingNotesMap.values()) {
            staleNoteEl.remove();
        }

        // Ensure correct order
        notesContainer.empty(); // Clear container before re-appending in correct order
        for (const noteEl of notesInOrder) {
            notesContainer.appendChild(noteEl);
        }

        this.setLastSelectedNotePath(lastSelectedNotePathRef.current);
    }


    /**
     * Callback function passed to NoteItemRenderer to handle UI updates after selection changes.
     */
    private handleSelectionChange(container: HTMLElement): void {
        this.updateSelectionClasses(container);
        this.updateBulkActionButtonsVisibility(container);
    }

    /**
     * Callback function passed to NoteItemRenderer for actions (like postpone, remove)
     * that require a broader UI update (potentially a full refresh or targeted updates).
     */
    private async handleNoteAction(): Promise<void> {
        await this.refreshSidebarView();
    }

    /**
     * Updates the 'selected' class on note items based on the selectedNotes array.
     * (Called by handleSelectionChange)
     */
    private updateSelectionClasses(container: HTMLElement): void {
        const selectedNotes = this.getSelectedNotes();
        const allNoteElements = container.querySelectorAll('.review-note-item[data-note-path]') as NodeListOf<HTMLElement>;
        allNoteElements.forEach(el => {
            const path = el.dataset.notePath;
            if (path && selectedNotes.includes(path)) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });
    }

    /**
     * Updates the visibility of the bulk action buttons based on selection count.
     * (Called by handleSelectionChange and render)
     */
    private updateBulkActionButtonsVisibility(container: HTMLElement): void {
        const selectedNotesPaths = this.getSelectedNotes();
        const bulkActionsContainer = container.querySelector('.review-bulk-actions') as HTMLElement;

        if (bulkActionsContainer) {
            bulkActionsContainer.toggleClass('sf-hidden', selectedNotesPaths.length <= 1);

            // Handle visibility/disabled state of "Advance Selected" button
            const advanceSelectedBtn = bulkActionsContainer.querySelector('.review-bulk-advance') as HTMLButtonElement | null;
            if (advanceSelectedBtn) {
                if (selectedNotesPaths.length > 1) {
                    const todayStart = DateUtils.startOfDay(new Date()); // Returns timestamp
                    const hasEligibleFutureNote = selectedNotesPaths.some(path => {
                        const schedule = this.plugin.reviewScheduleService.schedules[path];
                        return schedule && DateUtils.startOfDay(new Date(schedule.nextReviewDate)) > todayStart;
                    });
                    advanceSelectedBtn.disabled = !hasEligibleFutureNote;
                    advanceSelectedBtn.toggleClass('sf-hidden', false); // Always show if bulk actions are visible, rely on disabled state
                } else {
                    advanceSelectedBtn.disabled = true;
                    // advanceSelectedBtn.style.display = 'none'; // Or hide if no selection
                }
            }
        }
    }

    /**
     * Updates the main header statistics display.
     */
    private async updateHeaderStats(container: HTMLElement): Promise<void> {
        const headerStatsEl = container.querySelector('.review-stats-list-view .review-stats-count');
        if (!headerStatsEl) return;

        const dueNotesForStats = this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true);
        const overdueNotes = dueNotesForStats.filter(note => note.nextReviewDate < DateUtils.startOfDay());
        let totalTime = 0;
        for (const note of dueNotesForStats) {
            totalTime += await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
        }
        const statsText = `${dueNotesForStats.length} notes - ${EstimationUtils.formatTime(totalTime)}${overdueNotes.length > 0 ? ` (${overdueNotes.length} overdue)` : ''}`;
        headerStatsEl.textContent = statsText;

        const reviewButtonsContainer = container.querySelector('.review-buttons-container');
        if (reviewButtonsContainer) {
            (reviewButtonsContainer as HTMLElement).toggleClass('sf-hidden', dueNotesForStats.length === 0);
        }
        this.updateBulkActionButtonsVisibility(container);

        const allCaughtUpEl = container.querySelector('.review-all-caught-up');
        // Use notesForDisplay (which reflects the current date context) for "All caught up" message
        const notesInCurrentContext = this.plugin.reviewController.getTodayNotes();

        if (allCaughtUpEl) {
            (allCaughtUpEl as HTMLElement).toggleClass('sf-hidden', notesInCurrentContext.length !== 0);
            if (notesInCurrentContext.length === 0) {
                allCaughtUpEl.setText(this.getActiveListBaseDate() ? "No notes for selected date." : "All caught up! No notes due for review.");
            }
        } else if (notesInCurrentContext.length === 0) {
            const buttonsContainer = container.querySelector('.review-buttons-container');
            const newCaughtUpEl = container.createDiv("review-all-caught-up");
            newCaughtUpEl.setText(this.getActiveListBaseDate() ? "No notes for selected date." : "All caught up! No notes due for review.");

            // Insert after stats or buttons if they exist
            // const statsEl = container.querySelector(".review-stats-list-view"); // Stats section is removed
            const anchor = buttonsContainer; // || statsEl; // Stats section removed
            if (anchor && anchor.nextSibling) {
                container.insertBefore(newCaughtUpEl, anchor.nextSibling);
            } else if (anchor) {
                container.appendChild(newCaughtUpEl);
            } else {
                container.prepend(newCaughtUpEl); // Fallback
            }
        }
    }

    /**
     * Updates the count and estimated time for a specific date section header, or removes the section if empty.
     */
    private async updateSectionCounts(sectionEl: HTMLElement, container: HTMLElement): Promise<void> {
        if (!sectionEl || !container || !sectionEl.parentElement) return;

        const notesInSection = Array.from(sectionEl.querySelectorAll('.review-note-item[data-note-path]'));
        const count = notesInSection.length;

        if (count === 0) {
            sectionEl.remove();
        } else {
            const headerTextEl = sectionEl.querySelector('.review-date-header-container h3');
            const timeEl = sectionEl.querySelector('.review-date-time');
            const dateStr = sectionEl.dataset.dateKey;

            if (headerTextEl && timeEl && dateStr) {
                let sectionTime = 0;
                for (const noteEl of notesInSection) {
                    const path = (noteEl as HTMLElement).dataset.notePath;
                    if (path) {
                        sectionTime += await this.plugin.reviewScheduleService.estimateReviewTime(path);
                    }
                }
                timeEl.setText(`(${EstimationUtils.formatTime(sectionTime)})`);

                let displayHeader = dateStr;
                const noteCountText = `${count} ${count === 1 ? 'note' : 'notes'}`;
                const firstNotePath = (notesInSection[0] as HTMLElement).dataset.notePath;
                const schedule = firstNotePath ? this.plugin.reviewScheduleService.schedules[firstNotePath] : null;

                if (dateStr !== "Due notes" && schedule) {
                    const actualGroupSampleDate = new Date(schedule.nextReviewDate);
                    const formattedActualDate = actualGroupSampleDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    if (["Today", "Tomorrow"].includes(dateStr) || dateStr.startsWith("In ")) {
                        displayHeader = `${dateStr} (${formattedActualDate})`;
                    }
                    displayHeader += ` - ${noteCountText}`;
                } else {
                    displayHeader = `${dateStr} - ${noteCountText}`;
                }
                headerTextEl.textContent = displayHeader;

                let overdueBadge = headerTextEl.querySelector(".review-overdue-badge") as HTMLElement | null;
                if (dateStr === "Due notes") {
                    const daysDiff = notesInSection.map(noteEl => {
                        const path = (noteEl as HTMLElement).dataset.notePath;
                        const noteSchedule = path ? this.plugin.reviewScheduleService.schedules[path] : null;
                        return noteSchedule ? Math.abs(Math.floor((noteSchedule.nextReviewDate - DateUtils.startOfDay()) / (24 * 60 * 60 * 1000))) : 0;
                    });
                    const maxDays = Math.max(0, ...daysDiff.filter(d => !isNaN(d)));
                    if (maxDays > 0) {
                        const badgeText = ` (${maxDays} ${maxDays === 1 ? 'day' : 'days'} overdue)`;
                        if (!overdueBadge) {
                            overdueBadge = headerTextEl.createSpan("review-overdue-badge sf-overdue-badge");
                        }
                        overdueBadge.setText(badgeText);
                    } else if (overdueBadge) {
                        overdueBadge.remove();
                    }
                } else if (overdueBadge) {
                    overdueBadge.remove();
                }
            }
        }
        await this.updateHeaderStats(container);
    }

    /**
    * Updates counts for all date sections currently in the DOM.
    */
    private async updateAllSectionCounts(container: HTMLElement): Promise<void> {
        const sections = container.querySelectorAll('.review-date-section');
        for (const section of Array.from(sections)) {
            await this.updateSectionCounts(section as HTMLElement, container);
        }
        await this.updateHeaderStats(container);
    }

    /**
     * Group notes by their review date, considering activeListBaseDate.
     */
    groupNotesByDate(notes: ReviewSchedule[], _includeFuture = false): Record<string, ReviewSchedule[]> {
        const grouped: Record<string, ReviewSchedule[]> = {};
        const actualTodayStart = DateUtils.startOfDay(new Date());
        const activeListBaseDate = this.getActiveListBaseDate();
        const refDateForFilteringStart = activeListBaseDate ? DateUtils.startOfDay(new Date(activeListBaseDate)) : actualTodayStart;

        for (const note of notes) {
            const noteDate = new Date(note.nextReviewDate);
            const noteDateStart = DateUtils.startOfDay(noteDate); // Timestamp for note's due day midnight

            if (activeListBaseDate) {
                // When a specific date is selected from the calendar (activeListBaseDate is set),
                // only include notes whose due day (UTC midnight) matches the selected day (UTC midnight).
                if (noteDateStart !== refDateForFilteringStart) {
                    continue;
                }
            }
            // For the default view (activeListBaseDate is null), notesToGroup (derived from controller's todayNotes)
            // already contains all notes due up to and including today.
            // No further date-based filtering is needed here for the default view.

            // Determine the group string.
            // If activeListBaseDate is set, format relative to that date.
            // If activeListBaseDate is null (default view), format relative to actual current time.
            const dateStr = DateUtils.formatDate(note.nextReviewDate, 'relative', activeListBaseDate);

            // Overdue notes will now naturally be grouped under "Due notes" (or similar key from DateUtils)
            // by the dateStr determined above, rather than being merged into "Today".

            if (!grouped[dateStr]) {
                grouped[dateStr] = [];
            }
            grouped[dateStr].push(note);
        }
        return grouped;
    }

    /**
     * Get sorted date keys in the preferred display order: Due notes, Today, Tomorrow, future dates.
     */
    getSortedDateKeys(groupedNotes: Record<string, ReviewSchedule[]>): string[] {
        const keys = Object.keys(groupedNotes);
        const dateOrder: Record<string, number> = { 'Due notes': 0, 'Today': 1, 'Tomorrow': 2 };

        return keys.sort((a, b) => {
            const aIsSpecial = a in dateOrder;
            const bIsSpecial = b in dateOrder;

            if (aIsSpecial && bIsSpecial) return dateOrder[a as keyof typeof dateOrder] - dateOrder[b as keyof typeof dateOrder];
            if (aIsSpecial) return -1;
            if (bIsSpecial) return 1;

            const numAMatch = a.match(/^In (\d+) days$/);
            const numBMatch = b.match(/^In (\d+) days$/);

            if (numAMatch && numBMatch) return parseInt(numAMatch[1]) - parseInt(numBMatch[1]);
            if (numAMatch) return -1;
            if (numBMatch) return 1;

            return a.localeCompare(b);
        });
    }
}
