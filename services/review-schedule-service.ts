import { Notice, TFile, TFolder } from 'obsidian';
import { ReviewSchedule, ReviewResponse, toSM2Quality, FsrsRating } from '../models/review-schedule'; // Added FsrsRating
import SpaceforgePlugin from '../main';
import { DateUtils } from '../utils/dates';
import { FsrsScheduleService } from './fsrs-schedule-service'; // Added FsrsScheduleService
import { EstimationUtils } from '../utils/estimation';
import { ReviewHistoryItem } from '../models/review-schedule'; // Need this for history recording

/**
 * Handles management of review schedules and SM-2 calculations
 */
export class ReviewScheduleService {
    /**
     * Reference to the main plugin
     */
    private plugin: SpaceforgePlugin;
    private fsrsService: FsrsScheduleService; // Added FsrsScheduleService instance

    /**
     * Note schedules indexed by path
     */
    schedules: Record<string, ReviewSchedule> = {};

    /**
     * Custom order for notes (user-defined ordering)
     */
    customNoteOrder: string[] = [];

    /**
     * Timestamp of the last time link analysis was performed for ordering
     */
    lastLinkAnalysisTimestamp: number | null = null;

    /**
     * Review history (will be managed by ReviewHistoryService, but needed for recordReview)
     * This will be a reference to the history array in DataStorage
     */
    history: ReviewHistoryItem[];

    /**
     * Initialize Review Schedule Service
     *
     * @param plugin Reference to the main plugin
     * @param schedules Initial schedules data
     * @param customNoteOrder Initial custom note order data
     * @param lastLinkAnalysisTimestamp Initial last link analysis timestamp
     * @param history Reference to the history array in DataStorage
     */
    constructor(
        plugin: SpaceforgePlugin,
        schedules: Record<string, ReviewSchedule>,
        customNoteOrder: string[],
        lastLinkAnalysisTimestamp: number | null,
        history: ReviewHistoryItem[]
    ) {
        this.plugin = plugin;
        this.schedules = schedules;
        this.customNoteOrder = customNoteOrder;
        this.lastLinkAnalysisTimestamp = lastLinkAnalysisTimestamp;
        this.history = history; 
        this.fsrsService = new FsrsScheduleService(this.plugin.settings);
    }

    public updateAlgorithmServicesForSettingsChange(): void {
        // Call this if settings change, especially FSRS parameters
        this.fsrsService.updateFSRSInstance(this.plugin.settings);
    }

    /**
     * Schedule a note for review
     *
     * @param path Path to the note file
     * @param daysFromNow Days until first review (default: 0, same day)
     */
    async scheduleNoteForReview(path: string, daysFromNow: number = 0): Promise<void> {
        // Check if file exists and is a markdown file
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile) || file.extension !== "md") {
            new Notice("Only markdown files can be added to the review schedule");
            return;
        }

        const now = Date.now();
        const todayUTCStart = DateUtils.startOfUTCDay(new Date(now));
        const defaultAlgorithm = this.plugin.settings.defaultSchedulingAlgorithm;
        
        let newSchedule: ReviewSchedule;

        if (defaultAlgorithm === 'fsrs') {
            // FSRS card creation date is the exact moment. Its nextReviewDate is also an exact moment.
            const fsrsData = this.fsrsService.createNewFsrsCardData(new Date(now));
            newSchedule = {
                path,
                lastReviewDate: null, // Will be UTC midnight when set
                nextReviewDate: now, // FSRS cards are due immediately (exact timestamp)
                reviewCount: 0,
                schedulingAlgorithm: 'fsrs',
                fsrsData: fsrsData,
                // SM-2 fields can be undefined or default
                ease: this.plugin.settings.baseEase, // Keep a base for potential conversion
                interval: 0, 
                consecutive: 0,
                repetitionCount: 0,
                scheduleCategory: undefined, // Not applicable to FSRS
            };
            // daysFromNow is ignored for FSRS initial scheduling, it follows its learning steps.
        } else { // sm2
            newSchedule = {
                path,
                lastReviewDate: null, // Will be UTC midnight when set
                nextReviewDate: DateUtils.addDays(todayUTCStart, daysFromNow),
                ease: this.plugin.settings.baseEase,
                interval: daysFromNow,
                consecutive: 0,
                reviewCount: 0,
                repetitionCount: 0,
                scheduleCategory: this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced',
                schedulingAlgorithm: 'sm2',
                fsrsData: undefined,
            };

            if (newSchedule.scheduleCategory === 'initial') {
                const initialIntervals = this.plugin.settings.initialScheduleCustomIntervals;
                if (initialIntervals && initialIntervals.length > 0) {
                    newSchedule.interval = daysFromNow > 0 ? daysFromNow : initialIntervals[0];
                }
                if (daysFromNow === 0) {
                    newSchedule.nextReviewDate = DateUtils.addDays(todayUTCStart, newSchedule.interval);
                }
            }
        }
        this.schedules[path] = newSchedule;

        // Add to custom order if not already present
        if (!this.customNoteOrder.includes(path)) {
            this.customNoteOrder.push(path);
        }

        // Data saving is now handled by main.ts after this method returns

        // Notify any listeners (for UI updates)
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        new Notice(`Note added to review schedule`);
    }

    /**
     * Check if a note is due for review on or before the specified date
     * 
     * @param schedule The review schedule for the note
     * @param effectiveReviewDate The date to check against
     * @returns true if the note is due, false otherwise
     */
    private isNoteDue(schedule: ReviewSchedule, effectiveReviewDate: number): boolean {
        const reviewDateObj = new Date(effectiveReviewDate);
        const effectiveUTCDayEnd = DateUtils.endOfUTCDay(reviewDateObj);
        
        // Note is due if its nextReviewDate is on or before the effective date
        // Allow notes due today or earlier to be reviewed
        return schedule.nextReviewDate <= effectiveUTCDayEnd;
    }

    /**
     * Record a review for a note
     *
     * @param path Path to the note file
     * @param response User's response during review (can be SM-2 or FSRS rating)
     * @param isSkipped Whether this review was explicitly skipped (default: false)
     * @param currentReviewDate Optional timestamp for the current review date (simulated or actual)
     * @returns true if the review was recorded, false if it was just a preview
     */
    async recordReview(path: string, response: ReviewResponse | FsrsRating, isSkipped: boolean = false, currentReviewDate?: number): Promise<boolean> {
        const schedule = this.schedules[path];
        if (!schedule) return false;

        const effectiveReviewDate = currentReviewDate || Date.now();
        
        // Check if the note is actually due for review
        const isDue = this.isNoteDue(schedule, effectiveReviewDate);
        
        if (!isDue) {
            // Note is not due, this is just a preview - don't record anything
            return false;
        }

        const reviewDateObj = new Date(effectiveReviewDate);
        const effectiveUTCDayStart = DateUtils.startOfUTCDay(reviewDateObj);

        // Determine historyResponse for logging
        let historyResponseValue: ReviewResponse;
        if (Object.values(FsrsRating).includes(response as FsrsRating) && typeof response === "number") {
            switch (response as FsrsRating) {
                case FsrsRating.Again: historyResponseValue = ReviewResponse.IncorrectResponse; break;
                case FsrsRating.Hard: historyResponseValue = ReviewResponse.IncorrectButFamiliar; break;
                case FsrsRating.Good: historyResponseValue = ReviewResponse.CorrectWithDifficulty; break;
                case FsrsRating.Easy: historyResponseValue = ReviewResponse.CorrectWithHesitation; break;
                default: historyResponseValue = ReviewResponse.CorrectWithDifficulty;
            }
        } else {
            historyResponseValue = toSM2Quality(response as ReviewResponse);
        }

        // Record the actual review
        if (!isSkipped) {
            schedule.reviewCount = (schedule.reviewCount || 0) + 1;
        }
        schedule.lastReviewDate = effectiveUTCDayStart;

        // Log to history
        this.history.push({
            path,
            timestamp: effectiveReviewDate,
            response: historyResponseValue,
            interval: schedule.interval ?? schedule.fsrsData?.scheduled_days ?? 0,
            ease: schedule.ease ?? (schedule.fsrsData?.difficulty ? Math.round(schedule.fsrsData.difficulty * 10) : this.plugin.settings.baseEase),
            isSkipped: isSkipped
        });
        if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);

        if (schedule.schedulingAlgorithm === 'fsrs') {
            if (!schedule.fsrsData) { // Should not happen if card is properly initialized
            // FSRS service expects a Date object for the review time.
            // reviewDateObj (created from effectiveReviewDate) is correct here.
            schedule.fsrsData = this.fsrsService.createNewFsrsCardData(reviewDateObj);
        }

        // --- START FIX: Determine correct FsrsRating ---
        let actualFsrsRating: FsrsRating;
        // Check if the response is one of the legacy ReviewResponse values from MCQ modal
        if (response === ReviewResponse.Perfect) { // Value 5
            actualFsrsRating = FsrsRating.Easy; // Map to 4
        } else if (response === ReviewResponse.Good) { // Value 4
            actualFsrsRating = FsrsRating.Good; // Map to 3
        } else if (response === ReviewResponse.Fair) { // Value 3
            actualFsrsRating = FsrsRating.Hard; // Map to 2
        } else if (response === ReviewResponse.Hard) { // Value 1 (legacy)
            actualFsrsRating = FsrsRating.Again; // Map to 1
        } else if (Object.values(FsrsRating).includes(response as FsrsRating)) {
             // If it's already a valid FsrsRating (1, 2, 3, 4), use it directly
            actualFsrsRating = response as FsrsRating;
        } else {
            // Fallback for unexpected values (e.g., SM-2 specific 0, 2, potentially)
            // Map based on general difficulty
            const quality = toSM2Quality(response as ReviewResponse);
            if (quality >= 4) actualFsrsRating = FsrsRating.Easy; // 4, 5 -> Easy
            else if (quality === 3) actualFsrsRating = FsrsRating.Good; // 3 -> Good
            else if (quality === 2) actualFsrsRating = FsrsRating.Hard; // 2 -> Hard
            else actualFsrsRating = FsrsRating.Again; // 0, 1 -> Again
        }
        // --- END FIX ---

        const { updatedData, nextReviewDate: newNextReviewDateFsrs } = this.fsrsService.recordReview(
            schedule.fsrsData,
            actualFsrsRating, // Pass the correctly determined FsrsRating
            reviewDateObj // Pass the exact moment of review
        );
        schedule.fsrsData = updatedData;
        schedule.nextReviewDate = newNextReviewDateFsrs; // This is already a UTC timestamp from FSRS
            // SM-2 specific fields are not updated for FSRS cards
            schedule.interval = updatedData.scheduled_days; // For display consistency if needed
            schedule.ease = Math.round(updatedData.difficulty * 10); // Approximate for display

        } else { // SM-2
            let qualityRating = toSM2Quality(response as ReviewResponse);
            
            // Initialize SM-2 fields if they are somehow missing (should not happen for SM-2 cards)
            schedule.ease = schedule.ease ?? this.plugin.settings.baseEase;
            schedule.interval = schedule.interval ?? 0;
            schedule.repetitionCount = schedule.repetitionCount ?? 0;
            schedule.consecutive = schedule.consecutive ?? 0;
            schedule.scheduleCategory = schedule.scheduleCategory ?? (this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced');


            if (schedule.scheduleCategory === 'initial') {
                const initialIntervals = this.plugin.settings.initialScheduleCustomIntervals || [];
                // reviewCount is 0-indexed for history, 1-indexed for human counting of reviews.
                // If reviewCount is 0 (first review), initialIntervals[0] is the interval *after* this review.
                // If reviewCount is 1 (second review), initialIntervals[1] is the interval *after* this review.
                // The schedule.reviewCount was already incremented if not skipped.
                // So, if reviewCount is now 1 (meaning 1st review just happened), use initialIntervals[0] for next interval.
                // This seems to be what the original logic intended with `initialIntervals[schedule.reviewCount]`
                // if reviewCount was considered 0-indexed for *which review this is*.
                // Let's assume schedule.reviewCount (already incremented) is the number of reviews *completed*.
                // If 1 review completed, next interval is initialIntervals[0] if length allows.
                // If `schedule.reviewCount -1` is the index for the interval *just completed*, then `schedule.reviewCount`
                // would be the index for the *next* interval.
                // The original `schedule.reviewCount < initialIntervals.length` and `initialIntervals[schedule.reviewCount]`
                // implies that if `reviewCount` is (e.g.) 0 after incrementing (meaning it was -1, which is impossible),
                // it would take `initialIntervals[0]`. If `reviewCount` is 1, it takes `initialIntervals[1]`.
                // This needs to be robust. Let's use `schedule.repetitionCount` for initial steps as it's clearer.
                // For initial phase, repetitionCount tracks progression through initial steps.

                if (schedule.repetitionCount < initialIntervals.length) {
                    schedule.interval = initialIntervals[schedule.repetitionCount];
                } else { // Graduated from initial steps
                    schedule.scheduleCategory = 'graduated';
                    // For the first SM-2 calculation after graduation, treat as if n=0 for interval calc.
                    // daysLate should be 0 as we are just graduating.
                    const daysLateForGraduation = 0;
                    const { interval, ease, repetitionCount: newRepCount } = this.calculateSM2Schedule(
                        schedule.interval, // previous interval (last of initial steps)
                        schedule.ease,
                        qualityRating,
                        0, // Reset repetition count for SM-2 calculation after graduation
                        daysLateForGraduation,
                        isSkipped
                    );
                    schedule.interval = interval;
                    schedule.ease = ease;
                    schedule.repetitionCount = newRepCount; // This will be 1 if q >= 3
                }

                // Update ease factor regardless of graduation
                const q = qualityRating;
                let newEase = schedule.ease / 100;
                newEase = newEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
                newEase = Math.max(1.3, newEase);
                schedule.ease = Math.round(newEase * 100);

                if (qualityRating >= ReviewResponse.CorrectWithDifficulty) {
                    schedule.consecutive += 1;
                    if (qualityRating >= 3) {
                        // repetitionCount for initial phase should increment if successful, reset if not.
                    // This is distinct from the SM-2 n.
                    schedule.repetitionCount = (schedule.repetitionCount || 0) + 1;
                    } else { // q < 3
                        schedule.repetitionCount = 0; // Reset progress in initial steps
                    }
                } else { // q < 3
                    schedule.consecutive = 0;
                    schedule.repetitionCount = 0; // Reset progress in initial steps
                }
            } else { // 'spaced' or 'graduated' (already graduated or started as spaced)
                const daysLate = schedule.nextReviewDate < effectiveUTCDayStart ? // Compare with UTC day start
                    DateUtils.dayDifferenceUTC(schedule.nextReviewDate, effectiveUTCDayStart) : 0;
                const { interval, ease, repetitionCount } = this.calculateSM2Schedule(
                    schedule.interval, schedule.ease, qualityRating, schedule.repetitionCount || 0, daysLate, isSkipped
                );
                schedule.interval = interval;
                schedule.ease = ease;
                schedule.repetitionCount = repetitionCount;

                if (qualityRating >= ReviewResponse.CorrectWithDifficulty) {
                    schedule.consecutive += 1;
                } else {
                    schedule.consecutive = 0;
                }
            }
            // Base the next review date on the UTC start of the current review day
            schedule.nextReviewDate = DateUtils.addDays(effectiveUTCDayStart, schedule.interval);
        }

        // Data saving is now handled by main.ts after this method returns

        // Notify any listeners (for UI updates)
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        return true; // Review was successfully recorded
    }

    /**
     * Calculate new schedule parameters based on review response using the SM-2 algorithm
     * (This method is likely redundant now that recordReview uses calculateSM2Schedule directly,
     * but keeping for potential external use or backward compatibility if needed)
     *
     * @param currentInterval Current interval in days
     * @param currentEase Current ease factor
     * @param response User's response during review
     * @param repetitionCount Current repetition count (n)
     * @param daysLate How many days late the review is (0 if on time or early)
     * @param isSkipped Whether the item was explicitly skipped by the user
     * @returns New interval, ease, and repetition count
     */
    calculateNewSchedule(
        currentInterval: number,
        currentEase: number,
        response: ReviewResponse,
        repetitionCount: number = 0,
        daysLate: number = 0,
        isSkipped: boolean = false
    ): { interval: number, ease: number, repetitionCount: number } {
         // Ensure response is in the valid SM-2 range (0-5)
         let qualityRating = toSM2Quality(response);

         // Handle overdue or skipped items according to modified SM-2 algorithm
         if (isSkipped || daysLate > 0) {
             // Determine effective quality rating:
             // - If explicitly skipped, reduce quality by 1 (but not below 0)
             // - If overdue, set quality to 0
             // - If both overdue and explicitly skipped, prioritize the skip logic (user choice)
             const q_eff = isSkipped ? Math.max(0, qualityRating - 1) : 0;

             // Convert ease from internal format (250 = 2.5) to SM-2 format (2.5)
             let ease = currentEase / 100;

             // Calculate new ease factor using SM-2 formula with the effective quality
             ease = ease + (0.1 - (5 - q_eff) * (0.08 + (5 - q_eff) * 0.02));

             // Apply minimum ease factor (SM-2 specifies 1.3 as the minimum)
             ease = Math.max(1.3, ease);

             // Force next review to be tomorrow (interval = 1) regardless of computed interval
             // and reset repetition count to 1
             return {
                 interval: 1, // Force next review to be tomorrow
                 ease: Math.round(ease * 100), // Convert back to internal format
                 repetitionCount: 1 // Reset repetition count to 1
             };
         }

         // For normal reviews, use the regular SM-2 implementation
         // Convert ease from internal format (250 = 2.5) to SM-2 format (2.5)
         let ease = currentEase / 100;
         let newRepetitionCount = repetitionCount;
         let interval: number;

         // Calculate new ease factor using SM-2 formula
         // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
         ease = ease + (0.1 - (5 - qualityRating) * (0.08 + (5 - qualityRating) * 0.02));

         // Apply minimum ease factor (SM-2 specifies 1.3 as the minimum)
         ease = Math.max(1.3, ease);

         // If response is less than 3, reset repetition count to 0 (per strict SM-2)
         if (qualityRating < 3) {
             newRepetitionCount = 0;
             interval = 1; // Next interval is 1 day for failed items
         } else {
             // Increment repetition count for correct responses
             newRepetitionCount += 1;

             // Calculate new interval based on SM-2 rules
             if (newRepetitionCount === 1) {
                 interval = 1;
             } else if (newRepetitionCount === 2) {
                 interval = 6;
             } else {
                 // For n > 2, use the formula I_n = I_(n-1) * EF
                 interval = Math.round(currentInterval * ease);
             }
         }

         // Apply load balancing if enabled (this is an extension to the algorithm)
         if (this.plugin.settings.loadBalance) {
             const fuzz = interval > 7 ? Math.min(3, Math.floor(interval * 0.05)) : 0;
             interval = interval + Math.random() * fuzz * 2 - fuzz;
         }

         // Ensure interval is at least 1 day
         interval = Math.max(1, interval);

         // Enforce maximum interval (this is an extension to the algorithm)
         interval = Math.min(interval, this.plugin.settings.maximumInterval);

         // Convert ease back to internal format before returning
         return {
             interval: Math.round(interval), // SM-2 uses whole days
             ease: Math.round(ease * 100),
             repetitionCount: newRepetitionCount
         };
    }

     /**
      * Calculate new schedule parameters using the enhanced SM-2 algorithm with lateness penalty
      * (This is the core calculation logic used internally by recordReview and skipNote)
      *
      * @param currentInterval Current interval in days
      * @param currentEase Current ease factor (expressed as a number where 2.5 = 250)
      * @param qualityRating User's response during review, as a numeric quality rating (0-5)
      * @param repetitionCount Current repetition count (n)
      * @param daysLate How many days late the review is (0 if on time or early)
      * @param isSkipped Whether the item was explicitly skipped by the user
      * @returns New interval, ease, and repetition count
      */
     private calculateSM2Schedule(
         currentInterval: number,
         currentEase: number,
         qualityRating: number, // Changed parameter type from ReviewResponse to number
         repetitionCount: number = 0,
         daysLate: number = 0,
         isSkipped: boolean = false
     ): { interval: number, ease: number, repetitionCount: number } {
         // qualityRating is now expected to be a number (0-5) directly.
         // The call to toSM2Quality(response) is removed.

         // Handle overdue or skipped items according to modified SM-2 algorithm
         if (isSkipped || daysLate > 0) {
             // Determine effective quality rating:
             // - If explicitly skipped, reduce quality by 1 (but not below 0)
             // - If overdue, set quality to 0
             // - If both overdue and explicitly skipped, prioritize the skip logic (user choice)
             const q_eff = isSkipped ? Math.max(0, qualityRating - 1) : 0;

             // Convert ease from internal format (250 = 2.5) to SM-2 format (2.5)
             let ease = currentEase / 100;

             // Calculate new ease factor using SM-2 formula with the effective quality
             ease = ease + (0.1 - (5 - q_eff) * (0.08 + (5 - q_eff) * 0.02));

             // Apply minimum ease factor (SM-2 specifies 1.3 as the minimum)
             ease = Math.max(1.3, ease);

             // Force next review to be tomorrow (interval = 1) regardless of computed interval
             // and reset repetition count to 1
             const result = {
                 interval: 1, // Force next review to be tomorrow
                 ease: Math.round(ease * 100), // Convert back to internal format
                 repetitionCount: 1 // Reset repetition count to 1
             };

             return result;
         }

         // For normal reviews, use the regular SM-2 implementation
         // Convert ease from internal format (250 = 2.5) to SM-2 format (2.5)
         let ease = currentEase / 100;
         let newRepetitionCount = repetitionCount;
         let interval: number;

         // Calculate new ease factor using SM-2 formula
         // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
         ease = ease + (0.1 - (5 - qualityRating) * (0.08 + (5 - qualityRating) * 0.02));

         // Apply minimum ease factor (SM-2 specifies 1.3 as the minimum)
         ease = Math.max(1.3, ease);

         // If response is less than 3, reset repetition count to 0 (per strict SM-2)
         if (qualityRating < 3) {
             newRepetitionCount = 0;
             interval = 1; // Next interval is 1 day for failed items
         } else {
             // Increment repetition count for correct responses
             newRepetitionCount += 1;

             // Calculate new interval based on SM-2 rules
             if (newRepetitionCount === 1) {
                 interval = 1;
             } else if (newRepetitionCount === 2) {
                 interval = 6;
             } else {
                 // For n > 2, use the formula I_n = I_(n-1) * EF
                 interval = Math.round(currentInterval * ease);
             }
         }

         // Apply load balancing if enabled (this is an extension to the algorithm)
         if (this.plugin.settings.loadBalance) {
             const fuzz = interval > 7 ? Math.min(3, Math.floor(interval * 0.05)) : 0;
             interval = interval + Math.random() * fuzz * 2 - fuzz;
         }

         // Ensure interval is at least 1 day
         interval = Math.max(1, interval);

         // Enforce maximum interval (this is an extension to the algorithm)
         interval = Math.min(interval, this.plugin.settings.maximumInterval);

         // Convert ease back to internal format before returning
         return {
             interval: Math.round(interval), // SM-2 uses whole days
             ease: Math.round(ease * 100),
             repetitionCount: newRepetitionCount
         };
     }


    /**
     * Get notes due for review
     *
     * @param date Optional target date (default: now)
     * @param matchExactDate If true, only return notes due exactly on this date (ignoring time). Otherwise, notes due on or before this date.
     * @returns Array of due note schedules sorted by due date
     */
    getDueNotes(date: number = Date.now(), matchExactDate: boolean = false): ReviewSchedule[] {
        const targetDate = new Date(date);
        const targetUTCDayStart = DateUtils.startOfUTCDay(targetDate);
        const targetUTCDayEnd = DateUtils.endOfUTCDay(targetDate);

        return Object.values(this.schedules)
            .filter(schedule => {
                if (matchExactDate) {
                    // For all algorithms, a note is due on an exact date if its next review
                    // timestamp falls anywhere within that UTC day.
                    return schedule.nextReviewDate >= targetUTCDayStart && schedule.nextReviewDate <= targetUTCDayEnd;
                } else {
                    // For all algorithms, a note is due "today" (or on/before a date) if its
                    // next review timestamp is anytime up to the end of that UTC day.
                    return schedule.nextReviewDate <= targetUTCDayEnd;
                }
            })
            .sort((a, b) => a.nextReviewDate - b.nextReviewDate);
    }

    /**
     * Get upcoming reviews within a specified timeframe
     *
     * @param days Number of days to look ahead
     * @returns Array of upcoming review schedules sorted by due date
     */
    getUpcomingReviews(days: number = 7): ReviewSchedule[] {
        const now = Date.now();
        const futureDate = DateUtils.addDays(now, days);

        return Object.values(this.schedules)
            .filter(schedule =>
                schedule.nextReviewDate > now &&
                schedule.nextReviewDate <= futureDate
            )
            .sort((a, b) => a.nextReviewDate - b.nextReviewDate);
    }

    /**
     * Skip a note's review and reschedule for tomorrow with penalized quality
     *
     * This implements the "Postpone to Tomorrow" functionality from the modified SM-2 algorithm.
     * It applies a one-step quality penalty (reduce by 1 but not below 0) and forces the next
     * review to be tomorrow, regardless of what the normal interval would be. This keeps items
     * in rotation rather than letting them disappear into an ever-growing backlog.
     *
     * @param path Path to the note file
     * @param response Optional user's response to use for penalty calculation
     * @param currentReviewDate Optional timestamp for the current review date (simulated or actual)
     */
    async skipNote(path: string, response: ReviewResponse | FsrsRating = ReviewResponse.CorrectWithDifficulty, currentReviewDate?: number): Promise<void> {
        const schedule = this.schedules[path];
        if (!schedule) return;
        
        const effectiveReviewDate = currentReviewDate || Date.now();
        const reviewDateObj = new Date(effectiveReviewDate);

        // Record as a skipped review (isSkipped = true)
        // The 'response' for a skip is less critical but can be used for penalty in SM-2.
        // For FSRS, skipReview in FsrsService handles it as 'Again'.
        if (schedule.schedulingAlgorithm === 'fsrs') {
            if (!schedule.fsrsData) { // Should not happen
                schedule.fsrsData = this.fsrsService.createNewFsrsCardData(reviewDateObj);
            }
            const { updatedData, nextReviewDate: newNextReviewDateFsrs, log } = this.fsrsService.skipReview(
                schedule.fsrsData,
                reviewDateObj // Pass exact moment for FSRS skip
            );
            schedule.fsrsData = updatedData;
            schedule.nextReviewDate = newNextReviewDateFsrs; // Already a UTC timestamp
            schedule.lastReviewDate = DateUtils.startOfUTCDay(reviewDateObj); // FSRS skip is a review, set last review to UTC midnight

            this.history.push({ // Log FSRS skip
                path, timestamp: effectiveReviewDate, response: ReviewResponse.IncorrectResponse, // Approx. for log
                interval: schedule.fsrsData.scheduled_days, ease: Math.round(schedule.fsrsData.difficulty * 10), isSkipped: true
            });

        } else { // SM-2
            let qualityRating = toSM2Quality(response as ReviewResponse);
            qualityRating = Math.max(0, qualityRating - 1); // Apply skip penalty for SM-2

            this.history.push({
                path, timestamp: effectiveReviewDate, response: qualityRating,
                interval: schedule.interval || 0, ease: schedule.ease || 0, isSkipped: true
            });

            const effectiveUTCDayStart = DateUtils.startOfUTCDay(reviewDateObj);
            schedule.lastReviewDate = effectiveUTCDayStart; // Set last review to UTC midnight

            if (schedule.scheduleCategory === 'initial') {
                schedule.interval = 1; // Skip in initial phase often means try again soon
                schedule.nextReviewDate = DateUtils.addDays(effectiveUTCDayStart, 1);
                // For initial phase skips, repetitionCount might not advance or could reset.
                // The current calculateSM2Schedule with isSkipped=true will set repCount=1.
            } else {
                const { interval, ease, repetitionCount } = this.calculateSM2Schedule(
                    schedule.interval || 0, schedule.ease || this.plugin.settings.baseEase, qualityRating,
                    schedule.repetitionCount || 0, 0, true // daysLate = 0 for a skip, isSkipped = true
                );
                schedule.interval = interval; // Will be 1 due to isSkipped=true
                schedule.ease = ease;
                schedule.repetitionCount = repetitionCount; // Will be 1
                schedule.nextReviewDate = DateUtils.addDays(effectiveUTCDayStart, interval);
            }
            schedule.consecutive = 0;
        }

        // Data saving is now handled by main.ts after this method returns

        // Notify any listeners (for UI updates)
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }
    }

    /**
     * Postpone a note's review
     *
     * @param path Path to the note file
     * @param days Number of days to postpone (default: 1)
     */
    async postponeNote(path: string, days: number = 1): Promise<void> {
        const schedule = this.schedules[path];
        if (!schedule) return;

        // Update the review date, preserving the current phase
        // regardless of which initial phase the note is in
        schedule.nextReviewDate = DateUtils.addDays(schedule.nextReviewDate, days);
        // Data saving is now handled by main.ts after this method returns

        // Note: We're now handling the UI update through the controller's postponeNote method
        // directly, so we don't need to call handleNotePostponed here to avoid duplicate calls

        // Refresh the sidebar view if available with a slight delay to allow data to settle
        if (this.plugin.events) {
            setTimeout(() => {
                this.plugin.events.emit('sidebar-update');
            }, 50); // Small delay (e.g., 50ms)
        }

        new Notice(`Review postponed for ${days} day${days !== 1 ? 's' : ''}`);
    }

    /**
     * Advance a note's review by one day, if eligible.
     *
     * @param path Path to the note file
     * @returns True if the note was advanced, false otherwise.
     */
    async advanceNote(path: string): Promise<boolean> {
        const schedule = this.schedules[path];
        if (!schedule) {
            return false;
        }

        const todayUTCMidnight = DateUtils.startOfUTCDay(new Date());
        // For SM-2, nextReviewDate is already UTC midnight. For FSRS, it's an exact time.
        // To compare consistently for "advancing a day", we should compare UTC day starts.
        const noteReviewUTCDayStart = DateUtils.startOfUTCDay(new Date(schedule.nextReviewDate));

        // Only advance future notes, and not past today (based on UTC days)
        if (noteReviewUTCDayStart <= todayUTCMidnight) {
            return false;
        }

        // New potential next review date is one day earlier.
        // If FSRS, it's one day earlier from its exact time. If SM-2, one day earlier from its UTC midnight.
        const newPotentialNextReviewTimestamp = DateUtils.addDays(schedule.nextReviewDate, -1);
        
        // Ensure the new date (if SM-2, its UTC day start) is not before todayUTCMidnight
        if (schedule.schedulingAlgorithm === 'sm2') {
            schedule.nextReviewDate = Math.max(todayUTCMidnight, DateUtils.startOfUTCDay(new Date(newPotentialNextReviewTimestamp)));
        } else { // FSRS
            // For FSRS, ensure the new exact time is not earlier than the start of today UTC.
            // Or, more practically, not earlier than the current exact time if that's preferred.
            // Let's keep it simple: advance by one day, but not before current UTC midnight.
            schedule.nextReviewDate = Math.max(todayUTCMidnight, newPotentialNextReviewTimestamp);
        }

        // Data saving is handled by the calling controller (e.g., ReviewControllerCore)

        if (this.plugin.events) {
            // Use a timeout to allow other operations to complete before UI refresh
            setTimeout(() => {
                this.plugin.events.emit('sidebar-update');
            }, 50);
        }
        // Notice is handled by the calling controller for better context.
        return true;
    }

    /**
     * Remove a note from the review schedule
     *
     * @param path Path to the note file
     */
    async removeFromReview(path: string): Promise<void> {
        if (this.schedules[path]) {
            delete this.schedules[path];

            // Remove from custom order if present
            this.customNoteOrder = this.customNoteOrder.filter(p => p !== path);

            // Data saving is now handled by main.ts after this method returns
            new Notice("Note removed from review schedule");

            // Note: The controller will be notified separately to update its state
            // This prevents immediate reordering based on link analysis after removal.
            // The sidebar or other components should trigger an update if needed.
            if (this.plugin.events) {
                this.plugin.events.emit('sidebar-update'); // Notify UI to refresh
            }
        }
    }

    /**
     * Clear all review schedules
     */
    async clearAllSchedules(): Promise<void> {
        this.schedules = {};
        this.customNoteOrder = []; // Also clear custom order
        // Data saving is now handled by main.ts after this method returns
        new Notice("All review schedules have been cleared");

        // Notify any listeners (for UI updates)
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        // Explicitly update the review controller's state
        // This dependency might need to be managed differently, e.g., via events
        if (this.plugin.reviewController) {
            await this.plugin.reviewController.updateTodayNotes();
        }
    }

    /**
     * Estimate review time for a note
     *
     * @param path Path to the note file
     * @returns Estimated review time in seconds
     */
    async estimateReviewTime(path: string): Promise<number> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return 60; // Default 1 minute

        try {
            const content = await this.plugin.app.vault.read(file);
            return EstimationUtils.estimateReviewTime(file, content);
        } catch (error) {
            return 60; // Default 1 minute
        }
    }

    /**
     * Schedule multiple notes for review in a specific order
     *
     * @param paths Array of note paths in the order they should be processed
     * @param daysFromNow Days until first review (default: 0, same day)
     * @returns Number of notes scheduled
     */
    async scheduleNotesInOrder(paths: string[], daysFromNow: number = 0): Promise<number> {
        let count = 0;

        // Schedule each note in the provided order
        for (const path of paths) {
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (!file || !(file instanceof TFile) || file.extension !== "md" || this.schedules[path]) {
                continue; 
            }

            const now = Date.now();
            const todayUTCStart = DateUtils.startOfUTCDay(new Date(now));
            const defaultAlgorithm = this.plugin.settings.defaultSchedulingAlgorithm;
            let newSchedule: ReviewSchedule;

            if (defaultAlgorithm === 'fsrs') {
                const fsrsData = this.fsrsService.createNewFsrsCardData(new Date(now)); // Exact moment
                newSchedule = {
                    path, lastReviewDate: null, nextReviewDate: now, reviewCount: 0, // FSRS due now
                    schedulingAlgorithm: 'fsrs', fsrsData: fsrsData,
                    ease: this.plugin.settings.baseEase, interval: 0, consecutive: 0, repetitionCount: 0, scheduleCategory: undefined,
                };
            } else { // sm2
                newSchedule = {
                    path, lastReviewDate: null, 
                    nextReviewDate: DateUtils.addDays(todayUTCStart, daysFromNow), // UTC midnight
                    ease: this.plugin.settings.baseEase, interval: daysFromNow, 
                    consecutive: 0, reviewCount: 0, repetitionCount: 0,
                    scheduleCategory: this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced',
                    schedulingAlgorithm: 'sm2', fsrsData: undefined,
                };
                if (newSchedule.scheduleCategory === 'initial') {
                    const initialIntervals = this.plugin.settings.initialScheduleCustomIntervals;
                    if (initialIntervals && initialIntervals.length > 0) {
                        newSchedule.interval = daysFromNow > 0 ? daysFromNow : initialIntervals[0];
                    }
                    if (daysFromNow === 0) {
                        newSchedule.nextReviewDate = DateUtils.addDays(todayUTCStart, newSchedule.interval);
                    }
                }
            }
            this.schedules[path] = newSchedule;
            
            // Add to custom order if not already present
            if (!this.customNoteOrder.includes(path)) {
                this.customNoteOrder.push(path);
            }

            count++;
        }

        if (count > 0) {
            // Data saving is now handled by main.ts after this method returns

            // Notify any listeners (for UI updates)
            if (this.plugin.events) {
                this.plugin.events.emit('sidebar-update');
            }
        }

        return count;
    }

    /**
     * Update the custom note order - used to maintain user-defined ordering
     *
     * @param order Array of note paths in desired order
     */
    async updateCustomNoteOrder(order: string[]): Promise<void> {
        // Filter out duplicate paths and ensure we only store paths that exist in our schedules
        const uniqueValidPaths = Array.from(new Set(order)).filter(path => this.schedules[path] !== undefined);
        this.customNoteOrder = uniqueValidPaths;

        // Data saving is now handled by main.ts after this method returns

        // Notify sidebar to update
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }
    }

    /**
     * Get due notes ordered by custom order if available
     *
     * @param date Optional target date (default: now)
     * @param useCustomOrder Whether to apply custom ordering (default: true)
     * @param matchExactDate Passed to getDueNotes to filter by exact date if true.
     * @returns Array of due note schedules sorted appropriately
     */
    getDueNotesWithCustomOrder(date: number = Date.now(), useCustomOrder: boolean = true, matchExactDate: boolean = false): ReviewSchedule[] {
        // First, get all due notes using the modified method
        const dueNotes = this.getDueNotes(date, matchExactDate);

        // If we have no custom order or are instructed not to use it, return regular order
        if (!useCustomOrder || this.customNoteOrder.length === 0) {
            return dueNotes;
        }

        // Create a map for faster lookups
        const notesByPath: Record<string, ReviewSchedule> = {};
        dueNotes.forEach(note => {
            notesByPath[note.path] = note;
        });

        // Apply custom order for notes that have an order defined
        const notesInOrder: ReviewSchedule[] = [];
        const orderedPaths: Set<string> = new Set<string>();

        // First, add notes that have a defined order
        for (const path of this.customNoteOrder) {
            if (notesByPath[path]) {
                notesInOrder.push(notesByPath[path]);
                orderedPaths.add(path);
            }
        }

        // Then add any remaining notes that don't have a defined order
        for (const note of dueNotes) {
            if (!orderedPaths.has(note.path)) {
                notesInOrder.push(note);
            }
        }

        return notesInOrder;
    }

    /**
     * Handles the renaming of a note file.
     * Updates the schedule and custom order if the note was scheduled.
     *
     * @param oldPath The original path of the note.
     * @param newPath The new path of the note.
     */
    handleNoteRename(oldPath: string, newPath: string): void {
        if (this.schedules[oldPath]) {
            const schedule = this.schedules[oldPath];
            delete this.schedules[oldPath];

            schedule.path = newPath;
            this.schedules[newPath] = schedule;

            // Update customNoteOrder
            const oldPathIndex = this.customNoteOrder.indexOf(oldPath);
            if (oldPathIndex > -1) {
                this.customNoteOrder[oldPathIndex] = newPath;
            } else {
                // If oldPath wasn't in custom order for some reason,
                // ensure newPath is added if it's not there already.
                // This typically shouldn't happen if data is consistent.
                if (!this.customNoteOrder.includes(newPath)) {
                    this.customNoteOrder.push(newPath);
                }
            }
            

            // Notify any listeners (for UI updates)
            // Data saving will be handled by the caller in main.ts
            if (this.plugin.events) {
                this.plugin.events.emit('sidebar-update');
            }
        }
    }

    // Helper method for backward compatibility (moved from DataStorage)
    private getRepetitionCount(interval: number): number {
        // For legacy data migration: estimate repetition count based on interval
        if (interval <= 1) return 0;
        if (interval <= 6) return 1;
        return 2;
    }

    public async convertAllSm2ToFsrs(): Promise<void> {
        let convertedCount = 0;
        for (const path in this.schedules) {
            if (Object.prototype.hasOwnProperty.call(this.schedules, path)) {
                const schedule = this.schedules[path];
                if (schedule.schedulingAlgorithm === 'sm2') {
                    schedule.schedulingAlgorithm = 'fsrs';
                    // Use last review date or now for FSRS card creation to get a sensible start.
                    const baseDate = schedule.lastReviewDate ? new Date(schedule.lastReviewDate) : new Date();
                    schedule.fsrsData = this.fsrsService.createNewFsrsCardData(baseDate);
                    // New FSRS cards are typically due 'now' relative to their creation/conversion.
                    schedule.nextReviewDate = baseDate.getTime(); 
                    
                    // Clear or nullify SM-2 specific fields
                    schedule.ease = this.plugin.settings.baseEase; // Keep a base ease for potential future conversion back
                    schedule.interval = 0; // Reset SM-2 interval
                    schedule.repetitionCount = 0;
                    schedule.consecutive = 0;
                    schedule.scheduleCategory = undefined;
                    convertedCount++;
                }
            }
        }
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update'); // Notify UI to refresh
        }
    }

    public async convertAllFsrsToSm2(): Promise<void> {
        let convertedCount = 0;
        for (const path in this.schedules) {
            if (Object.prototype.hasOwnProperty.call(this.schedules, path)) {
                const schedule = this.schedules[path];
                if (schedule.schedulingAlgorithm === 'fsrs') {
                    schedule.schedulingAlgorithm = 'sm2';
                    schedule.ease = this.plugin.settings.baseEase;
                    schedule.interval = 0; // Start with a 0-day interval, due immediately for SM-2 re-evaluation
                    schedule.repetitionCount = 0;
                    schedule.consecutive = 0;
                    schedule.scheduleCategory = this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced';
                    
                    // Set next review date based on SM-2 initial logic, using UTC days
                    const now = Date.now();
                    const todayUTCStart = DateUtils.startOfUTCDay(new Date(now));
                    let nextReview = DateUtils.addDays(todayUTCStart, 0); // Due today (UTC midnight)
                    if (schedule.scheduleCategory === 'initial' && this.plugin.settings.initialScheduleCustomIntervals.length > 0) {
                        schedule.interval = this.plugin.settings.initialScheduleCustomIntervals[0];
                        nextReview = DateUtils.addDays(todayUTCStart, schedule.interval);
                    }
                    schedule.nextReviewDate = nextReview;
                    
                    schedule.fsrsData = undefined; // Clear FSRS data
                    convertedCount++;
                }
            }
        }
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update'); // Notify UI to refresh
        }
    }
}