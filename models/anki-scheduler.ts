/**
 * Anki's two schedulers as pure functions: the classic SM-2-derived one that
 * Anki has always shipped, and FSRS (23.10+), driven through ts-fsrs.
 *
 * No Obsidian imports, no I/O, and no clock reads: callers pass the answer
 * instant as `now` (ms since the epoch) and the origin of Anki's day numbering
 * as `dayBase` (the collection creation time, ms since the epoch). Nothing here
 * mutates its arguments, with one documented exception: `burySiblings` writes
 * the burying onto the sibling cards it is given.
 *
 * `due`, following Anki's own column of the same name, is overloaded:
 *
 *  - a new or review card stores a DAY NUMBER — the count of days since the
 *    collection was created, where day 0 is the day `dayBase` falls in;
 *  - a learning or relearning card stores a real TIMESTAMP in milliseconds.
 *
 * `interval` follows this model's convention: negative seconds while the card
 * is learning ("negative while learning"), days once it is a review card. A
 * relearning card is the exception that proves it: like Anki, it carries the
 * interval its lapse produced, in days, so `interval` is positive there and its
 * next step lives only in `due`.
 *
 * Deliberate simplifications, all so this stays deterministic and pure:
 *
 *  - No fuzzing and no "days late" bonus. Anki nudges review intervals with a
 *    seeded fuzz and rewards overdue cards; neither is reproducible without a
 *    seed, so intervals here are exactly the formula.
 *  - Learning and relearning step position is derived from the card (the model
 *    has no `remaining_steps` field that Anki stores): a learning card's
 *    negative interval gives its current step, and a relearning card is assumed
 *    to be on its first relearn step (which is the only one with Anki's default
 *    of a single relearn step).
 *  - Intervals round to whole days, and answer-button labels round minutes to
 *    whole minutes, so a 5.5 minute hard delay prints as "6m" the way Anki does.
 */

import { default_w, fsrs, Rating, State as FsrsState } from 'ts-fsrs';
import type { Card as FsrsCard, FSRSParameters, Grade as FsrsGrade } from 'ts-fsrs';
import { AnkiCardQueue, AnkiCardType, AnkiGrade, DeckScheduler, LeechAction } from './anki';
import type {
    AnkiCard,
    AnkiId,
    AnswerResult,
    CardMemoryState,
    DeckCounts,
    DeckOptions,
    FsrsOptions,
    ScheduleOutcome,
} from './anki';

/** One day, in milliseconds. Exported so callers can convert day numbers. */
export const DAY_MS = 86_400_000;

const DAY_SECS = 86_400;
const MINUTE_MS = 60_000;
/** Anki never lets the ease factor fall below this (1300 = 130%). */
const MIN_EASE_FACTOR = 1300;
/** How much Hard lowers the ease and Easy raises it, in permille. */
const EASE_STEP = 150;
/** What failing a review card costs on top of the lapse itself (Anki: -0.2). */
const AGAIN_EASE_PENALTY = 200;

/** The four labels Anki prints on its answer buttons, one per grade. */
export interface IntervalPreview {
    again: string;
    hard: string;
    good: string;
    easy: string;
}

// ---------------------------------------------------------------- formatting

function oneDecimal(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Anki's own interval text for a span of days: '4m', '3h', '1d', '3d', '2.5mo',
 * '1.4y'. Hours are shown below a day, months above 30 days and years above
 * 365, the last two to one decimal place, the way Anki's answer buttons do.
 */
export function formatInterval(days: number): string {
    if (days >= 365) {
        return `${oneDecimal(days / 365)}y`;
    }
    if (days >= 30) {
        return `${oneDecimal(days / 30)}mo`;
    }
    if (days >= 1) {
        return `${Math.round(days)}d`;
    }
    const minutes = days * 24 * 60;
    if (minutes >= 60) {
        return `${Math.round(minutes / 60)}h`;
    }
    if (minutes >= 1) {
        return `${Math.round(minutes)}m`;
    }
    return `${Math.round(Math.max(0, minutes) * 60)}s`;
}

// ------------------------------------------------------------------- helpers

/** The collection day number the instant `at` falls on. */
function dayNumber(at: number, dayBase: number): number {
    return Math.floor((at - dayBase) / DAY_MS);
}

/** The day number a review interval lands on: today plus the interval. */
function dueDayFor(intervalDays: number, now: number, dayBase: number): number {
    return dayNumber(now, dayBase) + Math.max(0, Math.round(intervalDays));
}

/** The first moment of the next day: the end of today, as a timestamp. */
function endOfTodayMs(now: number, dayBase: number): number {
    return dayBase + (dayNumber(now, dayBase) + 1) * DAY_MS;
}

/** The label for a wait measured in seconds. */
function secondsLabel(secs: number): string {
    return formatInterval(secs / DAY_SECS);
}

/** Anki's ease floor, and the deck's starting ease for a card that has none. */
function normalizedEase(card: AnkiCard, options: DeckOptions): number {
    const ease = card.easeFactor > 0 ? card.easeFactor : options.startingEase;
    return Math.max(MIN_EASE_FACTOR, ease);
}

/**
 * A review interval: rounded to whole days, floored at the deck's minimum (and
 * at one day, as Anki does), capped at the deck's maximum.
 */
function clampReviewInterval(rawDays: number, options: DeckOptions, minimum = 1): number {
    const floor = Math.max(1, Math.round(options.minimumInterval), minimum);
    const ceiling = Math.max(floor, Math.round(options.maximumInterval));
    return Math.min(Math.max(Math.round(rawDays), floor), ceiling);
}

/**
 * Anki's "new interval" after a lapse: `lapseMultiplier` of the old interval,
 * never below a day (0% means "start over at 1 day"), and never below the
 * deck's minimum interval.
 */
function lapseInterval(oldInterval: number, options: DeckOptions): number {
    const multiplied = Math.round((oldInterval * options.lapseMultiplier) / 1000);
    return Math.max(multiplied, 1, Math.round(options.minimumInterval));
}

/** The delay of one learning step, in seconds, or null when there is no step. */
function stepDelaySecs(steps: number[], index: number): number | null {
    const minutes = steps[index];
    return minutes === undefined ? null : Math.max(0, Math.round(minutes * 60));
}

/**
 * Anki rounds a step longer than a day to a whole number of days, so a card
 * answered in the morning and one answered at night land on the same day.
 */
function maybeRoundInDays(secs: number): number {
    return secs > DAY_SECS ? Math.round(secs / DAY_SECS) * DAY_SECS : secs;
}

/**
 * Anki's `LearningSteps::hard_delay_secs`: on the first step Hard sits halfway
 * between the first two steps (so it never collides with Again); on any later
 * step it repeats that step unchanged; with a single step it is 50% longer,
 * but never more than a day longer than the step itself.
 */
function hardDelaySecs(steps: number[], index: number): number | null {
    const current = stepDelaySecs(steps, index) ?? stepDelaySecs(steps, 0);
    if (current === null) {
        return null;
    }
    if (index > 0) {
        return current;
    }
    const next = stepDelaySecs(steps, 1);
    if (next !== null) {
        return maybeRoundInDays(Math.floor((current + next) / 2));
    }
    return maybeRoundInDays(Math.min(Math.floor((current * 3) / 2), current + DAY_SECS));
}

/**
 * Which learning step a card is sitting on. A learning card's negative interval
 * says how long it is waiting, which is exactly its current step's delay; a
 * relearning card carries its post-lapse interval instead, so it is treated as
 * being on the first relearn step.
 */
function learningStepIndex(card: AnkiCard, steps: number[]): number {
    if (steps.length === 0) {
        return -1;
    }
    const delaySecs = card.interval < 0 ? -card.interval : 0;
    let index = 0;
    for (let i = 0; i < steps.length; i += 1) {
        if (Math.round(steps[i] * 60) > delaySecs) {
            break;
        }
        index = i;
    }
    return index;
}

/** The fields a card needs the moment it stops being new (Anki's original_position). */
function leftNewQueue(card: AnkiCard): { newPosition: null; originalPosition: number | undefined } {
    return {
        newPosition: null,
        originalPosition: card.originalPosition ?? card.newPosition ?? undefined,
    };
}

/** A card waiting for its next learning/relearning step. */
function learningCardState(
    card: AnkiCard,
    type: AnkiCardType,
    delaySecs: number,
    now: number,
    ease: number,
): AnkiCard {
    // A relearning card keeps the post-lapse interval it will graduate at; a
    // learning card stores its wait as a negative interval, which is also how
    // its next answer finds the step it is on.
    const interval =
        type === AnkiCardType.Relearning && card.interval > 0 ? card.interval : -delaySecs;
    return {
        ...card,
        ...leftNewQueue(card),
        type,
        queue: AnkiCardQueue.Learning,
        due: now + delaySecs * 1000,
        interval,
        easeFactor: ease,
        reviews: card.reviews + 1,
    };
}

/** A card that has graduated into the review queue. */
function graduatedCard(
    card: AnkiCard,
    intervalDays: number,
    ease: number,
    now: number,
    dayBase: number,
): AnkiCard {
    const interval = Math.max(1, Math.round(intervalDays));
    return {
        ...card,
        ...leftNewQueue(card),
        type: AnkiCardType.Review,
        queue: AnkiCardQueue.Review,
        interval,
        easeFactor: ease,
        due: dueDayFor(interval, now, dayBase),
        reviews: card.reviews + 1,
    };
}

function scheduleResult(
    card: AnkiCard,
    reason: ScheduleOutcome['reason'],
    label: string,
    leeched = false,
): AnswerResult {
    return {
        card,
        reason,
        intervalLabel: label,
        // The session owns the stopwatch and the sibling burying; both are
        // filled in by the caller.
        timeTakenMs: 0,
        leeched,
        buriedCardIds: [],
    };
}

function isBuriedOrSuspended(card: AnkiCard): boolean {
    return (
        card.queue === AnkiCardQueue.Suspended ||
        card.queue === AnkiCardQueue.SchedBuried ||
        card.queue === AnkiCardQueue.UserBuried
    );
}

// ------------------------------------------------------- the classic scheduler

/**
 * Anki's classic scheduler: one answer on one card.
 *
 * The card is dispatched on its type (new, learning, relearning, review), the
 * way Anki's own state machine does. `due` on the result follows the model's
 * convention: a timestamp while the card is learning, a day number once it is
 * new-in-waiting or in the review queue.
 */
export function answerCard(
    card: AnkiCard,
    options: DeckOptions,
    grade: AnkiGrade,
    now: number,
    dayBase: number = now,
): AnswerResult {
    switch (card.type) {
        case AnkiCardType.Learning:
            return answerLearningCard(card, options, grade, now, dayBase, false);
        case AnkiCardType.Relearning:
            return answerLearningCard(card, options, grade, now, dayBase, true);
        case AnkiCardType.Review:
            return answerReviewCard(card, options, grade, now, dayBase);
        case AnkiCardType.New:
        default:
            return answerNewCard(card, options, grade, now, dayBase);
    }
}

function answerNewCard(
    card: AnkiCard,
    options: DeckOptions,
    grade: AnkiGrade,
    now: number,
    dayBase: number,
): AnswerResult {
    const ease = Math.max(MIN_EASE_FACTOR, options.startingEase);
    const firstSecs = stepDelaySecs(options.learningSteps, 0);

    if (firstSecs === null) {
        // No learning steps: the card graduates on the spot. Anki sends
        // again/hard/good to the graduating interval and easy to the easy one.
        const interval = grade === AnkiGrade.Easy ? options.easyInterval : options.graduatingInterval;
        const graduated = graduatedCard(card, interval, ease, now, dayBase);
        return scheduleResult(graduated, 'new', formatInterval(interval));
    }

    if (grade === AnkiGrade.Easy) {
        const graduated = graduatedCard(card, options.easyInterval, ease, now, dayBase);
        return scheduleResult(graduated, 'new', formatInterval(options.easyInterval));
    }

    if (grade === AnkiGrade.Good) {
        const nextSecs = stepDelaySecs(options.learningSteps, 1);
        if (nextSecs === null) {
            const graduated = graduatedCard(card, options.graduatingInterval, ease, now, dayBase);
            return scheduleResult(graduated, 'new', formatInterval(options.graduatingInterval));
        }
        const waiting = learningCardState(card, AnkiCardType.Learning, nextSecs, now, ease);
        return scheduleResult(waiting, 'new', secondsLabel(nextSecs));
    }

    const delaySecs =
        grade === AnkiGrade.Hard
            ? hardDelaySecs(options.learningSteps, 0) ?? firstSecs
            : firstSecs;
    const waiting = learningCardState(card, AnkiCardType.Learning, delaySecs, now, ease);
    return scheduleResult(waiting, 'new', secondsLabel(delaySecs));
}

function answerLearningCard(
    card: AnkiCard,
    options: DeckOptions,
    grade: AnkiGrade,
    now: number,
    dayBase: number,
    relearning: boolean,
): AnswerResult {
    const steps = relearning ? options.relearningSteps : options.learningSteps;
    const type = relearning ? AnkiCardType.Relearning : AnkiCardType.Learning;
    const reason: ScheduleOutcome['reason'] = relearning ? 'relearning' : 'learning';
    const ease = normalizedEase(card, options);
    const index = learningStepIndex(card, steps);

    // Where a graduation lands: a relearning card returns to the review
    // interval its lapse left on the card, everything else uses the deck's
    // graduating interval (or its easy interval for an "easy" answer).
    const carried = relearning && card.interval > 0 ? clampReviewInterval(card.interval, options) : null;
    const graduating = carried ?? Math.max(1, Math.round(options.graduatingInterval));
    const easy = carried ?? Math.max(1, Math.round(options.easyInterval));

    const graduate = (interval: number): AnswerResult => {
        const graduated = graduatedCard(card, interval, ease, now, dayBase);
        return scheduleResult(graduated, reason, formatInterval(interval));
    };

    if (index < 0) {
        // No steps configured: any answer graduates the card (Anki does this
        // and its own tests pin it).
        return grade === AnkiGrade.Easy ? graduate(easy) : graduate(graduating);
    }
    if (grade === AnkiGrade.Easy) {
        return graduate(easy);
    }
    if (grade === AnkiGrade.Good) {
        const nextSecs = stepDelaySecs(steps, index + 1);
        if (nextSecs === null) {
            return graduate(graduating);
        }
        const waiting = learningCardState(card, type, nextSecs, now, ease);
        return scheduleResult(waiting, reason, secondsLabel(nextSecs));
    }

    // Again restarts the steps; Hard repeats the current one.
    const delaySecs =
        grade === AnkiGrade.Hard
            ? hardDelaySecs(steps, index) ?? stepDelaySecs(steps, 0) ?? 0
            : stepDelaySecs(steps, 0) ?? 0;
    const waiting = learningCardState(card, type, delaySecs, now, ease);
    return scheduleResult(waiting, reason, secondsLabel(delaySecs));
}

function answerReviewCard(
    card: AnkiCard,
    options: DeckOptions,
    grade: AnkiGrade,
    now: number,
    dayBase: number,
): AnswerResult {
    const ease = normalizedEase(card, options);

    if (grade === AnkiGrade.Again) {
        return lapseCard(card, options, now, dayBase, ease);
    }

    // The numbers below are Anki's own, from rslib/src/scheduler/states/review.rs:
    //   review   good = (scheduled + daysLate/2) * ease
    //            hard = scheduled * hardMultiplier   (at least scheduled + 1)
    //            easy = (scheduled + daysLate) * ease * easyBonus  (at least good + 1)
    //   early    good = max(elapsed * ease, scheduled)
    //            hard = max(elapsed * hardMultiplier, scheduled * hardMultiplier/2)
    //            easy = good * (easyBonus - (easyBonus - 1)/2)
    // where `elapsed` is how long the card has actually been away and `daysLate`
    // is how far past its due day it is. Getting these wrong is the difference
    // between a deck that behaves like Anki and one that only looks like it.
    const scheduled = Math.max(1, card.interval);
    const elapsed = Math.max(0, dayNumber(now, dayBase) - (card.due - scheduled));
    const daysLate = elapsed - scheduled;
    const early = daysLate < 0;
    const hardFactor = options.hardMultiplier / 1000;
    const easeFactor = ease / 1000;
    const easyFactor = options.easyBonus / 1000;

    let raw: number;
    let minimum = 1;
    let newEase = ease;
    const multiplier = options.intervalMultiplier / 1000;
    if (early) {
        const goodInterval = Math.max(elapsed * easeFactor, scheduled);
        if (grade === AnkiGrade.Hard) {
            raw = Math.max(elapsed * hardFactor, scheduled * (hardFactor / 2)) * multiplier;
            newEase = Math.max(MIN_EASE_FACTOR, ease - EASE_STEP);
        } else if (grade === AnkiGrade.Good) {
            raw = goodInterval * multiplier;
        } else {
            raw = goodInterval * (easyFactor - (easyFactor - 1) / 2) * multiplier;
            newEase = ease + EASE_STEP;
        }
    } else {
        const lateBonus = daysLate / 2;
        // Hard first: its *constrained* value is the floor Good has to clear, and
        // Good's is the floor for Easy. Anki computes them in that order
        // (passing_nonearly_review_intervals), and the ordering is what keeps the
        // four buttons in a sensible sequence on short intervals.
        const hardMinimum = hardFactor > 1 ? scheduled + 1 : 0;
        const hardInterval = clampReviewInterval(scheduled * hardFactor * multiplier, options, hardMinimum);
        if (grade === AnkiGrade.Hard) {
            raw = scheduled * hardFactor * multiplier;
            minimum = hardMinimum;
            newEase = Math.max(MIN_EASE_FACTOR, ease - EASE_STEP);
        } else if (grade === AnkiGrade.Good) {
            raw = (scheduled + lateBonus) * easeFactor * multiplier;
            minimum = hardInterval + 1;
        } else {
            raw = (scheduled + daysLate) * easeFactor * easyFactor * multiplier;
            minimum = clampReviewInterval((scheduled + lateBonus) * easeFactor * multiplier, options, hardInterval + 1) + 1;
            newEase = ease + EASE_STEP;
        }
    }

    const interval = clampReviewInterval(raw, options, minimum);
    const reason: ScheduleOutcome['reason'] = early ? 'early' : 'review';

    const resultCard: AnkiCard = {
        ...card,
        type: AnkiCardType.Review,
        queue: AnkiCardQueue.Review,
        interval,
        easeFactor: newEase,
        due: dueDayFor(interval, now, dayBase),
        reviews: card.reviews + 1,
    };
    return scheduleResult(resultCard, reason, formatInterval(interval));
}

/**
 * A lapse: the card goes back to relearning with the old interval multiplied by
 * `lapseMultiplier` (0% starts over at a day), one more lapse on its record,
 * and the leech action applied when it has lapsed often enough.
 */
function lapseCard(
    card: AnkiCard,
    options: DeckOptions,
    now: number,
    dayBase: number,
    ease: number,
): AnswerResult {
    const lapses = card.lapses + 1;
    const postLapseInterval = lapseInterval(card.interval, options);
    // Anki charges an extra -0.2 of ease on a review failure
    // (EASE_FACTOR_AGAIN_DELTA in rslib/src/scheduler/states/review.rs), on top
    // of the decay the lapse itself represents.
    const easeAfterLapse = Math.max(MIN_EASE_FACTOR, ease - AGAIN_EASE_PENALTY);
    const leeched = isLeech({ ...card, lapses }, options);
    const base: AnkiCard = {
        ...card,
        ...leftNewQueue(card),
        type: AnkiCardType.Relearning,
        interval: postLapseInterval,
        lapses,
        easeFactor: easeAfterLapse,
        reviews: card.reviews + 1,
    };

    const delayMinutes = lapseDelayMinutes(options);
    if (delayMinutes === null) {
        // No relearn step to sit on: the card returns to review straight away.
        const review = {
            ...base,
            type: AnkiCardType.Review,
            queue: AnkiCardQueue.Review,
            due: dueDayFor(postLapseInterval, now, dayBase),
        };
        return scheduleResult(review, 'lapse', formatInterval(postLapseInterval), leeched);
    }

    const waitingSecs = Math.round(delayMinutes * 60);
    // The card keeps its post-lapse interval (that is what it graduates at) and
    // carries the wait for its relearn step in `due`.
    const relearning = {
        ...base,
        queue: AnkiCardQueue.Learning,
        due: now + delayMinutes * MINUTE_MS,
    };
    const label = secondsLabel(waitingSecs);
    if (leeched && options.leechAction === LeechAction.Suspend) {
        // Suspended, but still scheduled in relearning: unsuspending the card
        // has to put it back where it was, with its post-lapse interval intact.
        const held = { ...relearning, queue: AnkiCardQueue.Suspended };
        return scheduleResult(held, 'lapse', label, true);
    }
    return scheduleResult(relearning, 'lapse', label, leeched);
}

/** The deck's again-delay for a lapsed card, or null when it goes straight back. */
function lapseDelayMinutes(options: DeckOptions): number | null {
    const relearn = options.relearningSteps[0];
    if (relearn !== undefined && relearn > 0) {
        return relearn;
    }
    return options.againDelayMinutes > 0 ? options.againDelayMinutes : null;
}

// ------------------------------------------------------------------ FSRS path

function fsrsStateFor(type: AnkiCardType): FsrsState {
    switch (type) {
        case AnkiCardType.Learning:
            return FsrsState.Learning;
        case AnkiCardType.Review:
            return FsrsState.Review;
        case AnkiCardType.Relearning:
            return FsrsState.Relearning;
        case AnkiCardType.New:
        default:
            return FsrsState.New;
    }
}

function ankiTypeFor(state: FsrsState): AnkiCardType {
    switch (state) {
        case FsrsState.Learning:
            return AnkiCardType.Learning;
        case FsrsState.Review:
            return AnkiCardType.Review;
        case FsrsState.Relearning:
            return AnkiCardType.Relearning;
        case FsrsState.New:
        default:
            return AnkiCardType.New;
    }
}

function ratingFor(grade: AnkiGrade): FsrsGrade {
    switch (grade) {
        case AnkiGrade.Again:
            return Rating.Again;
        case AnkiGrade.Hard:
            return Rating.Hard;
        case AnkiGrade.Easy:
            return Rating.Easy;
        case AnkiGrade.Good:
        default:
            return Rating.Good;
    }
}

/**
 * The FSRS scheduler for one answer, on top of the bundled ts-fsrs.
 *
 * Memory state is read from and written back to `card.memory`; the card's own
 * `interval` and `due` follow the same conventions as the classic scheduler
 * (timestamp while learning, day number once in the review queue), so a deck
 * can be exported after either scheduler has run.
 */
export function answerFsrs(
    card: AnkiCard,
    options: DeckOptions,
    grade: AnkiGrade,
    now: number,
    fsrsOptions: FsrsOptions = options.fsrs,
    dayBase: number = now,
): AnswerResult {
    const parameters: Partial<FSRSParameters> = {
        request_retention: fsrsOptions.desiredRetention,
        maximum_interval: fsrsOptions.maximumInterval,
        // Anki stores the 19 FSRS-5 weights; an empty list means none have been
        // chosen, in which case the library's own defaults are the right ones.
        w: fsrsOptions.weights.length > 0 ? fsrsOptions.weights : [...default_w],
        // Deterministic: a preview has to give the same answer as the real thing.
        enable_fuzz: false,
        // Keep cards in the learning queue within the day, as Anki does while
        // the deck's learning steps have not been finished.
        enable_short_term: true,
    };
    const scheduler = fsrs(parameters);

    // A card with no usable memory state has nothing for FSRS to continue from:
    // it is a first review. Its own counts are kept so nothing is lost.
    const memory = card.memory && card.memory.stability > 0 ? card.memory : null;
    const current: FsrsCard = {
        due: new Date(now),
        stability: memory ? memory.stability : 0,
        difficulty: memory ? memory.difficulty : 0,
        elapsed_days: memory ? Math.max(0, Math.round((now - memory.lastReview) / DAY_MS)) : 0,
        scheduled_days: memory ? memory.scheduledDays : 0,
        reps: card.reviews,
        lapses: card.lapses,
        state: memory ? fsrsStateFor(card.type) : FsrsState.New,
        last_review: memory ? new Date(memory.lastReview) : undefined,
    };

    const next = scheduler.next(current, new Date(now), ratingFor(grade)).card;
    const type = ankiTypeFor(next.state);
    const shortTerm = next.state === FsrsState.Learning || next.state === FsrsState.Relearning;
    const dueMs = next.due.getTime();
    const intervalDays = Math.max(1, Math.round((dueMs - now) / DAY_MS));
    const nextMemory: CardMemoryState = {
        stability: next.stability,
        difficulty: next.difficulty,
        lastReview: next.last_review ? next.last_review.getTime() : now,
        scheduledDays: next.scheduled_days,
    };

    const leeched = grade === AnkiGrade.Again && isLeech({ ...card, lapses: next.lapses }, options);
    const suspended = leeched && options.leechAction === LeechAction.Suspend;
    const resultCard: AnkiCard = {
        ...card,
        ...leftNewQueue(card),
        type,
        queue: suspended
            ? AnkiCardQueue.Suspended
            : shortTerm
              ? AnkiCardQueue.Learning
              : AnkiCardQueue.Review,
        interval: shortTerm ? -Math.max(0, Math.round((dueMs - now) / 1000)) : intervalDays,
        // FSRS tracks difficulty, not the SM-2 ease, but the column still holds
        // a sane value for anything that reads it.
        easeFactor: card.easeFactor > 0 ? card.easeFactor : Math.max(MIN_EASE_FACTOR, options.startingEase),
        due: shortTerm ? dueMs : dayNumber(dueMs, dayBase),
        reviews: next.reps,
        lapses: next.lapses,
        memory: nextMemory,
        desiredRetentionDays: shortTerm ? card.desiredRetentionDays : intervalDays,
    };

    let reason: ScheduleOutcome['reason'];
    if (!memory) {
        reason = 'new';
    } else if (grade === AnkiGrade.Again && card.type === AnkiCardType.Review) {
        reason = 'lapse';
    } else if (type === AnkiCardType.Relearning) {
        reason = 'relearning';
    } else if (type === AnkiCardType.Learning) {
        reason = 'learning';
    } else {
        reason = 'review';
    }

    const label = shortTerm
        ? secondsLabel(Math.max(0, Math.round((dueMs - now) / 1000)))
        : formatInterval(intervalDays);
    return scheduleResult(resultCard, reason, label, leeched);
}

// ------------------------------------------------------------------- counting

/**
 * The deck's counts for today, in Anki's own terms.
 *
 *  - `newCount`: new cards, capped by `newPerDay` (0 means none today).
 *  - `learningCount`: learning and relearning cards due by the end of today.
 *  - `reviewCount`: review cards whose due day has arrived, capped by
 *    `reviewsPerDay` (0 means unlimited, the way Anki treats 0 there).
 *  - `totalCards`: every card that is not buried or suspended.
 *  - `dueToday`: the uncapped sum of the numbers above.
 *
 * Suspended and buried cards count as neither new, learning nor review. The
 * caller passes one deck's cards; a deck id is not part of a card's count.
 */
export function dueCounts(
    cards: AnkiCard[],
    options: DeckOptions,
    now: number,
    dayBase: number,
): DeckCounts {
    const today = dayNumber(now, dayBase);
    const endOfToday = endOfTodayMs(now, dayBase);
    let newRaw = 0;
    let learning = 0;
    let reviewRaw = 0;
    let total = 0;

    for (const card of cards) {
        if (isBuriedOrSuspended(card)) {
            continue;
        }
        total += 1;
        if (card.queue === AnkiCardQueue.New) {
            newRaw += 1;
        } else if (card.queue === AnkiCardQueue.Learning) {
            if (card.due <= endOfToday) {
                learning += 1;
            }
        } else if (card.queue === AnkiCardQueue.Review && card.due <= today) {
            reviewRaw += 1;
        }
    }

    const newCount = options.newPerDay > 0 ? Math.min(options.newPerDay, newRaw) : 0;
    const reviewCount = options.reviewsPerDay > 0 ? Math.min(options.reviewsPerDay, reviewRaw) : reviewRaw;

    return {
        newCount,
        learningCount: learning,
        reviewCount,
        totalCards: total,
        dueToday: newRaw + learning + reviewRaw,
    };
}

/**
 * How many new cards today's allowance is worth. Anki also subtracts the cards
 * it has already introduced today; that counter lives in the study session, so
 * the session is expected to subtract it.
 */
export function newCardCountForToday(
    cards: AnkiCard[],
    options: DeckOptions,
    now: number,
    dayBase: number,
): number {
    return dueCounts(cards, options, now, dayBase).newCount;
}

// ---------------------------------------------------------------------- queue

function positionOf(card: AnkiCard): number {
    return card.originalPosition ?? card.newPosition ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Anki's v3 study order for one deck: the learning cards that are due (intraday
 * and interday alike, earliest first), then the review cards in due order with
 * their original position as the tiebreak, then the new cards in position
 * order. New cards are kept sequential, as Anki does unless the deck asks for
 * them to be mixed in.
 *
 * Buried and suspended cards are left out, as are the day's over-limit cards
 * (`reviewsPerDay`, `newPerDay`), so the queue lines up with `dueCounts`.
 * `limit` caps the total, and `deckId` drops cards from another deck when the
 * caller passes cards from more than one.
 */
export function buildQueue(
    cards: AnkiCard[],
    options: DeckOptions,
    now: number,
    dayBase: number,
    limit?: number,
    deckId?: AnkiId,
): AnkiCard[] {
    const today = dayNumber(now, dayBase);
    const endOfToday = endOfTodayMs(now, dayBase);
    const learning: AnkiCard[] = [];
    const review: AnkiCard[] = [];
    const fresh: AnkiCard[] = [];

    for (const card of cards) {
        if (isBuriedOrSuspended(card)) {
            continue;
        }
        if (deckId !== undefined && card.deckId !== deckId) {
            continue;
        }
        if (card.queue === AnkiCardQueue.Learning) {
            if (card.due <= endOfToday) {
                learning.push(card);
            }
        } else if (card.queue === AnkiCardQueue.Review) {
            if (card.due <= today) {
                review.push(card);
            }
        } else if (card.queue === AnkiCardQueue.New) {
            fresh.push(card);
        }
    }

    learning.sort((a, b) => a.due - b.due);
    review.sort((a, b) => a.due - b.due || positionOf(a) - positionOf(b));
    fresh.sort((a, b) => positionOf(a) - positionOf(b));

    const reviewCap = options.reviewsPerDay > 0 ? options.reviewsPerDay : review.length;
    const newCap = options.newPerDay > 0 ? options.newPerDay : 0;
    const queue = [
        ...learning,
        ...review.slice(0, reviewCap),
        ...fresh.slice(0, newCap),
    ];
    return limit !== undefined && limit >= 0 ? queue.slice(0, limit) : queue;
}

// ---------------------------------------------------------------------- burying

/**
 * Bury the siblings of the card that was just answered: the other cards of the
 * same note, when the deck buries new and/or review siblings. Each buried card
 * gets the SiblingBuried queue and a due date at the end of today, which is the
 * start of tomorrow — for the day-number cards this really is `today + 1`.
 *
 * This is the one function here that writes to its input: the siblings are
 * updated in place, and their ids are returned.
 *
 * `now` should be the answer instant and `dayBase` the collection origin, as
 * with `answerCard`; when `now` is left out the answered card's `due` is used
 * as the instant, which is right for a learning card (a timestamp) and merely
 * harmless for the rest, since buried cards are excluded by their queue.
 */
export function burySiblings(
    cards: AnkiCard[],
    answeredCard: AnkiCard,
    options: DeckOptions,
    now: number = answeredCard.due,
    dayBase: number = 0,
): AnkiId[] {
    const endOfToday = endOfTodayMs(now, dayBase);
    const buried: AnkiId[] = [];
    for (const card of cards) {
        if (card.id === answeredCard.id || card.noteId !== answeredCard.noteId) {
            continue;
        }
        // New and review siblings follow the deck's toggles; a card in learning
        // or relearning is always buried — it cannot be shown twice today
        // (Anki's BuryMode: the toggles gate new, review and interday learning).
        if (card.queue === AnkiCardQueue.New) {
            if (!options.buryNewSiblings) continue;
        } else if (card.queue === AnkiCardQueue.Review || card.queue === AnkiCardQueue.DayLearn) {
            if (!options.buryReviewSiblings) continue;
        } else if (card.queue !== AnkiCardQueue.Learning) {
            continue;
        }
        // Scheduler-buried, Anki's own queue for this, and the due date moves only
        // for cards that were due inside today: an overdue review card simply
        // stops being gathered until tomorrow (bury_and_suspend.rs).
        card.queue = AnkiCardQueue.SchedBuried;
        if (card.type === AnkiCardType.Learning || card.type === AnkiCardType.Relearning) {
            card.due = endOfToday;
        }
        buried.push(card.id);
    }
    return buried;
}

// --------------------------------------------------------------------- preview

/**
 * The four labels for the answer buttons, without touching the card: the real
 * scheduler runs on a copy for each grade, so a preview and the answer that
 * follows it can never disagree. Decks set to FSRS are previewed through FSRS.
 */
export function intervalPreview(
    card: AnkiCard,
    options: DeckOptions,
    now: number,
    dayBase: number = now,
): IntervalPreview {
    const label = (grade: AnkiGrade): string => {
        const copy = { ...card };
        const answered =
            options.scheduler === DeckScheduler.Fsrs
                ? answerFsrs(copy, options, grade, now, options.fsrs, dayBase)
                : answerCard(copy, options, grade, now, dayBase);
        return answered.intervalLabel;
    };
    return {
        again: label(AnkiGrade.Again),
        hard: label(AnkiGrade.Hard),
        good: label(AnkiGrade.Good),
        easy: label(AnkiGrade.Easy),
    };
}

// ----------------------------------------------------------------------- leech

/**
 * Whether the card has lapsed often enough to be a leech. The card model has no
 * leech flag (Anki records it as a tag or a suspension), so the lapse count is
 * the whole story; a threshold of 0 disables the check.
 */
export function isLeech(card: AnkiCard, options: DeckOptions): boolean {
    // Anki asks again at the threshold and then at every half threshold after it
    // (leech_threshold_met in rslib/src/scheduler/states/review.rs), so a card
    // that keeps failing keeps being offered the decision.
    const threshold = options.leechThreshold;
    if (threshold <= 0 || card.lapses < threshold) return false;
    const halfThreshold = Math.max(1, Math.ceil(threshold / 2));
    return (card.lapses - threshold) % halfThreshold === 0;
}
