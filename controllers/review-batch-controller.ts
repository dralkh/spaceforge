import { Notice } from 'obsidian';
import SpaceforgePlugin from '../main';
import { IReviewBatchController } from './interfaces';
import { BatchReviewModal } from '../ui/batch-review-modal';

/**
 * Controller for batch reviewing multiple notes
 */
export class ReviewBatchController implements IReviewBatchController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Initialize batch controller
     *
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /**
     * Start reviewing all of today's notes
     */
    async reviewAllTodaysNotes(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        // Update notes while preserving existing order
        void reviewController.updateTodayNotes(true);

        const todayNotes = reviewController.getTodayNotes();
        if (todayNotes.length === 0) {
            new Notice("No notes due for review today!");
            return;
        }


        // Always start with first note in current order
        // We need to update the core controller's state
        if (reviewController) {
            // Force update to ensure we start at the first note
            void reviewController.updateTodayNotes(false);

            const note = todayNotes[0];

            // Start the review with the selected note
            await reviewController.reviewNote(note.path);
        }

        new Notice(`Starting review of all ${todayNotes.length} notes due today`);
    }

    /**
     * Review a specific set of notes
     *
     * @param paths Array of note paths to review
     * @param useMCQ Whether to use MCQs for testing (default: false)
     */
    reviewNotes(paths: string[], useMCQ = false): void {
        if (paths.length === 0) {
            new Notice("No notes selected for review.");
            return;
        }

        // Get the ReviewSchedule objects for the given paths
        const notesToReview = this.plugin.dataStorage.getDueNotesWithCustomOrder().filter(note => paths.includes(note.path));

        if (notesToReview.length === 0) {
            new Notice("Selected notes are not currently due for review.");
            return;
        }

        if (useMCQ) {
            new Notice(`Preparing MCQs for ${notesToReview.length} selected notes.This may take a moment...`);
        } else {
            new Notice(`Starting review of ${notesToReview.length} selected notes.`);
        }

        // Create a new batch review modal with the selected notes
        const modal = new BatchReviewModal(this.plugin.app, this.plugin, notesToReview, useMCQ);
        modal.open();
    }

    /**
     * Review all notes with MCQs in a batch
     *
     * @param useMCQ Whether to use MCQs for testing
     */
    reviewAllNotesWithMCQ(useMCQ = true): void {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        // Update today's notes first, preserving custom order if it exists
        const hasCustomOrder = this.plugin.reviewScheduleService.customNoteOrder.length > 0;
        void reviewController.updateTodayNotes(hasCustomOrder);

        const todayNotes = reviewController.getTodayNotes();
        if (todayNotes.length === 0) {
            new Notice("No notes due for review today!");
            return;
        }

        if (useMCQ) {
            new Notice("Preparing all MCQs. This may take a moment...");
        }

        // Use notes directly from todayNotes - they're already in the correct order
        // Custom order is already applied by updateTodayNotes if available
        const orderedNotes = [...todayNotes];

        // Create a new batch review modal with the ordered notes
        const modal = new BatchReviewModal(this.plugin.app, this.plugin, orderedNotes, useMCQ);
        modal.open();
    }

    /**
     * Regenerate MCQs for all notes due today
     */
    async regenerateAllMCQs(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        // Update notes respecting custom order if it exists
        const hasCustomOrder = this.plugin.reviewScheduleService.customNoteOrder.length > 0;
        void reviewController.updateTodayNotes(hasCustomOrder);

        const todayNotes = reviewController.getTodayNotes();
        if (todayNotes.length === 0) {
            new Notice("No notes due for review today!");
            return;
        }

        if (!this.plugin.mcqController) {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice("MCQ controller not initialized, please check MCQ settings");
            return;
        }

        new Notice(`Regenerating MCQs for ${todayNotes.length} notes...`);

        let generatedCount = 0;
        for (const note of todayNotes) {
            const success = await this.plugin.mcqController.generateMCQs(note.path);
            if (success) {
                generatedCount++;
            }
        }

        new Notice(`Generated MCQs for ${generatedCount} out of ${todayNotes.length} notes`);

        // Start batch review with the newly generated MCQs
        this.reviewAllNotesWithMCQ(true);
    }

    /**
     * Postpone a specific set of notes
     *
     * @param paths Array of note paths to postpone
     * @param days Number of days to postpone (default: 1)
     */
    async postponeNotes(paths: string[], days = 1): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        if (paths.length === 0) {
            new Notice("No notes selected to postpone.");
            return;
        }

        new Notice(`Postponing ${paths.length} notes by ${days} day(s)...`);
        for (const path of paths) {
            await this.plugin.dataStorage.postponeNote(path, days);
            // No need to call handleNotePostponed here for each note,
            // as a single refresh of the sidebar after the loop is sufficient.
        }
        await this.plugin.savePluginData(); // Add save call after loop

        // Refresh the sidebar view if available
        void this.plugin.getSidebarView()?.refresh();

        // Update today's notes after postponing
        void reviewController.updateTodayNotes(true);

        new Notice(`Postponed ${paths.length} notes by ${days} day(s).`);
    }

    /**
     * Advance a specific set of notes by one day each, if eligible.
     *
     * @param paths Array of note paths to advance
     */
    async advanceNotes(paths: string[]): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        if (paths.length === 0) {
            new Notice("No notes selected to advance.");
            return;
        }

        let advancedCount = 0;
        for (const path of paths) {
            // Directly call the core controller's advanceNote, which handles eligibility and notices
            // The service's advanceNote returns a boolean indicating success
            const advanced = await this.plugin.dataStorage.reviewScheduleService.advanceNote(path);
            if (advanced) {
                advancedCount++;
            }
        }

        if (advancedCount > 0) {
            await this.plugin.savePluginData(); // Save once after all operations

            // Refresh the sidebar view if available
            void this.plugin.getSidebarView()?.refresh();
            // Update today's notes after advancing
            void reviewController.updateTodayNotes(true);
            new Notice(`Advanced ${advancedCount} note(s).`);
        } else {
            new Notice("No eligible notes were advanced.");
        }
    }

    /**
     * Remove a specific set of notes from the review schedule
     *
     * @param paths Array of note paths to remove
     */
    async removeNotes(paths: string[]): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        if (paths.length === 0) {
            new Notice("No notes selected to remove.");
            return;
        }

        new Notice(`Removing ${paths.length} notes from review schedule...`);
        for (const path of paths) {
            await this.plugin.dataStorage.removeFromReview(path);
            // No need to call handleNotePostponed here for each note,
            // as a single refresh of the sidebar after the loop is sufficient.
        }
        await this.plugin.savePluginData(); // Add save call after loop

        // Refresh the sidebar view if available
        void this.plugin.getSidebarView()?.refresh();

        // Update today's notes after removing
        void reviewController.updateTodayNotes(true);

        new Notice(`Removed ${paths.length} notes from review schedule.`);
    }
}
