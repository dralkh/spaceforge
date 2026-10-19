import { FsrsRating, ReviewResponse } from '../models/review-schedule';

/**
 * Shared score → schedule-rating mapping.
 *
 * Both MCQ sessions and Study sessions end with a 0-1 performance score that
 * has to become a review rating, and both need the same answer for the same
 * score. Keeping one implementation here means the two features cannot drift
 * apart in what "80%" means.
 */

/** Map a 0-1 score onto the SM-2 0-5 quality scale. */
export function mapScoreToSm2Response(score: number): ReviewResponse {
    if (score >= 0.95) return ReviewResponse.PerfectRecall;
    if (score >= 0.80) return ReviewResponse.CorrectWithHesitation;
    if (score >= 0.60) return ReviewResponse.CorrectWithDifficulty;
    if (score >= 0.40) return ReviewResponse.IncorrectButFamiliar;
    if (score > 0) return ReviewResponse.IncorrectResponse;
    return ReviewResponse.CompleteBlackout;
}

/** Map a 0-1 score onto the FSRS 1-4 rating scale. */
export function mapScoreToFsrsRating(score: number): FsrsRating {
    if (score >= 0.90) return FsrsRating.Easy;
    if (score >= 0.70) return FsrsRating.Good;
    if (score >= 0.50) return FsrsRating.Hard;
    return FsrsRating.Again;
}

/** Human-readable name for a rating, used in notices. */
export function describeRating(rating: ReviewResponse | FsrsRating): string {
    return typeof rating === 'number' && Number(rating) <= 4 && FsrsRating[rating as FsrsRating] !== undefined
        ? FsrsRating[rating as FsrsRating]
        : ReviewResponse[rating as ReviewResponse] ?? String(rating);
}
