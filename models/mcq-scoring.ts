/**
 * MCQ scoring, shared by every surface that runs a multiple-choice session.
 *
 * Both the modal and the docked MCQ runner turn a session's answers into a
 * 0-1 score and then need the grade that score implies. A second copy of
 * either rule would let the same session mean different things depending on
 * where it was run, so both surfaces call into this module. Everything here is
 * pure: no Obsidian APIs, no plugin instance, no I/O.
 *
 * Score rules (as previously inlined in `MCQModal.calculateScore`):
 *  - default: correct on the first attempt = 1, on the second = 0.5, otherwise 0;
 *  - `mcqDeductFullMarkOnFirstFailure`: 1 only for a correct first attempt;
 *  - an answer slower than `mcqTimeDeductionSeconds` loses
 *    `mcqTimeDeductionAmount`, floored at 0, and only when it scored at all.
 *
 * The session score divides by `questionCount` (the set's questions), not by
 * the number of answers given: questions never reached still count against it.
 */
import { FsrsRating, ReviewResponse } from './review-schedule';
import { mapScoreToFsrsRating, mapScoreToSm2Response } from '../utils/rating';

export interface McqScoredAnswer {
    questionIndex: number;
    /** -1 when the user pressed "Show answer" instead of answering. */
    selectedAnswerIndex: number;
    attempts: number;
    correct: boolean;
    /** Seconds spent on the question. */
    timeToAnswer: number;
}

export interface McqScoringSettings {
    mcqDeductFullMarkOnFirstFailure: boolean;
    mcqTimeDeductionSeconds: number;
    mcqTimeDeductionAmount: number;
}

/** Points for one answer, 0..1, after the time deduction. */
export function scoreAnswer(answer: McqScoredAnswer, settings: McqScoringSettings): number {
    let questionScore = 0;

    if (settings.mcqDeductFullMarkOnFirstFailure) {
        // With this setting, you only get points if you're correct on the first try.
        if (answer.attempts === 1 && answer.correct) {
            questionScore = 1.0;
        } else {
            questionScore = 0; // 0 for multiple attempts or for a single incorrect attempt.
        }
    } else {
        // Original scoring logic
        if (answer.correct && answer.selectedAnswerIndex !== -1) {
            if (answer.attempts === 1) {
                questionScore = 1.0;
            } else if (answer.attempts === 2) {
                questionScore = 0.5;
            }
        }
    }

    // Apply time deduction only if points were scored.
    if (questionScore > 0 && answer.timeToAnswer > settings.mcqTimeDeductionSeconds) {
        questionScore -= settings.mcqTimeDeductionAmount;
        questionScore = Math.max(0, questionScore);
    }

    return questionScore;
}

/** Session score, 0..1. Zero questions -> 0. */
export function scoreSession(answers: McqScoredAnswer[], questionCount: number, settings: McqScoringSettings): number {
    let totalScore = 0;
    answers.forEach(answer => {
        totalScore += scoreAnswer(answer, settings);
    });
    return questionCount > 0 ? totalScore / questionCount : 0;
}

/** The rating a score implies, on the algorithm's own scale. */
/** The words the grade buttons use, so a suggestion reads like the button. */
const SM2_LABELS: Record<number, string> = {
    [ReviewResponse.CompleteBlackout]: 'Complete blackout',
    [ReviewResponse.IncorrectResponse]: 'Incorrect',
    [ReviewResponse.IncorrectButFamiliar]: 'Incorrect but familiar',
    [ReviewResponse.CorrectWithDifficulty]: 'Correct with difficulty',
    [ReviewResponse.CorrectWithHesitation]: 'Correct with hesitation',
    [ReviewResponse.PerfectRecall]: 'Perfect recall',
};

export function suggestedRating(score: number, algorithm: 'fsrs' | 'sm2'): { rating: number; label: string } {
    if (algorithm === 'fsrs') {
        const rating = mapScoreToFsrsRating(score);
        return { rating, label: FsrsRating[rating] };
    }
    const rating = mapScoreToSm2Response(score);
    // `ReviewResponse[5]` is the enum key ("PerfectRecall"), which is not what
    // the learner sees on the button: the label has to match the grade row.
    return { rating, label: SM2_LABELS[rating] ?? String(rating) };
}
