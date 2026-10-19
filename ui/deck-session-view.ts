/**
 * The deck sitting, on screen.
 *
 * A bar on top — which deck, how far in, what is left — and one card under it.
 * No popups: this mounts into the pane (or the window) the sitting opened in,
 * the same way the note review bar does, and it is the only place a question is
 * ever shown.
 *
 * Written to the house rules: one card at a time, keyboard first (space reveals,
 * the digits grade, the number keys pick a choice), type scaled from the
 * reader's own settings, and nothing styled from code except through the custom
 * properties it sets.
 *
 * Editing happens here too, in place: the card's own Edit control, or the bar's
 * Add control, swaps the card region for the editor panel
 * (`ui/card-editor-panel.ts`) — a section over the card, never a window. While
 * the editor is open the sitting's keys stand down and the card comes back
 * exactly where it was when the editor closes.
 */

import { Component, MarkdownRenderer, Menu, setIcon } from 'obsidian';

import type SpaceforgePlugin from '../main';
import { ANKI_GRADES, AnkiGrade } from '../models/anki';
import { compareTypedAnswer } from '../models/card-presentation';
import type { DeckSessionCard, DeckSessionHandlers } from '../controllers/deck-session-controller';
import { CardEditorHost, CardEditorPanel, CardEditorState } from './card-editor-panel';

/** The bar's own view of the sitting. */
export interface DeckSessionSummary {
    deckName: string;
    /** How many decks this sitting covers: 1 normally, more for "everything due". */
    deckCount: number;
    position: number;
    total: number;
    answered: number;
    /** Multiple-choice picks, and how many of them were right. */
    correct: number;
    picks: number;
    /** How many notes the other lane still owes, so the way back can be offered. */
    notesWaiting?: number;
}

/** How many dots the head row shows at once, however long the queue is. */
const MAX_DOTS = 12;

/** How long a right answer stays on screen before the next card, in ms. */
const RIGHT_ANSWER_PAUSE = 620;
/** How long a wrong one stays, so it can be read. */
const WRONG_ANSWER_PAUSE = 1400;

export class DeckSessionView {
    private plugin: SpaceforgePlugin;
    private handlers: DeckSessionHandlers;

    private root: HTMLElement | null = null;
    /** The pane this surface took over, so it can be given back. */
    private host: HTMLElement | null = null;
    private titleEl: HTMLElement | null = null;
    private metaEl: HTMLElement | null = null;
    private progressEl: HTMLElement | null = null;
    /** One dot per card in this sitting, the current one marked. */
    private dotsEl: HTMLElement | null = null;
    /** The card region: the card, its tools, the finish screen — or the editor. */
    private bodyEl: HTMLElement | null = null;
    private cardEl: HTMLElement | null = null;
    private frontEl: HTMLElement | null = null;
    private backEl: HTMLElement | null = null;
    private choicesEl: HTMLElement | null = null;
    private typeRow: HTMLElement | null = null;
    private typeInput: HTMLInputElement | null = null;
    private buttonsEl: HTMLElement | null = null;
    private finishedEl: HTMLElement | null = null;

    /** The in-place editor, while one is open: it takes the card's place. */
    private editorPanel: CardEditorPanel | null = null;
    private editorEl: HTMLElement | null = null;
    private editorOpen = false;

    private card: DeckSessionCard | null = null;
    private summary: DeckSessionSummary | null = null;
    private revealed = false;
    /** True while a question is on screen: other surfaces stand their keys down. */
    private answering = false;
    private pending: number | null = null;
    private renderComponent = new Component();

    constructor(plugin: SpaceforgePlugin, handlers: DeckSessionHandlers) {
        this.plugin = plugin;
        this.handlers = handlers;
    }

    /** True while a card is waiting for an answer. */
    isAnswering(): boolean {
        return this.answering;
    }

    mountInto(container: HTMLElement): void {
        this.build(container);
        this.host = container;
        // The pane was showing the deck's own file; a card sitting is what the
        // reader asked for, so the file's properties and text step aside for as
        // long as the sitting lasts (see .sf-deck-host in the stylesheet).
        container.addClass('sf-deck-host');
        container.appendChild(this.root as HTMLElement);
        this.renderComponent.load();
        document.addEventListener('keydown', this.keydownHandler, true);
    }

    /** Show a card. */
    show(card: DeckSessionCard, summary: DeckSessionSummary | null): void {
        this.card = card;
        this.summary = summary ?? this.summary;
        this.revealed = false;
        this.answering = true;
        this.clearPending();
        this.renderCard();
    }

    /** The sitting is over: everything due has been answered. */
    finish(summary: DeckSessionSummary | null): void {
        this.summary = summary ?? this.summary;
        this.card = null;
        this.answering = false;
        this.clearPending();
        this.renderCard();
    }

    /** A card was answered: a short, quiet flash, so the eye knows it landed. */
    pulse(): void {
        const root = this.root;
        if (!root) return;
        root.removeClass('sf-deck-landed');
        // Reading layout is enough to restart the animation.
        void root.offsetWidth;
        root.addClass('sf-deck-landed');
        window.setTimeout(() => root.removeClass('sf-deck-landed'), 400);
    }

    destroy(): void {
        document.removeEventListener('keydown', this.keydownHandler, true);
        this.clearPending();
        // The editor goes quietly with the surface: no re-render on the way out.
        this.editorPanel?.destroy();
        this.editorPanel = null;
        this.editorEl?.remove();
        this.editorEl = null;
        this.editorOpen = false;
        this.renderComponent.unload();
        this.renderComponent = new Component();
        this.root?.remove();
        this.host?.removeClass('sf-deck-host');
        this.root = null;
        this.host = null;
        this.answering = false;
    }

    // ----------------------------------------------------------------- build

    private build(container: HTMLElement): void {
        if (this.root) return;
        container.addClass('sf-deck-host');

        const root = container.createDiv({ cls: 'sf-deck' });
        this.root = root;

        const bar = root.createDiv({ cls: 'sf-deck-bar' });
        const identity = bar.createDiv({ cls: 'sf-deck-identity' });
        const icon = identity.createSpan({ cls: 'sf-deck-icon' });
        setIcon(icon, 'layers');
        this.titleEl = identity.createSpan({ cls: 'sf-deck-title' });
        this.metaEl = identity.createSpan({ cls: 'sf-deck-meta' });

        // The head row reads left to right like the questions panel's: what this
        // is, how far in, the dots across the middle, the actions at the end.
        this.progressEl = bar.createSpan({ cls: 'sf-deck-progress' });
        this.dotsEl = bar.createSpan({ cls: 'sf-deck-dots' });

        const right = bar.createDiv({ cls: 'sf-deck-actions' });
        // The deck's own controls: a card written into this deck, the session
        // options, and the end of the sitting. Writing a card is one press, not
        // a menu item — a menu is a popup, and the reader asked for none.
        const newButton = right.createEl('button', {
            cls: 'clickable-icon sf-deck-new',
            attr: { 'aria-label': 'Add a card to this deck', type: 'button', title: 'Write a card into this deck' },
        });
        setIcon(newButton, 'plus');
        newButton.addEventListener('click', () => this.handlers.onNewCard?.());

        const menuButton = right.createEl('button', {
            cls: 'clickable-icon sf-deck-menu',
            attr: { 'aria-label': 'Session options', type: 'button' },
        });
        setIcon(menuButton, 'more-horizontal');
        menuButton.addEventListener('click', event => this.openMenu(event));

        // Ending is one press and always visible, as it is in the questions panel.
        const endButton = right.createEl('button', { cls: 'sf-deck-end', text: 'End sitting' });
        endButton.setAttribute('type', 'button');
        endButton.setAttribute('title', 'End this sitting (esc)');
        endButton.addEventListener('click', () => this.handlers.onEnd());

        const body = root.createDiv({ cls: 'sf-deck-body' });
        this.bodyEl = body;
        this.cardEl = body.createDiv({ cls: 'sf-deck-card' });
        this.frontEl = this.cardEl.createDiv({ cls: 'sf-deck-front' });
        this.choicesEl = this.cardEl.createDiv({ cls: 'sf-deck-choices' });
        this.typeRow = this.cardEl.createDiv({ cls: 'sf-deck-type' });
        this.typeInput = this.typeRow.createEl('input', {
            cls: 'sf-deck-type-input',
            attr: { type: 'text', placeholder: 'Type the answer, then check it', spellcheck: 'false' },
        });
        const checkButton = this.typeRow.createEl('button', { cls: 'sf-deck-check', text: 'Check' });
        checkButton.addEventListener('click', () => this.checkTyped());
        this.typeInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.checkTyped();
            }
        });
        this.backEl = this.cardEl.createDiv({ cls: 'sf-deck-back' });
        this.buttonsEl = this.cardEl.createDiv({ cls: 'sf-deck-buttons' });
        // The card's own controls, on the card: editing the card the reader is
        // looking at, and writing the next one into this deck. Both open the
        // editor in place — no window, no menu, nothing over the note.
        const tools = this.cardEl.createDiv({ cls: 'sf-deck-tools' });
        const editButton = tools.createEl('button', {
            cls: 'sf-deck-tool sf-deck-edit',
            text: 'Edit card',
            attr: { type: 'button', title: 'Change this card' },
        });
        editButton.addEventListener('click', () => this.handlers.onEditCard?.());
        const addButton = tools.createEl('button', {
            cls: 'sf-deck-tool sf-deck-add-card',
            text: 'Add card',
            attr: { type: 'button', title: 'Write another card into this deck' },
        });
        addButton.addEventListener('click', () => this.handlers.onNewCard?.());
        this.finishedEl = body.createDiv({ cls: 'sf-deck-finished' });
    }

    // -------------------------------------------------------------- editing

    /**
     * Open the editor over the card — a section in the card region, not a
     * window: the sitting stays mounted, the bar keeps saying where the reader
     * is, and the card comes back untouched when the editor closes.
     */
    openEditor(state: CardEditorState, host: CardEditorHost): void {
        const body = this.bodyEl;
        if (!body) return;
        this.closeEditor();
        this.editorOpen = true;
        this.editorEl = body.createDiv({ cls: 'sf-card-editor-host' });
        this.editorPanel = new CardEditorPanel(state, host);
        this.editorPanel.mountInto(this.editorEl);
        this.showCardRegion(false);
    }

    /** The editor is done: the card (or the finish screen) comes back. */
    closeEditor(): void {
        const panel = this.editorPanel;
        this.editorPanel = null;
        panel?.destroy();
        this.editorEl?.remove();
        this.editorEl = null;
        if (!this.editorOpen) return;
        this.editorOpen = false;
        this.showCardRegion(true);
    }

    /** True while the editor is open: the sitting's own keys stand down. */
    isEditing(): boolean {
        return this.editorOpen;
    }

    /**
     * True while the sitting's surface is somewhere the reader can see.
     *
     * A dock that is collapsed, or standing on another tab, hides the panel
     * this view lives in; a surface behind `sf-hidden` is a surface nobody is
     * looking at, and the caller can bring the cards forward before putting
     * anything (the editor, say) into them.
     */
    isOnScreen(): boolean {
        const root = this.root;
        if (!root) return false;
        if (!root.isConnected) return false;
        return root.closest('.sf-hidden') === null;
    }

    /** Swap the card region between the card and the editor in it. */
    private showCardRegion(showCard: boolean): void {
        if (showCard) {
            // Re-rendering is what puts the card back: revealed state, choices,
            // grades and focus all come back exactly as the reader left them.
            this.renderCard();
            return;
        }
        this.cardEl?.addClass('sf-hidden');
        this.finishedEl?.addClass('sf-hidden');
    }

    // ----------------------------------------------------------------- render

    private renderCard(): void {
        const card = this.card;
        const summary = this.summary;
        const root = this.root;
        if (!root || !this.titleEl || !this.metaEl || !this.progressEl) return;

        this.titleEl.setText(summary?.deckCount && summary.deckCount > 1
            ? `${summary.deckName} · ${card?.deckName ?? ''}`.trim()
            : summary?.deckName ?? 'Deck');
        // The head row carries what places the card — the deck it came from — and
        // nothing else: a counter, a window of dots, an end button, exactly as the
        // questions panel has. The counts live on the sidebar's deck rows, and how
        // to answer is evident from the card itself.
        this.metaEl.setText('');
        // Position, not a tally: "3/12" means the same thing here as it does on
        // the questions panel.
        const progress = card ? `${card.position}/${card.total}` : summary ? `${summary.answered}/${summary.total}` : '';
        this.progressEl.setText(progress);
        this.progressEl.setAttribute('aria-label', card
            ? `card ${card.position} of ${card.total}`
            : `${summary?.answered ?? 0} cards answered of ${summary?.total ?? 0}`);
        this.renderDots(card);

        if (!card) {
            if (this.editorOpen) {
                // A sitting opened for the editor alone has no card behind it;
                // the finish screen would say "nothing left" over the very
                // panel the reader is writing in, so neither is shown.
                this.cardEl?.addClass('sf-hidden');
                this.finishedEl?.addClass('sf-hidden');
                return;
            }
            this.renderFinished();
            return;
        }

        if (this.editorOpen) {
            // The editor is over the card: the card below it keeps the state it
            // has, but nothing of it is on screen while the reader writes.
            this.cardEl?.addClass('sf-hidden');
            this.finishedEl?.addClass('sf-hidden');
            return;
        }
        this.finishedEl?.addClass('sf-hidden');
        this.cardEl?.removeClass('sf-hidden');
        this.renderFront(card);
        this.renderChoices(card);
        this.renderTyping(card);
        this.renderBack(card);
        this.renderButtons(card);
        this.focusFirst();
    }

    /** The queue as dots: what is done, and where the reader stands. */
    private renderDots(card: DeckSessionCard | null): void {
        const el = this.dotsEl;
        if (!el) return;
        el.empty();
        if (!card) return;

        // A window of the queue, not all of it: twenty-five dots in a row say
        // less than twelve do, and a sitting can hold hundreds. The window keeps
        // the current card in the middle of what is shown.
        const total = Math.max(0, card.total);
        const shown = Math.min(total, MAX_DOTS);
        const first = Math.max(1, Math.min(card.position - Math.floor(shown / 2), total - shown + 1));
        for (let i = 0; i < shown; i += 1) {
            const at = first + i;
            const dot = el.createSpan({ cls: 'sf-deck-dot' });
            if (at === card.position) dot.addClass('is-current');
            else if (at < card.position) dot.addClass('is-done');
        }
    }

    private renderFront(card: DeckSessionCard): void {
        const el = this.frontEl;
        if (!el) return;
        el.empty();
        void this.markdown(card.view.front, el);
    }

    private renderBack(card: DeckSessionCard): void {
        const el = this.backEl;
        if (!el) return;
        el.empty();
        el.toggleClass('sf-hidden', !this.revealed);
        if (!this.revealed) return;
        void this.markdown(card.view.back, el);
    }

    /** Multiple choice: the options, numbered, as buttons. */
    private renderChoices(card: DeckSessionCard): void {
        const el = this.choicesEl;
        if (!el) return;
        el.empty();
        if (card.view.mode !== 'mcq' || card.view.choices.length === 0) {
            el.addClass('sf-hidden');
            return;
        }
        el.removeClass('sf-hidden');

        card.view.choices.forEach((choice, index) => {
            const button = el.createEl('button', { cls: 'sf-deck-choice' });
            button.createSpan({ cls: 'sf-deck-choice-key', text: String(index + 1) });
            const text = button.createSpan({ cls: 'sf-deck-choice-text' });
            void this.markdown(choice, text);
            button.addEventListener('click', () => this.pick(index));
        });
    }

    /** Typing: an input, shown only when the card asks for one. */
    private renderTyping(card: DeckSessionCard): void {
        const row = this.typeRow;
        if (!row || !this.typeInput) return;
        const wanted = card.view.mode === 'type';
        row.toggleClass('sf-hidden', !wanted);
        if (!wanted) return;
        this.typeInput.value = '';
        this.typeInput.removeClass('sf-deck-type-right');
        this.typeInput.removeClass('sf-deck-type-wrong');
    }

    private renderButtons(card: DeckSessionCard, suggested?: AnkiGrade): void {
        const el = this.buttonsEl;
        if (!el) return;
        el.empty();

        const revealButton = el.createEl('button', { cls: 'sf-deck-reveal', text: 'Show answer' });
        revealButton.toggleClass('sf-hidden', this.revealed || card.view.mode === 'mcq');
        revealButton.addEventListener('click', () => this.reveal());

        for (const { grade, label } of ANKI_GRADES) {
            const interval = [card.preview.again, card.preview.hard, card.preview.good, card.preview.easy][grade - 1];
            const button = el.createEl('button', { cls: `sf-deck-grade sf-deck-grade-${label.toLowerCase()}` });
            button.createSpan({ cls: 'sf-deck-grade-key', text: String(grade) });
            button.createSpan({ cls: 'sf-deck-grade-label', text: label });
            if (interval) button.createSpan({ cls: 'sf-deck-grade-interval', text: interval });
            button.toggleClass('sf-hidden', !this.revealed && card.view.mode !== 'mcq');
            button.toggleClass('is-suggested', suggested === grade);
            if (suggested === grade) button.setAttribute('title', 'Suggested by your answer');
            button.addEventListener('click', () => this.grade(grade));
        }
    }

    private renderFinished(): void {
        const el = this.finishedEl;
        if (!el) return;
        el.removeClass('sf-hidden');
        this.cardEl?.addClass('sf-hidden');
        el.empty();

        const summary = this.summary;
        el.createDiv({
            cls: 'sf-deck-finished-title',
            text: summary && summary.deckCount > 1 ? 'Nothing left in your decks' : 'Nothing left in this deck',
        });
        if (summary) {
            const scored = summary.picks > 0 ? ` · ${summary.correct} of ${summary.picks} choices right` : '';
            el.createDiv({
                cls: 'sf-deck-finished-body',
                text: `Answered ${summary.answered} card${summary.answered === 1 ? '' : 's'}${scored}.`,
            });
        }
        // The day has two lanes, and finishing one is the moment to say what the
        // other is holding — with the way back, not just the number.
        const notesWaiting = summary?.notesWaiting ?? 0;
        if (notesWaiting > 0) {
            el.createDiv({
                cls: 'sf-deck-finished-next',
                text: `${notesWaiting} note${notesWaiting === 1 ? '' : 's'} still waiting in your review.`,
            });
        }

        // A deck that is finished is the deck the reader is thinking about: the
        // card they want to write goes in here, in place, without leaving it.
        const add = el.createEl('button', {
            cls: 'sf-deck-tool sf-deck-add-card',
            text: 'Add card',
            attr: { type: 'button', title: 'Write another card into this deck' },
        });
        add.addEventListener('click', () => this.handlers.onNewCard?.());

        const again = el.createEl('button', { cls: 'sf-deck-again', text: 'Study more' });
        again.addEventListener('click', () => this.handlers.onRebuild());
        if (notesWaiting > 0) {
            const notes = el.createEl('button', { cls: 'sf-deck-back-notes', text: 'Back to your notes' });
            notes.addEventListener('click', () => this.handlers.onEnd());
        }
        const done = el.createEl('button', { cls: 'sf-deck-done', text: 'Finish' });
        done.addEventListener('click', () => this.handlers.onEnd());
    }

    /** Chain: reveal, then refresh the buttons and the answer. */
    private reveal(): void {
        if (!this.card || this.revealed) return;
        this.revealed = true;
        this.renderBack(this.card);
        this.renderButtons(this.card);
    }

    private grade(grade: AnkiGrade): void {
        if (!this.card) return;
        if (!this.revealed && this.card.view.mode !== 'mcq') return;
        this.answering = false;
        this.handlers.onGrade(grade);
    }

    /** A choice was made: say whether it was right, then let the grade follow. */
    private pick(index: number): void {
        const card = this.card;
        const choicesEl = this.choicesEl;
        if (!card || !choicesEl || this.revealed) return;

        const buttons = Array.from(choicesEl.querySelectorAll('.sf-deck-choice'));
        const right = card.view.answerIndex;
        buttons.forEach((button, at) => {
            button.setAttribute('disabled', 'true');
            if (right >= 0 && at === right) button.addClass('sf-deck-choice-right');
            else if (at === index) button.addClass('sf-deck-choice-wrong');
        });

        const correct = right < 0 ? true : index === right;
        this.handlers.onChoose(index, correct);
        this.revealed = true;

        // Every card is graded, the way Anki grades every card: the pick says
        // whether the choice was right, and it *suggests* a grade, but the reader
        // gives it. Only the 'score' setting lets the pick decide, for readers
        // who asked for a quiz rather than a review.
        this.clearPending();
        const pause = correct ? RIGHT_ANSWER_PAUSE : WRONG_ANSWER_PAUSE;
        const suggested = correct ? AnkiGrade.Good : AnkiGrade.Again;
        this.pending = window.setTimeout(() => {
            this.pending = null;
            const shown = this.card;
            if (!shown) return;
            if (this.plugin.settings.mcqGradingMode === 'score') {
                this.grade(suggested);
                return;
            }
            this.renderBack(shown);
            this.renderButtons(shown, suggested);
        }, pause);
    }

    /** Check a typed answer against the card's own rules. */
    private checkTyped(): void {
        const card = this.card;
        const input = this.typeInput;
        if (!card || !input || this.revealed) return;

        const typed = input.value;
        // compareTypedAnswer is the same judgement the card's own rules describe.
        const right = compareTypedAnswer(typed, card.view);
        input.toggleClass('sf-deck-type-right', right);
        input.toggleClass('sf-deck-type-wrong', !right);
        input.setAttribute('disabled', 'true');
        this.revealed = true;
        this.renderBack(card);
        this.renderButtons(card);
    }

    private openMenu(event: MouseEvent): void {
        const menu = new Menu();
        menu.addItem(item => item.setTitle('Skip this card').setIcon('arrow-right').onClick(() => this.handlers.onSkip()));
        menu.addItem(item => item.setTitle('Rebuild the queue').setIcon('refresh-cw').onClick(() => this.handlers.onRebuild()));
        menu.addItem(item => item.setTitle('End the session').setIcon('x').onClick(() => this.handlers.onEnd()));
        menu.showAtMouseEvent(event);
    }

    /**
     * Markdown, rendered the way the rest of the app renders it, so images,
     * audio and video in a card work exactly as they do in a note.
     */
    private async markdown(text: string, el: HTMLElement): Promise<void> {
        if (text.length === 0) {
            el.createDiv({ cls: 'sf-deck-empty', text: '(empty side)' });
            return;
        }
        try {
            await MarkdownRenderer.render(this.plugin.app, text, el, '', this.renderComponent);
        } catch (error) {
            el.setText(text);
            console.error('spaceforge: could not render card text', error);
        }
    }

    private focusFirst(): void {
        const card = this.card;
        if (!card) return;
        if (card.view.mode === 'type') {
            this.typeInput?.focus();
            return;
        }
        this.choicesEl?.querySelector<HTMLElement>('.sf-deck-choice')?.focus();
    }

    private clearPending(): void {
        if (this.pending !== null) {
            window.clearTimeout(this.pending);
            this.pending = null;
        }
    }

    // --------------------------------------------------------------- keyboard

    /**
     * Bound on the document in the capture phase, as the note bar is, so a card
     * is answerable wherever the focus is — but never while the reader is typing
     * into something.
     */
    private keydownHandler = (event: KeyboardEvent): void => {
        // The editor owns the keyboard while it is open: the sitting's own keys
        // (space, the digits, Escape) belong to the reader's typing, not to the
        // card underneath.
        if (this.editorOpen) return;
        const card = this.card;
        if (!card) return;
        if (isEditable(event.target) && event.target !== this.typeInput) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            this.handlers.onEnd();
            return;
        }

        if (event.key === ' ' || event.key === 'Enter') {
            if (event.target === this.typeInput) return;
            event.preventDefault();
            if (!this.revealed) this.reveal();
            return;
        }

        if (event.key === '0') {
            event.preventDefault();
            this.handlers.onSkip();
            return;
        }

        if (!this.revealed && card.view.mode === 'mcq' && /^[1-9]$/.test(event.key)) {
            const index = Number(event.key) - 1;
            // The digits pick a choice only while the choices are still open; once
            // the answer is showing they grade the card, as on every other card.
            if (index < card.view.choices.length) {
                event.preventDefault();
                this.pick(index);
                return;
            }
        }

        if (this.revealed && /^[1-4]$/.test(event.key)) {
            event.preventDefault();
            this.grade(Number(event.key));
        }
    };
}

function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
}
