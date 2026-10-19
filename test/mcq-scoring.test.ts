/**
 * MCQ scoring tests.
 *
 * These rules decide what a session is worth and what grade it implies, so
 * they are pinned at the boundaries: attempts, the show-answer path, the time
 * deduction (including the floor at zero), the deduct-full-mark setting, the
 * empty set, and the score -> rating thresholds on both algorithms.
 *
 * The module under test is pure, so no Obsidian instance is needed.
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { McqScoredAnswer, McqScoringSettings, scoreAnswer, scoreSession, suggestedRating } from '../models/mcq-scoring';
import { mapScoreToFsrsRating, mapScoreToSm2Response } from '../utils/rating';
import { FsrsRating, ReviewResponse } from '../models/review-schedule';

/** Matches the shipped defaults: no first-try rule, deduct 0.5 after 90 s. */
const SETTINGS: McqScoringSettings = {
    mcqDeductFullMarkOnFirstFailure: false,
    mcqTimeDeductionSeconds: 90,
    mcqTimeDeductionAmount: 0.5,
};

function answer(overrides: Partial<McqScoredAnswer> = {}): McqScoredAnswer {
    return {
        questionIndex: 0,
        selectedAnswerIndex: 1,
        attempts: 1,
        correct: true,
        timeToAnswer: 5,
        ...overrides,
    };
}

// ------------------------------------------------------------------- attempts

test('a correct first attempt scores full marks', () => {
    assert.equal(scoreAnswer(answer(), SETTINGS), 1);
});

test('correct on the second attempt scores a half, from the third on it scores nothing', () => {
    assert.equal(scoreAnswer(answer({ attempts: 2 }), SETTINGS), 0.5);
    assert.equal(scoreAnswer(answer({ attempts: 3 }), SETTINGS), 0);
    assert.equal(scoreAnswer(answer({ attempts: 4 }), SETTINGS), 0);
});

test('an incorrect first attempt scores nothing', () => {
    assert.equal(scoreAnswer(answer({ correct: false, selectedAnswerIndex: 0 }), SETTINGS), 0);
});

test('a question the user gave up on ("Show answer") scores nothing, even when flagged correct', () => {
    // The modal records show-answer and post-second-failure answers with -1 here.
    assert.equal(scoreAnswer(answer({ selectedAnswerIndex: -1, correct: true }), SETTINGS), 0);
    assert.equal(scoreAnswer(answer({ selectedAnswerIndex: -1, correct: false, attempts: 2 }), SETTINGS), 0);
    assert.equal(scoreAnswer(answer({ selectedAnswerIndex: -1, correct: false, attempts: 3 }), SETTINGS), 0);
});

// ------------------------------------------------------------- time deduction

test('an answer slower than the threshold loses the deduction amount', () => {
    assert.equal(scoreAnswer(answer({ timeToAnswer: 90.5 }), SETTINGS), 0.5);
    assert.equal(scoreAnswer(answer({ attempts: 2, timeToAnswer: 200 }), SETTINGS), 0);
});

test('an answer exactly at the threshold is not penalised', () => {
    assert.equal(scoreAnswer(answer({ timeToAnswer: 90 }), SETTINGS), 1);
});

test('the time deduction never pushes a question below zero', () => {
    const harsh: McqScoringSettings = { ...SETTINGS, mcqTimeDeductionAmount: 1 };
    // A second-attempt score of 0.5 minus a full point would be negative.
    assert.equal(scoreAnswer(answer({ attempts: 2, timeToAnswer: 120 }), harsh), 0);
});

test('the deduction only applies to questions that scored, so a slow wrong answer stays at zero', () => {
    assert.equal(scoreAnswer(answer({ correct: false, selectedAnswerIndex: 0, timeToAnswer: 300 }), SETTINGS), 0);
});

// ------------------------------------------------------- deduct-full-mark rule

test('with deduct-full-mark, only a correct first attempt earns the point', () => {
    const deduct: McqScoringSettings = { ...SETTINGS, mcqDeductFullMarkOnFirstFailure: true };
    assert.equal(scoreAnswer(answer(), deduct), 1);
    assert.equal(scoreAnswer(answer({ attempts: 2 }), deduct), 0);
    assert.equal(scoreAnswer(answer({ correct: false, selectedAnswerIndex: 0 }), deduct), 0);
    assert.equal(scoreAnswer(answer({ selectedAnswerIndex: -1, correct: false, attempts: 3 }), deduct), 0);
});

test('the time deduction still applies under the deduct-full-mark rule', () => {
    const deduct: McqScoringSettings = { ...SETTINGS, mcqDeductFullMarkOnFirstFailure: true };
    assert.equal(scoreAnswer(answer({ timeToAnswer: 91 }), deduct), 0.5);
});

// -------------------------------------------------------------- session score

test('a session with no questions scores zero', () => {
    assert.equal(scoreSession([], 0, SETTINGS), 0);
    // Even a stray answer cannot score a set that has no questions.
    assert.equal(scoreSession([answer()], 0, SETTINGS), 0);
});

test('the session score divides by the question count, so unanswered questions count against it', () => {
    const answers = [
        answer({ questionIndex: 0 }),
        answer({ questionIndex: 1, correct: false, selectedAnswerIndex: 0 }),
    ];
    assert.equal(scoreSession(answers, 4, SETTINGS), 0.25);
});

test('a mixed session sums its per-question points', () => {
    const answers = [
        answer({ questionIndex: 0 }), // 1
        answer({ questionIndex: 1, attempts: 2 }), // 0.5
        answer({ questionIndex: 2, correct: false, selectedAnswerIndex: 2 }), // 0
    ];
    assert.equal(scoreSession(answers, 3, SETTINGS), 0.5);
});

test('a perfect session scores exactly one', () => {
    const answers = [answer({ questionIndex: 0 }), answer({ questionIndex: 1 }), answer({ questionIndex: 2 })];
    assert.equal(scoreSession(answers, 3, SETTINGS), 1);
});

// ---------------------------------------------------------- suggested rating

test('FSRS thresholds: Again below 0.50, Hard from 0.50, Good from 0.70, Easy from 0.90', () => {
    const cases: Array<[number, number, string]> = [
        [0, FsrsRating.Again, 'Again'],
        [0.49, FsrsRating.Again, 'Again'],
        [0.50, FsrsRating.Hard, 'Hard'],
        [0.69, FsrsRating.Hard, 'Hard'],
        [0.70, FsrsRating.Good, 'Good'],
        [0.89, FsrsRating.Good, 'Good'],
        [0.90, FsrsRating.Easy, 'Easy'],
        [1, FsrsRating.Easy, 'Easy'],
    ];
    for (const [score, rating, label] of cases) {
        assert.deepEqual(suggestedRating(score, 'fsrs'), { rating, label }, `score ${score}`);
    }
});

test('SM-2 thresholds: 0.40, 0.60, 0.80 and 0.95, with blackout reserved for a zero score', () => {
    // Labels are the words the grade buttons use, not the enum keys: the
    // suggestion is shown next to those buttons.
    const cases: Array<[number, number, string]> = [
        [0, ReviewResponse.CompleteBlackout, 'Complete blackout'],
        [0.39, ReviewResponse.IncorrectResponse, 'Incorrect'],
        [0.40, ReviewResponse.IncorrectButFamiliar, 'Incorrect but familiar'],
        [0.59, ReviewResponse.IncorrectButFamiliar, 'Incorrect but familiar'],
        [0.60, ReviewResponse.CorrectWithDifficulty, 'Correct with difficulty'],
        [0.79, ReviewResponse.CorrectWithDifficulty, 'Correct with difficulty'],
        [0.80, ReviewResponse.CorrectWithHesitation, 'Correct with hesitation'],
        [0.94, ReviewResponse.CorrectWithHesitation, 'Correct with hesitation'],
        [0.95, ReviewResponse.PerfectRecall, 'Perfect recall'],
        [1, ReviewResponse.PerfectRecall, 'Perfect recall'],
    ];
    for (const [score, rating, label] of cases) {
        assert.deepEqual(suggestedRating(score, 'sm2'), { rating, label }, `score ${score}`);
    }
});

test('suggestedRating is the shared maps, not a second copy of the thresholds', () => {
    for (let i = 0; i <= 100; i++) {
        const score = i / 100;

        const fsrs = suggestedRating(score, 'fsrs');
        assert.equal(fsrs.rating, mapScoreToFsrsRating(score));
        assert.equal(fsrs.label, FsrsRating[fsrs.rating]);

        const sm2 = suggestedRating(score, 'sm2');
        assert.equal(sm2.rating, mapScoreToSm2Response(score));
        // Same thresholds as the shared map; the label is the button wording
        // ("PerfectRecall" is the enum key, and it is not what a learner reads).
        assert.match(sm2.label, /^[A-Z][a-z]/);
    }
});
