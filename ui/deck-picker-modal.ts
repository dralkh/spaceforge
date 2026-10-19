/**
 * Choosing a deck to study.
 *
 * Obsidian's own suggestion list: keyboard first, themed by the app, and
 * already familiar — a second list with its own keys and its own look would be
 * a worse version of the same thing. Each entry says what is waiting, because
 * that is the only question a reader has at this point.
 */

import { App, SuggestModal } from 'obsidian';

import type { DeckSummary } from '../services/deck-store';
import { displayDeckName } from '../utils/deck-display';

export interface DeckPickerChoice {
    path: string;
    label: string;
    detail: string;
}

/** What the reader asked to study: one deck, or everything that is due. */
export type StudyTarget = { kind: 'deck'; path: string } | { kind: 'everything' };

/**
 * Ask what to study: every deck that owes cards (the first entry, the way a
 * parent deck sits first in Anki), or one deck. Resolves with null when the
 * reader dismissed the list. Awaiting this is the whole point — a caller that
 * needs to act on the choice should not have to thread a callback through.
 */
export function pickStudyTarget(app: App, decks: DeckSummary[]): Promise<StudyTarget | null> {
    const due = decks.reduce((sum, deck) => sum + deck.counts.dueToday, 0);
    const choices = deckChoices(decks);
    if (due > 0 && decks.length > 1) {
        choices.unshift({
            path: '',
            label: 'Everything due',
            detail: `${due} card${due === 1 ? '' : 's'} across your decks`,
        });
    }
    return pickChoice(app, choices).then(path => {
        if (path === null) return null;
        return path === '' ? { kind: 'everything' } : { kind: 'deck', path };
    });
}

/**
 * Ask which deck, and resolve with the answer: the path, or null when the
 * reader dismissed the list.
 */
export function pickDeckPath(app: App, decks: DeckSummary[]): Promise<string | null> {
    return pickChoice(app, deckChoices(decks));
}

/** What each deck is owed, in the one line a reader needs before choosing. */
function deckChoices(decks: DeckSummary[]): DeckPickerChoice[] {
    return decks.map(deck => ({
        path: deck.path,
        label: displayDeckName(deck.name),
        detail: deck.counts.dueToday > 0
            ? `${deck.counts.dueToday} due`
            : `${deck.counts.totalCards} card${deck.counts.totalCards === 1 ? '' : 's'}`,
    }));
}

/** The list itself: one implementation for both questions. */
function pickChoice(app: App, choices: DeckPickerChoice[]): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (path: string | null): void => {
            if (settled) return;
            settled = true;
            resolve(path);
        };
        const modal = new DeckPickerModal(app, choices, path => finish(path));
        modal.onClose = () => {
            finish(null);
            void modal.constructor;
        };
        modal.open();
    });
}

export class DeckPickerModal extends SuggestModal<DeckPickerChoice> {
    private choices: DeckPickerChoice[];
    private choose: (path: string) => void;

    constructor(app: App, choices: DeckPickerChoice[], onChoose: (path: string) => void) {
        super(app);
        this.choose = onChoose;
        this.choices = choices;
        this.setPlaceholder('Which deck?');
        this.emptyStateText = 'No decks yet. Import an Anki package, or write one in spaceforge/decks.';
    }

    getSuggestions(query: string): DeckPickerChoice[] {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return this.choices;
        return this.choices.filter(choice =>
            choice.label.toLowerCase().includes(needle) || choice.detail.toLowerCase().includes(needle),
        );
    }

    renderSuggestion(choice: DeckPickerChoice, el: HTMLElement): void {
        el.createDiv({ cls: 'sf-deck-pick-name', text: choice.label });
        el.createDiv({ cls: 'sf-deck-pick-detail', text: choice.detail });
    }

    onChooseSuggestion(choice: DeckPickerChoice): void {
        this.choose(choice.path);
    }
}

/** What is waiting in a deck, in a reader's words. */
export function describe(deck: DeckSummary): string {
    const parts: string[] = [];
    if (deck.counts.newCount > 0) parts.push(`${deck.counts.newCount} new`);
    if (deck.counts.reviewCount > 0) parts.push(`${deck.counts.reviewCount} to review`);
    if (deck.counts.learningCount > 0) parts.push(`${deck.counts.learningCount} learning`);
    if (parts.length === 0) parts.push(deck.counts.totalCards === 0 ? 'no cards yet' : 'nothing due');
    const media = deck.mediaCount > 0 ? ` · ${deck.mediaCount} media` : '';
    return `${parts.join(' · ')}${media}`;
}
