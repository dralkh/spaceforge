/**
 * A deck sitting: the reader studies a deck of cards, one card at a time.
 *
 * This is a lane of its own. Nothing here touches the note scheduler: a deck's
 * cards are scheduled per card, per deck, with Anki's own rules (see
 * models/anki-scheduler.ts), and a deck that came from Anki keeps the due dates
 * it arrived with.
 *
 * The sitting opens under the review bar when one is up — the same slot the
 * MCQs render in — and otherwise in a split or in a window of its own,
 * following the same setting the note review bar follows, so a reader who
 * wants their cards on a second monitor does not have to find a second
 * setting.
 */

import { Notice, TFile, WorkspaceLeaf } from 'obsidian';

import type SpaceforgePlugin from '../main';
import { AnkiCard, AnkiCardQueue, AnkiGrade, AnkiId, AnkiNote, AnswerResult, DeckBundle, DeckScheduler } from '../models/anki';
import { answerCard, answerFsrs, burySiblings, buildQueue, dueCounts, intervalPreview } from '../models/anki-scheduler';
import { CardView, isClozeNote, resolvePresentation } from '../models/card-presentation';
import { DeckSummary, DeckStore } from '../services/deck-store';
import {
    CardEditorConclusion,
    CardEditorHost,
    CardEditorRequest,
    CardEditorSave,
    CardEditorState,
    QuestionKind,
    draftFieldsFor,
    mintCardsFromDraft,
} from '../ui/card-editor-panel';
import { DeckSessionSummary, DeckSessionView } from '../ui/deck-session-view';
import { displayDeckName } from '../utils/deck-display';
import { deckDayBase } from '../utils/dates';

/** One card, ready to be shown, with everything the bar and the buttons need. */
export interface DeckSessionCard {
    card: AnkiCard;
    /** The deck this card belongs to; a combined sitting mixes several. */
    deckName: string;
    view: CardView;
    /** What each of the four grades would do to this card. */
    preview: ReturnType<typeof intervalPreview>;
    /** Where this card sits in the sitting, for the progress line. */
    position: number;
    total: number;
    /** How many cards the deck has in each queue right now. */
    counts: ReturnType<typeof dueCounts>;
}

export interface DeckSessionHandlers {
    onGrade: (grade: AnkiGrade) => void;
    onChoose: (index: number, correct: boolean) => void;
    onSkip: () => void;
    onEnd: () => void;
    onRebuild: () => void;
    /** Edit the card on screen, in place (the card's own Edit control). */
    onEditCard?: () => void;
    /** Write a new card into this sitting's deck, in place (the bar's Add). */
    onNewCard?: () => void;
}

/** How far ahead a card in learning may be shown again, as in Anki. */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

/** True for a card whose next step is inside today (learning or relearning). */
function isIntradayLearning(card: AnkiCard): boolean {
    return card.queue === AnkiCardQueue.Learning;
}

/**
 * The kind of question a card asks, in the editor's vocabulary.
 *
 * A typed card says so on its own presentation; a cloze card is the markers in
 * its text, or the presentation an imported card carried; everything else is a
 * plain flip card — which covers "and reversed" notes, because the reversal is
 * a second card of the same note rather than a different kind of field.
 */
function questionKindOf(note: AnkiNote, card: AnkiCard): QuestionKind {
    if (card.presentation?.mode === 'type') return 'typed';
    if (card.presentation?.mode === 'cloze' || isClozeNote(note)) return 'cloze';
    return 'basic';
}

export class DeckSessionController {
    private plugin: SpaceforgePlugin;
    private store: DeckStore;
    private view: DeckSessionView | null = null;
    private leaf: WorkspaceLeaf | null = null;
    private popoutLeaf: WorkspaceLeaf | null = null;
    /**
     * True while this sitting exists only to write a card: it was opened by the
     * editor (from the sidebar's row, say) with nothing in its queue, so when
     * the editor closes without a card behind it, the sitting goes too.
     */
    private composing = false;

    /** The deck the card on screen came from. */
    private deckPath: string | null = null;
    private bundle: DeckBundle | null = null;
    /** Every deck in this sitting: one normally, all of them for "everything due". */
    private decks = new Map<string, DeckBundle>();
    /** Which deck each card in play belongs to, so an answer lands in its own file. */
    private cardDeck = new Map<AnkiId, string>();
    private queue: AnkiCard[] = [];
    private current: DeckSessionCard | null = null;
    /** Where each deck of this sitting was left, kept while it runs. */
    private deckState = new Map<string, { bundle: DeckBundle; queue: AnkiCard[]; current: DeckSessionCard | null }>();
    /** What was answered in this sitting, so the summary is honest about it. */
    private answered = new Map<AnkiId, AnkiGrade>();
    /** Multiple-choice picks, for the grade the sitting suggests at the end. */
    private picks = new Map<AnkiId, { index: number; correct: boolean }>();
    private startedAt = 0;
    /** How a surface is made; a test replaces this with a stand-in. */
    private createView: (handlers: DeckSessionHandlers) => DeckSessionView;
    /** The teardown the current surface's mount returned, when one owns it. */
    private viewTeardown: (() => void) | null = null;

    constructor(
        plugin: SpaceforgePlugin,
        store: DeckStore,
        options: { createView?: (handlers: DeckSessionHandlers) => DeckSessionView } = {},
    ) {
        this.plugin = plugin;
        this.store = store;
        this.createView = options.createView ?? (handlers => new DeckSessionView(plugin, handlers));
    }

    /** True while a deck sitting is on screen, so other surfaces can stand down. */
    /** The deck the sitting is on, so a caller can tell one deck from the next. */
    currentDeckPath(): string | null {
        return this.deckPath;
    }

    /**
     * Move a live sitting to another deck without losing the sitting.
     *
     * The review run walks its queue deck by deck, so stepping from one deck's
     * step to the next is the same sitting: where the reader was in each deck,
     * and every card they have answered, come with them. Starting over instead
     * would lose the answers and re-ask cards already done.
     */
    async switchDeck(deckPath: string): Promise<void> {
        if (!this.isActive() || this.deckPath === deckPath) {
            await this.start(deckPath);
            return;
        }
        // What the deck being left was in the middle of.
        if (this.deckPath && this.bundle) {
            this.deckState.set(this.deckPath, {
                bundle: this.bundle,
                queue: this.queue,
                current: this.current,
            });
        }
        const answered = new Map(this.answered);
        const picks = new Map(this.picks);
        const startedAt = this.startedAt;
        await this.start(deckPath);
        const kept = this.deckState.get(deckPath);
        if (kept) {
            this.bundle = kept.bundle;
            this.queue = kept.queue;
            this.current = kept.current;
            for (const card of this.queue) this.cardDeck.set(card.id, deckPath);
        }
        // The answers are the sitting's, not the deck's.
        this.answered = answered;
        this.picks = picks;
        this.startedAt = startedAt;
        if (this.current) this.view?.show(this.current, this.summary());
    }

    isActive(): boolean {
        return this.view !== null;
    }

    /** The card on screen, for a status line or a test. */
    currentCard(): DeckSessionCard | null {
        return this.current;
    }

    /**
     * Open a deck and study it.
     *
     * The queue is built the way Anki builds it — cards in learning that are
     * due, then reviews in due order, then new cards, each capped by the deck's
     * own daily limits — and every answer rewrites only that card's state line
     * in the deck file, so a sitting interrupted halfway loses nothing.
     */
    async start(deckPath: string, options: { fromCardId?: AnkiId } = {}): Promise<void> {
        const bundle = await this.store.readDeck(deckPath);
        this.composing = false;
        this.deckPath = deckPath;
        this.bundle = bundle;
        this.decks = new Map([[deckPath, bundle]]);
        this.cardDeck.clear();
        this.answered.clear();
        this.picks.clear();
        this.startedAt = Date.now();

        const now = Date.now();
        const dayBase = this.dayBase(bundle);
        this.queue = buildQueue(bundle.cards, bundle.deck.options, now, dayBase, undefined, bundle.deck.id);
        for (const card of this.queue) this.cardDeck.set(card.id, deckPath);

        // Opening on a chosen card: the reader clicked that question, so it is
        // the one they get — the rest of the deck follows in its own order.
        const from = options.fromCardId;
        if (from !== undefined) {
            const at = this.queue.findIndex(card => card.id === from);
            if (at > 0) this.queue.unshift(...this.queue.splice(at, 1));
            else if (at < 0) {
                // Not in today's queue (a card that is not due, or suspended):
                // show it anyway, because the reader asked for it by name.
                const card = bundle.cards.find(entry => entry.id === from);
                if (card) this.queue.unshift(card);
            }
        }

        if (this.queue.length === 0) {
            const counts = dueCounts(bundle.cards, bundle.deck.options, now, dayBase);
            const waiting = counts.totalCards === 0
                ? 'has no cards yet.'
                : `has nothing due right now (${counts.newCount} new, ${counts.reviewCount} to review).`;
            new Notice(`"${displayDeckName(bundle.deck.name)}" ${waiting}`);
            // Only a sitting that is not there gets torn down: asking for a deck
            // with nothing due must not end the one the reader is in.
            if (!this.isActive()) this.teardown();
            return;
        }

        // A sitting left earlier comes back where it stopped, not from the top.
        this.resumeSavedSitting(deckPath);

        await this.mount();
        this.advance();
    }

    /**
     * Study everything that is due, across every deck at once.
     *
     * This is Anki's parent-deck behaviour: one sitting, one queue, whatever the
     * cards came from — so a reader with five decks does not have to visit five
     * of them to clear a day. The decks are interleaved rather than laid end to
     * end, so a large deck cannot bury a small one, and each answer still lands
     * in its own deck's file.
     */
    async startAllDue(): Promise<void> {
        const summaries = await this.store.listDecks();
        const now = Date.now();
        const queues: { path: string; bundle: DeckBundle; cards: AnkiCard[] }[] = [];

        for (const summary of summaries) {
            let bundle: DeckBundle;
            try {
                bundle = await this.store.readDeck(summary.path);
            } catch (error) {
                console.error(`spaceforge: could not read ${summary.path} for a combined sitting`, error);
                continue;
            }
            const dayBase = this.dayBase(bundle);
            const cards = buildQueue(bundle.cards, bundle.deck.options, now, dayBase, undefined, bundle.deck.id);
            if (cards.length > 0) queues.push({ path: summary.path, bundle, cards });
        }

        if (queues.length === 0) {
            new Notice(summaries.length === 0
                ? 'No decks to study yet.'
                : 'Nothing is due in your decks right now.');
            // As in start(): an empty answer to "everything due" does not end a
            // sitting that is already running.
            if (!this.isActive()) this.teardown();
            return;
        }

        // Round-robin: learning first within each deck, decks taking turns.
        const largest = Math.max(...queues.map(entry => entry.cards.length));
        const interleaved: AnkiCard[] = [];
        for (let round = 0; round < largest; round++) {
            for (const entry of queues) {
                const card = entry.cards[round];
                if (card) interleaved.push(card);
            }
        }

        this.decks = new Map(queues.map(entry => [entry.path, entry.bundle]));
        this.cardDeck.clear();
        this.composing = false;
        for (const entry of queues) {
            for (const card of entry.cards) this.cardDeck.set(card.id, entry.path);
        }
        this.queue = interleaved;
        this.deckPath = queues[0].path;
        this.bundle = queues[0].bundle;
        this.answered.clear();
        this.picks.clear();
        this.startedAt = now;

        await this.mount();
        this.advance();
    }

    /** Answer the card on screen. */
    async answer(grade: AnkiGrade): Promise<AnswerResult | null> {
        const current = this.current;
        const path = this.cardDeck.get(current?.card.id ?? '') ?? this.deckPath;
        const bundle = (path ? this.decks.get(path) : null) ?? this.bundle;
        if (!current || !bundle || !path) return null;

        const now = Date.now();
        const dayBase = this.dayBase(bundle);
        const options = bundle.deck.options;
        const result = options.scheduler === DeckScheduler.Fsrs
            ? answerFsrs(current.card, options, grade, now, options.fsrs, dayBase)
            : answerCard(current.card, options, grade, now, dayBase);

        this.replaceCard(bundle, result.card);
        this.answered.set(result.card.id, grade);
        await this.store.updateCardStates(path, [result.card]);

        // A sibling of the card just answered waits until tomorrow, as in Anki.
        const buried = burySiblings(bundle.cards, result.card, options, now, dayBase);
        if (buried.length > 0) {
            this.queue = this.queue.filter(card => !buried.includes(card.id));
            await this.store.updateCardStates(path, bundle.cards.filter(card => buried.includes(card.id)));
        }

        this.queue = this.queue.filter(card => card.id !== result.card.id);
        // A card that is still in learning comes back inside this sitting, which
        // is what a step of "1m" means to a reader — it goes to the back, so the
        // rest of the deck fills the wait (Anki's learn-ahead limit, 20 minutes).
        if (isIntradayLearning(result.card) && result.card.due - now <= LEARN_AHEAD_MS) {
            this.queue.push(result.card);
        }
        this.advance();
        return result;
    }

    /** Put the card back at the end of the queue without touching its schedule. */
    skip(): void {
        const current = this.current;
        if (!current) return;
        // Off the front first: pushing it back while it is still at the head of
        // the queue would hand the reader the same card again, for ever.
        this.queue = this.queue.filter(card => card.id !== current.card.id);
        this.queue.push(current.card);
        this.advance();
    }

    /** End the sitting: everything answered is already written; say what happened. */
    end(): void {
        this.deckState.clear();
        const deckName = this.bundle ? displayDeckName(this.bundle.deck.name) : 'the deck';
        const answered = this.answered.size;
        // A sitting the reader ended is finished: nothing to come back to.
        this.clearSavedSitting();
        this.teardown();

        if (answered > 0) {
            const minutes = Math.max(1, Math.round((Date.now() - this.startedAt) / 60_000));
            new Notice(`Studied ${answered} card${answered === 1 ? '' : 's'} from "${deckName}" in ${minutes} min.`);
        } else {
            new Notice(`Left "${deckName}" as it was.`);
        }
    }

    /**
     * Re-read the deck and rebuild the queue (after an edit, say).
     *
     * A rebuild is not a new sitting: what has already been answered stays
     * counted, because it was answered.
     */
    async rebuild(): Promise<void> {
        const path = this.deckPath;
        if (!path) return;
        const answered = new Map(this.answered);
        const picks = new Map(this.picks);
        const startedAt = this.startedAt;
        // A combined sitting rebuilds as one: rebuilding only the deck of the
        // card on screen would quietly drop the other decks from the queue.
        if (this.decks.size > 1) await this.startAllDue();
        else await this.start(path);
        this.answered = answered;
        this.picks = picks;
        this.startedAt = startedAt;
    }

    /** What the bar shows about the sitting as a whole. */
    summary(): DeckSessionSummary | null {
        const bundle = this.bundle;
        if (!bundle) return null;
        const current = this.current;
        return {
            deckName: this.decks.size > 1 ? 'your decks' : displayDeckName(bundle.deck.name),
            deckCount: this.decks.size,
            position: current?.position ?? this.answered.size,
            total: current?.total ?? this.answered.size,
            answered: this.answered.size,
            correct: [...this.picks.values()].filter(pick => pick.correct).length,
            picks: this.picks.size,
            // The other lane, so the finish screen can offer the way back rather
            // than leaving the reader at a full stop. Counted off the live
            // schedules rather than the review controller's cached list: a note
            // that came due while the cards were up is exactly the one worth
            // offering, and the cache would not know about it yet.
            notesWaiting: this.plugin.reviewScheduleService.getDueNotes().length,
        };
    }

    /** Plugin unload: no notices, no writes. */
    destroy(): void {
        this.teardown();
        this.leaf = null;
        this.popoutLeaf = null;
    }

    // -------------------------------------------------------------- internals

    /** Anki counts its days from the collection's creation; see {@link deckDayBase}. */
    private dayBase(bundle: DeckBundle): number {
        const created = bundle.extra?.crt;
        return deckDayBase(bundle.deck.id, typeof created === 'number' ? created : null);
    }

    private replaceCard(bundle: DeckBundle, card: AnkiCard): void {
        const at = bundle.cards.findIndex(entry => entry.id === card.id);
        if (at >= 0) bundle.cards[at] = card;
    }

    /** Take the next card, or finish the sitting. */
    private advance(): void {
        const bundle = this.bundle;
        if (!bundle) return;

        for (;;) {
            while (this.queue.length > 0) {
                const card = this.queue[0];
                const owner = this.cardDeck.get(card.id) ?? this.deckPath;
                const own = owner ? this.decks.get(owner) ?? bundle : bundle;
                const note = own.notes.find(entry => entry.id === card.noteId);
                if (!note) {
                    this.queue.shift();
                    continue;
                }
                const now = Date.now();
                const dayBase = this.dayBase(own);
                // The card's own deck is the one an answer belongs to, so the
                // helper fields follow the card rather than the sitting.
                this.deckPath = owner ?? this.deckPath;
                this.bundle = own;
                this.current = {
                    card,
                    deckName: displayDeckName(own.deck.name),
                    view: resolvePresentation(note, card),
                    preview: intervalPreview(card, own.deck.options, now, dayBase),
                    position: this.answered.size + 1,
                    total: this.answered.size + this.queue.length,
                    counts: dueCounts(own.cards, own.deck.options, now, dayBase),
                };
                this.view?.show(this.current, this.summary());
                // Every card that reaches the screen is the sitting's position:
                // saving it here means the pane can close at any point.
                this.persistSitting();
                return;
            }

            // Nothing left in the queue — but a card that came back for a short step
            // is due within the learn-ahead window, and a reader who answered it a
            // minute ago expects to see it again rather than to be told they are
            // done. Anki's own scheduler does the same.
            if (this.regather()) continue;
            break;
        }

        this.current = null;
        this.view?.finish(this.summary());
    }

    /**
     * Save where the sitting is: the queue by card id, and the card on screen.
     *
     * The state rides in the plugin's own data, so closing the pane, switching
     * the sidebar tab or reloading the app resumes the sitting rather than
     * starting it over. Cards that are gone by the time it is read back are
     * dropped on the way in.
     */
    private persistSitting(): void {
        const cardIds = this.queue.map(card => card.id);
        const currentId = this.current?.card.id ?? null;
        const state = this.plugin.pluginState;
        // A stand-in shell (the test harness) has no data store.
        if (!state) return;
        const previous = state.deckSitting ?? null;
        if (previous && previous.currentId === currentId && previous.cardIds.join(',') === cardIds.join(',')) return;
        state.deckSitting = {
            deckPath: this.decks.size > 1 ? null : this.deckPath,
            cardIds,
            currentId,
            savedAt: Date.now(),
        };
        void this.plugin.savePluginData();
    }

    /** Forget the saved sitting: the reader ended it, or it could not be used. */
    private clearSavedSitting(): void {
        const state = this.plugin.pluginState;
        if (state?.deckSitting) {
            state.deckSitting = null;
            void this.plugin.savePluginData();
        }
    }

    /**
     * Resume the deck's saved sitting: the saved order first, minus anything
     * that is no longer in play, with the card that was on screen at its head.
     *
     * Never throws and never blocks a start: a save that cannot be used — a stale
     * path, an empty queue — is simply cleared, and the deck starts fresh.
     */
    private resumeSavedSitting(deckPath: string): void {
        const saved = this.plugin.pluginState?.deckSitting ?? null;
        if (!saved || saved.deckPath !== deckPath) return;
        try {
            const inQueue = new Map(this.queue.map(card => [card.id, card]));
            const ordered = (saved.cardIds ?? [])
                .map(id => inQueue.get(id))
                .filter((card): card is AnkiCard => card !== undefined);
            if (ordered.length === 0) {
                this.clearSavedSitting();
                return;
            }
            const seen = new Set(ordered.map(card => card.id));
            const rest = this.queue.filter(card => !seen.has(card.id));
            this.queue = [...ordered, ...rest];

            // The card that was on screen is the one that comes up again.
            const currentId = saved.currentId;
            if (currentId) {
                const at = this.queue.findIndex(card => card.id === currentId);
                if (at > 0) this.queue.unshift(...this.queue.splice(at, 1));
            }
        } catch (error) {
            console.error('spaceforge: could not resume the saved sitting', error);
            this.clearSavedSitting();
        }
    }

    /**
     * Put the deck's currently-due cards back into the queue. Returns true when
     * anything was added, in which case the sitting carries on.
     */
    private regather(): boolean {
        const now = Date.now();
        const due: AnkiCard[] = [];
        for (const [path, bundle] of this.decks) {
            const dayBase = this.dayBase(bundle);
            const cards = buildQueue(bundle.cards, bundle.deck.options, now, dayBase, undefined, bundle.deck.id);
            for (const card of cards) {
                this.cardDeck.set(card.id, path);
                due.push(card);
            }
        }
        if (due.length === 0) return false;
        const known = new Set(this.queue.map(card => card.id));
        const answered = new Set(this.answered.keys());
        const returning = due.filter(card =>
            !known.has(card.id)
            && !answered.has(card.id)
            && card.queue === AnkiCardQueue.Learning
            && card.due - now <= LEARN_AHEAD_MS,
        );
        if (returning.length === 0) return false;
        this.queue.push(...returning);
        return true;
    }

    private handlers(): DeckSessionHandlers {
        return {
            onGrade: grade => void this.answer(grade),
            onChoose: (index, correct) => this.recordChoice(index, correct),
            onSkip: () => this.skip(),
            onEnd: () => this.end(),
            onRebuild: () => void this.rebuild(),
            // Editing is a move in the sitting, not a window over it: the card
            // on screen goes into the editor in place.
            onEditCard: () => void this.openCardEditor({ mode: 'edit' }),
            onNewCard: () => void this.openCardEditor({ mode: 'new' }),
        };
    }

    // --------------------------------------------------------------- editing

    /**
     * Open the card editor in the sitting's own surface — in place, never a
     * popup.
     *
     * With a sitting up, the editor takes the card's place inside it, and the
     * sitting keeps working: the card comes back exactly where it was. With
     * nothing up — the sidebar's "New card" row, say — a sitting is opened for
     * the writing and is taken down again when the editor closes without a card
     * behind it (see {@link compose}).
     */
    async openCardEditor(request: CardEditorRequest = { mode: 'new' }): Promise<void> {
        if (request.mode === 'edit') {
            if (!this.view || !this.current) {
                new Notice('Open a card sitting first — the card on screen is what gets edited.');
                return;
            }
            this.bringSurfaceForwardIfHidden();
            const state = this.buildEditState();
            if (!state) {
                new Notice('That card could not be opened for editing.');
                return;
            }
            this.view.openEditor(state, this.editorHost());
            return;
        }

        const deckPath = await this.resolveNewCardDeck(request.deckPath);
        if (!this.view) await this.compose(deckPath);
        else this.bringSurfaceForwardIfHidden();
        if (!this.view) {
            new Notice('Could not open a place for the card editor.');
            return;
        }
        this.view.openEditor(await this.buildNewState(this.deckPath ?? deckPath), this.editorHost());
    }

    /**
     * A sitting whose surface is docked behind another panel comes forward
     * before the editor opens in it: the editor is in the cards the reader is
     * looking at, and cards nobody can see are not a place to write.
     *
     * The flow's own way of bringing them forward is to hand the sitting its
     * panel again — the mount runs once more, the cards tab comes forward, and
     * the sitting's place is kept ({@link mountViewInto} re-shows the card).
     * Without a dock there is nothing to bring forward: the sitting is in a
     * pane of its own already.
     */
    private bringSurfaceForwardIfHidden(): void {
        const view = this.view;
        if (!view) return;
        // A stand-in surface that cannot answer is believed: "unmeasurable" is
        // not "hidden".
        const onScreen = typeof view.isOnScreen === 'function' ? view.isOnScreen() : true;
        if (onScreen) return;
        this.plugin.reviewFlowController?.showCardSitting(container => this.mountViewInto(container));
    }

    /**
     * A sitting with nothing in its queue, opened because the reader asked to
     * write a card: the editor is what the surface is for. The mount is the
     * sitting's normal one, so it lands in the dock when a review bar is up and
     * in a pane otherwise — never a popup. The sitting has no card behind it,
     * so when the editor closes without a save, it takes itself down.
     */
    private async compose(deckPath: string | null): Promise<void> {
        this.composing = true;
        this.deckPath = deckPath;
        this.bundle = null;
        this.current = null;
        this.queue = [];
        this.decks.clear();
        this.cardDeck.clear();
        this.answered.clear();
        this.picks.clear();
        this.startedAt = Date.now();
        if (deckPath) {
            try {
                const bundle = await this.store.readDeck(deckPath);
                this.bundle = bundle;
                this.decks.set(deckPath, bundle);
            } catch (error) {
                console.error('spaceforge: could not read the deck to write into', deckPath, error);
                this.deckPath = null;
            }
        }
        await this.mount();
    }

    /** Which deck a new card goes to: the asked-for one, the sitting's, or the first. */
    private async resolveNewCardDeck(preferred?: string): Promise<string | null> {
        if (preferred) return preferred;
        if (this.deckPath && this.decks.has(this.deckPath)) return this.deckPath;
        const decks = await this.store.listDecks().catch((): DeckSummary[] => []);
        return decks[0]?.path ?? null;
    }

    /** The editor's opening state for the card on screen. */
    private buildEditState(): CardEditorState | null {
        const current = this.current;
        if (!current) return null;
        const path = this.cardDeck.get(current.card.id) ?? this.deckPath;
        const bundle = (path ? this.decks.get(path) : null) ?? this.bundle;
        if (!bundle) return null;
        const note = bundle.notes.find(entry => entry.id === current.card.noteId);
        if (!note) return null;
        return {
            mode: 'edit',
            decks: [],
            deckPath: path ?? null,
            deckName: displayDeckName(bundle.deck.name),
            // The kind is the note's own; an edit changes the text, it does not
            // re-cut the card, so the type is shown and locked.
            question: questionKindOf(note, current.card),
            questionEditable: false,
            fields: note.fields.map((label, index) => ({ label, value: note.values[index] ?? '' })),
        };
    }

    /** The editor's opening state for a card about to be written. */
    private async buildNewState(deckPath: string | null): Promise<CardEditorState> {
        const decks = await this.store.listDecks().catch((): DeckSummary[] => []);
        const choices = decks.map(deck => ({ path: deck.path, name: displayDeckName(deck.name) }));
        const target = deckPath !== null && choices.some(choice => choice.path === deckPath)
            ? deckPath
            : choices[0]?.path ?? null;
        return {
            mode: 'new',
            decks: choices,
            deckPath: target,
            deckName: choices.find(choice => choice.path === target)?.name ?? '',
            question: 'basic',
            questionEditable: true,
            fields: draftFieldsFor('basic'),
        };
    }

    /** The panel's two jobs, wired to this sitting. */
    private editorHost(): CardEditorHost {
        return {
            save: draft => this.saveEditorDraft(draft),
            close: () => this.afterEditorClosed(),
        };
    }

    /** Write what the editor holds. Never throws: a failure is an honest answer. */
    private async saveEditorDraft(draft: CardEditorSave): Promise<CardEditorConclusion> {
        try {
            return draft.mode === 'edit'
                ? await this.applyEditDraft(draft)
                : await this.applyNewDraft(draft);
        } catch (error) {
            console.error('spaceforge: could not save the card', error);
            return { ok: false, message: 'That card could not be saved.' };
        }
    }

    /** A new card: written into its deck, then taken up by this sitting. */
    private async applyNewDraft(draft: CardEditorSave): Promise<CardEditorConclusion> {
        let path = draft.deckPath;
        let bundle: DeckBundle;
        if (path) {
            bundle = await this.store.readDeck(path);
        } else {
            // No decks yet: the card still has to go somewhere, so the deck is
            // started here — the name the reader typed, or a plain one.
            const name = draft.newDeckName.length > 0 ? draft.newDeckName : 'Cards';
            const created = await this.store.createDeck(name);
            path = created.path;
            bundle = created.bundle;
        }

        const minted = mintCardsFromDraft(bundle, draft.question, draft.values);
        bundle.notes.push(minted.note);
        bundle.cards.push(...minted.cards);
        await this.store.writeDeck(bundle, path);

        this.adoptWrittenCards(path, bundle, minted.cards);
        void this.plugin.getSidebarView()?.refresh();

        const count = minted.cards.length;
        return {
            ok: true,
            message: `Added ${count} card${count === 1 ? '' : 's'} to "${displayDeckName(bundle.deck.name)}".`,
        };
    }

    /** An edited card: the note's fields are rewritten, whole-file, and re-shown. */
    private async applyEditDraft(draft: CardEditorSave): Promise<CardEditorConclusion> {
        const current = this.current;
        if (!current) return { ok: false, message: 'There is no card on screen to edit.' };
        const path = this.cardDeck.get(current.card.id) ?? this.deckPath;
        const bundle = (path ? this.decks.get(path) : null) ?? this.bundle;
        if (!path || !bundle) return { ok: false, message: 'The deck this card lives in could not be read.' };
        const note = bundle.notes.find(entry => entry.id === current.card.noteId);
        if (!note) return { ok: false, message: 'This card’s note is no longer in the deck.' };

        // The fields keep their own names and count: the editor shows exactly
        // the note's fields, and the values go back where they came from.
        note.values = note.fields.map((_field, index) => draft.values[index] ?? '');
        note.modified = Date.now();
        await this.store.writeDeck(bundle, path);

        // The card on screen is the card that changed: it is resolved again and
        // shown where the reader is standing, so the edit lands in front of them.
        current.view = resolvePresentation(note, current.card);
        this.view?.show(current, this.summary());
        void this.plugin.getSidebarView()?.refresh();
        return { ok: true, message: 'Card saved.' };
    }

    /**
     * The sitting takes up the cards it just watched being written.
     *
     * A sitting that exists only to write becomes that deck's sitting, with the
     * new cards as its queue (the reader lands on what they wrote); a sitting
     * already on the deck puts them behind the cards it holds, in creation
     * order, exactly as Anki queues new cards.
     */
    private adoptWrittenCards(path: string, bundle: DeckBundle, cards: AnkiCard[]): void {
        if (this.composing) {
            this.composing = false;
            this.deckPath = path;
            this.bundle = bundle;
            this.decks = new Map([[path, bundle]]);
            this.cardDeck.clear();
            this.answered.clear();
            this.picks.clear();
            this.queue = [];
            for (const card of cards) {
                this.cardDeck.set(card.id, path);
                this.queue.push(card);
            }
            this.advance();
            return;
        }
        if (!this.isActive()) return;
        if (this.deckPath !== path && !this.decks.has(path)) return;
        // The sitting reads its notes out of the bundle it holds, so the deck
        // it just wrote to is re-read into the sitting: without this, the card
        // that was just written would reach the queue with no note behind it
        // and be dropped as unreadable.
        this.decks.set(path, bundle);
        if (this.deckPath === path) this.bundle = bundle;
        const known = new Set(this.queue.map(card => card.id));
        let added = 0;
        for (const card of cards) {
            if (known.has(card.id)) continue;
            this.cardDeck.set(card.id, path);
            this.queue.push(card);
            added += 1;
        }
        // A sitting with nothing on screen was finished: the card just written
        // is what it has to show now.
        if (added > 0 && !this.current) this.advance();
    }

    /**
     * The editor closed. The card goes back on screen where it was; a sitting
     * opened only to write has nothing left to sit on and takes itself down.
     */
    private afterEditorClosed(): void {
        this.view?.closeEditor();
        if (this.composing && !this.current) this.teardown();
    }

    /**
     * A sitting is one surface.
     *
     * A previous sitting's markup can outlive its session — a reload mid-sitting,
     * a leaf Obsidian rebuilt, a panel whose teardown never ran — and a reader
     * looking at two or three copies of the same panel is looking at a bug. Every
     * surface wearing the sitting's clothes is cleared before the new one exists.
     */
    private closeStaleSurfaces(): void {
        // No DOM (unit tests, a stripped environment): nothing to sweep — and a
        // document stand-in without a search finds nothing to take down either.
        if (typeof document === 'undefined') return;
        if (typeof document.querySelectorAll !== 'function') return;
        // The dock may still be holding the *previous* sitting's mount closure,
        // and a closure is enough to build a second copy of the same panel the
        // next time the dock renders. Clearing its bookkeeping comes first; the
        // markup sweep below is the belt to that pair of braces.
        this.plugin.reviewFlowController?.cardSittingEnded?.();
        for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.sf-dock-body.sf-deck-host'))) {
            panel.remove();
        }
        for (const root of Array.from(document.querySelectorAll<HTMLElement>('.sf-deck'))) {
            root.remove();
        }
    }

    /** Mount the sitting into whatever surface the reader configured. */
    private async mount(): Promise<void> {
        this.closeStaleSurfaces();
        // A review bar up is the first choice: the cards take the same slot the
        // MCQs render in, under the grades, so nothing is covered and the
        // grading keys keep working over the card on screen.
        if (this.plugin.reviewFlowController?.showCardSitting(container => this.mountViewInto(container))) {
            return;
        }

        // No review bar to dock under: the sitting takes a pane (or a window,
        // when that is the setting). It never opens as a popup — a card sitting
        // is a surface the reader is *in*, not a window over what they were
        // doing — so a stored 'modal' placement is read as a split rather than
        // putting anything over the app.
        const leaf = this.resolveLeaf();
        this.leaf = leaf;

        // The sitting is about to open in a pane, and a sitting must be visible
        // the moment it starts: the leaf it takes is brought on screen first,
        // because a reused pane can be a tab the reader has since moved away
        // from — the row they pressed was in the sidebar, and the cards are
        // nowhere near it.
        void this.plugin.app.workspace.revealLeaf?.(leaf);

        const deckFile = this.deckFile();
        if (deckFile) await leaf.openFile(deckFile, { active: false });

        const container = leaf.view?.containerEl;
        if (!container) {
            new Notice('Could not open a place for these cards.');
            return;
        }

        this.mountViewInto(container);
    }

    /**
     * Create the sitting's surface inside `container` and hand its teardown
     * back, so whoever owns the container — the dock or the pane — can give
     * the surface back when the sitting ends.
     *
     * This runs again whenever a surface has to be rebuilt — a host move can
     * hand the dock a fresh panel, and the dock re-mounts the sitting into it —
     * so a surface mounted while a card is up is shown where the sitting
     * stands: the card comes back with the panel, never a blank one.
     */
    private mountViewInto(container: HTMLElement): () => void {
        this.view?.destroy();
        const view = this.createView(this.handlers());
        view.mountInto(container);
        this.view = view;
        if (this.current) view.show(this.current, this.summary());
        const teardown = () => {
            view.destroy();
            if (this.view === view) this.view = null;
            if (this.viewTeardown === teardown) this.viewTeardown = null;
        };
        this.viewTeardown = teardown;
        return teardown;
    }

    /**
     * A pick is not a grade: it is remembered, and it shapes the suggested grade.
     */
    private recordChoice(index: number, correct: boolean): void {
        const current = this.current;
        if (!current) return;
        this.picks.set(current.card.id, { index, correct });
    }

    /** The deck file itself, so the pane has content of its own under the card. */
    private deckFile(): TFile | null {
        const path = this.deckPath;
        if (!path) return null;
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
    }

    private resolveLeaf(): WorkspaceLeaf {
        if (this.leaf && this.leaf.view?.containerEl?.isConnected) return this.leaf;
        if (this.plugin.settings.reviewSessionPlacement === 'window') {
            if (this.popoutLeaf && this.popoutLeaf.view?.containerEl?.isConnected) return this.popoutLeaf;
            this.popoutLeaf = this.plugin.app.workspace.openPopoutLeaf();
            return this.popoutLeaf;
        }
        return this.plugin.app.workspace.getLeaf();
    }

    private teardown(): void {
        // The surface the sitting shows through gives itself back first: the
        // teardown its mount left behind, then whatever view is left over (the
        // pane path destroys its own).
        this.viewTeardown?.();
        this.viewTeardown = null;
        this.view?.destroy();
        this.view = null;
        this.composing = false;
        this.current = null;
        this.queue = [];
        this.bundle = null;
        this.decks.clear();
        // The dock handed us its panel and waits to be told the sitting is over —
        // otherwise its cards slot would sit there empty until the next sitting.
        this.plugin.reviewFlowController?.cardSittingEnded?.();
        this.cardDeck.clear();
        this.deckPath = null;
    }
}
