import { Notice, TFile } from 'obsidian';
import SpaceforgePlugin from '../main';
import { ReviewResponse, ReviewSchedule, FsrsRating } from '../models/review-schedule'; // Added FsrsRating
import { IReviewController } from './interfaces';
import { ReviewModal } from '../ui/review-modal';

/**
 * Core controller that handles the review process
 */
export class ReviewControllerCore implements IReviewController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Currently loaded notes due for review
     */
    private todayNotes: ReviewSchedule[] = [];

    /**
     * Current index in today's notes
     */
    private currentNoteIndex = 0;

    /**
     * Cache of linked notes to improve performance
     */
    private linkedNoteCache: Map<string, string[]> = new Map();

    /**
     * Traversal order of notes for hierarchical navigation
     */
    private traversalOrder: string[] = [];

    /**
     * Map of paths to their position in the traversal order
     * Used for fast lookups during navigation
     */
    private traversalPositions: Map<string, number> = new Map();

    /**
     * Optional override for the current date, for testing or reviewing past/future notes.
     * If null, Date.now() is used.
     */
    private currentReviewDateOverride: number | null = null;

    /**
     * Initialize review controller
     *
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
        // Initialize today's notes
        this.updateTodayNotes();
    }

    /**
     * Sets an override for the current review date.
     * @param date Timestamp of the date to simulate, or null to use actual Date.now().
     */
    public setReviewDateOverride(date: number | null): void {
        this.currentReviewDateOverride = date;
        this.updateTodayNotes(); // Ensure notes are updated when the override changes
    }

    /**
     * Gets the effective review date (override or actual Date.now()).
     * @returns Timestamp for the effective review date.
     */
    private getEffectiveReviewDate(): number {
        return this.currentReviewDateOverride ?? Date.now();
    }

    /**
     * Gets the current review date override.
     * @returns Timestamp of the override, or null if no override is set.
     */
    public getCurrentReviewDateOverride(): number | null {
        return this.currentReviewDateOverride;
    }

    /**
     * Get the currently loaded notes due for review
     */
    getTodayNotes(): ReviewSchedule[] {
        return this.todayNotes;
    }

    /**
     * Get the current index in today's notes
     */
    getCurrentNoteIndex(): number {
        return this.currentNoteIndex;
    }

    /**
     * Set the current index in today's notes
     *
     * @param index The new index
     */
    setCurrentNoteIndex(index: number): void {
        // Ensure index is within bounds
        if (index >= 0 && index < this.todayNotes.length) {
            this.currentNoteIndex = index;
        } else {
            // Optionally clamp the index or handle the error differently
            this.currentNoteIndex = Math.max(0, Math.min(index, this.todayNotes.length - 1));
        }
    }

    /**
     * Update the list of today's due notes
     *
     * @param preserveCurrentIndex Whether to try to preserve the current note index
     */
    updateTodayNotes(preserveCurrentIndex = false): void {
        // Store current note path if we want to preserve the index
        let currentNotePath: string | null = null;
        if (preserveCurrentIndex && this.todayNotes.length > 0 && this.currentNoteIndex < this.todayNotes.length) {
            currentNotePath = this.todayNotes[this.currentNoteIndex].path;
        }

        // Clear all cached data
        this.linkedNoteCache.clear();
        this.traversalOrder = [];
        this.traversalPositions.clear();

        // Get the latest due notes from storage, already sorted by custom order (if available)
        // by getDueNotesWithCustomOrder, using the effective review date.
        const effectiveDate = this.getEffectiveReviewDate();
        // If currentReviewDateOverride is set, we are viewing a specific date from the calendar, so match exactly.
        // Otherwise (override is null), we are in the default "today" view, so get all notes due up to today.
        const matchExactDate = this.currentReviewDateOverride !== null;

        let newDueNotes: ReviewSchedule[];

        if (matchExactDate) {
            // Calendar view: Get notes for the specific date
            newDueNotes = this.plugin.dataStorage.reviewScheduleService.getDueNotesWithCustomOrder(effectiveDate, true, true);
        } else {
            // Default view: Get notes due up to today AND notes for today's date
            const dueNotes = this.plugin.dataStorage.reviewScheduleService.getDueNotesWithCustomOrder(effectiveDate, true, false);
            const todayOnlyNotes = this.plugin.dataStorage.reviewScheduleService.getDueNotesWithCustomOrder(effectiveDate, true, true);

            const combinedNotes = [...dueNotes, ...todayOnlyNotes];
            const uniqueNotes = new Map<string, ReviewSchedule>();
            for (const note of combinedNotes) {
                if (!uniqueNotes.has(note.path)) {
                    uniqueNotes.set(note.path, note);
                }
            }
            newDueNotes = Array.from(uniqueNotes.values());
        }

        this.todayNotes = newDueNotes;

        // The traversal order should directly reflect the order of todayNotes,
        // which respects the custom order followed by any remaining due notes.
        this.traversalOrder = this.todayNotes.map(note => note.path);

        // Rebuild positions map based on the final traversalOrder
        this.traversalPositions = new Map();
        this.traversalOrder.forEach((path, index) => {
            this.traversalPositions.set(path, index);
        });

        // Reset the note index unless we want to preserve it
        if (!preserveCurrentIndex) {
            this.currentNoteIndex = 0;
        }

        // Clear the link cache to ensure fresh data
        this.linkedNoteCache.clear();

        // No notes to process? Return early
        if (this.todayNotes.length === 0) {
            return;
        }

        // If we want to preserve the current index, try to find the same note
        if (preserveCurrentIndex && currentNotePath) {
            const newIndex = this.todayNotes.findIndex(note => note.path === currentNotePath);
            if (newIndex !== -1) {
                this.currentNoteIndex = newIndex;
            } else {
                // If the note is no longer in the list, reset to the beginning
                this.currentNoteIndex = 0;
            }

            // If the previous note is no longer in the list, reset to the beginning or nearest valid index
            this.currentNoteIndex = Math.min(Math.max(0, newIndex), this.todayNotes.length - 1);
        }

    }

    /**
     * Review the current note
     */
    async reviewCurrentNote(): Promise<void> {
        if (this.todayNotes.length === 0) {
            this.updateTodayNotes();
            if (this.todayNotes.length === 0) {
                new Notice("No notes due for review today!");
                return;
            }
        }

        const note = this.todayNotes[this.currentNoteIndex];
        await this.reviewNote(note.path);
    }

    /**
     * Start a review for a note
     *
     * @param path Path to the note file
     */
    async reviewNote(path: string): Promise<void> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice("Cannot review: file not found");
            return;
        }

        // Open the file
        await this.plugin.app.workspace.getLeaf().openFile(file);

        // Show review modal when file is opened
        this.showReviewModal(path);
    }

    /**
     * Postpone a note's review
     *
     * @param path Path to the note file
     * @param days Number of days to postpone (default: 1)
     */
    async postponeNote(path: string, days = 1): Promise<void> {
        // Store the current note path to potentially adjust currentNoteIndex later
        this.plugin.dataStorage.reviewScheduleService.postponeNote(path, days); // Corrected to call service via dataStorage
        await this.plugin.savePluginData();

        // Explicitly update navigation state in controller to ensure UI consistency
        this.handleNotePostponed(path);

        // Refresh the sidebar view if available
        void this.plugin.getSidebarView()?.refresh();
        // Notice is handled by the service for postponeNote
    }

    /**
     * Advance a note's review by one day, if eligible.
     *
     * @param path Path to the note file
     */
    async advanceNote(path: string): Promise<void> {
        const advanced = this.plugin.dataStorage.reviewScheduleService.advanceNote(path);

        if (advanced) {
            await this.plugin.savePluginData();
            this.handleNoteAdvanced(path); // New handler for advancing

            void this.plugin.getSidebarView()?.refresh();
            new Notice(`Note advanced.`); // Controller handles notice for advance
        } else {
            new Notice(`Note is not eligible to be advanced.`);
        }
    }

    /**
     * Handle a note being advanced, updating navigation state.
     * This primarily involves re-evaluating the todayNotes list.
     *
     * @param path Path to the advanced note
     */
    handleNoteAdvanced(_path: string): void {
        // Re-fetch and re-sort today's notes, preserving current selection if possible.
        // updateTodayNotes(true) should correctly place the advanced note
        // if it's now due, or remove it if it was advanced from future to still future.
        // It also updates traversalOrder and currentNoteIndex.
        this.updateTodayNotes(true);
    }

    /**
     * Handle a note being postponed, updating navigation state
     *
     * @param path Path to the postponed note
     */
    handleNotePostponed(path: string): void {

        if (this.todayNotes.length === 0) return;

        const postponedIndex = this.todayNotes.findIndex(note => note.path === path);
        if (postponedIndex === -1) {
            return;
        }

        const wasCurrentNote = postponedIndex === this.currentNoteIndex;
        const currentNotePath = this.currentNoteIndex < this.todayNotes.length
            ? this.todayNotes[this.currentNoteIndex].path
            : null;

        // Remove from traversal order first
        this.traversalOrder = this.traversalOrder.filter(p => p !== path);
        this.traversalPositions.delete(path);

        // Update positions for remaining notes
        this.traversalOrder.forEach((p, i) => this.traversalPositions.set(p, i));

        // Remove from todayNotes
        this.todayNotes = this.todayNotes.filter(n => n.path !== path);

        // Update current index
        if (wasCurrentNote) {
            this.currentNoteIndex = Math.min(this.currentNoteIndex, this.todayNotes.length - 1);
        } else if (currentNotePath) {
            const newIndex = this.todayNotes.findIndex(n => n.path === currentNotePath);
            this.currentNoteIndex = newIndex !== -1 ? newIndex : Math.min(this.currentNoteIndex, this.todayNotes.length - 1);
        }

        // Update custom order in storage
        this.plugin.dataStorage.reviewScheduleService.updateCustomNoteOrder(this.traversalOrder);
        // Removed redundant savePluginData() here; postponeNote already saves.

        // If the postponed note was the current one, select a new note
        if (wasCurrentNote) {
            // Keep the current index, but make sure it's valid
            this.currentNoteIndex = Math.min(this.currentNoteIndex, this.todayNotes.length - 1);
        } else if (currentNotePath) {
            // If we were viewing a different note, try to keep that selected
            const newIndex = this.todayNotes.findIndex(note => note.path === currentNotePath);
            if (newIndex !== -1) {
                this.currentNoteIndex = newIndex;
            } else {
                // If the current note is no longer in the list, adjust the index
                this.currentNoteIndex = Math.min(this.currentNoteIndex, this.todayNotes.length - 1);
            }
        } else {
            // Adjust current index if necessary to prevent out-of-bounds
            if (this.currentNoteIndex >= this.todayNotes.length) {
                this.currentNoteIndex = Math.max(0, this.todayNotes.length - 1);
            }
        }
    }

    /**
     * Show the review modal for a note
     *
     * @param path Path to the note file
     */
    showReviewModal(path: string): void {
        const modal = new ReviewModal(this.plugin.app, this.plugin, path);
        modal.open();
    }

    /**
     * Skip the review of a note and reschedule for tomorrow with penalty
     *
     * @param path Path to the note file
     */
    async skipReview(path: string): Promise<void> {
        const effectiveDate = this.getEffectiveReviewDate();
        this.plugin.dataStorage.reviewScheduleService.skipNote(path, ReviewResponse.CorrectWithDifficulty, effectiveDate); // Pass effectiveDate
        await this.plugin.savePluginData(); // Add save call

        // Show notification with more informative message
        new Notice("Review postponed to tomorrow. Note will be easier to recover with a small penalty applied.");

        // Refresh the sidebar view if available
        void this.plugin.getSidebarView()?.refresh();

        // Update today's notes after skipping the review
        this.updateTodayNotes(true);

        // Continue to the next note and show review modal
        if (this.todayNotes.length > 0) {
            this.currentNoteIndex = (this.currentNoteIndex + 1) % this.todayNotes.length;

            // Check if we've reviewed all notes (in case we've come full circle)
            const currentPath = this.todayNotes[this.currentNoteIndex].path;
            if (currentPath === path) {
                new Notice("All caught up! No more notes due for review.");
                return;
            }

            if (this.plugin.navigationController) {
                // After finding the next note, show the review modal
                if (this.todayNotes.length > 0 && this.currentNoteIndex < this.todayNotes.length) {
                    const nextNotePath = this.todayNotes[this.currentNoteIndex].path;
                    await this.plugin.navigationController.openNoteWithoutReview(nextNotePath);
                    this.showReviewModal(nextNotePath);
                } else {
                    new Notice("All caught up! No more notes due for review.");
                }
            } else {
                new Notice("All caught up! No more notes due for review.");
            }
        } else {
            new Notice("All caught up! No more notes due for review.");
        }
    }

    /**
     * Process a review response
     *
     * @param path Path to the note file
     * @param response User's response during review (SM-2 or FSRS)
     */
    async processReviewResponse(path: string, response: ReviewResponse | FsrsRating): Promise<void> {
        const effectiveDate = this.getEffectiveReviewDate();
        // Record a normal review (not skipped) with the user's quality rating
        const wasRecorded = this.plugin.dataStorage.reviewScheduleService.recordReview(path, response, false, effectiveDate);

        if (!wasRecorded) {
            // Note was not due, this is just a preview
            new Notice("Note previewed, not recorded");
            return;
        }



        // Check for MCQ regeneration based on rating
        const schedule = this.plugin.dataStorage.reviewScheduleService.schedules[path];
        let triggerRegeneration = false;

        if (schedule && this.plugin.settings.enableQuestionRegenerationOnRating && this.plugin.mcqService && typeof response === 'number') {
            if (schedule.schedulingAlgorithm === 'fsrs') {
                // FSRS: response is FsrsRating (1-4), setting is minFsrsRatingForQuestionRegeneration (1-4)
                if (response >= this.plugin.settings.minFsrsRatingForQuestionRegeneration) {
                    triggerRegeneration = true;
                }
            } else { // SM-2
                // SM-2: response is ReviewResponse (0-5), setting is minSm2RatingForQuestionRegeneration (0-5)
                if (response >= this.plugin.settings.minSm2RatingForQuestionRegeneration) {
                    triggerRegeneration = true;
                }
            }
        }

        if (triggerRegeneration) {
            this.plugin.mcqService.flagMCQSetForRegeneration(path);
            // The savePluginData call at the end of processReviewResponse will persist this.
        }

        // Show notification based on response
        let responseText: string;

        if (schedule && schedule.schedulingAlgorithm === 'fsrs') {
            // FSRS response text
            switch (response as FsrsRating) { // Cast because we are in FSRS block
                case FsrsRating.Again: responseText = "Again (1)"; break;
                case FsrsRating.Hard: responseText = "Hard (2)"; break;
                case FsrsRating.Good: responseText = "Good (3)"; break;
                case FsrsRating.Easy: responseText = "Easy (4)"; break;
                default: responseText = "Unknown FSRS Rating";
            }
        } else {
            // SM-2 response text
            switch (response as ReviewResponse) { // Cast because we are in SM-2 block
                case ReviewResponse.CompleteBlackout: responseText = "Complete Blackout (0)"; break;
                case ReviewResponse.IncorrectResponse: responseText = "Incorrect Response (1)"; break;
                case ReviewResponse.IncorrectButFamiliar: responseText = "Incorrect but Familiar (2)"; break;
                case ReviewResponse.CorrectWithDifficulty: responseText = "Correct with Difficulty (3)"; break;
                case ReviewResponse.CorrectWithHesitation: responseText = "Correct with Hesitation (4)"; break;
                case ReviewResponse.PerfectRecall: responseText = "Perfect Recall (5)"; break;
                default: responseText = "Unknown SM-2 Rating";
            }
        }
        new Notice(`Note review recorded: ${responseText}`);

        // Refresh the sidebar view if available
        void this.plugin.getSidebarView()?.refresh();

        // Update today's notes after recording the review (preserve the index since we're in the middle of navigation)
        this.updateTodayNotes(true);

        // Check if we're in a hierarchical review session
        const activeSession = this.plugin.dataStorage.getActiveSession();

        if (activeSession) {
            // Advance to the next file in the session
            await this.plugin.dataStorage.advanceActiveSession();

            // Get the next file to review
            const nextFilePath = this.plugin.dataStorage.getNextSessionFile();

            if (nextFilePath) {
                // Continue with the session
                await this.reviewNote(nextFilePath);
            } else {
                // Session complete
                new Notice("Hierarchical review session complete!");
            }
        }
        // If not in a session, automatically go to the next note and show review modal
        else if (this.todayNotes.length > 0) {
            // Check if we've reviewed all notes (in case we've come full circle)
            const currentPath = this.todayNotes[this.currentNoteIndex].path;
            if (currentPath === path) {
                new Notice("All caught up! No more notes due for review.");
                return;
            }

            // After finding the next note, show the review modal
            if (this.todayNotes.length > 0 && this.currentNoteIndex < this.todayNotes.length) {
                const nextNotePath = this.todayNotes[this.currentNoteIndex].path;
                if (this.plugin.navigationController) {
                    await this.plugin.navigationController.openNoteWithoutReview(nextNotePath);
                    this.showReviewModal(nextNotePath);
                } else {
                    new Notice("All caught up! No more notes due for review.");
                }
            } else {
                new Notice("All caught up! No more notes due for review.");
            }
        } else {
            new Notice("All caught up! No more notes due for review.");
        }

        // Save all accumulated plugin data once at the end
        await this.plugin.savePluginData();
    }
}
