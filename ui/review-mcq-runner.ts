import { setIcon } from 'obsidian';
import type SpaceforgePlugin from '../main';
import type { MCQQuestion, MCQSet } from '../models/mcq';

export interface McqRunAnswer {
    questionIndex: number;
    selectedAnswerIndex: number; // -1 when the user used "Show answer"
    attempts: number;
    correct: boolean;
    timeToAnswer: number; // seconds, rounded
}

export interface McqRunSummary {
    notePath: string;
    total: number;
    answered: number;
    completed: boolean; // every question has been answered
    answers: McqRunAnswer[];
    startedAt: number;
    finishedAt: number;
}

export interface McqRunnerOptions {
    /** Fired once: every question answered, or the user ended the sitting early. */
    onSummary: (summary: McqRunSummary) => void;
    /**
     * How long a correct answer stays on screen before the loop moves on by
     * itself. The Continue button is there for anyone who does not want to
     * wait; 0 disables the auto-advance entirely.
     */
    autoAdvanceMs?: number;
}

/** Long enough to read "Correct." and see which choice lit up. */
const DEFAULT_AUTO_ADVANCE_MS = 650;

type Phase = 'awaiting' | 'resolved' | 'ended';

/**
 * A question is only usable when there is something to click and an answer to
 * land on; anything else would wedge the loop.
 */
function isUsable(question: MCQQuestion | undefined): question is MCQQuestion {
    return (
        question !== undefined &&
        Array.isArray(question.choices) &&
        question.choices.length >= 2 &&
        Number.isInteger(question.correctAnswerIndex) &&
        question.correctAnswerIndex >= 0 &&
        question.correctAnswerIndex < question.choices.length
    );
}

/**
 * Same rule the review bar uses for its own keys: a keystroke aimed at a field,
 * an editor or a dialog is not a shortcut.
 */
function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return target.closest('[contenteditable="true"], .cm-editor, .modal, .prompt') !== null;
}

/**
 * The MCQ loop as an element inside a docked panel, never a window: the note is
 * being reviewed, the questions are one part of that, and a dialog would take
 * the note away from the reader.
 *
 * It asks the questions and reports what the user did — raw answers, attempts,
 * timing — and stops there. Scoring, scheduling and persistence belong to
 * whoever owns the sitting, so nothing here knows about grades.
 *
 * Everything is bound to the panel's own root: the runner never listens on the
 * document, so it cannot see keys meant for the editor, and it leaves nothing
 * behind when it is unmounted.
 */
export class McqRunner {
    // Kept because it is part of the caller's contract; the sitting's services
    // (session records, scheduling) are reached through it, not from here.
    private plugin: SpaceforgePlugin;
    private notePath: string;
    private mcqSet: MCQSet;
    private options: McqRunnerOptions;

    // ----------------------------------------------------------- DOM bookkeeping
    private root: HTMLElement | null = null;
    private progressEl: HTMLElement | null = null;
    private dotsEl: HTMLElement | null = null;
    private dotEls: HTMLElement[] = [];
    private endBtn: HTMLButtonElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private questionEl: HTMLElement | null = null;
    private choicesEl: HTMLElement | null = null;
    private feedbackEl: HTMLElement | null = null;
    private actionsEl: HTMLElement | null = null;
    private choiceEls: HTMLButtonElement[] = [];
    private keysEl: HTMLElement | null = null;
    private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

    // -------------------------------------------------------------- run state
    private index = 0;
    /** The choice the arrow keys are pointing at. */
    private highlighted = 0;
    private autoAdvanceMs: number;
    private autoAdvanceTimer: number | null = null;
    private phase: Phase = 'awaiting';
    private questionShownAt = 0;
    private records: (McqRunAnswer | undefined)[] = [];
    private startedAt = 0;
    private finished = false;
    private mounted = false;
    /**
     * Whether the panel is on screen. The dock hosts the runner in a panel it
     * hides on a tab switch rather than tearing it down, so the sitting keeps
     * its place while it is away — but a hidden runner answers nothing.
     */
    private visible = true;
    /** True while the document key listener is attached. */
    private listening = false;

    constructor(plugin: SpaceforgePlugin, notePath: string, set: MCQSet, options: McqRunnerOptions) {
        this.plugin = plugin;
        this.notePath = notePath;
        this.mcqSet = set;
        this.options = options;
        this.autoAdvanceMs = options.autoAdvanceMs ?? DEFAULT_AUTO_ADVANCE_MS;
    }

    // --------------------------------------------------------------- lifecycle

    /** Render into a host element; safe to call once. */
    mount(host: HTMLElement): void {
        if (this.mounted) return;
        this.mounted = true;
        // A freshly mounted runner is on screen until somebody hides it.
        this.visible = true;
        this.startedAt = Date.now();

        const root = host.createDiv('sf-mcq-runner');
        // Focusable, because the number keys are handled on the panel itself:
        // focus has to sit inside it for the shortcuts to mean anything, and
        // nothing outside it is ever touched.
        root.setAttribute('tabindex', '-1');
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', 'Multiple choice review');
        root.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown A-Z 1-9 Enter');

        const head = root.createDiv('sf-mcq-runner-head');
        const progressEl = head.createDiv('sf-mcq-runner-progress');
        const dotsEl = head.createDiv('sf-mcq-runner-dots');
        dotsEl.setAttribute('aria-hidden', 'true');
        const endBtn = head.createEl('button', { text: 'End session', cls: 'sf-mcq-runner-end' });
        endBtn.addEventListener('click', () => this.endEarly());

        const dotEls: HTMLElement[] = [];
        for (let i = 0; i < this.mcqSet.questions.length; i += 1) {
            dotEls.push(dotsEl.createSpan('sf-mcq-runner-dot'));
        }

        const bodyEl = root.createDiv('sf-mcq-runner-body');
        const questionEl = bodyEl.createDiv('sf-mcq-runner-question');
        const choicesEl = bodyEl.createDiv('sf-mcq-runner-choices');
        const keysEl = bodyEl.createDiv('sf-mcq-runner-keys');
        const feedbackEl = bodyEl.createDiv('sf-mcq-runner-feedback');
        feedbackEl.setAttribute('role', 'status');
        const actionsEl = bodyEl.createDiv('sf-mcq-runner-actions');

        this.root = root;
        this.progressEl = progressEl;
        this.dotsEl = dotsEl;
        this.dotEls = dotEls;
        this.endBtn = endBtn;
        this.bodyEl = bodyEl;
        this.questionEl = questionEl;
        this.choicesEl = choicesEl;
        this.keysEl = keysEl;
        this.feedbackEl = feedbackEl;
        this.actionsEl = actionsEl;

        // Bound to the document, not the panel: the panel is not always the
        // focused element (the note, a sidebar click or a re-render all move
        // focus away), and the shortcuts are worth nothing if they only work
        // when the reader clicks the panel first. Capture phase, like the
        // review bar's own keys, and guarded: anything typed into an editor,
        // field or dialog belongs to that surface.
        this.keydownHandler = (event: KeyboardEvent) => this.handleKeydown(event);
        this.applyKeyBinding();

        if (this.mcqSet.questions.length === 0) {
            // Nothing to ask: the caller is told at once rather than being left
            // with a panel that has no way forward.
            this.finish(true);
            return;
        }
        this.renderQuestion();
    }

    /**
     * True while a question is on screen: the caller uses it to stand its own
     * shortcuts down, so a digit does not both answer and grade the note.
     */
    get answering(): boolean {
        return this.mounted && !this.finished && this.phase === 'awaiting';
    }

    /**
     * Show or hide the runner without losing the sitting's place.
     *
     * The dock keeps every panel mounted and hides the ones whose tab is not
     * on screen, so a half-answered question survives a look at another tab.
     * What may not survive it is the keyboard: a question nobody can see must
     * not answer the reader's keys, so hiding lets go of the document listener
     * and showing takes it back — the same rule the card lane states for its
     * own sitting.
     */
    setVisible(visible: boolean): void {
        if (this.visible === visible) return;
        this.visible = visible;
        this.applyKeyBinding();
    }

    /** Attach or release the document key handler, idempotently. */
    private applyKeyBinding(): void {
        const shouldListen = this.mounted && this.visible;
        if (shouldListen === this.listening) return;
        const handler = this.keydownHandler;
        if (!handler) return;
        this.listening = shouldListen;
        if (shouldListen) document.addEventListener('keydown', handler, true);
        else document.removeEventListener('keydown', handler, true);
    }

    /** Remove everything and drop listeners. */
    unmount(): void {
        this.clearAutoAdvance();
        this.mounted = false;
        // Releases the document listener if it was bound.
        this.applyKeyBinding();
        this.keydownHandler = null;
        this.root?.remove();
        this.root = null;
        this.progressEl = null;
        this.dotsEl = null;
        this.dotEls = [];
        this.endBtn = null;
        this.bodyEl = null;
        this.questionEl = null;
        this.choicesEl = null;
        this.keysEl = null;
        this.feedbackEl = null;
        this.actionsEl = null;
        this.choiceEls = [];
    }

    // --------------------------------------------------------------- questions

    private renderQuestion(): void {
        const questions = this.mcqSet.questions;
        // Sets are generated, but one malformed question must not wedge the
        // loop for every question after it.
        let index = this.index;
        while (index < questions.length && !isUsable(questions[index])) index += 1;
        this.index = index;

        if (index >= questions.length) {
            this.finish(this.answers().length === questions.length);
            return;
        }

        const question = questions[index];
        this.phase = 'awaiting';
        this.questionShownAt = Date.now();
        this.choiceEls = [];

        if (this.questionEl) this.questionEl.setText(question.question || '(Question text missing)');
        this.choicesEl?.empty();
        this.feedbackEl?.empty();
        this.actionsEl?.empty();

        const choices = this.choicesEl;
        if (choices) {
            question.choices.forEach((choice, choiceIndex) => {
                const button = choices.createEl('button', { cls: 'sf-mcq-runner-choice' });
                button.createSpan({ cls: 'sf-mcq-runner-letter', text: String.fromCharCode(65 + choiceIndex) });
                button.createSpan({ cls: 'sf-mcq-runner-choice-text', text: choice || '(Empty choice)' });
                if (choiceIndex < 9) button.createSpan({ cls: 'sf-mcq-runner-key', text: String(choiceIndex + 1) });
                button.addEventListener('click', () => this.pick(choiceIndex));
                this.choiceEls.push(button);
            });
        }

        if (this.bodyEl) this.bodyEl.scrollTop = 0;
        this.highlighted = 0;
        this.applyHighlight();
        this.renderKeyHint(question.choices.length);
        this.updateHead();
        this.focusRoot();
    }

    /** The keys are worth nothing if nobody knows they exist. */
    private renderKeyHint(choiceCount: number): void {
        const el = this.keysEl;
        if (!el) return;
        const letters = `A–${String.fromCharCode(64 + Math.min(choiceCount, 26))}`;
        const digits = `1–${Math.min(choiceCount, 9)}`;
        el.setText(`↑↓ move · ${choiceCount <= 9 ? `${letters} or ${digits}` : letters} answer · enter continues`);
    }

    private pick(choiceIndex: number): void {
        if (this.finished || this.phase !== 'awaiting') return;
        const question = this.mcqSet.questions[this.index];
        if (!question) return;

        const record = this.recordFor(this.index);
        const isCorrect = choiceIndex === question.correctAnswerIndex;
        record.attempts += 1;
        record.timeToAnswer = this.elapsedSeconds();

        this.highlighted = choiceIndex;
        this.applyHighlight();

        if (isCorrect) {
            record.correct = true;
            record.selectedAnswerIndex = choiceIndex;
            this.phase = 'resolved';
            this.choiceEls.forEach((button, i) => {
                button.disabled = true;
                button.toggleClass('is-correct', i === choiceIndex);
                button.toggleClass('is-dim', i !== choiceIndex);
            });
            this.applyHighlight();
            this.setFeedback('correct', 'Correct.');
            this.setAction('Continue to next question', 'primary', true, () => this.continueAfterFeedback());
            this.scheduleAutoAdvance();
        } else {
            // The modal's convention: a wrong pick is not the answer yet, so the
            // record stays unresolved (-1) until the question is corrected or
            // given up on.
            record.correct = false;
            record.selectedAnswerIndex = -1;
            this.choiceEls[choiceIndex]?.addClass('is-wrong');
            this.setFeedback('wrong', 'Not quite — try another choice.');
            // The modal only re-offered the escape hatch when a question was
            // displayed again; inline that never happens, so it appears as soon
            // as one wrong pick lands instead of trapping the user.
            this.setAction('Show answer & continue', 'ghost', false, () => this.giveUp());
            this.focusRoot();
        }
        this.updateHead();
    }

    private giveUp(): void {
        if (this.finished || this.phase !== 'awaiting') return;
        const question = this.mcqSet.questions[this.index];
        if (!question) return;

        const record = this.recordFor(this.index);
        if (record.correct) return;
        // Only reachable after a wrong pick, and the modal counts giving up as
        // one more attempt; the caller scores on the same numbers.
        record.attempts += 1;
        record.selectedAnswerIndex = -1;
        record.correct = false;
        record.timeToAnswer = this.elapsedSeconds();
        this.phase = 'resolved';

        const correctIndex = question.correctAnswerIndex;
        this.choiceEls.forEach((button, i) => {
            button.disabled = true;
            button.toggleClass('is-correct', i === correctIndex);
            button.toggleClass('is-dim', i !== correctIndex);
        });
        const answerText = `${String.fromCharCode(65 + correctIndex)}) ${question.choices[correctIndex] || '(Empty choice)'}`;
        this.setFeedback('revealed', `Correct answer: ${answerText}`);
        this.setAction('Continue to next question', 'primary', true, () => this.continueAfterFeedback());
        this.updateHead();
    }

    private continueAfterFeedback(): void {
        // Guarded: the primary button both fires natively on Enter and bubbles a
        // keydown here, and the question must only advance once.
        if (this.finished || this.phase !== 'resolved') return;
        this.clearAutoAdvance();
        this.index += 1;
        this.renderQuestion();
    }

    // ---------------------------------------------------------------- keyboard

    /**
     * A correct answer moves on by itself after a beat. Anyone who would rather
     * not wait presses Continue (or Enter), which cancels the pending jump.
     */
    private scheduleAutoAdvance(): void {
        this.clearAutoAdvance();
        if (this.autoAdvanceMs <= 0) return;
        this.autoAdvanceTimer = window.setTimeout(() => {
            this.autoAdvanceTimer = null;
            this.continueAfterFeedback();
        }, this.autoAdvanceMs);
    }

    private clearAutoAdvance(): void {
        if (this.autoAdvanceTimer === null) return;
        window.clearTimeout(this.autoAdvanceTimer);
        this.autoAdvanceTimer = null;
    }

    private applyHighlight(): void {
        const live = this.phase === 'awaiting' && !this.finished;
        this.choiceEls.forEach((button, i) => {
            button.toggleClass('is-highlighted', live && i === this.highlighted);
        });
    }

    /** Arrow keys walk the choices; the ends wrap rather than sticking. */
    private moveHighlight(step: number): void {
        const total = this.choiceEls.length;
        if (total === 0) return;
        this.highlighted = (this.highlighted + step + total) % total;
        this.applyHighlight();
        this.choiceEls[this.highlighted]?.scrollIntoView({ block: 'nearest' });
    }

    /** `4` or `d` -> index 3; anything that names no choice -> null. */
    private keyToChoiceIndex(key: string): number | null {
        if (key.length !== 1) return null;
        if (key >= '1' && key <= '9') return Number.parseInt(key, 10) - 1;
        const lower = key.toLowerCase();
        if (lower < 'a' || lower > 'z') return null;
        const index = lower.charCodeAt(0) - 97;
        return index < this.choiceEls.length ? index : null;
    }

    // -------------------------------------------------------------- rendering

    private setFeedback(kind: 'correct' | 'wrong' | 'revealed', text: string): void {
        const el = this.feedbackEl;
        if (!el) return;
        el.empty();
        el.removeClass('is-correct', 'is-wrong', 'is-revealed');
        if (kind === 'correct') el.addClass('is-correct');
        else if (kind === 'wrong') el.addClass('is-wrong');
        else el.addClass('is-revealed');

        const icon = el.createSpan('sf-mcq-runner-feedback-icon');
        setIcon(icon, kind === 'correct' ? 'check-circle-2' : kind === 'wrong' ? 'x-circle' : 'eye');
        el.createSpan({ cls: 'sf-mcq-runner-feedback-text', text });
    }

    private setAction(label: string, variant: 'primary' | 'ghost', focus: boolean, onClick: () => void): void {
        const host = this.actionsEl;
        if (!host) return;
        host.empty();
        const button = host.createEl('button', { text: label, cls: `sf-mcq-runner-action is-${variant}` });
        button.addEventListener('click', onClick);
        // Only the affirmative action takes focus, so a stray Enter continues
        // rather than giving up on a question.
        if (focus) button.focus({ preventScroll: true });
        // The panel is dock-sized; the action has to be brought into view.
        host.scrollIntoView({ block: 'nearest' });
    }

    private updateHead(): void {
        const total = this.mcqSet.questions.length;
        const position = Math.min(this.index + 1, total);
        if (this.progressEl) {
            this.progressEl.setText(`${position}/${total}`);
            this.progressEl.setAttribute('aria-label', `Question ${position} of ${total}`);
        }
        this.dotEls.forEach((dot, i) => {
            const record = this.records[i];
            const current = !this.finished && i === this.index && this.phase !== 'resolved';
            dot.toggleClass('is-current', current);
            dot.toggleClass('is-correct', !current && record !== undefined && record.correct);
            dot.toggleClass('is-missed', !current && record !== undefined && !record.correct);
        });
    }

    private focusRoot(): void {
        this.root?.focus({ preventScroll: true });
    }

    // ----------------------------------------------------------------- finish

    private endEarly(): void {
        if (this.finished) return;
        this.finish(false);
    }

    private finish(completed: boolean): void {
        if (this.finished) return;
        this.finished = true;
        this.clearAutoAdvance();
        this.phase = 'ended';
        this.updateHead();
        this.root?.addClass('is-ended');
        this.root?.querySelectorAll('button').forEach(button => {
            button.disabled = true;
        });

        const total = this.mcqSet.questions.length;
        if (this.actionsEl) {
            const note = total === 0
                ? 'This set has no questions.'
                : completed ? 'All questions answered.' : 'Session ended early.';
            this.actionsEl.createDiv({ cls: 'sf-mcq-runner-ended', text: note });
        }

        const answers = this.answers();
        const summary: McqRunSummary = {
            notePath: this.notePath,
            total,
            answered: answers.length,
            completed,
            answers,
            startedAt: this.startedAt,
            finishedAt: Date.now(),
        };
        this.options.onSummary(summary);
    }

    // -------------------------------------------------------------- keyboard

    private handleKeydown(event: KeyboardEvent): void {
        if (this.finished || event.defaultPrevented) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // The note is right above this panel: while its editor (or any other
        // field or window) owns the keystroke, the runner stays out of the way.
        if (isEditableTarget(event.target)) return;

        if (event.key === 'Enter' && this.phase === 'resolved') {
            event.preventDefault();
            this.continueAfterFeedback();
            return;
        }

        if (this.phase !== 'awaiting') return;

        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            this.moveHighlight(1);
            return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            this.moveHighlight(-1);
            return;
        }

        if (event.key === 'Enter') {
            // Arrow to a choice, then Enter: the same as pressing its key.
            const button = this.choiceEls[this.highlighted];
            if (!button || button.disabled) return;
            event.preventDefault();
            this.pick(this.highlighted);
            return;
        }

        // A number or a letter, exactly as the row prints them.
        const index = this.keyToChoiceIndex(event.key);
        if (index === null) return;
        const button = this.choiceEls[index];
        if (!button || button.disabled) return;
        event.preventDefault();
        this.pick(index);
    }

    // ----------------------------------------------------------------- state

    private recordFor(index: number): McqRunAnswer {
        let record = this.records[index];
        if (!record) {
            record = {
                questionIndex: index,
                selectedAnswerIndex: -1,
                attempts: 0,
                correct: false,
                timeToAnswer: 0,
            };
            this.records[index] = record;
        }
        return record;
    }

    /** Seconds since the question appeared, rounded as the caller expects. */
    private elapsedSeconds(): number {
        return Math.max(0, Math.round((Date.now() - this.questionShownAt) / 1000));
    }

    /** A copy, so the caller owns what it is handed. */
    private answers(): McqRunAnswer[] {
        const answers: McqRunAnswer[] = [];
        for (const record of this.records) {
            if (record) answers.push({ ...record });
        }
        return answers;
    }
}
