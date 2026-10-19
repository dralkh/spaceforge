import { Menu, setIcon } from 'obsidian';
import { LeechChoice, LeechAction, ReviewAlgorithm, ReviewSessionHost } from '../models/review-flow';
import type { DockTab } from './review-dock';

export interface StripGradeButton {
    response: number;
    label: string;
    key: string;
    variant: string;
    /** Resulting interval, e.g. "10m" or "4d". Null when it cannot be computed. */
    intervalText: string | null;
}

export interface StripDecision {
    message: string;
    choices: LeechChoice[];
}

/** A Study / MCQs / Cards tab: one entry on the bar's own tab row. */
export interface StripTab {
    label: string;
    title: string;
}

export interface StripState {
    /**
     * What the run is doing. `cards` is the card lane's own step: the sitting
     * itself is open in the dock below, and the bar carries the step's place
     * in the run where the note's grades would be.
     */
    phase: 'reviewing' | 'decision' | 'cards' | 'finished';
    /** Note title (falls back to the path). */
    title: string;
    /** One line of scheduling context under the title. */
    meta: string;
    /** e.g. "3d overdue". */
    dueLabel: string;
    /**
     * Where the run stands. `place` is the number the bar prints — the model's
     * own place in the run, one step at a time — and it is what a caller should
     * hand over; `index` is the cursor's slot in the queue, kept for the
     * fallback and for callers that predate the place.
     */
    position: { handled: number; remaining: number; total: number; index?: number; place?: number };
    /**
     * What the run's queue is made of. A sitting is not only notes: when the
     * decks are holding cards they are steps of the same run, and the counter
     * counts them. Absent for a walk of notes alone, which is what the
     * counter's own wording follows.
     */
    queue?: { notes: number; cards: number } | null;
    algorithm: ReviewAlgorithm;
    grades: StripGradeButton[];
    decision: StripDecision | null;
    canUndo: boolean;
    /**
     * The cards as a step: the line the bar prints for it while the run stands
     * there. The sitting has its own buttons inside the dock, so this is the
     * bar's only word about the step.
     */
    cardsStep?: { label: string; detail: string } | null;
    /**
     * What to do next once the notes are done — the card lane, when the decks
     * are holding something. The bar is the last thing the reader looked at, so
     * this is where the day's other half is offered.
     */
    nextStep?: { label: string; title: string } | null;
    /**
     * The keyboard reminders. They travel with the bar but never sit on the
     * status line: the help affordance carries them on its hover and its label,
     * and prints them under the line only when the reader asks.
     */
    hint: string;
    /**
     * Study / MCQs / Cards: the three ways to work on *this* note. They render
     * as the bar's own tab row — one line, each tab carrying its own count and
     * the open one marked selected — so they read as places to go rather than
     * as more words on the status line. The cards entry comes from the dock
     * like the other two, and is null when the vault has no deck lane.
     */
    tabs?: { study: StripTab | null; mcq: StripTab | null; cards: StripTab | null; active: DockTab | null };
    /**
     * What a finished sitting scored, marked on the grade row itself. The bar
     * already prints the grades, so a sitting highlights the one its score
     * implies (and shows the percentage in that button) instead of opening a
     * second, identical set of buttons to choose from.
     */
    suggestion?: { rating: number; score: number; label: string } | null;
}

export interface ReviewStripHandlers {
    onHost: (host: ReviewSessionHost) => void;
    onGrade: (response: number) => void;
    onSkip: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onPostpone: () => void;
    onUndo: () => void;
    onEnd: () => void;
    onDecision: (action: LeechAction) => void;
    /** One of the three tabs: study, the questions, the card sitting. */
    onTab: (tab: DockTab) => void;
    onTestWithMCQs: () => void;
    onRegenerateMCQs: () => void;
    onRemoveFromSchedule: () => void;
}

/**
 * The docked review bar.
 *
 * It lives inside the note's leaf, below the note content, so the note stays
 * fully visible and scrollable and the controls never cover it. Rendering is a
 * full rebuild per item: the node count is small and it removes any chance of
 * stale grade buttons after the algorithm, queue or settings change.
 */
export class ReviewStrip {
    /** Where the session lives, for the menu's marks. */
    private host: ReviewSessionHost = 'note';
    private element: HTMLElement | null = null;
    private container: HTMLElement | null = null;
    private state: StripState | null = null;
    private handlers: ReviewStripHandlers;
    private mcqAvailable = false;

    constructor(handlers: ReviewStripHandlers) {
        this.handlers = handlers;
    }

    isMounted(): boolean {
        return this.element !== null && this.element.isConnected;
    }

    getElement(): HTMLElement | null {
        return this.element;
    }

    /** Attach the bar at the bottom of a leaf's content area. */
    mountInto(container: HTMLElement): void {
        if (this.element && this.container === container && this.element.isConnected) {
            return; // Already in the right place.
        }
        this.unmount();
        this.container = container;
        this.element = container.createDiv({ cls: 'sf-strip' });
        container.addClass('sf-strip-host');
        if (this.state) this.render(this.state);
    }

    unmount(): void {
        if (this.element) {
            this.element.remove();
        }
        if (this.container) {
            this.container.removeClass('sf-strip-host');
        }
        this.element = null;
        this.container = null;
    }

    setMcqAvailable(available: boolean): void {
        this.mcqAvailable = available;
    }

    render(state: StripState): void {
        this.state = state;
        const el = this.element;
        if (!el) return;

        el.empty();
        el.toggleClass('sf-strip-active', state.phase === 'reviewing' || state.phase === 'cards');
        el.toggleClass('sf-strip-asking', state.phase === 'decision');
        el.toggleClass('sf-strip-done', state.phase === 'finished');

        this.renderHeader(el, state);
        this.renderTabs(el, state);

        if (state.phase === 'finished') {
            this.renderFinished(el, state);
            return;
        }

        if (state.phase === 'decision' && state.decision) {
            this.renderDecision(el, state.decision);
            return;
        }

        if (state.phase === 'cards') {
            this.renderCardsStep(el, state);
            return;
        }

        this.renderGrades(el, state);
    }

    /**
     * The header: the status line, then whatever the reader can do from here.
     *
     * The status is a line of groups — (a) what this is and how far through,
     * (b) the scheduler, (c) the due state when there is one — each its own
     * element, so a narrow host wraps between the groups instead of through the
     * middle of one. The keyboard reminders are not on the line at all: they
     * wait behind the help affordance, where they cost it nothing.
     */
    private renderHeader(el: HTMLElement, state: StripState): void {
        const header = el.createDiv({ cls: 'sf-strip-header' });

        const status = header.createDiv({ cls: 'sf-strip-status' });
        // How far through the queue this sitting is. "0/6 notes" is a fact; a bar
        // is what tells a reader, at a glance and at sidebar width, whether to
        // keep going.
        // Not `.sf-strip-progress`: that class already belongs to the counter's
        // own container, and borrowing it turned "0/6 notes" into a 4px clipped
        // strip the moment the bar's rules landed.
        const progressBar = status.createDiv({ cls: 'sf-strip-progress-bar' });
        // Where the reader is, not how many they have finished. The run's own
        // place is what the bar prints (see `ReviewFlowModel.place`): it moves
        // by exactly one per step — a grade, a skip, Next or Previous alike —
        // and it is already capped at the run's size, so a number can never
        // read past the end of the queue.
        //
        // It used to be computed here as `max(handled, index) + 1`, and that
        // max is what the reader hit as a stuck counter: the handled tally
        // includes whole card series a live sitting marks at once, so once it
        // ran ahead of the walk the number stood still — `7/11 steps` — for
        // every place behind the tally, in both directions.
        const total = Math.max(1, state.position.total);
        const at = Math.min(Math.max(1, state.position.place ?? (state.position.index ?? 0) + 1), total);
        const fraction = total > 0 ? at / total : 0;
        progressBar.setCssProps({ '--sf-strip-progress': `${Math.round(fraction * 100)}%` });
        progressBar.createDiv({ cls: 'sf-strip-progress-bar-fill' });

        // (a) the note and how far through its run: "6/23 · Cell biology".
        const identity = status.createDiv({ cls: 'sf-strip-group sf-strip-group-identity' });
        const progress = identity.createDiv({ cls: 'sf-strip-progress' });
        // Just the count: "3/12" already says how many are left, and the second
        // number was read as a second total.
        // "0/6" alone left the reader guessing what was being counted, so the
        // counter says what it counts — and it counts every step of the run,
        // the notes and the card lane's own steps alike (see counterLabel).
        const count = progress.createSpan({ cls: 'sf-strip-progress-count', text: this.counterLabel(state, at) });
        const split = this.counterSplit(state);
        if (split) count.setAttribute('title', split);
        const title = identity.createDiv({ cls: 'sf-strip-title', text: state.title });
        title.setAttribute('title', state.title);

        // (b) the scheduler, muted: the algorithm, then the interval it is
        // standing on. "interval 6d" says the number twice inside a group that
        // is already a fact, so it prints as "SM-2 · 6d" — and the whole
        // scheduler string, ease and stability and difficulty included, stays
        // on the hover rather than in the line.
        const [algorithm = '', context = ''] = state.meta.split(' · ');
        const interval = context.replace(/^interval\s+/, '');
        const scheduleText = [algorithm, interval].filter(Boolean).join(' · ');
        if (scheduleText) {
            const schedule = status.createDiv({ cls: 'sf-strip-group sf-strip-group-schedule' });
            const meta = schedule.createSpan({ cls: 'sf-strip-meta', text: scheduleText });
            meta.setAttribute('title', state.meta);
        }

        // (c) the due state, said only when there is one to say.
        if (state.dueLabel) {
            const due = status.createDiv({ cls: 'sf-strip-group sf-strip-group-due' });
            due.createSpan({ cls: 'sf-strip-due', text: state.dueLabel });
        }

        header.createDiv({ cls: 'sf-strip-spacer' });

        // Once the run is over, only the run-level actions belong on the bar;
        // the finished panel renders those itself.
        if (state.phase !== 'finished') {
            if (state.hint) this.renderHelp(header, state.hint);
            this.renderSecondary(header, state);
        }
    }

    /**
     * The Study / MCQs / Cards row: real tabs, on a line of their own.
     *
     * Each tab carries its own count inside its own label, the open one is
     * marked selected for the eye and for assistive tech alike, and the row
     * scrolls when the host cannot hold it — a label cut in half is worse than
     * one the reader has to scroll to.
     */
    private renderTabs(el: HTMLElement, state: StripState): void {
        const tabs = state.tabs;
        if (!tabs || !(tabs.study || tabs.mcq || tabs.cards)) return;

        const row = el.createDiv({ cls: 'sf-strip-tabs' });
        row.setAttribute('role', 'tablist');
        // One row, one shape: the card lane is a tab like the other two, so it
        // gets the same clothes and the same active marking.
        for (const id of ['study', 'mcq', 'cards'] as const) {
            const tab = tabs[id];
            if (!tab) continue;
            const selected = tabs.active === id;
            const button = row.createEl('button', { cls: `sf-strip-tab sf-strip-tab-${id}` });
            button.setAttribute('type', 'button');
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.setAttribute('title', tab.title);
            button.toggleClass('is-active', selected);
            button.setText(tab.label);
            button.addEventListener('click', () => this.handlers.onTab(id));
        }
    }

    /**
     * The keyboard reminders, behind one affordance instead of on the line.
     *
     * The keys themselves are unchanged — this only stops the reminder from
     * competing with the status for the reader's eye. Its hover and its label
     * carry the shortcuts for pointer and assistive tech; pressing it prints
     * the same sentence under the line, and pressing it again puts it away.
     * Nothing is rendered until it is asked for, so a re-render can never
     * stack a second copy of it.
     */
    private renderHelp(header: HTMLElement, hint: string): void {
        const help = header.createEl('button', { cls: 'sf-strip-help' });
        help.setAttribute('type', 'button');
        help.setAttribute('title', hint);
        help.setAttribute('aria-label', `Keyboard shortcuts — ${hint}`);
        help.setAttribute('aria-expanded', 'false');
        help.setText('?');
        help.addEventListener('click', (event) => {
            event.preventDefault();
            const shown = header.querySelector<HTMLElement>('.sf-strip-help-text');
            if (shown) {
                shown.remove();
                help.removeClass('is-open');
                help.setAttribute('aria-expanded', 'false');
                return;
            }
            header.createDiv({ cls: 'sf-strip-help-text', text: hint });
            help.addClass('is-open');
            help.setAttribute('aria-expanded', 'true');
        });
    }

    /**
     * The counter's wording.
     *
     * It says what it counts, and it counts everything the run is made of. A
     * queue of notes alone is a queue of notes — "0/6 notes" — but once the
     * card lane's steps are in the same run there is no single noun for both,
     * and printing the notes' count for the whole queue would understate the
     * sitting the reader is in: those steps read as its steps, with the split
     * of them one hover away (see {@link counterSplit}).
     */
    private counterLabel(state: StripState, at: number): string {
        const cards = state.queue?.cards ?? 0;
        return cards > 0 ? `${at}/${state.position.total} steps` : `${at}/${state.position.total} notes`;
    }

    /** What those steps are made of, for the counter's hover. */
    private counterSplit(state: StripState): string {
        const queue = state.queue;
        if (!queue || queue.cards <= 0) return '';
        const notes = `${queue.notes} note${queue.notes === 1 ? '' : 's'}`;
        const cards = `${queue.cards} card${queue.cards === 1 ? '' : 's'}`;
        return `${notes} · ${cards}`;
    }

    /**
     * The card lane's step.
     *
     * The cards are not a tab beside the sitting: they are a step of the run,
     * and when the run walks into them the sitting opens in the dock below.
     * Nothing is drawn where the note's grades were — the card on screen has
     * buttons of its own — so this is the bar's own line for the step.
     */
    private renderCardsStep(el: HTMLElement, state: StripState): void {
        const step = state.cardsStep ?? { label: 'Cards', detail: '' };
        const line = el.createDiv({ cls: 'sf-strip-cards' });
        const icon = line.createSpan({ cls: 'sf-strip-cards-icon' });
        setIcon(icon, 'layers');
        line.createSpan({ cls: 'sf-strip-cards-label', text: step.label });
        if (step.detail) line.createSpan({ cls: 'sf-strip-cards-detail', text: step.detail });
    }

    private renderGrades(el: HTMLElement, state: StripState): void {
        const grades = el.createDiv({ cls: 'sf-strip-grades' });
        const suggestion = state.suggestion ?? null;
        const percent = suggestion ? `${Math.round(suggestion.score * 100)}%` : '';

        for (const grade of state.grades) {
            const suggested = suggestion !== null && suggestion.rating === grade.response;
            const button = grades.createEl('button', {
                cls: `sf-strip-grade sf-strip-grade-${grade.variant}${suggested ? ' is-suggested' : ''}`,
            });
            button.setAttribute('type', 'button');
            button.setAttribute('aria-label', suggested
                ? `${grade.label} (${grade.key}) — the score suggests this grade, ${percent}`
                : `${grade.label} (${grade.key})`);
            const main = button.createSpan({ cls: 'sf-strip-grade-main' });
            main.createSpan({ cls: 'sf-strip-grade-label', text: grade.label });
            main.createSpan({ cls: 'sf-strip-grade-interval', text: grade.intervalText ?? '' });
            if (suggested) {
                // The percentage belongs in the field it argues for.
                const score = button.createSpan({ cls: 'sf-strip-grade-score', text: percent });
                score.setAttribute('title', `${percent} on the questions — this is the grade your score implies`);
                button.setAttribute('title', `Suggested: ${percent} of the questions were answered correctly, which implies ${suggestion.label}`);
            }
            button.createSpan({ cls: 'sf-strip-grade-key', text: grade.key });
            button.addEventListener('click', () => this.handlers.onGrade(grade.response));
        }
    }

    private renderDecision(el: HTMLElement, decision: StripDecision): void {
        const panel = el.createDiv({ cls: 'sf-strip-decision' });
        const text = panel.createDiv({ cls: 'sf-strip-decision-text' });
        const icon = text.createSpan({ cls: 'sf-strip-decision-icon' });
        setIcon(icon, 'alert-triangle');
        text.createSpan({ text: decision.message });

        const actions = panel.createDiv({ cls: 'sf-strip-decision-actions' });
        for (const choice of decision.choices) {
            const button = actions.createEl('button', { cls: `sf-strip-decision-button${choice.primary ? ' mod-cta' : ''}` });
            button.setAttribute('type', 'button');
            button.createSpan({ text: choice.label });
            button.setAttribute('title', choice.description);
            button.addEventListener('click', () => this.handlers.onDecision(choice.action));
        }
    }

    private renderFinished(el: HTMLElement, state: StripState): void {
        const done = el.createDiv({ cls: 'sf-strip-finished' });
        const line = done.createDiv({ cls: 'sf-strip-finished-line' });
        const icon = line.createSpan({ cls: 'sf-strip-finished-icon' });
        setIcon(icon, 'check-circle');
        // With cards waiting, the queue ending is not an ending: the sitting is
        // already opening below, and the bar just says where the notes got to.
        // A run that carried the card lane's own steps says both, because they
        // were steps of this sitting: six notes plus six cards was twelve
        // things, and calling them twelve notes would be a lie.
        const queue = state.queue ?? null;
        const handled = queue && queue.cards > 0
            ? `${queue.notes} note${queue.notes === 1 ? '' : 's'} and ${queue.cards} card${queue.cards === 1 ? '' : 's'} handled`
            : `${state.position.handled} note${state.position.handled === 1 ? '' : 's'} handled`;
        line.createSpan({
            text: state.nextStep ? `Notes done — ${handled}` : `Review session complete — ${handled}`,
        });

        // The notes are done; the decks are the day's other half. Offered here,
        // where the reader is standing, rather than a sentence pointing at a
        // list somewhere else.
        const next = state.nextStep;
        if (next) {
            const handoff = done.createDiv({ cls: 'sf-strip-next' });
            const go = handoff.createEl('button', { cls: 'sf-strip-next-button' });
            go.setAttribute('type', 'button');
            go.setAttribute('title', next.title);
            const glyph = go.createSpan({ cls: 'sf-strip-next-icon' });
            setIcon(glyph, 'layers');
            go.createSpan({ text: next.label });
            go.addEventListener('click', () => this.handlers.onTab('cards'));
        }

        const actions = done.createDiv({ cls: 'sf-strip-secondary' });
        this.addSecondaryButton(actions, 'undo-2', 'Undo last rating (u)', this.handlers.onUndo, state.canUndo);
        this.addSecondaryButton(actions, 'x', 'End review session (esc)', this.handlers.onEnd, true);
    }

    private renderSecondary(el: HTMLElement, state: StripState): void {
        const actions = el.createDiv({ cls: 'sf-strip-secondary' });

        this.addSecondaryButton(actions, 'undo-2', 'Undo last rating (u)', this.handlers.onUndo, state.canUndo);
        // Navigation, the same as the list's own Previous/Next: the bar walks
        // the queue, it does not decide anything about the note.
        this.addSecondaryButton(actions, 'chevron-left', 'Previous note (b)', this.handlers.onPrevious, true);
        this.addSecondaryButton(actions, 'chevron-right', 'Next note (n)', this.handlers.onNext, true);
        this.addSecondaryButton(actions, 'calendar-clock', 'Postpone one day (p)', this.handlers.onPostpone, true);
        this.addSecondaryButton(actions, 'more-horizontal', 'More actions', (event) => this.showMoreMenu(event), true);
        this.addSecondaryButton(actions, 'x', 'End review session (esc)', this.handlers.onEnd, true);
    }

    private addSecondaryButton(container: HTMLElement, iconName: string, title: string, onClick: (event: MouseEvent) => void, enabled: boolean): HTMLButtonElement {
        const button = container.createEl('button', { cls: 'sf-strip-action' });
        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', title);
        button.setAttribute('title', title);
        setIcon(button, iconName);
        button.disabled = !enabled;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            onClick(event);
        });
        return button;
    }

    /** Remember where the session lives, so the menu can mark the current home. */
    setHost(host: ReviewSessionHost): void {
        this.host = host;
    }

    private showMoreMenu(event: MouseEvent): void {
        const menu = new Menu();
        if (this.mcqAvailable) {
            menu.addItem(item => item
                .setTitle('Test with MCQs')
                .setIcon('mcq-quiz')
                .onClick(() => this.handlers.onTestWithMCQs()));
            menu.addItem(item => item
                .setTitle('Generate new MCQs')
                .setIcon('refresh-cw')
                .onClick(() => this.handlers.onRegenerateMCQs()));
        }
        // The bar's own buttons navigate, so the escape hatch for a note that
        // failed and stayed due lives here: pass it for this sitting without
        // touching its schedule.
        menu.addItem(item => {
            item.setTitle('Skip this note (s)');
            // The app's menu and the test shim both expose onClick; a stand-in
            // without it keeps the item inert rather than breaking the menu.
            if (typeof item.onClick === 'function') item.onClick(() => this.handlers.onSkip());
        });
        menu.addItem(item => item
            .setTitle('Keep the review under the note')
            .setIcon('panel-bottom')
            .setChecked(this.host === 'note')
            .onClick(() => this.handlers.onHost('note')));
        menu.addItem(item => item
            .setTitle('Move the review into a window')
            .setIcon('picture-in-picture-2')
            .setChecked(this.host === 'window')
            .onClick(() => this.handlers.onHost('window')));
        menu.addItem(item => item
            .setTitle('Move the review into the sidebar')
            .setIcon('panel-right')
            .setChecked(this.host === 'sidebar')
            .onClick(() => this.handlers.onHost('sidebar')));

        menu.addSeparator();
        menu.addItem(item => item
            .setTitle('Remove from review schedule')
            .setIcon('trash-2')
            .onClick(() => this.handlers.onRemoveFromSchedule()));
        menu.showAtMouseEvent(event);
    }
}
