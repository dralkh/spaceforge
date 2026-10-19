/**
 * The deck rows that live inside the note list's day sections: the lines they
 * print, the arithmetic under them, and the rows behaving like the rows around
 * them.
 *
 * Two halves, both about the reader rather than the code: the pure helpers are
 * checked the way a reader reads them (a card due today says so, "in 1 day" is
 * singular, zeros are left out), and the view is driven against a fake element
 * tree so mounting it into someone else's container, repainting without
 * stacking, and the keyboard are exercised without a window — the plugin runs
 * on mobile and its tests run in Node.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AnkiCard, AnkiCardQueue, AnkiCardType, DeckCounts } from '../models/anki';
import {
    DEFAULT_MAX_CARDS_PER_DECK,
    DeckDueCard,
    DeckDueGroup,
    DeckRowHandlers,
    DeckRowOptions,
    DeckRowView,
    RestingDeck,
    describeCardState,
    describeDeckCounts,
    relativeDayKey,
    truncateQuestion,
} from '../ui/sidebar/deck-list-renderer';

const DAY = 86_400_000;
/** The day a deck's review day-numbers are counted from, at UTC midnight. */
const DAY_BASE = Date.UTC(2026, 9, 17);
/** Noon on that day, so every fixture sits well inside its own deck-day. */
const NOW = DAY_BASE + 12 * 3600_000;
const DECK_PATH = 'spaceforge/decks/Biology.md';

function counts(partial: Partial<DeckCounts> = {}): DeckCounts {
    return { newCount: 0, learningCount: 0, reviewCount: 0, totalCards: 0, dueToday: 0, ...partial };
}

function card(overrides: Partial<AnkiCard> = {}): AnkiCard {
    return {
        id: 'c1',
        noteId: 'n1',
        deckId: '1759088000000',
        ord: 0,
        type: AnkiCardType.New,
        queue: AnkiCardQueue.New,
        interval: 0,
        easeFactor: 2500,
        reviews: 0,
        lapses: 0,
        due: NOW,
        newPosition: 0,
        flag: 0,
        ...overrides,
    };
}

// ---------------------------------------------------------------- fake element

interface FakeEvent {
    key: string;
    stopped: boolean;
    target: FakeElement | null;
    preventDefault: () => void;
    stopPropagation: () => void;
}

interface FakeOptions {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
    title?: string;
}

/** One fake element: exactly the DOM surface these rows use, and no more. */
class FakeElement {
    readonly tag: string;
    readonly children: FakeElement[] = [];
    readonly classes = new Set<string>();
    readonly attrs: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly listeners: Record<string, Array<(event: FakeEvent) => void>> = {};
    parentElement: FakeElement | null = null;
    textContent = '';

    constructor(tag = 'div') {
        this.tag = tag;
    }

    createEl(tag: string, options?: string | FakeOptions): FakeElement {
        return this.append(new FakeElement(tag), options);
    }

    createDiv(options?: string | FakeOptions): FakeElement {
        return this.append(new FakeElement('div'), options);
    }

    createSpan(options?: string | FakeOptions): FakeElement {
        return this.append(new FakeElement('span'), options);
    }

    private append(el: FakeElement, options?: string | FakeOptions): FakeElement {
        if (typeof options === 'string') {
            el.classes.add(options);
        } else if (options !== undefined) {
            for (const cls of (options.cls ?? '').split(' ')) {
                if (cls.length > 0) el.classes.add(cls);
            }
            if (options.text !== undefined) el.textContent = options.text;
            if (options.attr !== undefined) Object.assign(el.attrs, options.attr);
            if (options.title !== undefined) el.attrs.title = options.title;
        }
        this.children.push(el);
        el.parentElement = this;
        return el;
    }

    empty(): void {
        for (const child of this.children) child.parentElement = null;
        this.children.length = 0;
        this.textContent = '';
    }

    setText(text: string): void {
        this.textContent = text;
    }

    addClass(cls: string): void {
        this.classes.add(cls);
    }

    removeClass(cls: string): void {
        this.classes.delete(cls);
    }

    toggleClass(cls: string, value: boolean): void {
        if (value) this.classes.add(cls);
        else this.classes.delete(cls);
    }

    hasClass(cls: string): boolean {
        return this.classes.has(cls);
    }

    setAttribute(name: string, value: string): void {
        this.attrs[name] = value;
    }

    remove(): void {
        const parent = this.parentElement;
        if (parent !== null) {
            const at = parent.children.indexOf(this);
            if (at >= 0) parent.children.splice(at, 1);
        }
        this.parentElement = null;
    }

    addEventListener(type: string, handler: (event: FakeEvent) => void): void {
        (this.listeners[type] ??= []).push(handler);
    }

    /** Fire one listener group, as a browser would. */
    fire(type: string, overrides: Partial<FakeEvent> = {}): FakeEvent {
        const event: FakeEvent = {
            key: '',
            stopped: false,
            target: this,
            preventDefault: () => undefined,
            stopPropagation: () => { event.stopped = true; },
            ...overrides,
        };
        for (const handler of this.listeners[type] ?? []) handler(event);
        return event;
    }

    find(predicate: (el: FakeElement) => boolean): FakeElement[] {
        const found: FakeElement[] = [];
        for (const child of this.children) {
            if (predicate(child)) found.push(child);
            found.push(...child.find(predicate));
        }
        return found;
    }

    byClass(cls: string): FakeElement[] {
        return this.find(el => el.hasClass(cls));
    }

    /** Every text in the subtree, in document order. */
    texts(): string[] {
        return this.find(() => true).map(el => el.textContent);
    }
}

// ------------------------------------------------------------------- fixtures

interface Recorded {
    studied: string[];
    cards: string[];
    opened: string[];
}

/** The view in a test's terms: it takes fake elements, and nothing else changes. */
interface FakeDayView {
    renderDay(container: FakeElement, groups: DeckDueGroup[], options?: DeckRowOptions): void;
    renderResting(container: FakeElement, decks: RestingDeck[]): void;
    destroy(): void;
}

function makeView(): { view: FakeDayView; recorded: Recorded } {
    const recorded: Recorded = { studied: [], cards: [], opened: [] };
    const handlers: DeckRowHandlers = {
        studyDeck: path => { recorded.studied.push(path); },
        studyCard: (path, cardId) => { recorded.cards.push(`${path}:${cardId}`); },
        openDeck: path => { recorded.opened.push(path); },
    };
    const real = new DeckRowView(null as never, handlers);
    return {
        recorded,
        view: {
            renderDay: (container, groups, options) =>
                real.renderDay(container as unknown as HTMLElement, groups, options),
            renderResting: (container, decks) => real.renderResting(container as unknown as HTMLElement, decks),
            destroy: () => real.destroy(),
        },
    };
}

function group(overrides: Partial<DeckDueGroup> = {}): DeckDueGroup {
    return {
        path: DECK_PATH,
        name: 'Biology',
        cards: [{ cardId: 'c1', front: 'What is the powerhouse of the cell?', state: 'due today' }],
        ...overrides,
    };
}

/** A deck's cards for the day, numbered, so a cap can be counted. */
function dueCards(total: number): DeckDueCard[] {
    return Array.from({ length: total }, (_unused, index) => ({
        cardId: `c${index}`,
        front: `Question ${index}`,
        state: 'due today',
    }));
}

/** The container the note list made for a day, with its note rows already in. */
function notesContainer(notes = 2): FakeElement {
    const container = new FakeElement();
    for (let i = 0; i < notes; i++) container.createDiv({ cls: 'review-note-item', text: `A note ${i}` });
    return container;
}

// ------------------------------------------------------------ counts, in words

test('a deck\'s counts read in Anki\'s own shape', () => {
    assert.equal(
        describeDeckCounts(counts({ newCount: 12, learningCount: 4, reviewCount: 30, totalCards: 46, dueToday: 46 })),
        '12 new · 4 learning · 30 to review'
    );
});

test('a deck\'s zero counts are left out, and an empty-handed deck says nothing', () => {
    assert.equal(describeDeckCounts(counts({ newCount: 1 })), '1 new');
    assert.equal(describeDeckCounts(counts({ learningCount: 2 })), '2 learning');
    assert.equal(describeDeckCounts(counts({ reviewCount: 3 })), '3 to review');
    assert.equal(describeDeckCounts(counts({ newCount: 2, reviewCount: 5 })), '2 new · 5 to review');
    assert.equal(describeDeckCounts(counts({ totalCards: 12 })), '', 'a day header says what is due; a row need not');
    assert.equal(describeDeckCounts(counts()), '');
});

// ------------------------------------------------------------------- the days

test('a day is keyed the way the note list keys its sections', () => {
    assert.equal(relativeDayKey(DAY_BASE, NOW), 'Today');
    assert.equal(relativeDayKey(DAY_BASE + DAY, NOW), 'Tomorrow');
    assert.equal(relativeDayKey(DAY_BASE + 3 * DAY, NOW), 'In 3 days');
    assert.equal(relativeDayKey(DAY_BASE + 40 * DAY, NOW), 'In 40 days');
});

test('the day key crosses midnight, and anything earlier is the overdue pile', () => {
    // One millisecond before midnight: tomorrow is still tomorrow.
    const beforeMidnight = DAY_BASE + DAY - 1;
    assert.equal(relativeDayKey(DAY_BASE + DAY, beforeMidnight), 'Tomorrow');
    // One millisecond after: the very same day is today.
    assert.equal(relativeDayKey(DAY_BASE + DAY, DAY_BASE + DAY), 'Today');
    assert.equal(relativeDayKey(DAY_BASE, DAY_BASE + 5 * DAY), 'Due notes');
    assert.equal(relativeDayKey(DAY_BASE - 9 * DAY, NOW), 'Due notes');
    // A raw timestamp is normalised to its own day, not read as a day number.
    assert.equal(relativeDayKey(DAY_BASE + 9 * 3600_000, NOW), 'Today');
});

// ---------------------------------------------------- card states, in words

test('every queue has its own words', () => {
    assert.equal(describeCardState(card(), DAY_BASE, NOW), 'new');
    assert.equal(
        describeCardState(card({ type: AnkiCardType.Learning, queue: AnkiCardQueue.Learning, interval: -600, due: NOW + 600_000 }), DAY_BASE, NOW),
        'learning'
    );
    // Relearning and day-learning are learning to the reader, whatever the queue value.
    assert.equal(
        describeCardState(card({ type: AnkiCardType.Relearning, queue: AnkiCardQueue.Learning, due: NOW }), DAY_BASE, NOW),
        'learning'
    );
    assert.equal(describeCardState(card({ queue: AnkiCardQueue.DayLearn }), DAY_BASE, NOW), 'learning');
    assert.equal(describeCardState(card({ queue: AnkiCardQueue.Suspended }), DAY_BASE, NOW), 'suspended');
    assert.equal(describeCardState(card({ queue: AnkiCardQueue.UserBuried }), DAY_BASE, NOW), 'buried');
    assert.equal(describeCardState(card({ queue: AnkiCardQueue.SchedBuried }), DAY_BASE, NOW), 'buried');
});

test('a review card\'s state is its day, counted from the deck\'s own day base', () => {
    const review = (due: number): AnkiCard =>
        card({ type: AnkiCardType.Review, queue: AnkiCardQueue.Review, interval: 5, due });

    assert.equal(describeCardState(review(0), DAY_BASE, NOW), 'due today');
    assert.equal(describeCardState(review(-4), DAY_BASE, NOW), 'due today', 'an overdue card is due today too');
    assert.equal(describeCardState(review(1), DAY_BASE, NOW), 'in 1 day', 'one day is singular');
    assert.equal(describeCardState(review(5), DAY_BASE, NOW), 'in 5 days');

    // The boundary: the last moment of the day before, and the first moment of
    // the day itself — the same instant the day key calls "Tomorrow"/"Today".
    assert.equal(describeCardState(review(0), DAY_BASE, DAY_BASE + DAY - 1), 'due today');
    assert.equal(describeCardState(review(1), DAY_BASE, DAY_BASE + DAY - 1), 'in 1 day');
    assert.equal(describeCardState(review(1), DAY_BASE, DAY_BASE + DAY), 'due today');
    assert.equal(describeCardState(review(2), DAY_BASE, DAY_BASE + DAY), 'in 1 day');
});

// -------------------------------------------------------------- the question line

test('a short question is left exactly as it is', () => {
    const text = 'What is the powerhouse of the cell?';
    assert.equal(truncateQuestion(text), text);
    assert.ok(!truncateQuestion(text).endsWith('…'));
});

test('a long question is cut to the limit, with an ellipsis only then', () => {
    const cut = truncateQuestion('x'.repeat(200));
    assert.equal(cut.length, 70);
    assert.ok(cut.endsWith('…'));
    assert.equal(cut.slice(0, -1), 'x'.repeat(69));
    assert.equal(truncateQuestion('x'.repeat(70)), 'x'.repeat(70), 'exactly the limit is not truncated');
    assert.equal(truncateQuestion('x'.repeat(71)).length, 70);
    assert.equal(truncateQuestion('abcdef', 4), 'abc…');
});

test('markup, sound markers and stray whitespace never reach a row', () => {
    assert.equal(truncateQuestion('<div>What is<br>2 + 2?</div>'), 'What is 2 + 2?');
    assert.equal(truncateQuestion('Look  at\n  this\tline'), 'Look at this line');
    assert.equal(truncateQuestion('<img src="nucleus.png"> Which organelle?'), 'Which organelle?');
    assert.equal(truncateQuestion('[sound:click.mp3] Listen'), 'Listen');
});

test('a cut never lands between the halves of a surrogate pair', () => {
    const cut = truncateQuestion('😀'.repeat(60), 70);
    assert.ok(cut.endsWith('…'));
    assert.equal(hasUnpairedSurrogate(cut), false, `split a pair: ${JSON.stringify(cut)}`);
    assert.equal([...cut.slice(0, -1)].length, 34, 'the whole emoji before the ellipsis');
});

/** True when a string holds half of a surrogate pair without its other half. */
function hasUnpairedSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

// ------------------------------------------------------------------- the rows

test('an empty list of decks leaves the note list exactly as it was', () => {
    const container = notesContainer(2);
    const { view } = makeView();
    const before = container.children.length;
    const elementsBefore = container.find(() => true).length;

    view.renderDay(container, []);
    assert.equal(container.children.length, before, 'nothing added for an empty day');
    assert.equal(container.find(() => true).length, elementsBefore, 'and nothing else either');

    // A deck with no cards for the day is not a row: a "0 cards" deck is noise.
    view.renderDay(container, [group({ cards: [] })]);
    assert.equal(container.byClass('sf-deck-day').length, 0);
    assert.equal(container.children.length, before);

    // Painted, then taken away again without leaving an empty container behind.
    view.renderDay(container, [group()]);
    assert.equal(container.byClass('sf-deck-day').length, 1);
    view.renderDay(container, []);
    assert.equal(container.byClass('sf-deck-day').length, 0, 'no empty container is left behind');
    assert.equal(container.children.length, before);
    assert.deepEqual(container.texts(), ['A note 0', 'A note 1'], 'the note rows are untouched');
});

test('repainting a day replaces its deck rows instead of stacking them', () => {
    const container = notesContainer(1);
    const { view } = makeView();
    const decks = [group(), group({ path: 'spaceforge/decks/Chemistry.md', name: 'Chemistry' })];

    view.renderDay(container, decks);
    const firstCount = container.children.length;
    const rows = container.byClass('sf-deck-row').length;
    assert.equal(rows, 2);

    view.renderDay(container, decks);
    assert.equal(container.children.length, firstCount, 'one wrapper, not two');
    assert.equal(container.byClass('sf-deck-row').length, rows, 'and no duplicated rows');
    assert.equal(container.byClass('sf-deck-chevron').length, rows);
    assert.equal(container.byClass('sf-deck-play').length, rows);
    assert.equal(container.byClass('sf-deck-chip').length, rows);

    // The same containers carry the new data on the next paint.
    view.renderDay(container, [group({ cards: dueCards(3) })]);
    assert.equal(container.byClass('sf-deck-row').length, 1);
    assert.equal(container.byClass('sf-deck-chip')[0].textContent, '3 cards');
});

test('a deck row starts its sitting in one click; the chevron is what opens it', () => {
    const container = notesContainer(1);
    const { view, recorded } = makeView();
    view.renderDay(container, [group()]);

    const row = container.byClass('sf-deck-row')[0];
    assert.ok(row);
    assert.equal(row.attrs.role, 'button', 'a row, to the keyboard');
    assert.equal(row.attrs.tabindex, '0', 'reachable with tab');
    assert.equal(container.byClass('sf-deck-question').length, 0, 'closed by default');

    // One click on the row: the deck is asked for, and its sitting starts.
    row.fire('click');
    assert.deepEqual(recorded.studied, [DECK_PATH], 'the row starts the deck');
    assert.equal(container.byClass('sf-deck-question').length, 0, 'without opening it');

    // The chevron opens the folder, and starts nothing.
    const chevron = container.byClass('sf-deck-chevron')[0];
    chevron.fire('click');
    assert.deepEqual(recorded.studied, [DECK_PATH], 'the chevron starts nothing');
    assert.equal(container.byClass('sf-deck-questions')[0].hasClass('sf-hidden'), false);
    assert.equal(container.byClass('sf-deck-question').length, 1);
    assert.equal(row.attrs['aria-expanded'], 'true');
    assert.deepEqual(
        container.byClass('sf-deck-question-text').map(el => el.textContent),
        ['What is the powerhouse of the cell?']
    );
    assert.deepEqual(container.byClass('sf-deck-chip').map(el => el.textContent), ['1 card', 'due today']);

    // The play button starts the sitting too, and must not also toggle.
    const play = container.byClass('sf-deck-play')[0];
    assert.equal(play.attrs['aria-label'], 'Study this deck');
    assert.equal(play.attrs.title, 'Study this deck');
    play.fire('click');
    assert.deepEqual(recorded.studied, [DECK_PATH, DECK_PATH], 'play starts the deck');
    assert.equal(container.byClass('sf-deck-questions')[0].hasClass('sf-hidden'), false, 'and leaves it open');

    // The chevron closes it, and starts nothing.
    chevron.fire('click');
    assert.equal(container.byClass('sf-deck-questions')[0].hasClass('sf-hidden'), true, 'the chevron closes it');
    assert.deepEqual(recorded.studied, [DECK_PATH, DECK_PATH], 'and starts nothing');

    // Opening it again does not build the rows a second time.
    chevron.fire('click');
    assert.equal(container.byClass('sf-deck-question').length, 1);
});

test('keyboard: enter starts a deck, enter on a question opens it', () => {
    const container = notesContainer(1);
    const { view, recorded } = makeView();
    view.renderDay(container, [group()]);

    // Enter and space on the row are the click: the deck's sitting starts.
    const row = container.byClass('sf-deck-row')[0];
    row.fire('keydown', { key: 'Enter' });
    assert.deepEqual(recorded.studied, [DECK_PATH], 'enter starts the deck');
    row.fire('keydown', { key: ' ' });
    assert.deepEqual(recorded.studied, [DECK_PATH, DECK_PATH], 'so does space');

    // The chevron is the way into the folder from the keyboard too.
    container.byClass('sf-deck-chevron')[0].fire('click');
    assert.equal(container.byClass('sf-deck-questions')[0].hasClass('sf-hidden'), false, 'the chevron opens the deck');
    assert.deepEqual(recorded.studied, [DECK_PATH, DECK_PATH], 'and starts nothing');

    const question = container.byClass('sf-deck-question')[0];
    assert.equal(question.attrs.tabindex, '0');
    assert.equal(question.attrs.role, 'button');
    question.fire('keydown', { key: 'Enter' });
    assert.deepEqual(recorded.cards, [`${DECK_PATH}:c1`], 'enter opens that question');
    question.fire('keydown', { key: 'Spacebar' });
    assert.deepEqual(recorded.cards, [`${DECK_PATH}:c1`, `${DECK_PATH}:c1`], 'so does space');
    question.fire('keydown', { key: 'Escape' });
    assert.equal(recorded.cards.length, 2, 'other keys do nothing');

    question.fire('click');
    assert.deepEqual(recorded.cards, [`${DECK_PATH}:c1`, `${DECK_PATH}:c1`, `${DECK_PATH}:c1`]);
});

test('a deck with more cards than the cap is cut off, and says so', () => {
    const container = notesContainer(0);
    const { view } = makeView();

    view.renderDay(container, [group({ cards: dueCards(5) })], { maxCardsPerDeck: 2 });
    container.byClass('sf-deck-chevron')[0].fire('click');
    assert.equal(container.byClass('sf-deck-question').length, 2);
    assert.deepEqual(container.byClass('sf-deck-more').map(el => el.textContent), ['Showing the first 2 of 5 cards.']);
    assert.equal(container.byClass('sf-deck-chip')[0].textContent, '5 cards', 'the chip still counts them all');

    // Under the default cap, a day-sized deck is listed whole and says nothing.
    const roomy = notesContainer(0);
    view.renderDay(roomy, [group({ cards: dueCards(5) })]);
    roomy.byClass('sf-deck-chevron')[0].fire('click');
    assert.equal(roomy.byClass('sf-deck-question').length, 5);
    assert.equal(roomy.byClass('sf-deck-more').length, 0);
    assert.ok(DEFAULT_MAX_CARDS_PER_DECK >= 200, 'a day can hold a lot of cards before the cap bites');
});

test('the reader\'s open decks survive a repaint, and a new container starts closed', () => {
    const container = notesContainer(1);
    const { view } = makeView();
    view.renderDay(container, [group()]);
    container.byClass('sf-deck-chevron')[0].fire('click');

    view.renderDay(container, [group()]);
    assert.equal(container.byClass('sf-deck-questions')[0].hasClass('sf-hidden'), false, 'kept their place');

    const other = notesContainer(1);
    view.renderDay(other, [group()]);
    assert.equal(other.byClass('sf-deck-questions').length, 0, 'a day nobody opened paints no questions');
});

// --------------------------------------------- the decks with nothing due

test('decks with nothing due trail the day on one muted, expandable line', () => {
    const container = notesContainer(1);
    const { view, recorded } = makeView();
    const resting = [
        { path: 'spaceforge/decks/Chemistry.md', name: 'Chemistry', nextDue: 'in 3 days' },
        { path: 'spaceforge/decks/Physics.md', name: 'Physics', nextDue: null },
    ];

    view.renderResting(container, resting);
    const line = container.byClass('sf-deck-resting-line')[0];
    assert.ok(line, 'one line, trailing the day');
    assert.equal(container.byClass('sf-deck-resting-text')[0].textContent, '2 decks with nothing due');
    assert.equal(container.byClass('sf-deck-resting-list')[0].hasClass('sf-hidden'), true, 'collapsed to begin with');

    line.fire('click');
    assert.equal(container.byClass('sf-deck-resting-list')[0].hasClass('sf-hidden'), false);

    // A repaint keeps the line open, and does not stack a second one.
    view.renderResting(container, resting);
    assert.equal(container.byClass('sf-deck-resting').length, 1, 'one line, not two');
    assert.equal(container.byClass('sf-deck-resting-list')[0].hasClass('sf-hidden'), false, 'still open');

    const rows = container.byClass('sf-deck-resting-row');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.byClass('sf-deck-resting-name')[0].textContent), ['Chemistry', 'Physics']);
    assert.equal(rows[0].byClass('sf-deck-chip')[0].textContent, 'in 3 days');
    assert.equal(rows[1].byClass('sf-deck-chip').length, 0, 'a deck with no next date shows no chip');

    rows[0].fire('click');
    assert.deepEqual(recorded.opened, ['spaceforge/decks/Chemistry.md'], 'a resting deck opens its document');
    rows[1].fire('keydown', { key: 'Enter' });
    assert.deepEqual(recorded.opened, ['spaceforge/decks/Chemistry.md', 'spaceforge/decks/Physics.md']);

    container.byClass('sf-deck-resting-line')[0].fire('click');
    assert.equal(container.byClass('sf-deck-resting-list')[0].hasClass('sf-hidden'), true, 'and it folds away again');
});

test('one deck reads singular, and an empty list leaves nothing behind', () => {
    const container = notesContainer(1);
    const { view } = makeView();

    view.renderResting(container, [{ path: DECK_PATH, name: 'Biology', nextDue: 'tomorrow' }]);
    assert.equal(container.byClass('sf-deck-resting-text')[0].textContent, '1 deck with nothing due');

    const before = container.children.length;
    view.renderResting(container, []);
    assert.equal(container.byClass('sf-deck-resting').length, 0, 'no empty line is left behind');
    assert.equal(container.children.length, before - 1);
});

test('destroy takes down everything the view painted', () => {
    const container = notesContainer(1);
    const { view } = makeView();
    view.renderDay(container, [group()]);
    view.renderResting(container, [{ path: DECK_PATH, name: 'Biology', nextDue: null }]);

    view.destroy();
    assert.equal(container.byClass('sf-deck-day').length, 0);
    assert.equal(container.byClass('sf-deck-resting').length, 0);
    assert.deepEqual(container.texts(), ['A note 0'], 'the note rows are the note list\'s, and stay');
});
