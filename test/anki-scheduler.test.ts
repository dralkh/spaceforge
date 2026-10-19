/**
 * Tests for the Anki scheduling engine: the classic scheduler's numbers
 * (steps, graduation, ease, lapses, leeches, limits, queue order, burying,
 * previews) and the FSRS path over ts-fsrs. Run with `npm test`.
 *
 * Every instant is fixed and passed in — the engine never reads the clock, so
 * the numbers below are exact. `NOW` sits on collection day 14: the collection
 * was created at 04:00 on 2026-01-01, and the answer instant is 09:00 on
 * 2026-01-15, 14 days and 5 hours later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { default_w } from 'ts-fsrs';

import {
    DAY_MS,
    answerCard,
    answerFsrs,
    buildQueue,
    burySiblings,
    dueCounts,
    formatInterval,
    intervalPreview,
    isLeech,
    newCardCountForToday,
} from '../models/anki-scheduler';
import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    AnkiGrade,
    DEFAULT_DECK_OPTIONS,
    DeckOptions,
    DeckScheduler,
    LeechAction,
} from '../models/anki';

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);
const DAY_BASE = Date.UTC(2026, 0, 1, 4, 0, 0);
/** The collection day `NOW` falls on. */
const TODAY = Math.floor((NOW - DAY_BASE) / DAY_MS);
/** A review card due on the given collection day. */
const day = (n: number): number => TODAY + n;

function options(overrides: Partial<DeckOptions> = {}): DeckOptions {
    return { ...DEFAULT_DECK_OPTIONS, ...overrides };
}

let sequence = 0;
function card(overrides: Partial<AnkiCard> = {}): AnkiCard {
    sequence += 1;
    return {
        id: `c${sequence}`,
        noteId: `n${sequence}`,
        deckId: 'deck',
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 0,
        reviews: 0,
        lapses: 0,
        due: 0,
        newPosition: null,
        flag: 0,
        ...overrides,
    };
}

/** A new card waiting in the new queue, at a given position. */
function newCard(position: number, overrides: Partial<AnkiCard> = {}): AnkiCard {
    return card({ newPosition: position, due: 0, ...overrides });
}

/** A review card with a real interval and ease. */
function reviewCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
    return card({
        type: AnkiCardType.Review,
        queue: AnkiCardQueue.Review,
        interval: 6,
        easeFactor: 2500,
        reviews: 3,
        due: TODAY,
        ...overrides,
    });
}

/** A learning card, waiting for its current step. */
function learningCard(delaySecs: number, overrides: Partial<AnkiCard> = {}): AnkiCard {
    return card({
        type: AnkiCardType.Learning,
        queue: AnkiCardQueue.Learning,
        interval: -delaySecs,
        due: NOW + delaySecs * 1000,
        ...overrides,
    });
}

test('the fixture sits on collection day 14', () => {
    assert.equal(TODAY, 14);
});

// ------------------------------------------------------------ new cards

test('a new card answered Good graduates onto the graduating interval', () => {
    // A single step, so Good goes straight to review (Anki's learning.rs).
    const result = answerCard(newCard(3), options({ learningSteps: [1] }), AnkiGrade.Good, NOW, DAY_BASE);

    assert.equal(result.reason, 'new');
    assert.equal(result.card.type, AnkiCardType.Review);
    assert.equal(result.card.queue, AnkiCardQueue.Review);
    assert.equal(result.card.interval, 1);
    assert.equal(result.card.due, day(1));
    assert.equal(result.card.easeFactor, 2500, 'graduation sets the starting ease');
    assert.equal(result.card.reviews, 1);
    assert.equal(result.card.newPosition, null, 'the card leaves the new queue');
    assert.equal(result.card.originalPosition, 3, 'and keeps its old position');
    assert.equal(result.intervalLabel, '1d');
    assert.equal(result.leeched, false);
    assert.deepEqual(result.buriedCardIds, []);
});

test('a new card answered Good moves to the second learning step', () => {
    const result = answerCard(newCard(1), options(), AnkiGrade.Good, NOW, DAY_BASE);

    assert.equal(result.card.type, AnkiCardType.Learning);
    assert.equal(result.card.queue, AnkiCardQueue.Learning);
    assert.equal(result.card.interval, -600, 'a learning card waits in negative seconds');
    assert.equal(result.card.due, NOW + 600_000, 'and carries a real timestamp');
    assert.equal(result.card.easeFactor, 2500);
    assert.equal(result.intervalLabel, '10m');
});

test('a new card answered Again starts the first learning step', () => {
    const result = answerCard(newCard(1), options(), AnkiGrade.Again, NOW, DAY_BASE);

    assert.equal(result.card.type, AnkiCardType.Learning);
    assert.equal(result.card.due, NOW + 60_000);
    assert.equal(result.card.interval, -60);
    assert.equal(result.intervalLabel, '1m');
});

test('a new card answered Hard takes the average of the first two steps', () => {
    const result = answerCard(newCard(1), options(), AnkiGrade.Hard, NOW, DAY_BASE);

    // (1 + 10) / 2 minutes = 330 seconds, and it stays in learning.
    assert.equal(result.card.type, AnkiCardType.Learning);
    assert.equal(result.card.due, NOW + 330_000);
    assert.equal(result.card.interval, -330);
    assert.equal(result.intervalLabel, '6m', 'Anki rounds the 5.5 minute average to 6m');
    assert.notEqual(result.card.due, NOW + 60_000, 'Hard never collides with Again');
});

test('a new card answered Easy jumps to the easy interval', () => {
    const result = answerCard(newCard(1), options(), AnkiGrade.Easy, NOW, DAY_BASE);

    assert.equal(result.card.type, AnkiCardType.Review);
    assert.equal(result.card.interval, 4);
    assert.equal(result.card.due, day(4));
    assert.equal(result.card.easeFactor, 2500);
    assert.equal(result.intervalLabel, '4d');
});

test('a card with no learning steps graduates on any answer', () => {
    const noSteps = options({ learningSteps: [] });
    for (const grade of [AnkiGrade.Again, AnkiGrade.Hard, AnkiGrade.Good]) {
        const result = answerCard(newCard(1), noSteps, grade, NOW, DAY_BASE);
        assert.equal(result.card.type, AnkiCardType.Review, `grade ${grade}`);
        assert.equal(result.card.interval, 1);
    }
    const easy = answerCard(newCard(1), noSteps, AnkiGrade.Easy, NOW, DAY_BASE);
    assert.equal(easy.card.interval, 4);
});

// ------------------------------------------------------- learning cards

test('a learning card walks 1m -> 10m -> graduation', () => {
    const first = answerCard(learningCard(60), options(), AnkiGrade.Good, NOW, DAY_BASE);

    assert.equal(first.reason, 'learning');
    assert.equal(first.card.type, AnkiCardType.Learning);
    assert.equal(first.card.due, NOW + 600_000, 'advanced to the 10m step');
    assert.equal(first.card.interval, -600);
    assert.equal(first.card.reviews, 1);
    assert.equal(first.intervalLabel, '10m');

    // Answering the second step on time graduates the card.
    const second = answerCard(first.card, options(), AnkiGrade.Good, NOW + 600_000, DAY_BASE);

    assert.equal(second.card.type, AnkiCardType.Review);
    assert.equal(second.card.queue, AnkiCardQueue.Review);
    assert.equal(second.card.interval, 1);
    assert.equal(second.card.due, day(1));
    assert.equal(second.card.easeFactor, 2500);
    assert.equal(second.card.reviews, 2);
    assert.equal(second.intervalLabel, '1d');
});

test('Hard on a learning card stays on the step: averaged first, repeated after', () => {
    // First step (1m of [1,10]): Anki averages the first two steps.
    const first = answerCard(learningCard(60), options(), AnkiGrade.Hard, NOW, DAY_BASE);
    assert.equal(first.card.due, NOW + 330_000);
    assert.equal(first.card.interval, -330);

    // Last step (10m): the step is repeated unchanged, so Hard never grows past it.
    const last = answerCard(learningCard(600), options(), AnkiGrade.Hard, NOW, DAY_BASE);
    assert.equal(last.card.due, NOW + 600_000);
    assert.equal(last.card.interval, -600);
    assert.equal(last.card.type, AnkiCardType.Learning);
});

test('Easy on a learning card graduates at the easy interval', () => {
    const result = answerCard(learningCard(600), options(), AnkiGrade.Easy, NOW, DAY_BASE);

    assert.equal(result.card.type, AnkiCardType.Review);
    assert.equal(result.card.interval, 4);
    assert.equal(result.card.due, day(4));
    assert.equal(result.intervalLabel, '4d');
});

test('Again on a learning card restarts the first step', () => {
    const result = answerCard(learningCard(600), options(), AnkiGrade.Again, NOW, DAY_BASE);

    assert.equal(result.card.type, AnkiCardType.Learning);
    assert.equal(result.card.due, NOW + 60_000);
    assert.equal(result.card.interval, -60);
});

test('a relearning card graduates back to the interval its lapse left', () => {
    const relearning = card({
        type: AnkiCardType.Relearning,
        queue: AnkiCardQueue.Learning,
        interval: 10,
        easeFactor: 2450,
        due: NOW + 600_000,
        lapses: 1,
        reviews: 4,
    });

    const good = answerCard(relearning, options(), AnkiGrade.Good, NOW, DAY_BASE);
    assert.equal(good.reason, 'relearning');
    assert.equal(good.card.type, AnkiCardType.Review);
    assert.equal(good.card.interval, 10, 'no relearn interval: straight back to the lapse interval');
    assert.equal(good.card.due, day(10));
    assert.equal(good.card.easeFactor, 2450, 'the ease the card already had is kept');
    assert.equal(good.intervalLabel, '10d');

    const easy = answerCard({ ...relearning, interval: 20 }, options(), AnkiGrade.Easy, NOW, DAY_BASE);
    assert.equal(easy.card.interval, 20);

    const again = answerCard(relearning, options(), AnkiGrade.Again, NOW, DAY_BASE);
    assert.equal(again.card.type, AnkiCardType.Relearning);
    assert.equal(again.card.queue, AnkiCardQueue.Learning);
    assert.equal(again.card.due, NOW + 600_000);
    assert.equal(again.card.interval, 10, 'the carried interval survives another failure');
    assert.equal(again.intervalLabel, '10m');
});

// --------------------------------------------------------- review cards

test("a review card's Good interval is its interval times the ease", () => {
    const result = answerCard(reviewCard(), options(), AnkiGrade.Good, NOW, DAY_BASE);

    // 6 days * 2.5 = 15 days.
    assert.equal(result.reason, 'review');
    assert.equal(result.card.type, AnkiCardType.Review);
    assert.equal(result.card.interval, 15);
    assert.equal(result.card.due, day(15));
    assert.equal(result.card.easeFactor, 2500, 'Good leaves the ease alone');
    assert.equal(result.card.reviews, 4);
    assert.equal(result.intervalLabel, '15d');

    const doubled = answerCard(
        reviewCard(),
        options({ intervalMultiplier: 2000 }),
        AnkiGrade.Good,
        NOW,
        DAY_BASE,
    );
    assert.equal(doubled.card.interval, 30, 'the interval multiplier applies to every review');
    assert.equal(doubled.card.due, day(30));
});

test('the buttons stay in order on a one-day card: hard < good < easy', () => {
    // Anki constrains hard first and makes it the floor for good (and good the
    // floor for easy): 1 * 1.2 = 1.2 rounds to 1, which is below the card's own
    // interval, so hard is lifted to 2; good (1 * 1.3 = 1.3) is then lifted to 3.
    const hard = answerCard(reviewCard({ interval: 1, easeFactor: 1300 }), options(), AnkiGrade.Hard, NOW, DAY_BASE);
    const good = answerCard(reviewCard({ interval: 1, easeFactor: 1300 }), options(), AnkiGrade.Good, NOW, DAY_BASE);
    const easy = answerCard(reviewCard({ interval: 1, easeFactor: 1300 }), options(), AnkiGrade.Easy, NOW, DAY_BASE);

    assert.equal(hard.card.interval, 2);
    assert.equal(good.card.interval, 3);
    assert.ok(easy.card.interval > good.card.interval, `easy ${easy.card.interval} must clear good ${good.card.interval}`);
    assert.equal(good.card.due, day(3));
    assert.equal(good.intervalLabel, '3d');
});

test('Hard lowers the ease by 150 and Easy raises it by 150, down to a floor of 1300', () => {
    const hard = answerCard(reviewCard({ easeFactor: 1400 }), options(), AnkiGrade.Hard, NOW, DAY_BASE);
    assert.equal(hard.card.easeFactor, 1300, 'clamped at the floor');
    assert.equal(hard.card.interval, 7, '6 days * the 1200 hard multiplier');
    assert.equal(hard.card.due, day(7));
    assert.equal(hard.intervalLabel, '7d');

    const easy = answerCard(reviewCard(), options(), AnkiGrade.Easy, NOW, DAY_BASE);
    assert.equal(easy.card.easeFactor, 2650);
    assert.equal(easy.card.interval, 20, '6 * 2.5 * 1.3 = 19.5, rounded to 20');
    assert.equal(easy.card.due, day(20));
});

test('maximumInterval clamps a long review interval', () => {
    const result = answerCard(
        reviewCard({ interval: 100 }),
        options({ maximumInterval: 180 }),
        AnkiGrade.Good,
        NOW,
        DAY_BASE,
    );

    // 100 * 2.5 = 250 days, capped at 180.
    assert.equal(result.card.interval, 180);
    assert.equal(result.card.due, day(180));
    assert.equal(result.intervalLabel, '6mo');
});

test('an early review follows Anki\'s early formula, which leans on elapsed time', () => {
    // Answered 3 days before it is due: the card last left on day -7, so 7 days
    // have elapsed of the 10 it was scheduled for.
    const early = answerCard(
        reviewCard({ interval: 10, easeFactor: 1300, due: day(3) }),
        options(),
        AnkiGrade.Good,
        NOW,
        DAY_BASE,
    );

    // good = max(elapsed * ease, scheduled) = max(9.1, 10) = 10, x the 1000
    // multiplier -> 10 days, and it is flagged as an early answer.
    assert.equal(early.reason, 'early');
    assert.equal(early.card.interval, 10);
    assert.equal(early.card.due, day(10));

    // With an interval multiplier that halves intervals, the same answer gives 5.
    const shortened = answerCard(
        reviewCard({ interval: 10, easeFactor: 1300, due: day(3) }),
        options({ intervalMultiplier: 500 }),
        AnkiGrade.Good,
        NOW,
        DAY_BASE,
    );
    assert.equal(shortened.card.interval, 5);
    assert.equal(shortened.intervalLabel, '5d');

    // Easy halves the bonus of an early answer: 10 * (1.3 - 0.15) = 11.5 -> 12.
    const earlyEasy = answerCard(
        reviewCard({ interval: 10, easeFactor: 1300, due: day(3) }),
        options(),
        AnkiGrade.Easy,
        NOW,
        DAY_BASE,
    );
    assert.equal(earlyEasy.card.interval, 12);

    // An on-time answer with an interval multiplier that halves intervals: good
    // computes to 13 x 0.5 = 7, but hard (10 x 1.2 x 0.5 = 6) has a floor of the
    // card's own interval plus a day (11), so good is lifted past it to 12.
    // That ordering — hard < good < easy — is Anki's, not an artefact.
    const onTime = answerCard(
        reviewCard({ interval: 10, easeFactor: 1300, due: day(0) }),
        options({ intervalMultiplier: 500 }),
        AnkiGrade.Good,
        NOW,
        DAY_BASE,
    );
    assert.equal(onTime.reason, 'review');
    assert.equal(onTime.card.interval, 12);
    const onTimeHard = answerCard(
        reviewCard({ interval: 10, easeFactor: 1300, due: day(0) }),
        options({ intervalMultiplier: 500 }),
        AnkiGrade.Hard,
        NOW,
        DAY_BASE,
    );
    assert.equal(onTimeHard.card.interval, 11, 'hard keeps at least the interval plus a day');
});

test('a lapse multiplies the old interval and counts the lapse', () => {
    const lapsed = answerCard(
        reviewCard({ interval: 20, lapses: 2 }),
        options({ lapseMultiplier: 0 }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );

    assert.equal(lapsed.reason, 'lapse');
    assert.equal(lapsed.card.type, AnkiCardType.Relearning);
    assert.equal(lapsed.card.queue, AnkiCardQueue.Learning);
    assert.equal(lapsed.card.interval, 1, "a 0% new interval starts over at a day");
    assert.equal(lapsed.card.lapses, 3);
    assert.equal(lapsed.card.reviews, 4);
    assert.equal(lapsed.card.due, NOW + 600_000, 'waiting on the 10m relearn step');
    assert.equal(lapsed.intervalLabel, '10m');

    const half = answerCard(
        reviewCard({ interval: 20, lapses: 0 }),
        options({ lapseMultiplier: 500 }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );
    assert.equal(half.card.interval, 10);
    assert.equal(half.card.lapses, 1);

    const floored = answerCard(
        reviewCard({ interval: 20, lapses: 0 }),
        options({ lapseMultiplier: 0, minimumInterval: 3 }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );
    assert.equal(floored.card.interval, 3, 'the deck minimum applies to the new interval');
});

test('a lapse with no relearn step returns the card to review at once', () => {
    const result = answerCard(
        reviewCard({ interval: 20, lapses: 0 }),
        options({ relearningSteps: [], againDelayMinutes: 0, lapseMultiplier: 500 }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );

    assert.equal(result.card.type, AnkiCardType.Review);
    assert.equal(result.card.queue, AnkiCardQueue.Review);
    assert.equal(result.card.interval, 10);
    assert.equal(result.card.due, day(10));
    assert.equal(result.intervalLabel, '10d');
    assert.equal(result.reason, 'lapse');
});

test('the leech threshold suspends the card exactly when it is reached', () => {
    const threshold = 3;

    const under = answerCard(
        reviewCard({ interval: 20, lapses: 1 }),
        options({ leechThreshold: threshold }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );
    assert.equal(under.card.lapses, 2);
    assert.equal(under.leeched, false, 'not a leech below the threshold');
    assert.equal(under.card.queue, AnkiCardQueue.Learning);

    const at = answerCard(
        reviewCard({ interval: 20, lapses: 2 }),
        options({ leechThreshold: threshold }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );
    assert.equal(at.card.lapses, 3);
    assert.equal(at.leeched, true);
    assert.equal(at.card.queue, AnkiCardQueue.Suspended, 'suspended on reaching the threshold');
    assert.equal(at.card.interval, 1, 'still scheduled where it was');
    assert.equal(at.reason, 'lapse');
    assert.equal(at.intervalLabel, '10m');

    const tagOnly = answerCard(
        reviewCard({ interval: 20, lapses: 2 }),
        options({ leechThreshold: threshold, leechAction: LeechAction.TagOnly }),
        AnkiGrade.Again,
        NOW,
        DAY_BASE,
    );
    assert.equal(tagOnly.leeched, true);
    assert.equal(tagOnly.card.queue, AnkiCardQueue.Learning, 'tag-only leaves it scheduled');
});

test('isLeech reads the lapse count and treats a zero threshold as off', () => {
    assert.equal(isLeech(card({ lapses: 3 }), options({ leechThreshold: 3 })), true);
    assert.equal(isLeech(card({ lapses: 2 }), options({ leechThreshold: 3 })), false);
    assert.equal(isLeech(card({ lapses: 99 }), options({ leechThreshold: 0 })), false);
});

test('answering never mutates the card it is given', () => {
    const original = reviewCard({ interval: 20, lapses: 2, due: day(3) });
    const before = JSON.stringify(original);
    for (const grade of [AnkiGrade.Again, AnkiGrade.Hard, AnkiGrade.Good, AnkiGrade.Easy]) {
        answerCard(original, options({ leechThreshold: 3 }), grade, NOW, DAY_BASE);
    }
    assert.equal(JSON.stringify(original), before);
    assert.equal(original.interval, 20);
    assert.equal(original.lapses, 2);
    assert.equal(original.queue, AnkiCardQueue.Review);
});

// ------------------------------------------------------------- labels

test("interval labels follow Anki's own style", () => {
    assert.equal(formatInterval(4 / (24 * 60)), '4m');
    assert.equal(formatInterval(1), '1d');
    assert.equal(formatInterval(3), '3d');
    assert.equal(formatInterval(30), '1mo');
    assert.equal(formatInterval(75), '2.5mo');
    assert.equal(formatInterval(365), '1y');
    assert.equal(formatInterval(500), '1.4y');
    assert.equal(formatInterval(1 / 48), '30m');
    assert.equal(formatInterval(0.5), '12h');
    assert.equal(formatInterval(0), '0s');
});

test('intervalPreview prints the four buttons and leaves the card alone', () => {
    const fresh = newCard(1);
    const freshBefore = JSON.stringify(fresh);
    assert.deepEqual(intervalPreview(fresh, options(), NOW, DAY_BASE), {
        again: '1m',
        hard: '6m',
        good: '10m',
        easy: '4d',
    });
    assert.equal(JSON.stringify(fresh), freshBefore);

    const review = reviewCard();
    const reviewBefore = JSON.stringify(review);
    assert.deepEqual(intervalPreview(review, options(), NOW, DAY_BASE), {
        again: '10m',
        hard: '7d',
        good: '15d',
        easy: '20d',
    });
    assert.equal(JSON.stringify(review), reviewBefore);

    // Graduating from the last step previews the graduating interval.
    const learning = learningCard(600);
    assert.deepEqual(intervalPreview(learning, options(), NOW, DAY_BASE), {
        again: '1m',
        hard: '10m',
        good: '1d',
        easy: '4d',
    });
});

// ------------------------------------------------------------- counts

test('due counts respect the day limits and hide buried and suspended cards', () => {
    const cards = [
        newCard(1, { id: 'new1' }),
        newCard(2, { id: 'new2' }),
        newCard(3, { id: 'new3' }),
        learningCard(300, { id: 'learn1' }),
        card({
            id: 'learnTomorrow',
            type: AnkiCardType.Learning,
            queue: AnkiCardQueue.Learning,
            interval: -600,
            due: NOW + DAY_MS,
        }),
        reviewCard({ id: 'revDue', due: day(-4) }),
        reviewCard({ id: 'revFuture', due: day(6) }),
        reviewCard({ id: 'suspended', queue: AnkiCardQueue.Suspended }),
        newCard(9, { id: 'buried', queue: AnkiCardQueue.SchedBuried }),
    ];

    const counts = dueCounts(cards, options(), NOW, DAY_BASE);
    assert.deepEqual(counts, {
        newCount: 3,
        learningCount: 1,
        reviewCount: 1,
        totalCards: 7,
        dueToday: 5,
    });

    const limited = dueCounts(cards, options({ newPerDay: 1 }), NOW, DAY_BASE);
    assert.equal(limited.newCount, 1, 'newPerDay caps the new cards');
    assert.equal(limited.totalCards, 7, 'while the deck size stays real');
    assert.equal(limited.dueToday, 5, 'and dueToday stays uncapped');

    const overReviews = [
        ...cards.slice(0, 7),
        reviewCard({ id: 'revToday2', due: day(0) }),
        reviewCard({ id: 'revToday3', due: day(-1) }),
    ];
    assert.equal(dueCounts(overReviews, options({ reviewsPerDay: 2 }), NOW, DAY_BASE).reviewCount, 2);
    assert.equal(
        dueCounts(overReviews, options({ reviewsPerDay: 0 }), NOW, DAY_BASE).reviewCount,
        3,
        'a zero review limit means unlimited',
    );

    assert.equal(newCardCountForToday(cards, options({ newPerDay: 1 }), NOW, DAY_BASE), 1);
    assert.equal(newCardCountForToday(cards, options(), NOW, DAY_BASE), 3);
});

// -------------------------------------------------------------- queue

test('the study queue runs learning, then review by due date, then new by position', () => {
    const learn = learningCard(60, { id: 'learn' });
    const dueOld = reviewCard({ id: 'reviewOld', due: day(-4) });
    const dueTodayPositionOne = reviewCard({ id: 'reviewPos1', due: day(0), originalPosition: 1 });
    const dueTodayPositionThree = reviewCard({ id: 'reviewPos3', due: day(0), originalPosition: 3 });
    const second = newCard(2, { id: 'newPos2' });
    const fifth = newCard(5, { id: 'newPos5' });
    const hidden = [
        reviewCard({ id: 'suspended', queue: AnkiCardQueue.Suspended }),
        newCard(1, { id: 'buried', queue: AnkiCardQueue.Buried }),
        reviewCard({ id: 'future', due: day(6) }),
    ];
    const cards = [fifth, dueTodayPositionThree, dueOld, hidden[0], second, hidden[1], dueTodayPositionOne, learn, hidden[2]];

    const queue = buildQueue(cards, options(), NOW, DAY_BASE);
    assert.deepEqual(
        queue.map((c) => c.id),
        ['learn', 'reviewOld', 'reviewPos1', 'reviewPos3', 'newPos2', 'newPos5'],
    );

    const capped = buildQueue(cards, options({ newPerDay: 1, reviewsPerDay: 2 }), NOW, DAY_BASE);
    assert.deepEqual(
        capped.map((c) => c.id),
        ['learn', 'reviewOld', 'reviewPos1', 'newPos2'],
        'learning is never capped, the review limit takes the earliest, new takes the first position',
    );

    assert.deepEqual(
        buildQueue(cards, options(), NOW, DAY_BASE, 3).map((c) => c.id),
        ['learn', 'reviewOld', 'reviewPos1'],
    );
    assert.deepEqual(buildQueue(cards, options(), NOW, DAY_BASE, undefined, 'other-deck'), []);

    assert.deepEqual(
        cards.map((c) => c.id),
        ['newPos5', 'reviewPos3', 'reviewOld', 'suspended', 'newPos2', 'buried', 'reviewPos1', 'learn', 'future'],
        'building the queue does not reorder the input',
    );
});

// ------------------------------------------------------------ burying

test("burying takes today's siblings of the answered note and nothing else", () => {
    const answered = newCard(1, { id: 'answered', noteId: 'note1' });
    const siblingNew = newCard(2, { id: 'sibNew', noteId: 'note1' });
    const siblingReview = reviewCard({ id: 'sibReview', noteId: 'note1' });
    const otherNew = newCard(3, { id: 'otherNew', noteId: 'note2' });
    const otherReview = reviewCard({ id: 'otherReview', noteId: 'note2' });
    const siblingSuspended = reviewCard({
        id: 'sibSuspended',
        noteId: 'note1',
        queue: AnkiCardQueue.Suspended,
    });
    const deck = [answered, siblingNew, siblingReview, otherNew, otherReview, siblingSuspended];
    const endOfToday = DAY_BASE + (TODAY + 1) * DAY_MS;
    const before = { sibNew: siblingNew.due, sibReview: siblingReview.due };

    const buried = burySiblings(
        deck,
        answered,
        options({ buryNewSiblings: true, buryReviewSiblings: true }),
        NOW,
        DAY_BASE,
    );

    assert.deepEqual(buried, ['sibNew', 'sibReview']);
    assert.equal(siblingNew.queue, AnkiCardQueue.SchedBuried);
    assert.equal(siblingReview.queue, AnkiCardQueue.SchedBuried);
    // Burying takes the card out of today's queue; only a card that was due
    // *inside* today has its due date moved to tomorrow (Anki's burying keeps a
    // new card's place in the new queue and a review card's due date).
    assert.equal(siblingNew.due, before.sibNew, 'a new sibling keeps its position');
    assert.equal(siblingReview.due, before.sibReview, 'a review sibling keeps its day');

    // A learning sibling is the case that does move: it cannot be shown again
    // today, so it lands at the start of tomorrow.
    const learningSibling = card({
        id: 'sibLearning',
        noteId: 'note1',
        type: AnkiCardType.Learning,
        queue: AnkiCardQueue.Learning,
        interval: -600,
        due: NOW + 600_000,
    });
    burySiblings([answered, learningSibling], answered, options({ buryNewSiblings: true }), NOW, DAY_BASE);
    assert.equal(learningSibling.queue, AnkiCardQueue.SchedBuried);
    assert.equal(learningSibling.due, endOfToday);
    assert.equal(otherNew.queue, AnkiCardQueue.New, 'another note is left alone');
    assert.equal(otherReview.queue, AnkiCardQueue.Review);
    assert.equal(siblingSuspended.queue, AnkiCardQueue.Suspended, 'already hidden, left hidden');
    assert.equal(answered.queue, AnkiCardQueue.New, 'the answered card is never buried');

    // Only new siblings, when the deck asks for that.
    const fresh = [newCard(2, { id: 's1', noteId: 'note1' }), reviewCard({ id: 'r1', noteId: 'note1' })];
    const newOnly = burySiblings(
        fresh,
        newCard(1, { id: 'a1', noteId: 'note1' }),
        options({ buryNewSiblings: true, buryReviewSiblings: false }),
        NOW,
        DAY_BASE,
    );
    assert.deepEqual(newOnly, ['s1']);
    assert.equal(fresh[1].queue, AnkiCardQueue.Review);

    // And nothing at all when both switches are off.
    const off = [newCard(2, { id: 's2', noteId: 'note1' })];
    assert.deepEqual(
        burySiblings(off, newCard(1, { id: 'a2', noteId: 'note1' }), options({ buryNewSiblings: false }), NOW, DAY_BASE),
        [],
    );
});

// ----------------------------------------------------------------- FSRS

const FSRS_DECK = options({ scheduler: DeckScheduler.Fsrs });
const FSRS = options().fsrs;
const MEMORY = { stability: 10, difficulty: 5, lastReview: NOW - 10 * DAY_MS, scheduledDays: 10 };

function fsrsReviewCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
    return reviewCard({ interval: 10, due: TODAY, memory: MEMORY, ...overrides });
}

test('FSRS: a first Good records memory and schedules a short-term step', () => {
    const result = answerFsrs(newCard(1), FSRS_DECK, AnkiGrade.Good, NOW, FSRS, DAY_BASE);

    assert.equal(result.reason, 'new');
    assert.equal(result.card.type, AnkiCardType.Learning);
    assert.equal(result.card.queue, AnkiCardQueue.Learning);
    assert.equal(result.card.interval, -600, 'a step is still a step: ten minutes');
    assert.equal(result.card.due, NOW + 600_000);
    assert.equal(result.intervalLabel, '10m');
    assert.equal(result.card.reviews, 1);
    assert.equal(result.card.lapses, 0);
    assert.ok(result.card.memory, 'memory is written back');
    assert.equal(result.card.memory.stability, 3.173, 'ts-fsrs 4.7 first Good stability');
    assert.equal(result.card.memory.difficulty, 5.28243442);
    assert.equal(result.card.memory.lastReview, NOW);
    assert.equal(result.card.memory.scheduledDays, 0);
});

test('FSRS: a second Good extends the interval into the review queue', () => {
    const first = answerFsrs(newCard(1), FSRS_DECK, AnkiGrade.Good, NOW, FSRS, DAY_BASE);
    const before = first.card.memory;
    const second = answerFsrs(
        { ...first.card },
        FSRS_DECK,
        AnkiGrade.Good,
        first.card.due,
        FSRS,
        DAY_BASE,
    );

    assert.ok(before);
    assert.equal(second.card.type, AnkiCardType.Review);
    assert.equal(second.card.queue, AnkiCardQueue.Review);
    assert.equal(second.card.interval, 4, '4 days, up from a ten minute step');
    assert.equal(second.card.due, day(4));
    assert.equal(second.intervalLabel, '4d');
    assert.equal(second.card.reviews, 2);
    assert.ok(second.card.memory);
    assert.ok(second.card.memory.stability > before.stability, 'stability grew');
    assert.equal(second.card.memory.stability, 4.46685806);
    assert.equal(second.card.memory.scheduledDays, 4);
    assert.equal(second.card.memory.lastReview, first.card.due);
});

test('FSRS: desiredRetention moves the interval the expected way', () => {
    const short = answerFsrs(
        fsrsReviewCard(),
        FSRS_DECK,
        AnkiGrade.Good,
        NOW,
        { ...FSRS, desiredRetention: 0.95 },
        DAY_BASE,
    );
    const standard = answerFsrs(fsrsReviewCard(), FSRS_DECK, AnkiGrade.Good, NOW, FSRS, DAY_BASE);
    const long = answerFsrs(
        fsrsReviewCard(),
        FSRS_DECK,
        AnkiGrade.Good,
        NOW,
        { ...FSRS, desiredRetention: 0.7 },
        DAY_BASE,
    );

    assert.equal(long.card.interval, 146, 'a 70% target schedules further out');
    assert.equal(standard.card.interval, 33);
    assert.equal(short.card.interval, 15);
    assert.ok(long.card.interval > standard.card.interval);
    assert.ok(standard.card.interval > short.card.interval);
    assert.equal(long.card.due, day(146));
    assert.equal(long.reason, 'review');
});

test("FSRS: the deck's maximumInterval caps the interval", () => {
    const big = fsrsReviewCard({
        interval: 1000,
        memory: { ...MEMORY, stability: 1000, scheduledDays: 1000 },
    });

    const capped = answerFsrs(big, FSRS_DECK, AnkiGrade.Good, NOW, { ...FSRS, maximumInterval: 5 }, DAY_BASE);
    const uncapped = answerFsrs(big, FSRS_DECK, AnkiGrade.Good, NOW, FSRS, DAY_BASE);

    assert.ok(capped.card.interval <= 10, `capped interval was ${capped.card.interval}`);
    assert.ok(uncapped.card.interval > 100, `uncapped interval was ${uncapped.card.interval}`);
    assert.ok(capped.card.interval < uncapped.card.interval);
});

test('FSRS: the deck weights are passed through to the library', () => {
    const weights = [...default_w];
    weights[0] = 1;
    const result = answerFsrs(
        newCard(1),
        FSRS_DECK,
        AnkiGrade.Again,
        NOW,
        { ...FSRS, weights },
        DAY_BASE,
    );

    assert.ok(result.card.memory);
    assert.equal(result.card.memory.stability, 1, 'w[0] is the Again stability');
    assert.equal(result.card.type, AnkiCardType.Learning);
});

test('FSRS: a card with no memory state is a first review, counts intact', () => {
    const stale = reviewCard({ reviews: 7, lapses: 3, due: day(-4) });
    const result = answerFsrs(stale, FSRS_DECK, AnkiGrade.Good, NOW, FSRS, DAY_BASE);

    assert.equal(result.reason, 'new');
    assert.equal(result.card.reviews, 8, 'the card keeps its history');
    assert.equal(result.card.lapses, 3);
    assert.ok(result.card.memory);
    assert.equal(result.card.memory.stability, 3.173, 'scheduled as a first review');
});

test('FSRS: a lapse goes back to relearning and counts itself', () => {
    const result = answerFsrs(fsrsReviewCard(), FSRS_DECK, AnkiGrade.Again, NOW, FSRS, DAY_BASE);

    assert.equal(result.reason, 'lapse');
    assert.equal(result.card.type, AnkiCardType.Relearning);
    assert.equal(result.card.queue, AnkiCardQueue.Learning);
    assert.equal(result.card.lapses, 1);
    assert.equal(result.card.interval, -300, 'ts-fsrs 4.7 relearns after 5 minutes');
    assert.equal(result.card.due, NOW + 300_000);
    assert.equal(result.intervalLabel, '5m');
    assert.ok(result.card.memory && result.card.memory.stability > 0);
});

test('FSRS: previewing a card gives the same labels as answering it', () => {
    const review = fsrsReviewCard();
    const before = JSON.stringify(review);
    const preview = intervalPreview(review, FSRS_DECK, NOW, DAY_BASE);
    const pairs: { key: keyof typeof preview; grade: AnkiGrade }[] = [
        { key: 'again', grade: AnkiGrade.Again },
        { key: 'hard', grade: AnkiGrade.Hard },
        { key: 'good', grade: AnkiGrade.Good },
        { key: 'easy', grade: AnkiGrade.Easy },
    ];

    for (const { key, grade } of pairs) {
        const answer = answerFsrs({ ...review }, FSRS_DECK, grade, NOW, FSRS, DAY_BASE);
        assert.equal(preview[key], answer.intervalLabel, `${key} preview`);
    }
    assert.equal(JSON.stringify(review), before);
});
