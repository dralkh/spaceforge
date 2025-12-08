import { ReviewResponse, ReviewSchedule } from '../models/review-schedule';

/**
 * Interface for the core review controller
 */
export interface IReviewController {
    /**
     * Update the list of today's due notes
     * 
     * @param preserveCurrentIndex Whether to try to preserve the current note index
     */
    updateTodayNotes(preserveCurrentIndex?: boolean): void;

    /**
     * Review the current note
     */
    reviewCurrentNote(): Promise<void>;

    /**
     * Review a note
     * 
     * @param path Path to the note file
     */
    reviewNote(path: string): Promise<void>;

    /**
     * Show the review modal for a note
     * 
     * @param path Path to the note file
     */
    showReviewModal(path: string): void;

    /**
     * Process a review response
     * 
     * @param path Path to the note file
     * @param response User's response during review
     */
    processReviewResponse(path: string, response: ReviewResponse): Promise<void>;

    /**
     * Skip the review of a note and reschedule for tomorrow with penalty
     * 
     * @param path Path to the note file
     */
    skipReview(path: string): Promise<void>;

    /**
     * Postpone a note's review
     * 
     * @param path Path to the note file
     * @param days Number of days to postpone (default: 1)
     */
    postponeNote(path: string, days?: number): Promise<void>;

    /**
     * Handle a note being postponed, updating navigation state
     * 
     * @param path Path to the postponed note
     */
    handleNotePostponed(path: string): Promise<void>;

    /**
     * Get the currently loaded notes due for review
     */
    getTodayNotes(): ReviewSchedule[];

    /**
     * Get the current index in today's notes
     */
    getCurrentNoteIndex(): number;

    /**
     * Set the current index in today's notes
     * @param index The new index
     */
    setCurrentNoteIndex(index: number): void;

    /**
     * Sets an override for the current review date.
     * @param date Timestamp of the date to simulate, or null to use actual Date.now().
     */
    setReviewDateOverride(date: number | null): void;

    /**
     * Gets the current review date override.
     * @returns Timestamp of the override, or null if no override is set.
     */
    getCurrentReviewDateOverride(): number | null;
}

/**
 * Interface for the navigation controller
 */
export interface IReviewNavigationController {
    /**
     * Navigate to the next note following the current order
     */
    navigateToNextNote(): Promise<void>;

    /**
     * Navigate to the previous note in the current order
     */
    navigateToPreviousNote(): Promise<void>;

    /**
     * Navigate to the next note without recording a review
     */
    navigateToNextNoteWithoutRating(): Promise<void>;

    /**
     * Navigate to the current note without showing review modal
     */
    navigateToCurrentNoteWithoutModal(): Promise<void>;

    /**
     * Open a note without showing the review modal
     * 
     * @param path Path to the note file
     */
    openNoteWithoutReview(path: string): Promise<void>;

    /**
     * Swap two notes in the traversal order
     * 
     * @param path1 Path to the first note
     * @param path2 Path to the second note
     */
    swapNotes(path1: string, path2: string): Promise<void>;
}

/**
 * Interface for the batch review controller
 */
export interface IReviewBatchController {
    /**
     * Start reviewing all of today's notes
     */
    reviewAllTodaysNotes(): Promise<void>;

    /**
     * Review a specific set of notes
     * 
     * @param paths Array of note paths to review
     * @param useMCQ Whether to use MCQs for testing
     */
    reviewNotes(paths: string[], useMCQ?: boolean): void;

    /**
     * Review all notes with MCQs in a batch
     * 
     * @param useMCQ Whether to use MCQs for testing
     */
    reviewAllNotesWithMCQ(useMCQ?: boolean): void;

    /**
     * Regenerate MCQs for all notes due today
     */
    regenerateAllMCQs(): Promise<void>;

    /**
     * Postpone a specific set of notes
     * 
     * @param paths Array of note paths to postpone
     * @param days Number of days to postpone
     */
    postponeNotes(paths: string[], days?: number): Promise<void>;

    /**
     * Remove a specific set of notes from the review schedule
     * 
     * @param paths Array of note paths to remove
     */
    removeNotes(paths: string[]): Promise<void>;
}

/**
 * Interface for the session controller
 */
export interface IReviewSessionController {
    /**
     * Get linked notes that are due today
     * 
     * @param notePath Path of the note to get links from
     * @returns Array of paths to linked notes that are due today
     */
    getDueLinkedNotes(notePath: string): string[];
}
