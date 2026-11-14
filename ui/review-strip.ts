import { Menu, setIcon } from 'obsidian';
import { LeechChoice, LeechAction, ReviewAlgorithm, ReviewSessionHost } from '../models/review-flow';
import type { ReviewGradeLayout } from '../models/settings';
import type { DockTab } from './review-dock';

/** The study panel's four views, flattened into the bar's one tab row. */
export type StripStudyView = 'learn' | 'board' | 'mindmap' | 'summary';

const STUDY_VIEWS: ReadonlyArray<[StripStudyView, string]> = [
    ['learn', 'Learn'],
    ['board', 'Visualize'],
    ['mindmap', 'Mind map'],
    ['summary', 'Summary'],
];

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
    /** A short count worn as a badge beside the label ("4", "3 due"). */
    count?: string;
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
    /** e.g. "3d overdue". Shown on the timing's hover once there is a timing. */
    dueLabel: string;
    /**
     * How long this note takes to read, and what is left of the run: the day
     * picked on the calendar (`scope`), or every due note when none was.
     * `left` is null while some notes are still being counted.
     */
    timing?: { note: string; left: string | null; notesLeft: number; scope: string | null } | null;
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
    /**
     * How the grades sit: the reader's setting, applied as a data attribute so
     * the stylesheet owns the three layouts and the bar stays one DOM shape.
     */
    gradeLayout?: ReviewGradeLayout;
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
    tabs?: {
        study: StripTab | null;
        mcq: StripTab | null;
        cards: StripTab | null;
        active: DockTab | null;
        /** Which of the study panel's views is on screen while study is open. */
        view?: StripStudyView | null;
        /** Read aloud, when there is a voice to read with. */
        listen?: { playing: boolean } | null;
    };
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
    /** One of the tabs: a study view, the questions, the card sitting. */
    onTab: (tab: DockTab, view?: StripStudyView) => void;
    /** Read aloud whatever is on screen, or pause what is playing. */
    onListen?: () => void;
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
    /** The keyboard reminders are printed under the header while true. */
    private helpOpen = false;

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

        if (state.phase === 'finished') {
            this.renderFinished(el, state);
            this.renderTabs(el, state);
            return;
        }

        if (state.phase === 'decision' && state.decision) {
            this.renderDecision(el, state.decision);
            return;
        }

        if (state.phase === 'cards') {
            this.renderCardsStep(el, state);
            this.renderTabs(el, state);
            return;
        }

        this.renderGrades(el, state);
        this.renderTabs(el, state);
    }

    /**
     * The header, three things and nothing else:
     *
     *   ▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  where the run is
     *   Cirrhosis Part 1                  ↶  ‹ 5/26 ›  ⋯  ✕
     *   1d overdue · FSRS · new
     *
     * The note's name is the line's subject; the due state and the scheduler
     * sit under it as one quiet sentence. Every control the reader needs on
     * every note is on the right, and everything they need now and then —
     * postpone, skip, where the review lives, the keyboard — is behind ⋯.
     */
    private renderHeader(el: HTMLElement, state: StripState): void {
        // Where the reader is, not how many they have finished: the run's own
        // place (see `ReviewFlowModel.place`) moves by exactly one per step and
        // is already capped at the run's size.
        const total = Math.max(1, state.position.total);
        const at = Math.min(Math.max(1, state.position.place ?? (state.position.index ?? 0) + 1), total);
        const progressBar = el.createDiv({ cls: 'sf-strip-progress-bar' });
        progressBar.setCssProps({ '--sf-strip-progress': `${Math.round((at / total) * 100)}%` });
        progressBar.createDiv({ cls: 'sf-strip-progress-bar-fill' });

        const header = el.createDiv({ cls: 'sf-strip-header' });
        const status = header.createDiv({ cls: 'sf-strip-status' });

        const identity = status.createDiv({ cls: 'sf-strip-group sf-strip-group-identity' });
        const title = identity.createDiv({ cls: 'sf-strip-title', text: state.title });
        title.setAttribute('title', state.meta ? `${state.title} — ${state.meta}` : state.title);

        // One quiet line under the name: the due state when there is one, then
        // the scheduler in its short form. The whole scheduler string, ease and
        // stability included, stays one hover away.
        const [algorithm = '', context = ''] = state.meta.split(' · ');
        const interval = context.replace(/^interval\s+/, '');
        const scheduleText = [algorithm, interval].filter(Boolean).join(' · ');
        const timing = state.timing ?? null;
        if (timing || state.dueLabel || scheduleText) {
            const sub = status.createDiv({ cls: 'sf-strip-sub' });
            if (timing) {
                // "4 min read · 1h 20m left today": what this note costs, then
                // what the rest of the sitting does. The due state moves to the
                // hover — how late a note is changes nothing about reading it.
                const group = sub.createDiv({ cls: 'sf-strip-group sf-strip-group-time' });
                group.createSpan({ cls: 'sf-strip-time-note', text: `${timing.note} read` });
                const where = timing.scope ? `for ${timing.scope}` : 'today';
                const notes = `${timing.notesLeft} note${timing.notesLeft === 1 ? '' : 's'}`;
                group.createSpan({
                    cls: 'sf-strip-time-left',
                    text: timing.left ? `${timing.left} left ${where}` : `${notes} left ${where}`,
                });
                group.setAttribute('title', [
                    `This note: about ${timing.note}`,
                    timing.left ? `Left ${where}: about ${timing.left} across ${notes}` : `Left ${where}: ${notes} (still counting)`,
                    state.dueLabel ? `Due: ${state.dueLabel}` : '',
                ].filter(Boolean).join('\n'));
            } else if (state.dueLabel) {
                const due = sub.createDiv({ cls: 'sf-strip-group sf-strip-group-due' });
                due.createSpan({ cls: 'sf-strip-due', text: state.dueLabel });
            }
            if (scheduleText) {
                const schedule = sub.createDiv({ cls: 'sf-strip-group sf-strip-group-schedule' });
                const meta = schedule.createSpan({ cls: 'sf-strip-meta', text: scheduleText });
                meta.setAttribute('title', state.meta);
            }
        }

        if (state.phase !== 'finished') {
            this.renderSecondary(header, state, at);
        } else {
            // The run is over: the place stays as a fact, with nothing to walk.
            const progress = header.createDiv({ cls: 'sf-strip-progress' });
            progress.createSpan({ cls: 'sf-strip-progress-count', text: this.counterLabel(state, at) });
        }

        // The keyboard reminders, printed only when asked for from the menu.
        if (this.helpOpen && state.hint && state.phase !== 'finished') {
            const help = el.createDiv({ cls: 'sf-strip-help-text', text: state.hint });
            help.setAttribute('title', 'Click to hide');
            help.addEventListener('click', () => {
                this.helpOpen = false;
                help.remove();
            });
        }
    }

    /**
     * One row of tabs for everything the reader can do with this note:
     *
     *   Learn · Visualize · Mind map · Summary · MCQs 4 · Cards 12      🔊
     *
     * The study panel's four views used to be a second row of tabs inside the
     * first one's panel; they are flattened here, so the reader never has to
     * learn that "Visualize" lives under "Study". Pressing the open tab puts
     * the panel away. Read aloud sits at the row's end and reads whatever the
     * open tab is showing.
     */
    private renderTabs(el: HTMLElement, state: StripState): void {
        const tabs = state.tabs;
        if (!tabs || !(tabs.study || tabs.mcq || tabs.cards || tabs.listen)) return;

        const bar = el.createDiv({ cls: 'sf-strip-tabbar' });
        const row = bar.createDiv({ cls: 'sf-strip-tabs' });
        row.setAttribute('role', 'tablist');

        const addTab = (id: DockTab, label: string, title: string, selected: boolean, count: string | undefined, view?: StripStudyView): void => {
            const button = row.createEl('button', {
                cls: `sf-strip-tab sf-strip-tab-${id}${view ? ` sf-strip-tab-view-${view}` : ''}`,
            });
            button.setAttribute('type', 'button');
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.setAttribute('title', title);
            button.toggleClass('is-active', selected);
            button.createSpan({ cls: 'sf-strip-tab-label', text: label });
            if (count) button.createSpan({ cls: 'sf-strip-tab-count', text: count });
            button.addEventListener('click', () => this.handlers.onTab(id, view));
        };

        if (tabs.study) {
            const studyOpen = tabs.active === 'study';
            const openView = tabs.view ?? 'learn';
            for (const [view, label] of STUDY_VIEWS) {
                const learn = view === 'learn';
                addTab(
                    'study',
                    learn ? tabs.study.label : label,
                    learn ? tabs.study.title : `${label} — drawn from this note`,
                    studyOpen && openView === view,
                    learn ? tabs.study.count : undefined,
                    view,
                );
            }
        }
        if (tabs.mcq) addTab('mcq', tabs.mcq.label, tabs.mcq.title, tabs.active === 'mcq', tabs.mcq.count);
        if (tabs.cards) addTab('cards', tabs.cards.label, tabs.cards.title, tabs.active === 'cards', tabs.cards.count);

        if (tabs.listen && this.handlers.onListen) {
            const playing = tabs.listen.playing;
            const label = playing ? 'Pause reading aloud' : 'Read aloud what is on screen';
            const listen = this.iconButton(bar, playing ? 'pause' : 'volume-2', label, () => this.handlers.onListen?.());
            listen.addClass('sf-strip-listen');
            listen.toggleClass('is-playing', playing);
            listen.setAttribute('aria-pressed', String(playing));
        }
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
        grades.setAttribute('data-grade-layout', state.gradeLayout ?? 'auto');
        grades.setAttribute('data-grade-count', String(state.grades.length));
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
            button.setAttribute('title', `${grade.label}${grade.intervalText ? ` — next in ${grade.intervalText}` : ''} · key ${grade.key}`);
            const main = button.createSpan({ cls: 'sf-strip-grade-main' });
            main.createSpan({ cls: 'sf-strip-grade-label', text: grade.label });
            main.createSpan({ cls: 'sf-strip-grade-interval', text: grade.intervalText ?? '' });
            if (suggested) {
                // The percentage belongs in the field it argues for.
                const score = button.createSpan({ cls: 'sf-strip-grade-score', text: percent });
                score.setAttribute('title', `${percent} on the questions — this is the grade your score implies`);
                button.setAttribute('title', `Suggested: ${percent} of the questions were answered correctly, which implies ${suggestion.label}`);
            }
            // Printed for keyboards only; a touch screen never shows it.
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

    /**
     * The controls every note needs: undo (only once there is something to
     * undo), the walk through the queue with the place in it between the
     * arrows, the menu, and the way out.
     */
    private renderSecondary(el: HTMLElement, state: StripState, at: number): void {
        const actions = el.createDiv({ cls: 'sf-strip-secondary' });

        if (state.canUndo) {
            this.addSecondaryButton(actions, 'undo-2', 'Undo last rating (u)', this.handlers.onUndo, true)
                .addClass('sf-strip-undo');
        }

        const nav = actions.createDiv({ cls: 'sf-strip-nav' });
        this.addSecondaryButton(nav, 'chevron-left', 'Previous (b)', this.handlers.onPrevious, true);
        const progress = nav.createDiv({ cls: 'sf-strip-progress' });
        const count = progress.createSpan({ cls: 'sf-strip-progress-count', text: this.counterLabel(state, at) });
        const split = this.counterSplit(state);
        if (split) count.setAttribute('title', split);
        this.addSecondaryButton(nav, 'chevron-right', 'Next (n)', this.handlers.onNext, true);

        this.addSecondaryButton(actions, 'more-horizontal', 'More', (event) => this.showMoreMenu(event), true);
        this.addSecondaryButton(actions, 'x', 'End review (esc)', this.handlers.onEnd, true);
    }

    private addSecondaryButton(container: HTMLElement, iconName: string, title: string, onClick: (event: MouseEvent) => void, enabled: boolean): HTMLButtonElement {
        const button = this.iconButton(container, iconName, title, onClick);
        button.addClass('sf-strip-action');
        button.disabled = !enabled;
        return button;
    }

    /**
     * An icon-only button that draws on every platform.
     *
     * The glyph goes into a span of its own, never straight into the button:
     * Obsidian's mobile stylesheet pads every `button` for touch, and on
     * iPadOS that padding left a 22px button with no room inside it, so
     * WebKit shrank the bare SVG — a flex item with no size of its own — to
     * nothing. The span is a fixed box the stylesheet sizes explicitly.
     */
    private iconButton(container: HTMLElement, iconName: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
        const button = container.createEl('button', { cls: 'sf-strip-icon-button' });
        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', title);
        button.setAttribute('title', title);
        const glyph = button.createSpan({ cls: 'sf-strip-icon' });
        setIcon(glyph, iconName);
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
        const item = (title: string, icon: string, onClick: () => void, checked?: boolean): void => {
            menu.addItem(entry => {
                entry.setTitle(title);
                if (typeof entry.setIcon === 'function') entry.setIcon(icon);
                if (checked !== undefined && typeof entry.setChecked === 'function') entry.setChecked(checked);
                // The app's menu and the test shim both expose onClick; a
                // stand-in without it keeps the item inert rather than breaking.
                if (typeof entry.onClick === 'function') entry.onClick(onClick);
            });
        };

        item('Postpone to tomorrow (p)', 'calendar-clock', () => this.handlers.onPostpone());
        // The escape hatch for a note that failed and stayed due: pass it for
        // this sitting without touching its schedule.
        item('Skip this note (s)', 'skip-forward', () => this.handlers.onSkip());

        if (this.mcqAvailable) {
            menu.addSeparator();
            item('Test with MCQs', 'mcq-quiz', () => this.handlers.onTestWithMCQs());
            item('Generate new MCQs', 'refresh-cw', () => this.handlers.onRegenerateMCQs());
        }

        menu.addSeparator();
        item('Review under the note', 'panel-bottom', () => this.handlers.onHost('note'), this.host === 'note');
        item('Review in a split', 'columns-2', () => this.handlers.onHost('split'), this.host === 'split');
        item('Review in a window', 'picture-in-picture-2', () => this.handlers.onHost('window'), this.host === 'window');
        item('Review in the sidebar', 'panel-right', () => this.handlers.onHost('sidebar'), this.host === 'sidebar');

        if (this.state?.hint) {
            menu.addSeparator();
            item(this.helpOpen ? 'Hide keyboard shortcuts' : 'Keyboard shortcuts', 'keyboard', () => {
                this.helpOpen = !this.helpOpen;
                if (this.state) this.render(this.state);
            });
        }

        menu.addSeparator();
        item('Remove from review schedule', 'trash-2', () => this.handlers.onRemoveFromSchedule());
        menu.showAtMouseEvent(event);
    }
}
