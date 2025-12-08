import SpaceforgePlugin from '../main';
import { ReviewControllerCore } from './review-controller-core';
import { ReviewNavigationController } from './review-navigation-controller';
import { ReviewBatchController } from './review-batch-controller';
import { MCQController } from './review-controller-mcq'; // Import MCQController
import { IReviewController } from './interfaces';
import { ReviewResponse, FsrsRating } from '../models/review-schedule';
import { MCQService } from '../services/mcq-service'; // Import MCQService

/**
 * Main controller that coordinates review functionality across the plugin
 * Acts as a facade that delegates to specialized controllers
 */
export class ReviewController implements IReviewController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Core controller for review functionality
     */
    private coreController: ReviewControllerCore;

    /**
     * Navigation controller for review functionality
     */
    private navigationController: ReviewNavigationController; // Add navigation controller

    /**
     * MCQ controller for review functionality
     */
    private mcqController: MCQController; // Add MCQ controller

    /**
     * Batch controller for review functionality
     */
    private batchController: ReviewBatchController; // Add batch controller

    /**
     * Constructor initializes the review controller
     *
     * @param plugin Reference to the main plugin
     * @param mcqService Reference to the MCQ service
     */
    constructor(plugin: SpaceforgePlugin, mcqService: MCQService) { // Accept MCQService
        this.plugin = plugin;
        this.coreController = new ReviewControllerCore(plugin);
        this.navigationController = new ReviewNavigationController(plugin); // Initialize navigation controller
        // Pass the generation service if available
        if (plugin.mcqGenerationService) {
            this.mcqController = new MCQController(plugin, mcqService, plugin.mcqGenerationService);
        } else {
            // Handle case where service might not be initialized (e.g., MCQ disabled)
            // Depending on usage, might need null checks later or ensure it's always initialized when enabled.
            // this.mcqController = undefined; // Or handle appropriately
        }
        this.batchController = new ReviewBatchController(plugin); // Initialize batch controller
    }

    /**
     * Update the list of today's due notes
     * Delegates to core controller
     *
     * @param preserveCurrentIndex Whether to try to preserve the current note index
     */
    updateTodayNotes(preserveCurrentIndex = false): void {
        this.coreController.updateTodayNotes(preserveCurrentIndex);
    }

    /**
     * Get the currently loaded notes due for review
     * Delegates to core controller
     */
    getTodayNotes() {
        return this.coreController.getTodayNotes();
    }

    /**
     * Get the current index in today's notes
     * Delegates to core controller
     */
    getCurrentNoteIndex() {
        return this.coreController.getCurrentNoteIndex();
    }

    /**
     * Set the current index in today's notes
     * Delegates to core controller
     *
     * @param index The new index
     */
    setCurrentNoteIndex(index: number): void {
        this.coreController.setCurrentNoteIndex(index);
    }

    /**
     * Review the current note
     * Delegates to core controller
     */
    async reviewCurrentNote(): Promise<void> {
        await this.coreController.reviewCurrentNote();
    }

    /**
     * Review a specific note
     * Delegates to core controller
     *
     * @param path Path to the note file
     */
    async reviewNote(path: string): Promise<void> {
        await this.coreController.reviewNote(path);
    }

    /**
     * Postpone a note's review
     * Delegates to core controller
     *
     * @param path Path to the note file
     * @param days Number of days to postpone (default: 1)
     */
    async postponeNote(path: string, days = 1): Promise<void> {
        await this.coreController.postponeNote(path, days);
    }

    /**
     * Advance a note's review by one day, if eligible.
     * Delegates to core controller.
     *
     * @param path Path to the note file
     */
    async advanceNote(path: string): Promise<void> {
        await this.coreController.advanceNote(path);
    }

    /**
     * Handle a note being postponed, updating navigation state
     * Delegates to core controller
     *
     * @param path Path to the postponed note
     */
    async handleNotePostponed(path: string): Promise<void> {
        await this.coreController.handleNotePostponed(path);
    }

    /**
     * Show the review modal for a note
     * Delegates to core controller
     *
     * @param path Path to the note file
     */
    showReviewModal(path: string): void {
        this.coreController.showReviewModal(path);
    }

    /**
     * Skip the review of a note and reschedule for tomorrow with penalty
     * Delegates to core controller
     *
     * @param path Path to the note file
     */
    async skipReview(path: string): Promise<void> {
        await this.coreController.skipReview(path);
    }

    /**
     * Process a review response
     * Delegates to core controller
     *
     * @param path Path to the note file
     * @param response User's response during review (SM-2 or FSRS)
     */
    async processReviewResponse(path: string, response: ReviewResponse | FsrsRating): Promise<void> {
        await this.coreController.processReviewResponse(path, response);
    }

    /**
     * Sets an override for the current review date.
     * Delegates to core controller.
     * @param date Timestamp of the date to simulate, or null to use actual Date.now().
     */
    public setReviewDateOverride(date: number | null): void {
        this.coreController.setReviewDateOverride(date);
    }

    /**
     * Gets the current review date override.
     * Delegates to core controller.
     * @returns Timestamp of the override, or null if no override is set.
     */
    public getCurrentReviewDateOverride(): number | null {
        return this.coreController.getCurrentReviewDateOverride();
    }

    // Delegate methods to specialized controllers

    /**
     * Start reviewing all of today's notes
     * Delegates to batch controller
     */
    async reviewAllTodaysNotes(): Promise<void> {
        await this.batchController.reviewAllTodaysNotes();
    }

    /**
     * Navigate to the next note
     * Delegates to navigation controller
     */
    async navigateToNextNote(): Promise<void> {
        await this.navigationController.navigateToNextNote();
    }

    /**
     * Navigate to the previous note
     * Delegates to navigation controller
     */
    async navigateToPreviousNote(): Promise<void> {
        await this.navigationController.navigateToPreviousNote();
    }

    /**
     * Start an MCQ review session for a note
     * Delegates to MCQ controller
     *
     * @param notePath Path to the note
     * @param onComplete Optional callback for when MCQ review is completed
     */
    async startMCQReview(
        notePath: string,
        onComplete?: (path: string, success: boolean) => void
    ): Promise<void> {
        // Pass only notePath as the callback is handled internally by MCQModal now
        if (this.mcqController) {
            await this.mcqController.startMCQReview(notePath, onComplete); // Pass the callback here as MCQController expects it
        } else {
            // Optionally call the callback with failure if provided
            if (onComplete) {
                onComplete(notePath, false);
            }
        }
    }

    /**
     * Review a specific set of notes
     * Delegates to batch controller
     *
     * @param paths Array of note paths to review
     * @param useMCQ Whether to use MCQs for testing (default: false)
     */
    reviewNotes(paths: string[], useMCQ = false): void {
        this.batchController.reviewNotes(paths, useMCQ);
    }

    /**
     * Postpone a specific set of notes
     * Delegates to batch controller
     *
     * @param paths Array of note paths to postpone
     * @param days Number of days to postpone (default: 1)
     */
    async postponeNotes(paths: string[], days = 1): Promise<void> {
        await this.batchController.postponeNotes(paths, days);
    }

    /**
     * Advance a specific set of notes by one day each, if eligible.
     * Delegates to batch controller.
     *
     * @param paths Array of note paths to advance
     */
    async advanceNotes(paths: string[]): Promise<void> {
        await this.batchController.advanceNotes(paths);
    }

    /**
     * Remove a specific set of notes from the review schedule
     * Delegates to batch controller
     *
     * @param paths Array of note paths to remove
     */
    async removeNotes(paths: string[]): Promise<void> {
        await this.batchController.removeNotes(paths);
    }

    /**
     * Open a note without showing the review modal
     * Delegates to navigation controller
     *
     * @param path Path to the note file
     */
    async openNoteWithoutReview(path: string): Promise<void> {
        await this.navigationController.openNoteWithoutReview(path);
    }

    /**
     * Swap two notes in the traversal order
     * Delegates to navigation controller
     *
     * @param path1 Path to the first note
     * @param path2 Path to the second note
     */
    async swapNotes(path1: string, path2: string): Promise<void> {
        await this.navigationController.swapNotes(path1, path2);
    }

    /**
     * Review all notes with MCQs in a batch
     * Delegates to batch controller
     *
     * @param useMCQ Whether to use MCQs for testing
     */
    reviewAllNotesWithMCQ(useMCQ = true): void {
        this.batchController.reviewAllNotesWithMCQ(useMCQ);
    }
}
