import { FSRS, FSRSParameters, Card as FsrsLibCard, State as FsrsState, Rating as TsFsrsRating, createEmptyCard as createFsrsLibEmptyCard, ReviewLog as FsrsReviewLog } from 'ts-fsrs';
import { SpaceforgeSettings } from '../models/settings';
import { ReviewSchedule, FsrsRating } from '../models/review-schedule';


export class FsrsScheduleService {
    private fsrsInstance: FSRS;
    private pluginSettings: SpaceforgeSettings;

    constructor(settings: SpaceforgeSettings) {
        this.pluginSettings = settings;
        this.fsrsInstance = new FSRS(this.mapSettingsToFsrsParams(settings.fsrsParameters));
    }

    private mapSettingsToFsrsParams(params: SpaceforgeSettings['fsrsParameters']): FSRSParameters {
        // Ensure all required FSRSParameters are present, even if with defaults from ts-fsrs if not in our settings
        // For now, we assume our settings structure matches FSRSParameters for the fields we care about.
        // The 'w' parameter (weights) is crucial and should come from settings.
        // If 'w' is not in params, FSRS will use its internal defaults.
        const defaultWeights = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
        const mappedParams = {
            request_retention: params.request_retention ?? 0.9,
            maximum_interval: params.maximum_interval ?? 36500,
            w: params.w && params.w.length > 0 ? params.w : defaultWeights,
            enable_fuzz: params.enable_fuzz ?? true,
            learning_steps: params.learning_steps && params.learning_steps.length > 0 ? params.learning_steps : [1, 10],
            enable_short_term: params.enable_short_term ?? false, // Added enable_short_term
        };
        return mappedParams as FSRSParameters; // Cast to FSRSParameters
    }

    public updateFSRSInstance(settings: SpaceforgeSettings): void {
        this.pluginSettings = settings;
        this.fsrsInstance = new FSRS(this.mapSettingsToFsrsParams(settings.fsrsParameters));
    }

    public createNewFsrsCardData(creationDate: Date = new Date()): Required<ReviewSchedule>['fsrsData'] {
        const emptyCard: FsrsLibCard = createFsrsLibEmptyCard(creationDate);
        return {
            stability: emptyCard.stability,
            difficulty: emptyCard.difficulty,
            elapsed_days: emptyCard.elapsed_days,
            scheduled_days: emptyCard.scheduled_days,
            reps: emptyCard.reps,
            lapses: emptyCard.lapses,
            state: emptyCard.state as number, // Cast to number; FsrsState is an enum
            last_review: emptyCard.last_review ? emptyCard.last_review.getTime() : undefined,
        };
    }

    private mapReviewScheduleFsrsDataToFsrsLibCard(fsrsData: Required<ReviewSchedule>['fsrsData'], now: Date): FsrsLibCard {
        return {
            ...fsrsData,
            due: now, // This will be the review date for the repeat() call
            state: fsrsData.state as FsrsState,
            last_review: fsrsData.last_review ? new Date(fsrsData.last_review) : undefined,
        };
    }

    private mapFsrsLibRatingToTsFsrsRating(rating: FsrsRating): TsFsrsRating {
        switch (rating) {
            case FsrsRating.Again: return TsFsrsRating.Again;
            case FsrsRating.Hard: return TsFsrsRating.Hard;
            case FsrsRating.Good: return TsFsrsRating.Good;
            case FsrsRating.Easy: return TsFsrsRating.Easy;
            default: throw new Error(`Unknown FsrsRating: ${rating}`);
        }
    }

    public recordReview(
        currentFsrsData: Required<ReviewSchedule>['fsrsData'],
        rating: FsrsRating,
        reviewDateTime: Date
    ): { updatedData: Required<ReviewSchedule>['fsrsData']; nextReviewDate: number; log: FsrsReviewLog } {
        const fsrsLibCardToReview = this.mapReviewScheduleFsrsDataToFsrsLibCard(currentFsrsData, reviewDateTime);
        const tsFsrsRating = this.mapFsrsLibRatingToTsFsrsRating(rating);

        const schedulingResult = this.fsrsInstance.repeat(fsrsLibCardToReview, reviewDateTime);

        // Ensure that tsFsrsRating is a valid key for schedulingResult
        // TsFsrsRating.Manual is a valid enum member but not a result of our mapping.
        // The keys of schedulingResult are Again, Hard, Good, Easy.
        const validRatingKey = tsFsrsRating as (TsFsrsRating.Again | TsFsrsRating.Hard | TsFsrsRating.Good | TsFsrsRating.Easy);

        const resultCard = schedulingResult[validRatingKey].card;
        const resultLog = schedulingResult[validRatingKey].log;

        const updatedData: Required<ReviewSchedule>['fsrsData'] = {
            stability: resultCard.stability,
            difficulty: resultCard.difficulty,
            elapsed_days: resultCard.elapsed_days,
            scheduled_days: resultCard.scheduled_days,
            reps: resultCard.reps,
            lapses: resultCard.lapses,
            state: resultCard.state as number,
            last_review: resultCard.last_review ? resultCard.last_review.getTime() : undefined,
        };

        return {
            updatedData,
            nextReviewDate: resultCard.due.getTime(),
            log: resultLog,
        };
    }

    public skipReview(
        currentFsrsData: Required<ReviewSchedule>['fsrsData'],
        reviewDateTime: Date
    ): { updatedData: Required<ReviewSchedule>['fsrsData']; nextReviewDate: number; log: FsrsReviewLog } {
        // Skipping in FSRS is typically handled by rating "Again"
        return this.recordReview(currentFsrsData, FsrsRating.Again, reviewDateTime);
    }
}
