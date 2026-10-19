import { Notice, setIcon } from 'obsidian';
import SpaceforgePlugin from '../main';
import { StudyController } from '../controllers/study-controller';
import { StudyPanel } from './study-panel';
import { McqRunner, McqRunSummary } from './review-mcq-runner';
import { scoreSession, suggestedRating } from '../models/mcq-scoring';
import { ReviewAlgorithm } from '../models/review-flow';
import { MCQSession, MCQSet } from '../models/mcq';
import type { StudySummaryPayload } from '../models/study';

export type DockTab = 'study' | 'mcq' | 'cards';

/**
 * The three panels the dock can hold. One of each, at most, at any time: a tab
 * switch hides and shows them, it never builds a second copy of one.
 */
type PanelKind = 'study' | 'mcq' | 'cards';

/**
 * How a panel of each kind is recognised from the DOM alone.
 *
 * The dock knows its panels by reference, but an interrupted mount — a plugin
 * reload, a rebuilt leaf, a panel whose teardown never ran — can leave one
 * behind with nothing pointing at it. These are the markers used to find those
 * leftovers, so a second copy of a kind is never made on top of one.
 *
 * One simple class per entry: the dock's own tests run against a miniature DOM
 * that matches single-class selectors, and a comma-separated list would pass in
 * Obsidian while finding nothing there.
 */
const PANEL_MARKERS: Record<PanelKind, string[]> = {
    // The study panel mounts *as* its host and adds its own class to it.
    study: ['.sf-study-panel'],
    // The questions panel's states: the runner, the score card, or the note it
    // has no questions for.
    mcq: ['.sf-mcq-runner', '.sf-dock-scorecard', '.sf-dock-empty'],
    // The card sitting adds this to the container it is mounted into.
    cards: ['.sf-deck-host'],
};

/** A grade the learner still has to give, with what the sitting scored. */
interface DockGate {
    source: 'mcq' | 'study';
    score: number;
    detail: string;
    suggested: { rating: number; label: string };
}

/** What the dock tells the bar about a finished sitting. */
export interface DockSuggestion {
    rating: number;
    score: number;
    label: string;
}

/** The Study / MCQs / Cards buttons, drawn by the bar beside the scheduler line. */
export interface DockTabState {
    study: { label: string; title: string } | null;
    mcq: { label: string; title: string } | null;
    /** The card lane's tab; null when the vault has no deck lane to offer. */
    cards: { label: string; title: string } | null;
    active: DockTab | null;
}

/** What the bar and the controller need from the dock. */
export interface ReviewDockHandlers {
    onSuggestion?: (suggestion: DockSuggestion | null) => void;
    onTabs?: (state: DockTabState) => void;
    /** True once the review run has stood on one of the decks' steps. */
    cardsReached?: () => boolean;
    /**
     * The card lane's sitting, once there is one to dock. The dock owns the
     * mount from here: it runs it the first time the cards tab opens, keeps
     * the teardown it returns until the sitting is replaced or the dock goes,
     * and never mounts it twice while the sitting lives.
     */
    cards?: { mount: (container: HTMLElement) => () => void } | null;
}

const MIN_DOCK_HEIGHT = 160;

/**
 * Everything that used to be a window over the note, docked under the review
 * bar: study mode, MCQ sittings and the card lane's sitting in the same slot,
 * plus the grade a finished sitting leaves for the learner to give.
 *
 * A sitting reports what it scored. It does not decide the grade, and it does
 * not move the learner to the next note: both of those are the two things a
 * popup used to do *for* them the moment the last question landed.
 */
export class ReviewDock {
    private plugin: SpaceforgePlugin;
    private controller: StudyController;
    private root: HTMLElement | null = null;
    /** One thin line, and only when there is something to say. */
    private statusEl: HTMLElement | null = null;
    private host: HTMLElement | null = null;
    private inner: HTMLElement | null = null;
    private grip: HTMLElement | null = null;
    /**
     * The questions panel: the runner and the score card both live in it, and
     * it is hidden — never emptied — while another tab is on screen.
     */
    private mcqPanel: HTMLElement | null = null;
    /** The element the study panel mounts *as*; it is the panel's own home. */
    private studyHost: HTMLElement | null = null;
    private panel: StudyPanel | null = null;
    private runner: McqRunner | null = null;
    private unsubscribe: (() => void) | null = null;
    private detachResize: (() => void) | null = null;
    private path: string | null = null;
    /**
     * The note whose sitting has already been taken. Re-rendering the dock must
     * not start another one: the score card is the end of a sitting, and a loop
     * that reopens on every strip tick would leave the bar's own keys (and the
     * learner) pointing at a set of questions nobody asked for.
     */
    private mcqDoneFor: string | null = null;
    /** True while the questions for this note are being prepared. */
    private preparing: string | null = null;
    /**
     * The question-set preparations in flight, one promise per note.
     *
     * A tab click, a sidebar refresh and a layout change all re-render the
     * dock, and every one of those lands in startMcq(): without this, N
     * concurrent calls would each await their own generation and mount their
     * own runner, and only the last would be remembered well enough to ever
     * be torn down.
     */
    private mcqStarts = new Map<string, Promise<void>>();
    /** Kept so a re-render can put the finished card back. */
    private lastScore: { summary: McqRunSummary; score: number; suggestedLabel: string } | null = null;
    private tab: DockTab = 'study';
    private expanded = false;
    private gate: DockGate | null = null;
    /** The panel the cards tab's sitting was mounted into, once it was. */
    private cardsPanel: HTMLElement | null = null;
    /** The teardown the sitting's own mount returned; the dock's to call. */
    private cardsTeardown: (() => void) | null = null;

    private handlers: ReviewDockHandlers;

    constructor(plugin: SpaceforgePlugin, controller: StudyController, handlers: ReviewDockHandlers = {}) {
        this.plugin = plugin;
        this.controller = controller;
        this.handlers = handlers;
    }

    /** Attach under the review bar (moves to the bottom if it already exists). */
    mountInto(container: HTMLElement): void {
        if (!this.root) this.build(container);
        // Re-appending keeps the dock last, under the bar, whenever the bar is
        // re-mounted for a new leaf.
        container.appendChild(this.root as HTMLElement);
        // The handle sizes the whole session block, so it sits at that block's
        // top edge — above the grade row, not tucked below it. The strip is
        // mounted just before this, so it is the thing to sit in front of.
        if (this.grip) {
            const strip = container.querySelector('.sf-strip');
            if (strip) container.insertBefore(this.grip, strip);
            else container.insertBefore(this.grip, container.firstChild);
        }
        // Redundant sittings from a previous plugin instance can be sitting in
        // this area — a reload mid-sitting leaves its markup behind — and the
        // reader must never see two of them. This dock's own sitting is not a
        // leftover: it stays mounted, in the middle of its queue.
        for (const stale of Array.from(this.inner?.querySelectorAll<HTMLElement>('.sf-dock-body.sf-deck-host') ?? [])) {
            if (stale !== this.cardsPanel) stale.remove();
        }
        this.refresh();
        this.applyHeight();
    }

    /** Follow the note the bar is on. */
    setPath(path: string | null): void {
        if (this.path === path) return;
        this.path = path;
        // A sitting belongs to the note it was taken on.
        this.teardownContent();
        this.mcqDoneFor = null;
        this.lastScore = null;
        this.gate = null;
        this.publishSuggestion();
        // An open dock follows the note: a step to the next note is the same
        // sitting, so the panel is rebuilt for the note the bar is now on
        // instead of the dock folding itself away and waiting for a click. A
        // dock that is already closed stays closed.
        if (this.expanded) {
            this.renderContent();
        }
        this.refresh();
    }

    /** Open one of the tabs, or collapse the dock when it is already open. */
    /**
     * True while a question is on screen: the review bar stands its grading
     * shortcuts down then, because the same digits answer the question.
     */
    isAnswering(): boolean {
        return this.tab === 'mcq' && this.runner?.answering === true;
    }

    openTab(tab: DockTab): void {
        if (this.expanded && this.tab === tab) {
            this.setExpanded(false);
            return;
        }
        this.tab = tab;
        this.setExpanded(true);
    }

    /**
     * Hand the dock the card lane's sitting: it fills the cards tab, in the
     * same slot the MCQs render in, and opens it.
     *
     * The mount runs once — here or the next time the tab is opened — and the
     * teardown it returns is kept until a new sitting replaces this one or the
     * dock is destroyed. Switching tabs afterwards only hides the panel: the
     * reader's place in the sitting is worth more than a fresh mount.
     */
    dockCards(cards: { mount: (container: HTMLElement) => () => void }): void {
        this.teardownCards();
        this.handlers.cards = cards;
        this.tab = 'cards';
        this.setExpanded(true);
    }

    /** True while a card sitting is docked here — the cards tab has content. */
    hasCardSitting(): boolean {
        return this.handlers.cards !== null && this.handlers.cards !== undefined;
    }

    /**
     * Bring the card sitting's panel forward, without toggling anything.
     *
     * The cards are a step of the run rather than a destination beside it, so
     * the run's own navigation walks into them: this is the "shown, now" half
     * of that. A tab switch that hides the sitting is still the reader's to
     * make — their place in it survives — but a step the run took must not
     * land on a card nobody can see.
     */
    showCards(): void {
        if (!this.hasCardSitting()) return;
        if (this.expanded && this.tab === 'cards') return;
        this.tab = 'cards';
        this.setExpanded(true);
    }

    /** True while the card sitting's panel is the thing on screen. */
    isShowingCards(): boolean {
        return this.expanded && this.tab === 'cards' && this.hasCardSitting();
    }

    /**
     * The run has walked back onto a note: the dock shows a note's own panel
     * again.
     *
     * The cards are a step of the same run, so leaving their step puts the
     * sitting away the way any tab does — hidden, mounted, and exactly where
     * the reader left it. A dock that is not showing the cards is left alone:
     * a tab the reader chose is theirs.
     */
    showNote(): void {
        if (!this.expanded || this.tab !== 'cards') return;
        this.tab = this.plugin.settings.studyEnabled ? 'study' : 'mcq';
        this.renderContent();
        this.refresh();
    }

    /**
     * True while a card sitting is docked but not the tab on screen.
     *
     * Its surface still listens on the document, so the review bar has to know
     * this: a card nobody can see must not answer the reader's keys.
     */
    isCardSittingHidden(): boolean {
        if (!this.hasCardSitting()) return false;
        return !(this.expanded && this.tab === 'cards');
    }

    /**
     * The sitting ended on its own — its finish screen, or the reader ending it.
     *
     * The dock handed out its panel and was waiting to be told; without this the
     * cards slot would sit there empty, with a tab that had nothing behind it.
     */
    cardsEnded(): void {
        if (!this.hasCardSitting()) return;
        const wasShowing = this.expanded && this.tab === 'cards';
        this.teardownCards();
        if (wasShowing) {
            // Back to the note the reader came from: the cards were a step, not
            // a move.
            this.setExpanded(false);
            this.tab = this.plugin.settings.studyEnabled ? 'study' : 'mcq';
        }
        // The panel is gone: whatever tab is on screen now has to be the one
        // shown, and its own panel is put back if it has one.
        if (this.expanded) this.renderContent();
        this.handlers.onTabs?.(this.tabState());
    }

    isExpanded(): boolean {
        return this.expanded;
    }

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.detachResize?.();
        this.detachResize = null;
        this.teardownContent();
        // The sitting's surface is this dock's panel, so it goes with the dock.
        this.teardownCards();
        this.grip?.remove();
        this.grip = null;
        this.root?.remove();
        this.root = null;
        this.statusEl = null;
        this.host = null;
        this.inner = null;
        this.grip = null;
        this.mcqPanel = null;
        this.studyHost = null;
        this.mcqStarts.clear();
        this.preparing = null;
        this.expanded = false;
    }

    // ------------------------------------------------------------------ build

    private build(container: HTMLElement): void {
        const root = container.createDiv({ cls: 'sf-dock' });
        // The Study / MCQs buttons live on the bar's own identity line now, so
        // the dock itself is only the content: a line of status when there is
        // something to say, and the panel under it.
        this.statusEl = root.createDiv('sf-dock-status');

        this.host = root.createDiv('sf-dock-host');
        this.inner = this.host.createDiv('sf-dock-inner');

        this.grip = this.inner.createDiv('sf-dock-grip');
        // The handle is the dock's top edge: say what it does, since a bare
        // strip of pixels explains nothing.
        this.grip.setAttribute('title', 'Drag to resize · double-click to reset');
        this.grip.addEventListener('dblclick', () => {
            this.plugin.settings.reviewDockHeight = 0;
            void this.plugin.savePluginData();
            this.applyHeight();
        });
        this.attachResize();

        // The panels are not built here: each is made the first time its tab
        // has something to show, and there is exactly one of each.

        this.root = root;
        this.unsubscribe = this.controller.subscribeChart(update => {
            if (update.path !== this.path) return;
            this.refresh(update.message);
        });
    }

    private attachResize(): void {
        const grip = this.grip;
        if (!grip) return;
        let startY = 0;
        let startHeight = 0;

        const onMove = (event: PointerEvent) => {
            const limit = Math.min(Math.round(window.innerHeight * 0.85), Math.max(MIN_DOCK_HEIGHT, Math.round(window.innerHeight - 220)));
            const next = Math.max(MIN_DOCK_HEIGHT, Math.min(limit, startHeight + (startY - event.clientY)));
            // A dragged height is user data; the stylesheet decides what to do with it.
            if (this.inner) this.inner.setCssProps({ '--sf-dock-height': `${next}px` });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            const height = this.inner ? Math.round(this.inner.getBoundingClientRect().height) : 0;
            if (height > 0) {
                this.plugin.settings.reviewDockHeight = height;
                void this.plugin.savePluginData();
            }
        };
        const onDown = (event: PointerEvent) => {
            if (!this.inner) return;
            event.preventDefault();
            startY = event.clientY;
            startHeight = Math.round(this.inner.getBoundingClientRect().height);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        };

        grip.addEventListener('pointerdown', onDown);
        this.detachResize = () => {
            grip.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }

    private applyHeight(): void {
        if (!this.inner) return;
        const stored = this.plugin.settings.reviewDockHeight;
        // Empty removes the property, which is how "size to content" is said. A
        // stored size under the floor is not a size anything is readable through
        // — the drag handle clamps itself at the same floor — so a dock left at
        // two pixels comes back as a dock, not as a hairline.
        const height = stored > 0 ? Math.max(MIN_DOCK_HEIGHT, Math.round(stored)) : 0;
        this.inner.setCssProps({ '--sf-dock-height': height > 0 ? `${height}px` : '' });
    }

    // ------------------------------------------------------------------- state

    private setExpanded(open: boolean): void {
        // A note is what the study and MCQ tabs need; the cards tab is a whole
        // sitting of its own, and it opens the dock wherever it is — a run whose
        // note queue has emptied still hands its cards over.
        if (open && !this.path && !this.hasCardSitting()) return;
        this.expanded = open;
        this.root?.toggleClass('is-open', open);
        this.host?.toggleClass('is-open', open);
        if (open) {
            this.renderContent();
        }
        // Collapsing keeps the content mounted: losing the tutor's place, or a
        // half-answered question, is not what a collapse should mean.
        this.refresh();
    }

    private renderContent(): void {
        if (!this.inner) return;
        // A tab switch hides and shows; it never empties another tab's panel.
        // Each panel is torn down only when its own reason to exist is gone:
        // the note changes, the sitting is handed back, the dock is destroyed.
        this.showPanel('study', this.expanded && this.tab === 'study');
        this.showPanel('mcq', this.expanded && this.tab === 'mcq');
        this.showPanel('cards', this.expanded && this.tab === 'cards');

        if (this.tab === 'cards') {
            // The sitting carries its own content: the dock shows it with or
            // without a note behind it.
            this.mountCards();
            return;
        }
        if (!this.path) return;
        if (this.tab === 'study') {
            this.mountStudy();
            return;
        }
        if (this.mcqDoneFor === this.path && this.lastScore) {
            const { summary, score, suggestedLabel } = this.lastScore;
            this.renderScoreCard(summary, score, suggestedLabel);
            return;
        }
        void this.startMcq();
    }

    /** The panel of a kind, if one has been made. */
    private panelElement(kind: PanelKind): HTMLElement | null {
        if (kind === 'study') return this.studyHost;
        if (kind === 'mcq') return this.mcqPanel;
        return this.cardsPanel;
    }

    /**
     * Show or hide one panel. This is the whole of what a tab switch does to
     * the panels it is not showing.
     */
    private showPanel(kind: PanelKind, show: boolean): void {
        this.panelElement(kind)?.toggleClass('sf-hidden', !show);
        // A hidden runner keeps the sitting's place but lets go of the
        // keyboard: a question nobody can see must not answer the reader's
        // keys, the same rule the card lane states with isCardSittingHidden().
        if (kind === 'mcq') this.runner?.setVisible(show);
    }

    /**
     * Clear the field for a panel of a kind before one is made: anything else
     * in the dock wearing that kind's clothes is debris from a mount that was
     * interrupted — a plugin reload, a rebuilt leaf, a panel whose teardown
     * never ran — and it goes, so there is never a second copy on screen.
     */
    private claimPanel(kind: PanelKind): void {
        const inner = this.inner;
        if (!inner) return;
        for (const selector of PANEL_MARKERS[kind]) {
            for (const marker of Array.from(inner.querySelectorAll<HTMLElement>(selector))) {
                // The panel is the nearest dock body above the marker; for the
                // study panel the marker *is* the panel.
                const panel = marker.closest<HTMLElement>('.sf-dock-body') ?? marker;
                panel.remove();
            }
        }
    }

    /**
     * The questions panel: the runner and the score card live in it.
     *
     * Made on first use and kept — a tab switch hides it, it does not take it
     * away — so the same runner is still there, half-answered, when the reader
     * comes back to the tab.
     */
    private ensureMcqPanel(): HTMLElement | null {
        const inner = this.inner;
        if (!inner) return null;
        if (this.mcqPanel?.isConnected) return this.mcqPanel;
        // A reference to a detached node is not a place to show anything.
        this.teardownMcq();
        this.claimPanel('mcq');
        this.mcqPanel = inner.createDiv('sf-dock-body');
        this.showPanel('mcq', this.expanded && this.tab === 'mcq');
        return this.mcqPanel;
    }

    /**
     * The cards tab's content: the sitting's panel, made on first open.
     *
     * The mount is run exactly once per sitting; a tab switch later only hides
     * or shows the panel it was mounted into.
     */
    private mountCards(): void {
        const panel = this.cardsPanel;
        // A panel that is no longer in the document is not a place to show
        // anything: Obsidian can rebuild the leaf out from under us, and a
        // reference to a detached node would mount the sitting into nothing.
        if (panel && !panel.isConnected) {
            const teardown = this.cardsTeardown;
            this.cardsTeardown = null;
            this.cardsPanel = null;
            teardown?.();
        }
        if (this.cardsPanel) return;
        const cards = this.handlers.cards;
        if (!cards || !this.inner) return;
        this.claimPanel('cards');
        // The same slot the MCQ runner takes: a dock body, so a card sitting
        // reads as part of the bar rather than a window over the note. (The
        // sitting's own `.sf-deck-host` class, added on mount, is what styles
        // it.)
        const host = this.inner.createDiv('sf-dock-body');
        this.cardsPanel = host;
        this.showPanel('cards', this.expanded && this.tab === 'cards');
        this.cardsTeardown = cards.mount(host);
    }

    /**
     * The sitting is over, or the dock is: run the teardown its mount left
     * behind and forget the panel, so the next sitting gets a fresh one.
     */
    private teardownCards(): void {
        const teardown = this.cardsTeardown;
        this.cardsTeardown = null;
        this.handlers.cards = null;
        // The panel is ours, so we take it away: a sitting's own teardown gives
        // back its surface, but an empty panel left behind was a second, third
        // and fourth copy of the sitting's chrome in the dock.
        const panel = this.cardsPanel;
        this.cardsPanel = null;
        teardown?.();
        panel?.remove();
    }

    private mountStudy(): void {
        if (!this.inner || !this.path) return;
        // Same self-heal as the cards panel: a host that is no longer in the
        // document is not a place to teach in.
        if (this.studyHost && !this.studyHost.isConnected) this.teardownStudy();
        if (this.panel) return;
        const path = this.path;
        if (!this.plugin.settings.studyEnabled) {
            new Notice('Study is turned off in Spaceforge settings.');
            return;
        }
        if (!this.controller.planService.getPlan(path)) {
            // Chart first: an uncharted note has nothing to teach yet.
            this.plugin.studyChartQueue?.enqueue(path, true);
            void this.plugin.studyChartQueue?.tick();
        }
        this.claimPanel('study');
        const host = this.inner.createDiv('sf-dock-body');
        this.studyHost = host;
        this.showPanel('study', this.expanded && this.tab === 'study');
        this.panel = new StudyPanel(this.plugin, this.controller, path, {
            compact: true,
            onRequestSpace: () => this.setExpanded(true),
            onSessionEnd: payload => this.afterStudySession(payload),
        });
        this.panel.mount(host);
    }

    /**
     * Ask for the questions for the note on screen, and mount the runner once
     * they arrive.
     *
     * Safe to call any number of times concurrently: a tab click, a sidebar
     * refresh and a layout change all land here, and there is one preparation
     * in flight per note — the late callers join the first promise instead of
     * starting a second generation or a second runner.
     */
    private startMcq(): Promise<void> {
        const path = this.path;
        if (!path || !this.inner || !this.root) return Promise.resolve();
        // One live runner per note, and a finished sitting is not started again
        // by a redraw.
        if (this.runner || this.mcqDoneFor === path) return Promise.resolve();
        const inFlight = this.mcqStarts.get(path);
        if (inFlight) return inFlight;

        const start = this.mintMcq(path);
        const settle = (): void => {
            if (this.mcqStarts.get(path) === start) this.mcqStarts.delete(path);
        };
        // Cleared when it settles — success or failure — so a retry after an
        // error starts a fresh preparation instead of joining a finished one.
        void start.then(settle, settle);
        this.mcqStarts.set(path, start);
        return start;
    }

    /** The actual preparation; the shared promise startMcq() hands out. */
    private async mintMcq(path: string): Promise<void> {
        if (!this.plugin.settings.enableMCQ || !this.plugin.mcqController) {
            new Notice('Questions are turned off in Spaceforge settings.');
            return;
        }
        this.preparing = path;
        if (this.expanded && this.tab === 'mcq') this.setStatus('Preparing questions…');

        let set: MCQSet | null = null;
        try {
            set = await this.plugin.mcqController.ensureMcqSetForNote(path);
        } catch (error) {
            console.error('spaceforge: could not prepare questions for', path, error);
        }
        if (this.preparing === path) this.preparing = null;
        if (this.path === path && this.expanded && this.tab === 'mcq') this.setStatus('');

        // Everything the mount depends on may have moved while the questions
        // were being prepared: another note, another tab, a dock that is gone,
        // or a sibling call that got here first. The dock mounts nothing it is
        // no longer showing — and asking for the tab again asks for the
        // questions again, which by then is a read, not a generation.
        if (this.path !== path || !this.root || !this.inner) return;
        if (this.runner || this.mcqDoneFor === path) return;
        if (!this.expanded || this.tab !== 'mcq') return;

        const panel = this.ensureMcqPanel();
        if (!panel) return;
        panel.empty();
        if (!set || set.questions.length === 0) {
            new Notice('No questions could be prepared for this note.');
            panel.createDiv({ cls: 'sf-dock-empty', text: 'No questions for this note yet.' });
            return;
        }

        const prepared: MCQSet = set;
        this.runner = new McqRunner(this.plugin, path, prepared, {
            onSummary: summary => { void this.finishMcq(summary, prepared); },
        });
        this.runner.mount(panel);
        // A runner that is not the tab on screen answers nothing.
        this.runner.setVisible(this.expanded && this.tab === 'mcq');
    }

    /** A sitting ended: score it, keep the record, then hand the grade over. */
    private async finishMcq(summary: McqRunSummary, set: MCQSet): Promise<void> {
        const score = scoreSession(summary.answers, summary.total, this.plugin.settings);
        const algorithm = this.algorithmFor(summary.notePath);
        const suggestion = suggestedRating(score, algorithm === 'fsrs' ? 'fsrs' : 'sm2');

        await this.saveMcqSession(summary, set, score);

        // The reader may have graded and moved on while the session was being
        // written: a sitting belongs to the note it was taken on, and its score
        // card and grade do not follow the bar to the next note.
        if (this.path !== summary.notePath) return;

        // The runner is spent; the panel stays — the score card is drawn in it.
        this.unmountRunner();
        this.mcqDoneFor = summary.notePath;
        this.lastScore = { summary, score, suggestedLabel: suggestion.label };
        this.renderScoreCard(summary, score, suggestion.label);

        // The score card and the suggestion are all the dock produces: whether
        // the grade lands (settings say so) or waits for the learner is the
        // controller's decision, and it has one grading path for both.
        this.gate = {
            source: 'mcq',
            score,
            detail: `${summary.answered}/${summary.total} answered · ${Math.round(score * 100)}%`,
            suggested: suggestion,
        };
        this.publishSuggestion();
    }

    private async saveMcqSession(summary: McqRunSummary, set: MCQSet, score: number): Promise<void> {
        const controller = this.plugin.mcqController;
        if (!controller) return;
        const session: MCQSession = {
            mcqSetId: `${set.notePath}_${set.generatedAt}`,
            notePath: set.notePath,
            answers: summary.answers.map(answer => ({
                questionIndex: answer.questionIndex,
                selectedAnswerIndex: answer.selectedAnswerIndex,
                correct: answer.correct,
                timeToAnswer: answer.timeToAnswer,
                attempts: answer.attempts,
            })),
            score,
            currentQuestionIndex: summary.total,
            completed: summary.completed,
            startedAt: summary.startedAt,
            completedAt: summary.finishedAt,
        };
        await controller.saveMCQSession(session);
    }

    private afterStudySession(payload: StudySummaryPayload): void {
        void this.plugin.getSidebarView()?.refresh();
        this.refresh();
        if (this.plugin.settings.studyAutoRateNote) return;
        // The session's own result is logged; the grade it implies is offered,
        // not taken.
        const algorithm = this.algorithmFor(payload.notePath);
        const suggestion = suggestedRating(payload.score, algorithm === 'fsrs' ? 'fsrs' : 'sm2');
        this.gate = {
            source: 'study',
            score: payload.score,
            detail: `session score ${Math.round(payload.score * 100)}%`,
            suggested: suggestion,
        };
        this.publishSuggestion();
    }

    // ------------------------------------------------------------- suggestion

    /**
     * A sitting leaves a grade behind: it marks the grade the bar's own row
     * already offers, with its score in the button, rather than printing the
     * same buttons again in a block of its own.
     */
    private publishSuggestion(): void {
        const pending = this.gate;
        this.handlers.onSuggestion?.(pending
            ? { rating: pending.suggested.rating, score: pending.score, label: pending.suggested.label }
            : null);
    }

    /** The suggestion is spent once it has been acted on. */
    clearSuggestion(): void {
        if (!this.gate) return;
        this.gate = null;
        this.publishSuggestion();
    }

    private setStatus(text: string): void {
        const shown = this.expanded ? text : '';
        this.statusEl?.setText(shown);
        this.statusEl?.toggleClass('is-empty', shown === '');
    }

    /** Tell the bar what the two tabs have waiting, and where the line stands. */
    private refresh(message?: string): void {
        const path = this.path;
        if (!this.root) return;
        const studyOn = this.plugin.settings.studyEnabled && !!this.plugin.studyController;
        const mcqOn = this.plugin.settings.enableMCQ && !!this.plugin.mcqController;
        // A card sitting is content on its own: the dock is shown for it too,
        // with or without a note under the bar.
        const hasContent = !!path || this.hasCardSitting();
        this.root.toggleClass('sf-hidden', !hasContent || (!studyOn && !mcqOn));
        this.handlers.onTabs?.(this.tabState());
        if (!path) return;

        const update = this.controller.chartUpdate(path);
        if (this.expanded && this.tab === 'study') {
            const line = message ?? update?.message ?? '';
            const sections = update && update.total > 0 ? ` · ${update.done}/${update.total} sections` : '';
            this.setStatus(`${line}${sections}`);
        } else if (this.expanded && this.tab === 'mcq' && this.preparing === path) {
            // Coming back to the tab while its set is still being written.
            this.setStatus('Preparing questions…');
        } else {
            // No status line belongs to the questions or the cards.
            this.setStatus('');
        }
    }

    /** What the bar prints on its identity line: the tabs, and what each holds. */
    tabState(): DockTabState {
        const path = this.path;
        const studyOn = this.plugin.settings.studyEnabled && !!this.plugin.studyController;
        const mcqOn = this.plugin.settings.enableMCQ && !!this.plugin.mcqController;
        const cards = this.cardsTabState();
        // No note under the bar: the card lane is still a sitting of its own,
        // and it is what the row after a finished queue offers.
        if (!path) return { study: null, mcq: null, cards, active: this.expanded ? this.tab : null };

        // A note's tab row is about the note: the decks' control appears once
        // the run has actually stood on one of their steps — or when a sitting
        // is docked here already, because a panel on screen needs its tab.
        const cardsForNote = (this.handlers.cardsReached?.() || this.hasCardSitting()) ? cards : null;

        let study: DockTabState['study'] = null;
        if (studyOn) {
            const badge = this.controller.studyBadge(path);
            const charting = this.controller.isCharting(path);
            study = {
                label: charting
                    ? 'Study · charting…'
                    : badge.hasPlan
                        ? (badge.due > 0 ? `Study · ${badge.due} due` : `Study · ${badge.total} objective${badge.total === 1 ? '' : 's'}`)
                        : 'Study this note',
                title: badge.hasPlan
                    ? `${badge.mastered}/${badge.total} solid · teach me these objectives here, under the note`
                    : 'Chart this note into objectives and be taught them',
            };
        }

        let mcq: DockTabState['mcq'] = null;
        if (mcqOn) {
            const set = this.plugin.mcqService?.getMCQSetForNote(path) ?? null;
            const count = set?.questions.length ?? 0;
            mcq = {
                label: count > 0 ? `MCQs · ${count}` : 'MCQs',
                title: count > 0
                    ? `Sit ${count} questions on this note, here, under the note`
                    : 'Write questions for this note and sit them here',
            };
        }

        return { study, mcq, cards: cardsForNote, active: this.expanded ? this.tab : null };
    }

    /**
     * The card lane's tab.
     *
     * While a sitting is docked here, the number is the sitting's own: what is
     * left of the queue on screen, so answering a card drops it by one. Only
     * while no sitting is live does it fall back to what the sidebar last
     * counted, and only then while that count is fresh: a number that might be
     * an hour old would be worse than no number. No deck lane means no tab at
     * all.
     */
    private cardsTabState(): DockTabState['cards'] {
        if (!this.plugin.deckSessionController) return null;
        const live = this.liveCardCount();
        if (live !== null) {
            return {
                label: live > 0 ? `Cards · ${live}` : 'Cards',
                title: live > 0
                    ? `${live} card${live === 1 ? '' : 's'} left in the sitting below`
                    : 'The sitting below is done',
            };
        }
        const counted = this.plugin.deckDueCount;
        const at = this.plugin.deckDueCountedAt;
        const due = counted !== null && Date.now() - at < 60_000 ? counted : 0;
        return {
            label: due > 0 ? `Cards · ${due}` : 'Cards',
            title: due > 0
                ? `${due} card${due === 1 ? '' : 's'} due in your decks · opens a card sitting under the bar`
                : 'Your decks · opens a card sitting under the bar',
        };
    }

    /**
     * What the docked sitting still has in it, or null when none is docked.
     *
     * The sitting answers for itself (its summary carries where it has got to,
     * answered cards included) — one number off the deck lane, not a
     * dependency: a lane that cannot answer leaves the sidebar's count to
     * stand.
     */
    private liveCardCount(): number | null {
        if (!this.hasCardSitting()) return null;
        const sitting = this.plugin.deckSessionController as unknown as {
            summary?: () => { total?: number; answered?: number; position?: number } | null;
            currentCard?: () => { total?: number; position?: number } | null;
        } | null;
        const summary = typeof sitting?.summary === 'function' ? sitting.summary() : null;
        const card = typeof sitting?.currentCard === 'function' ? sitting.currentCard() : null;
        const total = Number(card?.total ?? summary?.total);
        if (!Number.isFinite(total) || total <= 0) return null;
        // What the sitting has answered is the honest count of what is left:
        // the sitting's own total is what it set out with plus the cards it has
        // re-queued (a card in learning comes back inside the sitting), so the
        // two lines already mean "left", where a finished sitting reads zero.
        const answered = Number(summary?.answered);
        if (Number.isFinite(answered)) return Math.max(0, Math.round(total) - Math.round(answered));
        // A sitting with only a cursor to give: the card on screen and what
        // follows it.
        const position = Number(card?.position ?? summary?.position);
        if (Number.isFinite(position) && position > 0) return Math.max(0, Math.round(total) - Math.round(position) + 1);
        return null;
    }

    /**
     * A card landed, or the sitting's own count moved: the tab's number is the
     * sitting's, so it is re-read and republished at once rather than waiting
     * for the next unrelated render.
     */
    cardSittingChanged(): void {
        this.handlers.onTabs?.(this.tabState());
    }

    /**
     * The sitting's own summary: what it scored, question by question, and the
     * one way back in. The *grade* is not repeated here — it is marked on the
     * bar's grade row, where the learner is going to press it.
     */
    private renderScoreCard(summary: McqRunSummary, score: number, suggestedLabel: string): void {
        const panel = this.ensureMcqPanel();
        if (!panel) return;
        panel.empty();
        const card = panel.createDiv('sf-dock-scorecard');
        const head = card.createDiv('sf-dock-scorecard-head');
        const icon = head.createSpan('sf-dock-scorecard-icon');
        setIcon(icon, summary.completed ? 'check-circle' : 'circle-slash');
        head.createSpan({
            cls: 'sf-dock-scorecard-score',
            text: `${Math.round(score * 100)}%`,
        });
        const detail = head.createSpan({ cls: 'sf-dock-scorecard-detail' });
        detail.createSpan({ text: `${summary.answered}/${summary.total} answered${summary.completed ? '' : ' · ended early'}` });
        if (suggestedLabel) {
            detail.createSpan({ cls: 'sf-dock-scorecard-hint', text: ` · marked ${suggestedLabel} on the bar above` });
        }

        const dots = card.createDiv('sf-dock-scorecard-dots');
        for (const answer of summary.answers) {
            const dot = dots.createSpan(`sf-dock-scorecard-dot${answer.correct ? ' is-correct' : ' is-wrong'}`);
            dot.setAttribute('title', `Question ${answer.questionIndex + 1}: ${answer.correct ? 'correct' : 'incorrect'}`);
        }
        const restart = card.createEl('button', { cls: 'sf-dock-scorecard-restart', text: 'Sit them again' });
        restart.setAttribute('type', 'button');
        restart.addEventListener('click', () => {
            // The one way back into a finished sitting: asking for it.
            this.mcqDoneFor = null;
            this.lastScore = null;
            this.mcqPanel?.empty();
            void this.startMcq();
        });
    }

    private algorithmFor(path: string | null): ReviewAlgorithm {
        if (!path) return this.plugin.settings.defaultSchedulingAlgorithm === 'fsrs' ? 'fsrs' : 'sm2';
        const schedule = this.plugin.reviewScheduleService.schedules[path];
        return schedule?.schedulingAlgorithm === 'fsrs' ? 'fsrs' : 'sm2';
    }

    /** The study panel and the element it called home. */
    private teardownStudy(): void {
        this.panel?.unmount();
        this.panel = null;
        this.studyHost?.remove();
        this.studyHost = null;
    }

    /** The runner, out of the panel and out of the dock's hands. */
    private unmountRunner(): void {
        this.runner?.unmount();
        this.runner = null;
    }

    /** The questions panel: the runner, the score card, and the panel itself. */
    private teardownMcq(): void {
        this.unmountRunner();
        this.mcqPanel?.remove();
        this.mcqPanel = null;
    }

    /** The note is changing, or the dock is going: every panel goes with it. */
    private teardownContent(): void {
        this.teardownStudy();
        this.teardownMcq();
    }
}
