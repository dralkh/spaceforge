/**
 * Spaceforge Study — the visual board and the summary.
 *
 * The other two shapes the same material takes, beside the mind map. The board
 * is the forms a discipline actually reasons in, and each one is drawn as the
 * thing it is rather than as another list of prose: a comparison matrix is a
 * table with a header row, a decision is a step with its labelled branches, a
 * cycle is a ring with a direction cue, a sequence is a timeline down a
 * vertical rule. The summary is the condensed version, with its pearls set
 * apart and a toggle that lets the reader condense it further themselves.
 *
 * Four of the board's forms are *played*, which is what makes the surface a
 * gallery of things to work rather than a page of drawings:
 *
 *  - a comparison whose rows carry verdicts is a matching game — the reader
 *    calls each row right or wrong and is answered on the spot (see
 *    `VerdictControl`); a comparison with no verdicts is revealed cell by cell
 *    instead, guess-then-check, and a plain matrix is a reference, readable as
 *    it arrives;
 *  - a process is stepped one step at a time, and a step that branches hands
 *    its branches to the bar as buttons, so the reader *takes* a path: the step
 *    the branch names becomes current and every step the path has touched wears
 *    `is-walked`;
 *  - with a `motion` a flow or a cycle moves on its own — the highlight walks
 *    the steps or travels the ring, one tick at a time, under a Play/Pause
 *    control that says honestly which state it is in — and a reader who steps
 *    it by hand keeps the wheel;
 *  - a timeline is scrubbed: the range and the entries' own markers both land
 *    on the same entry, and the entry's words are read out beside the rule.
 *
 * Every control drives state that lives as a class on the nodes the passive
 * board already drew, so operating an asset never re-renders it and never moves
 * its geometry: the table keeps its own `<td>`s, the ring keeps its angles, and
 * a decision's branches stay where they were drawn while the reader walks past
 * them. A reader whose system asks for reduced motion is never animated at all;
 * the tick is a method as well as a timer, so the motion can be driven by hand
 * anywhere there is no clock to wait on.
 *
 * A comparison row carries a *verdict* as well as cells: a `mark` is drawn as a
 * coloured bar and a compact glyph at the head of the row, because which side
 * wins is read at a glance or not at all — and a cell too long to read at a
 * glance is cut with an ellipsis, keeping the whole of itself in a title.
 *
 * DOM only, with no Obsidian import beyond the element helpers the app extends
 * `HTMLElement` with, so the whole vocabulary renders in the test harness and
 * in the app alike. Everything lives in a host of any width: a table wider
 * than the host scrolls inside its own box instead of pushing the host wider,
 * and text that must be cut says so with a title rather than silently.
 */

import { StudyFlow, StudyFlowStep, StudyMatrix, StudySummary, StudyTimeline, StudyTimelineEntry, StudyVisual } from '../models/study-visuals';

/** The tag that marks the line the reader should leave with. */
const PEARL_TAG = 'Pearl';
/** A step that branches, and a step that ends the process. */
const DECISION_TAG = 'Decision';
const END_TAG = 'End';
/** The condensing control, and what it says when there is nothing to condense. */
const TOGGLE_LABEL = 'Pearls only';
const TOGGLE_EMPTY_TITLE = 'No pearls are marked in this summary';
/** The ring's own direction cue. */
const ARROW_TITLE = 'Steps run clockwise';
/** A verdict a comparison row can carry. */
type RowMark = 'better' | 'worse' | 'equal';
/** What each mark says in words: the glyph is drawn, but never the only thing said. */
const MARK_LABELS: Record<RowMark, string> = { better: 'Better', worse: 'Worse', equal: 'Equal' };
/** The order the verdict buttons are offered in, for every row that has a verdict. */
const MARK_ORDER: RowMark[] = ['better', 'worse', 'equal'];
/**
 * A cell is drawn as a few words.
 *
 * A comparison is read at a glance or it is not read at all, and a cell holding
 * a paragraph turns the row into prose. Past this many characters the drawn
 * text is cut with a visible ellipsis, and the whole of it stays one `title`
 * away (and, on a comparison, one reveal away).
 */
export const CELL_DRAW_LENGTH = 90;
/** What a process's own control says: the move it is offering, and the one it is making. */
const PLAY_LABEL = 'Play';
const PAUSE_LABEL = 'Pause';
/** Why a process is still, when the reader's system has asked for less movement. */
const REDUCED_MOTION_TITLE = 'Your system asks for reduced motion: step it yourself';
/** How long one step of a moving process is given, in ms. */
export const MOTION_INTERVAL_MS = 1100;

/** The reveal toggle's two words: what it will do next, never what it has done. */
const REVEAL_LABEL = 'Reveal all';
const HIDE_LABEL = 'Hide all';
/** The verdict game's own words: what to do, and what the end looks like. */
const GUESS_PROMPT = 'Call the verdict for every row.';
/** What the game's score says when the last verdict is matched. */
export const VERDICT_ALL_TEXT = 'All verdicts matched.';
/** What the stepper counts, and what the scrubber counts. */
const STEP_NOUN = 'Step';
const ENTRY_NOUN = 'Entry';
/** The attribute that marks a card an interactive control belongs to. */
const CONTROL_TAG = 'data-vb-control';
/** The keys a control answers when its card has focus. */
const NEXT_KEY = 'ArrowRight';
const PREVIOUS_KEY = 'ArrowLeft';
/** The keys a button answers on its own, which the reveal control takes over. */
const ACTIVATION_KEYS = ['Enter', ' ', 'Spacebar'];

/** Where the first step of a ring sits, with the steps running clockwise. */
export function ringAngle(index: number, total: number): number {
    const count = Math.max(1, total);
    return Math.round((index / count) * 360) - 90;
}

/**
 * A branch points at a step by id; show the step's own words when we have them,
 * so the branch says where it goes rather than quoting an internal id.
 */
export function branchTargetLabel(steps: StudyFlowStep[], to: string): string {
    return steps.find(step => step.id === to)?.label ?? to;
}

/** '14 bullets · 6 pearls' — the summary's own arithmetic, in the reader's words. */
export function summaryCountLine(summary: StudySummary): string {
    const pearls = summary.bullets.filter(bullet => bullet.emphasis === 'pearl').length;
    return `${plural(summary.bullets.length, 'bullet')} · ${plural(pearls, 'pearl')}`;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What a cell is drawn as: itself, or its first words with a visible ellipsis.
 *
 * The whole cell is never lost — a cut one carries its full text as a `title` —
 * but what is *drawn* stays a few words, because a cell is comparing things, not
 * explaining them. A single unbroken token is cut where it stands; anything with
 * spaces is cut on the last word boundary near the cap, so a cell does not end
 * mid-word.
 */
export function cellText(text: string): string {
    if (text.length <= CELL_DRAW_LENGTH) return text;
    const head = text.slice(0, CELL_DRAW_LENGTH + 1);
    const boundary = head.lastIndexOf(' ');
    const kept = boundary >= CELL_DRAW_LENGTH / 2 ? head.slice(0, boundary) : head.slice(0, CELL_DRAW_LENGTH);
    return `${kept.trimEnd()}…`;
}

/**
 * Whether the reader's system asks for less movement.
 *
 * Read through `matchMedia` and guarded: a host with no `matchMedia` at all
 * (the test harness, a stripped environment) answers "no preference" rather
 * than throwing while a card is being drawn, and anything unexpected in the
 * query is answered the same way. Motion is a nicety; it is never a way for a
 * render to fail.
 */
export function prefersReducedMotion(): boolean {
    try {
        const view = typeof window === 'undefined' ? null : window;
        if (!view || typeof view.matchMedia !== 'function') return false;
        return view.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
        return false;
    }
}

/** The handle a repeating schedule is held by: the host's own timer id. */
export type MotionTimer = number;

/** Where a motion's ticks come from, so a driver without a clock can supply them. */
export interface MotionScheduler {
    /** Run `handler` every `ms`; the handle is how the schedule is let go. */
    every(handler: () => void, ms: number): MotionTimer;
    /** Let go of a schedule: nothing it holds may run again. */
    cancel(handle: MotionTimer): void;
}

/**
 * The host's own repeating timer, or null when it has none.
 *
 * The handle is released with `unref` where the host offers one (Node does, a
 * browser does not): a pending tick must never be the reason a process refuses
 * to exit. A host that cannot schedule at all still gets a motion — it just
 * moves only when it is driven by hand.
 */
function hostMotionScheduler(): MotionScheduler | null {
    const host = typeof window === 'undefined' ? null : window;
    if (!host || typeof host.setInterval !== 'function' || typeof host.clearInterval !== 'function') return null;
    return {
        every: (handler, ms) => {
            const handle = host.setInterval(handler, ms);
            (handle as unknown as { unref?: () => void }).unref?.();
            return handle;
        },
        cancel: handle => host.clearInterval(handle),
    };
}

// -------------------------------------------------------------- interactions

/** A listener the board bound: teardown has to let go of every one. */
interface BoundListener {
    element: HTMLElement;
    type: string;
    handler: EventListener;
}

/**
 * One control's listeners, in one list.
 *
 * Every click, key and input the board answers is bound through its card's bag,
 * so `dispose()` cannot miss one: a handler still bound after teardown answers
 * a control nobody can see, and the leak grows with every mount.
 */
class ListenerBag {
    private bound: BoundListener[] = [];

    on(element: HTMLElement, type: string, handler: EventListener): void {
        element.addEventListener(type, handler);
        this.bound.push({ element, type, handler });
    }

    dispose(): void {
        for (const entry of this.bound) entry.element.removeEventListener(entry.type, entry.handler);
        this.bound.length = 0;
    }
}

/**
 * The interactive control of one card.
 *
 * One per interactive asset, which is what makes the keyboard work without a
 * document-wide listener: the card answers the keys pressed inside it, whoever
 * inside it has focus, and only while the asset is mounted. `handleKey` is the
 * same entry point the card's own listener uses, so a test (or a host without a
 * browser) drives exactly the path the app does.
 */
class CardControl {
    private readonly listeners = new ListenerBag();
    private useKey: ((event: KeyboardEvent) => boolean) | null = null;

    constructor(readonly element: HTMLElement, kind: string) {
        element.setAttribute(CONTROL_TAG, kind);
        this.listeners.on(element, 'keydown', event => {
            if (this.useKey && this.useKey(event as KeyboardEvent)) event.preventDefault();
        });
    }

    /** Bind a listener that teardown must remove. */
    on(element: HTMLElement, type: string, handler: EventListener): void {
        this.listeners.on(element, type, handler);
    }

    /** Put the asset in charge of the card's keys, once it exists. */
    answer(useKey: (event: KeyboardEvent) => boolean): void {
        this.useKey = useKey;
    }

    /** True when the asset used the key. */
    handleKey(event: KeyboardEvent): boolean {
        return this.useKey ? this.useKey(event) : false;
    }

    dispose(): void {
        this.listeners.dispose();
    }
}

/** One cell of a matrix or a comparison: the `<td>`, the button that reveals it, and the text a long cell keeps as a tooltip. */
interface RevealCell {
    cell: HTMLElement;
    button: HTMLElement;
    title: string;
}

/**
 * The reveal control: a comparison's cells covered until the reader asks.
 *
 * The cover is a class on the cell (`is-covered`) and the answer stays in the
 * cell's own text, so revealing is one class away rather than a rebuild: the
 * `<td>`s, their order and their count are the same whether anything is showing
 * or not. The count says how much of it the reader has checked themselves,
 * which is the question the toggle is there to answer.
 */
class RevealControl {
    private readonly toggle: HTMLButtonElement;
    private readonly count: HTMLElement;

    constructor(
        private readonly control: CardControl,
        bar: HTMLElement,
        private readonly cells: RevealCell[],
        covered: boolean
    ) {
        this.toggle = bar.createEl('button', { cls: 'sf-vb-reveal-toggle' });
        this.toggle.setAttribute('type', 'button');
        this.count = bar.createSpan('sf-vb-reveal-count');
        this.count.setAttribute('aria-live', 'polite');

        // Anything still covered: reveal everything. Everything already shown:
        // cover it all. The reader's next intent is the one that is not done yet.
        this.control.on(this.toggle, 'click', () => this.show(!(this.covered() > 0)));
        for (const entry of this.cells) this.control.on(entry.button, 'click', () => this.reveal(entry));

        this.show(covered);
    }

    /**
     * Enter or Space on a cell reveals that one cell, as its own click would.
     *
     * The key is answered here and its default is prevented, so a covered cell
     * is revealed once — by the control, not by the control and the button.
     * The toggle is left out of this on purpose: it is a plain button and its
     * click is the whole of its behaviour.
     */
    handleKey(event: KeyboardEvent): boolean {
        if (!ACTIVATION_KEYS.includes(event.key)) return false;
        const target = event.target as HTMLElement | null;
        const cell = target && typeof target.closest === 'function' ? (target.closest('.sf-vb-cell') as HTMLElement | null) : null;
        const entry = cell ? this.cells.find(candidate => candidate.cell === cell) : undefined;
        if (!entry) return false;
        this.reveal(entry);
        return true;
    }

    /** One cell shown: the reader has checked this one. */
    private reveal(entry: RevealCell): void {
        this.paint(entry, false);
        this.refresh();
    }

    /** Every cell shown, or every cell covered. */
    private show(covered: boolean): void {
        for (const entry of this.cells) this.paint(entry, covered);
        this.refresh();
    }

    /**
     * One cell's state, tooltip and all.
     *
     * A covered cell drops the title a long cell carries: the title is the whole
     * answer, and a tooltip that hands it over on hover would make the cover a
     * decoration rather than a step the reader has to take.
     */
    private paint(entry: RevealCell, covered: boolean): void {
        entry.cell.toggleClass('is-covered', covered);
        if (!covered && entry.title) entry.cell.setAttribute('title', entry.title);
        else entry.cell.removeAttribute('title');
    }

    private covered(): number {
        return this.cells.filter(entry => entry.cell.hasClass('is-covered')).length;
    }

    /** The toggle's word, its state, and the count — all in the reader's words. */
    private refresh(): void {
        const covered = this.covered();
        const total = this.cells.length;
        this.count.setText(`${total - covered} of ${total} shown`);
        this.toggle.setText(covered > 0 ? REVEAL_LABEL : HIDE_LABEL);
        this.toggle.setAttribute('aria-pressed', String(covered === 0));
    }
}

/**
 * The verdict game: a comparison whose rows carry marks becomes a matching
 * game the reader can win.
 *
 * A marked comparison is a set of verdicts — this side better, worse, or
 * level — and reading them off a drawn chip teaches nothing. So the marks are
 * withheld and each row asks the question instead: three buttons, one press,
 * and the answer arrives on the spot. A right call locks the row (the buttons
 * go quiet, the verdict's chip and tone appear, the count moves); a wrong one
 * is refused where it was made and the reader tries again. The count is the
 * whole feedback loop — `2 of 3 verdicts matched`, then `All verdicts
 * matched.` — and it is a live region, because a count that changes is the
 * only thing that needs saying.
 *
 * The row's cells stay readable throughout: the reader is being asked to judge,
 * not to guess, and the evidence is the evidence.
 */
interface GuessedRow {
    row: HTMLElement;
    /** The verdict the asset gave the row: the answer. */
    target: RowMark;
    /** One button per verdict, and the verdict it calls. */
    buttons: { mark: RowMark; button: HTMLButtonElement }[];
    done: boolean;
}

class VerdictControl {
    private readonly rows: GuessedRow[] = [];

    constructor(
        private readonly control: CardControl,
        private readonly card: HTMLElement,
        bar: HTMLElement,
        /** Draws the verdict chip on a row once it is called correctly. */
        private readonly paintMark: (label: HTMLElement, mark: RowMark) => void
    ) {
        bar.createDiv({ cls: 'sf-vb-guess-prompt', text: GUESS_PROMPT });
        this.score = bar.createSpan('sf-vb-guess-score');
        this.score.setAttribute('aria-live', 'polite');
        this.refresh();
    }

    private readonly score: HTMLElement;

    /** Put one row in the game: its buttons, and the verdict they are judged against. */
    watch(row: HTMLElement, label: HTMLElement, target: RowMark, buttons: { mark: RowMark; button: HTMLButtonElement }[]): void {
        const entry: GuessedRow = { row, target, buttons, done: false };
        for (const candidate of buttons) {
            this.control.on(candidate.button, 'click', () => this.guess(entry, candidate.mark, label));
        }
        this.rows.push(entry);
        this.refresh();
    }

    /** One press: right locks the row, wrong is refused in place. */
    private guess(entry: GuessedRow, mark: RowMark, label: HTMLElement): void {
        if (entry.done) return;
        entry.row.removeClass('is-guess-wrong');
        if (mark === entry.target) {
            entry.done = true;
            entry.row.addClass('is-guess-right');
            entry.row.addClass(`is-mark-${entry.target}`);
            entry.row.setAttribute('data-mark', entry.target);
            this.paintMark(label, entry.target);
            for (const candidate of entry.buttons) candidate.button.disabled = true;
        } else {
            entry.row.addClass('is-guess-wrong');
        }
        this.refresh();
    }

    /** The count, and the end of the game: both are states, so nothing moves. */
    private refresh(): void {
        const total = this.rows.length;
        const matched = this.rows.filter(entry => entry.done).length;
        const solved = total > 0 && matched === total;
        this.score.setText(solved ? VERDICT_ALL_TEXT : `${matched} of ${total} verdicts matched`);
        this.score.toggleClass('is-solved', solved);
        this.card.toggleClass('is-solved', solved);
    }
}

/**
 * The stepper: one step at a time, through a process or around a cycle.
 *
 * `marks` is what the card drew for its steps — the numbered items of a flow or
 * the nodes of a ring — and `is-current` on one of them is the whole of the
 * state, so stepping never re-renders a card: a decision's branches stay put
 * and a ring keeps its geometry. The bar carries the current step's own words,
 * because a ring's labels cannot hold a sentence and a dimmed list is no place
 * to read one. Both ends hold rather than wrap, so the reader never loses a
 * step they were reading.
 *
 * A step that branches also hands its branches to the bar as buttons: the
 * reader *takes* a path rather than only reading one, the step it leads to
 * becomes current, and every step the path has touched wears `is-walked`. The
 * buttons go through the same `walk` the arrows use, so taking a branch by hand
 * stops the motion exactly as stepping by hand does.
 */
class StepControl {
    private index = 0;
    /**
     * Called when the *reader* moves the process, and never when the motion
     * does: a reader who takes the wheel keeps it, so the card stops the
     * motion where they left it instead of dragging them on.
     */
    onManual: (() => void) | null = null;
    private readonly report: HTMLElement;
    private readonly nowLabel: HTMLElement;
    private readonly nowDetail: HTMLElement;
    private readonly previous: HTMLButtonElement;
    private readonly next: HTMLButtonElement;
    /** The steps the path has touched, so the way walked stays visible. */
    private readonly visited = new Set<number>([0]);

    constructor(
        private readonly control: CardControl,
        bar: HTMLElement,
        private readonly steps: StudyFlowStep[],
        private readonly marks: HTMLElement[],
        private readonly walked: HTMLElement,
        /** Where the current step's branch buttons go, when it has any. */
        private readonly choices: HTMLElement | null = null
    ) {
        this.previous = bar.createEl('button', { cls: 'sf-vb-step-prev', text: 'Previous' });
        this.previous.setAttribute('type', 'button');
        this.next = bar.createEl('button', { cls: 'sf-vb-step-next', text: 'Next' });
        this.next.setAttribute('type', 'button');
        this.report = bar.createSpan('sf-vb-step-report');
        this.report.setAttribute('aria-live', 'polite');

        const now = bar.createDiv('sf-vb-step-now');
        this.nowLabel = now.createDiv('sf-vb-step-label');
        this.nowDetail = now.createDiv('sf-vb-step-detail');

        this.control.on(this.previous, 'click', () => this.walk(this.index - 1));
        this.control.on(this.next, 'click', () => this.walk(this.index + 1));
        // The list (or the ring) is being walked, which is the rule that dims
        // everything the reader is not on.
        this.walked.addClass('is-stepped');
        this.show(0);
    }

    /**
     * One step on and round to the first at the end.
     *
     * This is how a *motion* moves a process: watched for long enough, the walk
     * comes round again, because the point of the animation is the shape of the
     * movement. The reader's own buttons still hold at the ends, and this is the
     * entry point anything without a timer uses to drive the motion by hand.
     */
    advance(): void {
        if (this.steps.length === 0) return;
        this.show((this.index + 1) % this.steps.length);
    }

    /** Left and right walk the process; the ends hold rather than wrap. */
    handleKey(event: KeyboardEvent): boolean {
        if (event.key === NEXT_KEY) {
            this.walk(this.index + 1);
            return true;
        }
        if (event.key === PREVIOUS_KEY) {
            this.walk(this.index - 1);
            return true;
        }
        return false;
    }

    /**
     * Take a branch by name: the step the branch points at becomes current, and
     * the way there is walked. Answers whether the branch led anywhere — a
     * branch into nothing is a branch the reader cannot take.
     */
    choose(stepId: string): boolean {
        const index = this.steps.findIndex(step => step.id === stepId);
        if (index < 0) return false;
        this.walk(index);
        return true;
    }

    /** The reader's own way through: they ask, and the motion lets go. */
    private walk(index: number): void {
        this.onManual?.();
        this.show(index);
    }

    /** Show one step and only one: it is current, the rest stand back. */
    private show(index: number): void {
        const at = Math.max(0, Math.min(this.steps.length - 1, index));
        const step = this.steps[at];
        if (!step) return;
        this.index = at;
        this.visited.add(at);
        this.marks.forEach((mark, position) => {
            mark.toggleClass('is-current', position === at);
            mark.toggleClass('is-walked', this.visited.has(position) && position !== at);
        });
        this.report.setText(`${STEP_NOUN} ${at + 1} of ${this.steps.length}`);
        this.nowLabel.setText(step.label);
        this.nowDetail.setText(step.detail ?? '');
        this.nowDetail.toggleClass('is-empty', !step.detail);
        this.previous.disabled = at === 0;
        this.next.disabled = at === this.steps.length - 1;
        this.renderChoices(step);
    }

    /**
     * The branches of the current step, as buttons: only the branches that lead
     * somewhere are offered, because a button that cannot be taken is a lie
     * about the process. A step with none leaves the bar as it was.
     */
    private renderChoices(step: StudyFlowStep): void {
        const box = this.choices;
        if (!box) return;
        box.empty();
        const branches = (step.branches ?? []).filter(branch => this.steps.some(candidate => candidate.id === branch.to));
        for (const branch of branches) {
            const button = box.createEl('button', { cls: 'sf-vb-choice', text: branch.label });
            button.setAttribute('type', 'button');
            this.control.on(button, 'click', () => this.choose(branch.to));
        }
    }
}

/**
 * The motion of a process: what moves it on its own, and the control that says
 * whether it is moving.
 *
 * A process that cannot be watched moving is a list, so a flow walks its steps
 * and a cycle travels round its ring — one step per tick, and on round again,
 * because the movement itself is the thing being taught. A `pulse` has no step
 * to move to: the ring's own breath is its motion, and the stylesheet draws it.
 *
 * Three rules make it honest rather than decorative. It moves only while the
 * control says `Pause`, so the reader can always stop it. A reader who steps it
 * by hand stops it (`pause()` is what the stepper calls), so the wheel stays
 * where they took it. And a reader whose system asks for reduced motion is
 * never animated at all: the control is drawn, disabled, saying why — the
 * process is still fully steppable by hand, which is the whole of what was
 * asked for.
 *
 * Nothing here needs the timer to work: `step()` is the tick, and the board
 * exposes the same advance so the motion can be driven by hand.
 */
class MotionControl {
    private playing = false;
    private handle: MotionTimer | null = null;
    /** The steps' own way forward, bound once the stepper exists. */
    private advance: (() => void) | null = null;
    private readonly toggle: HTMLButtonElement;

    constructor(
        private readonly control: CardControl,
        bar: HTMLElement,
        private readonly motion: 'flow' | 'cycle' | 'pulse',
        private readonly reduced: boolean,
        private readonly scheduler: MotionScheduler | null,
        /** The ring that breathes while a pulse plays, when there is one. */
        private readonly breathing: HTMLElement | null
    ) {
        // Built before the stepper's own buttons, so the control that starts the
        // whole process leads the bar it shares with them.
        this.toggle = bar.createEl('button', { cls: 'sf-vb-motion-toggle' });
        this.toggle.setAttribute('type', 'button');
        this.toggle.setAttribute('aria-pressed', 'false');
        if (this.reduced) {
            // Drawn rather than hidden: a control that vanished would read as a
            // missing feature, where this one says why it is not offered.
            this.toggle.disabled = true;
            this.toggle.setAttribute('title', REDUCED_MOTION_TITLE);
        }
        this.control.on(this.toggle, 'click', () => this.toggleRunning());
        this.paint();
    }

    /**
     * Hand the motion the steps it moves through, and start it.
     *
     * A card that carries a motion opens *moving* — that is what the motion is
     * for — unless the reader's system asks for less of it.
     */
    drive(advance: () => void): void {
        this.advance = advance;
        this.play();
    }

    /** True while the process is moving on its own. */
    isPlaying(): boolean {
        return this.playing;
    }

    /** Start it: a repeating tick per step. A no-op for a reader who asked for less. */
    play(): void {
        if (this.reduced || this.playing) return;
        this.playing = true;
        // A pulse is the ring breathing, which the stylesheet animates; there is
        // no step for a tick to move to, so none is scheduled.
        if (this.motion !== 'pulse' && this.advance !== null && this.scheduler) {
            this.handle = this.scheduler.every(() => this.step(), MOTION_INTERVAL_MS);
        }
        this.paint();
    }

    /** Stop it where it is, and let go of the schedule. */
    pause(): void {
        this.release();
        this.playing = false;
        this.paint();
    }

    /** One tick: the highlight moves on, and comes round again at the end. */
    step(): void {
        this.advance?.();
    }

    /** Let go of everything: a teardown must not leave a timer behind it. */
    dispose(): void {
        this.pause();
    }

    private toggleRunning(): void {
        // A disabled control does nothing in a browser and everything in a test
        // that clicks it by hand, so the refusal is made here as well.
        if (this.reduced) return;
        if (this.playing) this.pause();
        else this.play();
    }

    private release(): void {
        if (this.handle !== null && this.scheduler) this.scheduler.cancel(this.handle);
        this.handle = null;
    }

    /** The toggle's word, its state, and the ring's breath — all one truth. */
    private paint(): void {
        this.toggle.setText(this.playing ? PAUSE_LABEL : PLAY_LABEL);
        this.toggle.toggleClass('is-playing', this.playing);
        this.toggle.setAttribute('aria-pressed', String(this.playing));
        this.breathing?.toggleClass('is-pulsing', this.playing);
    }
}

/**
 * The scrubber: a timeline the reader can move through.
 *
 * The range is the control and `is-current` on an entry is the state, so the
 * rule, the markers and every detail stay exactly where they were drawn. A
 * marker is a button, because the time on the rule is also how the reader jumps
 * straight to the entry it names.
 */
class ScrubControl {
    private index = 0;
    private readonly range: HTMLInputElement;
    private readonly report: HTMLElement;
    private readonly nowWhen: HTMLElement;
    private readonly nowLabel: HTMLElement;
    private readonly nowDetail: HTMLElement;

    constructor(
        private readonly control: CardControl,
        bar: HTMLElement,
        private readonly entries: StudyTimelineEntry[],
        private readonly marks: HTMLElement[],
        markers: HTMLElement[]
    ) {
        this.range = bar.createEl('input', { cls: 'sf-vb-scrub-range' });
        this.range.setAttribute('type', 'range');
        this.range.setAttribute('min', '1');
        this.range.setAttribute('max', String(this.entries.length));
        this.range.setAttribute('step', '1');
        this.range.setAttribute('aria-label', 'Move through the timeline');
        this.report = bar.createSpan('sf-vb-scrub-report');
        this.report.setAttribute('aria-live', 'polite');

        const now = bar.createDiv('sf-vb-scrub-now');
        this.nowWhen = now.createSpan('sf-vb-tl-when');
        this.nowLabel = now.createDiv('sf-vb-tl-label');
        this.nowDetail = now.createDiv('sf-vb-tl-detail');

        this.control.on(this.range, 'input', () => this.show(Number(this.range.value) - 1));
        markers.forEach((marker, at) => this.control.on(marker, 'click', () => this.show(at)));
        this.show(0);
    }

    /**
     * Left and right move the marker, and their default is prevented: the
     * browser's own arrow handling for a range would move it a second time.
     */
    handleKey(event: KeyboardEvent): boolean {
        if (event.key === NEXT_KEY) {
            this.show(this.index + 1);
            return true;
        }
        if (event.key === PREVIOUS_KEY) {
            this.show(this.index - 1);
            return true;
        }
        return false;
    }

    /** Land on one entry: it is current, it is the range's value, it is read out. */
    private show(index: number): void {
        const at = Math.max(0, Math.min(this.entries.length - 1, index));
        const entry = this.entries[at];
        if (!entry) return;
        this.index = at;
        this.marks.forEach((mark, position) => mark.toggleClass('is-current', position === at));
        const value = String(at + 1);
        this.range.value = value;
        this.range.setAttribute('value', value);
        this.report.setText(`${ENTRY_NOUN} ${at + 1} of ${this.entries.length}`);
        this.nowWhen.setText(entry.when);
        this.nowLabel.setText(entry.label);
        this.nowDetail.setText(entry.detail ?? '');
        this.nowDetail.toggleClass('is-empty', !entry.detail);
    }
}

/**
 * What a board is drawn *for*: the reader's own preferences, and where its
 * motion keeps time.
 *
 * Both are injectable so the motion can be proven without a browser — a test
 * drives the ticks by hand and says what the reader's system asked for — and so
 * a host that knows better than `window` (a preview, an export) can say so too.
 */
export interface StudyVisualBoardOptions {
    /** Whether the reader asks for reduced motion. Defaults to the system's answer. */
    reducedMotion?: () => boolean;
    /** Where the motion's ticks come from. Defaults to the host's own timer. */
    scheduler?: MotionScheduler;
}

/**
 * The visual board: one card per form, in the order the pack gave them.
 *
 * A view instance is mounted once and torn down by the function `mount`
 * returns: the board owns one element of its own, every listener its controls
 * bound and every motion it started, so taking it down leaves the host exactly
 * as it was found and nothing ticking behind it.
 */
export class StudyVisualBoardView {
    private root: HTMLElement | null = null;
    /** The controls of the board that is mounted: the keyboard's way to them. */
    private controls: CardControl[] = [];
    /** The motions of the board that is mounted: they tick, and they are let go of. */
    private motions: MotionControl[] = [];
    private reducedMotion: () => boolean = prefersReducedMotion;
    private scheduler: MotionScheduler | null = null;

    mount(container: HTMLElement, visuals: StudyVisual[], options: StudyVisualBoardOptions = {}): () => void {
        this.unmount();
        this.reducedMotion = options.reducedMotion ?? prefersReducedMotion;
        this.scheduler = options.scheduler ?? hostMotionScheduler();
        // Nothing to draw is nothing to add: a board that is empty must not
        // leave an empty box in the host for someone to style around.
        if (visuals.length === 0) return () => undefined;
        const root = container.createDiv('sf-vb');
        this.root = root;
        for (const visual of visuals) this.renderVisual(root, visual);
        return () => this.unmount();
    }

    unmount(): void {
        // The motions first: a tick that outlives the board would move a
        // highlight nobody can see, and hold the host open behind it.
        for (const motion of this.motions.splice(0)) motion.dispose();
        for (const control of this.controls.splice(0)) control.dispose();
        this.root?.remove();
        this.root = null;
        this.reducedMotion = prefersReducedMotion;
        this.scheduler = null;
    }

    /**
     * Move every process on the board on by one step, as one of its ticks would.
     *
     * Exposed because the motion has to be provable without a clock: the reader
     * drives it by pressing Play, and anything that has to drive it without a
     * browser (a test, a preview) calls this instead of waiting on wall-clock
     * time. Answers whether there was a process there to move.
     */
    advance(): boolean {
        if (this.motions.length === 0) return false;
        for (const motion of this.motions) motion.step();
        return true;
    }

    /**
     * The keyboard, aimed at the card that holds whatever has focus.
     *
     * Each control binds its own keydown listener, so in the app an arrow key
     * pressed inside a card reaches that card; this is the same entry point by
     * name, for anything that drives the board without a browser.
     */
    handleKey(event: KeyboardEvent): boolean {
        const target = event.target as HTMLElement | null;
        const owner = target && typeof target.closest === 'function' ? (target.closest(`[${CONTROL_TAG}]`) as HTMLElement | null) : null;
        if (!owner) return false;
        const control = this.controls.find(entry => entry.element === owner);
        return control ? control.handleKey(event) : false;
    }

    // ---------------------------------------------------------------- visuals

    /** The control of one card: created here, released with the board. */
    private cardControl(card: HTMLElement, kind: string): CardControl {
        const control = new CardControl(card, kind);
        this.controls.push(control);
        return control;
    }

    private renderVisual(root: HTMLElement, visual: StudyVisual): void {
        const card = root.createDiv('sf-vb-visual');
        card.setAttribute('data-kind', visual.kind);
        card.createDiv({ cls: 'sf-vb-title', text: visual.title });

        switch (visual.kind) {
            case 'timeline':
                this.renderTimeline(card, visual);
                break;
            case 'cycle':
                this.renderCycle(card, visual);
                break;
            case 'flow':
                this.renderFlow(card, visual);
                break;
            case 'matrix':
            case 'compare':
                this.renderMatrix(card, visual);
                break;
            default:
                // lab, diagram, sequence, graph: the interactive assets belong to
                // the gallery's own renderers, and this board says so by drawing
                // nothing rather than by drawing the wrong thing.
                return;
        }

        if (visual.pearl) this.renderPearl(card, visual.pearl);
    }

    /** The one line the reader should leave with, marked as such. */
    private renderPearl(parent: HTMLElement, pearl: string): void {
        const line = parent.createDiv('sf-vb-pearl');
        line.createSpan({ cls: 'sf-vb-pearl-tag', text: PEARL_TAG });
        line.createSpan({ cls: 'sf-vb-pearl-text', text: pearl });
    }

    // ------------------------------------------------------------ matrix/compare

    /**
     * A comparison is a table, because that is what it is: columns are the
     * dimensions, each row is a thing, and the row that is the point of the
     * comparison carries an accent edge. The table scrolls inside its own box,
     * so a matrix wider than the sidebar never pushes the host wider.
     *
     * A row that carries a *verdict* turns the table into a game — see
     * `renderVerdictTable` — because a verdict is worth earning rather than
     * reading. A table with no verdicts is the reader's own check instead: a
     * comparison arrives covered (`is-covered` on the `<td>`, the answer still
     * its own text), a plain matrix arrives readable — a matrix is a reference
     * — and either way one toggle reveals or covers the lot with the count
     * saying how much shows.
     */
    private renderMatrix(parent: HTMLElement, matrix: StudyMatrix): void {
        if (matrix.rows.some(row => row.mark !== undefined)) {
            this.renderVerdictTable(parent, matrix);
            return;
        }
        const control = this.cardControl(parent, 'reveal');
        const bar = parent.createDiv('sf-vb-reveal-bar');
        const cells: RevealCell[] = [];

        const scroller = parent.createDiv('sf-vb-table-scroll');
        const table = scroller.createEl('table', { cls: 'sf-vb-table' });

        const head = table.createEl('thead', { cls: 'sf-vb-table-head' });
        const headRow = head.createEl('tr');
        const corner = headRow.createEl('th', { cls: 'sf-vb-th sf-vb-th-label' });
        corner.setAttribute('scope', 'col');
        for (const column of matrix.columns) {
            const th = headRow.createEl('th', { cls: 'sf-vb-th', text: column });
            th.setAttribute('scope', 'col');
        }

        const body = table.createEl('tbody', { cls: 'sf-vb-table-body' });
        for (const row of matrix.rows) {
            const tr = body.createEl('tr', { cls: 'sf-vb-row' });
            if (row.emphasis === true) {
                tr.addClass('is-emphasis');
                tr.setAttribute('data-emphasis', 'true');
            }
            if (row.mark) {
                // The verdict is a state of the row, so it is a class on the row:
                // the stylesheet draws the bar and the glyph from these, and the
                // row is readable as a comparison before a word of it is read.
                tr.addClass(`is-mark-${row.mark}`);
                tr.setAttribute('data-mark', row.mark);
            }
            const label = tr.createEl('th', { cls: 'sf-vb-row-label', text: row.label });
            label.setAttribute('scope', 'row');
            if (row.mark) this.renderMark(label, row.mark);
            for (const cell of row.cells) {
                const td = tr.createEl('td', { cls: 'sf-vb-cell' });
                // A cell is drawn as a few words: past the cap it is cut with a
                // visible ellipsis, and the whole of it becomes the cell's title
                // — so a cell can be read in full without becoming a paragraph
                // in the table. The `<td>` is the same `<td>` either way.
                const drawn = cellText(cell);
                const cut = drawn !== cell;
                if (cut) td.setAttribute('title', cell);
                // The cell's own button: a `<td>` cannot be a control without
                // costing the table its table semantics, and the answer has to
                // stay somewhere the reader can be shown it again.
                const button = td.createEl('button', { cls: 'sf-vb-reveal' });
                button.setAttribute('type', 'button');
                button.createSpan({ cls: 'sf-vb-reveal-text', text: drawn });
                // A cell that must be cut to be drawn says so with a title; the
                // control keeps that title only while the cell is not covered.
                cells.push({ cell: td, button, title: cut ? cell : '' });
            }
        }

        const reveal = new RevealControl(control, bar, cells, matrix.kind === 'compare');
        control.answer(event => reveal.handleKey(event));
    }

    /**
     * The same table, played instead of read: every row that carries a verdict
     * asks for it.
     *
     * The table is drawn exactly as before — a header row, a row per thing, the
     * cells readable — and each marked row carries a group of three verdict
     * buttons: better, worse, equal. One press answers, on the spot: a right
     * call locks the row and draws its chip, a wrong one refuses in place and
     * the reader tries again. The score is the whole feedback loop.
     */
    private renderVerdictTable(parent: HTMLElement, matrix: StudyMatrix): void {
        const control = this.cardControl(parent, 'verdict');
        const bar = parent.createDiv('sf-vb-guess-bar');
        const game = new VerdictControl(control, parent, bar, (label, mark) => this.renderMark(label, mark));

        const scroller = parent.createDiv('sf-vb-table-scroll');
        const table = scroller.createEl('table', { cls: 'sf-vb-table' });

        const head = table.createEl('thead', { cls: 'sf-vb-table-head' });
        const headRow = head.createEl('tr');
        const corner = headRow.createEl('th', { cls: 'sf-vb-th sf-vb-th-label' });
        corner.setAttribute('scope', 'col');
        for (const column of matrix.columns) {
            const th = headRow.createEl('th', { cls: 'sf-vb-th', text: column });
            th.setAttribute('scope', 'col');
        }

        const body = table.createEl('tbody', { cls: 'sf-vb-table-body' });
        for (const row of matrix.rows) {
            const tr = body.createEl('tr', { cls: 'sf-vb-row' });
            if (row.emphasis === true) {
                tr.addClass('is-emphasis');
                tr.setAttribute('data-emphasis', 'true');
            }
            const label = tr.createEl('th', { cls: 'sf-vb-row-label', text: row.label });
            label.setAttribute('scope', 'row');
            for (const cell of row.cells) {
                const td = tr.createEl('td', { cls: 'sf-vb-cell' });
                const drawn = cellText(cell);
                if (drawn !== cell) td.setAttribute('title', cell);
                td.createSpan({ cls: 'sf-vb-cell-text', text: drawn });
            }
            if (row.mark) {
                const guess = label.createDiv('sf-vb-guess');
                guess.setAttribute('role', 'group');
                guess.setAttribute('aria-label', `Verdict for ${row.label}`);
                const buttons = MARK_ORDER.map(mark => {
                    const button = guess.createEl('button', { cls: 'sf-vb-guess-btn', text: MARK_LABELS[mark] });
                    button.setAttribute('type', 'button');
                    return { mark, button };
                });
                game.watch(tr, label, row.mark, buttons);
            }
        }
    }

    // ------------------------------------------------------------------- flow

    /**
     * Numbered steps in order, with decisions branching and outcomes ending.
     *
     * The stepper walks them: `is-current` marks the one the reader is on, the
     * list dims the rest, and the bar carries the step's own words for a reader
     * who is stepping rather than reading. Nothing is hidden to do it — a
     * decision keeps its branches and its detail wherever the reader is.
     *
     * With a `motion` the walk happens by itself: the highlight advances one
     * step per tick under the bar's own Play/Pause control, and a reader who
     * steps it by hand takes the motion's place at the wheel. `teach` says what
     * to watch for, because movement without a point is decoration.
     */
    private renderFlow(parent: HTMLElement, flow: StudyFlow): void {
        const control = this.cardControl(parent, 'step');
        if (flow.teach) parent.createDiv({ cls: 'sf-vb-teach', text: flow.teach });
        const bar = parent.createDiv('sf-vb-stepper');
        const list = parent.createEl('ol', { cls: 'sf-vb-steps' });
        const marks: HTMLElement[] = [];
        flow.steps.forEach((step, index) => {
            const item = list.createEl('li', { cls: 'sf-vb-step' });
            const kind = step.kind ?? 'step';
            item.setAttribute('data-kind', kind);
            if (kind === 'decision') item.addClass('is-decision');
            if (kind === 'outcome') item.addClass('is-outcome');

            item.createSpan({ cls: 'sf-vb-step-num', text: String(index + 1) });
            const main = item.createDiv('sf-vb-step-main');
            main.createDiv({ cls: 'sf-vb-step-label', text: step.label });
            if (step.detail) main.createDiv({ cls: 'sf-vb-step-detail', text: step.detail });
            if (kind === 'decision') main.createSpan({ cls: 'sf-vb-step-kind', text: DECISION_TAG });
            if (kind === 'outcome') main.createSpan({ cls: 'sf-vb-step-end', text: END_TAG });
            this.renderBranches(main, flow.steps, step);
            marks.push(item);
        });

        // The motion's control is built first, so it leads the bar it shares
        // with the stepper's buttons; it is given the steps once they exist.
        const motion = this.mountMotion(control, bar, flow, null);
        // A decision's branches become buttons in the same bar, after the
        // control that plays the process and before its own report.
        const choices = bar.createDiv('sf-vb-choices');
        const stepper = new StepControl(control, bar, flow.steps, marks, list, choices);
        stepper.onManual = () => motion?.pause();
        motion?.drive(() => stepper.advance());
        control.answer(event => stepper.handleKey(event));
    }

    // ------------------------------------------------------------------ cycle

    /**
     * A cycle is a ring: the steps sit around it in order and an arrow says
     * which way they run. Nothing is lost to the drawing — a step that branches
     * or carries a detail says so beneath the ring, in words — and the stepper
     * walks the ring itself, so `is-current` lands on the node the reader is on.
     *
     * With a `motion` the highlight travels the ring on its own: `cycle` walks
     * the nodes one per tick, `pulse` breathes the ring instead, and either way
     * the drawing's geometry never moves — only the class that says who is
     * current does, so a travelling highlight is a travelling class.
     */
    private renderCycle(parent: HTMLElement, cycle: StudyFlow): void {
        const control = this.cardControl(parent, 'step');
        if (cycle.teach) parent.createDiv({ cls: 'sf-vb-teach', text: cycle.teach });
        const bar = parent.createDiv('sf-vb-stepper');
        const ring = parent.createDiv('sf-vb-ring');
        ring.createDiv('sf-vb-ring-track');
        const marks: HTMLElement[] = [];
        cycle.steps.forEach((step, index) => {
            const node = ring.createDiv('sf-vb-ring-step');
            node.setAttribute('data-kind', step.kind ?? 'step');
            node.setCssProps({ '--sf-vb-angle': `${ringAngle(index, cycle.steps.length)}deg` });
            node.createSpan({ cls: 'sf-vb-ring-num', text: String(index + 1) });
            node.createSpan({ cls: 'sf-vb-ring-label', text: step.label });
            marks.push(node);
        });
        const arrow = ring.createSpan('sf-vb-ring-arrow');
        arrow.setAttribute('title', ARROW_TITLE);

        const noted = cycle.steps
            .map((step, index) => ({ step, index }))
            .filter(entry => (entry.step.branches?.length ?? 0) > 0 || entry.step.detail !== undefined);
        if (noted.length > 0) {
            const notes = parent.createDiv('sf-vb-cycle-notes');
            for (const entry of noted) {
                const note = notes.createDiv('sf-vb-cycle-note');
                note.createDiv({ cls: 'sf-vb-cycle-note-from', text: `${entry.index + 1} · ${entry.step.label}` });
                if (entry.step.detail) note.createDiv({ cls: 'sf-vb-step-detail', text: entry.step.detail });
                this.renderBranches(note, cycle.steps, entry.step);
            }
        }

        // The ring is the thing that breathes, so the motion is given it; the
        // control still leads the bar, built before the stepper's own buttons.
        const motion = this.mountMotion(control, bar, cycle, ring);
        const stepper = new StepControl(control, bar, cycle.steps, marks, ring);
        stepper.onManual = () => motion?.pause();
        motion?.drive(() => stepper.advance());
        control.answer(event => stepper.handleKey(event));
    }

    /**
     * The verdict of one row, drawn: a bar and a glyph at the head of the row's
     * name, with the word kept where a glyph cannot say it (`title`, and the
     * accessible name, so the mark is never a colour alone).
     *
     * The glyph itself comes from the stylesheet — a row's mark is a mark, not
     * content — while the announced word travels with the chip, so a reader who
     * cannot see the colour still hears `Better`.
     */
    private renderMark(label: HTMLElement, mark: RowMark): void {
        const chip = label.createSpan({ cls: 'sf-vb-mark' });
        chip.setAttribute('aria-label', MARK_LABELS[mark]);
        chip.setAttribute('title', MARK_LABELS[mark]);
        // The mark leads the name: it is the first thing the row says.
        label.prepend(chip);
    }

    /**
     * The motion of a process, when it has one, and nothing when it does not.
     *
     * `motion` is what makes a process *move* on its own — a flow that walks, a
     * cycle that travels, a ring that breathes — and its absence is a process
     * the reader steps themselves. Either way the control exists only where the
     * material asked for motion, so a card never carries a dead Play button.
     */
    private mountMotion(control: CardControl, bar: HTMLElement, flow: StudyFlow, breathing: HTMLElement | null): MotionControl | null {
        const motion = flow.motion;
        if (motion !== 'flow' && motion !== 'cycle' && motion !== 'pulse') return null;
        const mounted = new MotionControl(control, bar, motion, this.reducedMotion(), this.scheduler, breathing);
        this.motions.push(mounted);
        return mounted;
    }

    /** A decision's branches: the label it carries and the step it goes to. */
    private renderBranches(parent: HTMLElement, steps: StudyFlowStep[], step: StudyFlowStep): void {
        const branches = step.branches ?? [];
        if (branches.length === 0) return;
        const box = parent.createDiv('sf-vb-branches');
        for (const branch of branches) {
            const row = box.createDiv('sf-vb-branch');
            row.createSpan({ cls: 'sf-vb-branch-label', text: branch.label });
            row.createSpan({ cls: 'sf-vb-branch-to', text: branchTargetLabel(steps, branch.to) });
        }
    }

    // --------------------------------------------------------------- timeline

    /**
     * Entries in order down a vertical rule, the time as the marker.
     *
     * The scrubber moves along them: `is-current` on the entry is the state, the
     * range and the entry's own marker both land there, and what the entry has
     * to say is read out above the rule as well as beside it.
     */
    private renderTimeline(parent: HTMLElement, timeline: StudyTimeline): void {
        const control = this.cardControl(parent, 'scrub');
        const bar = parent.createDiv('sf-vb-scrub');
        const list = parent.createEl('ol', { cls: 'sf-vb-timeline' });
        const marks: HTMLElement[] = [];
        const markers: HTMLElement[] = [];
        for (const entry of timeline.entries) {
            const item = list.createEl('li', { cls: 'sf-vb-tl-entry' });
            // The time is the control as well as the caption: pressing it takes
            // the reader straight to that entry.
            const marker = item.createEl('button', { cls: 'sf-vb-tl-marker' });
            marker.setAttribute('type', 'button');
            marker.createSpan({ cls: 'sf-vb-tl-when', text: entry.when });
            item.createDiv({ cls: 'sf-vb-tl-label', text: entry.label });
            if (entry.detail) item.createDiv({ cls: 'sf-vb-tl-detail', text: entry.detail });
            marks.push(item);
            markers.push(marker);
        }

        const scrubber = new ScrubControl(control, bar, timeline.entries, marks, markers);
        control.answer(event => scrubber.handleKey(event));
    }
}

/**
 * The summary: bullets, pearls marked so they survive condensing, and the
 * reader's own control for doing the condensing.
 *
 * The toggle hides the non-pearl bullets rather than removing them, so the
 * full summary is one press away and nothing is ever lost.
 */
export class StudySummaryView {
    private root: HTMLElement | null = null;
    private toggle: HTMLButtonElement | null = null;
    private bullets: HTMLElement[] = [];
    private pearlCount = 0;
    private pearlsOnly = false;

    mount(container: HTMLElement, summary: StudySummary): () => void {
        this.unmount();
        const root = container.createDiv('sf-sum');
        this.root = root;

        const head = root.createDiv('sf-sum-head');
        head.createDiv({ cls: 'sf-sum-title', text: summary.title });
        head.createDiv({ cls: 'sf-sum-count', text: summaryCountLine(summary) });

        const toggle = root.createEl('button', { cls: 'sf-sum-toggle', text: TOGGLE_LABEL });
        toggle.setAttribute('type', 'button');
        toggle.setAttribute('aria-pressed', 'false');
        this.toggle = toggle;
        this.pearlCount = summary.bullets.filter(bullet => bullet.emphasis === 'pearl').length;
        if (this.pearlCount === 0) {
            // Condensing a summary with no pearls would leave nothing at all.
            toggle.disabled = true;
            toggle.setAttribute('title', TOGGLE_EMPTY_TITLE);
        }
        toggle.addEventListener('click', this.onToggleClick);

        const list = root.createEl('ul', { cls: 'sf-sum-list' });
        for (const bullet of summary.bullets) {
            const item = list.createEl('li', { cls: 'sf-sum-bullet' });
            if (bullet.emphasis === 'pearl') item.addClass('is-pearl');
            const mark = item.createSpan('sf-sum-mark');
            mark.setAttribute('aria-hidden', 'true');
            const main = item.createDiv('sf-sum-main');
            main.createSpan({ cls: 'sf-sum-text', text: bullet.text });
            if (bullet.children && bullet.children.length > 0) {
                const children = main.createEl('ul', { cls: 'sf-sum-children' });
                for (const child of bullet.children) children.createEl('li', { cls: 'sf-sum-child', text: child });
            }
            this.bullets.push(item);
        }

        if (summary.kept) root.createDiv({ cls: 'sf-sum-kept', text: summary.kept });

        return () => this.unmount();
    }

    unmount(): void {
        this.toggle?.removeEventListener('click', this.onToggleClick);
        this.toggle = null;
        this.bullets = [];
        this.pearlCount = 0;
        this.pearlsOnly = false;
        this.root?.remove();
        this.root = null;
    }

    private onToggleClick = (): void => {
        this.togglePearlsOnly();
    };

    /** Hide everything that is not a pearl, or put it all back. */
    private togglePearlsOnly(): void {
        if (this.pearlCount === 0) return;
        this.pearlsOnly = !this.pearlsOnly;
        this.toggle?.toggleClass('is-on', this.pearlsOnly);
        this.toggle?.setAttribute('aria-pressed', String(this.pearlsOnly));
        for (const bullet of this.bullets) {
            bullet.toggleClass('sf-sum-hidden', this.pearlsOnly && !bullet.hasClass('is-pearl'));
        }
    }
}
