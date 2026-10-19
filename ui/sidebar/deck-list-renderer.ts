/**
 * The decks, inside the note list: one day's decks, grouped per deck, with the
 * questions each is holding for that day.
 *
 * This is deliberately not a section of its own. The note list owns the day
 * sections ("Due notes", "Today", "Tomorrow", "In N days" — the same strings
 * {@link relativeDayKey} produces) and the rows inside them; this file paints
 * the deck groups for one day *below* the note rows in that day's own container
 * (`<div class="review-notes-container">`), in the note list's own rhythm — the
 * row box, the hover, the chip and the action buttons follow
 * `ui/sidebar/note-item-renderer.ts` — so the day reads as one agenda: these
 * notes, then the cards a deck is holding for the same day. No heading, no
 * wrapper with a title of its own, no second scroll area.
 *
 * Three deliberate choices:
 *
 * - the caller (which owns the vault) assembles the groups; this view only
 *   paints them. `front` and `state` arrive ready — built with
 *   {@link describeCardState} and {@link truncateQuestion} — so a row here and
 *   the card a sitting shows can never disagree;
 * - a deck row starts that deck's sitting in one click, the way a note row
 *   starts that note's review; the chevron (and the hover-only play button,
 *   which does the same thing) are the row's other moves — the chevron opens
 *   the questions, so looking inside a deck is not the same gesture as asking
 *   for it;
 * - `renderDay(container, [])` leaves nothing behind, and repainting a day
 *   repaints rather than appends.
 */

import { setIcon } from 'obsidian';

import type SpaceforgePlugin from '../../main';
import { AnkiCardQueue } from '../../models/anki';
import type { AnkiCard, AnkiId, DeckCounts } from '../../models/anki';
import { DateUtils } from '../../utils/dates';

/** How many cards one deck lists for one day, unless the caller says otherwise. */
export const DEFAULT_MAX_CARDS_PER_DECK = 500;

/** The default question length, in characters, before the ellipsis. */
const QUESTION_LENGTH = 70;

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------- shapes

/** One due card as a row: already resolved, cut and spelled by the caller. */
export interface DeckDueCard {
    cardId: AnkiId;
    /**
     * The question's front, as the sitting shows it: a cloze card blanked, an
     * MCQ asked, media and markup behind {@link truncateQuestion}.
     */
    front: string;
    /** What the card is doing, from {@link describeCardState}. */
    state: string;
}

/** One deck's cards for one day. */
export interface DeckDueGroup {
    /** The deck document's vault path — what a sitting is started from. */
    path: string;
    /** The deck's name, as its frontmatter spells it. */
    name: string;
    cards: DeckDueCard[];
    /** How long this deck's cards are taken to take, ready to print. */
    time?: string;
}

/** What `renderDay` can be told. */
export interface DeckRowOptions {
    /** How many of a deck's cards to list before saying how many there are. */
    maxCardsPerDeck?: number;
}

/** What the view is given by the sidebar: rows in, sittings and files out. */
export interface DeckRowHandlers {
    /** Start a sitting on a whole deck. */
    studyDeck(path: string): void | Promise<void>;
    /** Start a sitting on one deck, opening on this card. */
    studyCard(path: string, cardId: AnkiId): void | Promise<void>;
    /** Open a card's deck document, for editing it. */
    openDeck(path: string): void | Promise<void>;
}

/** A deck that owes nothing, as the resting line lists it. */
export interface RestingDeck {
    path: string;
    name: string;
    /** When it is next wanted, already spelled ("in 3 days"), or null. */
    nextDue: string | null;
}

// ------------------------------------------------------------------- days

/**
 * The section key a day belongs under: the note list's own strings, so a day's
 * decks land in the same section as the notes due on that day. Anything before
 * today is `Due notes`, which is what the note list calls its overdue pile.
 */
export function relativeDayKey(dayStart: number, now: number): string {
    const target = DateUtils.startOfUTCDay(new Date(dayStart));
    const today = DateUtils.startOfUTCDay(new Date(now));
    if (target < today) return 'Due notes';
    const days = Math.round((target - today) / DAY_MS);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return `In ${days} days`;
}

// ------------------------------------------------------------------- counts

/**
 * A deck's counts in Anki's own shape — `12 new · 4 learning · 30 to review` —
 * with the parts that are zero left out. Empty-handed decks read as an empty
 * string: a day's header already says what is due, and a second "nothing due"
 * in every row would be noise.
 */
export function describeDeckCounts(counts: DeckCounts): string {
    const parts: string[] = [];
    if (counts.newCount > 0) parts.push(`${counts.newCount} new`);
    if (counts.learningCount > 0) parts.push(`${counts.learningCount} learning`);
    if (counts.reviewCount > 0) parts.push(`${counts.reviewCount} to review`);
    return parts.join(' · ');
}

// -------------------------------------------------------------------- cards

/**
 * What a card's state chip says, in the browser's own vocabulary:
 *
 * - `new` — never seen, available now;
 * - `learning` — mid-step (learning, relearning, day-learning alike);
 * - `due today` — a review card whose day has come, overdue included (the day
 *   it sits under says whether that day is today or "Due notes");
 * - `in N days` — a review card the sitting will not offer before that day;
 * - `suspended` — the reader put it aside;
 * - `buried` — a sibling of a card answered today, waiting for tomorrow.
 */
export function describeCardState(card: AnkiCard, dayBase: number, now: number): string {
    switch (card.queue) {
        case AnkiCardQueue.Suspended:
            return 'suspended';
        case AnkiCardQueue.SchedBuried:
        case AnkiCardQueue.UserBuried:
            return 'buried';
        case AnkiCardQueue.New:
            return 'new';
        case AnkiCardQueue.Review: {
            const days = card.due - dayNumber(now, dayBase);
            if (days <= 0) return 'due today';
            return `in ${days} day${days === 1 ? '' : 's'}`;
        }
        default:
            // Learning, relearning, day-learning and preview repeats: the card
            // is mid-step, whichever day its next step lands on.
            return 'learning';
    }
}

/** The deck-day number an instant falls in, counted from the deck's day base. */
function dayNumber(at: number, dayBase: number): number {
    return Math.floor((at - dayBase) / DAY_MS);
}

// --------------------------------------------------------------- questions

/** Markup a sidebar row should show as itself rather than as literal tags. */
const MARKUP_TAG_PATTERN = /<\/?(?:br|div|p|span|b|i|u|em|strong|sub|sup|small|font|img|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6])\b[^>]*>/gi;

/**
 * A question as one line of the sidebar: markup and `[sound:…]` markers put
 * away, whitespace flattened, and the whole thing cut to `max` characters with
 * an ellipsis — added only when something was actually cut, and never between
 * the halves of a surrogate pair.
 */
export function truncateQuestion(text: string, max: number = QUESTION_LENGTH): string {
    const flat = text
        .replace(MARKUP_TAG_PATTERN, ' ')
        .replace(/\[sound:[^\]]*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (flat.length <= max) return flat;
    // One character of the budget is spent on the ellipsis itself.
    const keep = Math.max(1, max - 1);
    const cut = isHighSurrogate(flat.charCodeAt(keep - 1)) ? keep - 1 : keep;
    return cut > 0 ? `${flat.slice(0, cut)}…` : '…';
}

/** True for the first half of a surrogate pair (an emoji, a rare glyph). */
function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

// --------------------------------------------------------------------- view

/**
 * The deck rows for the note list's day sections.
 *
 * One instance is enough for a whole sidebar: it tracks what it painted per
 * container, so a repaint replaces its own rows instead of stacking a second
 * copy under the notes, and which decks the reader opened so a repaint keeps
 * their place.
 */
export class DeckRowView {
    private plugin: SpaceforgePlugin;
    private handlers: DeckRowHandlers;

    /** The wrapper painted into each day container, so a repaint can replace it. */
    private days = new Map<HTMLElement, HTMLElement>();
    /** The resting line painted into each container, likewise. */
    private restings = new Map<HTMLElement, HTMLElement>();
    /** Which decks the reader opened, per container. */
    private openDecks = new Map<HTMLElement, Set<string>>();
    /** Which containers have their resting line expanded. */
    private openResting = new Set<HTMLElement>();

    constructor(plugin: SpaceforgePlugin, handlers: DeckRowHandlers) {
        this.plugin = plugin;
        this.handlers = handlers;
    }

    /**
     * Paint one day's deck groups into the container the note list made for
     * that day, below whatever the note rows left there. An empty list removes
     * what an earlier call painted and creates nothing, so a day with no decks
     * leaves the note list exactly as it was.
     */
    renderDay(container: HTMLElement, groups: DeckDueGroup[], options: DeckRowOptions = {}): void {
        const previous = this.days.get(container);
        previous?.remove();
        this.days.delete(container);

        const painted = groups.filter(group => group.cards.length > 0);
        if (painted.length === 0) {
            this.openDecks.delete(container);
            return;
        }

        const open = this.openDecks.get(container) ?? new Set<string>();
        this.openDecks.set(container, open);

        const wrapper = container.createDiv({ cls: 'sf-deck-day' });
        this.days.set(container, wrapper);

        const maxCards = options.maxCardsPerDeck ?? DEFAULT_MAX_CARDS_PER_DECK;
        for (const group of painted) this.renderGroup(wrapper, open, group, maxCards);
    }

    /**
     * The trailing muted line for decks that owe nothing today: one line,
     * expandable into a row per deck. An empty list leaves nothing behind.
     */
    renderResting(container: HTMLElement, decks: RestingDeck[]): void {
        const previous = this.restings.get(container);
        previous?.remove();
        this.restings.delete(container);
        if (decks.length === 0) {
            this.openResting.delete(container);
            return;
        }

        const block = container.createDiv({ cls: 'sf-deck-resting' });
        this.restings.set(container, block);

        let open = this.openResting.has(container);
        const line = block.createDiv({
            cls: 'sf-deck-resting-line',
            attr: { role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false' },
        });
        const chevron = line.createSpan({ cls: 'sf-deck-resting-chevron' });
        setIcon(chevron, open ? 'chevron-down' : 'chevron-right');
        line.createSpan({
            cls: 'sf-deck-resting-text',
            text: `${decks.length} ${decks.length === 1 ? 'deck' : 'decks'} with nothing due`,
        });

        const list = block.createDiv({ cls: 'sf-deck-resting-list' });
        list.toggleClass('sf-hidden', !open);
        for (const deck of decks) {
            const row = list.createDiv({
                cls: 'sf-deck-resting-row',
                attr: { role: 'button', tabindex: '0' },
                title: 'Open the deck document',
            });
            row.createSpan({ cls: 'sf-deck-resting-name', text: deck.name });
            if (deck.nextDue !== null) row.createSpan({ cls: 'sf-deck-chip', text: deck.nextDue });

            const openDeck = (): void => this.start(() => this.handlers.openDeck(deck.path));
            row.addEventListener('click', openDeck);
            row.addEventListener('keydown', event => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                openDeck();
            });
        }

        const toggle = (): void => {
            open = !open;
            if (open) this.openResting.add(container);
            else this.openResting.delete(container);
            line.setAttribute('aria-expanded', open ? 'true' : 'false');
            setIcon(chevron, open ? 'chevron-down' : 'chevron-right');
            list.toggleClass('sf-hidden', !open);
        };
        line.addEventListener('click', toggle);
        line.addEventListener('keydown', event => {
            if (!isActivationKey(event)) return;
            event.preventDefault();
            toggle();
        });
    }

    /** Take down everything painted, and forget what was known about it. */
    destroy(): void {
        for (const wrapper of this.days.values()) wrapper.remove();
        for (const block of this.restings.values()) block.remove();
        this.days.clear();
        this.restings.clear();
        this.openDecks.clear();
        this.openResting.clear();
    }

    // ---------------------------------------------------------------- a deck

    private renderGroup(
        parent: HTMLElement,
        open: Set<string>,
        group: DeckDueGroup,
        maxCards: number,
    ): void {
        const groupEl = parent.createDiv({ cls: 'sf-deck-group' });

        // The row is the deck's own button: one click starts its sitting. The
        // chevron beside it is the way into the questions, and the play button
        // is the same start the row offers, kept for the pointer.
        const isOpen = open.has(group.path);
        const row = groupEl.createDiv({
            cls: 'sf-deck-row',
            attr: {
                role: 'button',
                tabindex: '0',
                'aria-expanded': isOpen ? 'true' : 'false',
                // The row says which deck it is, the way a note row carries its
                // own path: the list's run marker finds the row of the deck the
                // run is standing on by this, not by its name.
                'data-deck-path': group.path,
            },
            title: group.name,
        });
        const title = row.createDiv({ cls: 'sf-deck-title' });
        // The icon lives in a span of its own: setIcon replaces an element's
        // children, so it is called before the name joins the cell. The name is
        // ellipsised at sidebar width, so the full one rides in its own title.
        const lead = title.createSpan({ cls: 'sf-deck-lead' });
        setIcon(lead, 'layers');
        title.createSpan({ cls: 'sf-deck-name', text: group.name, attr: { title: group.name } });

        // The row's own chips: what it owes, and what that is taken to cost.
        const meta = row.createDiv({ cls: 'sf-deck-meta' });
        meta.createSpan({
            cls: 'sf-deck-chip',
            text: `${group.cards.length} ${group.cards.length === 1 ? 'card' : 'cards'}`,
        });
        if (group.time) meta.createSpan({ cls: 'sf-deck-time', text: group.time });

        const actions = row.createDiv({ cls: 'sf-deck-actions' });
        const play = actions.createEl('button', {
            cls: 'sf-deck-play',
            attr: { type: 'button', 'aria-label': 'Study this deck' },
            title: 'Study this deck',
        });
        setIcon(play, 'play');
        play.addEventListener('click', event => {
            // The row under the finger opens the deck; a sitting is a different
            // intent, so it must not also toggle.
            event.stopPropagation();
            this.start(() => this.handlers.studyDeck(group.path));
        });

        const label = `${isOpen ? 'Collapse' : 'Expand'} ${group.name}`;
        const chevron = actions.createEl('button', {
            cls: 'sf-deck-chevron',
            attr: { type: 'button', 'aria-label': label, 'aria-expanded': isOpen ? 'true' : 'false' },
            title: label,
        });
        setIcon(chevron, isOpen ? 'chevron-down' : 'chevron-right');

        // The questions are built the first time the deck is opened, and then
        // shown and hidden: a day can hold a deck of thousands, and the sidebar
        // should not pay for rows nobody asked to see.
        let questions: HTMLElement | null = null;
        const toggle = (): void => {
            const nowOpen = !open.has(group.path);
            if (nowOpen) open.add(group.path);
            else open.delete(group.path);
            row.toggleClass('is-open', nowOpen);
            row.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
            const next = `${nowOpen ? 'Collapse' : 'Expand'} ${group.name}`;
            chevron.setAttribute('aria-label', next);
            chevron.setAttribute('title', next);
            setIcon(chevron, nowOpen ? 'chevron-down' : 'chevron-right');
            if (questions === null) {
                if (!nowOpen) return;
                questions = groupEl.createDiv({ cls: 'sf-deck-questions' });
                this.renderCards(questions, group, maxCards);
            }
            questions.toggleClass('sf-hidden', !nowOpen);
        };

        // One click on the row starts this deck's sitting, the way one click on a
        // note row starts that note's review: the row is the reader asking for
        // the deck. Looking inside a deck is the chevron's job, so the two
        // intents stay apart.
        const study = (): void => this.start(() => this.handlers.studyDeck(group.path));
        row.addEventListener('click', study);
        row.addEventListener('keydown', event => {
            if (!isActivationKey(event)) return;
            event.preventDefault();
            study();
        });
        chevron.addEventListener('click', event => {
            event.stopPropagation();
            toggle();
        });

        if (isOpen) {
            // The reader left it open: paint it open.
            questions = groupEl.createDiv({ cls: 'sf-deck-questions' });
            this.renderCards(questions, group, maxCards);
        }
    }

    /** A deck's questions, in the order the caller gave them, one row each. */
    private renderCards(container: HTMLElement, group: DeckDueGroup, maxCards: number): void {
        const shown = group.cards.slice(0, Math.max(0, maxCards));
        for (const card of shown) {
            const row = container.createDiv({
                cls: 'sf-deck-question',
                attr: { role: 'button', tabindex: '0', title: card.front },
            });
            row.createSpan({ cls: 'sf-deck-question-text', text: card.front });
            row.createSpan({ cls: 'sf-deck-chip', text: card.state });

            const open = (): void => this.start(() => this.handlers.studyCard(group.path, card.cardId));
            row.addEventListener('click', open);
            row.addEventListener('keydown', event => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                open();
            });
        }

        if (group.cards.length > shown.length) {
            container.createDiv({
                cls: 'sf-deck-more',
                text: `Showing the first ${shown.length} of ${group.cards.length} cards.`,
            });
        }
    }

    // ------------------------------------------------------------- plumbing

    /** Start something the handlers own, keeping its promise off the floor. */
    private start(action: () => void | Promise<void>): void {
        void Promise.resolve(action());
    }
}

/** Enter and space are what a row answers to, on every platform. */
function isActivationKey(event: KeyboardEvent): boolean {
    return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}
