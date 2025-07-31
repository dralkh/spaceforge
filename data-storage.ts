import { Notice, TFile, TFolder } from 'obsidian';
import { ReviewHistoryItem, ReviewResponse, ReviewSchedule, toSM2Quality } from './models/review-schedule';
import SpaceforgePlugin from './main';
import { DateUtils } from './utils/dates';
import { EstimationUtils } from './utils/estimation';
import { ReviewSession, ReviewSessionStore, generateSessionId, getNextFileInSession, advanceSession, isSessionComplete } from './models/review-session';
import { LinkAnalyzer } from './utils/link-analyzer';
import { MCQSet, MCQSession } from './models/mcq';
import { ReviewScheduleService } from './services/review-schedule-service';
import { ReviewHistoryService } from './services/review-history-service';
import { ReviewSessionService } from './services/review-session-service';
import { MCQService } from './services/mcq-service';

/**
 * Data storage interface for plugin data
 */
export interface SpaceforgeData {
    /**
     * Review schedules for all notes
     */
    schedules: Record<string, ReviewSchedule>;

    /**
     * Review history items
     */
    history: ReviewHistoryItem[];

    /**
     * Review sessions
     */
    reviewSessions: ReviewSessionStore;

    /**
     * Multiple-choice question sets
     */
    mcqSets: Record<string, MCQSet>;

    /**
     * Multiple-choice question session history
     */
    mcqSessions: Record<string, MCQSession[]>;

    /**
     * Custom order for notes (user-defined ordering)
     */
    customNoteOrder: string[];

    /**
     * Last used version (for migrations)
     */
    version: string;

    /**
     * Timestamp of the last time link analysis was performed for ordering
     */
    lastLinkAnalysisTimestamp?: number | null;
}

/**
 * Handles storage and retrieval of spaced repetition data
 */
export class DataStorage {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Service for managing review schedules
     */
    reviewScheduleService: ReviewScheduleService;

    /**
     * Service for managing review history
     */
    reviewHistoryService: ReviewHistoryService;

    /**
     * Service for managing review sessions
     */
    reviewSessionService: ReviewSessionService;

    /**
     * Service for managing MCQ data
     */
    mcqService: MCQService;

    /**
     * Initialize data storage
     *
     * @param plugin Reference to the main plugin
     * @param reviewScheduleService Instance of ReviewScheduleService
     * @param reviewHistoryService Instance of ReviewHistoryService
     * @param reviewSessionService Instance of ReviewSessionService
     * @param mcqService Instance of MCQService
     */
    constructor(
        plugin: SpaceforgePlugin,
        reviewScheduleService: ReviewScheduleService,
        reviewHistoryService: ReviewHistoryService,
        reviewSessionService: ReviewSessionService,
        mcqService: MCQService
    ) {
        this.plugin = plugin;
        this.reviewScheduleService = reviewScheduleService;
        this.reviewHistoryService = reviewHistoryService;
        this.reviewSessionService = reviewSessionService;
        this.mcqService = mcqService;

        // Constructor no longer calls ensureDataLoaded()
    }

    // Removed ensureDataLoaded() method
    // Removed loadData() method (and all localStorage logic within it)
    // Removed saveData() method (and all localStorage logic within it)

    /**
     * Initialize default data when no data is available
     * This is now primarily for internal use during integrity checks,
     * as main.ts handles initial default loading.
     */
    private initializeDefaultData(): void {
        this.reviewScheduleService.schedules = {};
        this.reviewHistoryService.history = [];
        this.reviewSessionService.reviewSessions = {
            sessions: {},
            activeSessionId: null
        };
        this.mcqService.mcqSets = {};
        this.mcqService.mcqSessions = {};
        this.reviewScheduleService.customNoteOrder = [];
        this.reviewScheduleService.lastLinkAnalysisTimestamp = null;
    }

    /**
     * Verify data integrity and fix any issues
     * @returns true if data is valid, false if it needed to be fixed
     */
    public verifyDataIntegrity(): boolean {
        console.log("Verifying data integrity...");
        let isValid = true;

        // Check schedules (using service data)
        if (!this.reviewScheduleService.schedules || typeof this.reviewScheduleService.schedules !== 'object') {
            console.warn("Invalid schedules data structure");
            this.reviewScheduleService.schedules = {};
            isValid = false;
        } else {
            // Check each schedule for required properties
            let invalidCount = 0;
            for (const path in this.reviewScheduleService.schedules) {
                const schedule = this.reviewScheduleService.schedules[path];
                if (!schedule || typeof schedule !== 'object') {
                    delete this.reviewScheduleService.schedules[path];
                    invalidCount++;
                    isValid = false;
                    continue;
                }

                // Use a type assertion to check properties safely
                const s = schedule as Record<string, any>;
                if (!('path' in s) || typeof s.path !== 'string' ||
                    !('lastReviewDate' in s) || (s.lastReviewDate !== null && typeof s.lastReviewDate !== 'number') ||
                    !('nextReviewDate' in s) || typeof s.nextReviewDate !== 'number' ||
                    !('ease' in s) || typeof s.ease !== 'number') {

                    delete this.reviewScheduleService.schedules[path];
                    invalidCount++;
                    isValid = false;
                }
            }

            if (invalidCount > 0) {
                console.warn(`Removed ${invalidCount} invalid schedules`);
            }
        }

        // Check history (using service data)
        if (!Array.isArray(this.reviewHistoryService.history)) {
            console.warn("Invalid history data structure");
            this.reviewHistoryService.history = [];
            isValid = false;
        }

        // Check review sessions (using service data)
        if (!this.reviewSessionService.reviewSessions ||
            typeof this.reviewSessionService.reviewSessions !== 'object' ||
            !this.reviewSessionService.reviewSessions.sessions ||
            typeof this.reviewSessionService.reviewSessions.sessions !== 'object') {

            console.warn("Invalid review sessions data structure");
            this.reviewSessionService.reviewSessions = {
                sessions: {},
                activeSessionId: null
            };
            isValid = false;
        }

        // Check MCQ sets (using service data)
        if (!this.mcqService.mcqSets || typeof this.mcqService.mcqSets !== 'object') {
            console.warn("Invalid MCQ sets data structure");
            this.mcqService.mcqSets = {};
            isValid = false;
        }

        // Check MCQ sessions (using service data)
        if (!this.mcqService.mcqSessions || typeof this.mcqService.mcqSessions !== 'object') {
            console.warn("Invalid MCQ sessions data structure");
            this.mcqService.mcqSessions = {};
            isValid = false;
        }

        // Check custom note order (using service data)
        if (!Array.isArray(this.reviewScheduleService.customNoteOrder)) {
            console.warn("Invalid custom note order data structure");
            this.reviewScheduleService.customNoteOrder = [];
            isValid = false;
        }

        // Check last link analysis timestamp (using service data)
        if (this.reviewScheduleService.lastLinkAnalysisTimestamp !== null && typeof this.reviewScheduleService.lastLinkAnalysisTimestamp !== 'number') {
            console.warn("Invalid last link analysis timestamp data structure");
            this.reviewScheduleService.lastLinkAnalysisTimestamp = null;
            isValid = false;
        }

        // Check if data is suspiciously empty (using service data)
        const noSchedules = Object.keys(this.reviewScheduleService.schedules).length === 0;
        const hasMCQs = Object.keys(this.mcqService.mcqSets).length > 0;

        if (noSchedules && hasMCQs) {
            console.warn("WARNING: No schedules found but MCQ data exists - possible data inconsistency");
            // Removed localStorage check here as it's deprecated
        }

        // Log final data state (using service data)
        console.log("Data integrity check complete:", {
            isValid,
            schedules: Object.keys(this.reviewScheduleService.schedules).length,
            history: this.reviewHistoryService.history.length,
            reviewSessions: Object.keys(this.reviewSessionService.reviewSessions.sessions).length,
            mcqSets: Object.keys(this.mcqService.mcqSets).length,
            mcqSessions: Object.keys(this.mcqService.mcqSessions).length
        });

        return isValid; // Returns true if valid, false if fixes were needed
    }


    /**
     * Verify data integrity and remove schedules for files that no longer exist
     * @returns {Promise<boolean>} True if any cleanup was performed, false otherwise.
     */
    public async cleanupNonExistentFiles(): Promise<boolean> {
        console.log("Verifying data integrity and cleaning up non-existent files...");
        let changesMade = false; // Track if any cleanup occurred

        // First, check that we have valid data structures (using service data)
        if (!this.reviewScheduleService.schedules || typeof this.reviewScheduleService.schedules !== 'object') {
            console.warn("Schedules is not a valid object, resetting it");
            this.reviewScheduleService.schedules = {};
            changesMade = true; // Resetting counts as a change
        }

        if (!Array.isArray(this.reviewHistoryService.history)) {
            console.warn("History is not a valid array, resetting it");
            this.reviewHistoryService.history = [];
            changesMade = true;
        }

        if (!this.reviewSessionService.reviewSessions || typeof this.reviewSessionService.reviewSessions !== 'object' || !this.reviewSessionService.reviewSessions.sessions) {
            console.warn("Review sessions is not a valid object, resetting it");
            this.reviewSessionService.reviewSessions = {
                sessions: {},
                activeSessionId: null
            };
            changesMade = true;
        }

        // Then, remove schedules for files that no longer exist (using service data)
        let cleanupCount = 0;
        const beforeCount = Object.keys(this.reviewScheduleService.schedules).length;

        // CRITICAL FIX: Add a safeguard to prevent removing all schedules
        const safetyCheck = {
            totalSchedules: beforeCount,
            checkedSchedules: 0,
            missingSchedules: 0,
            preserved: false
        };

        try {
            const allSchedules = {...this.reviewScheduleService.schedules}; // Create a copy
            const allFiles = new Set<string>();

            // Preload all markdown files
            try {
                const mdFiles = this.plugin.app.vault.getMarkdownFiles();
                mdFiles.forEach(file => allFiles.add(file.path));
                console.log(`Preloaded ${allFiles.size} markdown files for checking`);
            } catch (listError) {
                console.error("Error listing markdown files:", listError);
                return changesMade; // Return current state if file listing fails
            }

            // Safety check: If no files found but schedules exist
            if (allFiles.size === 0 && beforeCount > 0) {
                console.warn("No files found in vault but schedules exist - preserving schedules");
                safetyCheck.preserved = true;
                return changesMade; // No cleanup performed, return current state
            }

            for (const path in allSchedules) {
                try {
                    safetyCheck.checkedSchedules++;

                    if (allFiles.has(path)) continue; // File exists

                    // Double-check with direct vault access
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (!file) {
                        safetyCheck.missingSchedules++;
                        delete this.reviewScheduleService.schedules[path]; // Delete from service data
                        cleanupCount++;
                        changesMade = true; // Mark that changes were made
                    }
                } catch (checkError) {
                    console.warn(`Error checking file at path ${path}:`, checkError);
                }

                // SAFETY CHECK: Abort if removing too many
                if (safetyCheck.missingSchedules > 0 &&
                    safetyCheck.missingSchedules === safetyCheck.checkedSchedules &&
                    safetyCheck.checkedSchedules >= 5) {

                    console.warn(`SAFETY ALERT: Preventing removal of all schedules (${safetyCheck.missingSchedules}/${safetyCheck.totalSchedules} would be removed)`);
                    this.reviewScheduleService.schedules = allSchedules; // Restore service data
                    cleanupCount = 0;
                    changesMade = false; // Revert changesMade flag
                    safetyCheck.preserved = true;
                    break;
                }
            }

            console.log(`Cleanup complete: ${beforeCount} schedules before, ${Object.keys(this.reviewScheduleService.schedules).length} after (${cleanupCount} removed)`);
            console.log(`Safety check: ${safetyCheck.checkedSchedules} checked, ${safetyCheck.missingSchedules} missing, preserved: ${safetyCheck.preserved}`);

            // Removed the saveData call from here
            if (cleanupCount > 0 && !safetyCheck.preserved) {
                console.log(`Spaceforge: Cleaned up ${cleanupCount} non-existent files from schedules. Data needs saving.`);
            }

            // Log final state after potential cleanup
            const dataState = {
                schedules: Object.keys(this.reviewScheduleService.schedules).length,
                history: this.reviewHistoryService.history.length,
                reviewSessions: Object.keys(this.reviewSessionService.reviewSessions.sessions || {}).length,
                mcqSets: Object.keys(this.mcqService.mcqSets || {}).length,
                mcqSessions: Object.keys(this.mcqService.mcqSessions || {}).length
            };
            console.log("Final data state after cleanup check:", dataState);

            if (dataState.schedules === 0 && (dataState.history > 0 || dataState.reviewSessions > 0 || dataState.mcqSets > 0)) {
                console.warn("WARNING: No schedules found but other data exists - possible data inconsistency");
            }

        } catch (error) {
            console.error("Error during cleanup:", error);
        }

        return changesMade; // Return whether cleanup occurred
    }


    // The following methods are now delegated to the respective service classes.
    // They are kept here as public methods to maintain the public API of DataStorage,
    // but they now simply call the corresponding method on the service instance.
    // REMOVED await this.saveData() from all these methods.

    async scheduleNoteForReview(path: string, daysFromNow: number = 0): Promise<void> {
        await this.reviewScheduleService.scheduleNoteForReview(path, daysFromNow);
        // await this.saveData(); // Removed
    }

    async recordReview(path: string, response: ReviewResponse, isSkipped: boolean = false): Promise<boolean> {
        return await this.reviewScheduleService.recordReview(path, response, isSkipped);
    }

    calculateNewSchedule(
        currentInterval: number,
        currentEase: number,
        response: ReviewResponse
    ): { interval: number, ease: number } {
        // This method is likely redundant now that recordReview uses calculateSM2Schedule directly,
        // but keeping for potential external use or backward compatibility if needed.
        // It should probably be moved to ReviewScheduleService if kept.
        // For now, just calling the service method.
         const result = this.reviewScheduleService.calculateNewSchedule(currentInterval, currentEase, response);
         return { interval: result.interval, ease: result.ease };
    }

    async skipNote(path: string, response: ReviewResponse = ReviewResponse.CorrectWithDifficulty): Promise<void> {
        await this.reviewScheduleService.skipNote(path, response);
        // await this.saveData(); // Removed
    }

    async postponeNote(path: string, days: number = 1): Promise<void> {
        await this.reviewScheduleService.postponeNote(path, days);
        // await this.saveData(); // Removed
    }

    async removeFromReview(path: string): Promise<void> {
        await this.reviewScheduleService.removeFromReview(path);
        // await this.saveData(); // Removed
    }

    async clearAllSchedules(): Promise<void> {
        await this.reviewScheduleService.clearAllSchedules();
        // await this.saveData(); // Removed
    }

    async estimateReviewTime(path: string): Promise<number> {
        // This method doesn't directly modify data, so it can stay or be moved to a utility
        // Keeping it here for now, but it doesn't use service data directly.
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return 60; // Default 1 minute

        try {
            const content = await this.plugin.app.vault.read(file);
            return EstimationUtils.estimateReviewTime(file, content);
        } catch (error) {
            console.error("Error estimating review time:", error);
            return 60; // Default 1 minute
        }
    }

    async createReviewSession(folderPath: string, name: string): Promise<ReviewSession | null> {
        const session = await this.reviewSessionService.createReviewSession(folderPath, name);
        // if (session) { // Removed save call
        //      await this.saveData();
        // }
        return session;
    }

    async setActiveSession(sessionId: string | null): Promise<boolean> {
        const success = await this.reviewSessionService.setActiveSession(sessionId);
        // if (success) { // Removed save call
        //      await this.saveData();
        // }
        return success;
    }

    getActiveSession(): ReviewSession | null {
        return this.reviewSessionService.getActiveSession();
    }

    getNextSessionFile(): string | null {
        return this.reviewSessionService.getNextSessionFile();
    }

    async advanceActiveSession(): Promise<boolean> {
        const moreFiles = await this.reviewSessionService.advanceActiveSession();
        // await this.saveData(); // Removed
        return moreFiles;
    }

    async scheduleNotesInOrder(paths: string[], daysFromNow: number = 0): Promise<number> {
        const count = await this.reviewScheduleService.scheduleNotesInOrder(paths, daysFromNow);
        // if (count > 0) { // Removed save call
        //      await this.saveData();
        // }
        return count;
    }

    async scheduleSessionForReview(sessionId: string): Promise<number> {
        // This method calls scheduleNotesInOrder internally, which saves data.
        // No need to save again here.
        return await this.reviewSessionService.scheduleSessionForReview(sessionId);
    }

    async saveMCQSet(mcqSet: MCQSet): Promise<string> {
        const id = this.mcqService.saveMCQSet(mcqSet);
        // await this.saveData(); // Removed
        return id;
    }

    getMCQSetForNote(notePath: string): MCQSet | null {
        return this.mcqService.getMCQSetForNote(notePath);
    }

    async saveMCQSession(session: MCQSession): Promise<void> {
        this.mcqService.saveMCQSession(session);
        // await this.saveData(); // Removed
    }

    getMCQSessionsForNote(notePath: string): MCQSession[] {
        return this.mcqService.getMCQSessionsForNote(notePath);
    }

    getLatestMCQSessionForNote(notePath: string): MCQSession | null {
        return this.mcqService.getLatestMCQSessionForNote(notePath);
    }

    async updateCustomNoteOrder(order: string[]): Promise<void> {
        await this.reviewScheduleService.updateCustomNoteOrder(order);
        // await this.saveData(); // Removed
    }

    getDueNotesWithCustomOrder(date: number = Date.now(), useCustomOrder: boolean = true): ReviewSchedule[] {
        return this.reviewScheduleService.getDueNotesWithCustomOrder(date, useCustomOrder);
    }

    // Removed internal helper methods that were moved to services
}
