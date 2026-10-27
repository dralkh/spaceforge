import { FsrsRating, RatingKind, ReviewResponse, ReviewSchedule } from './review-schedule';

/**
 * Which scheduling algorithm a note is on. Kept here (rather than imported from
 * ui/constants) so this module stays free of Obsidian imports and can be unit
 * tested in plain Node.
 */
export type ReviewAlgorithm = 'sm2' | 'fsrs';

/** How the review controls are presented to the user. */
/**
 * How a review is presented.
 *
 * The dialog that used to sit on top of the note is gone: the docked bar keeps
 * the note in view and moves on after each grade, and a vault that still has
 * `'modal'` stored is migrated to `'strip'` when its settings load. The type
 * stays as a single member so old data can be read and corrected rather than
 * crashing the loader.
 */
export type ReviewInterfaceMode = 'strip';

/**
 * Where a review session is shown: splitting the note's pane, or in a window of
 * its own that can be moved to another monitor.
 */
export type ReviewSessionPlacement = 'split' | 'window';

/** Where a card sitting opens: over the app, in a split, or in its own window. */
export type DeckSessionPlacement = 'modal' | 'split' | 'window';

/**
 * Where the review session itself lives.
 *
 * The reader's screen is not always the pane the note is in: a session belongs
 * under the note, in a window of its own, or in the sidebar's review tab.
 */
export type ReviewSessionHost = 'note' | 'split' | 'window' | 'sidebar';

/** The four grades every algorithm can be expressed in. */
export type GradeBucket = 'again' | 'hard' | 'good' | 'easy';

/** What the user decides when a note keeps failing (Anki's "leech" dialog). */
export type LeechAction = 'reset' | 'postpone' | 'remove' | 'keep';

/**
 * The card lane's own steps in a run.
 *
 * A sitting is a sequence, not a row of tabs beside it: the notes come first
 * and the decks' cards follow as their own series of steps, so the bar's
 * counter counts everything the sitting is made of. A card step is not a note
 * — nothing opens it as a file — and it is named with a prefix no vault path
 * can carry: a path in a run is always a vault path, and Obsidian refuses a
 * file name with a colon in it.
 */
export const CARDS_STEP_PREFIX = 'spaceforge:cards:';

/** The id of one card step: the nth card of the run's own series. */
export function cardsStepId(index: number): string {
    return `${CARDS_STEP_PREFIX}${index}`;
}

/** The ids of a run's card steps, in order. */
/** A card step that names its deck: one step per deck the sitting will hand over. */
export function deckStepId(deckPath: string): string {
    return `${CARDS_STEP_PREFIX}${deckPath}`;
}

/** The deck a card step names, or null when it is an anonymous card step. */
export function cardStepDeck(step: string): string | null {
    if (!isCardsStep(step)) return null;
    const suffix = step.slice(CARDS_STEP_PREFIX.length);
    return suffix === '' || /^\d+$/.test(suffix) ? null : suffix;
}

export function cardsStepIds(count: number): string[] {
    const length = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    return Array.from({ length }, (_, index) => cardsStepId(index));
}

/** True when a step is one of the card lane's, not a note. */
export function isCardsStep(step: string): boolean {
    return step.startsWith(CARDS_STEP_PREFIX);
}

export type FlowPhase = 'inactive' | 'reviewing' | 'decision' | 'finished';

export interface GradeOption {
    /** Bucket for the coarse grade commands; null for extras the keyboard reaches. */
    bucket: GradeBucket | null;
    /** Value handed to the scheduler for this algorithm. */
    response: number;
    label: string;
    /** Keyboard key that grades with this option. */
    key: string;
    /** Colour token used by the stylesheet. */
    variant: string;
}

const FSRS_GRADES: GradeOption[] = [
    { bucket: 'again', response: FsrsRating.Again, label: 'Again', key: '1', variant: 'again' },
    { bucket: 'hard', response: FsrsRating.Hard, label: 'Hard', key: '2', variant: 'hard' },
    { bucket: 'good', response: FsrsRating.Good, label: 'Good', key: '3', variant: 'good' },
    { bucket: 'easy', response: FsrsRating.Easy, label: 'Easy', key: '4', variant: 'easy' },
];

const SM2_GRADES: GradeOption[] = [
    { bucket: null, response: ReviewResponse.CompleteBlackout, label: 'Complete blackout', key: '0', variant: 'blackout' },
    { bucket: 'again', response: ReviewResponse.IncorrectResponse, label: 'Incorrect', key: '1', variant: 'incorrect' },
    { bucket: null, response: ReviewResponse.IncorrectButFamiliar, label: 'Incorrect but familiar', key: '2', variant: 'familiar' },
    { bucket: 'hard', response: ReviewResponse.CorrectWithDifficulty, label: 'Correct with difficulty', key: '3', variant: 'difficulty' },
    { bucket: 'good', response: ReviewResponse.CorrectWithHesitation, label: 'Correct with hesitation', key: '4', variant: 'hesitation' },
    { bucket: 'easy', response: ReviewResponse.PerfectRecall, label: 'Perfect recall', key: '5', variant: 'perfect' },
];

export function gradeOptionsFor(algorithm: ReviewAlgorithm): GradeOption[] {
    return algorithm === 'fsrs' ? FSRS_GRADES : SM2_GRADES;
}

/** Resolve a coarse grade (used by the bindable commands) to this algorithm's value. */
export function bucketResponse(bucket: GradeBucket, algorithm: ReviewAlgorithm): number {
    const match = gradeOptionsFor(algorithm).find(option => option.bucket === bucket);
    if (match) return match.response;
    // Every algorithm defines the four buckets, so this is unreachable in practice.
    return algorithm === 'fsrs' ? FsrsRating.Good : ReviewResponse.CorrectWithHesitation;
}

/** Grade option bound to a single keyboard key, or null if the key grades nothing. */
export function gradeForKey(key: string, algorithm: ReviewAlgorithm): GradeOption | null {
    return gradeOptionsFor(algorithm).find(option => option.key === key) ?? null;
}

/** Lapse counters used to decide whether a note needs an explicit decision. */
export interface LapseInfo {
    lapses: number;
    handledAtLapses: number;
    threshold: number;
}

/** Anki-style checkpoints: ask at the threshold, then again at each multiple. */
export function nextLeechCheckpoint(handledAtLapses: number, threshold: number): number {
    if (threshold <= 0) return Number.POSITIVE_INFINITY;
    const handled = Math.max(0, Math.min(handledAtLapses, Number.MAX_SAFE_INTEGER));
    return Math.floor(handled / threshold) * threshold + threshold;
}

export function shouldPromptLeech(info: LapseInfo): boolean {
    if (info.threshold <= 0) return false;
    return info.lapses >= nextLeechCheckpoint(info.handledAtLapses, info.threshold);
}

/** Lapse counters read straight off a schedule, whichever algorithm owns them. */
export function lapseInfoFromSchedule(schedule: ReviewSchedule | undefined): { lapses: number; handledAtLapses: number } {
    if (!schedule) return { lapses: 0, handledAtLapses: 0 };
    const lapses = schedule.schedulingAlgorithm === 'fsrs'
        ? (schedule.fsrsData?.lapses ?? 0)
        : (schedule.lapses ?? 0);
    return { lapses, handledAtLapses: schedule.leechHandledAtLapses ?? 0 };
}

export interface LeechChoice {
    action: LeechAction;
    label: string;
    description: string;
    primary: boolean;
}

export function leechChoices(): LeechChoice[] {
    return [
        { action: 'reset', label: 'Reset progress', description: 'Back to a 1 day interval, lapse counter cleared', primary: true },
        { action: 'postpone', label: 'Rest for a week', description: 'Hide this note for 7 days', primary: false },
        { action: 'remove', label: 'Remove from schedule', description: 'Stop reviewing this note', primary: false },
        { action: 'keep', label: 'Keep as is', description: 'Carry on, ask again at the next checkpoint', primary: false },
    ];
}

export function leechPromptText(title: string, lapses: number, threshold: number): string {
    return `${title} has lapsed ${lapses} times (checkpoint every ${threshold}). What should happen to it?`;
}

/** Anki-style compact duration: 10m, 4h, 3d, 2.1mo, 1.2y. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return 'now';
    const minutes = ms / 60000;
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = hours / 24;
    if (days < 30) return `${Math.round(days)}d`;
    const months = days / 30.44;
    if (months < 12) return `${months.toFixed(1)}mo`;
    return `${(days / 365.25).toFixed(1)}y`;
}

/** Label for the interval preview shown on a grade button. */
export function formatIntervalPreview(nextReviewDate: number | null, now: number): string | null {
    if (nextReviewDate === null || !Number.isFinite(nextReviewDate)) return null;
    return formatDuration(nextReviewDate - now);
}

/**
 * What to print on a grade button for a previewed rating.
 *
 * Whole-day scheduling reads better as days ("3d") than as "62h", while a
 * learning step minutes away ("10m" in FSRS) is only visible in the clock, and
 * something due today is simply "today".
 */
export function formatScheduledInterval(intervalDays: number, nextReviewDate: number, now: number): string {
    const delta = nextReviewDate - now;
    if (Number.isFinite(intervalDays) && intervalDays >= 1) {
        return `${Math.round(intervalDays)}d`;
    }
    if (delta <= 0) return 'today';
    return formatDuration(delta);
}

/**
 * A due span with the clock in it: minutes under an hour, hours and minutes
 * under a day, and days with the leftover hours while the label stays short.
 *
 * `formatDuration` rounds to whole hours, which is right on a grade button
 * ("5h") but hides the twenty minutes the reader is actually waiting for.
 */
function formatDueSpan(ms: number): string {
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainder = hours % 24;
    // A week is where the hours stop being a decision: "8d 4h overdue" is a
    // longer label for the same choice, and it pushes the controls off a
    // 268 px bar onto their own row.
    return remainder && days < 7 ? `${days}d ${remainder}h` : `${days}d`;
}

/** "3h 20m overdue" / "due in 2h 15m" for the strip header. */
export function formatDueLabel(nextReviewDate: number, now: number): string {
    const delta = nextReviewDate - now;
    if (delta <= 0) {
        const late = -delta;
        if (late < 60000) return 'due now';
        return `${formatDueSpan(late)} overdue`;
    }
    return `due in ${formatDueSpan(delta)}`;
}

/** Snapshot kept so the last grade can be reverted (Anki's "undo"). */
export interface UndoRecord {
    path: string;
    /** Serialized schedule before the grade; null when no schedule existed. */
    scheduleJSON: string | null;
    /** History length before the grade, so the appended entries can be dropped. */
    historyLength: number;
    /** Path that was on screen before the grade, so undo can return to it. */
    previousPath: string | null;
    recordedAt: number;
}

export interface FlowPosition {
    /** Items handled (graded, skipped or otherwise resolved) this session. */
    handled: number;
    /** Items still to handle, including the current one. */
    remaining: number;
    /** Total items the session started with. */
    total: number;
}

export interface PendingDecision {
    path: string;
    lapses: number;
    threshold: number;
}

/**
 * Order-keeping state machine for a review run.
 *
 * The queue is reconciled against the live "due today" list on every transition
 * instead of being frozen at start: grading a note takes it out of that list, a
 * postpone or removal takes it out too, and anything that becomes due while the
 * session runs is picked up. That is what makes the flow self-advancing without
 * the user ever closing and reopening a panel.
 *
 * The queue holds two kinds of step: notes, and the card lane's own series
 * (see {@link CARDS_STEP_PREFIX}). They are the same kind of thing to the run
 * — one cursor, one handled set, one counter — because a sitting the reader
 * cannot navigate through is not one sitting.
 */
export class ReviewFlowModel {
    phase: FlowPhase = 'inactive';
    pendingDecision: PendingDecision | null = null;
    undoRecord: UndoRecord | null = null;

    private order: string[] = [];
    private handled = new Set<string>();
    private cursor = 0;
    private total = 0;
    /** Notes the run has queued, counting the ones it has since walked past. */
    private notesTotal = 0;
    /** The card steps the run is holding: the card lane's own series. */
    private cardsTotal = 0;
    /**
     * Steps the walk has taken out of its queue, at or before the cursor.
     *
     * The order is reconciled against the live due list on every transition, so
     * a raw index is not a place: a note that leaves the queue (graded,
     * postponed, removed) takes its slot with it and everything behind shifts
     * down one. Counting the steps that left at or before the cursor is what
     * keeps the reader's number where it was — without it, the place collapses
     * back whenever the queue is re-derived, and every fix for that (a tally
     * added on top of the index, `max(handled, index)`) then pins the number
     * while the reader walks the part of the queue behind the tally. See
     * {@link place}.
     */
    private removedBefore = 0;

    start(livePaths: string[], startPath?: string, cardSteps: number | string[] = 0): void {
        // A path can only be one item in the run, whatever the caller hands over.
        this.order = [...new Set(livePaths)];
        this.handled.clear();
        this.cursor = 0;
        this.removedBefore = 0;
        this.notesTotal = this.order.length;
        this.cardsTotal = 0;
        this.setCardSteps(cardSteps);
        this.undoRecord = null;
        this.pendingDecision = null;
        this.phase = this.order.length > 0 ? 'reviewing' : 'finished';
        if (startPath) this.focus(startPath);
    }

    /** Reconcile the queue with the live due list, keeping the cursor on the same note. */
    sync(livePaths: string[], cardSteps?: number | string[]): void {
        const live = new Set(livePaths);
        const current = this.currentPath();
        // Notes that are no longer due (graded, postponed, removed) leave the
        // run. The card lane's steps are not notes and never "become due": they
        // stay where they are. A note a session hands over is put back
        // explicitly with focus().
        const kept = this.order.filter(step => isCardsStep(step) || live.has(step));
        // The steps that just left were walked past: their places stay with the
        // reader, or the number the bar prints would fall back by one for every
        // note that is graded out of the queue.
        this.noteDroppedSteps(this.order, kept);
        this.order = kept;
        // Notes that came due while the sitting ran join the queue *before* the
        // card series: the cards are the tail of the run, and a note that
        // arrives mid-session is still a note.
        const known = new Set(this.order);
        const arriving: string[] = [];
        for (const path of livePaths) {
            if (!known.has(path) && !arriving.includes(path)) {
                arriving.push(path);
                known.add(path);
            }
        }
        if (arriving.length > 0) {
            const cards = this.cardSteps();
            this.order = [...this.noteSteps(), ...arriving, ...cards];
        }
        if (cardSteps !== undefined) this.setCardSteps(cardSteps);
        if (current) {
            const index = this.order.indexOf(current);
            if (index >= 0) {
                this.cursor = index;
            } else {
                const next = this.findNext(this.cursor);
                if (next) {
                    this.cursor = next.index;
                } else {
                    this.cursor = Math.min(this.cursor, Math.max(0, this.order.length - 1));
                }
            }
        } else {
            this.cursor = Math.min(this.cursor, Math.max(0, this.order.length - 1));
        }
        this.recount();
        if (this.phase === 'reviewing' || this.phase === 'decision') {
            if (this.findNext(this.cursor) === null && this.currentPath() === null) {
                this.phase = 'finished';
            }
        }
    }

    currentPath(): string | null {
        return this.order[this.cursor] ?? null;
    }

    /** True when this step is one of the card lane's, not a note. */
    isCardStep(step: string | null): boolean {
        return step !== null && isCardsStep(step);
    }

    /** True while the cursor stands on one of the card lane's steps. */
    onCardStep(): boolean {
        return this.isCardStep(this.currentPath());
    }

    /** The card steps the run is holding, in order. */
    cardSteps(): string[] {
        return this.order.filter(isCardsStep);
    }

    /** How many of the run's steps are the card lane's. */
    cardStepCount(): number {
        return this.cardSteps().length;
    }

    /**
     * What the run is made of: the notes it has queued — counting the ones it
     * has walked past — and the card lane's own steps. The bar prints the two
     * as one total; this is where the split is.
     */
    composition(): { notes: number; cards: number } {
        return { notes: this.notesTotal, cards: this.cardsTotal };
    }

    /**
     * Give the run the card lane's steps: its own series, at the tail of the
     * queue, one step per card the decks are holding.
     *
     * Before the reader reaches the series it follows the live count — a count
     * that arrives late still counts, and one that falls takes the steps away.
     * Once a card step has been handled the series only ever shrinks to what
     * the reader has already passed: a count that moves under the sitting must
     * not pull a step out from under the cursor, and a count that comes back
     * must not reopen a sitting that is over.
     */
    setCardSteps(countOrSteps: number | string[]): void {
        // The steps are the decks the sitting will hand over: one step per deck,
        // named by the deck itself, so the run can say which deck it has reached.
        // A plain count still works (it makes anonymous steps), which is what a
        // saved run from before deck steps carries.
        const live = Array.isArray(countOrSteps)
            ? countOrSteps.filter(step => typeof step === 'string' && isCardsStep(step))
            : cardsStepIds(countOrSteps);
        const wanted = Array.from(new Set(live));
        const held = this.cardSteps();
        // A step the reader has already passed is never given back: a count that
        // moves under the sitting must not pull a step out from under the
        // cursor, and a sitting that is over must not reopen.
        const passed = held.filter(step => this.handled.has(step));
        // A series the reader has finished stays finished: a count that comes
        // back after the sitting is over must not reopen it.
        const finished = held.length > 0 && passed.length === held.length;
        const merged = finished ? passed : [...passed, ...wanted.filter(step => !passed.includes(step))];
        const same = merged.length === held.length && merged.every((step, index) => step === held[index]);
        if (!same) {
            for (const step of held) {
                if (!merged.includes(step)) this.handled.delete(step);
            }
            const rebuilt = [...this.noteSteps(), ...merged];
            // A card step the reader has already walked past is never given
            // back, and the place it was walked at stays with them.
            this.noteDroppedSteps(this.order, rebuilt);
            this.order = rebuilt;
            this.cursor = Math.max(0, Math.min(this.cursor, this.order.length - 1));
        }
        this.recount();
    }

    /**
     * One card step is over: the sitting that was showing it has ended.
     *
     * Deliberately one step at a time. A step is a deck, and the reader sitting
     * the first deck's cards has not walked the second deck's step — a sitting
     * that marks the whole series spent is the tally that runs ahead of the
     * walk, and with it the bar's number was pinned at the end of the run while
     * the reader stood at its start. The run's own `advance()` spends the step
     * the cursor is on; this exists for a caller that knows which step it means.
     */
    completeCardStep(step: string): void {
        if (isCardsStep(step) && this.order.includes(step)) this.handled.add(step);
    }

    /**
     * The whole series is over: every step of the card lane is spent.
     *
     * For a sitting that covered every deck at once (Anki's parent-deck
     * behaviour): there is no deck left for the run to walk to, so nothing is
     * being decided on the reader's behalf. A sitting on one deck's step is not
     * this — see {@link completeCardStep}.
     */
    completeCardSteps(): void {
        for (const step of this.cardSteps()) this.handled.add(step);
    }

    /**
     * Point the run at the cards: the next card step that is not handled, or
     * the first one when they all are — walking back to a sitting that is over
     * is looking, not re-handling. False when the run holds no card steps.
     */
    focusCardSteps(): boolean {
        const steps = this.cardSteps();
        if (steps.length === 0) return false;
        const step = steps.find(candidate => !this.handled.has(candidate)) ?? steps[0];
        this.cursor = this.order.indexOf(step);
        this.pendingDecision = null;
        this.phase = 'reviewing';
        return true;
    }

    /** The run's own notes, in order, without the card lane's steps. */
    private noteSteps(): string[] {
        return this.order.filter(step => !isCardsStep(step));
    }

    /**
     * The denominator: every step the run has held. A note that leaves the
     * queue because it was handled keeps counting — the bar's total is the
     * sitting's size, not the length of what is left of it — while the card
     * series is counted as it stands, since it is the one part of the queue
     * that can be taken away before anyone has walked it.
     */
    private recount(): void {
        this.notesTotal = Math.max(this.notesTotal, this.noteSteps().length);
        this.cardsTotal = this.cardSteps().length;
        this.total = this.notesTotal + this.cardsTotal;
    }

    /**
     * Take note of the steps an order rebuild dropped at or before the cursor.
     *
     * Called with the order as it was and as it is about to be, *before* the
     * cursor is re-derived against the new one: only those steps count, because
     * only they move the cursor's index. A step dropped ahead of the reader was
     * never walked and must not inflate the place.
     */
    private noteDroppedSteps(before: string[], after: string[]): void {
        const kept = new Set(after);
        const upTo = Math.min(this.cursor, before.length - 1);
        for (let index = 0; index <= upTo; index++) {
            if (!kept.has(before[index])) this.removedBefore += 1;
        }
    }

    /**
     * Where the reader stands in the run, 1-based: the cursor's place in the
     * queue plus the steps that have already been taken out of it.
     *
     * This is the number the bar prints, and it moves by exactly one per step —
     * a grade, a skip, Next or Previous alike — because a step's place is its
     * own: taking a step out of the queue moves the cursor onto the next one
     * without moving the number, and a rebuild of the order (a note that stops
     * being due, a card series that is handed over) leaves the reader's place
     * exactly where it was. It is never the handled tally: a tally counts what
     * has been resolved, while a live sitting marks whole series of steps at
     * once, and a number taken from it is pinned wherever the tally runs ahead
     * of the walk.
     */
    place(): number {
        const at = this.cursor + 1 + this.removedBefore;
        return Math.max(1, Math.min(at, Math.max(1, this.total)));
    }

    /** True while the run's queue still names this note. */
    has(path: string): boolean {
        return this.order.includes(path);
    }

    /** Where the cursor sits in the queue (0-based), for a position readout. */
    cursorIndex(): number {
        return this.cursor;
    }

    isRunning(): boolean {
        return this.phase === 'reviewing' || this.phase === 'decision';
    }

    isActive(): boolean {
        return this.phase !== 'inactive';
    }

    isFinished(): boolean {
        return this.phase === 'finished';
    }

    paths(): string[] {
        return [...this.order];
    }

    nextPendingPath(): string | null {
        const found = this.findNext(this.cursor + 1);
        return found ? found.path : null;
    }

    /**
     * Move past the current note.
     *
     * By default the note counts as handled for this session. A note that is still
     * due today - a failure parked on a short-term step - is passed with
     * `keepInRun`, so it stays in the run and comes back after the others, the way
     * Anki re-asks a lapsed card in the same session.
     */
    advance(options: { keepInRun?: boolean } = {}): void {
        const current = this.currentPath();
        if (current && !options.keepInRun) this.handled.add(current);
        this.pendingDecision = null;
        const found = this.findNext(this.cursor + 1);
        if (found) {
            this.cursor = found.index;
            this.phase = 'reviewing';
        } else {
            this.phase = 'finished';
        }
    }

    /** Hold the flow on the current note until the user decides what to do with it. */
    awaitDecision(decision: PendingDecision): void {
        this.pendingDecision = decision;
        this.phase = 'decision';
    }

    /**
     * Step back one place in the queue — the mirror of {@link advance}.
     *
     * A look-back is not a re-handling: nothing leaves the handled set, so a
     * note already passed stays passed and walking forward again does not offer
     * it as fresh work. The step is circular, the way the due list's own
     * Previous has always been, and it is only available while the queue is
     * being walked — a finished run has nothing left to step back into.
     */
    stepBack(): boolean {
        if (this.phase !== 'reviewing') return false;
        const length = this.order.length;
        if (length === 0) return false;
        this.cursor = ((this.cursor - 1) % length + length) % length;
        this.pendingDecision = null;
        return true;
    }

    /**
     * Step forward one place in the queue — navigation, not a decision.
     *
     * The mirror of {@link stepBack}: the cursor moves and nothing else does.
     * The bar's Skip is what marks a note handled; walking the queue to look at
     * what comes next must not silently finish the reader's work, or the
     * counter climbs to the end the moment they browse.
     */
    stepForward(): boolean {
        if (this.phase !== 'reviewing') return false;
        const length = this.order.length;
        if (length === 0) return false;
        this.cursor = (this.cursor + 1) % length;
        this.pendingDecision = null;
        return true;
    }

    /** Point the flow at a note, whether or not it is already queued. */
    focus(path: string): void {
        let index = this.order.indexOf(path);
        if (index < 0) {
            // A new note joins the notes: the card lane's series stays the tail
            // of the run, wherever the reader happens to be standing.
            const notes = this.noteSteps();
            notes.push(path);
            this.order = [...notes, ...this.cardSteps()];
            index = notes.length - 1;
        }
        this.cursor = index;
        this.pendingDecision = null;
        this.phase = 'reviewing';
        this.recount();
    }

    /**
     * The run as data, for a save: the order being walked, the note it is on,
     * and what has already been handled.
     */
    snapshot(): { order: string[]; cursor: number; handled: string[] } {
        return { order: [...this.order], cursor: this.cursor, handled: [...this.handled] };
    }

    /**
     * Put a saved run back as it was, without re-deriving anything. Returns
     * false when there is nothing walkable in it, so a stale save can never
     * stop a run from starting.
     */
    restore(saved: { order?: string[]; cursor?: number; handled?: string[] }): boolean {
        const order = [...new Set(saved.order ?? [])].filter(path => typeof path === 'string' && path.length > 0);
        if (order.length === 0) return false;
        const handled = new Set((saved.handled ?? []).filter(path => order.includes(path)));
        const raw = Number(saved.cursor);
        const cursor = Number.isFinite(raw)
            ? Math.max(0, Math.min(order.length - 1, Math.round(raw)))
            : 0;
        this.order = order;
        this.handled = handled;
        this.cursor = cursor;
        this.removedBefore = 0;
        this.notesTotal = 0;
        this.cardsTotal = 0;
        this.recount();
        this.undoRecord = null;
        this.pendingDecision = null;
        this.phase = 'reviewing';
        return true;
    }

    position(): FlowPosition {
        const remaining = this.order.filter(path => !this.handled.has(path)).length;
        return { handled: this.handled.size, remaining, total: Math.max(this.total, this.order.length) };
    }

    setUndo(record: UndoRecord): void {
        this.undoRecord = record;
    }

    clearUndo(): void {
        this.undoRecord = null;
    }

    undoAvailable(): boolean {
        return this.undoRecord !== null;
    }

    /** Return to the last graded note and drop the record, so the caller can restore it. */
    undoTo(): UndoRecord | null {
        const record = this.undoRecord;
        if (!record) return null;
        this.undoRecord = null;
        this.handled.delete(record.path);
        this.focus(record.path);
        return record;
    }

    end(): void {
        this.phase = 'inactive';
        this.order = [];
        this.handled.clear();
        this.cursor = 0;
        this.removedBefore = 0;
        this.total = 0;
        this.notesTotal = 0;
        this.cardsTotal = 0;
        this.pendingDecision = null;
        this.undoRecord = null;
    }

    private findNext(fromIndex: number): { index: number; path: string } | null {
        const length = this.order.length;
        if (length === 0) return null;
        for (let step = 0; step < length; step++) {
            const index = ((fromIndex + step) % length + length) % length;
            const path = this.order[index];
            if (!this.handled.has(path)) return { index, path };
        }
        return null;
    }
}

/** Options accepted when a rating is recorded through the review controller. */
export interface ReviewResponseOptions {
    /** Move on to the next note / show the next dialog afterwards (default true). */
    navigate?: boolean;
    /** Suppress the per-review notice, for flows that grade quickly in a row. */
    silent?: boolean;
    /**
     * Which scale the response belongs to. FSRS-aware callers (the docked bar, the
     * modal's FSRS buttons, MCQ, the bindable commands) send `'fsrs'` so their
     * 1-4 ratings are not re-read as SM-2 qualities, where 3 would mean "Hard".
     */
    ratingKind?: RatingKind;
}

/** What recording a rating actually did. */
export interface ReviewRecordResult {
    /** False when the note was not due, so nothing was written. */
    recorded: boolean;
    /** Note the flow should show next, when one could be determined. */
    nextPath: string | null;
    /**
     * Where `nextPath` came from: a hierarchical session drives the order itself,
     * while the due queue leaves the caller in charge of picking the next note.
     */
    nextPathSource: 'session' | 'queue' | null;
    /** True when a hierarchical session just ran out of files. */
    sessionComplete: boolean;
}

export interface HotkeyEvent {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
}

export interface HotkeyContext {
    /**
     * A question is on screen in the dock. The runner owns digits, letters and
     * the arrows there, so the bar gives way rather than grading the note while
     * the same key answers a question.
     */
    questionOpen?: boolean;
    /** False once the session has ended, so stale listeners stay quiet. */
    active: boolean;
    phase: FlowPhase;
    algorithm: ReviewAlgorithm;
    /** True when the keystroke would otherwise go into a text field or the editor. */
    editableTarget: boolean;
    /** True when a modal or suggestion popup owns the keyboard right now. */
    overlayOpen: boolean;
    /** User preference: plain (unmodified) digit keys grade. */
    plainKeysEnabled: boolean;
}

export type HotkeyAction =
    | { type: 'grade'; response: number }
    | { type: 'next' }
    | { type: 'previous' }
    | { type: 'skip' }
    | { type: 'undo' }
    | { type: 'postpone' }
    | { type: 'end' }
    | { type: 'hint' };

const LETTER_ACTIONS: Record<string, HotkeyAction['type']> = {
    n: 'next',
    b: 'previous',
    s: 'skip',
    u: 'undo',
    p: 'postpone',
};

/**
 * Map a keystroke to a review action.
 *
 * Digits grade. While the caret is somewhere it would type (live preview, edit
 * mode, search fields) they are left alone and Alt+digit is the grading chord —
 * so the note stays a normal, editable note and nothing is swallowed mid-sentence.
 */
export function resolveHotkey(event: HotkeyEvent, context: HotkeyContext): HotkeyAction | null {
    if (!context.active || event.repeat) return null;
    if (context.overlayOpen) return null;
    if (event.ctrlKey || event.metaKey) return null;
    if (context.phase === 'decision' || context.phase === 'finished') {
        // Only the escape hatch and the hint stay live once the flow is paused.
        if (event.key === 'Escape' && !context.editableTarget) return { type: 'end' };
        if (event.key === 'u' && !context.editableTarget) return { type: 'undo' };
        return null;
    }
    if (context.phase !== 'reviewing') return null;
    if (event.shiftKey) return null;
    // Escape stays live: closing the review is not one of the runner's keys.
    if (context.questionOpen && !context.editableTarget && event.key !== 'Escape') return null;

    const key = event.key.toLowerCase();
    // Alt+digit always grades: it cannot collide with typing and it is the chord
    // the bar advertises while the caret is in the note. The setting governs the
    // *bare* digits, which are the ones a writer would trip over.
    const gradingAllowed = event.altKey || (context.plainKeysEnabled && !context.editableTarget);
    if (gradingAllowed) {
        const option = gradeForKey(key, context.algorithm);
        if (option) return { type: 'grade', response: option.response };
    }

    const letterAllowed = !context.editableTarget || event.altKey;
    if (letterAllowed) {
        const action = LETTER_ACTIONS[key];
        if (action === 'next') return { type: 'next' };
        if (action === 'previous') return { type: 'previous' };
        if (action === 'skip') return { type: 'skip' };
        if (action === 'undo') return { type: 'undo' };
        if (action === 'postpone') return { type: 'postpone' };
        if (event.key === '?') return { type: 'hint' };
    }

    if (event.key === 'Escape' && !context.editableTarget) return { type: 'end' };
    return null;
}

export const HOTKEY_HINT = '1-4 rate · n next · b back · esc end';
export const HOTKEY_HINT_SM2 = '0-5 rate · n next · b back · esc end';
export const HOTKEY_HINT_ALT = 'Alt+1-4 rate · n next · b back · esc end';
export const HOTKEY_HINT_ALT_SM2 = 'Alt+0-5 rate · n next · b back · esc end';
export const EDITING_HINT = 'Editing: hold Alt with the key';

/**
 * The reminder under the bar. It has to describe the keys that are actually
 * live: with plain digits switched off, or while the caret is in the note, the
 * grading chord is Alt+digit and saying otherwise just teaches a dead key.
 */
export function hotkeyHint(algorithm: ReviewAlgorithm, plainKeysEnabled = true): string {
    const fsrs = algorithm === 'fsrs';
    if (plainKeysEnabled) return fsrs ? HOTKEY_HINT : HOTKEY_HINT_SM2;
    return fsrs ? HOTKEY_HINT_ALT : HOTKEY_HINT_ALT_SM2;
}

/** Key badge for a grade button, reflecting whether the bare key really grades. */
export function gradeKeyLabel(key: string, plainKeysEnabled: boolean): string {
    return plainKeysEnabled ? key : `Alt+${key}`;
}
