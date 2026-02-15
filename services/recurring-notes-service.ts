import SpaceforgePlugin from '../main';
import { ReviewSchedule } from '../models/review-schedule';
import { DateUtils } from '../utils/dates';

/**
 * Service for managing recurring notes functionality
 */
export class RecurringNotesService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /**
     * Convert a regular note to a recurring note
     * @param path Path to the note file
     * @param interval Recurrence interval in days
     * @param endDate Optional end date for recurrence (timestamp)
     */
    async convertToRecurringNote(path: string, interval: number, endDate: number | null = null): Promise<void> {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule) {
            console.warn(`No schedule found for note: ${path}`);
            return;
        }

        // Store the original schedule before making it recurring
        const originalSchedule: ReviewSchedule = {
            ...schedule,
            isRecurring: false,
            recurrenceInterval: undefined,
            recurrenceEndDate: undefined,
            originalSchedule: null
        };

        // Update the schedule to be recurring
        schedule.isRecurring = true;
        schedule.recurrenceInterval = interval;
        schedule.recurrenceEndDate = endDate;
        schedule.originalSchedule = originalSchedule;

        // Schedule the next occurrence
        await this.scheduleNextRecurrence(path);
        
        await this.plugin.savePluginData();
    }

    /**
     * Schedule the next occurrence of a recurring note
     * @param path Path to the note file
     */
    async scheduleNextRecurrence(path: string): Promise<void> {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule || !schedule.isRecurring || !schedule.recurrenceInterval) {
            return;
        }

        const now = Date.now();
        const nextReviewDate = schedule.nextReviewDate || now;
        
        // Calculate the next occurrence based on the recurrence interval
        const nextOccurrenceDate = nextReviewDate + (schedule.recurrenceInterval * 24 * 60 * 60 * 1000);
        
        // If there's an end date and we've passed it, don't schedule further occurrences
        if (schedule.recurrenceEndDate && nextOccurrenceDate > schedule.recurrenceEndDate) {
            schedule.isRecurring = false; // Stop recurrence
            return;
        }

        // Update the schedule with the next occurrence date
        schedule.nextReviewDate = nextOccurrenceDate;
        schedule.lastReviewDate = nextReviewDate; // Mark as reviewed for this occurrence
        
        await this.plugin.savePluginData();
    }

    /**
     * Convert a recurring note back to a regular note
     * @param path Path to the note file
     */
    async convertToRegularNote(path: string): Promise<void> {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule || !schedule.isRecurring) {
            return;
        }

        // Restore original schedule if available
        if (schedule.originalSchedule) {
            const original = schedule.originalSchedule;
            schedule.path = original.path;
            schedule.lastReviewDate = original.lastReviewDate;
            schedule.nextReviewDate = original.nextReviewDate;
            schedule.ease = original.ease;
            schedule.interval = original.interval;
            schedule.consecutive = original.consecutive;
            schedule.reviewCount = original.reviewCount;
            schedule.repetitionCount = original.repetitionCount;
            schedule.scheduleCategory = original.scheduleCategory;
            schedule.fsrsData = original.fsrsData;
            schedule.schedulingAlgorithm = original.schedulingAlgorithm;
        }

        // Remove recurring properties
        schedule.isRecurring = false;
        schedule.recurrenceInterval = undefined;
        schedule.recurrenceEndDate = undefined;
        schedule.originalSchedule = null;

        await this.plugin.savePluginData();
    }

    /**
     * Check if a note is recurring
     * @param path Path to the note file
     * @returns True if the note is recurring
     */
    isNoteRecurring(path: string): boolean {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        return !!schedule?.isRecurring;
    }

    /**
     * Get recurrence information for a note
     * @param path Path to the note file
     * @returns Recurrence information or null if not recurring
     */
    getRecurrenceInfo(path: string): {
        interval: number;
        endDate: number | null;
        nextOccurrence: number;
    } | null {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule?.isRecurring || !schedule.recurrenceInterval) {
            return null;
        }

        return {
            interval: schedule.recurrenceInterval,
            endDate: schedule.recurrenceEndDate || null,
            nextOccurrence: schedule.nextReviewDate
        };
    }

    /**
     * Process all recurring notes and schedule their next occurrences
     * This should be called periodically (e.g., daily)
     */
    async processAllRecurringNotes(): Promise<void> {
        const schedules = this.plugin.reviewScheduleService.schedules;
        const now = Date.now();

        for (const path in schedules) {
            const schedule = schedules[path];
            if (schedule?.isRecurring && schedule.recurrenceInterval) {
                // Check if the note is due for its next occurrence
                if (schedule.nextReviewDate <= now) {
                    await this.scheduleNextRecurrence(path);
                }
            }
        }

        await this.plugin.savePluginData();
    }

    /**
     * Update the recurrence interval for a note
     * @param path Path to the note file
     * @param newInterval New recurrence interval in days
     */
    async updateRecurrenceInterval(path: string, newInterval: number): Promise<void> {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule?.isRecurring) {
            return;
        }

        schedule.recurrenceInterval = newInterval;
        await this.plugin.savePluginData();
    }

    /**
     * Update the recurrence end date for a note
     * @param path Path to the note file
     * @param newEndDate New end date timestamp or null for no end date
     */
    async updateRecurrenceEndDate(path: string, newEndDate: number | null): Promise<void> {
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        if (!schedule?.isRecurring) {
            return;
        }

        schedule.recurrenceEndDate = newEndDate;
        await this.plugin.savePluginData();
    }
}