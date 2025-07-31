/**
 * Represents a note's review schedule in the spaced repetition system
 */
export interface ReviewSchedule {
    /**
     * Path to the note file - unique identifier
     */
    path: string;
    
    /**
     * Timestamp of the last review
     */
    lastReviewDate: number | null;
    
    /**
     * Timestamp of the next scheduled review
     */
    nextReviewDate: number;
    
    /**
     * Ease factor - affects interval growth (higher = longer intervals)
     * In SM-2, this is a value typically starting at 2.5 (stored as 250 internally)
     */
    ease: number;
    
    /**
     * Current interval in days
     */
    interval: number;
    
    /**
     * Number of consecutive successful reviews (for backward compatibility)
     */
    consecutive: number;
    
    /**
     * Total number of completed reviews (for backward compatibility)
     */
    reviewCount: number;
    
    /**
     * SM-2 repetition count - used to determine interval calculation (n)
     * This is 1 for items in "learning" phase and increments for each successful review
     */
    repetitionCount?: number;

    /**
     * Defines the scheduling category for the note.
     * 'initial': Note is following the initial learning intervals.
     * 'spaced': Note is using standard SM-2 from the start.
     * 'graduated': Note has completed initial intervals and now uses SM-2.
     */
    scheduleCategory?: 'initial' | 'spaced' | 'graduated'; // Made optional for FSRS cards

    // --- FSRS Specific Data ---
    fsrsData?: {
        stability: number;
        difficulty: number;
        elapsed_days: number;
        scheduled_days: number;
        reps: number;
        lapses: number;
        state: number; // ts-fsrs.State enum (0:New, 1:Learning, 2:Review, 3:Relearning)
        last_review?: number; // Timestamp of last FSRS review for this card
    };

    schedulingAlgorithm: 'sm2' | 'fsrs'; // Determines which algo rules apply
}

// Removed INITIAL_INTERVALS, isInitialPhase, and getInitialInterval.
// This logic will now be handled in ReviewScheduleService using settings.initialScheduleCustomIntervals.

/**
 * Represents a user's response for FSRS (1-4 rating)
 */
export enum FsrsRating {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

/**
 * Represents a user's response during review (SM-2 quality rating 0-5)
 */
export enum ReviewResponse {
    /**
     * Complete blackout (0) - No recognition at all
     */
    CompleteBlackout = 0,
    
    /**
     * Incorrect response (1) - Wrong answer but upon seeing the correct answer, it felt familiar
     */
    IncorrectResponse = 1,
    
    /**
     * Incorrect response (2) - Wrong answer but upon seeing the correct answer, it felt very familiar
     */
    IncorrectButFamiliar = 2,
    
    /**
     * Correct with difficulty (3) - Correct answer but required significant effort to recall
     */
    CorrectWithDifficulty = 3,
    
    /**
     * Correct with hesitation (4) - Correct answer after some hesitation
     */
    CorrectWithHesitation = 4,
    
    /**
     * Perfect recall (5) - Correct answer with no hesitation
     */
    PerfectRecall = 5,
    
    // Legacy response values explicitly mapped to SM-2 equivalents
    // for backward compatibility
    
    /**
     * Legacy "Hard" response - mapped to IncorrectResponse (1)
     */
    Hard = 1,
    
    /**
     * Legacy "Fair" response - mapped to CorrectWithDifficulty (3)
     */
    Fair = 3,
    
    /**
     * Legacy "Good" response - mapped to CorrectWithHesitation (4)
     */
    Good = 4,
    
    /**
     * Legacy "Perfect" response - mapped to PerfectRecall (5)
     */
    Perfect = 5
}

/**
 * Convert any response to SM-2 quality ratings (0-5)
 * 
 * @param response The review response to convert
 * @returns SM-2 quality rating (0-5)
 */
export function toSM2Quality(response: ReviewResponse): number {
    // Ensure response is within 0-5 range
    if (response >= 0 && response <= 5) {
        return response;
    }
    
    // Map legacy responses to SM-2 quality ratings
    switch(response) {
        case ReviewResponse.Hard:
            return ReviewResponse.IncorrectResponse;
        case ReviewResponse.Fair:
            return ReviewResponse.CorrectWithDifficulty;
        case ReviewResponse.Good:
            return ReviewResponse.CorrectWithHesitation;
        case ReviewResponse.Perfect:
            return ReviewResponse.PerfectRecall;
        default:
            // Default to fair recall if unknown
            return ReviewResponse.CorrectWithDifficulty;
    }
}

/**
 * Review history entry
 */
export interface ReviewHistoryItem {
    /**
     * Path to the note file
     */
    path: string;
    
    /**
     * Timestamp of the review
     */
    timestamp: number;
    
    /**
     * User's response during review
     */
    response: ReviewResponse;
    
    /**
     * Interval at the time of review
     */
    interval: number;
    
    /**
     * Ease at the time of review
     */
    ease: number;
    
    /**
     * Whether this review was explicitly skipped by the user
     */
    isSkipped?: boolean;
}
