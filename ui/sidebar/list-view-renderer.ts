import { Menu, Notice, setIcon, Setting } from 'obsidian';
import SpaceforgePlugin from "../../main";
import { ReviewSchedule } from "../../models/review-schedule";
import { DateUtils } from "../../utils/dates";
import { EstimationUtils } from "../../utils/estimation";
import { PomodoroUIManager } from "./pomodoro-ui-manager";
import {
    DeckDueGroup,
    DeckRowView,
    RestingDeck,
    describeCardState,
    relativeDayKey,
    truncateQuestion,
} from "./deck-list-renderer";
import { AnkiCard, AnkiCardQueue, AnkiId, DeckBundle, DeckOptions } from "../../models/anki";
import { buildQueue } from "../../models/anki-scheduler";
import { resolvePresentation } from "../../models/card-presentation";
import { deckDayBase } from "../../utils/dates";
import { displayDeckName } from "../../utils/deck-display";
import { DeckSummary } from "../../services/deck-store";
import { TFile } from "obsidian";

/** One day, in the only unit Anki's day numbers are counted in. */
const DAY_MS = 86_400_000;

/** A deck as the sidebar needs it: read once, re-grouped on every render. */
interface CachedDeck {
    modified: number;
    deckName: string;
    deckId: AnkiId;
    options: DeckOptions;
    dayBase: number;
    cards: AnkiCard[];
    /** What each card's front reads, already through the presentation engine. */
    fronts: Map<string, string>;
}

import { NoteItemRenderer } from "./note-item-renderer";
import { ConfirmationModal } from "../confirmation-modal";
import { CardEditorModal } from "../card-editor-modal";

function isRowActivation(event: KeyboardEvent): boolean {
    const key = event.key;
    return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * Manages the rendering of the list view within the sidebar.
 */
export class ListViewRenderer {
    private plugin: SpaceforgePlugin;
    private pomodoroUIManager: PomodoroUIManager;
    private noteItemRenderer: NoteItemRenderer;
    private dragAndDropInitialized = false;

    // State properties needed from ReviewSidebarView (passed during render or managed via callbacks)
    private getActiveListBaseDate: () => Date | null;
    private getSelectedNotes: () => string[];
    private setSelectedNotes: (notes: string[]) => void;
    private getExpandedUpcomingDayKey: () => string | null;
    /** Cards due across every deck, for the session menu; null until counted. */
    private deckDueTotal: number | null = null;
    private deckDueCountedAt = 0;
    /** What the decks owe, keyed by the list's own day strings. */
    private deckDueToday: Record<string, DeckDueGroup[]> = {};
    private deckDueFuture: Record<string, DeckDueGroup[]> = {};
    /** Decks that owe nothing at all, for the muted line at the end. */
    private restingDecks: RestingDeck[] = [];
    /** Deck documents, read once per version and only re-grouped after that. */
    private deckCardCache = new Map<string, CachedDeck>();
    private deckRowRenderer: DeckRowView | null = null;
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
         const dueNotesForStats = this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true);

         // Setup drag-and-drop event handlers for the container
         this.setupDragAndDrop(container);

        // What the decks owe, before anything decides whether the day is done.
        await this.loadDeckDue();


        // --- Stats Section (REMOVED as per user request) ---
        // await this._ensureAndUpdateStatsSection(container, dueNotesForStats);

        // --- Review buttons, the pomodoro and the note navigation ---
        // Pass this.plugin.reviewController.getTodayNotes() to ensure Pomodoro uses notes for the selected date context
        this._ensureAndUpdateReviewButtonsSection(container, this.plugin.reviewController.getTodayNotes(), this.getSelectedNotes());

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

        // --- Cards: the reader's own way in to the card lane ---
        this._ensureAndUpdateCardsSection(container);

        this.updateBulkActionButtonsVisibility(container); // Ensure bulk actions visibility is correct at the end

        // Where the run is standing, shown where the reader looks for it: the
        // list is not a separate map of the session, it is the same map, and
        // this is the pin in it.
        this.markRunPosition(container);
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

    //     const overdueNotes = dueNotesForStats.filter(note => note.nextReviewDate < DateUtils.startOfUTCDay());
    //     let totalTime = 0;
    //     for (const note of dueNotesForStats) {
    //         totalTime += await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
    //     }
    //     statsCountEl.setText(`${dueNotesForStats.length} notes - ${EstimationUtils.formatTime(totalTime)}${overdueNotes.length > 0 ? ` (${overdueNotes.length} overdue)` : ''}`);
    // }

    /**
     * The review buttons, the pomodoro and the note navigation.
     *
     * The stack of buttons this used to carry is one session menu now — start a
     * run, study the decks, walk the list — with the background charting status
     * beside it. The pomodoro paces the work, and the two moves a reader makes
     * most often, previous and next note, sit under the timer.
     */
    private _ensureAndUpdateReviewButtonsSection(container: HTMLElement, notesForDisplay: ReviewSchedule[], _selectedNotes: string[]): void {
        // --- Pomodoro Section (Always visible when enabled, independent of notes) ---
        let pomodoroContainer = container.querySelector<HTMLElement>(".sidebar-pomodoro-section");
        if (!pomodoroContainer) {
            pomodoroContainer = container.createDiv("sidebar-pomodoro-section");
        }

        let pomodoroSectionContainerEl = pomodoroContainer.querySelector<HTMLElement>(".sidebar-pomodoro-section-container");
        if (!pomodoroSectionContainerEl) {
            // Check for legacy class names and migrate if found
            const legacyEl = pomodoroContainer.querySelector<HTMLElement>(".pomodoro-section-container, .sidebar-pomodoro-button-container");
            if (legacyEl) {
                legacyEl.className = "sidebar-pomodoro-section-container";
                pomodoroSectionContainerEl = legacyEl;
            } else {
                pomodoroSectionContainerEl = pomodoroContainer.createDiv("sidebar-pomodoro-section-container");
            }
        }

        // Update Pomodoro section visibility and content
        if (this.pomodoroUIManager && pomodoroSectionContainerEl) {
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

        // --- Previous / next note, under the Pomodoro ---
        let noteNav = container.querySelector<HTMLElement>(".sf-note-nav");
        if (!noteNav) {
            noteNav = container.createDiv({ cls: "sf-note-nav" });
            const previous = noteNav.createEl("button", {
                cls: "sf-note-nav-button",
                attr: { "aria-label": "Previous note", title: "Previous note" },
            });
            setIcon(previous, "chevron-left");
            previous.createSpan({ cls: "sf-note-nav-label", text: "Previous" });
            previous.addEventListener("click", () => {
                void this.plugin.navigationController.navigateToPreviousNote();
            });

            // setIcon replaces the element's children, so it goes first and the
            // label follows it — the other way round silently eats the label.
            const next = noteNav.createEl("button", {
                cls: "sf-note-nav-button",
                attr: { "aria-label": "Next note", title: "Next note" },
            });
            setIcon(next, "chevron-right");
            next.createSpan({ cls: "sf-note-nav-label", text: "Next" });
            next.addEventListener("click", () => {
                void this.plugin.navigationController.navigateToNextNote();
            });
        }

        // --- Review Buttons Section (Only visible when there are notes) ---
        let reviewButtonsContainer = container.querySelector<HTMLElement>(".review-buttons-container");

        // Visibility of review buttons should depend on whether there are notes in the current context (notesForDisplay)
        if (notesForDisplay.length > 0) {
            if (!reviewButtonsContainer) {
                reviewButtonsContainer = container.createDiv("review-buttons-container");
                // The session's actions, behind one three-dot button: start a
                // run, study the decks, walk the list.
                const menuBtn = reviewButtonsContainer.createEl("button", {
                    cls: "review-session-menu",
                    attr: { 'aria-label': "Session actions", title: "Session actions" },
                });
                setIcon(menuBtn, "more-horizontal");
                menuBtn.addEventListener("click", (event) => this.openSessionMenu(event));

                // Background charting status, updated on every refresh.
                reviewButtonsContainer.createDiv("review-chart-status");
            }
            reviewButtonsContainer.classList.remove('sf-hidden');
            this.updateChartStatus(reviewButtonsContainer);

            // Bulk action buttons
            this._ensureBulkActions(container);
            this.updateBulkActionButtonsVisibility(container); // Update visibility based on current selection
        } else if (reviewButtonsContainer) {
            reviewButtonsContainer.classList.add('sf-hidden');
            const bulkActionButtons = container.querySelector<HTMLElement>(".review-bulk-actions");
            if (bulkActionButtons) bulkActionButtons.toggleClass('sf-hidden', true);
        }
    }

    /**
     * The bulk action, under the selection it acts on.
     *
     * The selection says how many notes are chosen and what the work costs, and
     * the one bulk action left is the one that cannot be reached any other way:
     * advancing a note that is still in the future. Reviewing, postponing and
     * removing are per-note decisions, made on the row that owns the note.
     */
    private _ensureBulkActions(container: HTMLElement): void {
        let bulkActionButtons = container.querySelector<HTMLElement>(".review-bulk-actions");
        if (!bulkActionButtons) {
            bulkActionButtons = container.createDiv("review-bulk-actions");

            // What the actions below act on, and what it costs.
            const selectionInfo = bulkActionButtons.createDiv("review-selection-info");
            selectionInfo.createSpan("review-selection-count");
            selectionInfo.createSpan("review-selection-time");

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
        }
    }

    /**
     * The reader's way into the card lane: make a card, or bring cards in.
     *
     * Cards live inside decks, and these are the two things no deck row offers —
     * so they sit in the panel's own language, as labelled rows with an icon:
     * one opens the card editor (which writes a real card into the deck's own
     * storage), the other runs the package import the palette already has, and
     * both report what they did.
     */
    /**
     * Mark the row the run's cursor is on — the same position the bar shows.
     *
     * A step of the run is a note or a deck. While it stands on a note the
     * note's own row wears the marker; while it stands on a deck step
     * {@link ReviewFlowController.currentPath} is null by design (a card step
     * is not a note file), and the row that is marked is the deck the sitting
     * is on — {@link DeckSessionController.currentDeckPath} — found on the list
     * the way a note row is found: by the path the row carries.
     */
    private markRunPosition(container: HTMLElement): void {
        const flow = this.plugin.reviewFlowController;
        const current = flow?.currentPath?.() ?? null;
        const deckPath = flow?.isOnCardsStep?.()
            ? (this.plugin.deckSessionController?.currentDeckPath?.() ?? null)
            : null;

        for (const row of Array.from(container.querySelectorAll<HTMLElement>('.review-note-item[data-note-path]'))) {
            row.toggleClass('is-run-current', current !== null && row.dataset.notePath === current);
        }
        for (const row of Array.from(container.querySelectorAll<HTMLElement>('.sf-deck-row[data-deck-path]'))) {
            row.toggleClass('is-run-current', deckPath !== null && row.dataset.deckPath === deckPath);
        }
    }

    private _ensureAndUpdateCardsSection(container: HTMLElement): void {
        let section = container.querySelector<HTMLElement>(".sf-cards-section");
        if (!section) {
            section = container.createDiv("sf-cards-section");
            section.createDiv("sf-cards-heading").setText("Cards");

            const newCardRow = section.createDiv({
                cls: "sf-cards-row",
                attr: { role: "button", tabindex: "0", title: "Write a new card into one of your decks" },
            });
            const newCardIcon = newCardRow.createSpan("sf-cards-row-icon");
            setIcon(newCardIcon, "plus");
            newCardRow.createSpan({ cls: "sf-cards-row-label", text: "New card" });
            const openEditor = (): void => { new CardEditorModal(this.plugin).open(); };
            newCardRow.addEventListener("click", openEditor);
            newCardRow.addEventListener("keydown", (event) => {
                if (!isRowActivation(event)) return;
                event.preventDefault();
                openEditor();
            });

            const importRow = section.createDiv({
                cls: "sf-cards-row",
                attr: { role: "button", tabindex: "0", title: "Import cards from an Anki package" },
            });
            const importIcon = importRow.createSpan("sf-cards-row-icon");
            setIcon(importIcon, "download");
            importRow.createSpan({ cls: "sf-cards-row-label", text: "Import cards" });
            const runImport = (): void => { void this.plugin.importAnkiPackage(); };
            importRow.addEventListener("click", runImport);
            importRow.addEventListener("keydown", (event) => {
                if (!isRowActivation(event)) return;
                event.preventDefault();
                runImport();
            });
        }
    }

    private _ensureAndUpdateAllCaughtUpMessage(container: HTMLElement, dueNotesForStats: ReviewSchedule[], activeListBaseDate: Date | null): void {
        let caughtUpEl = container.querySelector<HTMLElement>(".review-all-caught-up");
        // The decks count too: "all caught up" while cards are waiting would be a
        // lie, and a small one is still a lie.
        const deckCards = Object.values(this.deckDueToday).reduce((sum, groups) => sum + groups.reduce((n, group) => n + group.cards.length, 0), 0);
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
            caughtUpEl.empty();
            caughtUpEl.createSpan({
                cls: 'review-caught-up-text',
                text: deckCards > 0
                    ? `No notes due — ${deckCards} card${deckCards === 1 ? '' : 's'} waiting in your decks.`
                    : "All caught up! Nothing due today.",
            });

            // The sentence led to the decks without letting the reader follow it.
            // One press starts the sitting, so the day finishes where it points.
            caughtUpEl.toggleClass('is-cards-waiting', deckCards > 0);
            if (deckCards > 0) {
                const study = caughtUpEl.createEl('button', {
                    cls: 'review-caught-up-action',
                    text: `Study ${deckCards} card${deckCards === 1 ? '' : 's'}`,
                });
                study.setAttribute('type', 'button');
                study.addEventListener('click', () => void this.plugin.deckSessionController.startAllDue());
            }
            caughtUpEl.toggleClass('sf-hidden', false);
        } else if (caughtUpEl) {
            caughtUpEl.toggleClass('sf-hidden', true);
        }
    }

    private async _ensureAndUpdateDateSections(container: HTMLElement, sortedDateKeys: string[], groupedNotes: Record<string, ReviewSchedule[]>): Promise<void> {
        await this.loadDeckDue();

        // The decks' days join the notes' days: a day with only cards still gets
        // a section, and the list keeps its own order.
        const daysWithDecks: Record<string, ReviewSchedule[]> = { ...groupedNotes };
        for (const key of Object.keys(this.deckDueToday)) {
            if (!daysWithDecks[key]) daysWithDecks[key] = [];
        }
        const sectionKeys = this.getSortedDateKeys(daysWithDecks);

        const existingSectionElements = Array.from(container.querySelectorAll<HTMLElement>(".review-date-section"));
        const dataKeysFromData = new Set(sectionKeys);
        let notesDisplayed = false;

        // Remove stale sections
        for (const sectionEl of existingSectionElements) {
            const key = sectionEl.dataset.dateKey;
            if (key && !dataKeysFromData.has(key)) {
                sectionEl.remove();
            }
        }

        // Update existing or create new sections
        for (const dateStr of sectionKeys) {
            const notesForSection = groupedNotes[dateStr] ?? [];
            const deckGroups = this.deckDueToday[dateStr] ?? [];
            if (notesForSection.length === 0 && deckGroups.length === 0) continue;
            if (notesForSection.length > 0) notesDisplayed = true;

            let dateSectionEl = container.querySelector<HTMLElement>(`.review-date-section[data-date-key="${dateStr}"]`);
            let notesContainerEl: HTMLElement | null;

            if (!dateSectionEl) {
                dateSectionEl = container.createDiv("review-date-section");
                dateSectionEl.dataset.dateKey = dateStr;

                const headerRow = dateSectionEl.createDiv("review-date-header");
                const headerContainer = headerRow.createDiv("review-date-header-container");
                // A classed div rather than an <h3>: heading elements bring the
                // app's own heading styling into a sidebar row (the docs ask for
                // setHeading() in settings, and this is not settings).
                headerContainer.createDiv({ cls: 'review-date-heading' });

                // "Advance All" button for future sections
                const todayStart = DateUtils.startOfUTCDay(new Date()); // Returns timestamp
                const sectionDateKeyIsFuture = !["Due notes", "Today"].includes(dateStr) &&
                    (notesForSection[0] !== undefined
                        ? DateUtils.startOfUTCDay(new Date(notesForSection[0].nextReviewDate)) > todayStart
                        : dateStr.startsWith('In '));

                if (sectionDateKeyIsFuture) {
                    const advanceAllBtn = headerContainer.createEl("button", { text: "Advance all", cls: "review-date-action-button review-date-advance-all" });
                    advanceAllBtn.title = `Advance all notes in this section by 1 day`;
                    advanceAllBtn.addEventListener("click", () => {
                        const currentNotesForSection = groupedNotes[dateStr] || [];
                        if (currentNotesForSection.length === 0) return;
                        new ConfirmationModal(
                            this.plugin.app,
                            'Advance all notes',
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
                        'Postpone all notes',
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
                notesContainerEl = dateSectionEl.querySelector<HTMLElement>(".review-notes-container");
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

            const headerContainer = dateSectionEl.querySelector<HTMLElement>(".review-date-header-container");
            const dateHeading = headerContainer?.querySelector<HTMLElement>(".review-date-heading");
            const reviewTimeEl = dateSectionEl.querySelector<HTMLElement>(".review-date-time");

            if (!headerContainer || !dateHeading) continue;

            let displayHeader = dateStr;
            const noteCountText = `${notesForSection.length} ${notesForSection.length === 1 ? 'note' : 'notes'}`;
            if (dateStr !== "Due notes" && notesForSection.length > 0) {
                const actualGroupSampleDate = new Date(notesForSection[0].nextReviewDate);
                const formattedActualDate = actualGroupSampleDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                if (["Today", "Tomorrow"].includes(dateStr) || dateStr.startsWith("In ")) {
                    displayHeader = `${dateStr} (${formattedActualDate})`;
                }
                displayHeader += ` - ${noteCountText}`;
            } else if (notesForSection.length > 0) {
                // A day with only cards has no note count to report; the deck
                // rows below it carry their own.
                displayHeader = `${dateStr} - ${noteCountText}`;
            }
            dateHeading.setText(displayHeader);

            let overdueBadge = dateHeading.querySelector<HTMLElement>(".review-overdue-badge");
            const todayActualStart = DateUtils.startOfUTCDay(); // Timestamp for actual today's midnight

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
                        const referenceDateForDiff = baseDate ? DateUtils.startOfUTCDay(baseDate) : todayActualStart;
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
            if (reviewTimeEl) {
                // The day's whole debt, both lanes, in the one place the header
                // has for it: "3 notes · 14 cards · ~18 min".
                const sectionCards = deckGroups.reduce((sum, group) => sum + group.cards.length, 0);
                const parts: string[] = [];
                if (notesForSection.length > 0) parts.push(`${notesForSection.length} note${notesForSection.length === 1 ? '' : 's'}`);
                if (sectionCards > 0) parts.push(`${sectionCards} card${sectionCards === 1 ? '' : 's'}`);
                const totalSeconds = sectionTime + this.cardSeconds(sectionCards);
                const time = totalSeconds > 0 ? ` · ~${EstimationUtils.formatTime(totalSeconds)}` : '';
                reviewTimeEl.setText(parts.length > 0 ? `${parts.join(' · ')}${time}` : '');
            }

            await this._updateOrRenderNoteList(notesContainerEl, notesForSection, dateStr, container);

            // The decks that owe something on this day, under the notes they
            // share it with.
            this.deckRows().renderDay(notesContainerEl, deckGroups);
        }

        // Decks that owe nothing sit at the end, quietly, so every deck and every
        // question stays findable on a day with no cards due at all.
        let restingEl = container.querySelector<HTMLElement>(".review-resting-decks");
        if (this.restingDecks.length > 0) {
            if (!restingEl) restingEl = container.createDiv("review-resting-decks");
            this.deckRows().renderResting(restingEl, this.restingDecks);
        } else if (restingEl) {
            restingEl.remove();
        }

        // Message for activeListBaseDate with no notes
        let noNotesForDateMsg = container.querySelector<HTMLElement>(".review-no-notes-for-date");
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
        let sessionSection = container.querySelector<HTMLElement>(".review-session-section");

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
                continueBtn.addEventListener("click", () => {
                    // Continuing means bringing the review bar back, positioned on
                    // the note the stored session is sitting on.
                    const session = this.plugin.reviewSessionService.getActiveSession();
                    const currentPath = session?.hierarchy?.traversalOrder?.[session.currentIndex];
                    if (this.plugin.reviewFlowController.isActive()) {
                        this.plugin.reviewFlowController.refreshCurrent();
                        return;
                    }
                    this.plugin.reviewFlowController.start(currentPath);
                });
                const endBtn = sessionSection.createEl("button", { text: "End session", cls: "review-session-end" });
                endBtn.addEventListener("click", () => {
                    this.plugin.reviewSessionService.setActiveSession(null);
                    void this.refreshSidebarView();
                });
            }
            sessionSection.toggleClass('sf-hidden', false);
            const nameEl = sessionSection.querySelector<HTMLElement>(".review-session-name");
            if (nameEl) nameEl.setText(activeSession.name);

            const progressEl = sessionSection.querySelector<HTMLElement>(".review-session-progress");
            if (progressEl) progressEl.setText(`Progress: ${activeSession.currentIndex}/${activeSession.hierarchy.traversalOrder.length}`);

            const progressBar = sessionSection.querySelector<HTMLElement>(".review-session-progress-bar");
            if (progressBar) {
                const progressPercent = Math.min(100, Math.round((activeSession.currentIndex / activeSession.hierarchy.traversalOrder.length) * 100));
                // The width is data, not styling: it goes in as a custom property
                // that the stylesheet reads, so a theme can still restyle the bar.
                progressBar.setCssProps({ '--sf-session-progress': `${progressPercent}%` });
            }
        } else if (sessionSection) {
            sessionSection.toggleClass('sf-hidden', true);
        }
    }

    private async _ensureAndUpdateUpcomingReviewsSection(container: HTMLElement): Promise<void> {
        await this.loadDeckDue();
        const allSchedules = Object.values(this.plugin.reviewScheduleService.schedules);
        const upcomingGroupedNotes = await this.groupNotesByDate(allSchedules, true);
        // Days that owe cards alone are days too.
        const upcomingWithDecks: Record<string, ReviewSchedule[]> = { ...upcomingGroupedNotes };
        for (const key of Object.keys(this.deckDueFuture)) {
            if (!upcomingWithDecks[key]) upcomingWithDecks[key] = [];
        }
        const upcomingKeys = this.getSortedDateKeys(upcomingWithDecks)
            .filter(key => {
                if (key === 'Due notes') return false;
                const actualTodayStart = DateUtils.startOfUTCDay(new Date());
                if (key === DateUtils.formatDate(actualTodayStart, 'relative', null)) return false; // Exclude "Today" if it's empty or handled by main list
                if (key === DateUtils.formatDate(DateUtils.addDays(actualTodayStart, 1), 'relative', null)) return false; // Exclude "Tomorrow"
                return true;
            });

        let upcomingSection = container.querySelector<HTMLElement>(".review-upcoming-section");

        if (upcomingKeys.length > 0) {
            if (!upcomingSection) {
                upcomingSection = container.createDiv("review-upcoming-section");
                new Setting(upcomingSection).setHeading().setName("Upcoming reviews");
                upcomingSection.createDiv("review-upcoming-list"); // List container
            }
            upcomingSection.toggleClass('sf-hidden', false);
            const upcomingListEl = upcomingSection.querySelector<HTMLElement>(".review-upcoming-list");
            if (!upcomingListEl) return; // Should not happen

            const existingDayItemElements = Array.from(upcomingListEl.querySelectorAll<HTMLElement>(".review-upcoming-day"));


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

                let dayItemEl = upcomingListEl.querySelector<HTMLElement>(`.review-upcoming-day[data-day-key="${dayKey}"]`);
                if (!dayItemEl) {
                    dayItemEl = upcomingListEl.createDiv("review-upcoming-day");
                    dayItemEl.addClass("clickable");
                    dayItemEl.dataset.dayKey = dayKey;
                    const daySummary = dayItemEl.createDiv("review-upcoming-day-summary");
                    daySummary.createSpan({ cls: "review-upcoming-day-name" }); // Placeholder for name

                    dayItemEl.addEventListener("click", (e) => { // Attach listener once
                        const currentDayKey = (e.currentTarget as HTMLElement).dataset.dayKey;
                        if (!currentDayKey) return;
                        const expandedUpcomingDayKey = this.getExpandedUpcomingDayKey();
                        const isCurrentlyExpanded = expandedUpcomingDayKey === currentDayKey;
                        this.setExpandedUpcomingDayKey(isCurrentlyExpanded ? null : currentDayKey);
                        // Visual state and note list rendering will be handled by the main render pass
                        void this.refreshSidebarView(); // Trigger a re-render to reflect expansion
                    });
                }

                // Update summary
                const daySummaryNameEl = dayItemEl.querySelector<HTMLElement>(".review-upcoming-day-summary .review-upcoming-day-name");
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
                if (daySummaryNameEl) {
                    const dayCards = (this.deckDueFuture[dayKey] ?? []).reduce((sum, group) => sum + group.cards.length, 0);
                    const parts: string[] = [];
                    if (notesForDay.length > 0) parts.push(`${notesForDay.length} ${notesForDay.length === 1 ? 'note' : 'notes'}`);
                    if (dayCards > 0) parts.push(`${dayCards} card${dayCards === 1 ? '' : 's'}`);
                    daySummaryNameEl.setText(`${upcomingDisplayHeader}: ${parts.join(' · ')}`);
                }

                // Handle expanded state
                const isExpanded = this.getExpandedUpcomingDayKey() === dayKey;
                dayItemEl.classList.toggle("is-expanded", isExpanded);
                let notesContainerEl = dayItemEl.querySelector<HTMLElement>(".review-upcoming-notes-container");

                if (isExpanded) {
                    if (!notesContainerEl) {
                        notesContainerEl = dayItemEl.createDiv("review-upcoming-notes-container");
                    }
                    notesContainerEl.toggleClass('sf-hidden', false);
                    await this._updateOrRenderNoteList(notesContainerEl, notesForDay, dayKey, container);
                    this.deckRows().renderDay(notesContainerEl, this.deckDueFuture[dayKey] ?? []);
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
        const existingNoteElements = Array.from(notesContainer.querySelectorAll<HTMLElement>('.review-note-item[data-note-path]'));
        const existingNotesMap = new Map(existingNoteElements.map(el => [el.dataset.notePath, el]));
        const notesInOrder: HTMLElement[] = [];
        const processedPaths = new Set<string>();

        const lastSelectedNotePath = this.getLastSelectedNotePath();
        const lastSelectedNotePathRef = { current: lastSelectedNotePath };

        for (const note of notes) {
            // Guard against duplicate entries in the provided list; a path must
            // only ever produce a single note item in the container.
            if (processedPaths.has(note.path)) continue;
            processedPaths.add(note.path);

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
                    async () => { await this.handleNoteAction(); }
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
     * Show what the background charting queue is doing, if anything.
     *
     * Charting is invisible by design (nobody should watch it), but silently
     * burning model calls is worse, so the sidebar says what is happening and
     * offers a pause.
     */
    private updateChartStatus(container: HTMLElement): void {
        const statusEl = container.querySelector<HTMLElement>('.review-chart-status');
        if (!statusEl) return;
        const queue = this.plugin.studyChartQueue;
        if (!queue || !this.plugin.settings.studyEnabled) {
            statusEl.empty();
            statusEl.addClass('sf-hidden');
            return;
        }

        const status = queue.getStatus();
        const anyWork = status.queued > 0 || status.active !== null || status.problems.length > 0;
        if (!anyWork) {
            statusEl.empty();
            statusEl.addClass('sf-hidden');
            return;
        }
        statusEl.removeClass('sf-hidden');
        statusEl.empty();

        const icon = statusEl.createSpan('review-chart-status-icon');
        setIcon(icon, status.problems.length > 0 && status.queued === 0 ? 'alert-circle' : status.paused ? 'pause-circle' : 'loader');
        statusEl.createDiv({ cls: 'review-chart-status-text', text: status.message || `${status.queued} note(s) queued for charting` });

        if (status.problems.length > 0 && status.queued === 0) {
            const retry = statusEl.createEl('button', { text: 'Retry', cls: 'review-chart-status-button' });
            const first = status.problems[0];
            retry.setAttribute('title', `Retry charting ${first.path.split('/').pop() ?? first.path}: ${first.reason}`);
            retry.addEventListener('click', () => {
                queue.retry(first.path);
                void queue.tick();
            });
        } else if (status.paused) {
            const resume = statusEl.createEl('button', { text: 'Resume', cls: 'review-chart-status-button' });
            resume.addEventListener('click', () => {
                queue.resume();
                void queue.tick();
            });
        } else if (status.queued > 0) {
            const pause = statusEl.createEl('button', { text: 'Pause', cls: 'review-chart-status-button' });
            pause.setAttribute('title', 'Stop charting notes in the background for now');
            pause.addEventListener('click', () => {
                queue.pause('paused from the sidebar');
                void this.refreshSidebarView();
            });
        }
    }

    /** The deck rows, built once: they hold the reader's open/closed choices. */
    private deckRows(): DeckRowView {
        if (!this.deckRowRenderer) {
            this.deckRowRenderer = new DeckRowView(this.plugin, {
                studyDeck: path => void this.plugin.deckSessionController.start(path),
                studyCard: (path, cardId) => void this.plugin.deckSessionController.start(path, { fromCardId: cardId }),
                openDeck: path => {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile) void this.plugin.app.workspace.getLeaf().openFile(file);
                },
            });
        }
        return this.deckRowRenderer;
    }

    /**
     * Work out what every deck owes, and on which day.
     *
     * A deck's cards keep Anki's own due conventions — a review card is due on a
     * day counted from the collection's creation, a card in learning at an exact
     * moment, a new card now — so each card is placed on the day it belongs to
     * and then grouped under its own deck. The result is keyed by the very same
     * strings the note list uses ("Due notes", "Today", …), which is what lets
     * the deck rows sit inside the note sections instead of beside them.
     *
     * Deck files are read once per version: a sidebar refresh happens for every
     * note change, and re-parsing every deck each time would be wasteful.
     */
    private async loadDeckDue(): Promise<void> {
        const now = Date.now();
        // Cheap when nothing has changed: several parts of a render ask for this.
        if (this.deckDueCountedAt > 0 && now - this.deckDueCountedAt < 1000) return;
        let decks: DeckSummary[] = [];
        try {
            decks = await this.plugin.deckStore.listDecks();
        } catch (error) {
            console.error('spaceforge: could not list the decks', error);
            return;
        }

        const today: Record<string, DeckDueGroup[]> = {};
        const future: Record<string, DeckDueGroup[]> = {};
        const resting: RestingDeck[] = [];
        let dueToday = 0;

        for (const summary of decks) {
            let entry = this.deckCardCache.get(summary.path);
            if (!entry || entry.modified !== summary.modified) {
                let bundle: DeckBundle;
                try {
                    bundle = await this.plugin.deckStore.readDeck(summary.path);
                } catch (error) {
                    console.error(`spaceforge: could not read ${summary.path} for the sidebar`, error);
                    continue;
                }
                entry = this.cacheDeck(summary.modified, bundle);
                this.deckCardCache.set(summary.path, entry);
            }

            const deckEntry = entry;
            const todayStart = DateUtils.startOfUTCDay(new Date(now));

            // Today's cards come from the deck's own queue, so what the sidebar
            // promises is exactly what "study this deck" will hand over — daily
            // caps, sibling burying and all. Later days come from the due dates
            // themselves, because a cap resets and tomorrow's cards are not
            // today's business.
            const queued = buildQueue(deckEntry.cards, deckEntry.options, now, deckEntry.dayBase, undefined, deckEntry.deckId);
            const dayOf = new Map<AnkiId, number>();
            const todayGroup: DeckDueGroup = {
                path: summary.path,
                name: deckEntry.deckName,
                cards: [],
                time: this.cardEstimate(queued.length),
            };
            for (const card of queued) {
                const dayStart = this.dueDayStart(card, deckEntry.dayBase, now);
                dayOf.set(card.id, dayStart);
                todayGroup.cards.push({
                    cardId: card.id,
                    front: deckEntry.fronts.get(card.id) ?? '',
                    state: describeCardState(card, deckEntry.dayBase, now),
                });
            }

            const futureGroups = new Map<string, DeckDueGroup>();
            for (const card of deckEntry.cards) {
                if (
                    card.queue === AnkiCardQueue.Suspended ||
                    card.queue === AnkiCardQueue.SchedBuried ||
                    card.queue === AnkiCardQueue.UserBuried ||
                    card.queue === AnkiCardQueue.New ||
                    card.queue === AnkiCardQueue.Learning
                ) {
                    continue;
                }
                const dayStart = this.dueDayStart(card, deckEntry.dayBase, now);
                if (dayStart <= todayStart) continue;
                const key = relativeDayKey(dayStart, now);
                let group = futureGroups.get(key);
                if (!group) {
                    group = { path: summary.path, name: deckEntry.deckName, cards: [] };
                    futureGroups.set(key, group);
                }
                group.cards.push({
                    cardId: card.id,
                    front: deckEntry.fronts.get(card.id) ?? '',
                    state: describeCardState(card, deckEntry.dayBase, now),
                });
            }

            if (todayGroup.cards.length > 0) {
                // Overdue cards read as "Due notes": the grouping is what says
                // they are late, and the day they fall on is not a lie either.
                const overdue = todayGroup.cards.some(card => (dayOf.get(card.cardId) ?? todayStart) < todayStart);
                const key = overdue ? 'Due notes' : 'Today';
                (today[key] ??= []).push(todayGroup);
                dueToday += todayGroup.cards.length;
            }

            if (todayGroup.cards.length === 0 && futureGroups.size === 0) {
                resting.push({ path: summary.path, name: deckEntry.deckName, nextDue: null });
                continue;
            }

            for (const [key, group] of futureGroups) {
                group.time = this.cardEstimate(group.cards.length);
                (future[key] ??= []).push(group);
            }
        }

        this.deckDueToday = today;
        this.deckDueFuture = future;
        this.restingDecks = resting;
        this.deckDueTotal = dueToday;
        this.deckDueCountedAt = now;
        // The review bar's card button reads this, so the count lives on the
        // plugin: one place counts, everyone else reads.
        this.plugin.deckDueCount = dueToday;
        this.plugin.deckDueCountedAt = now;
        // Which decks, not just how many cards: the review bar's navigation
        // counts a step per deck, so it needs the decks themselves.
        const decksWithDue = new Set<string>();
        for (const groups of Object.values(today)) {
            for (const group of groups) decksWithDue.add(group.path);
        }
        this.plugin.deckDueDecks = Array.from(decksWithDue);
    }

    /** Read a deck once: what each card says, and the day its numbers count from. */
    private cacheDeck(modified: number, bundle: DeckBundle): CachedDeck {
        const noteById = new Map(bundle.notes.map(note => [note.id, note]));
        const fronts = new Map<string, string>();
        for (const card of bundle.cards) {
            const note = noteById.get(card.noteId);
            if (!note) {
                fronts.set(card.id, '');
                continue;
            }
            // Flattened and trimmed here, once: a row is a line of text, and a
            // card whose front is only a picture has to say so rather than read
            // as an empty row.
            const raw = resolvePresentation(note, card).front;
            const flat = truncateQuestion(raw);
            fronts.set(card.id, flat.length > 0 ? flat : '(a picture)');
        }
        const created = bundle.extra?.crt;
        return {
            modified,
            deckName: displayDeckName(bundle.deck.name),
            deckId: bundle.deck.id,
            options: bundle.deck.options,
            dayBase: deckDayBase(bundle.deck.id, typeof created === 'number' ? created : null),
            cards: bundle.cards,
            fronts,
        };
    }

        /** What a set of cards is taken to take, from the reader's own setting. */
    private cardEstimate(count: number): string {
        const perCard = Number(this.plugin.settings.deckMinutesPerCard);
        if (!Number.isFinite(perCard) || perCard <= 0) return '';
        return EstimationUtils.formatTime(Math.round(count * perCard * 60));
    }

    /** How many seconds those cards are taken to take, for a day's total. */
    private cardSeconds(count: number): number {
        const perCard = Number(this.plugin.settings.deckMinutesPerCard);
        if (!Number.isFinite(perCard) || perCard <= 0) return 0;
        return count * perCard * 60;
    }

    /** The day a card is owed: now for a new card, a day number for a review. */
    private dueDayStart(card: AnkiCard, dayBase: number, now: number): number {
        if (card.queue === AnkiCardQueue.New) return DateUtils.startOfUTCDay(new Date(now));
        if (card.queue === AnkiCardQueue.Learning) return DateUtils.startOfUTCDay(new Date(card.due));
        return DateUtils.startOfUTCDay(new Date(dayBase + card.due * DAY_MS));
    }

    private openSessionMenu(event: MouseEvent): void {
        const menu = new Menu();

        menu.addItem(item => item
            .setTitle("Review current note")
            .setIcon("play")
            .onClick(() => { void this.plugin.reviewController.reviewCurrentNote(); }));

        // The deck lane, where a reader looks for session actions — the same
        // place the note actions live, rather than a second menu of its own.
        if ((this.deckDueTotal ?? 0) > 0) {
            const due = this.deckDueTotal as number;
            menu.addItem(item => item
                .setTitle(`Study ${due} card${due === 1 ? '' : 's'} due`)
                .setIcon("layers")
                .onClick(() => { void this.plugin.deckSessionController.startAllDue(); }));
        }
        menu.addItem(item => item
            .setTitle("Study a deck…")
            .setIcon("layers")
            .onClick(() => { void this.plugin.chooseDeckToStudy(); }));
        menu.addItem(item => item
            .setTitle("Review all due notes")
            .setIcon("list")
            .onClick(() => { void this.plugin.reviewController.reviewAllTodaysNotes(); }));

        if (this.plugin.settings.enableMCQ) {
            menu.addItem(item => item
                .setTitle("Review all with questions")
                .setIcon("list-checks")
                .onClick(() => { this.plugin.reviewController.reviewAllNotesWithMCQ(true); }));
        }

        if (this.plugin.settings.studyEnabled && this.plugin.studyController) {
            menu.addItem(item => item
                .setTitle("Study this note")
                .setIcon("graduation-cap")
                .onClick(() => { this.openStudyForBestCandidate(); }));
        }

        menu.addSeparator();
        menu.addItem(item => item
            .setTitle("Previous note")
            .setIcon("arrow-left")
            .onClick(() => { void this.plugin.reviewController.navigateToPreviousNote(); }));
        menu.addItem(item => item
            .setTitle("Next note")
            .setIcon("arrow-right")
            .onClick(() => { void this.plugin.reviewController.navigateToNextNote(); }));

        menu.showAtMouseEvent(event);
    }

    /**
     * Pick the most useful note to study from wherever the user is standing:
     * an explicit selection first, then the open note, then the first due note.
     */
    private openStudyForBestCandidate(): void {
        const controller = this.plugin.studyController;
        if (!controller) return;

        const status = controller.status();
        if (!status.ok) {
            new Notice(`Study is not available: ${status.reason}`);
            return;
        }

        const selected = this.getSelectedNotes();
        if (selected.length > 0) {
            controller.openStudy(selected[0]);
            return;
        }

        const active = this.plugin.app.workspace.getActiveFile();
        if (active && active.extension === 'md') {
            controller.openStudy(active.path);
            return;
        }

        const due = this.plugin.reviewController.getTodayNotes();
        if (due.length > 0) {
            controller.openStudy(due[0].path);
            return;
        }

        new Notice('Select a note in the list, or open one, then try again.');
    }

    private handleSelectionChange(container: HTMLElement): void {
        this.updateSelectionClasses(container);
        this.updateBulkActionButtonsVisibility(container);
        void this.updateSelectionInfo(container);
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
        const allNoteElements = container.querySelectorAll<HTMLElement>('.review-note-item[data-note-path]');
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
     * Updates the selection info display with count and cumulative time.
     * (Called by handleSelectionChange)
     */
    private async updateSelectionInfo(container: HTMLElement): Promise<void> {
        const selectedNotesPaths = this.getSelectedNotes();
        const bulkActionsContainer = container.querySelector<HTMLElement>('.review-bulk-actions');
        
        if (bulkActionsContainer && selectedNotesPaths.length > 0) {
            let selectionInfo = bulkActionsContainer.querySelector<HTMLElement>('.review-selection-info');
            if (!selectionInfo) {
                selectionInfo = bulkActionsContainer.createDiv('review-selection-info');
                selectionInfo.createSpan('review-selection-count');
                selectionInfo.createSpan('review-selection-time');
            }
            
            const countSpan = selectionInfo.querySelector('.review-selection-count');
            const timeSpan = selectionInfo.querySelector('.review-selection-time');
            
            if (countSpan && timeSpan) {
                // Update count
                countSpan.setText(`${selectedNotesPaths.length} ${selectedNotesPaths.length === 1 ? 'note' : 'notes'} selected`);
                
                // Calculate cumulative time
                let totalTime = 0;
                for (const path of selectedNotesPaths) {
                    totalTime += await this.plugin.reviewScheduleService.estimateReviewTime(path);
                }
                
                // Update time display
                timeSpan.setText(`(${EstimationUtils.formatTime(totalTime)})`);
            }
        }
    }

    /**
     * Updates the visibility of the bulk action buttons based on selection count.
     * (Called by handleSelectionChange and render)
     */
     private updateBulkActionButtonsVisibility(container: HTMLElement): void {
         const selectedNotesPaths = this.getSelectedNotes();
         const bulkActionsContainer = container.querySelector<HTMLElement>('.review-bulk-actions');
         if (bulkActionsContainer) {
             bulkActionsContainer.toggleClass('sf-hidden', selectedNotesPaths.length <= 1);

             // Handle visibility/disabled state of "Advance Selected" button
             const advanceSelectedBtn = bulkActionsContainer.querySelector<HTMLButtonElement>('.review-bulk-advance');
             if (advanceSelectedBtn) {
                 if (selectedNotesPaths.length > 1) {
                     const todayStart = DateUtils.startOfUTCDay(new Date()); // Returns timestamp
                     const hasEligibleFutureNote = selectedNotesPaths.some(path => {
                         const schedule = this.plugin.reviewScheduleService.schedules[path];
                         return schedule && DateUtils.startOfUTCDay(new Date(schedule.nextReviewDate)) > todayStart;
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
      * Setup drag-and-drop event handlers for the container
      */
     private setupDragAndDrop(container: HTMLElement): void {
         // Attach the drag-and-drop listeners only once; render() runs on every
         // refresh, and stacking duplicate handlers would run actions repeatedly.
         if (this.dragAndDropInitialized) return;
         this.dragAndDropInitialized = true;

         // Track the current drag target for visual feedback
         let currentDragTarget: HTMLElement | null = null;
         
         // Add drag-over event handler - only prevent default to allow drop
         container.addEventListener('dragover', (e) => {
             // Just allow the drop, don't do expensive calculations here
             e.preventDefault();
         });

        // Add drop event handler
        container.addEventListener('drop', (e) => {
            e.preventDefault();
            void (async () => {
                const draggedPath = e.dataTransfer?.getData('text/plain');
                if (!draggedPath) return;

                // Find the drop target note item
                const target = e.target as HTMLElement;
                const noteItem = target.closest<HTMLElement>('.review-note-item');

                if (!noteItem) return;

                const targetPath = noteItem.dataset.notePath;
                if (!targetPath || draggedPath === targetPath) return;

                // Get due notes to initialize custom order if needed
                const dueNotes = this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true);

                // Initialize custom order if empty - use current display order
                let currentOrder = [...this.plugin.reviewScheduleService.customNoteOrder];
                if (currentOrder.length === 0) {
                    // Use the order of currently displayed due notes
                    currentOrder = dueNotes.map(n => n.path);
                }

                // Ensure both paths are in the order
                if (!currentOrder.includes(draggedPath)) {
                    currentOrder.push(draggedPath);
                }
                if (!currentOrder.includes(targetPath)) {
                    currentOrder.push(targetPath);
                }

                // Find positions
                const draggedIndex = currentOrder.indexOf(draggedPath);
                const targetIndex = currentOrder.indexOf(targetPath);

                if (draggedIndex === -1 || targetIndex === -1) return;

                // Remove dragged from current position
                currentOrder.splice(draggedIndex, 1);

                // Calculate insert position based on mouse Y relative to target
                const rect = noteItem.getBoundingClientRect();
                const insertIndex = e.clientY < rect.top + rect.height / 2
                    ? targetIndex
                    : targetIndex + 1;

                // Insert at new position
                currentOrder.splice(insertIndex, 0, draggedPath);

                // Update and save
                await this.plugin.reviewScheduleService.updateCustomNoteOrder(currentOrder);
                await this.plugin.savePluginData();

                // Refresh view
                await this.refreshSidebarView();
            })();
        });

        // Add drag-enter for visual feedback
         container.addEventListener('dragenter', (e) => {
             const target = e.target as HTMLElement;
             const noteItem = target.closest('.review-note-item') as HTMLElement | null;
             
             if (noteItem && noteItem !== currentDragTarget) {
                 // Clear previous target
                 if (currentDragTarget) {
                     currentDragTarget.classList.remove('drag-over');
                 }
                 // Set new target
                 currentDragTarget = noteItem;
                 noteItem.classList.add('drag-over');
             }
         });

         // Add drag-leave event handler
         container.addEventListener('dragleave', (e) => {
             const target = e.target as HTMLElement;
             const noteItem = target.closest('.review-note-item') as HTMLElement | null;
             
             if (noteItem && noteItem === currentDragTarget) {
                 // Check if we're actually leaving the element, not just entering a child
                 const relatedTarget = e.relatedTarget as HTMLElement;
                 if (!noteItem.contains(relatedTarget)) {
                     noteItem.classList.remove('drag-over');
                     currentDragTarget = null;
                 }
             }
         });

         // Clean up on drag end
         container.addEventListener('dragend', () => {
             if (currentDragTarget) {
                 currentDragTarget.classList.remove('drag-over');
                 currentDragTarget = null;
             }
             // Clear all drag-over classes as safety
             container.querySelectorAll('.review-note-item.drag-over').forEach(el => {
                 el.classList.remove('drag-over');
             });
         });
     }

    /**
     * Updates the main header statistics display.
     */
    private async updateHeaderStats(container: HTMLElement): Promise<void> {
        const headerStatsEl = container.querySelector('.review-stats-list-view .review-stats-count');
        if (!headerStatsEl) return;

        const dueNotesForStats = this.plugin.reviewScheduleService.getDueNotesWithCustomOrder(Date.now(), true);
        const overdueNotes = dueNotesForStats.filter(note => note.nextReviewDate < DateUtils.startOfUTCDay());
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
            const headerTextEl = sectionEl.querySelector('.review-date-header-container .review-date-heading');
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

                let overdueBadge = headerTextEl.querySelector(".review-overdue-badge");
                if (dateStr === "Due notes") {
                    const daysDiff = notesInSection.map(noteEl => {
                        const path = (noteEl as HTMLElement).dataset.notePath;
                        const noteSchedule = path ? this.plugin.reviewScheduleService.schedules[path] : null;
                        return noteSchedule ? Math.abs(Math.floor((noteSchedule.nextReviewDate - DateUtils.startOfUTCDay()) / (24 * 60 * 60 * 1000))) : 0;
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
        const actualTodayStart = DateUtils.startOfUTCDay(new Date());
        const activeListBaseDate = this.getActiveListBaseDate();
        const refDateForFilteringStart = activeListBaseDate ? DateUtils.startOfUTCDay(new Date(activeListBaseDate)) : actualTodayStart;

        for (const note of notes) {
            const noteDate = new Date(note.nextReviewDate);
            const noteDateStart = DateUtils.startOfUTCDay(noteDate); // Timestamp for note's due day midnight (UTC)

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

            if (aIsSpecial && bIsSpecial) return dateOrder[a] - dateOrder[b];
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
