import { TFile } from 'obsidian';
import SpaceforgePlugin from './main';
import { ReviewHistoryItem, ReviewSchedule, ReviewResponse } from './models/review-schedule';
import { ReviewSessionStore, ReviewSession } from './models/review-session';
import { MCQSet, MCQSession } from './models/mcq';
import { EstimationUtils } from './utils/estimation';
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
        let isValid = true;
        if (!this.reviewScheduleService.schedules || typeof this.reviewScheduleService.schedules !== 'object') {
            this.reviewScheduleService.schedules = {};
            isValid = false;
        } else {
            for (const path in this.reviewScheduleService.schedules) {
                const schedule = this.reviewScheduleService.schedules[path];
                if (!schedule || typeof schedule !== 'object') {
                    delete this.reviewScheduleService.schedules[path];
                    isValid = false;
                    continue;
                }
                const s = schedule as unknown as Record<string, unknown>;
                if (!('path' in s) || typeof s.path !== 'string' ||
                    !('lastReviewDate' in s) || (s.lastReviewDate !== null && typeof s.lastReviewDate !== 'number') ||
                    !('nextReviewDate' in s) || typeof s.nextReviewDate !== 'number' ||
                    !('ease' in s) || typeof s.ease !== 'number') {

                    delete this.reviewScheduleService.schedules[path];
                    isValid = false;
                }
            }
        }
        if (!Array.isArray(this.reviewHistoryService.history)) {
            this.reviewHistoryService.history = [];
            isValid = false;
        }
        if (!this.reviewSessionService.reviewSessions ||
            typeof this.reviewSessionService.reviewSessions !== 'object' ||
            !this.reviewSessionService.reviewSessions.sessions ||
            typeof this.reviewSessionService.reviewSessions.sessions !== 'object') {

            this.reviewSessionService.reviewSessions = {
                sessions: {},
                activeSessionId: null
            };
            isValid = false;
        }
        if (!this.mcqService.mcqSets || typeof this.mcqService.mcqSets !== 'object') {
            this.mcqService.mcqSets = {};
            isValid = false;
        }
        if (!this.mcqService.mcqSessions || typeof this.mcqService.mcqSessions !== 'object') {
            this.mcqService.mcqSessions = {};
            isValid = false;
        }
        if (!Array.isArray(this.reviewScheduleService.customNoteOrder)) {
            this.reviewScheduleService.customNoteOrder = [];
            isValid = false;
        }
        if (this.reviewScheduleService.lastLinkAnalysisTimestamp !== null && typeof this.reviewScheduleService.lastLinkAnalysisTimestamp !== 'number') {
            this.reviewScheduleService.lastLinkAnalysisTimestamp = null;
            isValid = false;
        }
        const noSchedules = Object.keys(this.reviewScheduleService.schedules).length === 0;
        const hasMCQs = Object.keys(this.mcqService.mcqSets).length > 0;

        if (noSchedules && hasMCQs) {
            // no-op
        }
        return isValid;
    }

    public cleanupNonExistentFiles(): boolean {
        let changesMade = false;
        if (!this.reviewScheduleService.schedules || typeof this.reviewScheduleService.schedules !== 'object') {
            this.reviewScheduleService.schedules = {};
            changesMade = true;
        }
        if (!Array.isArray(this.reviewHistoryService.history)) {
            this.reviewHistoryService.history = [];
            changesMade = true;
        }
        if (!this.reviewSessionService.reviewSessions || typeof this.reviewSessionService.reviewSessions !== 'object' || !this.reviewSessionService.reviewSessions.sessions) {
            this.reviewSessionService.reviewSessions = {
                sessions: {},
                activeSessionId: null
            };
            changesMade = true;
        }
        let cleanupCount = 0;
        const beforeCount = Object.keys(this.reviewScheduleService.schedules).length;
        const safetyCheck = {
            totalSchedules: beforeCount,
            checkedSchedules: 0,
            missingSchedules: 0,
            preserved: false
        };
        try {
            const allSchedules = { ...this.reviewScheduleService.schedules };
            const allFiles = new Set<string>();
            try {
                this.plugin.app.vault.getMarkdownFiles().forEach(file => allFiles.add(file.path));
            } catch {
                return changesMade;
            }
            if (allFiles.size === 0 && beforeCount > 0) {
                safetyCheck.preserved = true;
                return changesMade;
            }
            for (const path in allSchedules) {
                try {
                    safetyCheck.checkedSchedules++;
                    if (allFiles.has(path)) continue;
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (!file) {
                        safetyCheck.missingSchedules++;
                        delete this.reviewScheduleService.schedules[path];
                        cleanupCount++;
                        changesMade = true;
                    }
                } catch {
                    // no-op
                }
                if (safetyCheck.missingSchedules > 0 &&
                    safetyCheck.missingSchedules === safetyCheck.checkedSchedules &&
                    safetyCheck.checkedSchedules >= 5) {

                    this.reviewScheduleService.schedules = allSchedules;
                    cleanupCount = 0;
                    changesMade = false;
                    safetyCheck.preserved = true;
                    break;
                }
            }
            if (cleanupCount > 0 && !safetyCheck.preserved) {
                // no-op
            }
            const dataState = {
                schedules: Object.keys(this.reviewScheduleService.schedules).length,
                history: this.reviewHistoryService.history.length,
                reviewSessions: Object.keys(this.reviewSessionService.reviewSessions.sessions || {}).length,
                mcqSets: Object.keys(this.mcqService.mcqSets || {}).length,
                mcqSessions: Object.keys(this.mcqService.mcqSessions || {}).length
            };
            if (dataState.schedules === 0 && (dataState.history > 0 || dataState.reviewSessions > 0 || dataState.mcqSets > 0)) {
                // no-op
            }
        } catch {
            // no-op
        }

        return changesMade; // Return whether cleanup occurred
    }


    // The following methods are now delegated to the respective service classes.
    // They are kept here as public methods to maintain the public API of DataStorage,
    // but they now simply call the corresponding method on the service instance.
    // REMOVED await this.saveData() from all these methods.

    async scheduleNoteForReview(path: string, daysFromNow = 0): Promise<void> {
        await this.reviewScheduleService.scheduleNoteForReview(path, daysFromNow);
        // await this.saveData(); // Removed
    }

    recordReview(path: string, response: ReviewResponse, isSkipped = false): boolean {
        return this.reviewScheduleService.recordReview(path, response, isSkipped);
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

    async postponeNote(path: string, days = 1): Promise<void> {
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
        } catch {
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

    async scheduleNotesInOrder(paths: string[], daysFromNow = 0): Promise<number> {
        const count = await this.reviewScheduleService.scheduleNotesInOrder(paths, daysFromNow);
        // if (count > 0) { // Removed save call
        //      await this.saveData();
        // }
        return count;
    }

    scheduleSessionForReview(sessionId: string): number {
        // This method calls scheduleNotesInOrder internally, which saves data.
        // No need to save again here.
        return this.reviewSessionService.scheduleSessionForReview(sessionId);
    }

    saveMCQSet(mcqSet: MCQSet): string {
        const id = this.mcqService.saveMCQSet(mcqSet);
        // await this.saveData(); // Removed
        return id;
    }

    getMCQSetForNote(notePath: string): MCQSet | null {
        return this.mcqService.getMCQSetForNote(notePath);
    }

    saveMCQSession(session: MCQSession): void {
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

    getDueNotesWithCustomOrder(date: number = Date.now(), useCustomOrder = true): ReviewSchedule[] {
        return this.reviewScheduleService.getDueNotesWithCustomOrder(date, useCustomOrder);
    }

    // Removed internal helper methods that were moved to services
}
