/**
 * Spaceforge Study — the sequence, as something the reader handles.
 *
 * The shape this asset was told to stop being: a numbered list with a Move
 * up / Move down pair on every row. Both of its modes are operated now.
 *
 *  - **A deck of cards.** `sequence.shuffle` asks for the steps out of order;
 *    each step is a card — a few words and, at most, a short detail — sitting
 *    in a vertical run of drop positions, and no card carries a number. The
 *    reader picks a card up with the pointer (pointerdown → pointermove →
 *    pointerup), a ghost follows the pointer while an indicator shows where
 *    the card will land, or picks one up with Space and moves it with the
 *    arrows. Check draws its verdict on every card: a coloured edge and a
 *    small glyph, plus the count said out loud. Any move or re-deal clears it.
 *  - **A one-card stepper.** Without `shuffle`, the steps are dealt one at a
 *    time into the same card, with Previous / Next and `Step 2 of 5` — never
 *    a numbered list of everything, which was the complaint.
 *
 * Five decisions are load-bearing:
 *
 *  - **A verdict is never stale.** Checking marks each card and reports
 *    `5 of 6 in place`; moving a card, or shuffling again, clears both, because
 *    a mark that described the previous arrangement is a lie about this one.
 *  - **A shuffle is never the answer.** An order that already reads correctly
 *    teaches nothing, so a seeded shuffle that lands on the true order is
 *    rotated before the reader sees it, and the seed is the asset's own step
 *    ids — nothing here uses `Math.random`.
 *  - **The pointer and the keyboard are one behaviour.** Both routes and the
 *    re-deal go through the same pure `reorder`; the keyboard route is a
 *    public method (`handleKey`) so a test drives the path the app drives,
 *    without a pointer event anywhere near it.
 *  - **A mark is drawn and said.** Each card's verdict is an edge colour and a
 *    glyph; the glyph carries the words ('In place' / 'Out of place') for a
 *    reader who cannot see it, and the count is a live region.
 *  - **Motion is optional.** The drop animation is skipped when the system
 *    asks for reduced motion — the stylesheet's media query and this module's
 *    own check both honour it. No inline styles are assigned: the ghost's
 *    position and the settle shift travel as custom properties.
 */

import { StudySequence, StudySequenceStep } from '../models/study-visuals';

/** The controls, in the reader's words. */
const CHECK_LABEL = 'Check';
const AGAIN_LABEL = 'Shuffle again';
const PREV_LABEL = 'Previous';
const NEXT_LABEL = 'Next';
/** The one line that says how a card is picked up. */
const DRAG_HINT = 'Drag a card, or press Space to pick one up and the arrows to move it.';
/** The two verdicts, as the words a reader hears behind the glyph. */
const IN_PLACE = 'In place';
const OUT_OF_PLACE = 'Out of place';
/** The tag on the line the reader should leave with. */
const PEARL_TAG = 'Pearl';
/** How long a dropped card takes to settle; the stylesheet animates the same span. */
const SETTLE_MS = 200;

// -------------------------------------------------------------- the shuffle

/**
 * The asset's own seed: a stable hash of its step ids.
 *
 * One hash per asset, so the order the reader is handed is a property of the
 * material rather than of the session — no `Math.random`, nothing to save, and
 * the same note reads the same way tomorrow.
 */
export function sequenceSeed(steps: StudySequenceStep[]): number {
    let hash = 2166136261;
    for (const step of steps) {
        for (const character of `${step.id}|`) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
    }
    return hash >>> 0;
}

/** A seeded stream of numbers in [0, 1): the only randomness this file has. */
function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** True while an order still reads as the steps' own order. */
export function isTrueOrder(order: number[]): boolean {
    return order.every((step, index) => step === index);
}

function rotated(order: number[]): number[] {
    return order.length < 2 ? [...order] : [...order.slice(1), order[0]];
}

/**
 * The order the reader is handed: a permutation of the steps' own indices,
 * shuffled from the asset's seed and from which round of shuffling this is.
 *
 * Deterministic, and never the true order — a deck that is already sorted is
 * not an exercise.
 */
export function shuffleOrder(count: number, seed: number, round = 0): number[] {
    const total = Math.max(0, Math.floor(count));
    const order = Array.from({ length: total }, (_unused, index) => index);
    if (total < 2) return order;
    const random = seededRandom((seed + Math.imul(round, 0x9e3779b9)) >>> 0);
    for (let position = total - 1; position > 0; position -= 1) {
        const swap = Math.floor(random() * (position + 1));
        const held = order[position];
        order[position] = order[swap];
        order[swap] = held;
    }
    return isTrueOrder(order) ? rotated(order) : order;
}

/**
 * The next re-deal: round `round` of the asset's own shuffle, guaranteed to
 * differ from the arrangement the reader is looking at — pressing the control
 * does something visible, and it does the same thing every time.
 */
export function nextShuffle(count: number, seed: number, round: number, previous: number[] | null): number[] {
    const order = shuffleOrder(count, seed, round);
    if (!previous || order.length < 2) return order;
    const same = order.length === previous.length && order.every((step, index) => step === previous[index]);
    if (!same) return order;
    const moved = rotated(order);
    return isTrueOrder(moved) ? rotated(moved) : moved;
}

/** `1 of 6 in place` — and never a lie about an empty deck. */
export function inPlaceReport(inPlace: number, total: number): string {
    return `${inPlace} of ${total} in place`;
}

/**
 * The order with one step moved: whatever sits at `from` is lifted out and
 * put back down at `to`, and everything it passed closes the gap behind it.
 *
 * This is the whole of what a drop means, and it is pure: the caller's array
 * is never touched, and a move that names nothing — the same index twice, an
 * index outside the list, a fraction — hands the order back as it was. A copy
 * is returned either way, so a no-op is still something a caller can hold.
 */
export function reorder<T>(items: T[], from: number, to: number): T[] {
    const order = [...items];
    if (!Number.isInteger(from) || !Number.isInteger(to)) return order;
    if (from === to) return order;
    if (from < 0 || from >= order.length || to < 0 || to >= order.length) return order;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    return order;
}

/** True when two orders read the same. */
function sameOrder(left: number[], right: number[]): boolean {
    return left.length === right.length && left.every((step, index) => step === right[index]);
}

/**
 * Where a card dropped at a boundary lands, in the deck's own indices.
 *
 * A pointer drag names the *gap* the indicator sits in — `0` above the first
 * card, `cards.length` below the last — while a move names the index the card
 * ends up at. A gap above the card's own position is one step short, because
 * the card leaves a gap behind it on the way out. The one piece of arithmetic
 * the pointer route adds to `reorder`, kept pure so it is not only ever
 * exercised by a hand on a trackpad.
 */
export function dropIndex(from: number, boundary: number): number {
    return boundary > from ? boundary - 1 : boundary;
}

/** One dealt card: its drop position, the card itself, and its verdict glyph. */
interface StepCard {
    slot: HTMLElement;
    card: HTMLElement;
    glyph: HTMLElement;
}

/**
 * The sequence, mounted into a host of any width.
 *
 * The host is only ever filled: every class, listener and element is this
 * view's own, and a teardown takes all of it — including the cards' own
 * listeners, which are re-bound every time the deck is redrawn.
 */
export class StudyVisualSequenceView {
    private container: HTMLElement | null = null;
    private sequence: StudySequence | null = null;
    private root: HTMLElement | null = null;

    // the shuffled deck
    private seed = 0;
    private order: number[] = [];
    private round = 0;
    private cards: StepCard[] = [];
    private boardEl: HTMLElement | null = null;
    private reportEl: HTMLElement | null = null;
    /** The position of the card the keyboard has lifted, or null. */
    private lifted: number | null = null;
    /** The order the deck read in when that card was picked up, for Escape. */
    private liftedFrom: number[] | null = null;
    private liftedOrigin = 0;
    /** The position a pointer drag began from, while one is running. */
    private pointerFrom: number | null = null;
    /** The drop position the indicator currently names, in boundary terms. */
    private dropAt = 0;
    private ghostEl: HTMLElement | null = null;
    private indicatorEl: HTMLElement | null = null;
    private settleTimer: number | null = null;

    // the one-card stepper
    private current = 0;
    private stepCardEl: HTMLElement | null = null;
    private stepLabelEl: HTMLElement | null = null;
    private stepDetailEl: HTMLElement | null = null;
    private positionEl: HTMLElement | null = null;
    private prevEl: HTMLButtonElement | null = null;
    private nextEl: HTMLButtonElement | null = null;

    private bindings: { el: EventTarget; type: string; handler: EventListener }[] = [];
    private cardBindings: { el: EventTarget; type: string; handler: EventListener }[] = [];
    private dragBindings: { el: EventTarget; type: string; handler: EventListener }[] = [];

    // ------------------------------------------------------------ lifecycle

    /** Render the sequence inside `container` and return its teardown. */
    mount(container: HTMLElement, sequence: StudySequence): () => void {
        this.unmount();
        this.container = container;
        this.sequence = sequence;

        const root = container.createDiv('sf-vsq');
        this.root = root;
        root.setAttribute('data-mode', sequence.shuffle === true ? 'shuffle' : 'ordered');

        if (sequence.teach) root.createDiv({ cls: 'sf-vsq-teach', text: sequence.teach });

        if (sequence.shuffle === true) this.buildDeck(root);
        else this.buildStepper(root);

        if (sequence.pearl) this.renderPearl(root, sequence.pearl);

        return () => this.unmount();
    }

    /** Take everything down: the drag, the timer, the listeners, then the tree. */
    unmount(): void {
        this.finishDrag();
        if (this.settleTimer !== null) {
            window.clearTimeout(this.settleTimer);
            this.settleTimer = null;
        }
        for (const binding of this.bindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.bindings = [];
        // The cards are rebuilt on every move, so their own listeners live here.
        this.releaseCardListeners();
        this.root?.remove();
        this.root = null;
        this.boardEl = null;
        this.reportEl = null;
        this.positionEl = null;
        this.stepCardEl = null;
        this.stepLabelEl = null;
        this.stepDetailEl = null;
        this.prevEl = null;
        this.nextEl = null;
        this.cards = [];
        this.order = [];
        this.round = 0;
        this.current = 0;
        this.seed = 0;
        this.lifted = null;
        this.liftedFrom = null;
        this.liftedOrigin = 0;
        this.container = null;
        this.sequence = null;
    }

    private steps(): StudySequenceStep[] {
        return this.sequence?.steps ?? [];
    }

    private bind(el: EventTarget, type: string, handler: (event: Event) => void): void {
        const listener = handler as EventListener;
        el.addEventListener(type, listener);
        this.bindings.push({ el, type, handler: listener });
    }

    /** Per-card listeners; the cards are rebuilt, so these go with them. */
    private releaseCardListeners(): void {
        for (const binding of this.cardBindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.cardBindings = [];
    }

    private bindCard(el: EventTarget, type: string, handler: (event: Event) => void): void {
        const listener = handler as EventListener;
        el.addEventListener(type, listener);
        this.cardBindings.push({ el, type, handler: listener });
    }

    /** The listeners a running pointer drag added to the window; a drag ends them. */
    private releaseDragListeners(): void {
        for (const binding of this.dragBindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.dragBindings = [];
    }

    private bindDrag(el: EventTarget, type: string, handler: (event: Event) => void): void {
        const listener = handler as EventListener;
        el.addEventListener(type, listener);
        this.dragBindings.push({ el, type, handler: listener });
    }

    // ---------------------------------------------------------- the deck

    private buildDeck(root: HTMLElement): void {
        this.seed = sequenceSeed(this.steps());
        this.round = 0;
        this.order = shuffleOrder(this.steps().length, this.seed, 0);

        const tools = root.createDiv('sf-vsq-tools');
        const check = tools.createEl('button', { cls: 'sf-vsq-check', text: CHECK_LABEL });
        check.setAttribute('type', 'button');
        this.bind(check, 'click', () => this.check());
        const again = tools.createEl('button', { cls: 'sf-vsq-again', text: AGAIN_LABEL });
        again.setAttribute('type', 'button');
        this.bind(again, 'click', () => this.reshuffle());

        root.createDiv({ cls: 'sf-vsq-hint', text: DRAG_HINT });

        const board = root.createDiv('sf-vsq-board');
        board.setAttribute('role', 'list');
        this.boardEl = board;

        const report = root.createDiv('sf-vsq-report');
        report.setAttribute('aria-live', 'polite');
        this.reportEl = report;

        this.renderCards();
    }

    /**
     * Draw the deck as the reader has it arranged: one card per drop position,
     * rebuilt from the order rather than shuffled about in place, so a card's
     * own state (lifted, marked right or wrong) is always the truth about
     * where it now sits.
     */
    private renderCards(): void {
        const board = this.boardEl;
        if (!board) return;
        this.releaseCardListeners();
        board.empty();
        this.cards = [];

        const steps = this.steps();
        this.order.forEach((stepIndex, position) => {
            const step = steps[stepIndex];
            if (!step) return;
            const slot = board.createDiv('sf-vsq-slot');
            slot.setAttribute('role', 'listitem');
            slot.setAttribute('data-slot', String(position));

            const card = slot.createDiv('sf-vsq-card');
            card.setAttribute('data-step-id', step.id);
            card.setAttribute('tabindex', '0');
            card.setAttribute('role', 'button');
            card.setAttribute('aria-pressed', 'false');
            card.createDiv({ cls: 'sf-vsq-card-label', text: step.label });
            if (step.detail) card.createDiv({ cls: 'sf-vsq-card-detail', text: step.detail });
            const glyph = card.createDiv('sf-vsq-card-glyph');

            this.bindCard(card, 'pointerdown', event => this.startDrag(event, position));
            this.bindCard(card, 'keydown', event => {
                if (this.handleKey(event as KeyboardEvent)) event.preventDefault();
            });

            this.cards.push({ slot, card, glyph });
        });

        this.markLifted();
    }

    /** Draw the lifted card as lifted, and every other card as not. */
    private markLifted(): void {
        this.cards.forEach((entry, index) => {
            const on = this.lifted === index;
            entry.card.toggleClass('is-lifted', on);
            entry.card.setAttribute('aria-pressed', String(on));
        });
    }

    private focusCard(position: number): void {
        this.cards[position]?.card.focus();
    }

    // -------------------------------------------------------- the keyboard

    /**
     * The keyboard, exactly as the cards' own listeners hand it over.
     *
     * Public because it *is* the path: a test, or a host without a browser,
     * drives the same method a keydown reaches, so the keyboard route is
     * pinned without a pointer event anywhere. Space (or Enter) picks a card
     * up, the arrows move it, Space puts it down, Escape puts it back; with no
     * card lifted the arrows just walk the focus down the deck.
     */
    handleKey(event: KeyboardEvent): boolean {
        const key = event?.key ?? '';
        if (!key || this.pointerFrom !== null) return false;
        const position = this.cardAt(event.target);

        if (key === ' ' || key === 'Enter') {
            if (this.lifted !== null) {
                this.drop();
                return true;
            }
            if (position === null) return false;
            this.pickUp(position);
            return true;
        }

        if (this.lifted === null) {
            if (position === null) return false;
            if (key === 'ArrowUp' || key === 'ArrowDown') {
                this.focusCard(Math.min(this.cards.length - 1, Math.max(0, position + (key === 'ArrowUp' ? -1 : 1))));
                return true;
            }
            return false;
        }

        if (key === 'ArrowUp') return this.moveLifted(-1);
        if (key === 'ArrowDown') return this.moveLifted(1);
        if (key === 'Escape') return this.putBack();
        return false;
    }

    /** The position of the card a keyboard event was aimed at, or null. */
    private cardAt(target: EventTarget | null): number | null {
        const element = target as HTMLElement | null;
        if (!element) return null;
        const found = typeof element.closest === 'function' ? element.closest('[data-step-id]') : null;
        const node = (found as HTMLElement | null) ?? element;
        const id = typeof node.getAttribute === 'function' ? node.getAttribute('data-step-id') : null;
        const at = this.cards.findIndex(
            entry => entry.card === node || (id !== null && entry.card.getAttribute('data-step-id') === id)
        );
        return at >= 0 ? at : null;
    }

    /** A card is in the reader's hand: it says so, and the reader is on it. */
    private pickUp(position: number): void {
        if (position < 0 || position >= this.cards.length) return;
        this.lifted = position;
        this.liftedOrigin = position;
        this.liftedFrom = [...this.order];
        this.markLifted();
        this.focusCard(position);
    }

    /** Put the card down where it stands; the arrangement is already right. */
    private drop(): void {
        const position = this.lifted;
        this.lifted = null;
        this.liftedFrom = null;
        this.markLifted();
        if (position !== null) this.focusCard(position);
    }

    /** Escape: the lift never happened. */
    private putBack(): boolean {
        const origin = this.liftedOrigin;
        const snapshot = this.liftedFrom;
        this.lifted = null;
        this.liftedFrom = null;
        if (snapshot && !sameOrder(snapshot, this.order)) {
            this.applyOrder(snapshot, origin);
            return true;
        }
        this.markLifted();
        this.focusCard(origin);
        return true;
    }

    /** One arrow step for the lifted card; an end is an end. */
    private moveLifted(delta: number): boolean {
        const from = this.lifted;
        if (from === null) return false;
        const to = Math.min(this.order.length - 1, Math.max(0, from + delta));
        if (to === from) return true;
        this.lifted = to;
        this.applyOrder(reorder(this.order, from, to), to);
        return true;
    }

    // --------------------------------------------------------- the pointer

    /**
     * The pointer takes a card up. The browser's pointer events are the one
     * thing the test harness cannot deliver, so this route is short on
     * purpose: the drop it produces goes through the same `applyOrder` the
     * keyboard uses, and the arithmetic behind it is pure — `dropIndex` and
     * `reorder` — and tested on its own.
     */
    private startDrag(event: Event, position: number): void {
        const pointer = event as PointerEvent;
        if (this.pointerFrom !== null || this.lifted !== null) return;
        if (typeof pointer.button === 'number' && pointer.button !== 0) return;
        const entry = this.cards[position];
        if (!entry) return;
        if (typeof pointer.preventDefault === 'function') pointer.preventDefault();

        this.pointerFrom = position;
        this.dropAt = position;
        entry.card.addClass('is-lifted');
        entry.card.focus();
        this.root?.addClass('is-dragging');

        this.ghostEl = this.buildGhost(this.order[position] ?? -1);
        if (this.boardEl) {
            this.indicatorEl = this.boardEl.createDiv('sf-vsq-indicator');
            this.placeIndicator(position);
        }
        this.moveGhost(pointer);

        this.bindDrag(window, 'pointermove', move => this.duringDrag(move as PointerEvent));
        this.bindDrag(window, 'pointerup', () => this.endDrag());
        this.bindDrag(window, 'pointercancel', () => this.cancelDrag());
    }

    /** The card in the reader's hand, as it travels. */
    private buildGhost(stepIndex: number): HTMLElement | null {
        const step = this.steps()[stepIndex];
        const root = this.root;
        if (!step || !root) return null;
        const ghost = root.createDiv('sf-vsq-ghost');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.createDiv({ cls: 'sf-vsq-card-label', text: step.label });
        if (step.detail) ghost.createDiv({ cls: 'sf-vsq-card-detail', text: step.detail });
        return ghost;
    }

    private moveGhost(pointer: PointerEvent): void {
        const ghost = this.ghostEl;
        if (!ghost) return;
        const x = typeof pointer.clientX === 'number' ? Math.round(pointer.clientX) : 0;
        const y = typeof pointer.clientY === 'number' ? Math.round(pointer.clientY) : 0;
        ghost.setCssProps({ '--sf-vsq-ghost-x': `${x}px`, '--sf-vsq-ghost-y': `${y}px` });
    }

    private duringDrag(pointer: PointerEvent): void {
        if (this.pointerFrom === null) return;
        if (typeof pointer.preventDefault === 'function') pointer.preventDefault();
        this.moveGhost(pointer);
        const boundary = this.boundaryAt(pointer);
        if (boundary === null) return;
        this.dropAt = boundary;
        this.placeIndicator(boundary);
    }

    /**
     * Which drop position the pointer is nearest, in boundary terms: `0` is
     * above the first card, `cards.length` is below the last. Null when
     * nothing on screen can be measured.
     */
    private boundaryAt(pointer: PointerEvent): number | null {
        const y = typeof pointer.clientY === 'number' ? pointer.clientY : null;
        if (y === null) return null;
        let boundary = 0;
        let found = false;
        this.cards.forEach((entry, index) => {
            const slot = entry.slot as unknown as { getBoundingClientRect?: () => { top: number; height: number } };
            if (typeof slot.getBoundingClientRect !== 'function') return;
            const rect = slot.getBoundingClientRect();
            if (!rect) return;
            if (!found && y < rect.top + rect.height / 2) {
                boundary = index;
                found = true;
            }
        });
        return found ? boundary : this.cards.length;
    }

    /** Put the indicator where the card would land. */
    private placeIndicator(boundary: number): void {
        const indicator = this.indicatorEl;
        const board = this.boardEl;
        if (!indicator || !board) return;
        const reference = this.cards[boundary]?.slot ?? null;
        if (reference) board.insertBefore(indicator, reference);
        else board.appendChild(indicator);
    }

    /** The pointer let go: land the card where the indicator said. */
    private endDrag(): void {
        const from = this.pointerFrom;
        if (from === null) return;
        const to = Math.min(this.order.length - 1, Math.max(0, dropIndex(from, this.dropAt)));
        this.finishDrag();
        if (to !== from) this.applyOrder(reorder(this.order, from, to), to);
    }

    /** The pointer ran off; the card stays where it was. */
    private cancelDrag(): void {
        if (this.pointerFrom === null) return;
        this.finishDrag();
    }

    /** Put the surface back as it was: no ghost, no indicator, no window listeners. */
    private finishDrag(): void {
        this.releaseDragListeners();
        const from = this.pointerFrom;
        this.pointerFrom = null;
        this.dropAt = 0;
        if (from !== null) this.cards[from]?.card.removeClass('is-lifted');
        this.ghostEl?.remove();
        this.ghostEl = null;
        this.indicatorEl?.remove();
        this.indicatorEl = null;
        this.root?.removeClass('is-dragging');
    }

    // --------------------------------------------------------- the order

    /**
     * Adopt a new arrangement: clear any verdict, redraw, keep the keyboard
     * where the reader put it, and let the cards slide from where they were.
     */
    private applyOrder(next: number[], focus?: number): void {
        if (sameOrder(next, this.order)) {
            if (focus !== undefined) this.focusCard(focus);
            return;
        }
        const before = this.measureCards();
        this.order = next;
        this.clearVerdict();
        this.renderCards();
        if (focus !== undefined) this.focusCard(focus);
        this.animateSettle(before);
    }

    /** Where every card sat before a redraw, so a change of order can be seen. */
    private measureCards(): Map<string, number> | null {
        const tops = new Map<string, number>();
        for (const entry of this.cards) {
            const node = entry.card as unknown as { getBoundingClientRect?: () => DOMRect };
            if (typeof node.getBoundingClientRect !== 'function') return null;
            const id = entry.card.getAttribute('data-step-id');
            const rect = node.getBoundingClientRect();
            if (!id || !rect) continue;
            tops.set(id, rect.top);
        }
        return tops;
    }

    /**
     * Show the change of order as movement: each card that changed places
     * starts from where it was and slides home. Skipped entirely when the
     * reader has asked for reduced motion.
     */
    private animateSettle(before: Map<string, number> | null): void {
        if (!before || before.size === 0 || this.reducedMotion()) return;
        const moved: HTMLElement[] = [];
        for (const entry of this.cards) {
            const id = entry.card.getAttribute('data-step-id');
            const was = id === null ? undefined : before.get(id);
            if (was === undefined) continue;
            const node = entry.card as unknown as { getBoundingClientRect?: () => DOMRect };
            if (typeof node.getBoundingClientRect !== 'function') continue;
            const shift = Math.round(was - node.getBoundingClientRect().top);
            if (!shift) continue;
            entry.card.setCssProps({ '--sf-vsq-shift': `${shift}px` });
            entry.card.addClass('is-settling');
            moved.push(entry.card);
        }
        if (moved.length === 0) return;
        if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
        this.settleTimer = window.setTimeout(() => {
            this.settleTimer = null;
            for (const card of moved) {
                card.removeClass('is-settling');
                card.setCssProps({ '--sf-vsq-shift': '' });
            }
        }, SETTLE_MS);
    }

    private reducedMotion(): boolean {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        return query ? query.matches === true : false;
    }

    // --------------------------------------------------------- the verdict

    /** Re-deal: the next of the asset's own shuffles, and no leftover verdict. */
    private reshuffle(): void {
        this.round += 1;
        this.applyOrder(nextShuffle(this.order.length, this.seed, this.round, this.order));
    }

    /** Check: every card marked against the true order, and the count said out loud. */
    private check(): void {
        let inPlace = 0;
        this.cards.forEach((entry, position) => {
            const right = this.order[position] === position;
            if (right) inPlace += 1;
            entry.card.toggleClass('is-right', right);
            entry.card.toggleClass('is-wrong', !right);
            this.drawMark(entry, right);
        });
        const total = this.order.length;
        this.reportEl?.setText(inPlaceReport(inPlace, total));
        this.reportEl?.toggleClass('is-complete', total > 0 && inPlace === total);
    }

    /** The mark, drawn: an edge and a glyph for the eye, the words for the ear. */
    private drawMark(entry: StepCard, right: boolean): void {
        const glyph = entry.glyph;
        glyph.empty();
        glyph.setAttribute('role', 'img');
        glyph.setAttribute('aria-label', right ? IN_PLACE : OUT_OF_PLACE);
        const svg = glyph.createSvg('svg', { cls: 'sf-vsq-glyph' });
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        const path = svg.createSvg('path', { cls: right ? 'sf-vsq-glyph-check' : 'sf-vsq-glyph-cross' });
        path.setAttribute('d', right ? 'M3 8.5 L6.5 12 L12.5 4' : 'M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5');
        path.setAttribute('fill', 'none');
    }

    /** A verdict belongs to the arrangement it was taken on, and no other. */
    private clearVerdict(): void {
        for (const entry of this.cards) {
            entry.card.removeClass('is-right');
            entry.card.removeClass('is-wrong');
            entry.glyph.empty();
            entry.glyph.removeAttribute('role');
            entry.glyph.removeAttribute('aria-label');
        }
        this.reportEl?.setText('');
        this.reportEl?.removeClass('is-complete');
    }

    // ------------------------------------------------------- the stepper

    /**
     * The ordered mode: one card at a time, its detail under its label, and a
     * Previous / Next pair that stops at both ends. The whole sequence is
     * never on screen at once — that list was the complaint.
     */
    private buildStepper(root: HTMLElement): void {
        this.current = 0;

        const stage = root.createDiv('sf-vsq-stepper');
        const card = stage.createDiv('sf-vsq-card');
        this.stepCardEl = card;
        this.stepLabelEl = card.createDiv('sf-vsq-card-label');
        this.stepDetailEl = card.createDiv('sf-vsq-card-detail');

        const controls = root.createDiv('sf-vsq-controls');
        const prev = controls.createEl('button', { cls: 'sf-vsq-prev', text: PREV_LABEL });
        prev.setAttribute('type', 'button');
        this.bind(prev, 'click', () => this.step(-1));
        this.prevEl = prev;

        const position = controls.createDiv('sf-vsq-position');
        position.setAttribute('aria-live', 'polite');
        this.positionEl = position;

        const next = controls.createEl('button', { cls: 'sf-vsq-next', text: NEXT_LABEL });
        next.setAttribute('type', 'button');
        this.bind(next, 'click', () => this.step(1));
        this.nextEl = next;

        this.renderStep();
    }

    /** Next / Previous: move one step, and stop at either end. */
    private step(delta: number): void {
        const total = this.steps().length;
        const next = Math.min(total - 1, Math.max(0, this.current + delta));
        if (next === this.current) return;
        this.current = next;
        this.renderStep();
    }

    /** The step on screen: the one card, and how far along the reader is. */
    private renderStep(): void {
        const steps = this.steps();
        const total = steps.length;
        const step = steps[this.current];
        this.stepCardEl?.setAttribute('data-step-id', step?.id ?? '');
        this.stepLabelEl?.setText(step?.label ?? '');
        const detail = step?.detail ?? '';
        this.stepDetailEl?.setText(detail);
        this.stepDetailEl?.toggleClass('sf-vsq-hidden', detail.length === 0);
        if (this.positionEl) this.positionEl.setText(total === 0 ? '' : `Step ${this.current + 1} of ${total}`);
        if (this.prevEl) this.prevEl.disabled = this.current <= 0;
        if (this.nextEl) this.nextEl.disabled = this.current >= total - 1;
    }

    private renderPearl(parent: HTMLElement, pearl: string): void {
        const line = parent.createDiv('sf-vsq-pearl');
        line.createSpan({ cls: 'sf-vsq-pearl-tag', text: PEARL_TAG });
        line.createSpan({ cls: 'sf-vsq-pearl-text', text: pearl });
    }
}
