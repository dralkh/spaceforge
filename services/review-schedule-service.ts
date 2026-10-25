import { Notice, TFile } from 'obsidian';
import { isDeckPath } from '../models/anki';
import { ReviewSchedule, ReviewResponse, RatingKind, ScheduleRepairReport, ScheduleRepairSnapshot, toSM2Quality, FsrsRating } from '../models/review-schedule';
import { HistoryScheduler, ReviewGrade, gradeOfFsrsRating, gradeOfSm2Quality } from '../models/stats';
import { lapseInfoFromSchedule, LeechAction, UndoRecord } from '../models/review-flow';
import { State as FsrsState } from 'ts-fsrs';
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
     * When true, recordReview() computes the schedule but writes nothing that
     * outlives the call (no history entry, no UI event). Used by previewReview()
     * so grade buttons can show the resulting interval without side effects.
     */
    private suppressSideEffects = false;

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
    scheduleNoteForReview(path: string, daysFromNow = 0): void {
        // Check if file exists and is a markdown file
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile) || file.extension !== "md") {
            new Notice('Only notes can be added to review.');
            return;
        }

        // A deck file is a deck, not a note: its cards have their own schedule.
        if (isDeckPath(path)) {
            new Notice('That is a deck file. Decks are studied from the deck list, card by card.');
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

        new Notice(`Note added to review.`);
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
    recordReview(
        path: string,
        response: ReviewResponse | FsrsRating,
        isSkipped = false,
        currentReviewDate?: number,
        ratingKind: RatingKind = 'auto'
    ): boolean {
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

        // Which scheduler is grading this review, read before the branches
        // below can move the note (a first review can graduate out of the
        // initial steps within this call, but it was an initial-step review).
        const schedulerBefore: HistoryScheduler = schedule.schedulingAlgorithm === 'fsrs'
            ? 'fsrs'
            : schedule.scheduleCategory === 'initial' ? 'initial' : 'sm2';

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

        // Log to history. The entry is completed *after* the scheduler runs,
        // so it can carry what the grade actually did (`nextInterval`, and the
        // real button behind the response). The statistics counters fold it in
        // at the same moment, which is why they only see non-preview reviews.
        let historyEntry: ReviewHistoryItem | null = null;
        if (!this.suppressSideEffects) {
            historyEntry = {
                path,
                timestamp: effectiveReviewDate,
                response: historyResponseValue,
                interval: schedule.interval ?? schedule.fsrsData?.scheduled_days ?? 0,
                ease: schedule.ease ?? (schedule.fsrsData?.difficulty ? Math.round(schedule.fsrsData.difficulty * 10) : this.plugin.settings.baseEase),
                isSkipped: isSkipped,
                scheduler: schedulerBefore,
            };
            this.history.push(historyEntry);
            if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
        }

        let pressedGrade: ReviewGrade | null = null;

        if (schedule.schedulingAlgorithm === 'fsrs') {
            if (!schedule.fsrsData) { // Should not happen if card is properly initialized
                // FSRS service expects a Date object for the review time.
                // reviewDateObj (created from effectiveReviewDate) is correct here.
                schedule.fsrsData = this.fsrsService.createNewFsrsCardData(reviewDateObj);
            }

            const actualFsrsRating = this.toFsrsRating(response, ratingKind);
            pressedGrade = gradeOfFsrsRating(actualFsrsRating);

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
            const qualityRating = toSM2Quality(response as ReviewResponse);
            pressedGrade = gradeOfSm2Quality(qualityRating);

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

                const step = schedule.repetitionCount ?? 0;
                const passed = qualityRating >= Number(ReviewResponse.CorrectWithDifficulty);
                const easy = qualityRating >= Number(ReviewResponse.PerfectRecall);

                if (easy) {
                    // Easy graduates a learning item on the spot, the way Anki does;
                    // SM-2's first interval after a fresh start is one day.
                    schedule.scheduleCategory = 'graduated';
                    schedule.interval = 1;
                    schedule.repetitionCount = 1;
                } else if (step < initialIntervals.length) {
                    // Good moves on to the next step, Hard repeats the current one, and
                    // a failure drops back to the first step - which here is "today",
                    // so a failed note is drilled again before the session ends.
                    schedule.interval = passed ? initialIntervals[step] : initialIntervals[0];
                } else { // Graduated from initial steps
                    schedule.scheduleCategory = 'graduated';
                    // For the first SM-2 calculation after graduation, treat as if n=0
                    // for the interval calculation.
                    const { interval, ease, repetitionCount: newRepCount } = this.calculateSM2Schedule(
                        schedule.interval, // previous interval (last of initial steps)
                        schedule.ease,
                        qualityRating,
                        0, // Reset repetition count for SM-2 calculation after graduation
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

                if (easy) {
                    // Already booked as graduated above: n = 1.
                    schedule.consecutive += 1;
                } else if (passed) {
                    schedule.consecutive += 1;
                    // Good advances a step; Hard (quality 3) repeats the current one,
                    // which is what makes Hard meaningfully harder than Good here.
                    if (qualityRating >= Number(ReviewResponse.CorrectWithHesitation)) {
                        schedule.repetitionCount = step + 1;
                    }
                } else {
                    schedule.consecutive = 0;
                    schedule.repetitionCount = 0; // Back to the first step (today).
                    schedule.lapses = (schedule.lapses || 0) + 1;
                }
            } else { // 'spaced' or 'graduated' (already graduated or started as spaced)
                const { interval, ease, repetitionCount } = this.calculateSM2Schedule(
                    schedule.interval, schedule.ease, qualityRating, schedule.repetitionCount || 0, isSkipped
                );
                schedule.interval = interval;
                schedule.ease = ease;
                schedule.repetitionCount = repetitionCount;

                if (qualityRating >= Number(ReviewResponse.CorrectWithDifficulty)) {
                    schedule.consecutive += 1;
                } else {
                    schedule.consecutive = 0;
                    schedule.lapses = (schedule.lapses || 0) + 1;
                }
            }
            // Base the next review date on the UTC start of the current review day
            schedule.nextReviewDate = DateUtils.addDays(effectiveUTCDayStart, schedule.interval);
        }

        // Data saving is now handled by main.ts after this method returns

        // Complete the log entry with what the grade did, and count it into the
        // permanent day statistics. Skipped reviews are activity only; the
        // counters decide that themselves from `isSkipped`.
        if (historyEntry) {
            historyEntry.nextInterval = schedule.interval ?? schedule.fsrsData?.scheduled_days ?? 0;
            if (pressedGrade) historyEntry.grade = pressedGrade;
            this.plugin.statsService?.recordNoteReview(historyEntry);
        }

        // Notify any listeners (for UI updates)
        if (this.plugin.events && !this.suppressSideEffects) {
            this.plugin.events.emit('sidebar-update');
        }

        return true; // Review was successfully recorded
    }

    /**
     * Resolve a response to an FSRS rating.
     *
     * With `ratingKind: 'fsrs'` the number is already an FsrsRating (1-4) and is
     * used as-is: the caller graded on the FSRS scale. The SM-2 ends (0 and 5) are
     * accepted as Again/Easy so a stray SM-2 value cannot silently shift a grade.
     * Everything else, and every `auto` caller, keeps the legacy translation from
     * the SM-2 quality scale.
     */
    private toFsrsRating(response: ReviewResponse | FsrsRating, ratingKind: RatingKind): FsrsRating {
        if (ratingKind === 'fsrs') {
            if (response === FsrsRating.Again || response === FsrsRating.Hard
                || response === FsrsRating.Good || response === FsrsRating.Easy) {
                return response;
            }
            if (response === ReviewResponse.CompleteBlackout) return FsrsRating.Again;
            if (response === ReviewResponse.PerfectRecall) return FsrsRating.Easy;
        }
        if (response === ReviewResponse.PerfectRecall) return FsrsRating.Easy;
        if (response === ReviewResponse.CorrectWithHesitation) return FsrsRating.Good;
        if (response === ReviewResponse.CorrectWithDifficulty) return FsrsRating.Hard;
        if (response === ReviewResponse.IncorrectResponse) return FsrsRating.Again;
        if (Object.values(FsrsRating).includes(response as FsrsRating)) return response as FsrsRating;
        const quality = toSM2Quality(response as ReviewResponse);
        if (quality >= 4) return FsrsRating.Easy;
        if (quality === 3) return FsrsRating.Good;
        if (quality === 2) return FsrsRating.Hard;
        return FsrsRating.Again;
    }

    /**
     * Rebuild schedules from the review log.
     *
     * Cards graded under the earlier rules - a forced 1-day interval whenever a note
     * was late, or an FSRS rating shifted a notch by the legacy translation - end up
     * exactly as if the corrected rules had always applied: every logged review is
     * replayed through recordReview with its own timestamp, starting from a fresh
     * card for that note.
     *
     * Only notes whose log is complete are touched: one recorded review per counted
     * review. A partial log (older than the log itself, or trimmed at 1000 entries)
     * would produce a worse guess than the state it replaces, so those notes are left
     * alone and reported instead.
     *
     * The caller owns the backup: snapshot the data file before running this.
     */
    repairFromHistory(): ScheduleRepairReport {
        const report: ScheduleRepairReport = { repaired: [], skipped: [] };
        const byPath = new Map<string, ReviewHistoryItem[]>();
        for (const entry of this.history) {
            const list = byPath.get(entry.path);
            if (list) list.push(entry);
            else byPath.set(entry.path, [entry]);
        }

        for (const [path, original] of Object.entries(this.schedules)) {
            const entries = (byPath.get(path) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
            if (entries.length === 0) {
                report.skipped.push({ path, reason: 'no history' });
                continue;
            }
            const graded = entries.filter(entry => !entry.isSkipped).length;
            const counted = original.reviewCount ?? 0;
            if (graded !== counted) {
                report.skipped.push({ path, reason: `partial history (${graded} of ${counted} reviews)` });
                continue;
            }

            const isFsrs = original.schedulingAlgorithm === 'fsrs';
            const fresh: ReviewSchedule = {
                path,
                lastReviewDate: null,
                nextReviewDate: entries[0].timestamp,
                ease: this.plugin.settings.baseEase,
                interval: 0,
                consecutive: 0,
                lapses: 0,
                repetitionCount: 0,
                reviewCount: 0,
                scheduleCategory: isFsrs ? undefined : (this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced'),
                schedulingAlgorithm: original.schedulingAlgorithm,
                fsrsData: isFsrs ? this.fsrsService.createNewFsrsCardData(new Date(entries[0].timestamp)) : undefined,
                leechHandledAtLapses: 0,
            };

            let recorded = 0;
            try {
                this.schedules[path] = fresh;
                this.suppressSideEffects = true;
                for (const entry of entries) {
                    // Make it due at the moment it was reviewed, so the replay is not
                    // gated by the due check.
                    fresh.nextReviewDate = entry.timestamp;
                    if (this.recordReview(path, entry.response, entry.isSkipped === true, entry.timestamp, isFsrs ? 'fsrs' : 'auto')) {
                        recorded += 1;
                    }
                }
            } catch (error) {
                this.schedules[path] = original;
                report.skipped.push({ path, reason: `replay failed: ${String(error)}` });
                continue;
            } finally {
                this.suppressSideEffects = false;
            }

            if (recorded !== entries.length) {
                this.schedules[path] = original;
                report.skipped.push({ path, reason: `replay stopped after ${recorded} of ${entries.length} entries` });
                continue;
            }

            // Never claim the user answered a lapse question for lapses the rebuilt
            // card does not have.
            const lapses = fresh.fsrsData?.lapses ?? fresh.lapses ?? 0;
            fresh.leechHandledAtLapses = Math.min(original.leechHandledAtLapses ?? 0, lapses);

            report.repaired.push({
                path,
                reviews: entries.length,
                before: scheduleRepairSnapshot(original),
                after: scheduleRepairSnapshot(fresh),
            });
        }

        return report;
    }

    /**
     * Compute what a rating would do to a note, without recording anything.
     *
     * Runs the real scheduling code on a throwaway copy of the schedule, so the
     * interval shown on a grade button is exactly what recording the grade
     * produces. History writes and UI events are suppressed for the duration.
     *
     * @param path Path to the note file
     * @param response Rating to preview
     * @param currentReviewDate Optional timestamp for the review (defaults to now)
     * @returns The resulting interval and next review date, or null if the note
     *          has no schedule or is not currently due.
     */
    previewReview(
        path: string,
        response: ReviewResponse | FsrsRating,
        currentReviewDate?: number,
        ratingKind: RatingKind = 'auto'
    ): { interval: number; nextReviewDate: number } | null {
        const schedule = this.schedules[path];
        if (!schedule) return null;

        const effectiveReviewDate = currentReviewDate || Date.now();
        if (!this.isNoteDue(schedule, effectiveReviewDate)) return null;

        const workingCopy: ReviewSchedule = JSON.parse(JSON.stringify(schedule)) as ReviewSchedule;
        this.schedules[path] = workingCopy;
        this.suppressSideEffects = true;
        try {
            const recorded = this.recordReview(path, response, false, effectiveReviewDate, ratingKind);
            if (!recorded) return null;
            return {
                interval: workingCopy.interval ?? workingCopy.fsrsData?.scheduled_days ?? 0,
                nextReviewDate: workingCopy.nextReviewDate,
            };
        } finally {
            this.suppressSideEffects = false;
            this.schedules[path] = schedule;
        }
    }

    /**
     * Lapse counters for a note, used for leech detection.
     * FSRS tracks lapses itself; SM-2 notes count them in `lapses`.
     */
    getLapseInfo(path: string): { lapses: number; handledAtLapses: number } {
        const schedule = this.schedules[path];
        return lapseInfoFromSchedule(schedule);
    }

    /**
     * Put a note's schedule back exactly as it was before a grade, and drop the
     * history the grade wrote — the undo path for a mis-keyed rating.
     *
     * Only entries appended after the snapshot are considered (index at or past
     * `historyLength`) and only for the note that was graded, so a rating made
     * elsewhere in the meantime is not swallowed by the undo.
     *
     * @param snapshot Record taken just before the grade (see models/review-flow)
     */
    restoreSnapshot(snapshot: UndoRecord): void {
        if (snapshot.scheduleJSON === null) {
            delete this.schedules[snapshot.path];
        } else {
            this.schedules[snapshot.path] = JSON.parse(snapshot.scheduleJSON) as ReviewSchedule;
        }

        const boundary = Math.max(0, Math.min(snapshot.historyLength, this.history.length));
        for (let i = this.history.length - 1; i >= boundary; i--) {
            if (this.history[i].path === snapshot.path) {
                const [removed] = this.history.splice(i, 1);
                // The day counters outlive the log, so an undone grade has to
                // be taken back out of them by hand.
                if (removed) this.plugin.statsService?.removeNoteReview(removed);
            }
        }
    }

    /**
     * Apply the user's decision for a note that keeps failing.
     *
     * @param path Path to the note file
     * @param action What the user chose: reset, postpone (one week), remove or keep
     */
    resolveLeech(path: string, action: LeechAction): void {
        const schedule = this.schedules[path];
        if (!schedule) return;

        const lapses = this.getLapseInfo(path).lapses;

        switch (action) {
            case 'reset': {
                const tomorrow = DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), 1);
                schedule.interval = 1;
                schedule.nextReviewDate = tomorrow;
                schedule.consecutive = 0;
                schedule.repetitionCount = 0;
                schedule.lapses = 0;
                schedule.scheduleCategory = this.plugin.settings.useInitialSchedule ? 'initial' : 'spaced';
                if (schedule.schedulingAlgorithm === 'fsrs' && schedule.fsrsData) {
                    schedule.fsrsData.lapses = 0;
                    schedule.fsrsData.scheduled_days = 1;
                    schedule.fsrsData.stability = Math.min(schedule.fsrsData.stability, 1);
                    schedule.fsrsData.state = FsrsState.Relearning;
                }
                break;
            }
            case 'postpone':
                this.postponeNote(path, 7);
                break;
            case 'remove':
                this.removeFromReview(path);
                break;
            case 'keep':
            default:
                break;
        }

        // Remember the checkpoint so the prompt only returns at the next multiple.
        const updated = this.schedules[path];
        if (updated) {
            updated.leechHandledAtLapses = Math.max(lapses, updated.leechHandledAtLapses ?? 0);
        }
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
     * @param isSkipped Whether the item was explicitly skipped by the user
     * @returns New interval, ease, and repetition count
     */
    calculateNewSchedule(
        currentInterval: number,
        currentEase: number,
        response: ReviewResponse,
        repetitionCount = 0,
        isSkipped = false
    ): { interval: number, ease: number, repetitionCount: number } {
        return this.calculateSM2Schedule(
            currentInterval,
            currentEase,
            toSM2Quality(response),
            repetitionCount,
            isSkipped
        );
    }

    /**
     * Calculate new schedule parameters using SM-2 (Wozniak 1987).
     * (This is the core calculation logic used internally by recordReview and skipNote)
     *
     * The next interval is a function of the previous interval, the grade and the
     * ease factor - nothing else. SM-2 has no lateness term: an item answered well
     * late is scheduled exactly as if it had been answered on time, because the
     * interval describes the wanted gap between repetitions, not a punishment.
     * (Models that do account for elapsed time, FSRS among them, grow the interval
     * after a late success rather than resetting it.)
     *
     * @param currentInterval Current interval in days
     * @param currentEase Current ease factor (expressed as a number where 2.5 = 250)
     * @param qualityRating User's response during review, as a numeric quality rating (0-5)
     * @param repetitionCount Current repetition count (n)
     * @param isSkipped Whether the item was explicitly skipped by the user
     * @returns New interval, ease, and repetition count
     */
    private calculateSM2Schedule(
        currentInterval: number,
        currentEase: number,
        qualityRating: number,
        repetitionCount = 0,
        isSkipped = false
    ): { interval: number, ease: number, repetitionCount: number } {
        // Skipping is the user saying "not now": no ease is spent and the note
        // returns tomorrow. It is not a failed recall, so it must not reset the item.
        if (isSkipped) {
            const q_eff = Math.max(0, qualityRating - 1);

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
            // SM-2 restarts the repetition schedule, and SuperMemo re-asks the item
            // in the same session until it passes: interval 0 keeps it due today.
            // Passing it again then follows I(1) = 1 day.
            interval = 0;
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

        // No negative intervals; 0 means "still due today".
        interval = Math.max(0, interval);

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
    getDueNotes(date: number = Date.now(), matchExactDate = false): ReviewSchedule[] {
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
    getUpcomingReviews(days = 7): ReviewSchedule[] {
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
    skipNote(path: string, response: ReviewResponse | FsrsRating = ReviewResponse.CorrectWithDifficulty, currentReviewDate?: number): void {
        const schedule = this.schedules[path];
        if (!schedule) return;

        const effectiveReviewDate = currentReviewDate || Date.now();
        const reviewDateObj = new Date(effectiveReviewDate);

        const schedulerBefore: HistoryScheduler = schedule.schedulingAlgorithm === 'fsrs'
            ? 'fsrs'
            : schedule.scheduleCategory === 'initial' ? 'initial' : 'sm2';

        // Record as a skipped review (isSkipped = true)
        // The 'response' for a skip is less critical but can be used for penalty in SM-2.
        // For FSRS, skipReview in FsrsService handles it as 'Again'.
        let skipEntry: ReviewHistoryItem | null = null;
        if (schedule.schedulingAlgorithm === 'fsrs') {
            if (!schedule.fsrsData) { // Should not happen
                schedule.fsrsData = this.fsrsService.createNewFsrsCardData(reviewDateObj);
            }
            const { updatedData, nextReviewDate: newNextReviewDateFsrs } = this.fsrsService.skipReview(
                schedule.fsrsData,
                reviewDateObj // Pass exact moment for FSRS skip
            );
            schedule.fsrsData = updatedData;
            schedule.nextReviewDate = newNextReviewDateFsrs; // Already a UTC timestamp
            schedule.lastReviewDate = DateUtils.startOfUTCDay(reviewDateObj); // FSRS skip is a review, set last review to UTC midnight

            skipEntry = { // Log FSRS skip
                path, timestamp: effectiveReviewDate, response: ReviewResponse.IncorrectResponse, // Approx. for log
                interval: schedule.fsrsData.scheduled_days, ease: Math.round(schedule.fsrsData.difficulty * 10), isSkipped: true,
                scheduler: schedulerBefore,
            };
            this.history.push(skipEntry);

        } else { // SM-2
            let qualityRating = toSM2Quality(response as ReviewResponse);
            qualityRating = Math.max(0, qualityRating - 1); // Apply skip penalty for SM-2

            skipEntry = {
                path, timestamp: effectiveReviewDate, response: qualityRating,
                interval: schedule.interval || 0, ease: schedule.ease || 0, isSkipped: true,
                scheduler: schedulerBefore,
            };
            this.history.push(skipEntry);

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
                    schedule.repetitionCount || 0, true // isSkipped = true
                );
                schedule.interval = interval; // Will be 1 due to isSkipped=true
                schedule.ease = ease;
                schedule.repetitionCount = repetitionCount; // Will be 1
                schedule.nextReviewDate = DateUtils.addDays(effectiveUTCDayStart, interval);
            }
            schedule.consecutive = 0;
        }

        // Data saving is now handled by main.ts after this method returns

        if (skipEntry) {
            skipEntry.nextInterval = schedule.interval ?? schedule.fsrsData?.scheduled_days ?? 0;
            this.plugin.statsService?.recordNoteReview(skipEntry);
        }

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
    postponeNote(path: string, days = 1): void {
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
            window.setTimeout(() => {
                this.plugin.events.emit('sidebar-update');
            }, 50); // Small delay (e.g., 50ms)
        }

        new Notice(`Review postponed for ${days} day${days !== 1 ? 's' : ''}.`);
    }

    /**
     * Advance a note's review by one day, if eligible.
     *
     * @param path Path to the note file
     * @returns True if the note was advanced, false otherwise.
     */
    advanceNote(path: string): boolean {
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
            window.setTimeout(() => {
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
    removeFromReview(path: string): void {
        if (this.schedules[path]) {
            delete this.schedules[path];

            // Remove from custom order if present
            this.customNoteOrder = this.customNoteOrder.filter(p => p !== path);

            // Data saving is now handled by main.ts after this method returns
            new Notice("Note removed from review.");

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
    clearAllSchedules(): void {
        this.schedules = {};
        this.customNoteOrder = []; // Also clear custom order
        // Data saving is now handled by main.ts after this method returns
        new Notice("All review schedules cleared.");

        // Notify any listeners (for UI updates)
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        // Explicitly update the review controller's state
        // This dependency might need to be managed differently, e.g., via events
        if (this.plugin.reviewController) {
            void this.plugin.reviewController.updateTodayNotes();
        }
    }

    /**
     * Estimate review time for a note
     *
     * @param path Path to the note file
     * @returns Estimated review time in seconds
     */
    /**
     * A note's review time, from its own words.
     *
     * The count comes from the word cache when that note has been read since it last
     * changed, and from the file otherwise — so a list of rows is one read per note
     * for its lifetime, not one read per render.
     */
    async estimateReviewTime(path: string): Promise<number> {
        const cached = this.plugin.wordCounts.words(path);
        if (cached !== null) return EstimationUtils.estimateReviewTimeFromWords(cached);

        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return 60; // the note is gone; nothing to read

        try {
            const content = await this.plugin.app.vault.read(file);
            this.plugin.wordCounts.remember(path, content);
            return EstimationUtils.estimateReviewTime(file, content);
        } catch {
            return 60;
        }
    }

    /**
     * The same estimate for a surface that cannot wait — the calendar's day cells.
     * Null means the note has not been read yet; ask for it to be primed and paint
     * again when it is, rather than inventing a number from the file's size.
     */
    estimateReviewTimeCached(path: string): number | null {
        const words = this.plugin.wordCounts.words(path);
        return words === null ? null : EstimationUtils.estimateReviewTimeFromWords(words);
    }

    /**
     * Schedule multiple notes for review in a specific order
     *
     * @param paths Array of note paths in the order they should be processed
     * @param daysFromNow Days until first review (default: 0, same day)
     * @returns Number of notes scheduled
     */
    scheduleNotesInOrder(paths: string[], daysFromNow = 0): number {
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
     * @param newOrder Array of note paths in desired order
     */
    updateCustomNoteOrder(newOrder: string[]): void {
        // Filter out duplicate paths and ensure we only store paths that exist in our schedules
        const uniqueValidPaths = Array.from(new Set(newOrder)).filter(path => this.schedules[path] !== undefined);
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
    getDueNotesWithCustomOrder(date: number = Date.now(), useCustomOrder = true, matchExactDate = false): ReviewSchedule[] {
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
        // (skip duplicates so a corrupted custom order cannot duplicate notes)
        for (const path of this.customNoteOrder) {
            if (notesByPath[path] && !orderedPaths.has(path)) {
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

    public convertAllSm2ToFsrs(): void {
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
                    schedule.consecutive = 0;
                    schedule.scheduleCategory = undefined;
                }
            }
        }
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update'); // Notify UI to refresh
        }
    }

    public convertAllFsrsToSm2(): void {
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
                }
            }
        }
        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update'); // Notify UI to refresh
        }
    }
}

function scheduleRepairSnapshot(schedule: ReviewSchedule): ScheduleRepairSnapshot {
    return {
        interval: schedule.interval ?? schedule.fsrsData?.scheduled_days ?? 0,
        ease: schedule.ease ?? null,
        difficulty: schedule.fsrsData?.difficulty ?? null,
        stability: schedule.fsrsData?.stability ?? null,
        lapses: schedule.fsrsData?.lapses ?? schedule.lapses ?? 0,
        nextReviewDate: schedule.nextReviewDate,
    };
}
