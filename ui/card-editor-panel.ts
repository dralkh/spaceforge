/**
 * The card editor, in place.
 *
 * A card is edited where it is read: this panel mounts inside the cards surface
 * — the deck sitting's own view, under the sitting's bar — and takes the card's
 * place while it is open, the way a study viewer swaps in over its host. It is
 * not a popup, and there is no window over the note: the reader is writing the
 * card in front of them, and the sitting they are in stays exactly where it was.
 *
 * Anki's own question types are offered by name, because that is the vocabulary
 * a reader arrives with: `Basic`, `Basic (and reversed card)`, `Cloze`, and
 * `Type in the answer`. Saving writes a real card — a note with its fields and
 * the card(s) generated from it — through the deck store, the same writer the
 * review path uses, so a card made here is scheduled and studied exactly like
 * one that arrived in a package.
 *
 * The keyboard belongs to the editor while it is open, and only then: the
 * sitting's own keys stand down (see {@link DeckSessionView}), Escape cancels
 * here rather than ending the sitting, and Ctrl/Cmd+Enter saves — which is what
 * the hint under the actions says.
 */

import { Notice, setIcon } from 'obsidian';

import { AnkiCard, AnkiCardQueue, AnkiCardType, AnkiNote, DeckBundle } from '../models/anki';
import { clozeOrdinals } from '../models/card-presentation';
import { freshAnkiId } from '../models/deck-document';

/** The question shapes the editor can write, in Anki's vocabulary. */
export type QuestionKind = 'basic' | 'basicReversed' | 'cloze' | 'typed';

/** The choices, as the reading surface spells them. */
export const QUESTION_KINDS: { value: QuestionKind; label: string }[] = [
    { value: 'basic', label: 'Basic' },
    { value: 'basicReversed', label: 'Basic (and reversed card)' },
    { value: 'cloze', label: 'Cloze' },
    { value: 'typed', label: 'Type in the answer' },
];

/** One field of the draft: the note's own field name, and what is in it. */
export interface CardEditorField {
    label: string;
    value: string;
    placeholder?: string;
}

/** A deck the editor may write into, as its picker shows it. */
export interface CardEditorDeck {
    path: string;
    name: string;
}

/** What whoever opens the editor asked for. */
export interface CardEditorRequest {
    /**
     * 'new' writes a card into a deck — the sitting's own when there is one,
     * else the named/first deck, else a deck started from the name typed in;
     * 'edit' changes the card on screen.
     */
    mode: 'new' | 'edit';
    /** A deck to write a new card into, instead of the sitting's own. */
    deckPath?: string;
}

/** What the editor opens on. */
export interface CardEditorState {
    /** 'new' writes a card into a deck; 'edit' changes the card on screen. */
    mode: 'new' | 'edit';
    /** Decks a new card may go to; empty means the vault has none yet. */
    decks: CardEditorDeck[];
    /** The deck chosen (new), or the deck the card on screen lives in (edit). */
    deckPath: string | null;
    /** The chosen deck's name; empty when the vault has no decks at all. */
    deckName: string;
    /** The question type. */
    question: QuestionKind;
    /** New cards may change type; the card on screen keeps its own. */
    questionEditable: boolean;
    /** The note's fields, in order. */
    fields: CardEditorField[];
}

/** What the reader decided, on the way out. */
export interface CardEditorSave {
    mode: 'new' | 'edit';
    /** New cards: the deck chosen, or null to start one from `newDeckName`. */
    deckPath: string | null;
    newDeckName: string;
    question: QuestionKind;
    values: string[];
}

/** How a save went, in one sentence for the reader. */
export interface CardEditorConclusion {
    ok: boolean;
    message: string;
}

/** Who the panel works for: whoever opened it, and the sitting behind it. */
export interface CardEditorHost {
    /** Write the draft home. Never throws: a failure is an honest conclusion. */
    save: (draft: CardEditorSave) => Promise<CardEditorConclusion>;
    /** The editor is closing; `saved` says whether a save went through. */
    close: (saved: boolean) => void;
}

/** The field labels a kind of question uses, as the editor writes them. */
export function draftFieldsFor(kind: QuestionKind, values: string[] = []): CardEditorField[] {
    if (kind === 'cloze') {
        return [
            {
                label: 'Cloze text',
                value: values[0] ?? '',
                placeholder: 'The {{c1::city}} where the {{c2::treaty}} was signed',
            },
            {
                label: 'Back extra',
                value: values[1] ?? '',
                placeholder: 'Anything the answer side should add (optional)',
            },
        ];
    }
    return [
        { label: 'Front', value: values[0] ?? '', placeholder: 'What is the powerhouse of the cell?' },
        { label: 'Back', value: values[1] ?? '', placeholder: 'The mitochondria' },
    ];
}

/**
 * What is wrong with the draft, in the reader's words; empty when it is usable.
 *
 * The same three rules the card lane has always had: a front is required, a
 * cloze front needs at least one deletion, and a basic card needs its back.
 */
export function validateCardDraft(kind: QuestionKind, values: string[]): string {
    const front = (values[0] ?? '').trim();
    const back = (values[1] ?? '').trim();
    if (front.length === 0) return kind === 'cloze' ? 'A cloze card needs its text.' : 'A card needs a front.';
    if (kind === 'cloze') {
        return clozeOrdinals(front).length === 0
            ? 'A cloze card needs at least one deletion: {{c1::…}}.'
            : '';
    }
    if (back.length === 0) return 'A basic card needs a back.';
    return '';
}

/**
 * A note and the card(s) a draft generates, ready to be written.
 *
 * The rules are Anki's own: a cloze text with two deletions makes two cards,
 * "and reversed" is two templates of one note, "type in the answer" is a card
 * whose answer is typed and compared, and new cards queue in creation order
 * behind the deck's own positions.
 */
export function mintCardsFromDraft(
    bundle: DeckBundle,
    kind: QuestionKind,
    values: string[],
    now: number = Date.now(),
): { note: AnkiNote; cards: AnkiCard[] } {
    const front = (values[0] ?? '').trim();
    const back = (values[1] ?? '').trim();
    const cloze = kind === 'cloze';
    const typed = kind === 'typed';

    const noteId = freshAnkiId(now);
    const note: AnkiNote = {
        id: noteId,
        modelName: cloze ? 'Cloze' : 'Basic',
        fields: cloze ? ['Cloze text', 'Back extra'] : ['Front', 'Back'],
        values: [front, back],
        tags: [],
        cardIds: [],
        mediaFiles: [],
        modified: now,
    };

    // New cards queue in creation order, so the position continues the deck's.
    const used = bundle.cards
        .map(card => card.newPosition)
        .filter((position): position is number => typeof position === 'number');
    let nextPosition = used.length > 0 ? Math.max(...used) + 1 : 0;

    const mint = (ord: number): AnkiCard => {
        const card: AnkiCard = {
            id: freshAnkiId(now),
            noteId,
            deckId: bundle.deck.id,
            ord,
            type: AnkiCardType.New,
            queue: AnkiCardQueue.New,
            interval: 0,
            easeFactor: bundle.deck.options.startingEase,
            reviews: 0,
            lapses: 0,
            due: now,
            newPosition: nextPosition,
            flag: 0,
        };
        nextPosition += 1;
        if (typed) {
            // "Type in the answer": the answer is typed and compared, exactly as
            // the sitting already renders a card with a typed presentation.
            card.presentation = { mode: 'type', accept: [], caseInsensitive: false, ignoreDiacritics: false };
        }
        return card;
    };

    let cards: AnkiCard[];
    if (cloze) {
        const ordinals = [...new Set(clozeOrdinals(front))].sort((a, b) => a - b);
        cards = (ordinals.length > 0 ? ordinals : [1]).map(ordinal => mint(Math.max(0, ordinal - 1)));
    } else if (kind === 'basicReversed') {
        // Two templates of one note: forward and reversed, Anki's own dedupe.
        cards = [mint(0), mint(1)];
    } else {
        cards = [mint(0)];
    }

    note.cardIds = cards.map(card => card.id);
    return { note, cards };
}

/**
 * The in-place editor: a section that swaps in over the card.
 *
 * It is a plain element tree — no Obsidian `Setting`, no modal — built from the
 * values it is handed, and it talks to the sitting only through
 * {@link CardEditorHost}: `save` to write, `close` when the reader is done.
 */
export class CardEditorPanel {
    private host: CardEditorHost;
    private state: CardEditorState;

    private root: HTMLElement | null = null;
    private areas: HTMLTextAreaElement[] = [];
    private areaLabels: HTMLElement[] = [];
    private deckSelect: HTMLSelectElement | null = null;
    private deckInput: HTMLInputElement | null = null;
    private kindSelect: HTMLSelectElement | null = null;
    private errorEl: HTMLElement | null = null;
    private saveButton: HTMLElement | null = null;

    private open = false;
    private saving = false;

    constructor(state: CardEditorState, host: CardEditorHost) {
        this.state = state;
        this.host = host;
    }

    isOpen(): boolean {
        return this.open;
    }

    /** Build the panel inside `container`, and take the keyboard. */
    mountInto(container: HTMLElement): void {
        if (this.open) return;
        this.open = true;

        const root = container.createDiv({ cls: 'sf-card-editor' });
        this.root = root;
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', this.state.mode === 'new' ? 'New card' : 'Edit card');

        const head = root.createDiv({ cls: 'sf-card-editor-head' });
        const icon = head.createSpan({ cls: 'sf-card-editor-icon' });
        setIcon(icon, this.state.mode === 'new' ? 'plus' : 'pencil');
        head.createSpan({
            cls: 'sf-card-editor-title',
            text: this.state.mode === 'new' ? 'New card' : 'Edit card',
        });
        if (this.state.mode === 'edit' && this.state.deckName.length > 0) {
            head.createSpan({ cls: 'sf-card-editor-deck', text: this.state.deckName });
        }

        if (this.state.mode === 'new') this.buildDeckRow(root);
        this.buildKindRow(root);
        this.buildFieldRows(root);
        this.buildActions(root);

        root.createDiv({
            cls: 'sf-card-editor-hint',
            text: 'Ctrl+Enter saves · Esc cancels.',
        });

        // Escape is handled at the window in the capture phase: while the
        // editor is up, the review flow's own Escape (end the session) must not
        // fire — cancel is what the reader means here.
        window.addEventListener('keydown', this.escapeHandler, true);
        (this.areas[0] ?? this.deckInput)?.focus();
    }

    /** Take the panel out, and give the keyboard back. */
    destroy(): void {
        window.removeEventListener('keydown', this.escapeHandler, true);
        this.root?.remove();
        this.root = null;
        this.areas = [];
        this.areaLabels = [];
        this.deckSelect = null;
        this.deckInput = null;
        this.kindSelect = null;
        this.errorEl = null;
        this.saveButton = null;
        this.open = false;
        this.saving = false;
    }

    // ------------------------------------------------------------------ rows

    private buildDeckRow(root: HTMLElement): void {
        const row = root.createDiv({ cls: 'sf-card-editor-row' });
        row.createSpan({ cls: 'sf-card-editor-label', text: 'Deck' });
        if (this.state.decks.length > 0) {
            const select = row.createEl('select', { cls: 'sf-card-editor-select' });
            for (const deck of this.state.decks) {
                const option = select.createEl('option', { text: deck.name });
                option.value = deck.path;
            }
            select.value = this.state.deckPath ?? this.state.decks[0].path;
            select.setAttribute('aria-label', 'Deck');
            this.deckSelect = select;
            return;
        }
        // No decks yet: the card still has to go somewhere, so the deck is
        // started here — the same promise the old editor made.
        const input = row.createEl('input', {
            cls: 'sf-card-editor-input',
            attr: { type: 'text', placeholder: 'Biology', spellcheck: 'false', 'aria-label': 'New deck name' },
        });
        this.deckInput = input;
        row.createSpan({ cls: 'sf-card-editor-note', text: 'No decks yet — this name starts one.' });
    }

    private buildKindRow(root: HTMLElement): void {
        const row = root.createDiv({ cls: 'sf-card-editor-row' });
        row.createSpan({ cls: 'sf-card-editor-label', text: 'Question type' });
        const select = row.createEl('select', { cls: 'sf-card-editor-select' });
        for (const option of QUESTION_KINDS) {
            const el = select.createEl('option', { text: option.label });
            el.value = option.value;
        }
        select.value = this.state.question;
        select.setAttribute('aria-label', 'Question type');
        if (!this.state.questionEditable) {
            select.setAttribute('disabled', 'true');
            select.addClass('is-locked');
        } else {
            select.addEventListener('change', () => this.applyKind(select.value as QuestionKind));
        }
        this.kindSelect = select;
    }

    private buildFieldRows(root: HTMLElement): void {
        const fieldsEl = root.createDiv({ cls: 'sf-card-editor-fields' });
        for (const field of this.state.fields) {
            const row = fieldsEl.createEl('label', { cls: 'sf-card-editor-row' });
            const label = row.createSpan({ cls: 'sf-card-editor-label', text: field.label });
            const area = row.createEl('textarea', { cls: 'sf-card-editor-area' });
            area.value = field.value;
            area.rows = 3;
            area.setAttribute('spellcheck', 'false');
            if (field.placeholder) area.setAttribute('placeholder', field.placeholder);
            this.areas.push(area);
            this.areaLabels.push(label);
        }
    }

    private buildActions(root: HTMLElement): void {
        const actions = root.createDiv({ cls: 'sf-card-editor-actions' });
        const save = actions.createEl('button', {
            cls: 'sf-card-editor-save',
            text: this.state.mode === 'new' ? 'Save card' : 'Save changes',
            attr: { type: 'button' },
        });
        save.addClass('mod-cta');
        save.addEventListener('click', () => void this.commit());
        this.saveButton = save;

        const cancel = actions.createEl('button', {
            cls: 'sf-card-editor-cancel',
            text: 'Cancel',
            attr: { type: 'button' },
        });
        cancel.addEventListener('click', () => this.cancel());

        this.errorEl = actions.createSpan({ cls: 'sf-card-editor-error' });
        this.errorEl.setAttribute('role', 'alert');
    }

    /** The rows say what the fields mean for the type chosen. */
    private applyKind(kind: QuestionKind): void {
        this.state.question = kind;
        const fields = draftFieldsFor(kind, this.readValues());
        this.state.fields = fields;
        fields.forEach((field, index) => {
            this.areaLabels[index]?.setText(field.label);
            const area = this.areas[index];
            if (!area) return;
            if (field.placeholder) area.setAttribute('placeholder', field.placeholder);
            else area.removeAttribute('placeholder');
        });
    }

    // ---------------------------------------------------------------- actions

    private readValues(): string[] {
        return this.areas.map(area => area.value);
    }

    private setError(message: string): void {
        this.errorEl?.setText(message);
        this.errorEl?.toggleClass('is-empty', message.length === 0);
    }

    private cancel(): void {
        if (this.saving) return;
        this.host.close(false);
    }

    private async commit(): Promise<void> {
        if (this.saving) return;
        const values = this.readValues().map(value => value.trim());
        const problem = validateCardDraft(this.state.question, values);
        if (problem.length > 0) {
            this.setError(problem);
            return;
        }

        this.saving = true;
        this.saveButton?.setAttribute('disabled', 'true');
        try {
            const conclusion = await this.host.save({
                mode: this.state.mode,
                deckPath: this.deckSelect ? this.deckSelect.value : this.state.deckPath,
                newDeckName: this.deckInput ? this.deckInput.value.trim() : '',
                question: this.state.question,
                values,
            });
            if (!conclusion.ok) {
                this.setError(conclusion.message);
                return;
            }
            if (conclusion.message.length > 0) new Notice(conclusion.message);
            this.host.close(true);
            return;
        } finally {
            this.saving = false;
            this.saveButton?.removeAttribute('disabled');
        }
    }

    /**
     * Escape, in the capture phase at the window: it runs before the review
     * flow's own document handler, so cancelling the editor can never end the
     * sitting the reader is in.
     */
    private escapeHandler = (event: KeyboardEvent): void => {
        if (!this.open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
    };
}
